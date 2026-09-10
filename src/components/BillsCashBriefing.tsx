import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '../services/billWorkbookService';
import {
  analyzeStatementSections,
  compactForTerra,
  formatCallableError,
  monthShort,
  runTerraStatementPass,
  type StatementCashAnalysis,
  type StatementMonth,
  type StatementSection,
  type TerraBriefing,
  type VendorTotal,
} from '../services/statementCashService';

const TERRA_CACHE_KEY = 'njplumbing.bills.cash.terra.v1';

const IN_TAGS = ['1-800 Heaters wires', 'Square'] as const;
const OUT_TAGS = [
  'Payroll',
  'Home Depot',
  "Lowe's",
  'Bender Plumbing',
  'Enterprise / fleet',
  'MCA advances',
  'Zelle',
  'ADP',
  'Amazon',
  'Meals / QSR',
] as const;

const WASH_BUCKETS: { label: string; tags: string[]; note: string }[] = [
  { label: 'Payroll & ADP', tags: ['Payroll', 'ADP'], note: 'Crew and payroll tax/fees' },
  { label: 'Materials', tags: ['Home Depot', "Lowe's", 'Bender Plumbing'], note: 'Supply houses and big-box' },
  { label: 'Enterprise', tags: ['Enterprise / fleet'], note: 'Vehicle rental on the card' },
  { label: 'Daily ACH (Slate / Elite)', tags: ['MCA advances'], note: 'Payback of advances already received, plus any factor' },
  { label: 'Zelle', tags: ['Zelle'], note: 'Transfers — job, draw, or personal; statement does not say' },
  { label: 'Meals & Amazon card', tags: ['Meals / QSR', 'Amazon'], note: 'Debit card' },
];

function cacheKey(analysis: ReturnType<typeof compactForTerra>) {
  return JSON.stringify({
    coverage: analysis.coverage,
    fileCount: analysis.fileCount,
    uniqueMonthCount: analysis.uniqueMonthCount,
    totals: analysis.officialTotals,
  });
}

function loadCachedTerra(key: string): TerraBriefing | null {
  try {
    const raw = localStorage.getItem(TERRA_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { key?: string; briefing?: TerraBriefing };
    return parsed.key === key ? parsed.briefing || null : null;
  } catch {
    return null;
  }
}

function saveCachedTerra(key: string, briefing: TerraBriefing) {
  localStorage.setItem(TERRA_CACHE_KEY, JSON.stringify({ key, briefing }));
}

function pct(part: number, whole: number) {
  if (!whole) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function vendorAmount(vendors: Record<string, VendorTotal>, label: string) {
  return vendors[label]?.total || 0;
}

function vendorCount(vendors: Record<string, VendorTotal>, label: string) {
  return vendors[label]?.count || 0;
}

function netClass(value: number) {
  if (value > 0) return 'bills__amt bills__amt--in';
  if (value < 0) return 'bills__amt bills__amt--out';
  return 'bills__amt';
}

function FlowTrack({
  value,
  max,
  direction,
}: {
  value: number;
  max: number;
  direction: 'in' | 'out';
}) {
  const width = Math.max(1.5, (Math.abs(value) / Math.max(max, 1)) * 100);
  return (
    <div className="bills__flow-track">
      <div
        className={`bills__flow-fill bills__flow-fill--${direction}`}
        style={{ width: `${Math.min(100, width)}%` }}
      />
    </div>
  );
}

function FlowList({
  rows,
  max,
  direction,
  shareOf,
}: {
  rows: { label: string; total: number; count: number }[];
  max: number;
  direction: 'in' | 'out';
  shareOf: number;
}) {
  return (
    <div className="bills__flow-list">
      {rows
        .filter((row) => row.total > 0)
        .map((row) => (
          <div className="bills__flow-row" key={row.label}>
            <div className="bills__flow-row-top">
              <span>{row.label}</span>
              <strong className={direction === 'in' ? 'bills__amt--in' : 'bills__amt--out'}>
                {formatUsd(row.total)}
              </strong>
            </div>
            <FlowTrack value={row.total} max={max} direction={direction} />
            <small>
              {row.count.toLocaleString()} items · {pct(row.total, shareOf)} of {direction === 'in' ? 'deposits' : 'outflows'}
            </small>
          </div>
        ))}
    </div>
  );
}

function monthFlowRows(month: StatementMonth, analysis: StatementCashAnalysis) {
  const inRows: { label: string; total: number; count: number }[] = IN_TAGS.map((label) => ({
    label,
    total: vendorAmount(month.vendors, label),
    count: vendorCount(month.vendors, label),
  }));
  const taggedIn = inRows.reduce((sum, row) => sum + row.total, 0);
  const otherIn = Math.max(0, month.deposits - taggedIn);
  if (otherIn > 0) inRows.push({ label: 'Other deposits', total: otherIn, count: 0 });

  const outRows: { label: string; total: number; count: number }[] = OUT_TAGS.map((label) => ({
    label,
    total: vendorAmount(month.vendors, label),
    count: vendorCount(month.vendors, label),
  }));
  const taggedOut = outRows.reduce((sum, row) => sum + row.total, 0);
  const otherOut = Math.max(0, month.spend - taggedOut);
  if (otherOut > 0) {
    outRows.push({
      label: 'Other / untagged',
      total: otherOut,
      count: 0,
    });
  }

  return {
    inRows,
    outRows,
    inMax: Math.max(month.deposits, ...inRows.map((row) => row.total), 1),
    outMax: Math.max(month.spend, ...outRows.map((row) => row.total), 1),
    shareIn: month.deposits || analysis.totals.deposits,
    shareOut: month.spend || analysis.totals.spend,
  };
}

export default function BillsCashBriefing({ sections }: { sections: StatementSection[] }) {
  const analysis = useMemo(() => analyzeStatementSections(sections), [sections]);
  const compact = useMemo(() => (analysis ? compactForTerra(analysis) : null), [analysis]);
  const compactKey = compact ? cacheKey(compact) : '';
  const [terra, setTerra] = useState<TerraBriefing | null>(null);
  const [passLabel, setPassLabel] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');

  useEffect(() => {
    if (!compactKey) {
      setTerra(null);
      return;
    }
    setTerra(loadCachedTerra(compactKey));
  }, [compactKey]);

  useEffect(() => {
    if (!analysis?.months.length) {
      setSelected('');
      return;
    }
    setSelected((current) =>
      analysis.months.some((row) => row.label === current) ? current : analysis.months.at(-1)!.label
    );
  }, [analysis]);

  const period = useMemo(() => {
    if (!analysis) return null;
    const inRows: { label: string; total: number; count: number }[] = IN_TAGS.map((label) => ({
      label,
      total: vendorAmount(analysis.vendorTotals, label),
      count: vendorCount(analysis.vendorTotals, label),
    }));
    const taggedIn = inRows.reduce((sum, row) => sum + row.total, 0);
    const otherIn = Math.max(0, analysis.totals.deposits - taggedIn);
    if (otherIn > 0) inRows.push({ label: 'Other deposits', total: otherIn, count: 0 });

    const outRows: { label: string; total: number; count: number }[] = OUT_TAGS.map((label) => ({
      label,
      total: vendorAmount(analysis.vendorTotals, label),
      count: vendorCount(analysis.vendorTotals, label),
    }));
    const taggedOut = outRows.reduce((sum, row) => sum + row.total, 0);
    const otherOut = Math.max(0, analysis.totals.spend - taggedOut);
    if (otherOut > 0) outRows.push({ label: 'Other / untagged', total: otherOut, count: 0 });

    const buckets = WASH_BUCKETS.map((bucket) => ({
      label: bucket.label,
      note: bucket.note,
      total: bucket.tags.reduce((sum, tag) => sum + vendorAmount(analysis.vendorTotals, tag), 0),
    }));
    const taggedBucket = buckets.reduce((sum, row) => sum + row.total, 0);
    const rest = Math.max(0, analysis.totals.spend - taggedBucket);
    if (rest > 0) {
      buckets.push({
        label: 'Everything else',
        note: 'Other card, electronic, and withdrawals not in the tags above',
        total: rest,
      });
    }

    return {
      inRows,
      outRows,
      inMax: Math.max(...inRows.map((row) => row.total), 1),
      outMax: Math.max(...outRows.map((row) => row.total), 1),
      buckets,
    };
  }, [analysis]);

  const selectedMonth = analysis?.months.find((row) => row.label === selected);
  const monthDetail = selectedMonth && analysis ? monthFlowRows(selectedMonth, analysis) : null;
  const chartMax = analysis
    ? Math.max(...analysis.months.map((row) => Math.max(row.deposits, row.spend)), 1)
    : 1;

  const runTerra = async () => {
    if (!compact) return;
    setWorking(true);
    setError('');
    try {
      setPassLabel('Pass 1 of 3…');
      const cash = await runTerraStatementPass({ pass: 'cash', compact });
      setTerra({ cash, costs: null, briefing: null });
      setPassLabel('Pass 2 of 3…');
      const costs = await runTerraStatementPass({ pass: 'costs', compact });
      setTerra({ cash, costs, briefing: null });
      setPassLabel('Pass 3 of 3…');
      const briefing = await runTerraStatementPass({
        pass: 'briefing',
        compact,
        prior: { cash, costs, briefing: null },
      });
      const next = { cash, costs, briefing };
      setTerra(next);
      saveCachedTerra(compactKey, next);
      setPassLabel('');
    } catch (err) {
      setError(formatCallableError(err));
    } finally {
      setWorking(false);
    }
  };

  if (!analysis || !period) {
    return (
      <section className="bills__card bills__card--wide">
        <h3>Checking cash flow</h3>
        <p className="bills__muted">
          Drop Chase statement PDFs above. Green is money in. Red is money out. Totals come from the
          statement summaries in this window.
        </p>
      </section>
    );
  }

  const kept = analysis.totals.deposits === 0 ? 0 : analysis.totals.net / analysis.totals.deposits;
  const summaries = [terra?.cash?.headline, terra?.costs?.headline, terra?.briefing?.headline].filter(
    Boolean
  ) as string[];

  return (
    <section className="bills__cash">
      <div className="bills__toolbar">
        <div>
          <h2>Checking cash flow</h2>
          <p>
            Chase ending 3509 · {analysis.uniqueMonthCount} months · {analysis.coverage} ·{' '}
            {analysis.fileCount} files. Green = in. Red = out. Click a month for that month’s tags.
          </p>
        </div>
        <button type="button" disabled={working} onClick={() => void runTerra()}>
          {working ? passLabel || 'Summarizing…' : terra ? 'Refresh summary' : 'Plain-language summary'}
        </button>
      </div>

      {analysis.duplicateNames.length || analysis.missingMonths.length ? (
        <p className="bills__muted">
          {analysis.duplicateNames.length
            ? `Same-month copies not added twice: ${analysis.duplicateNames.join(', ')}. `
            : ''}
          {analysis.missingMonths.length
            ? `No file in this set for ${analysis.missingMonths.join(', ')}.`
            : ''}
        </p>
      ) : null}

      {error ? <div className="bills__error">{error}</div> : null}

      <div className="bills__kpis">
        <div className="bills__kpi bills__kpi--in">
          <span>Money in</span>
          <strong>{formatUsd(analysis.totals.deposits)}</strong>
        </div>
        <div className="bills__kpi bills__kpi--out">
          <span>Money out</span>
          <strong>{formatUsd(analysis.totals.spend)}</strong>
        </div>
        <div className={`bills__kpi ${analysis.totals.net >= 0 ? 'bills__kpi--in' : 'bills__kpi--out'}`}>
          <span>Left in the account</span>
          <strong>{formatUsd(analysis.totals.net)}</strong>
        </div>
        <div className="bills__kpi">
          <span>Share of deposits still in checking</span>
          <strong className={netClass(analysis.totals.net)}>{pct(analysis.totals.net, analysis.totals.deposits)}</strong>
        </div>
        <div className="bills__kpi">
          <span>Latest statement ending balance</span>
          <strong>{formatUsd(analysis.months.at(-1)?.end || 0)}</strong>
        </div>
        <div className="bills__kpi">
          <span>Months in vs out</span>
          <strong>
            <span className="bills__amt--in">{analysis.months.filter((row) => row.net >= 0).length} in</span>
            {' · '}
            <span className="bills__amt--out">{analysis.months.filter((row) => row.net < 0).length} out</span>
          </strong>
        </div>
      </div>

      <div className="bills__card bills__card--wide">
        <h3>Period flow</h3>
        <p className="bills__muted">Official Chase deposits vs total withdrawals for the months on file.</p>
        <div className="bills__flow-compare">
          <div className="bills__flow-row">
            <div className="bills__flow-row-top">
              <span>In</span>
              <strong className="bills__amt--in">{formatUsd(analysis.totals.deposits)}</strong>
            </div>
            <FlowTrack value={analysis.totals.deposits} max={analysis.totals.deposits} direction="in" />
          </div>
          <div className="bills__flow-row">
            <div className="bills__flow-row-top">
              <span>Out</span>
              <strong className="bills__amt--out">{formatUsd(analysis.totals.spend)}</strong>
            </div>
            <FlowTrack value={analysis.totals.spend} max={analysis.totals.deposits} direction="out" />
          </div>
          <div className="bills__kept">
            <div className="bills__kept-track">
              <div className="bills__kept-out" style={{ width: `${Math.min(100, (1 - kept) * 100)}%` }} />
              <div className="bills__kept-in" style={{ width: `${Math.max(0, kept) * 100}%` }} />
            </div>
            <small>
              Of each deposit dollar, {pct(analysis.totals.spend, analysis.totals.deposits)} left as
              withdrawals and {pct(analysis.totals.net, analysis.totals.deposits)} remained.
            </small>
          </div>
        </div>
      </div>

      <div className="bills__card bills__card--wide">
        <h3>The wash — same cash, different buckets</h3>
        <p className="bills__muted">
          In {formatUsd(analysis.totals.deposits)} and out {formatUsd(analysis.totals.spend)} is nearly even
          on this account. That is the checking picture. Tax is a separate calculation: which of these
          buckets are ordinary business expenses, which are payback of money already received, and which
          are draws or life. This page does not file a return.
        </p>
        <div className="bills__wash-bar" title="Share of total outflows">
          {period.buckets
            .filter((row) => row.total > 0)
            .map((row, index) => (
              <div
                key={row.label}
                className="bills__wash-seg"
                style={{
                  width: `${(row.total / analysis.totals.spend) * 100}%`,
                  opacity: 0.38 + (index / Math.max(period.buckets.length - 1, 1)) * 0.62,
                }}
                title={`${row.label} ${formatUsd(row.total)}`}
              />
            ))}
        </div>
        <div className="bills__table-wrap">
          <table>
            <thead>
              <tr>
                <th>Bucket</th>
                <th>On the statements</th>
                <th>Share of out</th>
                <th>What it is</th>
              </tr>
            </thead>
            <tbody>
              {period.buckets.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td className="bills__amt--out">{formatUsd(row.total)}</td>
                  <td>{pct(row.total, analysis.totals.spend)}</td>
                  <td>{row.note}</td>
                </tr>
              ))}
              <tr>
                <td>Left in checking</td>
                <td className="bills__amt--in">{formatUsd(analysis.totals.net)}</td>
                <td>{pct(analysis.totals.net, analysis.totals.deposits)}</td>
                <td>Deposits minus withdrawals for these months</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="bills__flow-split">
        <div className="bills__card">
          <h3>
            <span className="bills__amt--in">Money in</span> — tagged deposits
          </h3>
          <p className="bills__muted">Parsed from credit descriptions. Other deposits is the Chase total minus these tags.</p>
          <FlowList
            rows={period.inRows}
            max={period.inMax}
            direction="in"
            shareOf={analysis.totals.deposits}
          />
        </div>
        <div className="bills__card">
          <h3>
            <span className="bills__amt--out">Money out</span> — tagged withdrawals
          </h3>
          <p className="bills__muted">Parsed from debit descriptions. Untagged is the Chase outflow total minus these tags.</p>
          <FlowList
            rows={period.outRows}
            max={period.outMax}
            direction="out"
            shareOf={analysis.totals.spend}
          />
        </div>
      </div>

      <div className="bills__card bills__card--wide">
        <h3>Each month</h3>
        <p className="bills__muted">Green bar is deposits. Red bar is withdrawals. Click a month for the tag split.</p>
        <div className="bills__month-flow">
          {analysis.months.map((row) => (
            <button
              type="button"
              key={row.label}
              className={`bills__month-flow-item${selected === row.label ? ' bills__month-flow-item--on' : ''}`}
              onClick={() => setSelected(row.label)}
            >
              <small>{monthShort(row.label)}</small>
              <div className="bills__month-flow-bars">
                <div
                  className="bills__month-flow-bar bills__month-flow-bar--in"
                  style={{ height: `${Math.max(3, (row.deposits / chartMax) * 88)}px` }}
                />
                <div
                  className="bills__month-flow-bar bills__month-flow-bar--out"
                  style={{ height: `${Math.max(3, (row.spend / chartMax) * 88)}px` }}
                />
              </div>
              <span className={netClass(row.net)}>{formatUsd(row.net)}</span>
            </button>
          ))}
        </div>
      </div>

      {selectedMonth && monthDetail ? (
        <div className="bills__card bills__card--wide">
          <h3>{monthShort(selectedMonth.label)}</h3>
          <div className="bills__kpis">
            <div className="bills__kpi bills__kpi--in">
              <span>In</span>
              <strong>{formatUsd(selectedMonth.deposits)}</strong>
            </div>
            <div className="bills__kpi bills__kpi--out">
              <span>Out</span>
              <strong>{formatUsd(selectedMonth.spend)}</strong>
            </div>
            <div className={`bills__kpi ${selectedMonth.net >= 0 ? 'bills__kpi--in' : 'bills__kpi--out'}`}>
              <span>Net</span>
              <strong>{formatUsd(selectedMonth.net)}</strong>
            </div>
            <div className="bills__kpi">
              <span>Opened / closed</span>
              <strong>
                {formatUsd(selectedMonth.begin)} → {formatUsd(selectedMonth.end)}
              </strong>
            </div>
          </div>
          <div className="bills__flow-split">
            <FlowList
              rows={monthDetail.inRows}
              max={monthDetail.inMax}
              direction="in"
              shareOf={selectedMonth.deposits}
            />
            <FlowList
              rows={monthDetail.outRows}
              max={monthDetail.outMax}
              direction="out"
              shareOf={selectedMonth.spend}
            />
          </div>
          <div className="bills__table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Chase summary</th>
                  <th>Amount</th>
                  <th>Share of out</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Deposits and additions</td>
                  <td className="bills__amt--in">{formatUsd(selectedMonth.deposits)}</td>
                  <td></td>
                </tr>
                <tr>
                  <td>ATM &amp; debit card</td>
                  <td className="bills__amt--out">{formatUsd(selectedMonth.cardOut)}</td>
                  <td>{pct(selectedMonth.cardOut, selectedMonth.spend)}</td>
                </tr>
                <tr>
                  <td>Electronic withdrawals</td>
                  <td className="bills__amt--out">{formatUsd(selectedMonth.electronicOut)}</td>
                  <td>{pct(selectedMonth.electronicOut, selectedMonth.spend)}</td>
                </tr>
                <tr>
                  <td>Other withdrawals</td>
                  <td className="bills__amt--out">{formatUsd(selectedMonth.otherOut)}</td>
                  <td>{pct(selectedMonth.otherOut, selectedMonth.spend)}</td>
                </tr>
                <tr>
                  <td>Fees</td>
                  <td className="bills__amt--out">{formatUsd(selectedMonth.fees)}</td>
                  <td>{pct(selectedMonth.fees, selectedMonth.spend)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="bills__card bills__card--wide">
        <h3>Monthly checking summary</h3>
        <div className="bills__table-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>In</th>
                <th>Card</th>
                <th>Electronic</th>
                <th>Other</th>
                <th>Fees</th>
                <th>Net</th>
                <th>End</th>
              </tr>
            </thead>
            <tbody>
              {analysis.months.map((row) => (
                <tr
                  key={row.label}
                  className={selected === row.label ? 'bills__row--on' : undefined}
                  onClick={() => setSelected(row.label)}
                >
                  <td>{monthShort(row.label)}</td>
                  <td className="bills__amt--in">{formatUsd(row.deposits)}</td>
                  <td className="bills__amt--out">{formatUsd(row.cardOut)}</td>
                  <td className="bills__amt--out">{formatUsd(row.electronicOut)}</td>
                  <td className="bills__amt--out">{formatUsd(row.otherOut)}</td>
                  <td className="bills__amt--out">{formatUsd(row.fees)}</td>
                  <td className={netClass(row.net)}>{formatUsd(row.net)}</td>
                  <td>{formatUsd(row.end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bills__card bills__card--wide">
        <h3>Tag totals across the file</h3>
        <p className="bills__muted">
          2025 average in {formatUsd(analysis.year2025.avgDeposits)} / out {formatUsd(analysis.year2025.avgSpend)}.
          2026 available months average in {formatUsd(analysis.year2026.avgDeposits)} / out{' '}
          {formatUsd(analysis.year2026.avgSpend)}.
        </p>
        <div className="bills__table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tag</th>
                <th>Direction</th>
                <th>Amount</th>
                <th>Count</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {period.inRows.map((row) => (
                <tr key={`in-${row.label}`}>
                  <td>{row.label}</td>
                  <td className="bills__amt--in">In</td>
                  <td className="bills__amt--in">{formatUsd(row.total)}</td>
                  <td>{row.count ? row.count.toLocaleString() : '—'}</td>
                  <td>{pct(row.total, analysis.totals.deposits)}</td>
                </tr>
              ))}
              {period.outRows.map((row) => (
                <tr key={`out-${row.label}`}>
                  <td>{row.label}</td>
                  <td className="bills__amt--out">Out</td>
                  <td className="bills__amt--out">{formatUsd(row.total)}</td>
                  <td>{row.count ? row.count.toLocaleString() : '—'}</td>
                  <td>{pct(row.total, analysis.totals.spend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {summaries.length ? (
        <details className="bills__statement-preview">
          <summary>Plain-language notes on these totals</summary>
          {summaries.map((line) => (
            <p className="bills__cash-headline" key={line}>
              {line}
            </p>
          ))}
        </details>
      ) : null}
    </section>
  );
}
