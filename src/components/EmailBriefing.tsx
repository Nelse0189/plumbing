import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  captureGmailOAuthCallback,
  clearGmailOAuthQuery,
  disconnectGmailInbox,
  finishGmailInboxSignIn,
  getGmailInboxMessage,
  downloadGmailInboxAttachment,
  listGmailInboxAccounts,
  listGmailInboxMessages,
  processGmailInboxesNow,
  saveWatchAddresses,
  searchGmailInboxMessages,
  startGmailInboxSignIn,
  subscribeGmailBriefings,
  subscribeInboxChats,
  saveInboxChat,
  deleteInboxChat,
  summarizeOfficeEmails,
  askAboutOfficeEmail,
  draftEmailReply,
  getEmailCorrespondent,
  type EmailBriefingResult,
  type EmailCorrespondent,
  type EmailReplyDraft,
  type EmailChatMessage,
  type EmailChatUsage,
  type GmailInboxAccount,
  type GmailInboxAttachment,
  type GmailInboxMessage,
  type SavedEmailBriefing,
  type SavedInboxChat,
} from '../services/emailBriefingService';
import { findWorkOrdersByNumber } from '../services/workOrderService';
import {
  attachmentLooksLikeWorkOrder,
  extractWorkOrderNumbers,
} from '../utils/workOrderRefs';
import { signIn as signInMicrosoft, tryAcquireTokenSilent } from '../teams-test/auth';
import { downloadTeamsWorkOrderPdf } from '../teams-test/graphClient';
import type { StoredWorkOrder } from '../types';
import { formatUsd } from '../services/importProgressService';
import { parsePastedEmails, parseWatchAddresses } from '../utils/parsePastedEmails';
import {
  applyAtMention,
  atQuery,
  CHAT_CONTEXT_LIMIT,
  CHAT_CONTEXT_MAX,
  CHAT_CONTEXT_MIN,
  CHAT_CONTEXT_STORAGE_KEY,
  clampChatContextLimit,
  gmailSearchQuery,
  isAdvertisement,
  pickRelevantMessages,
  readShopMailOnly,
  storeShopMailOnly,
  type AtSuggestion,
  type ChatPin,
} from '../utils/inboxChatContext';
import './EmailBriefing.css';

let gmailFinishStarted = false;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

/** Result of the extract → match → search → draft pipeline, shared by the inbox reader and the paste box. */
function ReplyDraftPanel(props: {
  draft: EmailReplyDraft;
  text: string;
  onTextChange: (value: string) => void;
  copied: boolean;
  onCopy: () => void;
  showEvidence: boolean;
  onToggleEvidence: () => void;
}) {
  const { draft, text, onTextChange, copied, onCopy, showEvidence, onToggleEvidence } = props;
  return (
    <>
      {draft.matches.length ? (
        <div className="email-brief__reply-matches">
          {draft.matches.map((item, index) => {
            const ref = item.reference;
            const label =
              ref.customerName ||
              ref.retailerOrderNumber ||
              (ref.workOrderNumber ? `WO ${ref.workOrderNumber}` : '') ||
              ref.address ||
              ref.phone;
            if (!label) return null;
            return (
              <div
                key={`${label}-${index}`}
                className={`email-brief__reply-match ${
                  item.match ? 'is-matched' : item.ambiguous.length ? 'is-ambiguous' : 'is-missing'
                }`}
              >
                <strong>{label}</strong>
                {ref.retailerOrderNumber && ref.customerName ? <small> {ref.retailerOrderNumber}</small> : null}
                {item.match ? (
                  <span>
                    → WO {item.match.workOrderNumber} · {item.match.customerName}
                    {item.match.appointmentDate ? ` · ${item.match.appointmentDate}` : ''}
                    {item.match.status ? ` · ${item.match.status}` : ''}
                    {item.match.permitPulled === true ? ' · permit pulled' : ''}
                    {item.match.permitPulled === false ? ' · permit not marked' : ''}
                    <small> ({item.match.reasons.join(', ')})</small>
                  </span>
                ) : item.ambiguous.length ? (
                  <span>
                    ? {item.ambiguous.length} possible:{' '}
                    {item.ambiguous.map((hit) => `WO ${hit.workOrderNumber} ${hit.customerName}`).join(' / ')}
                  </span>
                ) : (
                  <span>no work order found</span>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      <label className="email-brief__reply-subject">
        <span>Subject</span>
        <input type="text" value={draft.subject} readOnly />
      </label>
      <textarea
        className="email-brief__reply-text"
        value={text}
        rows={Math.min(24, Math.max(8, text.split('\n').length + 2))}
        onChange={(event) => onTextChange(event.target.value)}
      />
      <div className="email-brief__reply-bar">
        <button type="button" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy reply'}
        </button>
        {draft.gmailDraftId ? (
          <a
            href={`https://mail.google.com/mail/u/0/#drafts?compose=${draft.gmailDraftId}`}
            target="_blank"
            rel="noreferrer"
          >
            Open Gmail draft
          </a>
        ) : null}
        <button type="button" onClick={onToggleEvidence}>
          {showEvidence ? 'Hide evidence' : 'Show evidence'}
        </button>
        <small className="email-brief__muted">
          {draft.confidence} confidence · {formatUsd(draft.costUsd)} · {Math.round(draft.elapsedMs / 100) / 10}s
        </small>
      </div>
      {draft.gmailDraftError ? (
        <p className="email-brief__muted">Gmail draft not saved: {draft.gmailDraftError}</p>
      ) : null}

      {draft.unresolved.length ? (
        <div className="email-brief__reply-unresolved">
          <h4>Before sending</h4>
          <ul>
            {draft.unresolved.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {draft.internalNotes ? <p className="email-brief__muted">{draft.internalNotes}</p> : null}

      {showEvidence ? (
        <div className="email-brief__reply-evidence">
          {draft.intent ? (
            <p>
              <strong>What they want:</strong> {draft.intent}
            </p>
          ) : null}
          {draft.attachmentNotes.length ? (
            <p>
              <strong>Attachments read:</strong> {draft.attachmentNotes.join(' · ')}
            </p>
          ) : null}
          {draft.attachmentsRead.skipped.length ? (
            <p>
              <strong>Attachments skipped:</strong> {draft.attachmentsRead.skipped.join(' · ')}
            </p>
          ) : null}
          {draft.citations.length ? (
            <>
              <h4>Records used</h4>
              <ul>
                {draft.citations.map((item, index) => (
                  <li key={`${item.collection}-${item.id}-${index}`}>
                    {item.title || item.id}
                    <small> · {item.collection}</small>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {draft.vectorHits.length ? (
            <>
              <h4>Semantic search hits</h4>
              <ul>
                {draft.vectorHits.map((item, index) => (
                  <li key={`${item.collection}-${item.id}-${index}`}>
                    {item.title || item.id}
                    <small>
                      {' '}
                      · {item.collection} · {item.score.toFixed(2)}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {draft.correspondent?.notesMarkdown ? (
            <>
              <h4>Correspondent memory</h4>
              <pre>{draft.correspondent.notesMarkdown}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function fromName(from: string): string {
  const named = from.match(/^"?([^"<]+)"?\s*</);
  if (named?.[1]?.trim()) return named[1].trim();
  return from.replace(/[<>]/g, '').trim() || 'Unknown sender';
}

function headerPeople(header: string): Array<{ name: string; email: string; label: string }> {
  if (!header.trim()) return [];
  return header
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const emailMatch = part.match(/<([^>]+)>/);
      const email = (emailMatch?.[1] || (/@/.test(part) ? part.replace(/["']/g, '') : ''))
        .trim()
        .toLowerCase();
      const name = fromName(part);
      return { name, email, label: name || email };
    })
    .filter((person) => person.label);
}

function receivedMs(message: GmailInboxMessage): number {
  const ms = Number(message.receivedAt);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const parsed = Date.parse(message.date);
  return Number.isFinite(parsed) ? parsed : 0;
}

type InboxSort = 'newest' | 'oldest' | 'sender' | 'recipient';

function messageMatches(message: GmailInboxMessage, query: string): boolean {
  if (!query) return true;
  const haystack = [
    message.from,
    message.to,
    message.cc,
    message.subject,
    message.snippet,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function inboxDate(message: GmailInboxMessage): string {
  const ms = Number(message.receivedAt);
  const date = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(message.date);
  if (!Number.isFinite(date.getTime())) return message.date || '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatChatUsage(usage: EmailChatUsage): string {
  const tokens = `${usage.totalTokens.toLocaleString()} tokens`;
  const parts = `${usage.promptTokens.toLocaleString()} in`;
  const out = `${usage.completionTokens.toLocaleString()} out`;
  const cached = usage.cachedTokens
    ? ` · ${usage.cachedTokens.toLocaleString()} cached`
    : '';
  return `${formatUsd(usage.costUsd)} · ${tokens} (${parts} · ${out}${cached})`;
}

function isPdfAttachment(item: GmailInboxAttachment): boolean {
  return (
    item.mimeType === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf')
  );
}

type ReferencedWorkOrder = {
  number: string;
  order?: StoredWorkOrder;
  attachment?: GmailInboxAttachment;
};

function messageAsContext(message: GmailInboxMessage): string {
  return [
    message.from ? `From: ${message.from}` : '',
    message.to ? `To: ${message.to}` : '',
    message.date ? `Date: ${message.date}` : '',
    message.subject ? `Subject: ${message.subject}` : '',
    '',
    message.body || message.snippet,
  ]
    .filter((line, index, lines) => line || lines[index + 1])
    .join('\n');
}

function BriefingBlock({ briefing }: { briefing: EmailBriefingResult }) {
  return (
    <section className="email-brief__result">
      <h3>{briefing.headline}</h3>
      {briefing.briefing.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {briefing.actions.length ? (
        <>
          <h4>Do next</h4>
          <ul>
            {briefing.actions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      {briefing.money.length ? (
        <>
          <h4>Money</h4>
          <ul>
            {briefing.money.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      {briefing.scheduling.length ? (
        <>
          <h4>Scheduling</h4>
          <ul>
            {briefing.scheduling.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="email-brief__items">
        {briefing.emails.map((item, index) => (
          <article
            key={`${item.subject}-${index}`}
            className={`email-brief__item email-brief__item--${item.urgency}`}
          >
            <header>
              <strong>{item.subject || '(no subject)'}</strong>
              <span>{item.urgency}</span>
            </header>
            {item.from ? <small>{item.from}</small> : null}
            <p>{item.summary}</p>
            {item.action ? <p className="email-brief__action">{item.action}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export default function EmailBriefing() {
  const [watchText, setWatchText] = useState('');
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [briefing, setBriefing] = useState<EmailBriefingResult | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [accounts, setAccounts] = useState<GmailInboxAccount[]>([]);
  const [saved, setSaved] = useState<SavedEmailBriefing[]>([]);
  const [inboxEmail, setInboxEmail] = useState('');
  const [messages, setMessages] = useState<GmailInboxMessage[]>([]);
  const [inboxPageToken, setInboxPageToken] = useState('');
  const [inboxSort, setInboxSort] = useState<InboxSort>('newest');
  const [inboxSearch, setInboxSearch] = useState('');
  const [shopMailOnly, setShopMailOnly] = useState(readShopMailOnly);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [openMessage, setOpenMessage] = useState<GmailInboxMessage | null>(null);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [messageBusy, setMessageBusy] = useState(false);
  const [referencedOrders, setReferencedOrders] = useState<ReferencedWorkOrder[]>([]);
  const [pdfViewer, setPdfViewer] = useState<{ title: string; url: string } | null>(null);
  const [pdfBusy, setPdfBusy] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [replyDraft, setReplyDraft] = useState<EmailReplyDraft | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState('');
  const [replyCopied, setReplyCopied] = useState(false);
  const [correspondent, setCorrespondent] = useState<EmailCorrespondent | null>(null);
  const [showReplyEvidence, setShowReplyEvidence] = useState(false);
  const [pasteFiles, setPasteFiles] = useState<Array<{ name: string; dataUrl: string }>>([]);
  const [pasteReply, setPasteReply] = useState<EmailReplyDraft | null>(null);
  const [pasteReplyText, setPasteReplyText] = useState('');
  const [pasteReplyBusy, setPasteReplyBusy] = useState(false);
  const [pasteReplyError, setPasteReplyError] = useState('');
  const [pasteReplyCopied, setPasteReplyCopied] = useState(false);
  const [showPasteEvidence, setShowPasteEvidence] = useState(false);
  const pdfUrlRef = useRef('');
  const inboxLoadSeq = useRef(0);
  const [chatContext, setChatContext] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const [chatMessages, setChatMessages] = useState<EmailChatMessage[]>([]);
  const [chatPins, setChatPins] = useState<ChatPin[]>([]);
  const [chatUsed, setChatUsed] = useState<Array<{ from: string; subject: string }>>([]);
  const [chatContextNote, setChatContextNote] = useState('');
  const [chatContextLimit, setChatContextLimit] = useState(() => {
    try {
      return clampChatContextLimit(localStorage.getItem(CHAT_CONTEXT_STORAGE_KEY));
    } catch {
      return CHAT_CONTEXT_LIMIT;
    }
  });
  const [chatId, setChatId] = useState('');
  const [savedChats, setSavedChats] = useState<SavedInboxChat[]>([]);
  const restoredChat = useRef(false);
  const bodyCache = useRef(new Map<string, GmailInboxMessage>());

  const parsed = useMemo(() => parsePastedEmails(paste), [paste]);
  const watch = useMemo(() => parseWatchAddresses(watchText), [watchText]);
  const shopMessages = useMemo(
    () => (shopMailOnly ? messages.filter((message) => !isAdvertisement(message)) : messages),
    [messages, shopMailOnly]
  );
  const hiddenCount = messages.length - shopMessages.length;
  const inboxPeople = useMemo(() => {
    const byKey = new Map<string, { name: string; email: string; label: string }>();
    for (const message of shopMessages) {
      for (const person of [
        ...headerPeople(message.from),
        ...headerPeople(message.to),
        ...headerPeople(message.cc),
      ]) {
        const key = person.email || person.label.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, person);
      }
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [shopMessages]);
  const peopleSuggestions = useMemo(() => {
    const query = inboxSearch.trim().toLowerCase();
    const pool = query
      ? inboxPeople.filter(
          (person) =>
            person.label.toLowerCase().includes(query) || person.email.includes(query)
        )
      : inboxPeople;
    return pool.slice(0, 12);
  }, [inboxPeople, inboxSearch]);
  const visibleMessages = useMemo(() => {
    const filtered = shopMessages.filter((message) => messageMatches(message, inboxSearch.trim()));
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (inboxSort === 'sender') return fromName(a.from).localeCompare(fromName(b.from));
      if (inboxSort === 'recipient') {
        const left = headerPeople(a.to)[0]?.label || a.to;
        const right = headerPeople(b.to)[0]?.label || b.to;
        return left.localeCompare(right);
      }
      const delta = receivedMs(b) - receivedMs(a);
      return inboxSort === 'oldest' ? -delta : delta;
    });
    return sorted;
  }, [shopMessages, inboxSearch, inboxSort]);
  const chatSessionCost = useMemo(
    () =>
      chatMessages.reduce(
        (sum, message) => sum + (message.usage?.costUsd || 0),
        0
      ),
    [chatMessages]
  );
  const chatSessionTokens = useMemo(
    () =>
      chatMessages.reduce(
        (sum, message) => sum + (message.usage?.totalTokens || 0),
        0
      ),
    [chatMessages]
  );
  const mentionQuery = atQuery(chatInput);
  const mentionSuggestions = useMemo((): AtSuggestion[] => {
    if (mentionQuery === null) return [];
    const query = mentionQuery;
    const items: AtSuggestion[] = [];
    if (openMessage && (!query || 'this'.includes(query) || openMessage.subject.toLowerCase().includes(query))) {
      items.push({
        kind: 'message',
        id: openMessage.id,
        label: openMessage.subject || 'This message',
        hint: 'Open message',
      });
    }
    for (const person of inboxPeople) {
      if (
        query &&
        !person.label.toLowerCase().includes(query) &&
        !person.email.includes(query)
      ) {
        continue;
      }
      items.push({
        kind: 'person',
        query: person.email || person.label,
        label: person.label,
        hint: person.email || 'Sender / recipient',
      });
      if (items.length >= 10) break;
    }
    for (const message of visibleMessages.slice(0, 20)) {
      if (items.length >= 12) break;
      const label = message.subject || fromName(message.from);
      if (query && !label.toLowerCase().includes(query) && !fromName(message.from).toLowerCase().includes(query)) {
        continue;
      }
      items.push({
        kind: 'message',
        id: message.id,
        label,
        hint: fromName(message.from),
      });
    }
    return items.slice(0, 12);
  }, [mentionQuery, openMessage, inboxPeople, visibleMessages]);

  const refreshAccounts = async () => {
    const next = await listGmailInboxAccounts();
    setAccounts(next);
    setInboxEmail((current) => current || next[0]?.email || '');
    return next;
  };

  const loadInbox = async (
    email: string,
    mode: 'replace' | 'more' | 'all' = 'replace',
    workOnly = shopMailOnly
  ) => {
    if (!email) {
      setMessages([]);
      setInboxPageToken('');
      setOpenMessage(null);
      setSelectedId('');
      return;
    }
    const seq = ++inboxLoadSeq.current;
    setInboxBusy(true);
    setError('');
    try {
      let pageToken = mode === 'replace' ? '' : inboxPageToken;
      if (mode === 'replace') {
        setMessages([]);
        setOpenMessage(null);
        setSelectedId('');
      }
      let loaded = mode === 'replace' ? [] : messages;
      const maxPages = mode === 'all' ? 15 : 1;
      for (let page = 0; page < maxPages; page += 1) {
        if (mode !== 'replace' && page > 0 && !pageToken) break;
        const result = await listGmailInboxMessages(email, pageToken || undefined, workOnly);
        if (seq !== inboxLoadSeq.current) return;
        const seen = new Set(loaded.map((item) => item.id));
        loaded = [
          ...loaded,
          ...result.messages.filter((item) => item.id && !seen.has(item.id)),
        ];
        pageToken = result.nextPageToken;
        setInboxEmail(result.email || email);
        setMessages(loaded);
        setInboxPageToken(pageToken);
        if (!pageToken) break;
      }
    } catch (err) {
      if (seq !== inboxLoadSeq.current) return;
      setError(err instanceof Error ? err.message : 'Could not load the inbox.');
    } finally {
      if (seq === inboxLoadSeq.current) setInboxBusy(false);
    }
  };

  const showPdf = (bytes: ArrayBuffer, title: string) => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    pdfUrlRef.current = url;
    setPdfViewer({ title, url });
  };

  const closePdf = () => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    pdfUrlRef.current = '';
    setPdfViewer(null);
  };

  useEffect(
    () => () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    },
    []
  );

  const openReferencedPdf = async (item: ReferencedWorkOrder) => {
    setPdfBusy(item.number);
    setPdfError('');
    try {
      if (item.attachment && inboxEmail && openMessage) {
        const bytes = await downloadGmailInboxAttachment(
          inboxEmail,
          openMessage.id,
          item.attachment.id
        );
        showPdf(bytes, `WO ${item.number}`);
        return;
      }
      const order = item.order;
      if (
        order?.teamsTeamId &&
        order.teamsChannelId &&
        order.teamsMessageId &&
        order.teamsAttachmentId
      ) {
        let token = await tryAcquireTokenSilent();
        if (!token) {
          await signInMicrosoft();
          token = await tryAcquireTokenSilent();
        }
        if (!token) {
          throw new Error('Sign in with Microsoft to open the Teams work-order PDF.');
        }
        const bytes = await downloadTeamsWorkOrderPdf({
          teamId: order.teamsTeamId,
          channelId: order.teamsChannelId,
          messageId: order.teamsMessageId,
          attachmentId: order.teamsAttachmentId,
        });
        showPdf(bytes, `WO ${order.workOrderNumber || item.number}`);
        return;
      }
      throw new Error(
        item.order
          ? 'This work order is in the system, but there is no PDF to open.'
          : `Work order ${item.number} is not imported yet. Import it from Teams, or open an attached PDF.`
      );
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : String(err));
    } finally {
      setPdfBusy('');
    }
  };

  const draftReplyForOpenMessage = async () => {
    if (!openMessage || !inboxEmail) return;
    setReplyBusy(true);
    setReplyError('');
    setReplyCopied(false);
    try {
      const result = await draftEmailReply({ email: inboxEmail, messageId: openMessage.id });
      setReplyDraft(result);
      setReplyText(result.reply);
      if (result.correspondent) setCorrespondent(result.correspondent);
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : 'Could not draft a reply.');
    } finally {
      setReplyBusy(false);
    }
  };

  const copyReplyText = async () => {
    try {
      await navigator.clipboard.writeText(replyText);
      setReplyCopied(true);
      window.setTimeout(() => setReplyCopied(false), 1800);
    } catch {
      setReplyError('Clipboard is not available here. Select the text and copy it by hand.');
    }
  };

  const addPasteFiles = async (files: File[]) => {
    const accepted = files.filter(
      (file) => /^image\/(png|jpe?g|gif|webp)$/i.test(file.type) || file.type === 'application/pdf'
    );
    if (!accepted.length) {
      setPasteReplyError('Attach screenshots (PNG/JPG) or PDFs.');
      return;
    }
    const next = await Promise.all(
      accepted.slice(0, 6).map(async (file) => ({ name: file.name, dataUrl: await fileToDataUrl(file) }))
    );
    setPasteFiles((current) => [...current, ...next].slice(0, 6));
    setPasteReplyError('');
  };

  const draftReplyFromPaste = async () => {
    const first = parsed[0];
    const body = first?.body || paste.trim();
    if (!body && !pasteFiles.length) {
      setPasteReplyError('Paste the email text (or attach a screenshot of it) first.');
      return;
    }
    setPasteReplyBusy(true);
    setPasteReplyError('');
    setPasteReplyCopied(false);
    try {
      const result = await draftEmailReply({
        ...(inboxEmail ? { email: inboxEmail } : {}),
        pasted: {
          from: first?.from || '',
          to: first?.to || '',
          subject: first?.subject || '',
          date: first?.date || '',
          body,
          files: pasteFiles,
        },
      });
      setPasteReply(result);
      setPasteReplyText(result.reply);
    } catch (err) {
      setPasteReplyError(err instanceof Error ? err.message : 'Could not draft a reply.');
    } finally {
      setPasteReplyBusy(false);
    }
  };

  const copyPasteReplyText = async () => {
    try {
      await navigator.clipboard.writeText(pasteReplyText);
      setPasteReplyCopied(true);
      window.setTimeout(() => setPasteReplyCopied(false), 1800);
    } catch {
      setPasteReplyError('Clipboard is not available here. Select the text and copy it by hand.');
    }
  };

  const openInboxMessage = async (message: GmailInboxMessage) => {
    setSelectedId(message.id);
    setOpenMessage(message);
    setReferencedOrders([]);
    setPdfError('');
    setReplyDraft(null);
    setReplyText('');
    setReplyError('');
    setShowReplyEvidence(false);
    setCorrespondent(null);
    setMessageBusy(true);
    const senderEmail = headerPeople(message.from)[0]?.email || '';
    if (senderEmail) {
      void getEmailCorrespondent(senderEmail)
        .then((record) => setCorrespondent(record))
        .catch(() => setCorrespondent(null));
    }
    try {
      const full = await getGmailInboxMessage(inboxEmail, message.id);
      bodyCache.current.set(full.id, full);
      setOpenMessage(full);
      setChatContext(messageAsContext(full));
      const numbers = extractWorkOrderNumbers(full.subject, full.body || '', full.snippet || '');
      const pdfs = (full.attachments || []).filter(isPdfAttachment);
      const resolved: ReferencedWorkOrder[] = await Promise.all(
        numbers.map(async (number) => {
          const matches = await findWorkOrdersByNumber(number).catch(() => []);
          const attachment = pdfs.find((item) => attachmentLooksLikeWorkOrder(item.name, number));
          return { number, order: matches[0], attachment };
        })
      );
      if (!resolved.length && pdfs[0]) {
        resolved.push({ number: pdfs[0].name.replace(/\.pdf$/i, ''), attachment: pdfs[0] });
      }
      setReferencedOrders(resolved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that message.');
    } finally {
      setMessageBusy(false);
    }
  };

  useEffect(() => {
    return subscribeGmailBriefings(setSaved);
  }, []);

  useEffect(() => {
    return subscribeInboxChats(
      (chats) => {
        setSavedChats(chats);
        if (!restoredChat.current && chats[0]?.messages.length) {
          restoredChat.current = true;
          setChatId(chats[0].id);
          setChatMessages(chats[0].messages);
          setChatPins(chats[0].pins);
          setChatUsed(chats[0].used);
        }
      },
      (err) => console.warn('Could not load saved inbox chats:', err)
    );
  }, []);

  useEffect(() => {
    void refreshAccounts()
      .then((next) => {
        if (next[0]?.email) return loadInbox(next[0].email);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Could not load signed-in inboxes.');
      });
  }, []);

  useEffect(() => {
    const callback = captureGmailOAuthCallback();
    if (!callback || gmailFinishStarted) return;
    gmailFinishStarted = true;
    if (callback.error) {
      setError(`Google sign-in was cancelled or blocked (${callback.error}).`);
      clearGmailOAuthQuery();
      return;
    }
    setBusy(true);
    setStatus('Finishing Google sign-in and reading the inbox…');
    void finishGmailInboxSignIn({ code: callback.code, state: callback.state })
      .then(async (result) => {
        clearGmailOAuthQuery();
        await refreshAccounts();
        await loadInbox(result.email);
        setStatus(
          result.newCount
            ? `Signed in ${result.email}. Summarized ${result.newCount} new message${result.newCount === 1 ? '' : 's'}.`
            : `Signed in ${result.email}. Inbox is connected.`
        );
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Google sign-in failed.');
      })
      .finally(() => setBusy(false));
  }, []);

  const signInGmail = async () => {
    setBusy(true);
    setError('');
    try {
      const url = await startGmailInboxSignIn(watch[0]);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Google sign-in.');
      setBusy(false);
    }
  };

  const processNow = async (email?: string) => {
    setBusy(true);
    setError('');
    try {
      const { results } = await processGmailInboxesNow(email);
      const added = results.reduce((sum, item) => sum + (item.newCount || 0), 0);
      const failed = results.find((item) => item.error);
      await refreshAccounts();
      if (inboxEmail) await loadInbox(inboxEmail);
      setStatus(
        failed
          ? `${failed.email}: ${failed.error}`
          : added
            ? `Processed ${added} new message${added === 1 ? '' : 's'}.`
            : 'No new inbox messages since the last run.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not process the inbox.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (email: string) => {
    setBusy(true);
    try {
      await disconnectGmailInbox(email);
      const next = await refreshAccounts();
      if (inboxEmail === email) {
        const fallback = next[0]?.email || '';
        setInboxEmail(fallback);
        await loadInbox(fallback);
      }
      setStatus(`Disconnected ${email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect that inbox.');
    } finally {
      setBusy(false);
    }
  };

  const runPaste = async () => {
    setBusy(true);
    setError('');
    try {
      saveWatchAddresses(watch);
      if (!parsed.length) {
        setError('Paste emails or sign in a Gmail inbox.');
        return;
      }
      setBriefing(await summarizeOfficeEmails(parsed, watch));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not summarize those emails.');
    } finally {
      setBusy(false);
    }
  };

  const pinSuggestion = (item: AtSuggestion) => {
    if (item.kind === 'message') {
      setChatPins((current) =>
        current.some((pin) => pin.type === 'message' && pin.id === item.id)
          ? current
          : [...current, { type: 'message', id: item.id, label: item.label }]
      );
      setChatInput((current) => applyAtMention(current, item.label.replace(/\s+/g, '-')));
    } else {
      setChatPins((current) =>
        current.some((pin) => pin.type === 'person' && pin.query === item.query)
          ? current
          : [...current, { type: 'person', query: item.query, label: item.label }]
      );
      setChatInput((current) => applyAtMention(current, item.label.replace(/\s+/g, '-')));
    }
  };

  const fillMessageBodies = async (picked: GmailInboxMessage[]) => {
    const loadOne = async (message: GmailInboxMessage, fullBody: boolean) => {
      const cached = bodyCache.current.get(message.id);
      if (cached?.body) return cached;
      if (message.body) {
        bodyCache.current.set(message.id, message);
        return message;
      }
      if (!fullBody || !inboxEmail) return message;
      try {
        const full = await getGmailInboxMessage(inboxEmail, message.id);
        bodyCache.current.set(full.id, full);
        return full;
      } catch {
        return message;
      }
    };
    const filled: GmailInboxMessage[] = [];
    const fullCount = picked.length;
    for (let index = 0; index < picked.length; index += 6) {
      const chunk = picked.slice(index, index + 6);
      const loaded = await Promise.all(
        chunk.map((message, offset) => loadOne(message, index + offset < fullCount))
      );
      filled.push(...loaded);
    }
    return filled;
  };

  const askChat = async () => {
    const question = chatInput.trim();
    if (!question) {
      setChatError('Type a question. Use @ to attach a sender or message.');
      return;
    }
    setChatBusy(true);
    setChatError('');
    setChatInput('');
    const nextHistory = [...chatMessages, { role: 'user' as const, content: question }];
    setChatMessages(nextHistory);
    try {
      let catalog = [...messages];
      if (inboxEmail && inboxPageToken && catalog.length < Math.max(80, chatContextLimit * 2)) {
        const extra = await listGmailInboxMessages(inboxEmail, inboxPageToken, shopMailOnly).catch(
          () => null
        );
        if (extra?.messages.length) {
          const seen = new Set(catalog.map((item) => item.id));
          catalog = [
            ...catalog,
            ...extra.messages.filter((item) => item.id && !seen.has(item.id)),
          ];
          setMessages(catalog);
          setInboxPageToken(extra.nextPageToken);
        }
      }
      const searchQuery = gmailSearchQuery(question);
      if (inboxEmail && searchQuery) {
        const found = await searchGmailInboxMessages(inboxEmail, searchQuery).catch(() => []);
        const seen = new Set(catalog.map((item) => item.id));
        catalog = [...catalog, ...found.filter((item) => item.id && !seen.has(item.id))];
      }
      const adsSkipped = catalog.filter((item) => isAdvertisement(item)).length;
      const picked = pickRelevantMessages(
        catalog,
        question,
        chatPins,
        selectedId || openMessage?.id,
        chatContextLimit
      );
      const withBodies = await fillMessageBodies(picked);
      const emails = withBodies.map((item) => ({
        from: item.from,
        to: item.to,
        subject: item.subject,
        date: item.date,
        body: item.body || item.snippet || '',
      }));
      const pasted = chatContext.trim() || paste.trim();
      if (!emails.length && !pasted) {
        setChatError('Load the inbox or open a message so chat can pull context.');
        return;
      }
      setChatContextNote(
        `${emails.length} work email${emails.length === 1 ? '' : 's'} in context${
          adsSkipped ? ` · ${adsSkipped} ad${adsSkipped === 1 ? '' : 's'} skipped` : ''
        }`
      );
      const result = await askAboutOfficeEmail(
        question,
        chatMessages.map(({ role, content }) => ({ role, content })),
        emails,
        pasted
      );
      setChatUsed(result.used);
      const nextMessages: EmailChatMessage[] = [
        ...nextHistory,
        { role: 'assistant', content: result.answer, usage: result.usage },
      ];
      setChatMessages(nextMessages);
      const title =
        nextHistory.find((message) => message.role === 'user')?.content.trim().slice(0, 80) ||
        'Inbox chat';
      try {
        const id = await saveInboxChat({
          id: chatId || undefined,
          title,
          inboxEmail,
          messages: nextMessages,
          pins: chatPins,
          used: result.used,
        });
        if (!chatId) setChatId(id);
        restoredChat.current = true;
      } catch (saveError) {
        console.warn('Could not save inbox chat:', saveError);
      }
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Could not answer that.');
    } finally {
      setChatBusy(false);
    }
  };

  const openSavedChat = (chat: SavedInboxChat) => {
    restoredChat.current = true;
    setChatId(chat.id);
    setChatMessages(chat.messages);
    setChatPins(chat.pins);
    setChatUsed(chat.used);
    setChatError('');
  };

  const startNewChat = () => {
    restoredChat.current = true;
    setChatId('');
    setChatMessages([]);
    setChatPins([]);
    setChatUsed([]);
    setChatContextNote('');
    setChatError('');
  };

  const removeSavedChat = async (id: string) => {
    await deleteInboxChat(id);
    if (chatId === id) startNewChat();
  };

  const onDrop = async (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDropActive(false);
    const files = [...event.dataTransfer.files].filter(
      (file) => /\.(eml|txt|md)$/i.test(file.name) || file.type.startsWith('text/')
    );
    if (!files.length) {
      setError('Drop .eml or .txt email files.');
      return;
    }
    const chunks = await Promise.all(files.map((file) => file.text()));
    setPaste((current) => [current, ...chunks].filter(Boolean).join('\n\n----------\n\n'));
  };

  return (
    <div className="email-brief">
      {pdfViewer ? (
        <div className="email-brief__pdf" role="dialog" aria-modal="true" aria-label={pdfViewer.title}>
          <button type="button" className="email-brief__pdf-backdrop" aria-label="Close PDF" onClick={closePdf} />
          <div className="email-brief__pdf-panel">
            <header>
              <strong>{pdfViewer.title}</strong>
              <button type="button" onClick={closePdf}>
                Close
              </button>
            </header>
            <iframe title={pdfViewer.title} src={pdfViewer.url} />
          </div>
        </div>
      ) : null}
      <div className="email-brief__toolbar">
        <div>
          <h2>Inbox</h2>
          <p>
            Signed-in Gmail shows here as a live inbox. Briefings still run in the background every
            15 minutes.
          </p>
        </div>
        <div className="email-brief__actions">
          <button type="button" className="email-brief__primary" disabled={busy} onClick={() => void signInGmail()}>
            {busy ? 'Working…' : 'Sign in with Gmail'}
          </button>
          <button type="button" disabled={inboxBusy || !inboxEmail} onClick={() => void loadInbox(inboxEmail)}>
            {inboxBusy ? 'Loading…' : 'Refresh inbox'}
          </button>
          <button type="button" disabled={busy || !accounts.length} onClick={() => void processNow()}>
            Process new mail
          </button>
        </div>
      </div>

      {accounts.length > 1 ? (
        <div className="email-brief__accounts-bar" role="tablist" aria-label="Inboxes">
          {accounts.map((account) => (
            <button
              key={account.email}
              type="button"
              role="tab"
              aria-selected={account.email === inboxEmail}
              className={account.email === inboxEmail ? 'is-active' : ''}
              disabled={inboxBusy}
              onClick={() => {
                setInboxEmail(account.email);
                void loadInbox(account.email);
              }}
            >
              {account.email}
            </button>
          ))}
        </div>
      ) : null}

      {status ? <div className="email-brief__status">{status}</div> : null}
      {error ? <div className="email-brief__error">{error}</div> : null}

      <div className="email-brief__inbox-tools">
        <label className="email-brief__search">
          Search sender or recipient
          <input
            value={inboxSearch}
            onChange={(event) => {
              setInboxSearch(event.target.value);
              setSuggestOpen(true);
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => window.setTimeout(() => setSuggestOpen(false), 150)}
            placeholder="Start typing or pick a name"
            aria-label="Search inbox by sender or recipient"
            autoComplete="off"
          />
          {suggestOpen && peopleSuggestions.length ? (
            <ul className="email-brief__suggest" role="listbox">
              {peopleSuggestions.map((person) => (
                <li key={`${person.email}-${person.label}`}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setInboxSearch(person.email || person.label);
                      setSuggestOpen(false);
                    }}
                  >
                    <strong>{person.label}</strong>
                    {person.email && person.email !== person.label.toLowerCase() ? (
                      <small>{person.email}</small>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </label>
        <label>
          Sort
          <select
            value={inboxSort}
            onChange={(event) => setInboxSort(event.target.value as InboxSort)}
            aria-label="Sort inbox"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="sender">Sender</option>
            <option value="recipient">Recipient</option>
          </select>
        </label>
        <label className="email-brief__toggle">
          <input
            type="checkbox"
            checked={shopMailOnly}
            disabled={inboxBusy}
            onChange={(event) => {
              const next = event.target.checked;
              setShopMailOnly(next);
              storeShopMailOnly(next);
              if (inboxEmail) void loadInbox(inboxEmail, 'replace', next);
            }}
          />
          Shop mail only
        </label>
        <p className="email-brief__muted">
          {visibleMessages.length === messages.length
            ? `${messages.length} loaded`
            : `${visibleMessages.length} shown · ${messages.length} loaded`}
          {hiddenCount ? ` · ${hiddenCount} ad${hiddenCount === 1 ? '' : 's'} hidden` : ''}
          {inboxPageToken ? ' · more on server' : messages.length ? ' · all loaded' : ''}
        </p>
        <div className="email-brief__actions">
          <button
            type="button"
            disabled={inboxBusy || !inboxPageToken}
            onClick={() => void loadInbox(inboxEmail, 'more')}
          >
            Load more
          </button>
          <button
            type="button"
            disabled={inboxBusy || !inboxPageToken}
            onClick={() => void loadInbox(inboxEmail, 'all')}
          >
            {inboxBusy ? 'Loading…' : 'Load all'}
          </button>
        </div>
      </div>

      <section className="email-brief__inbox" aria-label="Gmail inbox">
        <div className="email-brief__inbox-list">
          {!accounts.length ? (
            <p className="email-brief__muted">Sign in with Gmail to see the inbox.</p>
          ) : inboxBusy && !messages.length ? (
            <p className="email-brief__muted">Loading inbox…</p>
          ) : messages.length === 0 ? (
            <p className="email-brief__muted">No messages in this inbox.</p>
          ) : visibleMessages.length === 0 ? (
            <p className="email-brief__muted">
              {inboxSearch.trim()
                ? 'No messages match that search.'
                : shopMailOnly && messages.length
                  ? 'No shop mail in this batch. Load more, or turn off Shop mail only.'
                  : 'No messages match that search.'}
            </p>
          ) : (
            visibleMessages.map((message) => (
              <button
                key={message.id}
                type="button"
                className={`email-brief__msg${message.unread ? ' email-brief__msg--unread' : ''}${
                  selectedId === message.id ? ' email-brief__msg--selected' : ''
                }`}
                onClick={() => void openInboxMessage(message)}
              >
                <strong>
                  {inboxSort === 'recipient'
                    ? headerPeople(message.to)[0]?.label || message.to || 'No recipient'
                    : fromName(message.from)}
                </strong>
                <span>{inboxDate(message)}</span>
                <em>{message.subject || '(no subject)'}</em>
                <small>
                  {inboxSort === 'recipient'
                    ? `From ${fromName(message.from)}`
                    : message.to
                      ? `To ${headerPeople(message.to)[0]?.label || message.to}`
                      : message.snippet}
                  {message.snippet ? ` · ${message.snippet}` : ''}
                </small>
              </button>
            ))
          )}
        </div>
        <div className="email-brief__inbox-read">
          {openMessage ? (
            <>
              <header>
                <h3>{openMessage.subject || '(no subject)'}</h3>
                <p>{openMessage.from}</p>
                {openMessage.to ? <p>To: {openMessage.to}</p> : null}
                <p>{openMessage.date || inboxDate(openMessage)}</p>
              </header>
              {referencedOrders.length ? (
                <div className="email-brief__wo-refs">
                  {referencedOrders.map((item) => (
                    <button
                      key={item.number}
                      type="button"
                      disabled={Boolean(pdfBusy)}
                      onClick={() => void openReferencedPdf(item)}
                    >
                      {pdfBusy === item.number
                        ? `Opening WO ${item.number}…`
                        : `Open WO ${item.number} PDF${
                            item.order?.customerName ? ` · ${item.order.customerName}` : ''
                          }`}
                    </button>
                  ))}
                </div>
              ) : null}
              {pdfError ? <div className="email-brief__error">{pdfError}</div> : null}
              {messageBusy ? <p className="email-brief__muted">Loading message…</p> : null}
              <pre>{openMessage.body || openMessage.snippet || (messageBusy ? '' : 'No message text.')}</pre>

              <div className="email-brief__reply">
                <div className="email-brief__reply-bar">
                  <button
                    type="button"
                    className="email-brief__primary"
                    disabled={replyBusy || messageBusy}
                    onClick={() => void draftReplyForOpenMessage()}
                  >
                    {replyBusy ? 'Reading email, matching jobs, drafting…' : replyDraft ? 'Redraft AI reply' : 'Draft AI reply'}
                  </button>
                  {!replyDraft ? (
                    <small className="email-brief__muted">
                      Extracts names and order numbers (including from screenshots), matches them to work orders, then drafts a grounded reply.
                    </small>
                  ) : null}
                </div>
                {replyError ? <div className="email-brief__error">{replyError}</div> : null}

                {correspondent ? (
                  <details className="email-brief__correspondent">
                    <summary>
                      {correspondent.name || correspondent.email}
                      {correspondent.company ? ` · ${correspondent.company}` : ''}
                      {` · ${correspondent.messageCount} email${correspondent.messageCount === 1 ? '' : 's'} on file`}
                    </summary>
                    <pre>{correspondent.notesMarkdown || 'No notes yet.'}</pre>
                  </details>
                ) : null}

                {replyDraft ? (
                  <ReplyDraftPanel
                    draft={replyDraft}
                    text={replyText}
                    onTextChange={setReplyText}
                    copied={replyCopied}
                    onCopy={() => void copyReplyText()}
                    showEvidence={showReplyEvidence}
                    onToggleEvidence={() => setShowReplyEvidence((value) => !value)}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <p className="email-brief__muted">
              {accounts.length ? 'Select a message to read it.' : 'No inbox connected yet.'}
            </p>
          )}
        </div>
      </section>

      <section className="email-brief__card">
        <h3>Signed-in inboxes</h3>
        {accounts.length ? (
          <ul className="email-brief__accounts">
            {accounts.map((account) => (
              <li key={account.email}>
                <div>
                  <strong>{account.email}</strong>
                  <small>
                    {account.lastProcessedCount
                      ? `Last briefing: ${account.lastProcessedCount} new`
                      : 'Watching inbox'}
                    {account.lastError ? ` · ${account.lastError}` : ''}
                  </small>
                </div>
                <div className="email-brief__actions">
                  <button type="button" disabled={busy} onClick={() => void processNow(account.email)}>
                    Process
                  </button>
                  <button type="button" disabled={busy} onClick={() => void disconnect(account.email)}>
                    Disconnect
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="email-brief__muted">
            No inboxes yet. Click Sign in with Gmail for each address you want processed.
          </p>
        )}
      </section>

      <section className="email-brief__card">
        <h3>Ask the inbox</h3>
        <p className="email-brief__muted">
          Chat uses the open message plus other mail that matches your question, like Cursor pulling
          relevant files. Type @ to pin a sender or thread. Threads are saved so you can open them
          later.
        </p>
        <label className="email-brief__context-slider">
          <span>
            Emails in next answer <strong>{chatContextLimit}</strong>
          </span>
          <input
            type="range"
            min={CHAT_CONTEXT_MIN}
            max={CHAT_CONTEXT_MAX}
            step={1}
            value={chatContextLimit}
            disabled={chatBusy}
            aria-label="Number of emails to include in chat"
            onChange={(event) => {
              const next = clampChatContextLimit(event.target.value);
              setChatContextLimit(next);
              try {
                localStorage.setItem(CHAT_CONTEXT_STORAGE_KEY, String(next));
              } catch {
                /* ignore quota / private mode */
              }
            }}
          />
          <small>
            {CHAT_CONTEXT_MIN}–{CHAT_CONTEXT_MAX}. More mail can answer better, and costs more tokens.
          </small>
        </label>
        {savedChats.length ? (
          <div className="email-brief__chat-history" aria-label="Saved chats">
            {savedChats.map((chat) => (
              <div
                key={chat.id}
                className={`email-brief__chat-history-item${
                  chat.id === chatId ? ' is-active' : ''
                }`}
              >
                <button type="button" onClick={() => openSavedChat(chat)}>
                  <strong>{chat.title}</strong>
                  <small>
                    {chat.updatedAt
                      ? new Date(chat.updatedAt).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })
                      : 'Saved'}
                    {chat.inboxEmail ? ` · ${chat.inboxEmail}` : ''}
                    {` · ${chat.messages.length} message${chat.messages.length === 1 ? '' : 's'}`}
                  </small>
                </button>
                <button
                  type="button"
                  className="email-brief__chat-history-delete"
                  aria-label={`Delete chat ${chat.title}`}
                  onClick={() => void removeSavedChat(chat.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="email-brief__muted">No saved chats yet. Ask a question and it will stay here.</p>
        )}
        {openMessage ? (
          <div className="email-brief__actions">
            <button
              type="button"
              onClick={() =>
                setChatPins((current) =>
                  current.some((pin) => pin.type === 'message' && pin.id === openMessage.id)
                    ? current
                    : [
                        ...current,
                        {
                          type: 'message',
                          id: openMessage.id,
                          label: openMessage.subject || fromName(openMessage.from),
                        },
                      ]
                )
              }
            >
              Pin this message
            </button>
          </div>
        ) : null}
        {chatPins.length ? (
          <div className="email-brief__pins">
            {chatPins.map((pin) => (
              <button
                key={`${pin.type}-${pin.type === 'message' ? pin.id : pin.query}`}
                type="button"
                className="email-brief__pin"
                onClick={() => setChatPins((current) => current.filter((item) => item !== pin))}
              >
                {pin.label} ×
              </button>
            ))}
          </div>
        ) : null}
        {chatUsed.length || chatSessionTokens || chatContextNote ? (
          <p className="email-brief__muted">
            {chatContextNote || null}
            {chatContextNote && (chatSessionTokens || chatUsed.length) ? ' · ' : ''}
            {chatSessionTokens
              ? `This chat: ${formatUsd(chatSessionCost)} · ${chatSessionTokens.toLocaleString()} tokens`
              : null}
            {chatSessionTokens && chatUsed.length ? ' · ' : ''}
            {chatUsed.length
              ? `Last answer used: ${chatUsed
                  .map((item) => item.subject || item.from)
                  .filter(Boolean)
                  .slice(0, 8)
                  .join(' · ')}`
              : null}
          </p>
        ) : null}
        <textarea
          className="email-brief__extra"
          value={chatContext}
          onChange={(event) => setChatContext(event.target.value)}
          placeholder="Optional extra text to include…"
          aria-label="Optional extra email text"
        />
        <div className="email-brief__chat">
          {chatMessages.length ? (
            <div className="email-brief__chat-log">
              {chatMessages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`email-brief__bubble email-brief__bubble--${message.role}`}
                >
                  <small>{message.role === 'user' ? 'You' : 'Assistant'}</small>
                  <p>{message.content}</p>
                  {message.usage ? (
                    <small className="email-brief__cost">{formatChatUsage(message.usage)}</small>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="email-brief__muted">
              No questions yet. Ask about a job, sender, or the open message. Type @ to pin context.
            </p>
          )}
          {chatError ? <div className="email-brief__error">{chatError}</div> : null}
          <div className="email-brief__chat-compose">
            <div className="email-brief__search">
              <textarea
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !mentionSuggestions.length) {
                    event.preventDefault();
                    void askChat();
                  }
                }}
                placeholder="Ask about the inbox… type @ to attach a sender or message"
                aria-label="Question about the inbox"
              />
              {mentionSuggestions.length ? (
                <ul className="email-brief__suggest email-brief__suggest--chat" role="listbox">
                  {mentionSuggestions.map((item) => (
                    <li key={`${item.kind}-${item.kind === 'message' ? item.id : item.query}`}>
                      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => pinSuggestion(item)}>
                        <strong>{item.label}</strong>
                        <small>{item.hint}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="email-brief__actions">
              <button type="button" className="email-brief__primary" disabled={chatBusy} onClick={() => void askChat()}>
                {chatBusy ? 'Searching inbox…' : 'Ask'}
              </button>
              <button
                type="button"
                disabled={chatBusy || (!chatMessages.length && !chatId)}
                onClick={startNewChat}
              >
                New chat
              </button>
            </div>
          </div>
        </div>
      </section>

      {saved[0] ? (
        <div>
          <p className="email-brief__muted">
            Latest automatic briefing
            {saved[0].accountEmail ? ` · ${saved[0].accountEmail}` : ''}
            {saved[0].createdAt ? ` · ${new Date(saved[0].createdAt).toLocaleString()}` : ''}
            {` · ${saved[0].messageCount} message${saved[0].messageCount === 1 ? '' : 's'}`}
          </p>
          <BriefingBlock briefing={saved[0].result} />
        </div>
      ) : null}

      {briefing ? <BriefingBlock briefing={briefing} /> : null}

      <section className="email-brief__card">
        <h3>Or paste a thread</h3>
        <textarea
          value={watchText}
          onChange={(event) => setWatchText(event.target.value)}
          placeholder="Optional: addresses to emphasize"
          aria-label="Addresses to emphasize"
        />
        <label
          className={`email-brief__drop${dropActive ? ' email-brief__drop--active' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(event) => void onDrop(event)}
        >
          Drop .eml / .txt here
          <input
            type="file"
            accept=".eml,.txt,text/plain,message/rfc822"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files || [])];
              void Promise.all(files.map((file) => file.text())).then((chunks) => {
                setPaste((current) => [current, ...chunks].filter(Boolean).join('\n\n----------\n\n'));
              });
              event.target.value = '';
            }}
          />
        </label>
        <textarea
          className="email-brief__paste"
          value={paste}
          onChange={(event) => setPaste(event.target.value)}
          placeholder="From: …"
          aria-label="Pasted emails"
        />
        <button type="button" disabled={busy} onClick={() => void runPaste()}>
          Summarize pasted emails
        </button>

        <div className="email-brief__reply">
          <div className="email-brief__reply-bar">
            <button
              type="button"
              className="email-brief__primary"
              disabled={pasteReplyBusy}
              onClick={() => void draftReplyFromPaste()}
            >
              {pasteReplyBusy ? 'Reading, matching jobs, drafting…' : 'Draft AI reply to pasted email'}
            </button>
            <label className="email-brief__file-pick">
              Attach screenshot / PDF
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
                multiple
                hidden
                onChange={(event) => {
                  void addPasteFiles([...(event.target.files || [])]);
                  event.target.value = '';
                }}
              />
            </label>
            {pasteFiles.length ? (
              <small className="email-brief__muted">
                {pasteFiles.map((file) => file.name).join(', ')}{' '}
                <button type="button" className="email-brief__link" onClick={() => setPasteFiles([])}>
                  clear
                </button>
              </small>
            ) : (
              <small className="email-brief__muted">
                Uses the first pasted email. Screenshots of tables or highlighted rows are read by the vision model.
              </small>
            )}
          </div>
          {pasteReplyError ? <div className="email-brief__error">{pasteReplyError}</div> : null}
          {pasteReply ? (
            <ReplyDraftPanel
              draft={pasteReply}
              text={pasteReplyText}
              onTextChange={setPasteReplyText}
              copied={pasteReplyCopied}
              onCopy={() => void copyPasteReplyText()}
              showEvidence={showPasteEvidence}
              onToggleEvidence={() => setShowPasteEvidence((value) => !value)}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
