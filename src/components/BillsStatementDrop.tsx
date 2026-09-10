import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { extractPdfText } from '../teams-test/pdf';

type StatementSection = {
  key: string;
  name: string;
  text: string;
  empty: boolean;
};

const STORAGE_KEY = 'njplumbing.bills.statements.v2';
const OLD_STORAGE_KEYS = ['njplumbing.bills.statements'];
const SECTION_HEADER = /^===== (.+?) =====\s*$/;

function isPdfFile(file: File) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function isStatementTextFile(file: File) {
  return /\.txt$/i.test(file.name) || file.type === 'text/plain';
}

function fileKey(file: File) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function nameKey(name: string) {
  return `name::${name.toLowerCase()}`;
}

function alreadyProcessed(file: File, sections: StatementSection[]) {
  const key = fileKey(file);
  const named = nameKey(file.name);
  return sections.some(
    (section) => section.key === key || section.key === named || section.name.toLowerCase() === file.name.toLowerCase()
  );
}

function sectionBlock(section: StatementSection) {
  return `===== ${section.name} =====\n${section.text || '[no extractable text — this PDF may be a scan]'}`;
}

function combinedText(sections: StatementSection[]) {
  return [...sections]
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
    .map(sectionBlock)
    .join('\n\n');
}

function parseStatementText(raw: string): StatementSection[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const parsed: StatementSection[] = [];
  let name = '';
  let body: string[] = [];
  const flush = () => {
    if (!name) return;
    const text = body.join('\n').trim();
    parsed.push({
      key: nameKey(name),
      name,
      text,
      empty: !text || text.startsWith('[no extractable text'),
    });
  };
  for (const line of lines) {
    const header = line.match(SECTION_HEADER);
    if (header) {
      flush();
      name = header[1];
      body = [];
      continue;
    }
    if (name) body.push(line);
  }
  flush();
  return parsed;
}

function mergeSections(current: StatementSection[], incoming: StatementSection[]) {
  const next = [...current];
  for (const section of incoming) {
    if (next.some((existing) => existing.name.toLowerCase() === section.name.toLowerCase())) continue;
    next.push(section);
  }
  return next;
}

function loadStoredSections(): StatementSection[] {
  try {
    for (const key of OLD_STORAGE_KEYS) localStorage.removeItem(key);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StatementSection[];
    return Array.isArray(parsed) ? parsed.filter((item) => item?.name) : [];
  } catch {
    return [];
  }
}

function downloadText(fileName: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export default function BillsStatementDrop({
  onSectionsChange,
}: {
  onSectionsChange?: (sections: StatementSection[]) => void;
}) {
  const [active, setActive] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [sections, setSections] = useState<StatementSection[]>(loadStoredSections);

  const preview = useMemo(() => combinedText(sections), [sections]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sections));
    onSectionsChange?.(sections);
  }, [sections, onSectionsChange]);

  const finish = (next: StatementSection[], message: string, download = true) => {
    setSections(next);
    if (download && next.length) downloadText('bank-statements.txt', combinedText(next));
    setStatus(message);
  };

  const processFiles = async (fileList: FileList | File[]) => {
    const files = [...fileList];
    const texts = files.filter(isStatementTextFile);
    const pdfs = files.filter(isPdfFile);
    if (!texts.length && !pdfs.length) {
      setError('Drop PDF statements, or drop a previous bank-statements.txt to restore it.');
      return;
    }

    setWorking(true);
    setError('');
    try {
      let next = sections;
      let restored = 0;
      for (const file of texts) {
        const parsed = parseStatementText(await file.text());
        const before = next.length;
        next = mergeSections(next, parsed);
        restored += next.length - before;
      }

      const fresh = pdfs.filter((file) => !alreadyProcessed(file, next));
      const skipped = pdfs.length - fresh.length;
      const added: StatementSection[] = [];
      for (const file of fresh.sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true })
      )) {
        const text = (await extractPdfText(await file.arrayBuffer())).trim();
        added.push({
          key: fileKey(file),
          name: file.name,
          text,
          empty: !text,
        });
      }
      next = mergeSections(next, added);

      if (!restored && !added.length) {
        setStatus(
          skipped
            ? `Skipped ${skipped} already processed PDF${skipped === 1 ? '' : 's'}. ${next.length} statement${next.length === 1 ? '' : 's'} already saved.`
            : `${next.length} statement${next.length === 1 ? '' : 's'} already saved.`
        );
        return;
      }

      const empty = added.filter((section) => section.empty).map((section) => section.name);
      const parts = [
        restored ? `Restored ${restored} from text` : '',
        added.length ? `extracted ${added.length} new PDF${added.length === 1 ? '' : 's'}` : '',
        skipped ? `skipped ${skipped} already processed` : '',
      ].filter(Boolean);
      finish(
        next,
        `${parts.join(', ')} (${next.length} total).${
          empty.length ? ` No text in: ${empty.join(', ')}.` : ' Totals appear in the cash briefing below.'
        }`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read those files.');
    } finally {
      setWorking(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setActive(false);
    void processFiles(event.dataTransfer.files);
  };

  return (
    <section className="bills__load">
      <label
        className={`bills__drop${active ? ' bills__drop--active' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setActive(true);
        }}
        onDragLeave={() => setActive(false)}
        onDrop={onDrop}
      >
        {working
          ? 'Reading files…'
          : 'Drop PDFs to add, or drop an existing bank-statements.txt to restore earlier work'}
        <input
          type="file"
          accept="application/pdf,.pdf,text/plain,.txt"
          multiple
          hidden
          disabled={working}
          onChange={(event) => {
            if (event.target.files?.length) void processFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </label>
      <p className="bills__muted">
        Files processed before the skip-list change were only in the downloaded{' '}
        <code>bank-statements.txt</code>. Drop that file here to reload them, then add new PDFs —
        matching filenames are skipped. Progress is kept in this browser until you clear it.
      </p>
      {sections.length ? (
        <div className="bills__statement-files">
          <p>
            {sections.length} processed: {sections.map((section) => section.name).join(', ')}
          </p>
          <button
            type="button"
            disabled={working}
            onClick={() => downloadText('bank-statements.txt', preview)}
          >
            Download again
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => {
              setSections([]);
              localStorage.removeItem(STORAGE_KEY);
              setStatus('Cleared processed statements.');
              setError('');
            }}
          >
            Clear processed
          </button>
        </div>
      ) : null}
      {error ? <div className="bills__error">{error}</div> : null}
      {status ? <div className="bills__status">{status}</div> : null}
      {preview ? (
        <details className="bills__statement-preview">
          <summary>Preview extracted text</summary>
          <pre>
            {preview.slice(0, 20_000)}
            {preview.length > 20_000 ? '\n\n…truncated in preview' : ''}
          </pre>
        </details>
      ) : null}
    </section>
  );
}
