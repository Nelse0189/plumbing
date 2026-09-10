import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DispatchPlan,
  DispatchStop,
  DispatchTruck,
  Plumber,
  StoredWorkOrder,
  TruckPhone,
} from '../types';
import { saveDispatchPlan, subscribeDispatchPlan } from '../services/dispatchService';
import {
  applyPlumberAssignmentsToPlan,
  plumberNamesForIds,
  setPlumberTruck,
  subscribePlumbers,
  truckAssignedToPlumber,
} from '../services/plumberService';
import {
  formatTruckPhone,
  subscribeTruckPhones,
  type TruckPhoneRoster,
} from '../services/truckPhoneService';
import {
  startPlumberJobCall,
  subscribePlumberCall,
} from '../services/plumberVoiceService';
import {
  formatWorkOrderError,
  getStoredWorkOrder,
  patchWorkOrderFields,
  subscribeWorkOrdersForDate,
} from '../services/workOrderService';
import {
  DISPATCH_TIME_SLOTS,
  formatWindowLabel,
  windowKey,
  windowsEqual,
} from '../utils/dispatchWindows';
import { isNativePlumberApp, plumberHref } from '../utils/plumberPage';
import { workOrderHref } from '../utils/workOrderPage';
import { smsPhoneDigits } from '../services/phoneSmsService';
import {
  customerPhonesOf,
  formatCustomerPhone,
  formatCustomerPhones,
  parseCustomerPhones,
} from '../utils/customerPhones';
import {
  getActiveAccount,
  handleRedirectPromise,
  signIn,
  tryAcquireTokenSilent,
} from '../teams-test/auth';
import { downloadTeamsWorkOrderPdf } from '../teams-test/graphClient';
import DispatchDayStrip from './DispatchDayStrip';
import TimeClock from './TimeClock';
import TimeHours from './TimeHours';
import './PlumberBoard.css';

function telHref(phone: string): string | null {
  const digits = smsPhoneDigits(phone);
  return digits.length === 10 ? `tel:+1${digits}` : null;
}

function mapsHref(address: string): string | null {
  const query = address.trim();
  return query ? `https://maps.google.com/?q=${encodeURIComponent(query)}` : null;
}

function orderForStop(
  stop: DispatchStop,
  byId: Map<string, StoredWorkOrder>,
  byNumber: Map<string, StoredWorkOrder>
): StoredWorkOrder | undefined {
  return byId.get(stop.workOrderId) || byId.get(stop.id) || byNumber.get(stop.workOrderNumber);
}

function confirmationLabel(stop: DispatchStop): string | null {
  if (stop.cancelled) return 'Cancelled';
  if (stop.voiceConfirmationResponse === 'confirmed') return 'Window confirmed';
  if (stop.voiceConfirmationResponse === 'declined') return 'Needs reschedule';
  return null;
}

export default function PlumberBoard({
  selectedDate,
  onSelectDate,
  editable = false,
}: {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  editable?: boolean;
}) {
  const [plan, setPlan] = useState<DispatchPlan | null>(null);
  const [orders, setOrders] = useState<StoredWorkOrder[]>([]);
  const [plumbers, setPlumbers] = useState<Plumber[]>([]);
  const [phones, setPhones] = useState<TruckPhoneRoster>({});
  const [filterTruckId, setFilterTruckId] = useState(() => {
    return new URLSearchParams(window.location.search).get('truck') || '';
  });
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [pdfBusyId, setPdfBusyId] = useState('');
  const [callBusyKey, setCallBusyKey] = useState('');
  const [callHint, setCallHint] = useState('');
  const [callId, setCallId] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [pdfViewer, setPdfViewer] = useState<{ title: string; url: string } | null>(null);
  const [signedIn, setSignedIn] = useState(() => Boolean(getActiveAccount()));
  const pdfUrlRef = useRef('');
  const plumbersRef = useRef(plumbers);
  plumbersRef.current = plumbers;

  useEffect(() => {
    if (editable) return;
    history.replaceState(
      null,
      '',
      plumberHref({ date: selectedDate, truck: filterTruckId || undefined })
    );
  }, [selectedDate, filterTruckId, editable]);

  useEffect(() => {
    return subscribeDispatchPlan(
      selectedDate,
      setPlan,
      (err) => setError(err.message)
    );
  }, [selectedDate]);

  useEffect(() => {
    return subscribeWorkOrdersForDate(
      selectedDate,
      setOrders,
      (err) => setError(err.message)
    );
  }, [selectedDate]);

  useEffect(() => {
    return subscribeTruckPhones(setPhones, (err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!callId) return;
    return subscribePlumberCall(
      callId,
      (call) => {
        if (call.status === 'queued' || call.status === 'ringing') {
          setCallHint(`Answer ${formatTruckPhone(call.plumberPhone)} to connect to the customer.`);
          return;
        }
        if (call.status === 'in-progress') {
          setCallHint('Connected. This call is recorded.');
          return;
        }
        if (call.status === 'completed' || call.status === 'processed' || call.status === 'awaiting_transcript') {
          setCallHint('Call ended. The recording is going to the Calls tab.');
          setCallBusyKey('');
          return;
        }
        if (
          call.status === 'no-answer' ||
          call.status === 'busy' ||
          call.status === 'canceled' ||
          call.status === 'failed'
        ) {
          setCallHint('');
          setCallBusyKey('');
          setError(call.error || `Call ${call.status.replace(/-/g, ' ')}.`);
        }
      },
      (err) => setError(err.message)
    );
  }, [callId]);

  const startRecordedCall = async (input: {
    truckId: string;
    stopId: string;
    customerPhone: string;
    plumberPhone?: string;
  }) => {
    const key = `${input.stopId}:${input.customerPhone}`;
    setError('');
    setCallBusyKey(key);
    setCallHint('Calling your truck phone…');
    try {
      const started = await startPlumberJobCall({
        dispatchDate: selectedDate,
        truckId: input.truckId,
        stopId: input.stopId,
        customerPhone: input.customerPhone,
        plumberPhone: input.plumberPhone,
      });
      setCallId(started.callId);
      setCallHint(`Answer ${formatTruckPhone(started.plumberPhone)} to connect to the customer.`);
    } catch (err) {
      setCallBusyKey('');
      setCallHint('');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    return subscribePlumbers(setPlumbers, (err) => setError(err.message));
  }, []);

  useEffect(() => {
    void handleRedirectPromise()
      .then(() => setSignedIn(Boolean(getActiveAccount())))
      .catch(() => null);
  }, []);

  useEffect(
    () => () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    },
    []
  );

  const byId = useMemo(() => {
    const map = new Map<string, StoredWorkOrder>();
    for (const order of orders) map.set(order.id, order);
    return map;
  }, [orders]);

  const byNumber = useMemo(() => {
    const map = new Map<string, StoredWorkOrder>();
    for (const order of orders) {
      const number = order.workOrderNumber.trim();
      if (number) map.set(number, order);
    }
    return map;
  }, [orders]);

  const trucks = useMemo(() => {
    const list = plan?.trucks || [];
    return editable ? list : list.filter((truck) => truck.stops.length > 0);
  }, [plan, editable]);

  const visibleTrucks =
    filterTruckId && trucks.some((truck) => truck.id === filterTruckId)
      ? trucks.filter((truck) => truck.id === filterTruckId)
      : trucks;

  const persistPlan = async (next: DispatchPlan, message?: string, roster = plumbersRef.current) => {
    setSaving(true);
    setError('');
    try {
      const stamped = applyPlumberAssignmentsToPlan(next, roster);
      await saveDispatchPlan(stamped);
      setPlan(stamped);
      if (message) setStatus(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const updateStop = async (
    truckId: string,
    stop: DispatchStop,
    patch: Partial<DispatchStop>,
    workOrderPatch?: Parameters<typeof patchWorkOrderFields>[1]
  ) => {
    if (!plan) return;
    const next: DispatchPlan = {
      ...plan,
      trucks: plan.trucks.map((truck) =>
        truck.id === truckId
          ? {
              ...truck,
              stops: truck.stops.map((item) =>
                item.id === stop.id ? { ...item, ...patch } : item
              ),
            }
          : truck
      ),
    };
    await persistPlan(next);
    const workOrderId = stop.workOrderId || stop.id;
    if (workOrderPatch && workOrderId) {
      try {
        await patchWorkOrderFields(workOrderId, workOrderPatch);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const moveStop = async (truckId: string, stopId: string, direction: -1 | 1) => {
    if (!plan) return;
    const truck = plan.trucks.find((item) => item.id === truckId);
    if (!truck) return;
    const index = truck.stops.findIndex((item) => item.id === stopId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= truck.stops.length) return;
    const stops = [...truck.stops];
    const [moved] = stops.splice(index, 1);
    stops.splice(nextIndex, 0, moved);
    await persistPlan({
      ...plan,
      trucks: plan.trucks.map((item) => (item.id === truckId ? { ...item, stops } : item)),
    });
  };

  const moveStopToTruck = async (fromTruckId: string, stopId: string, toTruckId: string) => {
    if (!plan || fromTruckId === toTruckId) return;
    let moving: DispatchStop | null = null;
    const trucksNext = plan.trucks.map((truck) => {
      if (truck.id === fromTruckId) {
        moving = truck.stops.find((item) => item.id === stopId) || null;
        return { ...truck, stops: truck.stops.filter((item) => item.id !== stopId) };
      }
      return truck;
    });
    if (!moving) return;
    const next = {
      ...plan,
      trucks: trucksNext.map((truck) =>
        truck.id === toTruckId ? { ...truck, stops: [...truck.stops, moving as DispatchStop] } : truck
      ),
    };
    await persistPlan(next, 'Stop moved.');
  };

  const assignPlumber = async (truckId: string, plumberId: string) => {
    if (!plan || !plumberId) return;
    const plumber = plumbers.find((item) => item.id === plumberId);
    const nextRoster = await setPlumberTruck(plumbers, plumberId, truckId);
    setPlumbers(nextRoster);
    plumbersRef.current = nextRoster;
    const truck = plan.trucks.find((item) => item.id === truckId);
    await persistPlan(
      plan,
      plumber && truck ? `${plumber.name} assigned to ${truck.name}.` : undefined,
      nextRoster
    );
  };

  const unassignPlumber = async (truckId: string, plumberId: string) => {
    if (!plan) return;
    const plumber = plumbers.find((item) => item.id === plumberId);
    const truck = plan.trucks.find((item) => item.id === truckId);
    const nextRoster = await setPlumberTruck(plumbers, plumberId, '');
    setPlumbers(nextRoster);
    plumbersRef.current = nextRoster;
    await persistPlan(
      plan,
      plumber && truck ? `${plumber.name} removed from ${truck.name}.` : undefined,
      nextRoster
    );
  };

  const closePdf = () => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    pdfUrlRef.current = '';
    setPdfViewer(null);
  };

  const openPdf = async (stop: DispatchStop) => {
    setPdfBusyId(stop.id);
    setPdfError('');
    try {
      let order = orderForStop(stop, byId, byNumber) || null;
      if (!order && stop.workOrderId) {
        order = await getStoredWorkOrder(stop.workOrderId);
      }
      if (
        !order?.teamsTeamId ||
        !order.teamsChannelId ||
        !order.teamsMessageId ||
        !order.teamsAttachmentId
      ) {
        throw new Error(
          order
            ? 'This job has no Teams work-order PDF on file.'
            : 'Could not find the work order for this stop.'
        );
      }
      let token = await tryAcquireTokenSilent();
      if (!token) {
        await signIn();
        token = await tryAcquireTokenSilent();
        setSignedIn(Boolean(getActiveAccount()));
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
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      pdfUrlRef.current = url;
      setPdfViewer({
        title: `WO ${order.workOrderNumber || stop.workOrderNumber || ''}`.trim(),
        url,
      });
    } catch (err) {
      setPdfError(formatWorkOrderError(err));
    } finally {
      setPdfBusyId('');
    }
  };

  const signInMicrosoft = async () => {
    setPdfError('');
    try {
      await signIn();
      setSignedIn(Boolean(getActiveAccount()));
    } catch (err) {
      setPdfError(formatWorkOrderError(err));
    }
  };

  return (
    <div className={`plumber-board${editable ? ' plumber-board--edit' : ''}`}>
      {pdfViewer ? (
        <div className="plumber-board__pdf" role="dialog" aria-modal="true" aria-label={pdfViewer.title}>
          <button
            type="button"
            className="plumber-board__pdf-backdrop"
            aria-label="Close PDF"
            onClick={closePdf}
          />
          <div className="plumber-board__pdf-panel">
            <header>
              <strong>{pdfViewer.title}</strong>
              <div>
                <a href={pdfViewer.url} target="_blank" rel="noreferrer">
                  Open
                </a>
                <button type="button" onClick={closePdf}>
                  Close
                </button>
              </div>
            </header>
            <iframe title={pdfViewer.title} src={pdfViewer.url} />
          </div>
        </div>
      ) : null}

      <DispatchDayStrip
        selectedDate={selectedDate}
        onSelectDate={onSelectDate}
        label="Schedule day"
      />

      <p className="plumber-board__lede">
        {editable
          ? 'Office editor for the plumber website. Changes here show on /plumber for the trucks.'
          : "Today's truck routes. Call rings your Android Phone app and records the job. Tap an address for maps."}
      </p>

      {editable ? (
        <TimeHours selectedDate={selectedDate} />
      ) : isNativePlumberApp() ? null : (
        <TimeClock
          plumbers={plumbers}
          truckId={filterTruckId || undefined}
          plumberIds={
            filterTruckId
              ? trucks.find((truck) => truck.id === filterTruckId)?.plumberIds
              : undefined
          }
        />
      )}

      <div className="plumber-board__toolbar">
        {trucks.length > 1 ? (
          <div className="plumber-board__filters" role="tablist" aria-label="Trucks">
            <button
              type="button"
              className={!filterTruckId ? 'is-on' : ''}
              onClick={() => setFilterTruckId('')}
            >
              All trucks
            </button>
            {trucks.map((truck) => (
              <button
                key={truck.id}
                type="button"
                className={filterTruckId === truck.id ? 'is-on' : ''}
                onClick={() => setFilterTruckId(truck.id)}
              >
                {truck.name}
                {truck.driver ? ` · ${truck.driver}` : ''}
              </button>
            ))}
          </div>
        ) : null}
        <button type="button" onClick={() => void signInMicrosoft()}>
          {signedIn ? 'Microsoft signed in' : 'Sign in for PDFs'}
        </button>
      </div>

      {error ? <div className="plumber-board__error">{error}</div> : null}
      {status ? <div className="plumber-board__status">{status}</div> : null}
      {callHint ? <div className="plumber-board__status">{callHint}</div> : null}
      {pdfError ? <div className="plumber-board__error">{pdfError}</div> : null}

      {!plan ? (
        <p className="plumber-board__empty">Loading today&apos;s schedule…</p>
      ) : visibleTrucks.length === 0 ? (
        <p className="plumber-board__empty">No trucks have stops on this day.</p>
      ) : (
        visibleTrucks.map((truck) => (
          <TruckSchedule
            key={truck.id}
            truck={truck}
            trucks={plan.trucks}
            phones={phones[truck.id] || []}
            plumbers={plumbers}
            byId={byId}
            byNumber={byNumber}
            pdfBusyId={pdfBusyId}
            callBusyKey={callBusyKey}
            editable={editable}
            saving={saving}
            onOpenPdf={openPdf}
            onStartCall={startRecordedCall}
            onAssignPlumber={assignPlumber}
            onUnassignPlumber={unassignPlumber}
            onUpdateStop={updateStop}
            onMoveStop={moveStop}
            onMoveStopToTruck={moveStopToTruck}
          />
        ))
      )}
    </div>
  );
}

function TruckSchedule({
  truck,
  trucks,
  phones,
  plumbers,
  byId,
  byNumber,
  pdfBusyId,
  callBusyKey,
  editable,
  saving,
  onOpenPdf,
  onStartCall,
  onAssignPlumber,
  onUnassignPlumber,
  onUpdateStop,
  onMoveStop,
  onMoveStopToTruck,
}: {
  truck: DispatchTruck;
  trucks: DispatchTruck[];
  phones: TruckPhone[];
  plumbers: Plumber[];
  byId: Map<string, StoredWorkOrder>;
  byNumber: Map<string, StoredWorkOrder>;
  pdfBusyId: string;
  callBusyKey: string;
  editable: boolean;
  saving: boolean;
  onOpenPdf: (stop: DispatchStop) => void;
  onStartCall: (input: {
    truckId: string;
    stopId: string;
    customerPhone: string;
    plumberPhone?: string;
  }) => Promise<void>;
  onAssignPlumber: (truckId: string, plumberId: string) => Promise<void>;
  onUnassignPlumber: (truckId: string, plumberId: string) => Promise<void>;
  onUpdateStop: (
    truckId: string,
    stop: DispatchStop,
    patch: Partial<DispatchStop>,
    workOrderPatch?: Parameters<typeof patchWorkOrderFields>[1]
  ) => Promise<void>;
  onMoveStop: (truckId: string, stopId: string, direction: -1 | 1) => Promise<void>;
  onMoveStopToTruck: (fromTruckId: string, stopId: string, toTruckId: string) => Promise<void>;
}) {
  const active = truck.stops.filter((stop) => !stop.cancelled);
  const cancelled = truck.stops.filter((stop) => stop.cancelled);
  const names = plumberNamesForIds(truck.plumberIds, plumbers);
  return (
    <section className="plumber-truck" aria-label={truck.name}>
      <header className="plumber-truck__header">
        <div>
          <h2>{truck.name}</h2>
          <p>
            {names.join(', ') || truck.driver || 'No plumber assigned'}
            {truck.set ? ' · Set' : ''}
            {active.length ? ` · ${active.length} stop${active.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        {phones.length > 0 ? (
          <div className="plumber-truck__phones">
            {phones.map((entry) => {
              const href = telHref(entry.phone);
              const label = entry.label
                ? `${entry.label} · ${formatTruckPhone(entry.phone)}`
                : formatTruckPhone(entry.phone);
              return href ? (
                <a key={entry.id} href={href}>
                  {label}
                </a>
              ) : (
                <span key={entry.id}>{label}</span>
              );
            })}
          </div>
        ) : null}
        {editable ? (
          <div className="plumber-truck__assign">
            <label>
              Assign plumber
              <select
                value=""
                disabled={saving || plumbers.length === 0}
                onChange={(event) => {
                  const plumberId = event.target.value;
                  if (plumberId) void onAssignPlumber(truck.id, plumberId);
                  event.currentTarget.value = '';
                }}
              >
                <option value="">
                  {plumbers.length === 0 ? 'Add plumbers on Dispatch first' : 'Choose plumber'}
                </option>
                {plumbers.map((plumber) => {
                  const assigned = truckAssignedToPlumber(
                    { date: '', originAddress: '', trucks, unassigned: [], notReady: [] },
                    plumber.id,
                    plumbers
                  );
                  const onThisTruck = assigned?.id === truck.id;
                  return (
                    <option key={plumber.id} value={plumber.id} disabled={onThisTruck}>
                      {plumber.name}
                      {assigned && !onThisTruck ? ` · on ${assigned.name}` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            {(truck.plumberIds || []).length > 0 ? (
              <div className="plumber-truck__chips">
                {(truck.plumberIds || []).map((plumberId) => {
                  const plumber = plumbers.find((item) => item.id === plumberId);
                  return (
                    <button
                      key={plumberId}
                      type="button"
                      disabled={saving}
                      onClick={() => void onUnassignPlumber(truck.id, plumberId)}
                    >
                      {plumber?.name || 'Plumber'} ×
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>
      {active.length === 0 && cancelled.length === 0 ? (
        <p className="plumber-board__empty">No stops on this truck.</p>
      ) : null}
      {active.map((stop, index) => (
        <StopCard
          key={stop.id}
          index={index + 1}
          stop={stop}
          order={orderForStop(stop, byId, byNumber)}
          trucks={trucks}
          truckId={truck.id}
          stopCount={active.length}
          pdfBusy={pdfBusyId === stop.id}
          callBusyKey={callBusyKey}
          truckPhones={phones}
          editable={editable}
          saving={saving}
          onOpenPdf={() => onOpenPdf(stop)}
          onStartCall={onStartCall}
          onUpdateStop={onUpdateStop}
          onMoveStop={onMoveStop}
          onMoveStopToTruck={onMoveStopToTruck}
        />
      ))}
      {cancelled.map((stop, index) => (
        <StopCard
          key={stop.id}
          index={active.length + index + 1}
          stop={stop}
          order={orderForStop(stop, byId, byNumber)}
          trucks={trucks}
          truckId={truck.id}
          stopCount={active.length}
          pdfBusy={pdfBusyId === stop.id}
          callBusyKey={callBusyKey}
          truckPhones={phones}
          editable={editable}
          saving={saving}
          onOpenPdf={() => onOpenPdf(stop)}
          onStartCall={onStartCall}
          onUpdateStop={onUpdateStop}
          onMoveStop={onMoveStop}
          onMoveStopToTruck={onMoveStopToTruck}
        />
      ))}
    </section>
  );
}

function StopCard({
  index,
  stop,
  order,
  trucks,
  truckId,
  stopCount,
  pdfBusy,
  callBusyKey,
  truckPhones,
  editable,
  saving,
  onOpenPdf,
  onStartCall,
  onUpdateStop,
  onMoveStop,
  onMoveStopToTruck,
}: {
  index: number;
  stop: DispatchStop;
  order?: StoredWorkOrder;
  trucks: DispatchTruck[];
  truckId: string;
  stopCount: number;
  pdfBusy: boolean;
  callBusyKey: string;
  truckPhones: TruckPhone[];
  editable: boolean;
  saving: boolean;
  onOpenPdf: () => void;
  onStartCall: (input: {
    truckId: string;
    stopId: string;
    customerPhone: string;
    plumberPhone?: string;
  }) => Promise<void>;
  onUpdateStop: (
    truckId: string,
    stop: DispatchStop,
    patch: Partial<DispatchStop>,
    workOrderPatch?: Parameters<typeof patchWorkOrderFields>[1]
  ) => Promise<void>;
  onMoveStop: (truckId: string, stopId: string, direction: -1 | 1) => Promise<void>;
  onMoveStopToTruck: (fromTruckId: string, stopId: string, toTruckId: string) => Promise<void>;
}) {
  const addressHref = mapsHref(stop.address);
  const status = confirmationLabel(stop);
  const notes = (stop.notes || order?.notes || '').trim();
  const summary = (order?.callSummary || '').trim();
  const install = (stop.installDescription || order?.installDescription || '').trim();
  // Orders typed into Teams while the PDF system was down have a message but no attachment.
  const hasPdf = Boolean(
    order?.teamsTeamId && order.teamsChannelId && order.teamsMessageId && order.teamsAttachmentId
  );
  const phones = customerPhonesOf(stop);
  const plumberPhone = truckPhones[0]?.phone;
  const canRecord = Boolean(plumberPhone) && !stop.cancelled;
  const [draft, setDraft] = useState({
    customerName: stop.customerName,
    phone: formatCustomerPhones(stop) || stop.phone,
    address: stop.address,
    jobType: stop.jobType,
    installDescription: install,
    notes,
  });

  useEffect(() => {
    setDraft({
      customerName: stop.customerName,
      phone: formatCustomerPhones(stop) || stop.phone,
      address: stop.address,
      jobType: stop.jobType,
      installDescription: install,
      notes,
    });
  }, [stop.customerName, stop.phone, stop.phones, stop.address, stop.jobType, install, notes]);

  const commitField = (
    field: keyof typeof draft,
    value: string,
    workOrderKey?: keyof Parameters<typeof patchWorkOrderFields>[1]
  ) => {
    const trimmed = value.trim();
    const current =
      field === 'installDescription'
        ? install
        : field === 'notes'
          ? notes
          : String(stop[field as keyof DispatchStop] || '');
    if (trimmed === current) return;
    if (field === 'phone') {
      const parsed = parseCustomerPhones(value);
      const phone = parsed[0] || trimmed;
      if (phone === (stop.phone || '') && parsed.join() === customerPhonesOf(stop).join()) {
        return;
      }
      void onUpdateStop(
        truckId,
        stop,
        { phone, phones: parsed },
        { phone, phones: parsed }
      );
      return;
    }
    const patch: Partial<DispatchStop> = { [field]: trimmed };
    const workOrderPatch = workOrderKey ? { [workOrderKey]: trimmed } : undefined;
    void onUpdateStop(truckId, stop, patch, workOrderPatch);
  };

  return (
    <article className={`plumber-stop${stop.cancelled ? ' plumber-stop--cancelled' : ''}`}>
      <header>
        <span className="plumber-stop__index">{index}</span>
        <div>
          <strong>{stop.workOrderNumber || 'No WO#'}</strong>
          {editable ? (
            <label className="plumber-stop__window-edit">
              Window
              <select
                disabled={saving || stop.cancelled}
                value={windowKey(stop.window)}
                onChange={(event) => {
                  const [start, end] = event.target.value.split('|');
                  if (start && end) {
                    void onUpdateStop(truckId, stop, {
                      window: { start, end },
                      customWindow: true,
                    });
                  }
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
            </label>
          ) : (
            <p className="plumber-stop__window">{formatWindowLabel(stop.window)}</p>
          )}
        </div>
        {status ? <span className="plumber-stop__chip">{status}</span> : null}
      </header>

      {editable ? (
        <div className="plumber-stop__fields">
          <label>
            Customer
            <input
              value={draft.customerName}
              disabled={saving}
              onChange={(event) => setDraft((current) => ({ ...current, customerName: event.target.value }))}
              onBlur={() => commitField('customerName', draft.customerName, 'customerName')}
            />
          </label>
          <label>
            Phone
            <input
              value={draft.phone}
              disabled={saving}
              placeholder="One or two numbers"
              onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))}
              onBlur={() => commitField('phone', draft.phone, 'phone')}
            />
          </label>
          <label>
            Address
            <input
              value={draft.address}
              disabled={saving}
              onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))}
              onBlur={() => commitField('address', draft.address, 'address')}
            />
          </label>
          <label>
            Job
            <input
              value={draft.jobType}
              disabled={saving}
              onChange={(event) => setDraft((current) => ({ ...current, jobType: event.target.value }))}
              onBlur={() => commitField('jobType', draft.jobType, 'jobType')}
            />
          </label>
          <label>
            Install
            <input
              value={draft.installDescription}
              disabled={saving}
              onChange={(event) =>
                setDraft((current) => ({ ...current, installDescription: event.target.value }))
              }
              onBlur={() =>
                commitField('installDescription', draft.installDescription, 'installDescription')
              }
            />
          </label>
          <label className="plumber-stop__notes">
            Job notes
            <textarea
              rows={4}
              value={draft.notes}
              disabled={saving}
              onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
              onBlur={() => commitField('notes', draft.notes, 'notes')}
            />
          </label>
        </div>
      ) : (
        <dl>
          <div>
            <dt>Customer</dt>
            <dd>{stop.customerName || '—'}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>
              {phones.length > 0 ? (
                phones.map((phone, index) => (
                  <span key={phone} className="plumber-stop__phone">
                    {index > 0 ? ' / ' : ''}
                    {formatCustomerPhone(phone)}
                    {telHref(phone) ? (
                      <a className="plumber-stop__direct" href={telHref(phone) || undefined}>
                        Phone app
                      </a>
                    ) : null}
                  </span>
                ))
              ) : (
                stop.phone || '—'
              )}
            </dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>
              {addressHref ? (
                <a href={addressHref} target="_blank" rel="noreferrer">
                  {stop.address}
                </a>
              ) : (
                stop.address || '—'
              )}
            </dd>
          </div>
          {stop.jobType ? (
            <div>
              <dt>Job</dt>
              <dd>{stop.jobType}</dd>
            </div>
          ) : null}
          {install ? (
            <div>
              <dt>Install</dt>
              <dd>{install}</dd>
            </div>
          ) : null}
        </dl>
      )}

      {summary ? (
        <details>
          <summary>Call notes</summary>
          <pre>{summary}</pre>
        </details>
      ) : null}
      {!editable && notes ? (
        <details>
          <summary>Job notes</summary>
          <pre>{notes}</pre>
        </details>
      ) : null}

      <div className="plumber-stop__actions">
        {canRecord
          ? phones.map((phone) => {
              const busy = callBusyKey === `${stop.id}:${phone}`;
              return (
                <button
                  key={phone}
                  type="button"
                  className="plumber-stop__call"
                  disabled={Boolean(callBusyKey) || saving}
                  onClick={() =>
                    void onStartCall({
                      truckId,
                      stopId: stop.id,
                      customerPhone: phone,
                      plumberPhone,
                    })
                  }
                >
                  {busy ? 'Calling…' : `Call ${formatCustomerPhone(phone)}`}
                </button>
              );
            })
          : phones.map((phone) => {
              const href = telHref(phone);
              return href ? (
                <a key={phone} className="plumber-stop__call" href={href}>
                  Call {formatCustomerPhone(phone)}
                </a>
              ) : null;
            })}
        <button type="button" className="plumber-stop__pdf" disabled={pdfBusy} onClick={onOpenPdf}>
          {pdfBusy ? 'Opening PDF…' : hasPdf ? 'Work order PDF' : 'Find work order PDF'}
        </button>
        <a className="plumber-stop__ticket" href={workOrderHref()}>
          Job ticket
        </a>
        {editable && !stop.cancelled ? (
          <>
            <button
              type="button"
              disabled={saving || index <= 1}
              onClick={() => void onMoveStop(truckId, stop.id, -1)}
            >
              Up
            </button>
            <button
              type="button"
              disabled={saving || index >= stopCount}
              onClick={() => void onMoveStop(truckId, stop.id, 1)}
            >
              Down
            </button>
            <label className="plumber-stop__move">
              Truck
              <select
                value={truckId}
                disabled={saving}
                onChange={(event) => {
                  const nextTruck = event.target.value;
                  if (nextTruck !== truckId) void onMoveStopToTruck(truckId, stop.id, nextTruck);
                }}
              >
                {trucks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
      </div>
    </article>
  );
}
