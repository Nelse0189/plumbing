import { useEffect, useState } from 'react';
import type { PlaudCall, PlaudConnection, PlaudSyncSummary } from '../types';
import {
  askPlaudCalls,
  connectPlaudWebSession,
  getPlaudConnection,
  importPlaudTranscript,
  listPlaudCalls,
  syncPlaudCalls,
} from '../services/plaudService';
import './CallIntake.css';

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

export default function CallIntake({ selectedDate }: { selectedDate: string }) {
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
  const [submitting, setSubmitting] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [webToken, setWebToken] = useState('');
  const [webApiBase, setWebApiBase] = useState('https://api.plaud.ai');
  const [error, setError] = useState<string | null>(null);

  const reload = async (scope: 'day' | 'all' = listScope) => {
    setLoading(true);
    setError(null);
    try {
      const [nextCalls, nextConnection] = await Promise.all([
        listPlaudCalls(
          scope === 'all' ? { allTime: true } : { date: selectedDate }
        ),
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
    let cancelled = false;
    setAnswer('');
    setLoading(true);
    setError(null);
    void Promise.all([
      listPlaudCalls(
        listScope === 'all' ? { allTime: true } : { date: selectedDate }
      ),
      getPlaudConnection(),
    ])
      .then(([nextCalls, nextConnection]) => {
        if (cancelled) return;
        setCalls(nextCalls);
        setConnection(nextConnection);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate, listScope]);

  return (
    <div className="call-intake">
      <header className="call-intake__header">
        <div>
          <h2>Plaud Call Intake · {listScope === 'all' ? 'all recordings' : selectedDate}</h2>
          <p>
            Import every recording from your Plaud account, or just the selected
            date. Already saved calls are skipped. The list below shows
            {' '}{listScope === 'all' ? 'every imported call' : `calls saved for ${selectedDate}`}.
          </p>
          <p className={`call-intake__connection ${connection?.connected ? 'is-connected' : 'is-disconnected'}`}>
            {connection?.connected
              ? `Connected to Plaud${connection.mode === 'web' ? ' via web.plaud.ai' : ''}${connection.name || connection.email ? ` · ${connection.name || connection.email}` : ''}${typeof connection.libraryCount === 'number' ? ` · ${connection.libraryCount} in Plaud` : ''}`
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
                await reload('all');
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
                await reload('day');
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
        <h3>Ask AI about calls from this day</h3>
        <div>
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Which Plaud recordings booked water-heater appointments?"
          />
          <button
            type="button"
            disabled={asking || !question.trim() || calls.length === 0}
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
            {calls.length} recording{calls.length === 1 ? '' : 's'}
            {listScope === 'all' ? ' (all imported)' : ` (${selectedDate})`}
          </h3>
          <div className="call-intake__actions">
            <button
              type="button"
              className={listScope === 'all' ? 'call-intake__primary' : undefined}
              onClick={() => setListScope('all')}
            >
              Show all imported
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
        {calls.map((call) => (
          <article key={call.id} className="call-intake__call">
            <header>
              <strong>{call.recordingName || call.callerPhone || 'Untitled Plaud recording'}</strong>
              <span>{call.startedAt ? new Date(call.startedAt).toLocaleString() : ''}</span>
              {formatDuration(call.durationMs) && <span>{formatDuration(call.durationMs)}</span>}
              <span className={`call-intake__status call-intake__status--${call.status}`}>
                {call.status.replace('_', ' ')}
              </span>
            </header>
            {call.summary && <p>{call.summary}</p>}
            {!call.summary && call.plaudSummary && <p>{call.plaudSummary}</p>}
            {call.appointmentMade && (
              <p className="call-intake__appointment">
                Water-heater appointment detected · Work order: {call.workOrderId}
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
        {!loading && calls.length === 0 && (
          <p className="call-intake__empty">
            {listScope === 'all'
              ? 'No Plaud recordings have been imported yet. Click Import all Plaud calls to pull every recording from your account.'
              : `No Plaud recordings saved for ${selectedDate}. Click Import all Plaud calls to pull every recording, or Sync this day for this date only.`}
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
    </div>
  );
}
