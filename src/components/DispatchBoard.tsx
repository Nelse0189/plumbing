import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import type { DispatchPlan, DispatchStop, DispatchTruck, Plumber, TruckPhone } from '../types';
import {
  autoOrderAllUnsetTrucks,
  autoOrderTruckStops,
  assignUnassignedJobsToTrucks,
  cancelMorningTextsForTruck,
  cancelPendingMorningText,
  closeDispatchJob,
  createManualDispatchJob,
  createMockDispatchJob,
  deleteDispatchJob,
  setDispatchJobCancelled,
  type ManualDispatchJobInput,
  queueMorningTextsForTruck,
  refreshPendingMorningWindowsForPlan,
  cloneDispatchStopForCopy,
  duplicateDispatchStopToTruck,
  mapStopOnPlan,
  saveDispatchPlan,
  subscribeDispatchPlan,
  syncDispatchTruckToSchedule,
  workOrderKey,
} from '../services/dispatchService';
import DispatchDayStrip from './DispatchDayStrip';
import {
  addPlumber,
  applyPlumberAssignmentsToPlan,
  plumberNamesForIds,
  removePlumber,
  seedPlumberAssignmentsFromPlan,
  setPlumberTruck,
  subscribePlumbers,
  truckAssignedToPlumber,
} from '../services/plumberService';
import {
  addTruckPhone,
  phonesForTruck,
  removeTruckPhone,
  subscribeTruckPhones,
  truckPhoneDisplayName,
  type TruckPhoneRoster,
} from '../services/truckPhoneService';
import {
  applyDefaultWindows,
  DEFAULT_DISPATCH_ORIGIN,
  DISPATCH_TIME_SLOTS,
  createEmptyDispatchTrucks,
  formatWindowLabel,
  windowKey,
  windowsEqual,
} from '../utils/dispatchWindows';
import {
  applyUpdatedWindowSmsDefaultsToPlan,
  customerWindowSms,
  stopNeedsUpdatedWindowSms,
  windowSmsWasAlreadySent,
} from '../utils/dispatchWindowSms';
import { initiateVoiceWindowConfirmation, downloadVoiceConfirmationAudio, type VoiceCallRoute } from '../services/voiceConfirmationService';
import {
  formatSmsStatus,
  queuePhoneSms,
  smsPhoneDigits,
  smsThreadForPhone,
  subscribePhoneSmsInbox,
  subscribePhoneSmsOutbox,
  type PhoneSmsInboxItem,
  type PhoneSmsOutboxItem,
  type SmsThreadItem,
} from '../services/phoneSmsService';
import NotesWithScheduleHighlight from './NotesWithScheduleHighlight';
import { locateScheduleEvidenceQuote } from '../utils/teamsAppointmentDate';
import {
  customerPhonesOf,
  formatCustomerPhone,
  formatCustomerPhones,
} from '../utils/customerPhones';
import {
  detectWorkOrderSchedules,
  manuallyScheduleWorkOrder,
  patchWorkOrderFields,
} from '../services/workOrderService';
import { subscribeTeamsLiveSync } from '../services/teamsWatchService';
import {
  cancelWorkOrderImport,
  formatUsd,
  subscribeLatestWorkOrderImportProgress,
  type WorkOrderImportProgress,
} from '../services/importProgressService';
import { DispatchGasBar, TruckGasLine, useDispatchGas } from './DispatchGas';
import './DispatchBoard.css';

interface DispatchBoardProps {
  selectedDate: string;
  onSelectDate: (date: string) => void;
}

type DragPayload =
  | { from: 'unassigned'; stopId: string }
  | { from: 'notReady'; stopId: string }
  | { from: 'truck'; truckId: string; stopId: string; index: number };

type CopyTruckOption = {
  id: string;
  name: string;
  disabled: boolean;
  hint: string;
};

function otherTruckNamesForStop(plan: DispatchPlan, stop: DispatchStop): string[] {
  const key = workOrderKey(stop);
  const names = plan.trucks
    .filter((truck) =>
      truck.stops.some((item) => workOrderKey(item) === key && item.id !== stop.id)
    )
    .map((truck) => truck.name);
  if (plan.unassigned.some((item) => workOrderKey(item) === key && item.id !== stop.id)) {
    names.push('Ready');
  }
  if (plan.notReady.some((item) => workOrderKey(item) === key && item.id !== stop.id)) {
    names.push('Not Ready');
  }
  return names;
}

function copyTruckOptionsForStop(
  plan: DispatchPlan,
  stop: DispatchStop
): CopyTruckOption[] {
  const key = workOrderKey(stop);
  return plan.trucks.map((truck) => {
    const already = truck.stops.some((item) => workOrderKey(item) === key);
    return {
      id: truck.id,
      name: truck.name,
      disabled: Boolean(stop.cancelled) || truck.set || already,
      hint: truck.set ? 'Set' : already ? 'Already on this truck' : '',
    };
  });
}

function isCopyDrop(event: DragEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey;
}

type BulkSmsTrack = {
  smsId: string;
  stopId: string;
  customerName: string;
  phone: string;
};

function parseDrag(data: string): DragPayload | null {
  try {
    return JSON.parse(data) as DragPayload;
  } catch {
    return null;
  }
}

/** Index is only used to reorder on the same truck. New assignments always go last. */
function truckDropInsertIndex(
  payload: DragPayload,
  target: { truckId: string; index?: number }
): number | undefined {
  if (payload.from === 'truck' && payload.truckId === target.truckId) {
    return target.index;
  }
  return undefined;
}

/** "2026-09-10" → "Thu, Sep 10" for the date on each job card. */
function formatMovedDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** The service day this card represents: this board, or where a moved job went. */
function stopServiceDate(stop: DispatchStop, scheduleDate: string): string {
  if (stop.movedToDate !== undefined) return stop.movedToDate;
  return scheduleDate;
}

function StopServiceDateField({
  stop,
  scheduleDate,
  busy,
  hideCaption,
  onChange,
}: {
  stop: DispatchStop;
  scheduleDate: string;
  busy?: boolean;
  hideCaption?: boolean;
  onChange?: (date: string) => Promise<void>;
}) {
  const serviceDate = stopServiceDate(stop, scheduleDate);
  const [draft, setDraft] = useState(serviceDate);

  useEffect(() => {
    setDraft(serviceDate);
  }, [serviceDate]);

  const weekday = draft ? formatMovedDate(draft) : 'Off schedule';

  return (
    <label
      className={`dispatch-node__date${hideCaption ? ' dispatch-node__date--plain' : ''}`}
      onMouseDown={(event) => event.stopPropagation()}
      title="Change this if Teams notes booked the wrong day. The new date is locked so import will not overwrite it."
    >
      {hideCaption ? null : <span className="dispatch-node__date-caption">Date</span>}
      <input
        type="date"
        value={draft}
        disabled={busy || !onChange}
        draggable={false}
        aria-label={`Service date for ${stop.workOrderNumber || stop.customerName || 'job'}`}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const next = event.target.value;
          if (!next || next === draft) return;
          const previous = draft;
          setDraft(next);
          if (!onChange) return;
          void onChange(next).catch(() => setDraft(previous));
        }}
      />
      <span className="dispatch-node__date-weekday">{weekday}</span>
    </label>
  );
}

function scrollLaneOnDrag(event: DragEvent<HTMLElement>) {
  event.preventDefault();
  const edge = 56;
  const speed = 24;
  let node: HTMLElement | null = event.currentTarget;
  while (node) {
    const style = window.getComputedStyle(node);
    const canY = /(auto|scroll)/.test(style.overflowY);
    const canX = /(auto|scroll)/.test(style.overflowX);
    if (canY || canX) {
      event.dataTransfer.dropEffect = isCopyDrop(event) ? 'copy' : 'move';
      const rect = node.getBoundingClientRect();
      if (canY) {
        if (event.clientY < rect.top + edge) node.scrollTop -= speed;
        else if (event.clientY > rect.bottom - edge) node.scrollTop += speed;
      }
      if (canX) {
        if (event.clientX < rect.left + edge) node.scrollLeft -= speed;
        else if (event.clientX > rect.right - edge) node.scrollLeft += speed;
      }
      break;
    }
    node = node.parentElement;
  }
  if (event.clientY < edge) window.scrollBy(0, -speed);
  else if (event.clientY > window.innerHeight - edge) window.scrollBy(0, speed);
}

const MANUAL_JOB_TYPES = [
  'Water heater installation',
  'Water heater repair',
  'Drain cleaning',
  'Toilet repair / replacement',
  'Faucet / fixture',
  'Kitchen / bath remodel',
  'Gas line',
  'Boiler',
  'Sewer / main line',
  'Other',
];

function emptyManualForm(date: string): ManualDispatchJobInput {
  return {
    workOrderNumber: '',
    customerName: '',
    phone: '',
    address: '',
    jobType: MANUAL_JOB_TYPES[0],
    appointmentDate: date,
    appointmentTime: '',
    notes: '',
    smsConsent: false,
  };
}

const VOICE_ROUTE_KEY = 'njplumbing.voiceCallRoute';
const VOICE_ROUTE_OPTIONS: Array<{
  id: VoiceCallRoute;
  label: string;
  hint: string;
}> = [
  { id: 'customer', label: 'Customer', hint: 'Dial the job’s actual phone number' },
  { id: '8605439082', label: '860-543-9082', hint: 'Route confirmation calls to 860-543-9082' },
  { id: '8609643025', label: '860-964-3025', hint: 'Route confirmation calls to 860-964-3025' },
];

function loadVoiceCallRoute(): VoiceCallRoute {
  try {
    const stored = localStorage.getItem(VOICE_ROUTE_KEY);
    if (stored === 'customer' || stored === '8605439082' || stored === '8609643025') {
      return stored;
    }
    const legacy = localStorage.getItem('njplumbing.voiceTestNumber') || '';
    const digits = legacy.replace(/\D/g, '');
    const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (ten === '8605439082') return '8605439082';
    if (ten === '8609643025') return '8609643025';
  } catch {
    // ignore
  }
  return '8609643025';
}

function voiceRouteLabel(route: VoiceCallRoute): string {
  return VOICE_ROUTE_OPTIONS.find((option) => option.id === route)?.label || '860-964-3025';
}

function formatVoiceConfirmationLabel(stop: DispatchStop): string {
  const responseLabels: Record<
    NonNullable<DispatchStop['voiceConfirmationResponse']>,
    string
  > = {
    confirmed: 'Confirmed',
    declined: 'Declined',
    unknown: 'No clear answer',
    no_answer: 'No answer',
    hung_up: 'Hung up',
  };
  const statusLabels: Record<NonNullable<DispatchStop['voiceCallStatus']>, string> = {
    queued: 'Queued',
    ringing: 'Ringing',
    answered: 'Answered',
    completed: 'Completed',
    busy: 'Busy',
    canceled: 'Canceled',
    failed: 'Failed',
    'no-answer': 'No answer',
  };

  const response = stop.voiceConfirmationResponse;
  const liveCall =
    stop.voiceCallStatus === 'queued' ||
    stop.voiceCallStatus === 'ringing' ||
    stop.voiceCallStatus === 'answered';
  if (liveCall && stop.voiceCallStatus) {
    const status = statusLabels[stop.voiceCallStatus] || stop.voiceCallStatus;
    return `Call: ${status}`;
  }
  if (stop.voiceWantsHumanCallback) {
    const base =
      response && response !== 'unknown'
        ? `Call: ${responseLabels[response]}`
        : stop.voiceCallStatus
          ? `Call: ${statusLabels[stop.voiceCallStatus] || stop.voiceCallStatus}`
          : 'Call: completed';
    return `${base} · Head plumber should call back`;
  }
  if (response && response !== 'unknown') {
    return `Call: ${responseLabels[response]}`;
  }
  if (stop.voiceCallStatus) {
    const status = statusLabels[stop.voiceCallStatus] || stop.voiceCallStatus;
    if (response === 'unknown' && stop.voiceCallStatus === 'completed') {
      return `Call: ${responseLabels.unknown}`;
    }
    return `Call: ${status}`;
  }
  return 'Call: unknown';
}

function formatSmsStamp(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
}

function smsBadgeForThread(thread: SmsThreadItem[]): string {
  const latest = thread[thread.length - 1];
  if (!latest) return '';
  if (latest.direction === 'in') return 'Reply';
  if (latest.status === 'sent') return 'Sent';
  if (latest.status === 'sending') return 'Sending';
  if (latest.status === 'queued') return 'Queued';
  if (latest.status === 'failed') return 'Failed';
  return '';
}

function SmsThreadList({ thread }: { thread: SmsThreadItem[] }) {
  if (thread.length === 0) {
    return (
      <p className="dispatch-sms-thread__empty">
        No texts with this number yet. Send one, then the shop phone status and
        the customer reply will show here.
      </p>
    );
  }
  return (
    <div className="dispatch-sms-thread">
      {thread.map((item) => (
        <article
          key={item.id}
          className={`dispatch-sms-thread__item dispatch-sms-thread__item--${item.direction}`}
        >
          <strong>
            {item.direction === 'out'
              ? `Office · ${formatSmsStatus(item.status || 'queued')}`
              : 'Customer'}
          </strong>
          <p>{item.body}</p>
          <small>
            {formatSmsStamp(item.at)}
            {item.error ? ` · ${item.error}` : ''}
          </small>
        </article>
      ))}
    </div>
  );
}

const SMS_MAX_LENGTH = 1600;

function truckPhonesSmsBadge(
  phones: TruckPhone[],
  outbox: PhoneSmsOutboxItem[],
  inbox: PhoneSmsInboxItem[]
): string {
  let best = '';
  for (const entry of phones) {
    const badge = smsBadgeForThread(smsThreadForPhone(entry.phone, outbox, inbox));
    if (badge === 'Reply') return 'Reply';
    if (badge === 'Failed') best = 'Failed';
    else if (badge === 'Sending' && best !== 'Failed') best = 'Sending';
    else if (badge === 'Queued' && !best) best = 'Queued';
    else if (badge === 'Sent' && (!best || best === 'Queued')) best = 'Sent';
  }
  return best;
}

function TruckSmsModal({
  truckName,
  phones,
  initialPhone,
  smsOutbox,
  smsInbox,
  onClose,
  onQueued,
}: {
  truckName: string;
  phones: TruckPhone[];
  initialPhone: string;
  smsOutbox: PhoneSmsOutboxItem[];
  smsInbox: PhoneSmsInboxItem[];
  onClose: () => void;
  onQueued?: (notice: string) => void;
}) {
  const [smsPhone, setSmsPhone] = useState(initialPhone || phones[0]?.phone || '');
  const [smsBody, setSmsBody] = useState('');
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsError, setSmsError] = useState('');
  const [smsNotice, setSmsNotice] = useState('');
  const pendingSmsIdRef = useRef<string | null>(null);
  const selected = phones.find((entry) => entry.phone === smsPhone) || phones[0];
  const smsThread = useMemo(
    () => smsThreadForPhone(smsPhone, smsOutbox, smsInbox),
    [smsPhone, smsOutbox, smsInbox]
  );

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const sendTruckText = async () => {
    setSmsBusy(true);
    setSmsError('');
    setSmsNotice('');
    try {
      const result = await queuePhoneSms(smsPhone, smsBody, 'dispatch');
      pendingSmsIdRef.current = result.id;
      const notice = `Queued to ${result.to}. Waiting for the shop phone to send it.`;
      setSmsNotice(notice);
      onQueued?.(notice);
    } catch (err) {
      setSmsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSmsBusy(false);
    }
  };

  useEffect(() => {
    const pendingId = pendingSmsIdRef.current;
    if (!pendingId) return;
    const item = smsThread.find((entry) => entry.id === `out-${pendingId}`);
    if (!item) return;
    if (item.status === 'sent') {
      pendingSmsIdRef.current = null;
      const notice = `Sent to ${smsPhone}.`;
      setSmsError('');
      setSmsNotice(notice);
      onQueued?.(notice);
    } else if (item.status === 'sending') {
      setSmsNotice('Sending from the shop phone…');
    } else if (item.status === 'queued') {
      setSmsNotice(`Queued to ${smsPhone}. Waiting for the shop phone to send it.`);
    } else if (item.status === 'failed') {
      pendingSmsIdRef.current = null;
      setSmsNotice('');
      setSmsError(item.error || 'The shop phone could not send this text.');
      onQueued?.(item.error || 'The shop phone could not send this text.');
    }
  }, [smsThread, smsPhone, onQueued]);

  return createPortal(
    <div
      className="dispatch-details-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Text ${truckName}`}
    >
      <div className="dispatch-details-modal__backdrop" onClick={onClose} />
      <div
        className="dispatch-details-modal__panel dispatch-details-modal__panel--sms"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dispatch-details-modal__header">
          <div>
            <strong>Text truck</strong>
            <p>
              {truckName}
              {selected ? ` · ${truckPhoneDisplayName(selected)}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <SmsThreadList thread={smsThread} />
        <form
          className="dispatch-sms-form"
          onSubmit={(event) => {
            event.preventDefault();
            void sendTruckText();
          }}
        >
          <label>
            Phone
            {phones.length > 1 ? (
              <select
                value={smsPhone}
                onChange={(event) => setSmsPhone(event.target.value)}
              >
                {phones.map((entry) => (
                  <option key={entry.id} value={entry.phone}>
                    {truckPhoneDisplayName(entry)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={smsPhone}
                autoComplete="tel"
                inputMode="tel"
                readOnly
              />
            )}
          </label>
          <label>
            Message
            <textarea
              value={smsBody}
              maxLength={SMS_MAX_LENGTH}
              rows={6}
              placeholder={`Text ${truckName} from the shop phone…`}
              onChange={(event) => setSmsBody(event.target.value)}
            />
          </label>
          <div className="dispatch-sms-form__meta">
            <span>
              {smsBody.length}/{SMS_MAX_LENGTH}
            </span>
            <span>
              Sends from the shop Android phone. Replies from this truck number
              show in the thread above.
            </span>
          </div>
          {smsError ? <p className="dispatch-sms-form__error">{smsError}</p> : null}
          {smsNotice ? <p className="dispatch-sms-form__ok">{smsNotice}</p> : null}
          <div className="dispatch-sms-form__actions">
            <button
              type="submit"
              className="dispatch-sms-form__send"
              disabled={smsBusy || !smsPhone.trim() || !smsBody.trim()}
            >
              {smsBusy ? 'Queuing…' : 'Send text'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

function TruckPhoneControls({
  truck,
  phones,
  saving,
  smsOutbox,
  smsInbox,
  onAdd,
  onRemove,
  onText,
}: {
  truck: DispatchTruck;
  phones: TruckPhone[];
  saving: boolean;
  smsOutbox: PhoneSmsOutboxItem[];
  smsInbox: PhoneSmsInboxItem[];
  onAdd: (input: { phone: string; label?: string }) => Promise<void>;
  onRemove: (phoneId: string) => Promise<void>;
  onText: (phone?: string) => void;
}) {
  const [phoneDraft, setPhoneDraft] = useState('');
  const [labelDraft, setLabelDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const smsBadge = truckPhonesSmsBadge(phones, smsOutbox, smsInbox);

  const submit = async () => {
    if (adding || saving || !phoneDraft.trim()) return;
    setAdding(true);
    try {
      await onAdd({ phone: phoneDraft, label: labelDraft });
      setPhoneDraft('');
      setLabelDraft('');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="dispatch-truck__phones">
      <span className="dispatch-truck__phones-label">Truck phones</span>
      {phones.length > 0 ? (
        <div className="dispatch-truck__phone-chips">
          {phones.map((entry) => (
            <span key={entry.id} className="dispatch-truck__phone-chip">
              <button
                type="button"
                className="dispatch-truck__phone-chip-text"
                title={`Text ${truckPhoneDisplayName(entry)}`}
                onClick={() => onText(entry.phone)}
              >
                {truckPhoneDisplayName(entry)}
              </button>
              <button
                type="button"
                className="dispatch-truck__phone-chip-remove"
                disabled={saving || adding}
                aria-label={`Remove ${truckPhoneDisplayName(entry)} from ${truck.name}`}
                onClick={() => void onRemove(entry.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="dispatch-truck__phones-empty">
          Add the plumber's Android cell. Dispatch texts it, and recorded job calls ring it.
        </p>
      )}
      <form
        className="dispatch-truck__phone-add"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          placeholder="Phone number"
          value={phoneDraft}
          disabled={saving || adding}
          onChange={(event) => setPhoneDraft(event.target.value)}
        />
        <input
          type="text"
          maxLength={40}
          autoComplete="off"
          placeholder="Label (optional)"
          value={labelDraft}
          disabled={saving || adding}
          onChange={(event) => setLabelDraft(event.target.value)}
        />
        <button type="submit" disabled={saving || adding || !phoneDraft.trim()}>
          Add
        </button>
      </form>
      <button
        type="button"
        className={`dispatch-node__text-button${
          smsBadge === 'Reply' ? ' dispatch-node__text-button--reply' : ''
        }${smsBadge === 'Sent' ? ' dispatch-node__text-button--sent' : ''}`}
        disabled={phones.length === 0}
        title={
          phones.length > 0
            ? `Text ${truck.name} from the shop phone`
            : 'Add a truck phone number first'
        }
        onClick={() => onText()}
      >
        {smsBadge ? `Text truck · ${smsBadge}` : 'Text truck'}
      </button>
    </div>
  );
}

function stopHasArrivalWindow(stop: DispatchStop): boolean {
  return Boolean(stop.window?.start?.trim() && stop.window?.end?.trim());
}

function primaryCustomerPhone(stop: DispatchStop): string {
  return customerPhonesOf(stop)[0] || stop.phone?.trim() || '';
}

function StopNode({
  stop,
  locked,
  scheduleDate,
  smsOutbox,
  smsInbox,
  onPriorityChange,
  onWindowChange,
  onCallConfirmation,
  voiceRoute,
  voiceRouteLabel,
  onClose,
  onCancel,
  onDelete,
  onCopyToTruck,
  copyTrucks,
  alsoOnLabel,
  onTextQueued,
  onWindowSmsNotified,
  onNotesChange,
  onServiceDateChange,
  dateSaving,
  closing,
  cancelling,
  deleting,
  copying,
  calling,
  dragPayload,
}: {
  stop: DispatchStop;
  locked: boolean;
  scheduleDate: string;
  smsOutbox: PhoneSmsOutboxItem[];
  smsInbox: PhoneSmsInboxItem[];
  onPriorityChange?: (priority: number) => void;
  onWindowChange?: (start: string, end: string) => void;
  onCallConfirmation?: (phone?: string) => void;
  voiceRoute?: VoiceCallRoute;
  voiceRouteLabel?: string;
  onClose?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onCopyToTruck?: (truckId: string) => void;
  copyTrucks?: CopyTruckOption[];
  alsoOnLabel?: string;
  onTextQueued?: (notice: string) => void;
  onWindowSmsNotified?: () => void;
  onNotesChange?: (notes: string) => Promise<void>;
  onServiceDateChange?: (date: string) => Promise<void>;
  dateSaving?: boolean;
  closing?: boolean;
  cancelling?: boolean;
  deleting?: boolean;
  copying?: boolean;
  calling?: boolean;
  dragPayload: DragPayload;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState(stop.notes || '');
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesError, setNotesError] = useState('');
  const [smsPhone, setSmsPhone] = useState(stop.phone || '');
  const customerPhones = useMemo(() => customerPhonesOf(stop), [stop.phone, stop.phones]);
  const [callPhone, setCallPhone] = useState(customerPhones[0] || stop.phone || '');
  const [smsBody, setSmsBody] = useState('');
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsError, setSmsError] = useState('');
  const [smsNotice, setSmsNotice] = useState('');
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const pendingSmsIdRef = useRef<string | null>(null);
  const hasNotes = Boolean(stop.notes?.trim());
  const cancelled = Boolean(stop.cancelled);
  const movedElsewhere = stop.movedToDate !== undefined;
  const cancelledLabel = movedElsewhere
    ? stop.movedToDate
      ? `Moved to ${formatMovedDate(stop.movedToDate)}`
      : 'Taken off schedule'
    : 'Cancelled';
  const canTextWindow = Boolean(onWindowChange) && stopHasArrivalWindow(stop) && !cancelled;
  const scheduleEvidence = hasNotes
    ? locateScheduleEvidenceQuote(stop.notes || '', stop.scheduleEvidenceQuote)
    : null;
  const smsThread = useMemo(
    () => smsThreadForPhone(smsPhone || customerPhones[0] || stop.phone || '', smsOutbox, smsInbox),
    [smsPhone, customerPhones, stop.phone, smsOutbox, smsInbox]
  );
  const smsBadge = useMemo(() => {
    const phones = customerPhones.length ? customerPhones : [stop.phone].filter(Boolean);
    let best = '';
    for (const phone of phones) {
      const badge = smsBadgeForThread(smsThreadForPhone(phone, smsOutbox, smsInbox));
      if (badge === 'Reply') return 'Reply';
      if (badge === 'Failed') best = 'Failed';
      else if (badge === 'Sending' && best !== 'Failed') best = 'Sending';
      else if (badge === 'Queued' && !best) best = 'Queued';
      else if (badge === 'Sent' && (!best || best === 'Queued')) best = 'Sent';
    }
    return best;
  }, [customerPhones, stop.phone, smsOutbox, smsInbox]);

  useEffect(() => {
    const next = customerPhones[0] || stop.phone || '';
    if (!textOpen) setSmsPhone(next);
    setCallPhone((current) =>
      customerPhones.some((phone) => phone === current) ? current : next
    );
  }, [customerPhones, stop.phone, textOpen]);

  useEffect(() => {
    setAudioError('');
    setAudioUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, [stop.voiceConfirmationId]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const voiceLive =
    stop.voiceCallStatus === 'queued' ||
    stop.voiceCallStatus === 'ringing' ||
    stop.voiceCallStatus === 'answered';
  const canPlayCall = Boolean(stop.voiceConfirmationId) && !voiceLive;

  const playCall = async (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    const confirmationId = stop.voiceConfirmationId;
    if (!confirmationId) return;
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
      setAudioError('');
      return;
    }
    setAudioBusy(true);
    setAudioError('');
    try {
      const blob = await downloadVoiceConfirmationAudio(confirmationId);
      setAudioUrl(URL.createObjectURL(blob));
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : String(err));
    } finally {
      setAudioBusy(false);
    }
  };

  const openTextComposer = () => {
    if (!canTextWindow) return;
    setDetailsOpen(false);
    setSmsPhone(customerPhones[0] || stop.phone || '');
    setSmsBody(customerWindowSms(stop, scheduleDate));
    setSmsError('');
    setSmsNotice('');
    setTextOpen(true);
  };

  const sendCustomerText = async (phones = [smsPhone]) => {
    const targets = [...new Set(phones.map((item) => item.trim()).filter(Boolean))];
    if (targets.length === 0) return;
    setSmsBusy(true);
    setSmsError('');
    setSmsNotice('');
    try {
      const queued: string[] = [];
      for (const target of targets) {
        const result = await queuePhoneSms(target, smsBody, 'dispatch');
        pendingSmsIdRef.current = result.id;
        queued.push(result.to);
      }
      onWindowSmsNotified?.();
      const notice =
        queued.length > 1
          ? `Queued to ${queued.join(' and ')}. Waiting for the shop phone to send them.`
          : `Queued to ${queued[0]}. Waiting for the shop phone to send it.`;
      setSmsNotice(notice);
      onTextQueued?.(notice);
    } catch (err) {
      setSmsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSmsBusy(false);
    }
  };

  useEffect(() => {
    const pendingId = pendingSmsIdRef.current;
    if (!pendingId) return;
    const item = smsThread.find((entry) => entry.id === `out-${pendingId}`);
    if (!item) return;
    if (item.status === 'sent') {
      pendingSmsIdRef.current = null;
      const notice = `Sent to ${smsPhone || stop.phone}.`;
      setSmsError('');
      setSmsNotice(notice);
      onTextQueued?.(notice);
    } else if (item.status === 'sending') {
      setSmsNotice('Sending from the shop phone…');
    } else if (item.status === 'queued') {
      setSmsNotice(
        `Queued to ${smsPhone || stop.phone}. Waiting for the shop phone to send it.`
      );
    } else if (item.status === 'failed') {
      pendingSmsIdRef.current = null;
      setSmsNotice('');
      setSmsError(item.error || 'The shop phone could not send this text.');
      onTextQueued?.(item.error || 'The shop phone could not send this text.');
    }
  }, [smsThread, smsPhone, stop.phone, onTextQueued]);

  useEffect(() => {
    if (!editingNotes) setNotesDraft(stop.notes || '');
  }, [stop.notes, editingNotes]);

  useEffect(() => {
    if (!detailsOpen) {
      setEditingNotes(false);
      setNotesBusy(false);
      setNotesError('');
    }
  }, [detailsOpen]);

  const startEditingNotes = () => {
    setNotesDraft(stop.notes || '');
    setNotesError('');
    setEditingNotes(true);
  };

  const cancelEditingNotes = () => {
    if (notesBusy) return;
    setEditingNotes(false);
    setNotesDraft(stop.notes || '');
    setNotesError('');
  };

  const saveNotes = async () => {
    if (!onNotesChange || notesBusy) return;
    setNotesBusy(true);
    setNotesError('');
    try {
      await onNotesChange(notesDraft);
      setEditingNotes(false);
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : String(err));
    } finally {
      setNotesBusy(false);
    }
  };

  useEffect(() => {
    if (!detailsOpen && !textOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (editingNotes) {
        event.preventDefault();
        cancelEditingNotes();
        return;
      }
      setDetailsOpen(false);
      setTextOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [detailsOpen, textOpen, editingNotes, notesBusy, stop.notes]);

  return (
    <article
      className={`dispatch-node ${locked ? 'dispatch-node--locked' : ''} ${
        cancelled ? 'dispatch-node--cancelled' : ''
      }`}
      draggable={!cancelled}
      aria-label={
        cancelled
          ? `Cancelled job ${stop.workOrderNumber || stop.customerName || stop.id}`
          : undefined
      }
      onDragStart={(event) => {
        event.dataTransfer.setData('application/json', JSON.stringify(dragPayload));
        event.dataTransfer.effectAllowed = 'copyMove';
      }}
    >
      <header className="dispatch-node__header">
        <strong>
          {stop.workOrderNumber || 'No WO#'}
          {alsoOnLabel && !cancelled ? (
            <span className="dispatch-node__also-chip">{alsoOnLabel}</span>
          ) : null}
          {cancelled ? (
            <span className="dispatch-node__cancelled-chip">{cancelledLabel}</span>
          ) : null}
        </strong>
        <span className="dispatch-node__header-actions">
          {stop.distanceMiles != null && (
            <span className="dispatch-node__miles">{stop.distanceMiles} mi</span>
          )}
          {onClose && (
            <button
              type="button"
              className="dispatch-node__close"
              disabled={closing || cancelling}
              title="Close job and retain its history"
              aria-label={`Close job ${stop.workOrderNumber || stop.customerName || stop.id}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }}
            >
              {closing ? '…' : 'Close'}
            </button>
          )}
          {onCancel && (
            <button
              type="button"
              className={`dispatch-node__cancel${cancelled ? ' dispatch-node__cancel--on' : ''}`}
              disabled={cancelling || closing || deleting || movedElsewhere}
              title={
                movedElsewhere
                  ? stop.movedToDate
                    ? `The service date moved to ${formatMovedDate(stop.movedToDate)}. Manage it on that day.`
                    : 'The service date was removed. Set a date to put it back on a board.'
                  : cancelled
                    ? 'Put this job back on the active board'
                    : 'Cancel this job and take it off the truck.'
              }
              aria-label={
                cancelled
                  ? `Restore job ${stop.workOrderNumber || stop.customerName || stop.id}`
                  : `Cancel job ${stop.workOrderNumber || stop.customerName || stop.id}`
              }
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
              }}
            >
              {cancelling ? '…' : cancelled ? 'Restore' : 'Cancelled'}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="dispatch-node__delete"
              disabled={deleting || cancelling}
              title="Delete job"
              aria-label={`Delete job ${stop.workOrderNumber || stop.customerName || stop.id}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDelete();
              }}
            >
              {deleting ? '…' : 'Delete'}
            </button>
          )}
        </span>
      </header>
      {cancelled ? (
        <span className="dispatch-node__cancelled-stamp">
          {movedElsewhere ? 'Moved' : 'Cancelled'}
        </span>
      ) : null}
      <p className="dispatch-node__customer">{stop.customerName}</p>
      <StopServiceDateField
        stop={stop}
        scheduleDate={scheduleDate}
        busy={dateSaving}
        onChange={onServiceDateChange}
      />
      {formatCustomerPhones(stop) ? (
        <p className="dispatch-node__phone">{formatCustomerPhones(stop)}</p>
      ) : null}
      <p className="dispatch-node__address">{stop.address || 'No address'}</p>
      <p className="dispatch-node__meta">{stop.jobType || 'Job type TBD'}</p>
      <div className="dispatch-node__notes-row">
        <button
          type="button"
          className={`dispatch-node__notes-button ${
            hasNotes ? '' : 'dispatch-node__notes-button--empty'
          }`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setTextOpen(false);
            setDetailsOpen(true);
          }}
        >
          {hasNotes ? 'Notes & details' : 'No notes'}
        </button>
        {canTextWindow && (
          <button
            type="button"
            className={`dispatch-node__text-button${
              smsBadge === 'Reply' ? ' dispatch-node__text-button--reply' : ''
            }${smsBadge === 'Sent' ? ' dispatch-node__text-button--sent' : ''}${
              stopNeedsUpdatedWindowSms(stop) ? ' dispatch-node__text-button--update' : ''
            }`}
            title={
              stopNeedsUpdatedWindowSms(stop)
                ? `Window changed — text ${stop.customerName || 'customer'} the updated ${formatWindowLabel(stop.window)} time frame`
                : stop.phone
                ? `Text ${stop.customerName || 'customer'} the ${formatWindowLabel(
                    stop.window
                  )} window`
                : 'Text customer from the shop phone'
            }
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openTextComposer();
            }}
          >
            {stopNeedsUpdatedWindowSms(stop)
              ? 'Text · window updated'
              : smsBadge
                ? `Text · ${smsBadge}`
                : 'Text'}
          </button>
        )}
      </div>
      {detailsOpen &&
        createPortal(
          <div
            className="dispatch-details-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Notes for ${stop.workOrderNumber || stop.customerName || 'job'}`}
          >
            <div
              className="dispatch-details-modal__backdrop"
              onClick={() => setDetailsOpen(false)}
            />
            <div
              className="dispatch-details-modal__panel"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <header className="dispatch-details-modal__header">
                <div>
                  <strong>{stop.workOrderNumber || 'No WO#'}</strong>
                  <p>{stop.customerName || 'Unknown customer'}</p>
                </div>
                <div className="dispatch-details-modal__header-actions">
                  {canTextWindow && (
                    <button
                      type="button"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={() => openTextComposer()}
                    >
                      {stopNeedsUpdatedWindowSms(stop)
                        ? 'Text updated window'
                        : 'Text customer'}
                    </button>
                  )}
                  <button
                    type="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => setDetailsOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </header>
              <dl className="dispatch-details-modal__facts">
                <div>
                  <dt>Date</dt>
                  <dd>
                    <StopServiceDateField
                      stop={stop}
                      scheduleDate={scheduleDate}
                      busy={dateSaving}
                      hideCaption
                      onChange={onServiceDateChange}
                    />
                  </dd>
                </div>
                <div>
                  <dt>Phone</dt>
                  <dd>{formatCustomerPhones(stop) || '—'}</dd>
                </div>
                <div>
                  <dt>Address</dt>
                  <dd>{stop.address || '—'}</dd>
                </div>
                <div>
                  <dt>Job type</dt>
                  <dd>{stop.jobType || '—'}</dd>
                </div>
                <div>
                  <dt>Window</dt>
                  <dd>{formatWindowLabel(stop.window)}</dd>
                </div>
              </dl>
              {smsThread.length > 0 ? (
                <section className="dispatch-details-modal__notes">
                  <h3>Texts</h3>
                  <SmsThreadList thread={smsThread} />
                </section>
              ) : null}
              <section className="dispatch-details-modal__notes">
                <div className="dispatch-details-modal__notes-heading">
                  <h3>Notes</h3>
                  {!editingNotes ? (
                    <button
                      type="button"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={() => startEditingNotes()}
                    >
                      {hasNotes ? 'Edit notes' : 'Add notes'}
                    </button>
                  ) : null}
                </div>
                {editingNotes ? (
                  <>
                    <textarea
                      className="dispatch-details-modal__notes-editor"
                      value={notesDraft}
                      disabled={notesBusy}
                      rows={12}
                      autoFocus
                      aria-label="Job notes"
                      onChange={(event) => setNotesDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                          event.preventDefault();
                          void saveNotes();
                        }
                      }}
                    />
                    {notesError ? (
                      <p className="dispatch-details-modal__empty">{notesError}</p>
                    ) : (
                      <p className="dispatch-details-modal__evidence-hint">
                        Ctrl+Enter saves. Escape cancels.
                      </p>
                    )}
                    <div className="dispatch-details-modal__notes-actions">
                      <button
                        type="button"
                        disabled={notesBusy}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => void saveNotes()}
                      >
                        {notesBusy ? 'Saving…' : 'Save notes'}
                      </button>
                      <button
                        type="button"
                        disabled={notesBusy}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => cancelEditingNotes()}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : hasNotes ? (
                  <>
                    <NotesWithScheduleHighlight
                      notes={stop.notes || ''}
                      scheduleDate={scheduleDate}
                      evidenceQuote={stop.scheduleEvidenceQuote}
                    />
                    {scheduleEvidence ? (
                      <p className="dispatch-details-modal__evidence-hint">
                        Highlighted text is why this job is on this day’s schedule.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="dispatch-details-modal__empty">
                    No notes on this work order yet.
                  </p>
                )}
              </section>
            </div>
          </div>,
          document.body
        )}
      {textOpen &&
        createPortal(
          <div
            className="dispatch-details-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Text ${stop.customerName || 'customer'}`}
          >
            <div
              className="dispatch-details-modal__backdrop"
              onClick={() => setTextOpen(false)}
            />
            <div
              className="dispatch-details-modal__panel dispatch-details-modal__panel--sms"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <header className="dispatch-details-modal__header">
                <div>
                  <strong>Text customer</strong>
                  <p>{stop.customerName || 'Unknown customer'}</p>
                </div>
                <button
                  type="button"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => setTextOpen(false)}
                >
                  Close
                </button>
              </header>
              <SmsThreadList thread={smsThread} />
              <form
                className="dispatch-sms-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendCustomerText();
                }}
              >
                <label>
                  Phone
                  {customerPhones.length > 1 ? (
                    <select
                      value={
                        customerPhones.includes(smsPhone) ? smsPhone : customerPhones[0]
                      }
                      onChange={(event) => setSmsPhone(event.target.value)}
                    >
                      {customerPhones.map((phone) => (
                        <option key={phone} value={phone}>
                          {formatCustomerPhone(phone)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={smsPhone}
                      autoComplete="tel"
                      inputMode="tel"
                      placeholder="Customer phone"
                      onChange={(event) => setSmsPhone(event.target.value)}
                    />
                  )}
                </label>
                {customerPhones.length > 1 ? (
                  <p className="dispatch-sms-form__hint">
                    This work order has {customerPhones.length} numbers. Choose one, or
                    send to both.
                  </p>
                ) : null}
                {!customerPhones.length && !stop.phone?.trim() ? (
                  <p className="dispatch-sms-form__error">
                    No phone on this work order. Enter a number to send.
                  </p>
                ) : null}
                <label>
                  Message
                  <textarea
                    value={smsBody}
                    maxLength={SMS_MAX_LENGTH}
                    rows={6}
                    placeholder={
                      stopNeedsUpdatedWindowSms(stop)
                        ? 'Edit the updated time-frame text before sending…'
                        : 'Edit the arrival-window text before sending…'
                    }
                    onChange={(event) => setSmsBody(event.target.value)}
                  />
                </label>
                <div className="dispatch-sms-form__meta">
                  <span>
                    {smsBody.length}/{SMS_MAX_LENGTH}
                  </span>
                  <span>Sends from the shop Android phone. Status updates here when it is actually sent, and customer replies appear in the thread above.</span>
                </div>
                {smsError ? (
                  <p className="dispatch-sms-form__error">{smsError}</p>
                ) : null}
                {smsNotice ? (
                  <p className="dispatch-sms-form__ok">{smsNotice}</p>
                ) : null}
                <div className="dispatch-sms-form__actions">
                  <button
                    type="submit"
                    className="dispatch-sms-form__send"
                    disabled={smsBusy || !smsPhone.trim() || !smsBody.trim()}
                  >
                    {smsBusy ? 'Queuing…' : 'Send text'}
                  </button>
                  {customerPhones.length > 1 ? (
                    <button
                      type="button"
                      className="dispatch-sms-form__send"
                      disabled={smsBusy || !smsBody.trim()}
                      onClick={() => void sendCustomerText(customerPhones)}
                    >
                      Text both numbers
                    </button>
                  ) : null}
                  <button type="button" onClick={() => setTextOpen(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}
      <div className="dispatch-node__controls">
        <label>
          Priority
          <input
            type="number"
            min={0}
            max={99}
            disabled={locked || cancelled || !onPriorityChange}
            value={stop.priority}
            onChange={(event) => onPriorityChange?.(Number(event.target.value) || 0)}
          />
        </label>
        {onCopyToTruck && copyTrucks && copyTrucks.length > 0 && !cancelled ? (
          <label className="dispatch-node__copy">
            Copy to truck
            <select
              disabled={copying || copyTrucks.every((truck) => truck.disabled)}
              value=""
              title="Keep this job here and add the same job to another truck"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                const truckId = event.target.value;
                event.currentTarget.value = '';
                if (truckId) onCopyToTruck(truckId);
              }}
            >
              <option value="">Choose truck</option>
              {copyTrucks.map((truck) => (
                <option key={truck.id} value={truck.id} disabled={truck.disabled}>
                  {truck.name}
                  {truck.hint ? ` · ${truck.hint}` : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {onWindowChange && (
          <label className="dispatch-node__window">
            Window
            <select
              disabled={locked || cancelled}
              value={windowKey(stop.window)}
              onChange={(event) => {
                const [start, end] = event.target.value.split('|');
                if (start && end) onWindowChange(start, end);
              }}
            >
              {DISPATCH_TIME_SLOTS.map((slot) => (
                <option key={windowKey(slot)} value={windowKey(slot)}>
                  {formatWindowLabel(slot)}
                </option>
              ))}
              {!DISPATCH_TIME_SLOTS.some((slot) => windowsEqual(slot, stop.window)) && (
                <option value={windowKey(stop.window)}>
                  {formatWindowLabel(stop.window)} (custom)
                </option>
              )}
            </select>
            {stop.customWindow && <small>Edited</small>}
          </label>
        )}
        {onCallConfirmation && (
          <div
            className="dispatch-node__voice"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dispatch-node__voice-actions">
              {customerPhones.length > 1 && voiceRoute === 'customer' ? (
                <select
                  className="dispatch-node__phone-select"
                  disabled={calling || cancelled}
                  value={
                    customerPhones.includes(callPhone) ? callPhone : customerPhones[0]
                  }
                  title="Customer number to call"
                  onChange={(event) => setCallPhone(event.target.value)}
                >
                  {customerPhones.map((phone) => (
                    <option key={phone} value={phone}>
                      {formatCustomerPhone(phone)}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                disabled={calling || cancelled || !(callPhone || stop.phone)?.trim()}
                title={
                  cancelled
                    ? 'Cancelled jobs are not called'
                    : (callPhone || stop.phone)?.trim()
                    ? voiceRoute === 'customer'
                      ? `Call the customer at ${formatCustomerPhone(callPhone || stop.phone)}`
                      : `Call ${voiceRouteLabel || 'the selected number'}. Does not dial the customer (${formatCustomerPhones(stop) || stop.phone}).`
                    : 'Add a phone number before calling'
                }
                onClick={(event) => {
                  event.stopPropagation();
                  onCallConfirmation?.(callPhone || customerPhones[0] || stop.phone);
                }}
              >
                {calling
                  ? 'Calling…'
                  : voiceRoute === 'customer'
                    ? 'Call customer'
                    : `Call ${voiceRouteLabel || 'selected number'}`}
              </button>
              {canPlayCall && (
                <button
                  type="button"
                  className="dispatch-node__voice-play"
                  disabled={audioBusy}
                  title="Download and play the automated confirmation call"
                  onClick={(event) => void playCall(event)}
                >
                  {audioBusy ? 'Loading recording…' : audioUrl ? 'Hide recording' : 'Play call'}
                </button>
              )}
            </div>
            {(stop.voiceCallStatus || stop.voiceConfirmationResponse) && (
              <small>
                {formatVoiceConfirmationLabel(stop)}
              </small>
            )}
            {stop.voiceConfirmationDetails && (
              <small>{stop.voiceConfirmationDetails}</small>
            )}
            {stop.voiceHumanCallbackDetails && (
              <small>{stop.voiceHumanCallbackDetails}</small>
            )}
            {audioError && (
              <small className="dispatch-node__voice-error">{audioError}</small>
            )}
            {audioUrl && (
              <audio
                className="dispatch-node__voice-audio"
                src={audioUrl}
                controls
                autoPlay
              >
                Your browser cannot play this recording.
              </audio>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default function DispatchBoard({
  selectedDate,
  onSelectDate,
}: DispatchBoardProps) {
  const [plan, setPlan] = useState<DispatchPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importProgress, setImportProgress] =
    useState<WorkOrderImportProgress | null>(null);
  const [cancelingImport, setCancelingImport] = useState(false);
  const [callingStopId, setCallingStopId] = useState<string | null>(null);
  const [voiceCallRoute, setVoiceCallRoute] = useState<VoiceCallRoute>(loadVoiceCallRoute);
  const [closingStopId, setClosingStopId] = useState<string | null>(null);
  const [cancellingStopId, setCancellingStopId] = useState<string | null>(null);
  const [deletingStopId, setDeletingStopId] = useState<string | null>(null);
  const [copyingStopId, setCopyingStopId] = useState<string | null>(null);
  const [dateSavingStopId, setDateSavingStopId] = useState<string | null>(null);
  const [boardEpoch, setBoardEpoch] = useState(0);
  const [summaryEpoch, setSummaryEpoch] = useState(0);
  const [smsOutbox, setSmsOutbox] = useState<PhoneSmsOutboxItem[]>([]);
  const [smsInbox, setSmsInbox] = useState<PhoneSmsInboxItem[]>([]);
  const [plumbers, setPlumbers] = useState<Plumber[]>([]);
  const [truckPhones, setTruckPhones] = useState<TruckPhoneRoster>({});
  const [truckSms, setTruckSms] = useState<{
    truckId: string;
    truckName: string;
    phone: string;
  } | null>(null);
  const [plumberNameDraft, setPlumberNameDraft] = useState('');
  const [showManualForm, setShowManualForm] = useState(false);
  const [bulkSmsBusy, setBulkSmsBusy] = useState(false);
  const [bulkSmsTracks, setBulkSmsTracks] = useState<BulkSmsTrack[]>([]);
  const [bulkSmsQueueTotal, setBulkSmsQueueTotal] = useState(0);
  const [manualForm, setManualForm] = useState<ManualDispatchJobInput>(() =>
    emptyManualForm(selectedDate)
  );
  const skipDetectForEpochRef = useRef<number | null>(null);
  const creatingManualJobRef = useRef(false);
  const planRef = useRef(plan);
  planRef.current = plan;
  const selectedVoiceRouteLabel = voiceRouteLabel(voiceCallRoute);
  const {
    settings: fuelSettings,
    estimates: gasEstimates,
    estimateFor,
    savingFuel,
    onShopPrice,
    onSaveFuel,
    onTruckMpg,
  } = useDispatchGas(plan);

  useEffect(() => {
    try {
      localStorage.setItem(VOICE_ROUTE_KEY, voiceCallRoute);
    } catch {
      // ignore
    }
  }, [voiceCallRoute]);

  useEffect(() => {
    if (!showManualForm) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowManualForm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showManualForm]);

  useEffect(() => {
    let gotFirstSnapshot = false;
    setLoading(true);
    setError(null);

    const unsubscribe = subscribeDispatchPlan(
      selectedDate,
      (loaded) => {
        setPlan(loaded);
        if (!gotFirstSnapshot) {
          gotFirstSnapshot = true;
          setLoading(false);
        }
      },
      (err) => {
        setError(err.message);
        setPlan((current) =>
          current ?? {
            date: selectedDate,
            originAddress: DEFAULT_DISPATCH_ORIGIN,
            trucks: createEmptyDispatchTrucks(),
            unassigned: [],
            notReady: [],
          }
        );
        setLoading(false);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [selectedDate, boardEpoch]);

  useEffect(() => {
    const stopOutbox = subscribePhoneSmsOutbox(setSmsOutbox, (err) =>
      console.warn('Dispatch SMS outbox:', err)
    );
    const stopInbox = subscribePhoneSmsInbox(setSmsInbox, (err) =>
      console.warn('Dispatch SMS inbox:', err)
    );
    const stopPlumbers = subscribePlumbers(setPlumbers, (err) =>
      console.warn('Dispatch plumbers:', err)
    );
    const stopTruckPhones = subscribeTruckPhones(setTruckPhones, (err) =>
      console.warn('Dispatch truck phones:', err)
    );
    return () => {
      stopOutbox();
      stopInbox();
      stopPlumbers();
      stopTruckPhones();
    };
  }, []);

  useEffect(() => {
    if (!plan || plumbers.length === 0) return;
    if (plumbers.every((plumber) => plumber.truckId !== undefined)) return;
    let cancelled = false;
    void seedPlumberAssignmentsFromPlan(plumbers, plan).then((next) => {
      if (!cancelled && next) setPlumbers(next);
    });
    return () => {
      cancelled = true;
    };
  }, [plan, plumbers]);

  useEffect(() => {
    return subscribeLatestWorkOrderImportProgress(
      setImportProgress,
      (err) => console.warn('Could not subscribe to import progress:', err)
    );
  }, []);

  useEffect(() => {
    return subscribeTeamsLiveSync((event) => {
      if (event.imported || event.updated || event.booked) {
        setSummaryEpoch((value) => value + 1);
        setStatus(event.message);
      }
    });
  }, []);

  const importRunStatus = importProgress?.status;
  const previousImportStatus = useRef<string | null>(null);
  const forceScheduleReadRef = useRef(false);
  useEffect(() => {
    const previous = previousImportStatus.current;
    previousImportStatus.current = importRunStatus ?? null;
    if (previous === 'processing' && importRunStatus === 'completed') {
      setBoardEpoch((value) => {
        const next = value + 1;
        skipDetectForEpochRef.current = next;
        return next;
      });
      setSummaryEpoch((value) => value + 1);
      setStatus(
        importProgress?.message ||
          'Import finished. Scheduled jobs on Dispatch were updated from the new notes.'
      );
    }
  }, [importRunStatus, importProgress?.message]);

  useEffect(() => {
    let cancelled = false;
    if (skipDetectForEpochRef.current === boardEpoch) {
      setDetecting(false);
      return;
    }
    const force = forceScheduleReadRef.current;
    forceScheduleReadRef.current = false;
    setDetecting(true);
    void detectWorkOrderSchedules(force)
      .then((result) => {
        if (cancelled) return;
        setError(null);
        setSummaryEpoch((value) => value + 1);
        setStatus(
          result.scanned
            ? `Read ${result.scanned} job notes and booked ${result.booked} for a service day. Schedule OpenAI ${formatUsd(result.costUsd)}.`
            : result.skipped
              ? `Job notes unchanged. Using the last schedule read (${result.skipped} jobs). OpenAI $0.00`
              : 'No job notes to read yet. Import PDFs from Teams, then refresh.'
        );
      })
      .catch((err) => {
        if (cancelled) return;
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code: string }).code)
            : '';
        const message = err instanceof Error ? err.message : String(err);
        if (code.includes('not-found') || /not found|NOT_FOUND/i.test(message)) {
          setStatus(
            'Schedule detection is not on the server yet. Deploy functions, then click Refresh jobs.'
          );
          return;
        }
        setStatus(
          `Could not read job notes: ${message.replace(/^UNKNOWN:?\s*/i, '')}`
        );
      })
      .finally(() => {
        if (!cancelled) setDetecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [boardEpoch]);

  // Clear the per-stop "Calling…" button state once Firestore reports progress.
  useEffect(() => {
    if (!plan || !callingStopId) return;
    for (const truck of plan.trucks) {
      const stop = truck.stops.find((item) => item.id === callingStopId);
      if (!stop?.voiceCallStatus) continue;
      if (stop.voiceCallStatus !== 'queued') {
        setCallingStopId(null);
      }
      break;
    }
  }, [plan, callingStopId]);

  const assignedCount = useMemo(() => {
    if (!plan) return 0;
    return plan.trucks.reduce((sum, truck) => sum + truck.stops.length, 0);
  }, [plan]);

  const windowSmsTargets = useMemo(() => {
    const send: DispatchStop[] = [];
    let skippedSent = 0;
    let skippedNoPhone = 0;
    if (!plan) return { send, skippedSent, skippedNoPhone };
    for (const truck of plan.trucks) {
      for (const stop of truck.stops) {
        if (stop.cancelled || !stopHasArrivalWindow(stop)) continue;
        if (!primaryCustomerPhone(stop)) {
          skippedNoPhone += 1;
          continue;
        }
        if (
          !stopNeedsUpdatedWindowSms(stop) &&
          windowSmsWasAlreadySent(stop, smsOutbox, smsPhoneDigits)
        ) {
          skippedSent += 1;
          continue;
        }
        send.push(stop);
      }
    }
    return { send, skippedSent, skippedNoPhone };
  }, [plan, smsOutbox]);

  const bulkSmsProgress = useMemo(() => {
    if (bulkSmsTracks.length === 0 && !bulkSmsBusy) return null;
    const rows = bulkSmsTracks.map((track) => {
      const item = smsOutbox.find((entry) => entry.id === track.smsId);
      return {
        ...track,
        status: item?.status || 'queued',
        error: item?.error || '',
      };
    });
    const sent = rows.filter((row) => row.status === 'sent').length;
    const failed = rows.filter((row) => row.status === 'failed').length;
    const sending = rows.find((row) => row.status === 'sending') || null;
    const waiting = rows.filter((row) => row.status === 'queued').length;
    const finished = rows.length > 0 && sent + failed === rows.length;
    return {
      rows,
      sent,
      failed,
      sending,
      waiting,
      queuedCount: rows.length,
      total: bulkSmsQueueTotal || rows.length,
      finished,
    };
  }, [bulkSmsBusy, bulkSmsQueueTotal, bulkSmsTracks, smsOutbox]);

  const persist = async (
    next: DispatchPlan,
    message?: string,
    roster: Plumber[] = plumbers
  ): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const stamped = applyPlumberAssignmentsToPlan(next, roster);
      await saveDispatchPlan(stamped);
      setPlan(stamped);
      if (message) setStatus(message);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const windowSmsAlreadySent = (stop: DispatchStop) =>
    windowSmsWasAlreadySent(stop, smsOutbox, smsPhoneDigits);

  const withUpdatedWindowSmsDefaults = (previous: DispatchPlan, next: DispatchPlan) =>
    applyUpdatedWindowSmsDefaultsToPlan(previous, next, windowSmsAlreadySent);

  const saveWindowSmsDefaults = async (
    previous: DispatchPlan,
    next: DispatchPlan,
    message: string
  ): Promise<DispatchPlan | null> => {
    const patched = withUpdatedWindowSmsDefaults(previous, next);
    const updatedCount = patched.trucks.reduce((sum, truck) => {
      const prevTruck = previous.trucks.find((item) => item.id === truck.id);
      return (
        sum +
        truck.stops.filter((item) => {
          const before = prevTruck?.stops.find((entry) => entry.id === item.id);
          return (
            stopNeedsUpdatedWindowSms(item) &&
            !(before && stopNeedsUpdatedWindowSms(before))
          );
        }).length
      );
    }, 0);
    const notice =
      updatedCount > 0
        ? `${message} ${updatedCount} remaining job${updatedCount === 1 ? '' : 's'} now use an updated time-frame text.`
        : message;
    const saved = await persist(patched, notice);
    return saved ? patched : null;
  };

  const stampWindowSmsNotified = async (stop: DispatchStop) => {
    if (!plan) return;
    const key = windowKey(stop.window);
    const stamp = (item: DispatchStop) =>
      item.id === stop.id ? { ...item, windowSmsNotifiedKey: key } : item;
    await persist({
      ...plan,
      unassigned: plan.unassigned.map(stamp),
      notReady: plan.notReady.map(stamp),
      trucks: plan.trucks.map((truck) => ({
        ...truck,
        stops: truck.stops.map(stamp),
      })),
    });
  };

  const handleTextAllCustomers = async () => {
    if (!plan || bulkSmsBusy || saving) return;
    if (bulkSmsProgress && !bulkSmsProgress.finished) return;
    const { send, skippedSent, skippedNoPhone } = windowSmsTargets;
    if (send.length === 0) {
      setStatus('No customers left to text on this day’s trucks.');
      return;
    }
    const skipBits = [
      skippedSent
        ? `${skippedSent} already texted for the current window`
        : '',
      skippedNoPhone ? `${skippedNoPhone} with no phone` : '',
    ].filter(Boolean);
    const skipLine = skipBits.length
      ? `\n\nSkipped: ${skipBits.join('; ')}.`
      : '';
    const confirmed = window.confirm(
      `Send the arrival-window text to ${send.length} customer${
        send.length === 1 ? '' : 's'
      } on this day’s trucks?${skipLine}\n\nEach person gets the same personalized window text as the per-job Send text button. Messages go out from the shop phone.`
    );
    if (!confirmed) return;

    setBulkSmsBusy(true);
    setBulkSmsTracks([]);
    setBulkSmsQueueTotal(send.length);
    setError(null);
    setStatus(null);
    const queuedIds: string[] = [];
    const tracks: BulkSmsTrack[] = [];
    const failed: string[] = [];
    try {
      for (let index = 0; index < send.length; index += 1) {
        const stop = send[index];
        const phone = primaryCustomerPhone(stop);
        try {
          const result = await queuePhoneSms(
            phone,
            customerWindowSms(stop, plan.date),
            'dispatch'
          );
          queuedIds.push(stop.id);
          tracks.push({
            smsId: result.id,
            stopId: stop.id,
            customerName: stop.customerName || stop.workOrderNumber || 'Customer',
            phone: result.to || phone,
          });
          setBulkSmsTracks([...tracks]);
        } catch (err) {
          failed.push(
            `${stop.customerName || stop.workOrderNumber || 'job'}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      if (queuedIds.length === 0) {
        setBulkSmsTracks([]);
        setBulkSmsQueueTotal(0);
        setError(failed[0] || 'Could not queue any window texts.');
        return;
      }

      setBulkSmsBusy(false);

      const current = planRef.current || plan;
      const queued = new Set(queuedIds);
      const stamp = (item: DispatchStop) =>
        queued.has(item.id)
          ? { ...item, windowSmsNotifiedKey: windowKey(item.window) }
          : item;
      await persist({
        ...current,
        unassigned: current.unassigned.map(stamp),
        notReady: current.notReady.map(stamp),
        trucks: current.trucks.map((truck) => ({
          ...truck,
          stops: truck.stops.map(stamp),
        })),
      });
      if (failed.length) {
        setError(
          `${failed.length} could not be queued: ${failed.slice(0, 3).join('; ')}${
            failed.length > 3 ? '…' : ''
          }`
        );
      }
    } finally {
      setBulkSmsBusy(false);
    }
  };

  const openManualForm = () => {
    setManualForm(emptyManualForm(plan?.date || selectedDate));
    setError(null);
    setShowManualForm(true);
  };

  const updateManualField = <K extends keyof ManualDispatchJobInput>(
    key: K,
    value: ManualDispatchJobInput[K]
  ) => {
    setManualForm((current) => ({ ...current, [key]: value }));
  };

  const handleCreateManualJob = async () => {
    if (!plan || creatingManualJobRef.current) return;
    creatingManualJobRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const stop = await createManualDispatchJob(manualForm);
      const jobDate = manualForm.appointmentDate.trim();
      setShowManualForm(false);
      setManualForm(emptyManualForm(jobDate));
      if (jobDate === plan.date) {
        const already = plan.unassigned.some((item) => item.id === stop.id);
        const next: DispatchPlan = {
          ...plan,
          unassigned: already ? plan.unassigned : [...plan.unassigned, stop],
        };
        await saveDispatchPlan(next);
        setPlan(next);
        setStatus(
          `Work order ${stop.workOrderNumber} added to Ready / Unassigned. Drag it onto a truck.`
        );
      } else {
        onSelectDate(jobDate);
        setStatus(
          `Work order ${stop.workOrderNumber} saved for ${jobDate}. Switched to that day.`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      creatingManualJobRef.current = false;
      setSaving(false);
    }
  };

  const handleAddPlumber = async () => {
    const name = plumberNameDraft.trim();
    if (!name || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await addPlumber(plumbers, name);
      setPlumbers(next);
      setPlumberNameDraft('');
      setStatus(`Added ${name} to the plumber list.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRemovePlumberName = async (plumber: Plumber) => {
    if (!plan || saving) return;
    setSaving(true);
    setError(null);
    try {
      const nextRoster = await removePlumber(plumbers, plumber.id);
      setPlumbers(nextRoster);
      await persist(plan, `Removed ${plumber.name} from the plumber list.`, nextRoster);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const handleAssignPlumber = async (truckId: string, plumberId: string) => {
    if (!plan || !plumberId) return;
    const plumber = plumbers.find((item) => item.id === plumberId);
    const previous = truckAssignedToPlumber(plan, plumberId, plumbers);
    const nextPlumbers = await setPlumberTruck(plumbers, plumberId, truckId);
    setPlumbers(nextPlumbers);
    const truck = plan.trucks.find((item) => item.id === truckId);
    const moved =
      previous && previous.id !== truckId ? ` Moved off ${previous.name}.` : '';
    await persist(
      plan,
      plumber && truck ? `${plumber.name} assigned to ${truck.name}.${moved}` : undefined,
      nextPlumbers
    );
  };

  const handleAddTruckPhone = async (
    truckId: string,
    input: { phone: string; label?: string }
  ) => {
    setError(null);
    try {
      const next = await addTruckPhone(truckPhones, truckId, input);
      setTruckPhones(next);
      const truck = plan?.trucks.find((item) => item.id === truckId);
      setStatus(`Added a phone number to ${truck?.name || 'the truck'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  const handleRemoveTruckPhone = async (truckId: string, phoneId: string) => {
    setError(null);
    try {
      const next = await removeTruckPhone(truckPhones, truckId, phoneId);
      setTruckPhones(next);
      const truck = plan?.trucks.find((item) => item.id === truckId);
      setStatus(`Removed a phone number from ${truck?.name || 'the truck'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUnassignPlumber = async (truckId: string, plumberId: string) => {
    if (!plan) return;
    const plumber = plumbers.find((item) => item.id === plumberId);
    const truck = plan.trucks.find((item) => item.id === truckId);
    const nextPlumbers = await setPlumberTruck(plumbers, plumberId, '');
    setPlumbers(nextPlumbers);
    await persist(
      plan,
      plumber && truck ? `${plumber.name} removed from ${truck.name}.` : undefined,
      nextPlumbers
    );
  };

  const removeStop = (
    current: DispatchPlan,
    payload: DragPayload
  ): { plan: DispatchPlan; stop: DispatchStop | null } => {
    if (payload.from === 'unassigned') {
      const stop = current.unassigned.find((item) => item.id === payload.stopId) || null;
      return {
        stop,
        plan: {
          ...current,
          unassigned: current.unassigned.filter((item) => item.id !== payload.stopId),
        },
      };
    }
    if (payload.from === 'notReady') {
      const stop = current.notReady.find((item) => item.id === payload.stopId) || null;
      return {
        stop,
        plan: {
          ...current,
          notReady: current.notReady.filter((item) => item.id !== payload.stopId),
        },
      };
    }
    const truck = current.trucks.find((item) => item.id === payload.truckId);
    const stop = truck?.stops.find((item) => item.id === payload.stopId) || null;
    return {
      stop,
      plan: {
        ...current,
        trucks: current.trucks.map((item) => {
          if (item.id !== payload.truckId) return item;
          return {
            ...item,
            stops: applyDefaultWindows(item.stops.filter((s) => s.id !== payload.stopId)),
          };
        }),
      },
    };
  };

  const onDropToLane = async (
    event: DragEvent,
    target:
      | { type: 'unassigned' }
      | { type: 'notReady' }
      | { type: 'truck'; truckId: string; index?: number }
  ) => {
    event.preventDefault();
    if (!plan) return;
    const payload = parseDrag(event.dataTransfer.getData('application/json'));
    if (!payload) return;

    if (target.type === 'truck') {
      const truck = plan.trucks.find((item) => item.id === target.truckId);
      if (!truck || truck.set) {
        setError('That truck is Set. Reopen it before changing stops.');
        return;
      }
    }

    const copyOntoTruck = isCopyDrop(event) && target.type === 'truck';
    if (copyOntoTruck) {
      const source =
        payload.from === 'unassigned'
          ? plan.unassigned.find((item) => item.id === payload.stopId)
          : payload.from === 'notReady'
            ? plan.notReady.find((item) => item.id === payload.stopId)
            : plan.trucks
                .find((item) => item.id === payload.truckId)
                ?.stops.find((item) => item.id === payload.stopId);
      if (!source || source.cancelled) {
        setError('Restore the job before copying it to another truck.');
        return;
      }
      try {
        const destId = target.truckId;
        const dest = plan.trucks.find((item) => item.id === destId);
        if (dest?.stops.some((item) => workOrderKey(item) === workOrderKey(source))) {
          setError(`That job is already on ${dest.name}.`);
          return;
        }
        const copy = cloneDispatchStopForCopy(source);
        const insertIndex = truckDropInsertIndex(payload, target);
        const next: DispatchPlan = {
          ...plan,
          trucks: plan.trucks.map((truck) => {
            if (truck.id !== destId) return truck;
            const stops = [...truck.stops];
            const insertAt =
              insertIndex == null || insertIndex < 0 || insertIndex > stops.length
                ? stops.length
                : insertIndex;
            stops.splice(insertAt, 0, copy);
            return { ...truck, stops: applyDefaultWindows(stops) };
          }),
        };
        const savedPlan = await saveWindowSmsDefaults(
          plan,
          next,
          `Copied ${source.workOrderNumber || source.customerName || 'job'} to ${dest?.name || 'the truck'}.`
        );
        if (!savedPlan) return;
        if (dest) {
          const destTruck = savedPlan.trucks.find((item) => item.id === destId);
          if (destTruck) await syncDispatchTruckToSchedule(plan.date, destTruck);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    const { plan: without, stop } = removeStop(plan, payload);
    if (!stop) return;

    let next: DispatchPlan = without;
    if (target.type === 'unassigned') {
      next = { ...without, unassigned: [...without.unassigned, stop] };
    } else if (target.type === 'notReady') {
      next = { ...without, notReady: [...without.notReady, stop] };
    } else if (target.type === 'truck') {
      const truckId = target.truckId;
      const insertIndex = truckDropInsertIndex(payload, target);
      next = {
        ...without,
        trucks: without.trucks.map((truck) => {
          if (truck.id !== truckId) return truck;
          const stops = [...truck.stops];
          const insertAt =
            insertIndex == null || insertIndex < 0 || insertIndex > stops.length
              ? stops.length
              : insertIndex;
          stops.splice(insertAt, 0, {
            ...stop,
            cancelled: false,
            customWindow: stop.customWindow,
          });
          return { ...truck, stops: applyDefaultWindows(stops) };
        }),
      };
    }

    const leftSourceTruck =
      payload.from === 'truck' &&
      (target.type !== 'truck' || target.truckId !== payload.truckId);
    const savedPlan = await saveWindowSmsDefaults(
      plan,
      next,
      leftSourceTruck ? 'Job moved off the truck.' : 'Stops updated.'
    );
    if (!savedPlan) return;

    try {
      await refreshPendingMorningWindowsForPlan(plan, savedPlan);
      if (payload.from === 'truck' && payload.truckId) {
        if (leftSourceTruck) {
          await cancelPendingMorningText(plan.date, payload.truckId, payload.stopId);
        }
        const sourceTruck = savedPlan.trucks.find((item) => item.id === payload.truckId);
        if (sourceTruck) await syncDispatchTruckToSchedule(plan.date, sourceTruck);
      }
      if (target.type === 'truck') {
        const destTruck = savedPlan.trucks.find((item) => item.id === target.truckId);
        const sourceTruckId = payload.from === 'truck' ? payload.truckId : undefined;
        if (destTruck && destTruck.id !== sourceTruckId) {
          await syncDispatchTruckToSchedule(plan.date, destTruck);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateStopOnTruck = async (
    truckId: string,
    stopId: string,
    updater: (stop: DispatchStop) => DispatchStop
  ) => {
    if (!plan) return;
    const truck = plan.trucks.find((item) => item.id === truckId);
    if (!truck || truck.set) return;
    const next: DispatchPlan = {
      ...plan,
      trucks: plan.trucks.map((item) => {
        if (item.id !== truckId) return item;
        return {
          ...item,
          stops: item.stops.map((stop) => (stop.id === stopId ? updater(stop) : stop)),
        };
      }),
    };
    await persist(next);
  };

  const handleSetTruck = async (truck: DispatchTruck, set: boolean) => {
    if (!plan) return;
    setSaving(true);
    setError(null);
    try {
      let updatedTruck: DispatchTruck;
      if (set) {
        if (truck.stops.length === 0) {
          setError('Add at least one stop before marking a truck Set.');
          return;
        }
        updatedTruck = await queueMorningTextsForTruck(plan, truck);
      } else {
        updatedTruck = await cancelMorningTextsForTruck(plan, truck);
      }
      const next: DispatchPlan = {
        ...plan,
        trucks: plan.trucks.map((item) => (item.id === truck.id ? updatedTruck : item)),
      };
      await saveDispatchPlan(next);
      setPlan(next);
      setStatus(
        set
          ? `${truck.name} is Set. Morning window texts queued for the test number (+18609643025).`
          : `${truck.name} reopened. Pending morning texts cancelled.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCopyToTruck = async (stop: DispatchStop, truckId: string) => {
    if (!plan) return;
    const dest = plan.trucks.find((item) => item.id === truckId);
    const label = stop.workOrderNumber || stop.customerName || 'this job';
    setCopyingStopId(stop.id);
    setError(null);
    try {
      const next = duplicateDispatchStopToTruck(plan, stop.id, truckId);
      const ok = await persist(
        next,
        `Copied ${label} to ${dest?.name || 'the truck'}. Both trucks keep the job.`
      );
      if (!ok) return;
      const updated = next.trucks.find((item) => item.id === truckId);
      if (updated) await syncDispatchTruckToSchedule(plan.date, updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCopyingStopId(null);
    }
  };

  const handleDeleteJob = async (stop: DispatchStop) => {
    if (!plan) return;
    const label = stop.workOrderNumber || stop.customerName || 'this job';
    const others = otherTruckNamesForStop(plan, stop);
    const confirmed = window.confirm(
      others.length
        ? `Remove this copy of ${label}? It stays on ${others.join(' and ')}.`
        : `Delete ${label}? This removes it from the board and deletes the work order.`
    );
    if (!confirmed) return;

    setDeletingStopId(stop.id);
    setError(null);
    try {
      const next = await deleteDispatchJob(plan, stop.id);
      await saveWindowSmsDefaults(plan, next, `Deleted ${label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingStopId(null);
    }
  };

  const handleCancelJob = async (stop: DispatchStop) => {
    if (!plan) return;
    const label = stop.workOrderNumber || stop.customerName || 'this job';
    const nextCancelled = !stop.cancelled;
    if (nextCancelled) {
      const onTruck = plan.trucks.some((truck) =>
        truck.stops.some((item) => item.id === stop.id)
      );
      const others = otherTruckNamesForStop(plan, stop);
      const confirmed = window.confirm(
        others.length
          ? `Remove this copy of ${label}? It stays on ${others.join(' and ')}.`
          : onTruck
            ? `Cancel ${label}? It comes off the truck and goes back to Ready / Unassigned.`
            : `Cancel ${label}? It stays in Ready / Unassigned as cancelled.`
      );
      if (!confirmed) return;
    }

    setCancellingStopId(stop.id);
    setError(null);
    try {
      const next = await setDispatchJobCancelled(plan, stop.id, nextCancelled);
      await saveWindowSmsDefaults(
        plan,
        next,
        nextCancelled ? `Cancelled ${label}. It is off the truck.` : `Restored ${label}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancellingStopId(null);
    }
  };

  const handleCloseJob = async (stop: DispatchStop) => {
    if (!plan) return;
    const label = stop.workOrderNumber || stop.customerName || 'this job';
    const others = otherTruckNamesForStop(plan, stop);
    const confirmed = window.confirm(
      others.length
        ? `Remove this copy of ${label}? It stays on ${others.join(' and ')}.`
        : `Close ${label}? It will leave dispatch but remain saved in Firebase history.`
    );
    if (!confirmed) return;

    setClosingStopId(stop.id);
    setError(null);
    try {
      const next = await closeDispatchJob(plan, stop.id);
      await saveWindowSmsDefaults(
        plan,
        next,
        `Closed ${label}. It remains in work-order history.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClosingStopId(null);
    }
  };

  const handleSaveNotes = async (stop: DispatchStop, notes: string) => {
    if (!plan) return;
    if (notes === (stop.notes || '')) return;
    const workOrderId = (stop.workOrderId || stop.id).trim();
    if (!workOrderId) {
      throw new Error('This job is missing a work order, so notes cannot be saved.');
    }
    const previous = plan;
    setPlan(mapStopOnPlan(plan, stop.id, (item) => ({ ...item, notes })));
    setError(null);
    try {
      await patchWorkOrderFields(workOrderId, { notes });
      setStatus('Notes saved.');
    } catch (err) {
      setPlan(previous);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const handleChangeServiceDate = async (stop: DispatchStop, nextDate: string) => {
    if (!plan) return;
    const workOrderId = (stop.workOrderId || stop.id).trim();
    if (!workOrderId) {
      throw new Error('This job is missing a work order, so the date cannot be changed.');
    }
    const current = stopServiceDate(stop, plan.date);
    if (nextDate === current) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
      throw new Error('Pick a valid service date.');
    }
    setDateSavingStopId(stop.id);
    setError(null);
    try {
      await manuallyScheduleWorkOrder(workOrderId, nextDate);
      const label = stop.workOrderNumber || stop.customerName || 'job';
      const when = formatMovedDate(nextDate);
      setStatus(
        nextDate === plan.date
          ? `Service date for ${label} is ${when}. That date is locked so Teams import will not overwrite it.`
          : `Moved ${label} to ${when}. It will show on that day’s board. The date is locked so Teams import will not overwrite it.`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setDateSavingStopId(null);
    }
  };

  const handleVoiceConfirmation = async (
    truck: DispatchTruck,
    stop: DispatchStop,
    toPhone?: string
  ) => {
    if (!plan) return;
    const phones = customerPhonesOf(stop);
    const selected = toPhone || phones[0] || stop.phone;
    if (!selected?.trim()) {
      setError('This job does not have a phone number.');
      return;
    }
    const confirmed = window.confirm(
      voiceCallRoute === 'customer'
        ? `This will call the actual customer at ${formatCustomerPhone(selected)}.\n\nThe agent will talk about ${stop.customerName || 'this job'} and ${formatWindowLabel(stop.window)}.`
        : `This will call ${selectedVoiceRouteLabel} only.\nIt will not call the customer at ${formatCustomerPhones(stop) || selected}.\n\nThe agent will still talk about ${stop.customerName || 'this job'} and ${formatWindowLabel(stop.window)}.`
    );
    if (!confirmed) return;

    setCallingStopId(stop.id);
    setError(null);
    try {
      const result = await initiateVoiceWindowConfirmation(
        plan.date,
        truck.id,
        stop.id,
        voiceCallRoute,
        voiceCallRoute === 'customer' ? selected : undefined
      );
      const next: DispatchPlan = {
        ...plan,
        trucks: plan.trucks.map((candidate) =>
          candidate.id !== truck.id
            ? candidate
            : {
                ...candidate,
                stops: candidate.stops.map((candidateStop) =>
                  candidateStop.id !== stop.id
                    ? candidateStop
                    : {
                        ...candidateStop,
                        voiceCallStatus: 'queued',
                        voiceConfirmationId: result.confirmationId,
                        voiceConversationId: undefined,
                        voiceConfirmationResponse: undefined,
                        voiceConfirmationAt: undefined,
                        voiceConfirmationDetails: `Call queued to ${result.to}`,
                      }
                ),
              }
        ),
      };
      setPlan(next);
      setStatus(
        `Confirmation call queued to ${result.to} for ${formatWindowLabel(stop.window)}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCallingStopId(null);
    }
  };

  const copyPropsFor = (stop: DispatchStop) => {
    if (!plan) return {};
    const names = otherTruckNamesForStop(plan, stop);
    return {
      copyTrucks: copyTruckOptionsForStop(plan, stop),
      alsoOnLabel: names.length ? `Also ${names.join(', ')}` : undefined,
      onCopyToTruck: (truckId: string) => void handleCopyToTruck(stop, truckId),
      copying: copyingStopId === stop.id,
    };
  };

  if (loading || !plan) {
    return (
      <div className="dispatch-board">
        <div className="dispatch-board__loading">Loading CT dispatch board…</div>
        {error && <div className="dispatch-board__error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="dispatch-board">
      <div className="dispatch-board__toolbar">
        <div>
          <h2>CT Dispatch · 5 trucks</h2>
          <p>
            Depot: {plan.originAddress || DEFAULT_DISPATCH_ORIGIN}. Default windows: 10–12,
            11:30–3:30, 1–5, 2–6, 3–7 (assigned in that order, then wrap). Custom texts go
            through the shop Android phone. Morning texts still go to the test number.
            Confirmation calls follow the routing switches: customer, 860-543-9082, or 860-964-3025.
          </p>
        </div>
        <div className="dispatch-board__actions">
          <fieldset className="dispatch-board__voice-routes">
            <legend>Call routing</legend>
            {VOICE_ROUTE_OPTIONS.map((option) => {
              const on = voiceCallRoute === option.id;
              return (
                <label
                  key={option.id}
                  className={`dispatch-board__voice-route${on ? ' dispatch-board__voice-route--on' : ''}`}
                  title={option.hint}
                  onClick={() => setVoiceCallRoute(option.id)}
                >
                  <span>{option.label}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`Route confirmation calls to ${option.label}`}
                    onClick={() => setVoiceCallRoute(option.id)}
                  >
                    <span />
                  </button>
                </label>
              );
            })}
          </fieldset>
          <button
            type="button"
            className="dispatch-board__text-all"
            disabled={
              saving ||
              bulkSmsBusy ||
              Boolean(bulkSmsProgress && !bulkSmsProgress.finished) ||
              windowSmsTargets.send.length === 0
            }
            title={
              bulkSmsBusy
                ? 'Queuing window texts…'
                : bulkSmsProgress && !bulkSmsProgress.finished
                  ? 'The shop phone is still sending this batch'
                  : windowSmsTargets.send.length === 0
                    ? windowSmsTargets.skippedSent > 0
                      ? 'Everyone with a phone already got this window text'
                      : 'Load jobs onto trucks first'
                    : `Text ${windowSmsTargets.send.length} customer${
                        windowSmsTargets.send.length === 1 ? '' : 's'
                      } the arrival-window message`
            }
            onClick={() => void handleTextAllCustomers()}
          >
            {bulkSmsBusy
              ? `Queuing ${bulkSmsTracks.length}/${bulkSmsQueueTotal}…`
              : bulkSmsProgress && !bulkSmsProgress.finished
                ? `Sending ${bulkSmsProgress.sent + bulkSmsProgress.failed}/${bulkSmsProgress.total}`
                : `Text all customers${
                    windowSmsTargets.send.length
                      ? ` (${windowSmsTargets.send.length})`
                      : ''
                  }`}
          </button>
          <button type="button" onClick={openManualForm}>
            New work order
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                const mockStop = await createMockDispatchJob(plan.date);
                const next: DispatchPlan = {
                  ...plan,
                  unassigned: [...plan.unassigned, mockStop],
                };
                await saveDispatchPlan(next);
                setPlan(next);
                setStatus(
                  `Mock job ${mockStop.workOrderNumber} added to Ready / Unassigned. Drag it onto a truck.`
                );
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setSaving(false);
              }
            }}
          >
            Create test job
          </button>
          <button
            type="button"
            disabled={saving || plan.unassigned.length === 0}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                const assigned = await assignUnassignedJobsToTrucks(plan);
                const moved = plan.unassigned.length - assigned.unassigned.length;
                await persist(
                  assigned,
                  moved
                    ? `Loaded ${moved} job${moved === 1 ? '' : 's'} onto trucks by distance. Nearby stops stay together.`
                    : 'No ready jobs to load onto trucks.'
                );
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setSaving(false);
              }
            }}
          >
            Load trucks by distance
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                const ordered = await autoOrderAllUnsetTrucks(plan);
                await persist(ordered, 'Ordered unset trucks farthest-from-depot first (priority wins).');
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setSaving(false);
              }
            }}
          >
            Auto-order by distance
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              forceScheduleReadRef.current = true;
              setBoardEpoch((value) => value + 1);
              setStatus('Reading job notes with AI…');
            }}
          >
            Refresh jobs
          </button>
          <span className="dispatch-board__counts">
            {assignedCount} assigned · {plan.unassigned.length} ready · {plan.notReady.length} not
            ready
            {detecting ? ' · reading job notes…' : ''}
          </span>
        </div>
      </div>

      <DispatchDayStrip
        selectedDate={selectedDate}
        onSelectDate={onSelectDate}
        refreshKey={summaryEpoch}
      />

      {error && <div className="dispatch-board__error">{error}</div>}
      {status && <div className="dispatch-board__status">{status}</div>}
      {bulkSmsProgress ? (
        <div
          className={`dispatch-board__sms-progress${
            bulkSmsProgress.finished ? ' dispatch-board__sms-progress--done' : ''
          }`}
        >
          <div className="dispatch-board__sms-progress-head">
            <strong>
              {bulkSmsBusy
                ? `Queuing texts ${bulkSmsProgress.queuedCount} of ${bulkSmsProgress.total}`
                : bulkSmsProgress.finished
                  ? bulkSmsProgress.failed
                    ? `Sent ${bulkSmsProgress.sent} of ${bulkSmsProgress.total} · ${bulkSmsProgress.failed} failed`
                    : `Sent all ${bulkSmsProgress.total} window texts`
                  : `Shop phone sending ${bulkSmsProgress.sent + bulkSmsProgress.failed} of ${bulkSmsProgress.total}`}
            </strong>
            {bulkSmsProgress.finished ? (
              <button
                type="button"
                onClick={() => {
                  setBulkSmsTracks([]);
                  setBulkSmsQueueTotal(0);
                }}
              >
                Hide
              </button>
            ) : null}
          </div>
          <div
            className="dispatch-board__sms-progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={bulkSmsProgress.total}
            aria-valuenow={
              bulkSmsBusy
                ? bulkSmsProgress.queuedCount
                : bulkSmsProgress.sent + bulkSmsProgress.failed
            }
          >
            <span
              style={{
                width: `${Math.round(
                  (100 *
                    (bulkSmsBusy
                      ? bulkSmsProgress.queuedCount
                      : bulkSmsProgress.sent + bulkSmsProgress.failed)) /
                    Math.max(1, bulkSmsProgress.total)
                )}%`,
              }}
            />
          </div>
          {bulkSmsProgress.sending ? (
            <p>
              Now sending: {bulkSmsProgress.sending.customerName}{' '}
              ({formatCustomerPhone(bulkSmsProgress.sending.phone)})
            </p>
          ) : bulkSmsBusy ? (
            <p>Handing messages to the shop phone…</p>
          ) : bulkSmsProgress.finished ? (
            <p>
              {bulkSmsProgress.failed
                ? 'The shop phone finished this batch. Failed names are marked below.'
                : 'The shop phone finished this batch.'}
            </p>
          ) : (
            <p>
              {bulkSmsProgress.waiting} waiting
              {bulkSmsProgress.sent ? ` · ${bulkSmsProgress.sent} sent` : ''}
              {bulkSmsProgress.failed ? ` · ${bulkSmsProgress.failed} failed` : ''}
            </p>
          )}
          <ol>
            {bulkSmsProgress.rows.map((row) => (
              <li
                key={row.smsId}
                className={`dispatch-board__sms-progress-item dispatch-board__sms-progress-item--${row.status}`}
              >
                <span>{row.customerName}</span>
                <span>
                  {formatSmsStatus(row.status)}
                  {row.status === 'failed' && row.error ? ` · ${row.error}` : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <DispatchGasBar
        estimates={gasEstimates}
        settings={fuelSettings}
        savingFuel={savingFuel}
        onShopPrice={onShopPrice}
        onSaveFuel={onSaveFuel}
      />

      <section className="dispatch-plumbers" aria-label="Plumbers">
        <div className="dispatch-plumbers__header">
          <h3>Plumbers</h3>
          <form
            className="dispatch-plumbers__add"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAddPlumber();
            }}
          >
            <input
              type="text"
              maxLength={80}
              autoComplete="off"
              placeholder="Add plumber name"
              value={plumberNameDraft}
              onChange={(event) => setPlumberNameDraft(event.target.value)}
            />
            <button type="submit" disabled={saving || !plumberNameDraft.trim()}>
              Add
            </button>
          </form>
        </div>
        {plumbers.length === 0 ? (
          <p className="dispatch-lane__empty">
            Add names, then assign them to trucks below.
          </p>
        ) : (
          <ul className="dispatch-plumbers__list">
            {plumbers.map((plumber) => {
              const assigned = truckAssignedToPlumber(plan, plumber.id, plumbers);
              return (
                <li key={plumber.id}>
                  <strong>{plumber.name}</strong>
                  <span>{assigned ? assigned.name : 'Unassigned'}</span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleRemovePlumberName(plumber)}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {importProgress && (
        <div className="dispatch-board__import-progress">
          <strong>
            {importProgress.status === 'queued'
              ? 'Teams import queued'
              : importProgress.status === 'processing'
              ? 'Teams import in progress'
              : importProgress.status === 'failed'
                ? 'Teams import needs attention'
                : importProgress.status === 'canceled'
                  ? 'Teams import canceled'
                : 'Latest Teams import'}
          </strong>
          <span>
            {importProgress.channelName}: {importProgress.processed}/
            {importProgress.total} PDFs processed · {importProgress.imported}{' '}
            imported · {importProgress.cached} cached
            {importProgress.failed ? ` · ${importProgress.failed} failed` : ''}
          </span>
          {(importProgress.pdfCostUsd != null ||
            importProgress.scheduleCostUsd != null ||
            importProgress.openaiCostUsd != null) && (
            <span>
              OpenAI: PDFs {formatUsd(importProgress.pdfCostUsd)} · schedule{' '}
              {formatUsd(importProgress.scheduleCostUsd)} · total{' '}
              {formatUsd(importProgress.openaiCostUsd)}
            </span>
          )}
          {importProgress.message && <small>{importProgress.message}</small>}
          {(importProgress.status === 'queued' ||
            importProgress.status === 'processing') && (
            <button
              type="button"
              disabled={cancelingImport}
              onClick={async () => {
                setCancelingImport(true);
                try {
                  await cancelWorkOrderImport(importProgress.id);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setCancelingImport(false);
                }
              }}
            >
              {cancelingImport ? 'Canceling…' : 'Cancel import'}
            </button>
          )}
        </div>
      )}

      <div className="dispatch-board__lanes">
        <section
          className="dispatch-lane dispatch-lane--not-ready"
          onDragOver={scrollLaneOnDrag}
          onDrop={(event) => void onDropToLane(event, { type: 'notReady' })}
        >
          <h3>Not Ready</h3>
          <p className="dispatch-lane__hint">Missing notes on the work order PDF/doc</p>
          {plan.notReady.length === 0 && (
            <p className="dispatch-lane__empty">No blocked jobs</p>
          )}
          {plan.notReady.map((stop) => (
            <StopNode
              key={stop.id}
              stop={stop}
              locked={false}
              scheduleDate={plan.date}
              smsOutbox={smsOutbox}
              smsInbox={smsInbox}
              dragPayload={{ from: 'notReady', stopId: stop.id }}
              {...copyPropsFor(stop)}
              onCancel={() => void handleCancelJob(stop)}
              cancelling={cancellingStopId === stop.id}
              onDelete={() => void handleDeleteJob(stop)}
              deleting={deletingStopId === stop.id}
              onNotesChange={(notes) => handleSaveNotes(stop, notes)}
              onServiceDateChange={(date) => handleChangeServiceDate(stop, date)}
              dateSaving={dateSavingStopId === stop.id}
              onTextQueued={(notice) => {
                setError(null);
                setStatus(notice);
              }}
            />
          ))}
        </section>

        <section
          className="dispatch-lane dispatch-lane--unassigned"
          onDragOver={scrollLaneOnDrag}
          onDrop={(event) => void onDropToLane(event, { type: 'unassigned' })}
        >
          <h3>Ready / Unassigned</h3>
          <p className="dispatch-lane__hint">Drag onto a truck · Ctrl-drag copies to a second truck</p>
          <div className="dispatch-lane__jobs" onDragOver={scrollLaneOnDrag}>
          {plan.unassigned.length === 0 && (
            <p className="dispatch-lane__empty">No unassigned ready jobs</p>
          )}
          {plan.unassigned.map((stop) => (
            <StopNode
              key={stop.id}
              stop={stop}
              locked={false}
              scheduleDate={plan.date}
              smsOutbox={smsOutbox}
              smsInbox={smsInbox}
              onPriorityChange={async (priority) => {
                const next = {
                  ...plan,
                  unassigned: plan.unassigned.map((item) =>
                    item.id === stop.id ? { ...item, priority } : item
                  ),
                };
                await persist(next);
              }}
              dragPayload={{ from: 'unassigned', stopId: stop.id }}
              {...copyPropsFor(stop)}
              onClose={() => void handleCloseJob(stop)}
              closing={closingStopId === stop.id}
              onCancel={() => void handleCancelJob(stop)}
              cancelling={cancellingStopId === stop.id}
              onDelete={() => void handleDeleteJob(stop)}
              deleting={deletingStopId === stop.id}
              onNotesChange={(notes) => handleSaveNotes(stop, notes)}
              onServiceDateChange={(date) => handleChangeServiceDate(stop, date)}
              dateSaving={dateSavingStopId === stop.id}
              onTextQueued={(notice) => {
                setError(null);
                setStatus(notice);
              }}
            />
          ))}
          </div>
        </section>

        <div className="dispatch-board__trucks" onDragOver={scrollLaneOnDrag}>
          {plan.trucks.map((truck) => (
            <section
              key={truck.id}
              className={`dispatch-truck ${truck.set ? 'dispatch-truck--set' : ''}`}
              onDragOver={scrollLaneOnDrag}
              onDrop={(event) =>
                void onDropToLane(event, { type: 'truck', truckId: truck.id })
              }
            >
              <header className="dispatch-truck__header">
                <div>
                  <h3>{truck.name}</h3>
                  <span>
                    {truck.stops.length} stop{truck.stops.length === 1 ? '' : 's'}
                    {truck.set ? ' · SET' : ''}
                    {plumberNamesForIds(truck.plumberIds, plumbers).length
                      ? ` · ${plumberNamesForIds(truck.plumberIds, plumbers).join(', ')}`
                      : truck.driver
                        ? ` · ${truck.driver}`
                        : ''}
                  </span>
                </div>
                <label className="dispatch-truck__assign">
                  Assign plumber
                  <select
                    value=""
                    disabled={saving || plumbers.length === 0}
                    onChange={(event) => {
                      const plumberId = event.target.value;
                      if (plumberId) void handleAssignPlumber(truck.id, plumberId);
                    }}
                  >
                    <option value="">
                      {plumbers.length === 0 ? 'Add plumbers first' : 'Choose plumber'}
                    </option>
                    {plumbers.map((plumber) => {
                      const assigned = truckAssignedToPlumber(plan, plumber.id, plumbers);
                      const onThisTruck = assigned?.id === truck.id;
                      return (
                        <option
                          key={plumber.id}
                          value={plumber.id}
                          disabled={onThisTruck}
                        >
                          {plumber.name}
                          {assigned && !onThisTruck ? ` · on ${assigned.name}` : ''}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <TruckPhoneControls
                  truck={truck}
                  phones={phonesForTruck(truckPhones, truck.id)}
                  saving={saving}
                  smsOutbox={smsOutbox}
                  smsInbox={smsInbox}
                  onAdd={(input) => handleAddTruckPhone(truck.id, input)}
                  onRemove={(phoneId) => handleRemoveTruckPhone(truck.id, phoneId)}
                  onText={(phone) =>
                    setTruckSms({
                      truckId: truck.id,
                      truckName: truck.name,
                      phone: phone || phonesForTruck(truckPhones, truck.id)[0]?.phone || '',
                    })
                  }
                />
                {(truck.plumberIds || []).length > 0 && (
                  <div className="dispatch-truck__plumber-chips">
                    {(truck.plumberIds || []).map((plumberId) => {
                      const plumber = plumbers.find((item) => item.id === plumberId);
                      const label = plumber?.name || 'Unknown plumber';
                      return (
                        <button
                          key={plumberId}
                          type="button"
                          className="dispatch-truck__plumber-chip"
                          disabled={saving}
                          onClick={() => void handleUnassignPlumber(truck.id, plumberId)}
                        >
                          {label} ×
                        </button>
                      );
                    })}
                  </div>
                )}
                <TruckGasLine
                  truck={truck}
                  estimate={estimateFor(truck.id)}
                  saving={saving || savingFuel}
                  onMpg={(mpg) => onTruckMpg(truck.id, mpg)}
                  onReceipt={async (amount) => {
                    const next = {
                      ...plan,
                      trucks: plan.trucks.map((item) =>
                        item.id === truck.id ? { ...item, gasReceiptUsd: amount } : item
                      ),
                    };
                    await persist(
                      next,
                      amount
                        ? `${truck.name} gas receipt saved.`
                        : `${truck.name} gas receipt cleared.`
                    );
                  }}
                />
                <div className="dispatch-truck__actions">
                  <button
                    type="button"
                    disabled={saving || truck.set || truck.stops.length < 2}
                    onClick={async () => {
                      const ordered = await autoOrderTruckStops(plan, truck.id);
                      await persist(ordered, `${truck.name} ordered farthest first.`);
                    }}
                  >
                    Farthest first
                  </button>
                  {truck.set ? (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleSetTruck(truck, false)}
                    >
                      Reopen
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="dispatch-truck__set"
                      disabled={saving || truck.stops.length === 0}
                      onClick={() => void handleSetTruck(truck, true)}
                    >
                      Set
                    </button>
                  )}
                </div>
              </header>

              <div className="dispatch-truck__stops" onDragOver={scrollLaneOnDrag}>
              {truck.stops.length === 0 && (
                <p className="dispatch-lane__empty">Drop jobs here</p>
              )}

              {truck.stops.map((stop, index) => (
                <div
                  key={stop.id}
                  className="dispatch-truck__slot"
                  onDragOver={scrollLaneOnDrag}
                  onDrop={(event) => {
                    event.stopPropagation();
                    void onDropToLane(event, {
                      type: 'truck',
                      truckId: truck.id,
                      index,
                    });
                  }}
                >
                  <span className="dispatch-truck__order">{index + 1}</span>
                  <StopNode
                    stop={stop}
                    locked={truck.set}
                    scheduleDate={plan.date}
                    smsOutbox={smsOutbox}
                    smsInbox={smsInbox}
                    dragPayload={{
                      from: 'truck',
                      truckId: truck.id,
                      stopId: stop.id,
                      index,
                    }}
                    onPriorityChange={(priority) =>
                      void updateStopOnTruck(truck.id, stop.id, (current) => ({
                        ...current,
                        priority,
                      }))
                    }
                    onWindowChange={(start, end) =>
                      void updateStopOnTruck(truck.id, stop.id, (current) => ({
                        ...current,
                        window: { start, end },
                        customWindow: true,
                      }))
                    }
                    onCallConfirmation={(phone) =>
                      void handleVoiceConfirmation(truck, stop, phone)
                    }
                    voiceRoute={voiceCallRoute}
                    voiceRouteLabel={selectedVoiceRouteLabel}
                    calling={callingStopId === stop.id}
                    onClose={() => void handleCloseJob(stop)}
                    closing={closingStopId === stop.id}
                    onCancel={() => void handleCancelJob(stop)}
                    cancelling={cancellingStopId === stop.id}
                    onDelete={() => void handleDeleteJob(stop)}
                    deleting={deletingStopId === stop.id}
                    onNotesChange={(notes) => handleSaveNotes(stop, notes)}
              onServiceDateChange={(date) => handleChangeServiceDate(stop, date)}
              dateSaving={dateSavingStopId === stop.id}
                    onTextQueued={(notice) => {
                      setError(null);
                      setStatus(notice);
                    }}
                    onWindowSmsNotified={() => void stampWindowSmsNotified(stop)}
                    {...copyPropsFor(stop)}
                  />
                </div>
              ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {truckSms && (
        <TruckSmsModal
          truckName={truckSms.truckName}
          phones={phonesForTruck(truckPhones, truckSms.truckId)}
          initialPhone={truckSms.phone}
          smsOutbox={smsOutbox}
          smsInbox={smsInbox}
          onClose={() => setTruckSms(null)}
          onQueued={(notice) => {
            setError(null);
            setStatus(notice);
          }}
        />
      )}

      {showManualForm &&
        createPortal(
          <div className="dispatch-manual" role="dialog" aria-modal="true" aria-labelledby="dispatch-manual-title">
            <button
              type="button"
              className="dispatch-manual__backdrop"
              aria-label="Close new work order"
              onClick={() => {
                setError(null);
                setShowManualForm(false);
              }}
            />
            <form
              className="dispatch-manual__panel"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreateManualJob();
              }}
            >
              <div className="dispatch-manual__header">
                <div>
                  <h3 id="dispatch-manual-title">New work order</h3>
                  <p>Adds a job to this dispatch day. Drag it onto a truck after you save.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setShowManualForm(false);
                  }}
                >
                  Close
                </button>
              </div>
              {error ? <p className="dispatch-board__error">{error}</p> : null}
              <div className="dispatch-manual__grid">
                <label>
                  Work order # <span>(optional)</span>
                  <input
                    value={manualForm.workOrderNumber}
                    onChange={(event) => updateManualField('workOrderNumber', event.target.value)}
                    placeholder="Auto-generated if blank"
                  />
                </label>
                <label>
                  Customer name
                  <input
                    value={manualForm.customerName}
                    onChange={(event) => updateManualField('customerName', event.target.value)}
                    required
                    autoFocus
                  />
                </label>
                <label>
                  Phone
                  <input
                    value={manualForm.phone}
                    onChange={(event) => updateManualField('phone', event.target.value)}
                    placeholder="8605551234 or two numbers"
                    required
                  />
                </label>
                <label>
                  Service address
                  <input
                    value={manualForm.address}
                    onChange={(event) => updateManualField('address', event.target.value)}
                    placeholder="Street, town, CT"
                    required
                  />
                </label>
                <label>
                  Job type
                  <select
                    value={manualForm.jobType}
                    onChange={(event) => updateManualField('jobType', event.target.value)}
                  >
                    {MANUAL_JOB_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Appointment date
                  <input
                    type="date"
                    value={manualForm.appointmentDate}
                    onChange={(event) => updateManualField('appointmentDate', event.target.value)}
                    required
                  />
                </label>
                <label>
                  Time <span>(optional)</span>
                  <input
                    type="time"
                    value={manualForm.appointmentTime}
                    onChange={(event) => updateManualField('appointmentTime', event.target.value)}
                  />
                </label>
                <label className="dispatch-manual__full">
                  Job notes
                  <textarea
                    value={manualForm.notes}
                    onChange={(event) => updateManualField('notes', event.target.value)}
                    placeholder="Scope, access, parts, callback window…"
                  />
                </label>
                <label className="dispatch-manual__check">
                  <input
                    type="checkbox"
                    checked={manualForm.smsConsent}
                    onChange={(event) => updateManualField('smsConsent', event.target.checked)}
                  />
                  Customer agreed to appointment texts
                </label>
              </div>
              <div className="dispatch-manual__actions">
                <button type="submit" className="dispatch-manual__save" disabled={saving}>
                  {saving ? 'Saving…' : 'Save work order'}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setError(null);
                    setShowManualForm(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>,
          document.body
        )}
    </div>
  );
}
