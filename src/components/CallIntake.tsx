import { useEffect, useState } from 'react';
import type { VoxrushCall } from '../types';
import {
  askVoxrushCalls,
  listVoxrushCalls,
  mockVoxrushCall,
} from '../services/voxrushService';
import './CallIntake.css';

function TranscriptWithEvidence({ call }: { call: VoxrushCall }) {
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
  const [calls, setCalls] = useState<VoxrushCall[]>([]);
  const [transcript, setTranscript] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      setCalls(await listVoxrushCalls(selectedDate));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [selectedDate]);

  return (
    <div className="call-intake">
      <header className="call-intake__header">
        <div>
          <h2>Voxrush Call Intake · {selectedDate}</h2>
          <p>
            Mock call ingestion until Voxrush webhook details are available. Calls
            are transcribed, summarized, and attributed to a work order.
          </p>
        </div>
        <button type="button" disabled={loading} onClick={() => void reload()}>
          {loading ? 'Loading…' : 'Refresh calls'}
        </button>
      </header>

      {error && <div className="call-intake__error">{error}</div>}

      <section className="call-intake__mock">
        <h3>Add mock Voxrush call</h3>
        <label>
          Caller phone (optional)
          <input value={phone} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <label>
          Call transcript
          <textarea
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            placeholder="Paste a realistic customer scheduling call transcript…"
          />
        </label>
        <button
          type="button"
          disabled={submitting || transcript.trim().length < 20}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await mockVoxrushCall({
                transcript,
                callerPhone: phone,
                startedAt: `${selectedDate}T12:00:00.000Z`,
              });
              setTranscript('');
              setPhone('');
              await reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {submitting ? 'Processing call…' : 'Process mock call'}
        </button>
      </section>

      <section className="call-intake__chat">
        <h3>Ask AI about calls from this day</h3>
        <div>
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Which calls booked water-heater appointments?"
          />
          <button
            type="button"
            disabled={asking || !question.trim() || calls.length === 0}
            onClick={async () => {
              setAsking(true);
              try {
                setAnswer(await askVoxrushCalls(selectedDate, question));
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
        <h3>{calls.length} calls</h3>
        {calls.map((call) => (
          <article key={call.id} className="call-intake__call">
            <header>
              <strong>{call.callerPhone || 'Unknown caller'}</strong>
              <span>{new Date(call.startedAt).toLocaleString()}</span>
              <span className={`call-intake__status call-intake__status--${call.status}`}>
                {call.status}
              </span>
            </header>
            <p>{call.summary}</p>
            {call.appointmentMade && (
              <p className="call-intake__appointment">
                Water-heater appointment detected · Work order: {call.workOrderId}
              </p>
            )}
            {call.customerServiceTips?.length > 0 && (
              <ul>
                {call.customerServiceTips.map((tip, index) => (
                  <li key={index}>{tip}</li>
                ))}
              </ul>
            )}
            <details>
              <summary>Transcript {call.appointmentEvidence?.quote ? '— appointment highlighted' : ''}</summary>
              <TranscriptWithEvidence call={call} />
            </details>
          </article>
        ))}
        {!loading && calls.length === 0 && (
          <p className="call-intake__empty">No Voxrush calls recorded for this day.</p>
        )}
      </section>
    </div>
  );
}
