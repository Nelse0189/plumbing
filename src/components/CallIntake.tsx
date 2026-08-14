import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PlaudCall, PlaudConnection, PlaudSyncSummary } from '../types';
import {
  askPlaudCalls,
  connectPlaudWebSession,
  getPlaudConnection,
  importPlaudTranscript,
  listPlaudCalls,
  processPlaudCall,
  syncPlaudCalls,
} from '../services/plaudService';
import {
  getDaySchedulingInfo,
  type DaySchedulingInfo,
  type DaySchedulingJob,
} from '../services/dispatchService';
import './CallIntake.css';

function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

function localTodayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayChipLabel(isoDate: string, todayIso: string): string {
  if (isoDate === todayIso) return 'Today';
  if (isoDate === addDaysToIsoDate(todayIso, -1)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function formatLongDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function formatDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return '';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function callDateOf(call: PlaudCall): string {
  if (call.callDate) return call.callDate;
  if (!call.startedAt) return '';
  const parsed = new Date(call.startedAt);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function callNeedsProcessing(call: PlaudCall): boolean {
  return (
    call.status === 'in_plaud' ||
    call.status === 'awaiting_transcript' ||
    call.status === 'failed' ||
    !call.summary
  );
}

function dispatchLaneLabel(lane: DaySchedulingJob['dispatchLane']): string {
  if (lane === 'truck') return 'On a truck';
  if (lane === 'unassigned') return 'Ready / unassigned';
  if (lane === 'not_ready') return 'Not ready';
  return 'Not on dispatch board';
}

function Modal({
  title,
  subtitle,
  onClose,
  wide,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="call-intake__modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="call-intake__modal-backdrop" onClick={onClose} />
      <div
        className={
          wide
            ? 'call-intake__modal-panel call-intake__modal-panel--wide'
            : 'call-intake__modal-panel'
        }
      >
        <header className="call-intake__modal-header">
          <div>
            <strong>{title}</strong>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body
  );
}

function CallSummaryBody({ call }: { call: PlaudCall }) {
  return (
    <div className="call-intake__summary-body">
      <dl className="call-intake__facts">
        <div>
          <dt>When</dt>
          <dd>{call.startedAt ? new Date(call.startedAt).toLocaleString() : '—'}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(call.durationMs) || '—'}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd className="call-intake__status">{call.status.replace('_', ' ')}</dd>
        </div>
        <div>
          <dt>Appointment</dt>
          <dd>{call.appointmentMade ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Work order</dt>
          <dd>{call.workOrderId || '—'}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{call.callerPhone || '—'}</dd>
        </div>
      </dl>
      {call.error ? <p className="call-intake__error">{call.error}</p> : null}
      <section>
        <h3>Dispatcher summary</h3>
        {call.summary ? (
          <pre className="call-intake__transcript">{call.summary}</pre>
        ) : (
          <p className="call-intake__empty">No dispatcher summary yet. Process this call first.</p>
        )}
      </section>
      {call.plaudSummary ? (
        <section>
          <h3>Plaud AI summary</h3>
          <pre className="call-intake__transcript">{call.plaudSummary}</pre>
        </section>
      ) : null}
      {call.customerServiceTips?.length > 0 ? (
        <section>
          <h3>Customer-service tips</h3>
          <ul>
            {call.customerServiceTips.map((tip, index) => (
              <li key={index}>{tip}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {call.appointmentEvidence?.quote ? (
        <section>
          <h3>Appointment wording</h3>
          <p>{call.appointmentEvidence.quote}</p>
        </section>
      ) : null}
      {call.transcript ? (
        <details>
          <summary>Transcript</summary>
          <TranscriptWithEvidence call={call} />
        </details>
      ) : null}
    </div>
  );
}

function SchedulingJobCard({ job }: { job: DaySchedulingJob }) {
  const order = job.workOrder;
  return (
    <article className="call-intake__job">
      <header>
        <strong>WO {order.workOrderNumber || '—'}</strong>
        <span className="call-intake__status">{order.status.replace('_', ' ')}</span>
      </header>
      <dl className="call-intake__facts">
        <div>
          <dt>Customer</dt>
          <dd>{order.customerName || '—'}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{order.phone || '—'}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>{order.address || '—'}</dd>
        </div>
        <div>
          <dt>Job type</dt>
          <dd>{order.jobType || '—'}</dd>
        </div>
        <div>
          <dt>Appointment</dt>
          <dd>
            {order.appointmentDate || '—'}
            {order.appointmentTime ? ` at ${order.appointmentTime}` : ''}
          </dd>
        </div>
        <div>
          <dt>Selected time</dt>
          <dd>{order.selectedTime || 'Not chosen yet'}</dd>
        </div>
        <div>
          <dt>SMS consent</dt>
          <dd>{order.smsConsent ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{order.source || order.sourceFileName || '—'}</dd>
        </div>
        <div>
          <dt>Dispatch</dt>
          <dd>
            {dispatchLaneLabel(job.dispatchLane)}
            {job.truckName ? ` · ${job.truckName}` : ''}
            {job.windowLabel ? ` · ${job.windowLabel}` : ''}
          </dd>
        </div>
        <div>
          <dt>Morning text</dt>
          <dd>{job.morningTextStatus || 'none'}</dd>
        </div>
        <div>
          <dt>Voice confirmation</dt>
          <dd>
            {job.voiceConfirmationResponse
              ? job.voiceConfirmationResponse.replace('_', ' ')
              : 'Not called'}
            {job.voiceConfirmationDetails ? ` · ${job.voiceConfirmationDetails}` : ''}
          </dd>
        </div>
        <div>
          <dt>Schedule board</dt>
          <dd>
            {job.scheduleTruckName
              ? `${job.scheduleTruckName}${job.scheduleTime ? ` at ${job.scheduleTime}` : ''}`
              : 'Not on schedule'}
          </dd>
        </div>
        <div>
          <dt>SMS scheduling</dt>
          <dd>
            {job.schedulingStatus || 'No request'}
            {job.availableTimeSlots?.length
              ? ` · slots ${job.availableTimeSlots.join(', ')}`
              : ''}
          </dd>
        </div>
      </dl>
      {order.callSummary ? (
        <section>
          <h3>Call summary</h3>
          <pre className="call-intake__transcript">{order.callSummary}</pre>
        </section>
      ) : null}
      <section>
        <h3>Notes</h3>
        {order.notes ? (
          <pre className="call-intake__transcript">{order.notes}</pre>
        ) : (
          <p className="call-intake__empty">No notes on this work order.</p>
        )}
      </section>
    </article>
  );
}

function TranscriptWithEvidence({ call }: { call: PlaudCall }) {
  const evidence = call.appointmentEvidence;
  if (!evidence?.quote || evidence.start < 0) {
    return <pre className="call-intake__transcript">{call.transcript}</pre>;
  }
  const start = Math.min(evidence.start, call.transcript.length);
  const end = Math.min(Math.max(evidence.end, start), call.transcript.length);
  return (
    <pre className="call-intake__transcript">
      {call.transcript.slice(0, start)}
      <mark>{call.transcript.slice(start, end)}</mark>
      {call.transcript.slice(end)}
    </pre>
  );
}

export default function CallIntake({
  selectedDate,
  onSelectDate,
}: {
  selectedDate: string;
  onSelectDate: (date: string) => void;
}) {
  const [calls, setCalls] = useState<PlaudCall[]>([]);
  const [connection, setConnection] = useState<PlaudConnection | null>(null);
  const [syncSummary, setSyncSummary] = useState<PlaudSyncSummary | null>(null);
  const [transcript, setTranscript] = useState('');
  const [phone, setPhone] = useState('');
  const [recordingName, setRecordingName] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncMode, setSyncMode] = useState<'day' | 'all' | null>(null);
  const syncing = syncMode !== null;
  const [listScope, setListScope] = useState<'day' | 'all'>('all');
  const todayIso = localTodayIso();
  const recentDays = useMemo(
    () => Array.from({ length: 8 }, (_, index) => addDaysToIsoDate(todayIso, -index)),
    [todayIso]
  );
  const [submitting, setSubmitting] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [webToken, setWebToken] = useState('');
  const [webApiBase, setWebApiBase] = useState('https://api.plaud.ai');
  const [error, setError] = useState<string | null>(null);
  const [processingCallId, setProcessingCallId] = useState<string | null>(null);
  const [processingAll, setProcessingAll] = useState(false);
  const [processProgress, setProcessProgress] = useState('');
  const [summaryCall, setSummaryCall] = useState<PlaudCall | null>(null);
  const [summaryCalls, setSummaryCalls] = useState<PlaudCall[] | null>(null);
  const [dayJobs, setDayJobs] = useState<DaySchedulingInfo | null>(null);
  const [loadingDayJobs, setLoadingDayJobs] = useState(false);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextCalls, nextConnection] = await Promise.all([
        listPlaudCalls({ allTime: true }),
        getPlaudConnection(),
      ]);
      setCalls(nextCalls);
      setConnection(nextConnection);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // Load the full library once; day chips filter it locally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleCalls = useMemo(() => {
    if (listScope === 'all') return calls;
    return calls.filter((call) => callDateOf(call) === selectedDate);
  }, [calls, listScope, selectedDate]);

  const goToDate = (date: string) => {
    setError(null);
    onSelectDate(date);
    setListScope('day');
  };

  const mergeProcessedCall = (processed: PlaudCall) => {
    setCalls((current) => {
      const index = current.findIndex((item) => item.id === processed.id);
      if (index < 0) return [processed, ...current];
      const next = [...current];
      next[index] = { ...current[index], ...processed };
      return next;
    });
    return processed;
  };

  const handleProcessCall = async (call: PlaudCall, openPopup = true) => {
    setProcessingCallId(call.id);
    setError(null);
    try {
      const processed = mergeProcessedCall(
        await processPlaudCall({
          callId: call.id,
          force: call.status === 'failed',
        })
      );
      if (openPopup) setSummaryCall(processed);
      return processed;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setProcessingCallId(null);
    }
  };

  const handleShowSummary = async (call: PlaudCall) => {
    if (callNeedsProcessing(call)) {
      await handleProcessCall(call, true);
      return;
    }
    setSummaryCall(call);
  };

  const handleProcessVisibleCalls = async () => {
    const alreadySummarized = visibleCalls.filter(
      (call) => !callNeedsProcessing(call) && Boolean(call.summary || call.plaudSummary)
    );
    const pending = visibleCalls.filter(callNeedsProcessing);
    setProcessingAll(true);
    setError(null);
    const processed: PlaudCall[] = [];
    try {
      for (let index = 0; index < pending.length; index += 1) {
        const call = pending[index];
        setProcessProgress(`Processing ${index + 1} of ${pending.length}…`);
        const result = await handleProcessCall(call, false);
        if (result) processed.push(result);
      }
      setSummaryCalls([...alreadySummarized, ...processed]);
    } finally {
      setProcessingAll(false);
      setProcessProgress('');
    }
  };

  const handleShowDayWorkOrders = async () => {
    setLoadingDayJobs(true);
    setError(null);
    try {
      const extraIds = calls
        .filter((call) => !call.callDate || call.callDate === selectedDate)
        .map((call) => call.workOrderId)
        .filter((id): id is string => Boolean(id));
      setDayJobs(await getDaySchedulingInfo(selectedDate, extraIds));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDayJobs(false);
    }
  };

  return (
    <div className="call-intake">
      <header className="call-intake__header">
        <div>
          <h2>
            Plaud Call Intake ·{' '}
            {listScope === 'all' ? 'all recordings' : formatLongDate(selectedDate)}
          </h2>
          <p>
            Import every recording from your Plaud account, or jump to yesterday
            and earlier days. The list below shows recordings Plaud currently has
            {' '}{listScope === 'all' ? '(all time)' : `on ${formatLongDate(selectedDate)}`}, including ones not imported yet.
          </p>
          <p className={`call-intake__connection ${connection?.connected ? 'is-connected' : 'is-disconnected'}`}>
            {connection?.connected
              ? `Connected to Plaud${connection.mode === 'web' ? ' via web.plaud.ai' : ''}${connection.name || connection.email ? ` · ${connection.name || connection.email}` : ''}${connection.tokenType ? ` · ${connection.tokenType}` : ''}${connection.apiBase ? ` · ${connection.apiBase.replace(/^https:\/\//, '')}` : ''}${typeof connection.libraryCount === 'number' ? ` · ${connection.libraryCount} in Plaud` : ''}`
              : 'Plaud CLI login is currently blocked by a broken Plaud “bind device” page. Connect with a web.plaud.ai session token below.'}
          </p>
        </div>
        <div className="call-intake__actions">
          <button
            type="button"
            className="call-intake__primary"
            disabled={syncing || !connection?.connected}
            onClick={async () => {
              if (
                !window.confirm(
                  'Import every recording available on Plaud, not just this day? Already saved calls are skipped. The first run can take several minutes.'
                )
              ) {
                return;
              }
              setSyncMode('all');
              setError(null);
              try {
                const summary = await syncPlaudCalls({ allTime: true });
                setSyncSummary(summary);
                setListScope('all');
                await reload();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setSyncMode(null);
              }
            }}
          >
            {syncMode === 'all' ? 'Importing all Plaud calls…' : 'Import all Plaud calls'}
          </button>
          <button
            type="button"
            disabled={syncing || !connection?.connected}
            onClick={async () => {
              setSyncMode('day');
              setError(null);
              try {
                const summary = await syncPlaudCalls({ date: selectedDate });
                setSyncSummary(summary);
                setListScope('day');
                await reload();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setSyncMode(null);
              }
            }}
          >
            {syncMode === 'day' ? 'Syncing this day…' : 'Sync this day'}
          </button>
          <button type="button" disabled={loading} onClick={() => void reload()}>
            {loading ? 'Loading…' : 'Refresh calls'}
          </button>
        </div>
      </header>

      <section className="call-intake__day-nav" aria-label="Call date">
        <div className="call-intake__day-controls">
          <button
            type="button"
            onClick={() => goToDate(addDaysToIsoDate(selectedDate, -1))}
          >
            ← Previous day
          </button>
          <input
            type="date"
            value={selectedDate}
            max={todayIso}
            onChange={(event) => goToDate(event.target.value)}
            aria-label="Call date"
          />
          <button
            type="button"
            disabled={selectedDate >= todayIso}
            onClick={() => goToDate(addDaysToIsoDate(selectedDate, 1))}
          >
            Next day →
          </button>
          <button
            type="button"
            className={selectedDate === todayIso && listScope === 'day' ? 'call-intake__primary' : undefined}
            onClick={() => goToDate(todayIso)}
          >
            Today
          </button>
        </div>
        <div className="call-intake__day-chips">
          {recentDays.map((date) => (
            <button
              key={date}
              type="button"
              className={
                date === selectedDate && listScope === 'day'
                  ? 'call-intake__day-chip call-intake__day-chip--selected'
                  : 'call-intake__day-chip'
              }
              onClick={() => goToDate(date)}
            >
              {dayChipLabel(date, todayIso)}
            </button>
          ))}
        </div>
        <div className="call-intake__day-actions">
          <button
            type="button"
            className="call-intake__primary"
            disabled={processingAll || processingCallId !== null || visibleCalls.length === 0}
            onClick={() => void handleProcessVisibleCalls()}
          >
            {processingAll
              ? processProgress || 'Processing calls…'
              : 'Process calls & show summaries'}
          </button>
          <button
            type="button"
            disabled={loadingDayJobs}
            onClick={() => void handleShowDayWorkOrders()}
          >
            {loadingDayJobs
              ? 'Loading work orders…'
              : `Work orders for ${formatLongDate(selectedDate)}`}
          </button>
        </div>
      </section>

      {error && <div className="call-intake__error">{error}</div>}

      {!connection?.connected && (
        <section className="call-intake__mock">
          <h3>Connect Plaud from web.plaud.ai</h3>
          <p>
            Plaud’s official CLI login is showing a broken page
            (<code>oauth_bind_device_title</code>). Use the normal website instead:
          </p>
          <ol className="call-intake__steps">
            <li>Open <a href="https://web.plaud.ai" target="_blank" rel="noreferrer">https://web.plaud.ai</a> and sign in as usual.</li>
            <li>
              In Edge, open Developer tools with <strong>Ctrl+Shift+I</strong>, or
              right-click the page and choose <strong>Inspect</strong>. On many
              laptops use <strong>Fn+F12</strong>. Or open the ⋯ menu → More tools → Developer tools.
            </li>
            <li>
              You are in the right place: an <code>api.plaud.ai</code> request
              and its <strong>Cookie</strong> / <strong>Cookies</strong> section.
              You can paste the entire Cookie line into the box below. The app
              will pull out <code>pld_wt</code> or <code>pld_ut</code> (the
              value that starts with <code>eyJ</code>). If the Cookies panel is
              a table, copy the Value for <code>pld_wt</code> first, or
              <code>pld_ut</code> if that is the only <code>eyJ</code> cookie.
              A semicolon only separates cookies; it is not part of the token.
            </li>
            <li>
              <code>workspaceId</code> inside <code>pld_sessionMeta</code> is not
              the token. Look at key names on the left of Local Storage, not
              fields inside a JSON value.
            </li>
            <li>
              If a ~360 character token is rejected, it is probably a user
              token. On https://web.plaud.ai run this in Console, then click a
              recording. It copies the next live Authorization token and prints
              only the length:
              <pre className="call-intake__transcript">{`const orig = window.fetch;
window.fetch = async function(...args) {
  const res = await orig.apply(this, args);
  const headers = args[1] && args[1].headers;
  const auth = headers instanceof Headers
    ? (headers.get('Authorization') || '')
    : ((headers && (headers.Authorization || headers.authorization)) || '');
  if (/eyJ/.test(auth)) {
    const token = auth.replace(/^(bearer|wt|ut|wrt)\\s+/i, '');
    copy(token);
    console.log('copied token length', token.length);
    window.fetch = orig;
  }
  return res;
};
console.log('click a Plaud recording now');`}</pre>
            </li>
            <li>
              If Network does not show Authorization, run this in the
              <strong>Console</strong> tab. It prints key names only — paste
              those names here if you get stuck:
              <pre className="call-intake__transcript">{`['localStorage','sessionStorage'].forEach((label) => {
  const store = label === 'localStorage' ? localStorage : sessionStorage;
  Object.keys(store).forEach((k) => {
    const v = store.getItem(k) || '';
    const hints = [];
    if (/workspaceList/i.test(k)) hints.push('name-has-workspaceList');
    if (/token/i.test(k)) hints.push('name-has-token');
    if (v.includes('workspaceToken')) hints.push('has-workspaceToken');
    if (v.startsWith('eyJ') || v.includes('"eyJ')) hints.push('looks-like-jwt');
    console.log(label, k, hints.join(',') || 'no-token-hints');
  });
});`}</pre>
            </li>
          </ol>
          <label>
            Plaud web token
            <textarea
              value={webToken}
              onChange={(event) => setWebToken(event.target.value)}
              placeholder="Paste the whole Cookie line, or the eyJ... value"
            />
          </label>
          <p className="call-intake__sync">
            {webToken.trim()
              ? `Paste length: ${webToken.trim().length} characters${
                  /pld_wt|pld_ut/i.test(webToken)
                    ? '. This looks like a Cookie header — we will extract pld_wt or pld_ut.'
                    : webToken.includes('eyJ')
                      ? `. Found ${(webToken.match(/eyJ/g) || []).length} eyJ value(s).`
                      : '. A real Plaud token starts with eyJ. If this is the Cookie line, paste the whole line.'
                }`
              : 'Paste the whole Cookie line from the api.plaud.ai request, or just the eyJ... cookie value. Do not paste the token into chat.'}
          </p>
          <label>
            API base (usually leave this)
            <input value={webApiBase} onChange={(event) => setWebApiBase(event.target.value)} />
          </label>
          <button
            type="button"
            disabled={connecting || webToken.trim().length < 20}
            onClick={async () => {
              setConnecting(true);
              setError(null);
              try {
                await connectPlaudWebSession({
                  token: webToken,
                  apiBase: webApiBase,
                });
                setWebToken('');
                await reload();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setConnecting(false);
              }
            }}
          >
            {connecting ? 'Connecting…' : 'Connect Plaud account'}
          </button>
        </section>
      )}

      {syncSummary && (
        <p className="call-intake__sync">
          {syncSummary.scope === 'all-time'
            ? 'Imported all Plaud recordings'
            : `Synced ${syncSummary.scope || selectedDate}`}
          {typeof syncSummary.plaudTotal === 'number' ? ` · Plaud library ${syncSummary.plaudTotal}` : ''}
          {' '}· {syncSummary.matched} of {syncSummary.scanned} files ·
          {' '}{syncSummary.imported} imported · {syncSummary.skipped} already saved ·
          {' '}{syncSummary.awaitingTranscript} waiting on transcripts ·
          {' '}{syncSummary.appointments} appointments · {syncSummary.failed} failed.
        </p>
      )}

      <section className="call-intake__chat">
        <h3>
          Ask AI about calls from{' '}
          {listScope === 'all' ? 'these recordings' : formatLongDate(selectedDate)}
        </h3>
        <div>
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Which Plaud recordings booked water-heater appointments?"
          />
          <button
            type="button"
            disabled={asking || !question.trim() || visibleCalls.length === 0}
            onClick={async () => {
              setAsking(true);
              try {
                setAnswer(await askPlaudCalls(selectedDate, question));
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setAsking(false);
              }
            }}
          >
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
        {answer && <p className="call-intake__answer">{answer}</p>}
      </section>

      <section className="call-intake__calls">
        <div className="call-intake__list-header">
          <h3>
            {visibleCalls.length} recording{visibleCalls.length === 1 ? '' : 's'}
            {listScope === 'all' ? ' (all from Plaud)' : ` (${formatLongDate(selectedDate)})`}
          </h3>
          <div className="call-intake__actions">
            <button
              type="button"
              className={listScope === 'all' ? 'call-intake__primary' : undefined}
              onClick={() => setListScope('all')}
            >
              Show all recordings
            </button>
            <button
              type="button"
              className={listScope === 'day' ? 'call-intake__primary' : undefined}
              onClick={() => setListScope('day')}
            >
              Show this day
            </button>
          </div>
        </div>
        {visibleCalls.map((call) => (
          <article key={call.id} className="call-intake__call">
            <header>
              <strong>{call.recordingName || call.callerPhone || 'Untitled Plaud recording'}</strong>
              <span>{call.startedAt ? new Date(call.startedAt).toLocaleString() : ''}</span>
              {formatDuration(call.durationMs) && <span>{formatDuration(call.durationMs)}</span>}
              <span className={`call-intake__status call-intake__status--${call.status}`}>
                {call.status.replace('_', ' ')}
              </span>
              <span className="call-intake__call-actions">
                {callNeedsProcessing(call) ? (
                  <button
                    type="button"
                    disabled={processingAll || processingCallId !== null}
                    onClick={() => void handleProcessCall(call, true)}
                  >
                    {processingCallId === call.id ? 'Processing…' : 'Process'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="call-intake__primary"
                  disabled={processingAll || processingCallId !== null}
                  onClick={() => void handleShowSummary(call)}
                >
                  {processingCallId === call.id ? 'Opening…' : 'Summary'}
                </button>
              </span>
            </header>
            {call.summary && <p>{call.summary}</p>}
            {!call.summary && call.plaudSummary && <p>{call.plaudSummary}</p>}
            {call.appointmentMade && (
              <p className="call-intake__appointment">
                Water-heater appointment detected · Work order: {call.workOrderId}
              </p>
            )}
            {call.status === 'in_plaud' && (
              <p className="call-intake__waiting">
                This recording is in Plaud. Click Process or Summary to pull the transcript and show the dispatcher summary.
              </p>
            )}
            {call.status === 'awaiting_transcript' && (
              <p className="call-intake__waiting">
                Plaud has the recording, but the transcript is not ready yet. Sync again after Plaud finishes processing.
              </p>
            )}
            {call.error && <p className="call-intake__error">{call.error}</p>}
            {call.customerServiceTips?.length > 0 && (
              <ul>
                {call.customerServiceTips.map((tip, index) => (
                  <li key={index}>{tip}</li>
                ))}
              </ul>
            )}
            {call.transcript && (
              <details>
                <summary>
                  Transcript {call.appointmentEvidence?.quote ? '— appointment highlighted' : ''}
                </summary>
                <TranscriptWithEvidence call={call} />
              </details>
            )}
            {call.plaudSummary && call.summary && (
              <details>
                <summary>Plaud AI summary</summary>
                <pre className="call-intake__transcript">{call.plaudSummary}</pre>
              </details>
            )}
          </article>
        ))}
        {!loading && visibleCalls.length === 0 && (
          <p className="call-intake__empty">
            {typeof connection?.libraryCount === 'number' && connection.libraryCount === 0
              ? 'Plaud returned 0 recordings for this login. Sign in at web.plaud.ai as the plumber whose Note has the calls, then paste that account’s Cookie line and connect again.'
              : listScope === 'all'
                ? 'No Plaud recordings found yet. Connect the plumber’s Plaud account, then click Import all Plaud calls.'
                : `No Plaud recordings found for ${formatLongDate(selectedDate)}. Use Previous day or a date chip, or switch to Show all recordings.`}
          </p>
        )}
      </section>

      <section className="call-intake__mock">
        <h3>Import a transcript manually</h3>
        <p>
          Use this only when a recording is not in Plaud yet. Paste output from
          {' '}<code>plaud transcript &lt;id&gt;</code> or any call transcript.
        </p>
        <label>
          Recording name (optional)
          <input value={recordingName} onChange={(event) => setRecordingName(event.target.value)} />
        </label>
        <label>
          Caller phone (optional)
          <input value={phone} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <label>
          Call transcript
          <textarea
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            placeholder="Paste a Plaud transcript or a realistic customer scheduling call…"
          />
        </label>
        <button
          type="button"
          disabled={submitting || transcript.trim().length < 20}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await importPlaudTranscript({
                transcript,
                callerPhone: phone,
                recordingName,
                startedAt: `${selectedDate}T12:00:00.000Z`,
              });
              setTranscript('');
              setPhone('');
              setRecordingName('');
              await reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {submitting ? 'Processing transcript…' : 'Import transcript'}
        </button>
      </section>

      {summaryCall ? (
        <Modal
          title={summaryCall.recordingName || 'Call summary'}
          subtitle={
            summaryCall.startedAt
              ? new Date(summaryCall.startedAt).toLocaleString()
              : undefined
          }
          onClose={() => setSummaryCall(null)}
        >
          <CallSummaryBody call={summaryCall} />
        </Modal>
      ) : null}

      {summaryCalls ? (
        <Modal
          title="Call summaries"
          subtitle={
            listScope === 'all'
              ? `${summaryCalls.length} processed recording${summaryCalls.length === 1 ? '' : 's'}`
              : formatLongDate(selectedDate)
          }
          onClose={() => setSummaryCalls(null)}
          wide
        >
          {summaryCalls.length === 0 ? (
            <p className="call-intake__empty">
              No summaries yet. Import or process recordings first.
            </p>
          ) : (
            <div className="call-intake__summary-list">
              {summaryCalls.map((call) => (
                <article key={call.id} className="call-intake__job">
                  <header>
                    <strong>
                      {call.recordingName || call.callerPhone || 'Untitled Plaud recording'}
                    </strong>
                    <span className={`call-intake__status call-intake__status--${call.status}`}>
                      {call.status.replace('_', ' ')}
                    </span>
                  </header>
                  <CallSummaryBody call={call} />
                </article>
              ))}
            </div>
          )}
        </Modal>
      ) : null}

      {dayJobs ? (
        <Modal
          title={`Work orders · ${formatLongDate(dayJobs.date)}`}
          subtitle={`${dayJobs.jobs.length} work order${dayJobs.jobs.length === 1 ? '' : 's'} · ${dayJobs.assignedCount} on trucks · ${dayJobs.unassignedCount} unassigned · ${dayJobs.notReadyCount} not ready`}
          onClose={() => setDayJobs(null)}
          wide
        >
          {dayJobs.jobs.length === 0 ? (
            <p className="call-intake__empty">
              No work orders are dated {formatLongDate(dayJobs.date)} yet. Process calls that booked appointments, or import work orders from Teams.
            </p>
          ) : (
            <div className="call-intake__summary-list">
              {dayJobs.jobs.map((job) => (
                <SchedulingJobCard key={job.workOrder.id} job={job} />
              ))}
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
