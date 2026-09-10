import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PlaudCall, PlaudConnection, PlaudSyncSummary, StoredWorkOrder } from '../types';
import {
  askPlaudCalls,
  connectPlaudWebSession,
  getPlaudConnection,
  importPlaudTranscript,
  listPlaudCalls,
  processPlaudCall,
  processPlaudCalls,
  getPlaudCallAudioUrl,
  downloadPlaudCallAudio,
  plaudCallAudioProxyUrl,
  startPlaudOAuth,
  syncPlaudCalls,
} from '../services/plaudService';
import { formatPlaudCallableError } from '../plaudOAuth';
import {
  PLAUD_CONNECT_SOURCE,
  consumePlaudConnectToken,
  isAllowedPlaudConnectOrigin,
  isPlaudWebSessionToken,
  stopPlaudSignInWatcher,
} from '../plaudConnect';
import { canSignInWithPlaudWindow, isPlaudDesktop, signInWithPlaudDesktop } from '../plaudDesktop';
import {
  findWorkOrderForCall,
  getDaySchedulingInfo,
  type DaySchedulingInfo,
  type DaySchedulingJob,
} from '../services/dispatchService';
import { formatUsd } from '../services/importProgressService';
import {
  azureConfigError,
  getActiveAccount,
  handleRedirectPromise,
  signIn,
} from '../teams-test/auth';
import {
  subscribeTeamsWatchTarget,
  type TeamsWatchTarget,
} from '../services/teamsWatchService';
import {
  applyTeamsPostToCall,
  buildTeamsScheduleDraft,
  callHasScheduleForTeams,
  postTeamsScheduleDraft,
  type TeamsSchedulePostDraft,
} from '../services/teamsSchedulePostService';
import NotesWithScheduleHighlight from './NotesWithScheduleHighlight';
import './CallIntake.css';
import './DispatchBoard.css';

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

function formatDetectedDate(value?: string): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatLongDate(value);
  return value;
}

const MONTH_INDEX: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const DAY_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};

function parseDayToken(raw: string): number {
  const text = raw.toLowerCase().trim();
  const digits = text.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
  if (digits) return Number(digits[1]);
  return DAY_WORDS[text] || 0;
}

function inferIsoDateFromText(text: string, startedAt?: string): string {
  const blob = text.trim();
  if (!blob) return '';
  const iso = blob.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const callDate = startedAt
    ? new Date(startedAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    : '';
  const year = Number((callDate || new Date().toISOString().slice(0, 10)).slice(0, 4));
  const lower = blob.toLowerCase().replace(/[.,]/g, ' ');
  const named = lower.match(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)(?:\s+(\d{4}))?/
  );
  if (named) {
    const month = MONTH_INDEX[named[1]];
    const day = parseDayToken(named[2]);
    const useYear = named[3] ? Number(named[3]) : year;
    if (month && day) {
      return `${useYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return '';
}

function textLooksUnscheduled(text: string): boolean {
  return /\b(get back to you|call(ing)? (you )?back|i will call you back|figure out when|once details|to schedule it|probably next week|preferably (the )?next week|next week or the week after|week after|not sure when|sometime (probably )?(next week|the week after)|when you('re| are) ready)\b/i.test(
    text
  );
}

function extractWorkOrderNumberFromText(text: string): string {
  const blob = text.trim();
  if (!blob) return '';
  const patterns = [
    /\bwork[\s-]*order(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*([A-Za-z]{0,4}\d{4,12}(?:-\d{1,8})?)\b/gi,
    /\b(?:wo|w\/o)\s*(?:number|no\.?|#|:)\s*[:#-]?\s*([A-Za-z]{0,4}\d{4,12})\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of blob.matchAll(pattern)) {
      const candidate = (match[1] || '').trim();
      if (
        candidate &&
        !/^plaud-/i.test(candidate) &&
        /\d{4,}/.test(candidate) &&
        !/^\d{4}-\d{2}-\d{2}$/.test(candidate) &&
        !/^\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?$/.test(candidate)
      ) {
        return candidate;
      }
    }
  }
  return '';
}

function workOrderNumberForCall(call: PlaudCall): string {
  const stored = (call.workOrderNumber || '').trim();
  if (stored && !/^plaud-/i.test(stored) && /\d{4,}/.test(stored)) return stored;
  return (
    extractWorkOrderNumberFromText(call.plaudSummary || '') ||
    extractWorkOrderNumberFromText(call.summary || '') ||
    extractWorkOrderNumberFromText(call.recordingName || '')
  );
}

function callHasLinkedWorkOrder(call: PlaudCall): boolean {
  return Boolean(call.workOrderId || workOrderNumberForCall(call));
}

function workOrderFromCall(call: PlaudCall): StoredWorkOrder {
  return {
    id: call.workOrderId || call.id,
    workOrderNumber: workOrderNumberForCall(call),
    customerName: call.customerName || '',
    phone: call.phone || call.callerPhone || '',
    address: call.address || '',
    jobType: '',
    appointmentDate: appointmentDateForCall(call),
    appointmentTime: call.appointmentTime || '',
    notes: call.summary || '',
    sourceFileName: call.recordingName || '',
    smsConsent: false,
    status: call.status === 'processed' ? 'unscheduled' : 'needs_review',
    callSummary: call.summary,
    source: 'plaud_call',
  };
}

function appointmentDateForCall(call: PlaudCall): string {
  const prose = [call.summary, call.plaudSummary, call.appointmentEvidence?.quote]
    .filter(Boolean)
    .join('\n');
  const fromProse = inferIsoDateFromText(prose, call.startedAt);
  if (fromProse) return fromProse;
  if (
    call.appointmentDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(call.appointmentDate) &&
    !textLooksUnscheduled(prose)
  ) {
    return call.appointmentDate;
  }
  return '';
}

function AppointmentDateBadge({
  date,
  time,
}: {
  date?: string;
  time?: string;
}) {
  if (!date) return null;
  return (
    <span className="call-intake__date-badge">
      {formatDetectedDate(date)}
      {time ? ` · ${time}` : ''}
    </span>
  );
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

function compareCallsForList(left: PlaudCall, right: PlaudCall): number {
  if (left.appointmentMade !== right.appointmentMade) {
    return left.appointmentMade ? -1 : 1;
  }
  return (right.startedAt || '').localeCompare(left.startedAt || '');
}

function callNeedsProcessing(call: PlaudCall): boolean {
  if (call.source === 'plumber-phone') {
    return call.status === 'awaiting_transcript' || call.status === 'failed';
  }
  return (
    call.status === 'in_plaud' ||
    call.status === 'awaiting_transcript' ||
    call.status === 'failed' ||
    call.status === 'needs_review' ||
    call.source === 'plaud-whisper' ||
    !call.summary
  );
}

function callHasPlaudAudio(call: PlaudCall): boolean {
  if (call.source === 'plumber-phone') return true;
  if (call.source === 'plaud-manual') return false;
  const fileId = call.id.replace(/^plaud-/, '');
  return Boolean(fileId) && !fileId.startsWith('manual-');
}

function audioDownloadName(call: PlaudCall, fallback: string): string {
  const raw = (call.recordingName || fallback || 'call').replace(/[<>:"/\\|?*]+/g, '-').trim();
  const base = raw.slice(0, 80) || 'call';
  return /\.(mp3|opus|m4a|wav|ogg)$/i.test(base) ? base : `${base}.mp3`;
}

function isStaleReviewReason(reason: string): boolean {
  return /arrival time|callback window|clock time|calendar date|YYYY-MM-DD|appointment date/i.test(
    reason
  );
}

function reviewReasonsForCall(call: PlaudCall): string[] {
  const stored = (call.reviewReasons || []).filter((reason) => !isStaleReviewReason(reason));
  if (stored.length > 0) return stored;
  if (call.status !== 'needs_review') return [];
  const reasons: string[] = [];
  if (!call.appointmentMade) {
    reasons.push('The analyzer did not treat this as a fully confirmed appointment.');
  }
  const evidence = call.appointmentEvidence;
  if (evidence?.quote && !(evidence.end > evidence.start)) {
    reasons.push(
      'The booking quote was paraphrased and could not be matched in the transcript, so it was not treated as confirmed.'
    );
  } else if (!evidence?.quote) {
    reasons.push('No exact wording from the call was saved that confirms the booking.');
  }
  if (!call.phone && !call.callerPhone) {
    reasons.push('Customer phone number is missing.');
  }
  if (call.address && !/[0-9]/.test(call.address)) {
    reasons.push('Service address is incomplete (city only or blank).');
  }
  if (reasons.length === 0) {
    reasons.push('A dispatcher needs to confirm the booking details.');
  }
  return reasons;
}

function ReviewReasons({ call }: { call: PlaudCall }) {
  const reasons = reviewReasonsForCall(call);
  if (reasons.length === 0) return null;
  return (
    <section className="call-intake__review">
      <h3>{call.status === 'needs_review' ? 'Why this needs review' : 'Work order needs review'}</h3>
      <ul>
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </section>
  );
}

function transcriptSourceLabel(call: PlaudCall): string {
  if (call.source === 'plaud-whisper') {
    return 'Transcribed here without speaker names. Process again to retry Plaud’s labeled transcript.';
  }
  if (call.hasSpeakerLabels || call.source === 'plaud') {
    return 'Plaud transcript with speaker names';
  }
  if (call.source === 'plaud-unlabeled') {
    return 'Plaud transcript (no speaker names in the file)';
  }
  if (call.source === 'plaud-manual') {
    return 'Pasted transcript';
  }
  if (call.source === 'plumber-phone') {
    return 'Recorded plumber job call';
  }
  return call.source || '';
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
          <dd>
            {call.appointmentMade ? 'Yes' : 'No'}
            {appointmentDateForCall(call) ? (
              <>
                {' '}
                <AppointmentDateBadge
                  date={appointmentDateForCall(call)}
                  time={call.appointmentTime}
                />
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Work order</dt>
          <dd>{workOrderNumberForCall(call) || '—'}</dd>
        </div>
        <div>
          <dt>OpenAI</dt>
          <dd>{call.costUsd != null ? formatUsd(call.costUsd) : '—'}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{call.callerPhone || '—'}</dd>
        </div>
        <div>
          <dt>Transcript</dt>
          <dd>{transcriptSourceLabel(call) || '—'}</dd>
        </div>
      </dl>
      {call.status === 'failed' && call.error ? (
        <p className="call-intake__error">{call.error}</p>
      ) : null}
      <ReviewReasons call={call} />
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

function TeamsScheduleApprovalModal({
  drafts,
  statuses,
  errors,
  approvingId,
  onClose,
  onApprove,
  onSkip,
}: {
  drafts: TeamsSchedulePostDraft[];
  statuses: Record<string, 'pending' | 'posting' | 'posted' | 'skipped' | 'error'>;
  errors: Record<string, string>;
  approvingId: string | null;
  onClose: () => void;
  onApprove: (draft: TeamsSchedulePostDraft) => void;
  onSkip: (callId: string) => void;
}) {
  const pending = drafts.filter((draft) => (statuses[draft.call.id] || 'pending') === 'pending');
  const posted = drafts.filter((draft) => statuses[draft.call.id] === 'posted');
  const skipped = drafts.filter((draft) => statuses[draft.call.id] === 'skipped');
  const busy = approvingId !== null;
  return (
    <Modal
      title="Post schedules to Teams"
      subtitle={`${pending.length} waiting for approval · ${posted.length} posted · ${skipped.length} skipped`}
      onClose={busy ? () => undefined : onClose}
      wide
    >
      <p className="call-intake__teams-confirm-lead">
        These are the schedule notes from Plaud that would go to Teams. Approve each note
        separately. Nothing is posted until you approve that row.
      </p>
      {drafts.length === 0 ? (
        <p className="call-intake__empty">No unposted schedule notes to review.</p>
      ) : (
        <div className="call-intake__summary-list">
          {drafts.map((draft) => {
            const status = statuses[draft.call.id] || 'pending';
            const canApprove =
              (status === 'pending' || status === 'error') &&
              Boolean(draft.destination) &&
              !busy;
            return (
              <article
                key={draft.call.id}
                className={
                  status === 'posted'
                    ? 'call-intake__teams-preview call-intake__teams-preview--posted'
                    : status === 'skipped'
                      ? 'call-intake__teams-preview call-intake__teams-preview--skipped'
                      : 'call-intake__teams-preview'
                }
              >
                <header>
                  <strong>{draft.jobLabel}</strong>
                  <span>
                    {draft.destination
                      ? draft.destination.kind === 'reply'
                        ? `Reply on the work-order thread (${draft.destination.channelName})`
                        : `New post in ${draft.destination.channelName}`
                      : 'No Teams destination yet'}
                  </span>
                  <span className={`call-intake__status call-intake__status--${status}`}>
                    {status === 'posting' ? 'Posting' : status}
                  </span>
                </header>
                {draft.destinationError && status === 'pending' ? (
                  <p className="call-intake__error">{draft.destinationError}</p>
                ) : null}
                {status === 'error' ? (
                  <p className="call-intake__error">
                    {errors[draft.call.id] ||
                      'Could not post this note. Fix the error, then approve it again.'}
                  </p>
                ) : null}
                <pre className="call-intake__transcript">{draft.text}</pre>
                {status === 'pending' || status === 'error' ? (
                  <p className="call-intake__teams-row-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onSkip(draft.call.id)}
                    >
                      Skip
                    </button>
                    <button
                      type="button"
                      className="call-intake__primary"
                      disabled={!canApprove}
                      onClick={() => onApprove(draft)}
                    >
                      {approvingId === draft.call.id ? 'Posting…' : 'Approve and post this note'}
                    </button>
                  </p>
                ) : status === 'posted' ? (
                  <p className="call-intake__teams-posted">Posted to Teams</p>
                ) : (
                  <p className="call-intake__teams-skipped">Skipped — not posted</p>
                )}
              </article>
            );
          })}
        </div>
      )}
      <p className="call-intake__teams-row-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          {pending.length === 0 ? 'Done' : 'Close'}
        </button>
      </p>
    </Modal>
  );
}

function WorkOrderDetailsModal({
  order,
  onClose,
}: {
  order: StoredWorkOrder;
  onClose: () => void;
}) {
  const hasNotes = Boolean(order.notes?.trim());
  return createPortal(
    <div
      className="dispatch-details-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Work order ${order.workOrderNumber || order.customerName || 'details'}`}
    >
      <div className="dispatch-details-modal__backdrop" onClick={onClose} />
      <div className="dispatch-details-modal__panel">
        <header className="dispatch-details-modal__header">
          <div>
            <strong>{order.workOrderNumber || 'No WO#'}</strong>
            <p>{order.customerName || 'Unknown customer'}</p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <dl className="dispatch-details-modal__facts">
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
              {order.appointmentDate
                ? `${order.appointmentDate}${order.appointmentTime ? ` · ${order.appointmentTime}` : ''}`
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{order.status.replace('_', ' ')}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{order.source || order.sourceFileName || '—'}</dd>
          </div>
        </dl>
        <section className="dispatch-details-modal__notes">
          <h3>Notes</h3>
          {hasNotes ? (
            <NotesWithScheduleHighlight
              notes={order.notes || ''}
              scheduleDate={order.appointmentDate}
              evidenceQuote={order.scheduleEvidenceQuote}
            />
          ) : (
            <p className="dispatch-details-modal__empty">No notes on this work order yet.</p>
          )}
        </section>
      </div>
    </div>,
    document.body
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
            {order.appointmentDate ? (
              <AppointmentDateBadge date={order.appointmentDate} time={order.appointmentTime} />
            ) : (
              '—'
            )}
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
          <NotesWithScheduleHighlight
            notes={order.notes}
            scheduleDate={order.appointmentDate}
            evidenceQuote={order.scheduleEvidenceQuote}
            className="call-intake__transcript"
          />
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
  oauthNotice = '',
  oauthFailed = false,
}: {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  oauthNotice?: string;
  oauthFailed?: boolean;
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
  const [signingIn, setSigningIn] = useState(false);
  const [webToken, setWebToken] = useState('');
  const [webApiBase, setWebApiBase] = useState('https://api.plaud.ai');
  const [showReconnect, setShowReconnect] = useState(false);
  const [connectHint, setConnectHint] = useState(oauthNotice && !oauthFailed ? oauthNotice : '');
  const [error, setError] = useState<string | null>(null);
  const [processingCallId, setProcessingCallId] = useState<string | null>(null);
  const [processingAll, setProcessingAll] = useState(false);
  const [processProgress, setProcessProgress] = useState('');
  const [summaryCall, setSummaryCall] = useState<PlaudCall | null>(null);
  const [summaryCalls, setSummaryCalls] = useState<PlaudCall[] | null>(null);
  const [detailsWorkOrder, setDetailsWorkOrder] = useState<StoredWorkOrder | null>(null);
  const [loadingWorkOrderId, setLoadingWorkOrderId] = useState<string | null>(null);
  const [audioSession, setAudioSession] = useState<{
    callId: string;
    url: string;
    filename: string;
    usingProxy?: boolean;
  } | null>(null);
  const [audioBusyId, setAudioBusyId] = useState<string | null>(null);
  const [dayJobs, setDayJobs] = useState<DaySchedulingInfo | null>(null);
  const [loadingDayJobs, setLoadingDayJobs] = useState(false);
  const [teamsWatch, setTeamsWatch] = useState<TeamsWatchTarget | null>(null);
  const [teamsSignedIn, setTeamsSignedIn] = useState(() => Boolean(getActiveAccount()));
  const [teamsPostDrafts, setTeamsPostDrafts] = useState<TeamsSchedulePostDraft[] | null>(null);
  const [teamsDraftStatus, setTeamsDraftStatus] = useState<
    Record<string, 'pending' | 'posting' | 'posted' | 'skipped' | 'error'>
  >({});
  const [teamsDraftErrors, setTeamsDraftErrors] = useState<Record<string, string>>({});
  const [teamsApprovingId, setTeamsApprovingId] = useState<string | null>(null);
  const [teamsPostBusyId, setTeamsPostBusyId] = useState<string | null>(null);
  const connectingRef = useRef(false);

  useEffect(() => {
    return subscribeTeamsWatchTarget(setTeamsWatch, (err) => {
      console.warn('Could not load the Teams watch channel:', err);
    });
  }, []);

  useEffect(() => {
    void handleRedirectPromise()
      .catch(() => null)
      .then(() => setTeamsSignedIn(Boolean(getActiveAccount())));
  }, []);

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
      return nextCalls;
    } catch (err) {
      setError(formatPlaudCallableError(err));
      return [] as PlaudCall[];
    } finally {
      setLoading(false);
    }
  };

  const connectWithToken = useCallback(async (token: string) => {
    const trimmed = token.trim();
    if (trimmed.length < 20 || connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    setError(null);
    setConnectHint('Connecting Plaud session…');
    try {
      await connectPlaudWebSession({
        token: trimmed,
        cookie: trimmed,
        apiBase: webApiBase,
      });
      setWebToken('');
      setShowReconnect(false);
      setConnectHint('Plaud is connected. You can close the Plaud window.');
      stopPlaudSignInWatcher();
      await reload();
    } catch (err) {
      setError(formatPlaudCallableError(err));
      setConnectHint('');
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
    // reload is stable enough for this page; include webApiBase only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webApiBase]);

  const syncFromPlaud = async (input: { date?: string; allTime?: boolean }) => {
    if (isPlaudDesktop() && window.plaudDesktop?.listLibrary) {
      const listed = await window.plaudDesktop.listLibrary({
        date: input.date,
        allTime: input.allTime,
      });
      if (listed.error) throw new Error(listed.error);
      if (listed.token) {
        try {
          await connectPlaudWebSession({
            token: listed.token,
            cookie: listed.token,
            apiBase: webApiBase,
          });
        } catch (err) {
          console.warn('Saved Plaud login after local list failed', err);
        }
      }
      if (!listed.files?.length) {
        throw new Error(
          'Plaud’s window can see recordings, but this app could not copy that list. Keep the recordings visible and try Sync again.'
        );
      }
      return syncPlaudCalls({ ...input, files: listed.files });
    }
    return syncPlaudCalls(input);
  };

  useEffect(() => {
    void reload();
    const incoming = consumePlaudConnectToken();
    if (incoming && isPlaudWebSessionToken(incoming)) void connectWithToken(incoming);
    if (oauthFailed && oauthNotice) setError(oauthNotice);
    // Load the full library once; day chips filter it locally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isAllowedPlaudConnectOrigin(event.origin)) return;
      const data = event.data as { source?: string; token?: string } | null;
      if (!data || data.source !== PLAUD_CONNECT_SOURCE) return;
      const token = String(data.token || '').trim();
      if (token) void connectWithToken(token);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      stopPlaudSignInWatcher();
    };
  }, [connectWithToken]);

  const visibleCalls = useMemo(() => {
    const filtered =
      listScope === 'all' ? calls : calls.filter((call) => callDateOf(call) === selectedDate);
    return [...filtered].sort(compareCallsForList);
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
          force:
            call.status === 'failed' ||
            call.status === 'needs_review' ||
            call.source === 'plaud-whisper',
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
    if (call.summary && (call.source === 'plaud-whisper' || call.source === 'plumber-phone' || call.hasSpeakerLabels)) {
      setSummaryCall(call);
      return;
    }
    if (callNeedsProcessing(call)) {
      await handleProcessCall(call, true);
      return;
    }
    setSummaryCall(call);
  };

  const runServerProcessJob = async (input: { allTime?: boolean; date?: string }) => {
    let pass = 0;
    let last: PlaudSyncSummary | null = null;
    let billed = 0;
    do {
      pass += 1;
      setProcessProgress(
        last?.remaining
          ? `Saved ${last.saved || 0} to Firebase, ${last.remaining} left (pass ${pass})… OpenAI ${formatUsd(billed)}`
          : `Processing calls on the server and saving to Firebase (pass ${pass})…`
      );
      last = await processPlaudCalls(input);
      billed = Math.round((billed + (last.costUsd || 0)) * 1e6) / 1e6;
      setSyncSummary({ ...last, costUsd: billed });
      setProcessProgress(
        `Saved ${last.saved || 0} to Firebase${
          last.remaining ? `, ${last.remaining} left` : ''
        } (pass ${pass})… OpenAI ${formatUsd(billed)}`
      );
      await reload();
    } while (Boolean(last.incomplete) && (last.remaining || 0) > 0 && pass < 20);
    return last ? { ...last, costUsd: billed } : last;
  };

  const handleProcessVisibleCalls = async () => {
    setProcessingAll(true);
    setError(null);
    try {
      await runServerProcessJob({ date: selectedDate });
      const next = await reload();
      const forPopup = next
        .filter((call) => callDateOf(call) === selectedDate)
        .filter((call) => Boolean(call.summary || call.plaudSummary));
      setSummaryCalls(forPopup);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessingAll(false);
      setProcessProgress('');
    }
  };

  const handleProcessAllCalls = async () => {
    if (
      !window.confirm(
        'Process every Plaud recording and save transcripts and summaries to Firebase? Calls that are already finished are skipped. Leave this page open until it finishes.'
      )
    ) {
      return;
    }
    setProcessingAll(true);
    setError(null);
    setListScope('all');
    try {
      await runServerProcessJob({ allTime: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessingAll(false);
      setProcessProgress('');
    }
  };

  const handlePlayCallAudio = async (call: PlaudCall) => {
    if (audioSession?.callId === call.id) {
      setAudioSession(null);
      return;
    }
    setAudioBusyId(call.id);
    setError(null);
    try {
      const link = await getPlaudCallAudioUrl(call.id);
      setAudioSession({
        callId: call.id,
        url: link.url,
        filename: audioDownloadName(call, link.filename),
      });
                } catch {
      setAudioSession({
        callId: call.id,
        url: plaudCallAudioProxyUrl(call.id),
        filename: audioDownloadName(call, 'call.mp3'),
        usingProxy: true,
      });
    } finally {
      setAudioBusyId(null);
    }
  };

  const handleDownloadCallAudio = async (call: PlaudCall) => {
    setAudioBusyId(call.id);
    setError(null);
    try {
      const { blob, filename } = await downloadPlaudCallAudio(call.id);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = audioDownloadName(call, filename);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(formatPlaudCallableError(err));
    } finally {
      setAudioBusyId(null);
    }
  };

  const handleShowWorkOrder = async (call: PlaudCall) => {
    setLoadingWorkOrderId(call.id);
    setError(null);
    try {
      const loaded = await findWorkOrderForCall({
        workOrderId: call.workOrderId,
        workOrderNumber: workOrderNumberForCall(call),
      });
      setDetailsWorkOrder(loaded || workOrderFromCall(call));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDetailsWorkOrder(workOrderFromCall(call));
    } finally {
      setLoadingWorkOrderId(null);
    }
  };

  const ensureMicrosoftForTeamsPost = async () => {
    if (azureConfigError) throw new Error(azureConfigError);
    await handleRedirectPromise().catch(() => null);
    if (!getActiveAccount()) {
      await signIn();
    }
    setTeamsSignedIn(Boolean(getActiveAccount()));
    if (!getActiveAccount()) {
      throw new Error('Sign in with Microsoft on the Teams tab, then confirm the post here.');
    }
  };

  const prepareTeamsDraft = async (
    call: PlaudCall,
    dispatch?: DaySchedulingJob | null
  ): Promise<TeamsSchedulePostDraft> => {
    const loaded =
      dispatch?.workOrder ||
      (await findWorkOrderForCall({
        workOrderId: call.workOrderId,
        workOrderNumber: workOrderNumberForCall(call),
      }));
    return buildTeamsScheduleDraft({
      call,
      workOrder: loaded,
      appointmentDate: appointmentDateForCall(call),
      watch: teamsWatch,
      dispatch: dispatch
        ? { truckName: dispatch.truckName, windowLabel: dispatch.windowLabel }
        : null,
    });
  };

  const handleReviewTeamsSchedules = async () => {
    const eligible = visibleCalls.filter(
      (call) =>
        !call.teamsPostedAt &&
        callHasScheduleForTeams(call) &&
        (call.appointmentMade || appointmentDateForCall(call))
    );
    if (eligible.length === 0) {
      setError(
        'No unposted Plaud schedule notes to review. Process calls that booked a service day first.'
      );
      return;
    }
    setTeamsPostBusyId('review');
    setError(null);
    try {
      const extraIds = eligible
        .map((call) => call.workOrderId)
        .filter((id): id is string => Boolean(id));
      const dates = [
        ...new Set(
          eligible
            .map((call) => appointmentDateForCall(call))
            .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        ),
      ];
      if (!dates.includes(selectedDate)) dates.push(selectedDate);
      const dispatchById = new Map<string, DaySchedulingJob>();
      const dispatchByNumber = new Map<string, DaySchedulingJob>();
      for (const date of dates) {
        const info = await getDaySchedulingInfo(date, extraIds);
        for (const job of info.jobs) {
          dispatchById.set(job.workOrder.id, job);
          if (job.workOrder.workOrderNumber) {
            dispatchByNumber.set(job.workOrder.workOrderNumber, job);
          }
        }
      }
      const drafts: TeamsSchedulePostDraft[] = [];
      for (const call of eligible) {
        const woNumber = workOrderNumberForCall(call);
        const dispatch =
          (call.workOrderId ? dispatchById.get(call.workOrderId) : undefined) ||
          (woNumber ? dispatchByNumber.get(woNumber) : undefined) ||
          null;
        drafts.push(await prepareTeamsDraft(call, dispatch));
      }
      setTeamsDraftStatus(
        Object.fromEntries(drafts.map((draft) => [draft.call.id, 'pending' as const]))
      );
      setTeamsDraftErrors({});
      setTeamsPostDrafts(drafts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTeamsPostBusyId(null);
    }
  };

  const handleApproveTeamsDraft = async (draft: TeamsSchedulePostDraft) => {
    if (teamsApprovingId) return;
    setTeamsApprovingId(draft.call.id);
    setTeamsDraftStatus((current) => ({ ...current, [draft.call.id]: 'posting' }));
    setTeamsDraftErrors((current) => {
      const next = { ...current };
      delete next[draft.call.id];
      return next;
    });
    setError(null);
    try {
      await ensureMicrosoftForTeamsPost();
      const posted = await postTeamsScheduleDraft(draft);
      if (!draft.destination) {
        throw new Error('No Teams destination for this schedule note.');
      }
      const nextCall = applyTeamsPostToCall(draft.call, posted, draft.destination);
      setCalls((current) => current.map((call) => (call.id === nextCall.id ? nextCall : call)));
      setSummaryCall((current) => (current?.id === nextCall.id ? nextCall : current));
      setTeamsPostDrafts((current) =>
        current
          ? current.map((item) =>
              item.call.id === nextCall.id
                ? { ...item, call: nextCall, alreadyPostedAt: nextCall.teamsPostedAt }
                : item
            )
          : current
      );
      setTeamsDraftStatus((current) => ({ ...current, [draft.call.id]: 'posted' }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTeamsDraftErrors((current) => ({ ...current, [draft.call.id]: message }));
      setTeamsDraftStatus((current) => ({ ...current, [draft.call.id]: 'error' }));
    } finally {
      setTeamsApprovingId(null);
    }
  };

  const handleSkipTeamsDraft = (callId: string) => {
    if (teamsApprovingId) return;
    setTeamsDraftStatus((current) => ({ ...current, [callId]: 'skipped' }));
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
            Process all recordings on the server and save transcripts, dispatcher
            summaries, and work orders to Firebase. New calls from the last two
            days are also processed automatically about every 15 minutes. Posting a
            schedule into Teams opens a list of notes; each note must be approved on its
            own.
          </p>
          <p className={`call-intake__connection ${connection?.connected ? 'is-connected' : 'is-disconnected'}`}>
            {connection?.connected
              ? `Connected to Plaud${connection.mode === 'web' ? ' via web.plaud.ai' : ''}${connection.name || connection.email ? ` · ${connection.name || connection.email}` : ''}${connection.tokenType ? ` · ${connection.tokenType}` : ''}${connection.apiBase ? ` · ${connection.apiBase.replace(/^https:\/\//, '')}` : ''}${typeof connection.libraryCount === 'number' ? ` · ${connection.libraryCount} in Plaud` : ''}`
              : 'Plaud is not connected. Click Sign in with Plaud below.'}
          </p>
          <p className={`call-intake__connection ${teamsSignedIn ? 'is-connected' : 'is-disconnected'}`}>
            {teamsSignedIn
              ? `Microsoft is signed in${teamsWatch ? ` · Teams destination ${teamsWatch.channelName}` : ' · pick a channel on the Teams tab to post new notes'}`
              : 'Microsoft is not signed in. Sign-in is requested when you approve a schedule note.'}
          </p>
        </div>
        <div className="call-intake__actions">
          <button
            type="button"
            className="call-intake__primary"
            disabled={syncing || processingAll || !connection?.connected}
            onClick={() => void handleProcessAllCalls()}
          >
            {processingAll && listScope === 'all'
              ? processProgress || 'Processing all calls…'
              : 'Process all calls & save'}
          </button>
          <button
            type="button"
            className="call-intake__primary"
            disabled={syncing || processingAll || !connection?.connected}
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
                const summary = await syncFromPlaud({ allTime: true });
                setSyncSummary(summary);
                setListScope('all');
                await reload();
              } catch (err) {
                setError(formatPlaudCallableError(err));
              } finally {
                setSyncMode(null);
              }
            }}
          >
            {syncMode === 'all' ? 'Importing all Plaud calls…' : 'Import all Plaud calls'}
          </button>
          <button
            type="button"
            disabled={syncing || processingAll || !connection?.connected}
            onClick={async () => {
              setSyncMode('day');
              setError(null);
              try {
                const summary = await syncFromPlaud({ date: selectedDate });
                setSyncSummary(summary);
                setListScope('day');
                await reload();
              } catch (err) {
                setError(formatPlaudCallableError(err));
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
          {connection?.connected ? (
            <button type="button" onClick={() => setShowReconnect(true)}>
              Reconnect Plaud
            </button>
          ) : null}
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
            disabled={processingAll || processingCallId !== null || syncing || visibleCalls.length === 0}
            onClick={() => void handleProcessVisibleCalls()}
          >
            {processingAll
              ? processProgress || 'Processing calls…'
              : `Process ${formatLongDate(selectedDate)} & save`}
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
          <button
            type="button"
            className="call-intake__primary"
            disabled={
              teamsApprovingId !== null ||
              teamsPostBusyId !== null ||
              visibleCalls.filter(
                (call) =>
                  !call.teamsPostedAt &&
                  callHasScheduleForTeams(call) &&
                  (call.appointmentMade || appointmentDateForCall(call))
              ).length === 0
            }
            onClick={() => void handleReviewTeamsSchedules()}
          >
            {teamsPostBusyId === 'review'
              ? 'Loading schedule notes…'
              : 'Post schedules to Teams'}
          </button>
        </div>
      </section>

      {error && <div className="call-intake__error">{error}</div>}

      {(!connection?.connected || showReconnect) && (
        <section className="call-intake__mock">
          <h3>Connect Plaud</h3>
          <p>
            Click Sign in with Plaud and log in as the plumber whose Note has
            the calls. Stay on the Plaud home page until the recordings list is
            visible. Do not use the OAuth page that 404s after login.
          </p>
          <div className="call-intake__connect-actions">
            <button
              type="button"
              className="call-intake__primary"
              disabled={connecting || signingIn}
              onClick={() => {
                void (async () => {
                  setError(null);
                  setSigningIn(true);
                  try {
                    if (await canSignInWithPlaudWindow()) {
                      setConnectHint(
                        'Sign in at web.plaud.ai in the window that opened. Wait until your recordings list is visible — this app will close that window when it has a working login.'
                      );
                      const token = await signInWithPlaudDesktop();
                      await connectWithToken(token);
                      return;
                    }
                    setConnectHint('Opening Plaud authorization…');
                    const { url } = await startPlaudOAuth();
                    const popup = window.open(
                      url,
                      'plaud-oauth',
                      'width=520,height=740,noopener=no'
                    );
                    if (!popup) {
                      window.location.assign(url);
                    } else {
                      setConnectHint(
                        'Finish sign-in in the Plaud window. After you authorize, this app will take over.'
                      );
                    }
                  } catch (err) {
                    setConnectHint('');
                    setError(formatPlaudCallableError(err));
                  } finally {
                    setSigningIn(false);
                  }
                })();
              }}
            >
              {signingIn ? 'Sign in in the Plaud window…' : 'Sign in with Plaud'}
            </button>
            {showReconnect && connection?.connected ? (
              <button type="button" onClick={() => setShowReconnect(false)}>
                Cancel
              </button>
            ) : null}
          </div>
          {connectHint ? <p className="call-intake__sync">{connectHint}</p> : null}
          {connecting ? <p className="call-intake__sync">Connecting…</p> : null}
          <details className="call-intake__manual-connect">
            <summary>Paste a token instead</summary>
            <p>
              Open{' '}
              <a href="https://web.plaud.ai" target="_blank" rel="noreferrer">
                https://web.plaud.ai
              </a>
              , inspect an <code>api.plaud.ai</code> request, and paste the Cookie
              line or the <code>eyJ...</code> value.
            </p>
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
              onClick={() => void connectWithToken(webToken)}
            >
              {connecting ? 'Connecting…' : 'Connect Plaud account'}
            </button>
          </details>
        </section>
      )}

      {syncSummary && (
        <p className="call-intake__sync">
          {syncSummary.scope?.startsWith('process')
            ? 'Processed Plaud recordings and saved them to Firebase'
            : syncSummary.scope === 'all-time'
              ? 'Imported all Plaud recordings'
              : `Synced ${syncSummary.scope || selectedDate}`}
          {typeof syncSummary.plaudTotal === 'number' ? ` · Plaud library ${syncSummary.plaudTotal}` : ''}
          {' '}· {syncSummary.matched} of {syncSummary.scanned} files ·
          {' '}{syncSummary.saved ?? syncSummary.imported} saved ·
          {' '}{syncSummary.processed ?? 0} analyzed ·
          {' '}{syncSummary.skipped} already done ·
          {' '}{syncSummary.awaitingTranscript} waiting on transcripts ·
          {' '}{syncSummary.appointments} appointments · {syncSummary.failed} failed
          {syncSummary.incomplete && (syncSummary.remaining || 0) > 0
            ? ` · ${syncSummary.remaining} still queued`
            : '.'}
          {syncSummary.costUsd != null ? ` OpenAI ${formatUsd(syncSummary.costUsd)}.` : ''}
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
        {visibleCalls.map((call) => {
          const detectedDate = appointmentDateForCall(call);
          return (
          <article
            key={call.id}
            className={
              detectedDate ? 'call-intake__call call-intake__call--dated' : 'call-intake__call'
            }
          >
            <header>
              <strong>{call.recordingName || call.callerPhone || 'Untitled Plaud recording'}</strong>
              <AppointmentDateBadge date={detectedDate} time={call.appointmentTime} />
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
                    {processingCallId === call.id
                      ? 'Processing…'
                      : call.source === 'plaud-whisper'
                        ? 'Retry Plaud transcript'
                        : 'Process'}
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
                {callHasPlaudAudio(call) ? (
                  <>
                    <button
                      type="button"
                      disabled={audioBusyId !== null}
                      onClick={() => void handlePlayCallAudio(call)}
                    >
                      {audioBusyId === call.id
                        ? 'Loading…'
                        : audioSession?.callId === call.id
                          ? 'Stop'
                          : 'Play'}
                    </button>
                    <button
                      type="button"
                      disabled={audioBusyId !== null}
                      onClick={() => void handleDownloadCallAudio(call)}
                    >
                      {audioBusyId === call.id ? 'Loading…' : 'Download'}
                    </button>
                  </>
                ) : null}
                {callHasLinkedWorkOrder(call) ? (
                  <button
                    type="button"
                    disabled={processingAll || loadingWorkOrderId !== null}
                    onClick={() => void handleShowWorkOrder(call)}
                  >
                    {loadingWorkOrderId === call.id ? 'Opening…' : 'Work order'}
                  </button>
                ) : null}
              </span>
            </header>
            {audioSession?.callId === call.id ? (
              <audio
                className="call-intake__audio"
                src={audioSession.url}
                controls
                autoPlay
                onError={() => {
                  if (!audioSession.usingProxy) {
                    setAudioSession({
                      ...audioSession,
                      url: plaudCallAudioProxyUrl(call.id),
                      usingProxy: true,
                    });
                    return;
                  }
                  setError('Could not play this recording. Try Download instead.');
                  setAudioSession(null);
                }}
              >
                Your browser cannot play this recording.
              </audio>
            ) : null}
            {call.summary && <p>{call.summary}</p>}
            {!call.summary && call.plaudSummary && <p>{call.plaudSummary}</p>}
            {detectedDate ? (
              <p className="call-intake__appointment-date">
                Install date
                <AppointmentDateBadge date={detectedDate} time={call.appointmentTime} />
                {workOrderNumberForCall(call) ? (
                  <span>Work order: {workOrderNumberForCall(call)}</span>
                ) : null}
                {call.costUsd != null ? <span>OpenAI {formatUsd(call.costUsd)}</span> : null}
                {call.teamsPostedAt ? (
                  <span className="call-intake__teams-posted">
                    Posted to Teams {new Date(call.teamsPostedAt).toLocaleString()}
                    {call.teamsPostedWebUrl ? (
                      <>
                        {' '}
                        <a href={call.teamsPostedWebUrl} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </p>
            ) : call.appointmentMade ? (
              <p className="call-intake__appointment">
                Water-heater appointment detected
                {workOrderNumberForCall(call) ? ` · Work order: ${workOrderNumberForCall(call)}` : ''}
                {call.costUsd != null ? ` · OpenAI ${formatUsd(call.costUsd)}` : ''}
                {call.teamsPostedAt
                  ? ` · Posted to Teams ${new Date(call.teamsPostedAt).toLocaleString()}`
                  : ''}
              </p>
            ) : call.costUsd != null ? (
              <p className="call-intake__appointment">OpenAI {formatUsd(call.costUsd)}</p>
            ) : null}
            {reviewReasonsForCall(call).length > 0 && (
              <div className="call-intake__review">
                <strong>
                  {call.status === 'needs_review' ? 'Why this needs review' : 'Work order needs review'}
                </strong>
                <ul>
                  {reviewReasonsForCall(call).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {call.status === 'in_plaud' && (
              <p className="call-intake__waiting">
                This recording is in Plaud. Click Process to pull Plaud’s transcript with speaker names.
              </p>
            )}
            {call.status === 'awaiting_transcript' && (
              <p className="call-intake__waiting">
                {call.error ||
                  'Plaud has the recording, but no transcript yet. Click Process to fetch Plaud’s speaker-labeled transcript.'}
              </p>
            )}
            {call.source === 'plaud-whisper' && call.transcript && (
              <p className="call-intake__waiting">
                This call was transcribed here without speaker names. Click Process to retry Plaud’s labeled transcript.
              </p>
            )}
            {call.status === 'failed' && call.error && (
              <p className="call-intake__error">{call.error}</p>
            )}
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
                  Transcript
                  {call.hasSpeakerLabels || call.source === 'plaud'
                    ? ' — Plaud speakers'
                    : call.source === 'plaud-whisper'
                      ? ' — no speaker names'
                      : ''}
                  {call.appointmentEvidence?.quote ? ' — appointment highlighted' : ''}
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
          );
        })}
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
          {audioSession?.callId === summaryCall.id ? (
            <audio
              className="call-intake__audio"
              src={audioSession.url}
              controls
              autoPlay
              onError={() => {
                if (!audioSession.usingProxy) {
                  setAudioSession({
                    ...audioSession,
                    url: plaudCallAudioProxyUrl(summaryCall.id),
                    usingProxy: true,
                  });
                }
              }}
            />
          ) : null}
          <p className="call-intake__call-actions">
            {callHasPlaudAudio(summaryCall) ? (
              <>
                <button
                  type="button"
                  disabled={audioBusyId !== null}
                  onClick={() => void handlePlayCallAudio(summaryCall)}
                >
                  {audioBusyId === summaryCall.id
                    ? 'Loading…'
                    : audioSession?.callId === summaryCall.id
                      ? 'Stop'
                      : 'Play'}
                </button>
                <button
                  type="button"
                  disabled={audioBusyId !== null}
                  onClick={() => void handleDownloadCallAudio(summaryCall)}
                >
                  {audioBusyId === summaryCall.id ? 'Loading…' : 'Download'}
                </button>
              </>
            ) : null}
            {callHasLinkedWorkOrder(summaryCall) ? (
              <button
                type="button"
                disabled={loadingWorkOrderId !== null}
                onClick={() => void handleShowWorkOrder(summaryCall)}
              >
                {loadingWorkOrderId === summaryCall.id ? 'Opening…' : 'Work order'}
              </button>
            ) : null}
          </p>
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

      {detailsWorkOrder ? (
        <WorkOrderDetailsModal
          order={detailsWorkOrder}
          onClose={() => setDetailsWorkOrder(null)}
        />
      ) : null}

      {teamsPostDrafts ? (
        <TeamsScheduleApprovalModal
          drafts={teamsPostDrafts}
          statuses={teamsDraftStatus}
          errors={teamsDraftErrors}
          approvingId={teamsApprovingId}
          onClose={() => {
            if (!teamsApprovingId) {
              setTeamsPostDrafts(null);
              setTeamsDraftStatus({});
              setTeamsDraftErrors({});
            }
          }}
          onApprove={(draft) => void handleApproveTeamsDraft(draft)}
          onSkip={handleSkipTeamsDraft}
        />
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
