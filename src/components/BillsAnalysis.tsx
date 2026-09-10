import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  azureConfigError,
  getActiveAccount,
  handleRedirectPromise,
  signIn,
} from '../teams-test/auth';
import { downloadSharedWorkbook } from '../teams-test/graphClient';
import {
  analyzeWorkbook,
  analyzeWorkbookFile,
  DEFAULT_BILLS_SHAREPOINT_URL,
  downloadWorkbookFromSharingUrl,
  formatUsd,
  periodKeyFromLine,
  billYearsFromMonths,
  buildYearOverYearComparison,
  setPendingSharePointLoad,
  takePendingSharePointLoad,
  type BillWorkbookAnalysis,
} from '../services/billWorkbookService';
import {
  buildJobTicketBillingWorkbook,
  downloadBillingWorkbook,
  requestNightlyBillingExport,
  subscribeBillingExports,
  type BillingExportRecord,
} from '../services/billingExportService';
import { listJobTicketsForDate } from '../services/jobTicketService';
import { easternDateKey } from '../utils/billingInvoiceExport';
import BillsCashBriefing from './BillsCashBriefing';
import BillsPlaidPanel from './BillsPlaidPanel';
import BillsStatementDrop from './BillsStatementDrop';
import './BillsAnalysis.css';

let billsAutoLoadStarted = false;

function formatYoyMonthTooltip(
  row: {
    monthName: string;
    baseAmount: number;
    compareAmount: number;
    delta: number;
    deltaPercent: number | null;
  },
  baseYear: string,
  compareYear: string
): string {
  const pct =
    row.deltaPercent != null
      ? `${row.delta >= 0 ? '+' : ''}${row.deltaPercent}%`
      : row.baseAmount === 0 && row.compareAmount !== 0
        ? 'new vs prior year'
        : '—';
  return `${row.monthName}: ${formatUsd(row.baseAmount)} (${baseYear}) → ${formatUsd(row.compareAmount)} (${compareYear}) · ${row.delta >= 0 ? '+' : ''}${formatUsd(row.delta)} · ${pct}`;
}

export default function BillsAnalysis() {
  const [shareUrl, setShareUrl] = useState(DEFAULT_BILLS_SHAREPOINT_URL);
  const [analysis, setAnalysis] = useState<BillWorkbookAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const [query, setQuery] = useState('');
  const [invoiceFilter, setInvoiceFilter] = useState('all');
  const [townFilter, setTownFilter] = useState('all');
  const [workFilter, setWorkFilter] = useState('all');
  const [yearFilter, setYearFilter] = useState('all');
  const [monthFilter, setMonthFilter] = useState('all');
  const [unpricedOnly, setUnpricedOnly] = useState(false);
  const [yoyCompareYear, setYoyCompareYear] = useState('');
  const [yoyBaseYear, setYoyBaseYear] = useState('');
  const [yoyUseProjected, setYoyUseProjected] = useState(false);
  const [statementSections, setStatementSections] = useState<{ name: string; text: string }[]>([]);
  const [exportDate, setExportDate] = useState(easternDateKey);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState('');
  const [savedExports, setSavedExports] = useState<BillingExportRecord[]>([]);
  const onStatementSectionsChange = useCallback((next: { name: string; text: string }[]) => {
    setStatementSections(next);
  }, []);

  useEffect(() => {
    return subscribeBillingExports(setSavedExports);
  }, []);

  const applyAnalysis = (next: BillWorkbookAnalysis, source: string) => {
    setAnalysis(next);
    setInvoiceFilter('all');
    setTownFilter('all');
    setWorkFilter('all');
    setYearFilter(next.byYear.find((year) => year.isCurrent)?.year || 'all');
    setMonthFilter('all');
    setQuery('');
    setUnpricedOnly(false);
    const openInvoice = [...next.invoices].reverse().find((invoice) => invoice.jobCount > 0 && invoice.pricedCount === 0);
    setStatus(
      openInvoice
        ? `Loaded ${next.fileName} from ${source}. Invoice ${openInvoice.invoiceNumber} has ${openInvoice.jobCount} jobs still unpriced.`
        : `Loaded ${next.fileName} from ${source}. ${next.lineCount} jobs across ${next.invoices.length || next.sheets.length} invoices.`
    );
  };

  const loadBuffer = async (data: ArrayBuffer, fileName: string, source: string) => {
    applyAnalysis(analyzeWorkbook(data, fileName), source);
  };

  const buildCompletedJobsSheet = async () => {
    const serviceDate = /^\d{4}-\d{2}-\d{2}$/.test(exportDate) ? exportDate : easternDateKey();
    setExporting(true);
    setError('');
    setExportNote('');
    try {
      const tickets = await listJobTicketsForDate(serviceDate);
      const local = buildJobTicketBillingWorkbook(tickets, serviceDate);
      downloadBillingWorkbook(local);
      applyAnalysis(
        analyzeWorkbook(local.bytes.slice().buffer as ArrayBuffer, local.fileName),
        'completed job tickets'
      );
      const signed = local.included.length;
      const drafts = local.skipped.length;
      setExportNote(
        `Downloaded ${local.fileName}. ${signed} completed ticket${signed === 1 ? '' : 's'} added. ${
          drafts ? `${drafts} draft${drafts === 1 ? '' : 's'} listed on Review only.` : 'No drafts for that day.'
        } Rosie’s SharePoint file was not changed.`
      );
      try {
        await requestNightlyBillingExport(serviceDate);
        setStatus(`Saved a Cloud copy of ${local.fileName} for the 10pm run history.`);
      } catch {
        setStatus('Spreadsheet downloaded here. The 10pm Cloud copy will start after functions deploy.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the completed-jobs spreadsheet.');
    } finally {
      setExporting(false);
    }
  };

  const loadFile = async (file: File) => {
    setLoading(true);
    setError('');
    try {
      applyAnalysis(await analyzeWorkbookFile(file), 'upload');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that workbook.');
    } finally {
      setLoading(false);
    }
  };

  const loadFromSharePoint = async (url = shareUrl) => {
    if (!url.trim()) {
      setError('Paste the SharePoint Excel link first.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      try {
        const workbook = await downloadWorkbookFromSharingUrl(url.trim());
        await loadBuffer(workbook.data, workbook.name, 'SharePoint');
        return;
      } catch {
        // Anyone links still need a guest cookie; the local proxy keeps it.
        // If that fails (hosted site, or org policy), sign in once with Graph.
      }
      if (azureConfigError) {
        throw new Error(azureConfigError);
      }
      await handleRedirectPromise();
      if (!getActiveAccount()) {
        setPendingSharePointLoad(url.trim());
        await signIn();
        if (!getActiveAccount()) return;
      }
      const workbook = await downloadSharedWorkbook(url.trim());
      await loadBuffer(workbook.data, workbook.name, 'SharePoint');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        /interaction_in_progress/i.test(message)
          ? 'Microsoft login was already open. Close extra Microsoft popups, refresh Bills, and click Load from SharePoint once.'
          : `${message} You can also drop the .xlsx here.`
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (billsAutoLoadStarted) return;
    billsAutoLoadStarted = true;
    void (async () => {
      try {
        await handleRedirectPromise();
      } catch {
        // Continue; a pending SharePoint load still needs a signed-in account.
      }
      const pending = takePendingSharePointLoad();
      if (pending) {
        setShareUrl(pending);
        await loadFromSharePoint(pending);
        return;
      }
      await loadFromSharePoint(DEFAULT_BILLS_SHAREPOINT_URL);
    })();
    // Intentionally load the live invoice workbook once on mount / Microsoft return.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invoiceMode = analysis?.kind === 'invoice-book';
  const filteredLines = useMemo(() => {
    if (!analysis) return [];
    const needle = query.trim().toLowerCase();
    return analysis.lines.filter((line) => {
      if (invoiceFilter !== 'all' && line.invoiceNumber !== invoiceFilter && line.sheet !== invoiceFilter) {
        return false;
      }
      if (townFilter !== 'all' && (line.town || '(blank)').toLowerCase() !== townFilter.toLowerCase()) {
        return false;
      }
      if (
        workFilter !== 'all' &&
        (line.workPerformed || line.description).toUpperCase() !== workFilter
      ) {
        return false;
      }
      const period = periodKeyFromLine(line);
      if (yearFilter !== 'all') {
        const year = period === 'Unknown' ? 'Unknown' : period.slice(0, 4);
        if (year !== yearFilter) return false;
      }
      if (monthFilter !== 'all' && period !== monthFilter) return false;
      if (unpricedOnly && line.amount !== 0) return false;
      if (!needle) return true;
      return [
        line.vendor,
        line.town,
        line.workPerformed,
        line.description,
        line.orderNumber,
        line.invoiceNumber,
        line.status,
        line.date,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [analysis, query, invoiceFilter, townFilter, workFilter, yearFilter, monthFilter, unpricedOnly]);

  const filteredTotal = filteredLines.reduce((sum, line) => sum + line.amount, 0);
  const currentYear = analysis?.byYear.find((year) => year.isCurrent) || null;
  const currentMonth = currentYear?.months.find((month) => month.projectedAmount != null) || null;
  const selectedYear = yearFilter === 'all' ? null : analysis?.byYear.find((year) => year.year === yearFilter) || null;
  const monthBuckets = selectedYear?.months ?? analysis?.byMonth ?? [];
  const chartMonths = [...monthBuckets]
    .filter((bucket) => /^\d{4}-\d{2}$/.test(bucket.month))
    .reverse()
    .slice(-16);
  const maxMonth = Math.max(
    0,
    ...chartMonths.map((bucket) => Math.max(Math.abs(bucket.amount), Math.abs(bucket.projectedAmount ?? 0)))
  );
  const maxTown = analysis?.byTown[0] ? Math.max(analysis.byTown[0].count, 1) : 1;
  const maxWork = analysis?.byWork[0] ? Math.max(analysis.byWork[0].count, 1) : 1;
  const invoicesByYear = useMemo(() => {
    if (!analysis) return [];
    const groups: Array<{ year: string; invoices: typeof analysis.invoices }> = [];
    for (const invoice of analysis.invoices) {
      const year = invoice.invoiceDate?.slice(0, 4) || 'Unknown';
      if (yearFilter !== 'all' && year !== yearFilter) continue;
      const last = groups[groups.length - 1];
      if (last?.year === year) last.invoices.push(invoice);
      else groups.push({ year, invoices: [invoice] });
    }
    return groups;
  }, [analysis, yearFilter]);

  const billYears = useMemo(
    () => (analysis ? billYearsFromMonths(analysis.byMonth) : []),
    [analysis]
  );

  useEffect(() => {
    if (!analysis || billYears.length === 0) return;
    const preferredCompare =
      analysis.byYear.find((year) => year.isCurrent)?.year || billYears[0];
    const preferredBase =
      billYears.find((year) => year < preferredCompare) ||
      billYears.find((year) => year !== preferredCompare) ||
      preferredCompare;
    setYoyCompareYear((current) =>
      current && billYears.includes(current) ? current : preferredCompare
    );
    setYoyBaseYear((current) =>
      current && billYears.includes(current) && current !== preferredCompare
        ? current
        : preferredBase
    );
  }, [analysis, billYears]);

  const yoyRows = useMemo(() => {
    if (!analysis || !yoyCompareYear || !yoyBaseYear || yoyCompareYear === yoyBaseYear) {
      return [];
    }
    return buildYearOverYearComparison(
      analysis.byMonth,
      yoyCompareYear,
      yoyBaseYear,
      yoyUseProjected
    );
  }, [analysis, yoyCompareYear, yoyBaseYear, yoyUseProjected]);

  const maxYoy = Math.max(
    0,
    ...yoyRows.flatMap((row) => [Math.abs(row.baseAmount), Math.abs(row.compareAmount)])
  );

  const yoyTotals = useMemo(() => {
    const base = yoyRows.reduce((sum, row) => sum + row.baseAmount, 0);
    const compare = yoyRows.reduce((sum, row) => sum + row.compareAmount, 0);
    const delta = Math.round((compare - base) * 100) / 100;
    return {
      base,
      compare,
      delta,
      deltaPercent: base !== 0 ? Math.round((delta / base) * 1000) / 10 : null,
    };
  }, [yoyRows]);

  const selectYear = (year: string) => {
    setYearFilter((current) => (current === year ? 'all' : year));
    setMonthFilter('all');
  };

  const selectMonth = (month: string) => {
    setMonthFilter((current) => (current === month ? 'all' : month));
    if (/^\d{4}-/.test(month)) setYearFilter(month.slice(0, 4));
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDropActive(false);
    const file = event.dataTransfer.files[0];
    if (file) void loadFile(file);
  };

  return (
    <div className="bills">
      <div className="bills__toolbar">
        <div>
          <h2>1-800 Heaters invoices</h2>
          <p>
            N&amp;J Plumbing invoices billed to 1-800 Heaters. Loads Rosie’s Anyone Excel link
            without a Microsoft sign-in. Drop an .xlsx here if you need a local copy.
          </p>
        </div>
        <button type="button" disabled={loading} onClick={() => void loadFromSharePoint()}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <section className="bills__load">
        <label
          className={`bills__drop${dropActive ? ' bills__drop--active' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={onDrop}
        >
          Drop an .xlsx / .csv here, or click to choose a file
          <input
            type="file"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void loadFile(file);
              event.target.value = '';
            }}
          />
        </label>
        <div className="bills__sharepoint">
          <input
            value={shareUrl}
            onChange={(event) => setShareUrl(event.target.value)}
            placeholder="SharePoint Excel link"
            aria-label="SharePoint Excel link"
          />
          <button type="button" disabled={loading} onClick={() => void loadFromSharePoint()}>
            {loading ? 'Loading…' : 'Load from SharePoint'}
          </button>
        </div>
        <p className="bills__muted">
          Uses the Anyone SharePoint link. A Microsoft popup only appears if that download is blocked.
        </p>
      </section>

      <section className="bills__export">
        <div>
          <h3>Completed job tickets → new spreadsheet</h3>
          <p>
            Reviews Job Ticket forms for the day. Signed tickets become invoice rows on a new
            .xlsx. Drafts stay on the Review sheet. Rosie&apos;s live SharePoint file is not
            edited. The same export also runs at 10:00 pm Eastern.
          </p>
        </div>
        <div className="bills__export-row">
          <label>
            Service date
            <input
              type="date"
              value={exportDate}
              onChange={(event) => setExportDate(event.target.value)}
            />
          </label>
          <button type="button" disabled={exporting} onClick={() => void buildCompletedJobsSheet()}>
            {exporting ? 'Building…' : 'Build test spreadsheet'}
          </button>
        </div>
        {exportNote ? <p className="bills__muted">{exportNote}</p> : null}
        {savedExports.length ? (
          <ul className="bills__export-list">
            {savedExports.map((item) => (
              <li key={item.id}>
                {item.fileName} · {item.includedCount} completed
                {item.skippedCount ? ` · ${item.skippedCount} skipped` : ''} · {item.trigger}
              </li>
            ))}
          </ul>
        ) : (
          <p className="bills__muted">No Cloud copies yet. Use the button to build one now.</p>
        )}
      </section>

      {error ? <div className="bills__error">{error}</div> : null}
      {status ? <div className="bills__status">{status}</div> : null}

      <BillsStatementDrop onSectionsChange={onStatementSectionsChange} />
      <BillsCashBriefing sections={statementSections} />
      <BillsPlaidPanel />
      {analysis?.warnings.map((warning) => (
        <div className="bills__warn" key={warning}>
          {warning}
        </div>
      ))}

      {!analysis && !loading ? (
        <p className="bills__muted">Load the workbook to see invoices and jobs.</p>
      ) : null}

      {analysis ? (
        <>
          <div className="bills__kpis">
            <div className="bills__kpi">
              <span>Billed</span>
              <strong>{formatUsd(analysis.totalSpend)}</strong>
            </div>
            <div className="bills__kpi">
              <span>Invoices</span>
              <strong>{analysis.invoices.length || analysis.sheets.length}</strong>
            </div>
            <div className="bills__kpi">
              <span>Jobs</span>
              <strong>{analysis.lineCount}</strong>
            </div>
            <div className="bills__kpi">
              <span>Unpriced jobs</span>
              <strong>{analysis.unpricedCount}</strong>
            </div>
            <div className="bills__kpi">
              <span>Average job</span>
              <strong>{formatUsd(analysis.avgAmount)}</strong>
            </div>
            {currentYear?.projectedAmount != null ? (
              <div className="bills__kpi">
                <span>{currentYear.year} projected</span>
                <strong>{formatUsd(currentYear.projectedAmount)}</strong>
              </div>
            ) : null}
            {currentMonth?.projectedAmount != null ? (
              <div className="bills__kpi">
                <span>{currentMonth.label} projected</span>
                <strong>{formatUsd(currentMonth.projectedAmount)}</strong>
              </div>
            ) : null}
            <div className="bills__kpi">
              <span>Job dates</span>
              <strong>
                {analysis.dateStart && analysis.dateEnd
                  ? `${analysis.dateStart} → ${analysis.dateEnd}`
                  : 'Not detected'}
              </strong>
            </div>
          </div>
          {analysis.billTo ? (
            <p className="bills__muted">
              {analysis.fromCompany} → {analysis.billTo}
            </p>
          ) : null}
          {currentYear?.projectionNote ? (
            <p className="bills__muted">
              {currentYear.year} year-to-date {formatUsd(currentYear.amount)}, projected{' '}
              {formatUsd(currentYear.projectedAmount ?? 0)}
              {currentMonth?.projectedAmount != null
                ? ` · ${currentMonth.label} billed ${formatUsd(currentMonth.amount)}, projected ${formatUsd(currentMonth.projectedAmount)}`
                : ''}
              {' · '}
              {currentYear.projectionNote}.
            </p>
          ) : null}

          <div className="bills__grid">
            <section className="bills__card bills__card--wide">
              <h3>By year</h3>
              {analysis.byYear.length === 0 ? (
                <p className="bills__muted">No dated jobs yet.</p>
              ) : (
                <div className="bills__years">
                  {analysis.byYear.map((year) => (
                    <button
                      type="button"
                      className={`bills__year${yearFilter === year.year ? ' bills__year--active' : ''}`}
                      key={year.year}
                      onClick={() => selectYear(year.year)}
                    >
                      <strong>{year.label}{year.isCurrent ? ' · YTD' : ''}</strong>
                      <span>{formatUsd(year.amount)}</span>
                      {year.projectedAmount != null ? (
                        <span className="bills__year-proj">Projected {formatUsd(year.projectedAmount)}</span>
                      ) : null}
                      <small>
                        {year.count} jobs
                        {year.invoiceCount ? ` · ${year.invoiceCount} invoices` : ''}
                        {year.unpricedCount ? ` · ${year.unpricedCount} unpriced` : ''}
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="bills__card bills__card--wide">
              <h3>{selectedYear ? `By month · ${selectedYear.label}` : 'By month'}</h3>
              {chartMonths.length === 0 ? (
                <p className="bills__muted">No month buckets yet.</p>
              ) : (
                <div className="bills__chart">
                  {chartMonths.map((bucket) => {
                    const actualHeight = Math.max(4, (Math.abs(bucket.amount) / (maxMonth || 1)) * 120);
                    const projectedHeight =
                      bucket.projectedAmount != null
                        ? Math.max(4, (Math.abs(bucket.projectedAmount) / (maxMonth || 1)) * 120)
                        : 0;
                    return (
                      <button
                        type="button"
                        className={`bills__col${monthFilter === bucket.month ? ' bills__col--active' : ''}`}
                        key={bucket.month}
                        title={
                          bucket.projectedAmount != null
                            ? `${bucket.label}: billed ${formatUsd(bucket.amount)}, projected ${formatUsd(bucket.projectedAmount)}`
                            : `${bucket.label}: ${formatUsd(bucket.amount)} · ${bucket.count} jobs`
                        }
                        onClick={() => selectMonth(bucket.month)}
                      >
                        <div
                          className="bills__col-stack"
                          style={{ height: `${Math.max(actualHeight, projectedHeight)}px` }}
                        >
                          {projectedHeight > actualHeight ? (
                            <div
                              className="bills__col-bar bills__col-bar--projected"
                              style={{ height: `${projectedHeight - actualHeight}px` }}
                            />
                          ) : null}
                          <div
                            className="bills__col-bar"
                            style={{
                              height: `${actualHeight}px`,
                              opacity: bucket.unpricedCount === bucket.count && bucket.amount === 0 ? 0.35 : 1,
                            }}
                          />
                        </div>
                        <small>{bucket.label.replace(/ 20/, " '")}</small>
                      </button>
                    );
                  })}
                </div>
              )}
              {monthBuckets.length > 0 ? (
                <div className="bills__table-wrap bills__table-wrap--short">
                  <table>
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th className="num">Jobs</th>
                        <th className="num">Unpriced</th>
                        <th className="num">Labor</th>
                        <th className="num">Extras</th>
                        <th className="num">Avg</th>
                        <th className="num">Billed</th>
                        <th className="num">Projected</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthBuckets.map((bucket) => (
                        <tr
                          key={bucket.month}
                          className={monthFilter === bucket.month ? 'bills__row--active' : ''}
                          onClick={() => selectMonth(bucket.month)}
                        >
                          <td>{bucket.label}</td>
                          <td className="num">{bucket.count}</td>
                          <td className="num">{bucket.unpricedCount || '—'}</td>
                          <td className="num">{formatUsd(bucket.laborAmount)}</td>
                          <td className="num">{formatUsd(bucket.extrasAmount)}</td>
                          <td className="num">{formatUsd(bucket.avgAmount)}</td>
                          <td className="num">{formatUsd(bucket.amount)}</td>
                          <td className="num">
                            {bucket.projectedAmount != null ? formatUsd(bucket.projectedAmount) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
            <section className="bills__card bills__card--wide">
              <h3>Year over year · same month</h3>
              {billYears.length < 2 ? (
                <p className="bills__muted">Need at least two years of dated jobs to compare.</p>
              ) : (
                <>
                  <div className="bills__yoy-controls">
                    <label>
                      Compare
                      <select
                        value={yoyCompareYear}
                        onChange={(event) => setYoyCompareYear(event.target.value)}
                      >
                        {billYears.map((year) => (
                          <option key={year} value={year}>
                            {year}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="bills__muted">vs</span>
                    <label>
                      Base year
                      <select
                        value={yoyBaseYear}
                        onChange={(event) => setYoyBaseYear(event.target.value)}
                      >
                        {billYears.map((year) => (
                          <option key={year} value={year}>
                            {year}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="bills__check">
                      <input
                        type="checkbox"
                        checked={yoyUseProjected}
                        onChange={(event) => setYoyUseProjected(event.target.checked)}
                      />
                      Use {yoyCompareYear} month-end projection where available
                    </label>
                  </div>
                  {yoyCompareYear === yoyBaseYear ? (
                    <p className="bills__muted">Pick two different years.</p>
                  ) : yoyRows.length === 0 ? (
                    <p className="bills__muted">No overlapping months between those years.</p>
                  ) : (
                    <>
                      <p className="bills__muted">
                        {yoyCompareYear} {formatUsd(yoyTotals.compare)} vs {yoyBaseYear}{' '}
                        {formatUsd(yoyTotals.base)}
                        {yoyTotals.deltaPercent != null
                          ? ` · ${yoyTotals.delta >= 0 ? '+' : ''}${formatUsd(yoyTotals.delta)} (${yoyTotals.delta >= 0 ? '+' : ''}${yoyTotals.deltaPercent}%)`
                          : ''}
                      </p>
                      <div className="bills__yoy-chart">
                        {yoyRows.map((row) => {
                          const baseHeight = Math.max(
                            4,
                            (Math.abs(row.baseAmount) / (maxYoy || 1)) * 100
                          );
                          const compareHeight = Math.max(
                            4,
                            (Math.abs(row.compareAmount) / (maxYoy || 1)) * 100
                          );
                          return (
                            <div
                              className="bills__yoy-group"
                              key={row.monthIndex}
                              title={formatYoyMonthTooltip(row, yoyBaseYear, yoyCompareYear)}
                            >
                              <div className="bills__yoy-bars">
                                <div
                                  className="bills__yoy-bar bills__yoy-bar--base"
                                  style={{ height: `${baseHeight}px` }}
                                />
                                <div
                                  className="bills__yoy-bar bills__yoy-bar--compare"
                                  style={{ height: `${compareHeight}px` }}
                                />
                              </div>
                              <small>{row.monthName}</small>
                            </div>
                          );
                        })}
                      </div>
                      <div className="bills__yoy-legend">
                        <span>
                          <i className="bills__yoy-swatch bills__yoy-swatch--base" />
                          {yoyBaseYear}
                        </span>
                        <span>
                          <i className="bills__yoy-swatch bills__yoy-swatch--compare" />
                          {yoyCompareYear}
                          {yoyUseProjected ? ' (projected when shown)' : ''}
                        </span>
                      </div>
                      <div className="bills__table-wrap bills__table-wrap--short">
                        <table>
                          <thead>
                            <tr>
                              <th>Month</th>
                              <th className="num">{yoyBaseYear}</th>
                              <th className="num">{yoyCompareYear}</th>
                              <th className="num">Change</th>
                              <th className="num">Jobs</th>
                            </tr>
                          </thead>
                          <tbody>
                            {yoyRows.map((row) => (
                              <tr
                                key={row.monthIndex}
                                className={
                                  monthFilter === `${yoyCompareYear}-${String(row.monthIndex).padStart(2, '0')}`
                                    ? 'bills__row--active'
                                    : ''
                                }
                                onClick={() =>
                                  selectMonth(`${yoyCompareYear}-${String(row.monthIndex).padStart(2, '0')}`)
                                }
                              >
                                <td>{row.monthName}</td>
                                <td className="num">{formatUsd(row.baseAmount)}</td>
                                <td className="num">
                                  {formatUsd(row.compareAmount)}
                                  {yoyUseProjected && row.compareProjected != null
                                    ? ` (proj ${formatUsd(row.compareProjected)})`
                                    : ''}
                                </td>
                                <td
                                  className={`num${row.delta > 0 ? ' bills__delta--up' : row.delta < 0 ? ' bills__delta--down' : ''}`}
                                >
                                  {row.delta >= 0 ? '+' : ''}
                                  {formatUsd(row.delta)}
                                  {row.deltaPercent != null
                                    ? ` (${row.delta >= 0 ? '+' : ''}${row.deltaPercent}%)`
                                    : ''}
                                </td>
                                <td className="num">
                                  {row.baseCount} → {row.compareCount}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
            <section className="bills__card">
              <h3>Towns</h3>
              <div className="bills__bars">
                {analysis.byTown.slice(0, 8).map((town) => (
                  <button
                    type="button"
                    className="bills__bar-row"
                    key={town.name}
                    onClick={() => setTownFilter(town.name)}
                  >
                    <span title={town.name}>{town.name}</span>
                    <em>
                      {town.count} · {formatUsd(town.amount)}
                    </em>
                    <div className="bills__bar-track">
                      <div
                        className="bills__bar-fill"
                        style={{ width: `${(town.count / maxTown) * 100}%` }}
                      />
                    </div>
                  </button>
                ))}
              </div>
            </section>
            <section className="bills__card">
              <h3>Work performed</h3>
              <div className="bills__bars">
                {analysis.byWork.slice(0, 8).map((work) => (
                  <button
                    type="button"
                    className="bills__bar-row"
                    key={work.name}
                    onClick={() => setWorkFilter(work.name)}
                  >
                    <span title={work.name}>{work.name}</span>
                    <em>
                      {work.count} · {formatUsd(work.amount)}
                    </em>
                    <div className="bills__bar-track">
                      <div
                        className="bills__bar-fill"
                        style={{ width: `${(work.count / maxWork) * 100}%` }}
                      />
                    </div>
                  </button>
                ))}
              </div>
            </section>
            {invoiceMode ? (
              <section className="bills__card">
                <h3>Invoice list · newest first</h3>
                <div className="bills__table-wrap bills__table-wrap--short">
                  {invoicesByYear.map((group) => (
                    <table key={group.year}>
                      <thead>
                        <tr>
                          <th colSpan={2}>{group.year === 'Unknown' ? 'Unknown year' : group.year}</th>
                          <th className="num">Jobs</th>
                          <th className="num">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.invoices.map((invoice) => (
                          <tr
                            key={invoice.sheet}
                            className={invoiceFilter === invoice.invoiceNumber ? 'bills__row--active' : ''}
                            onClick={() => setInvoiceFilter(invoice.invoiceNumber)}
                          >
                            <td>INV {invoice.invoiceNumber}</td>
                            <td>{invoice.invoiceDate || '—'}</td>
                            <td className="num">
                              {invoice.jobCount}
                              {invoice.pricedCount < invoice.jobCount
                                ? ` (${invoice.jobCount - invoice.pricedCount} open)`
                                : ''}
                            </td>
                            <td className="num">{formatUsd(invoice.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <section className="bills__card">
            <h3>Jobs · newest first</h3>
            <div className="bills__filters">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, town, order, model…"
              />
              {invoiceMode ? (
                <select value={invoiceFilter} onChange={(event) => setInvoiceFilter(event.target.value)}>
                  <option value="all">All invoices</option>
                  {analysis.invoices.map((invoice) => (
                    <option key={invoice.sheet} value={invoice.invoiceNumber}>
                      INV {invoice.invoiceNumber}
                    </option>
                  ))}
                </select>
              ) : null}
              <select
                value={yearFilter}
                onChange={(event) => {
                  setYearFilter(event.target.value);
                  setMonthFilter('all');
                }}
              >
                <option value="all">All years</option>
                {analysis.byYear.map((year) => (
                  <option key={year.year} value={year.year}>
                    {year.label}
                  </option>
                ))}
              </select>
              <select
                value={monthFilter}
                onChange={(event) => {
                  const value = event.target.value;
                  setMonthFilter(value);
                  if (/^\d{4}-/.test(value)) setYearFilter(value.slice(0, 4));
                }}
              >
                <option value="all">All months</option>
                {monthBuckets.map((bucket) => (
                  <option key={bucket.month} value={bucket.month}>
                    {bucket.label}
                  </option>
                ))}
              </select>
              <select value={townFilter} onChange={(event) => setTownFilter(event.target.value)}>
                <option value="all">All towns</option>
                {analysis.byTown.map((town) => (
                  <option key={town.name} value={town.name}>
                    {town.name}
                  </option>
                ))}
              </select>
              <select value={workFilter} onChange={(event) => setWorkFilter(event.target.value)}>
                <option value="all">All work</option>
                {analysis.byWork.map((work) => (
                  <option key={work.name} value={work.name}>
                    {work.name}
                  </option>
                ))}
              </select>
              <label className="bills__check">
                <input
                  type="checkbox"
                  checked={unpricedOnly}
                  onChange={(event) => setUnpricedOnly(event.target.checked)}
                />
                Unpriced only
              </label>
              <button
                type="button"
                onClick={() => {
                  setInvoiceFilter('all');
                  setTownFilter('all');
                  setWorkFilter('all');
                  setYearFilter('all');
                  setMonthFilter('all');
                  setQuery('');
                  setUnpricedOnly(false);
                }}
              >
                Clear
              </button>
              <span className="bills__muted">
                {filteredLines.length} shown · {formatUsd(filteredTotal)}
              </span>
            </div>
            <div className="bills__table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>INV</th>
                    <th>Order</th>
                    <th>Name</th>
                    <th>Town</th>
                    <th>Work</th>
                    <th className="num">Labor</th>
                    <th className="num">Extras</th>
                    <th className="num">Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLines.slice(0, 400).map((line) => (
                    <tr key={line.id}>
                      <td>{line.date || '—'}</td>
                      <td>{line.invoiceNumber || line.sheet}</td>
                      <td>{line.orderNumber || '—'}</td>
                      <td>{line.vendor}</td>
                      <td>{line.town || '—'}</td>
                      <td>{line.workPerformed || line.description || '—'}</td>
                      <td className="num">{formatUsd(line.laborAmount ?? 0)}</td>
                      <td className="num">{formatUsd(line.extrasAmount ?? 0)}</td>
                      <td className="num">{formatUsd(line.amount)}</td>
                      <td>{line.status || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
