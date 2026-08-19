import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  deleteDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import type {
  DispatchPlan,
  DispatchStop,
  DispatchTruck,
  StoredWorkOrder,
  WorkOrder,
} from '../types';
import { getSchedule } from './scheduleService';
import { geocodeAddress } from '../utils/geocode';
import { haversineMiles, sortFarthestFirst } from '../utils/distance';
import {
  applyDefaultWindows,
  createEmptyDispatchTrucks,
  DEFAULT_DISPATCH_ORIGIN,
  defaultWindowForStopIndex,
  formatWindowLabel,
} from '../utils/dispatchWindows';

const DISPATCH_COLLECTION = 'dispatchPlans';
const WORK_ORDERS_COLLECTION = 'workOrders';
const MORNING_COLLECTION = 'morningConfirmations';

const DISPATCH_MORNING_HOUR = Number.parseInt(
  import.meta.env.VITE_DISPATCH_MORNING_HOUR || '7',
  10
);

function workOrderHasNotes(notes: string | undefined): boolean {
  return Boolean(notes && notes.trim().length > 0);
}

function toDispatchStop(
  workOrder: Pick<
    StoredWorkOrder,
    | 'id'
    | 'workOrderNumber'
    | 'customerName'
    | 'phone'
    | 'address'
    | 'jobType'
    | 'notes'
    | 'scheduleEvidenceQuote'
    | 'sourceFileName'
  >,
  index = 0
): DispatchStop {
  return {
    id: workOrder.id,
    workOrderId: workOrder.id,
    workOrderNumber: workOrder.workOrderNumber,
    customerName: workOrder.customerName,
    phone: workOrder.phone,
    address: workOrder.address,
    jobType: workOrder.jobType,
    notes: workOrder.notes || '',
    scheduleEvidenceQuote: workOrder.scheduleEvidenceQuote || '',
    sourceFileName: workOrder.sourceFileName,
    priority: 0,
    window: defaultWindowForStopIndex(index),
    customWindow: false,
    morningTextStatus: 'none',
  };
}

type WorkOrderDoc = WorkOrder & {
  status?: string;
  selectedTime?: string;
  callSummary?: string;
  source?: string;
  autoImported?: boolean;
  mock?: boolean;
};

function mapStoredWorkOrder(
  documentId: string,
  data: WorkOrderDoc,
  fallbackDate = ''
): StoredWorkOrder {
  return {
    id: documentId,
    workOrderNumber: data.workOrderNumber || '',
    customerName: data.customerName || '',
    phone: data.phone || '',
    address: data.address || '',
    jobType: data.jobType || '',
    appointmentDate: data.appointmentDate || fallbackDate,
    appointmentTime: data.appointmentTime || '',
    notes: data.notes || '',
    scheduleEvidenceQuote: data.scheduleEvidenceQuote || '',
    sourceFileName: data.sourceFileName || '',
    smsConsent: data.smsConsent === true,
    confidence: data.confidence,
    status: (data.status as StoredWorkOrder['status']) || 'unscheduled',
    selectedTime: data.selectedTime,
    callSummary: data.callSummary || '',
    source: data.source || '',
    autoImported: data.autoImported === true,
    mock: data.mock === true,
    teamsTeamId: data.teamsTeamId,
    teamsChannelId: data.teamsChannelId,
    teamsMessageId: data.teamsMessageId,
    teamsAttachmentId: data.teamsAttachmentId,
  };
}

/** A job belongs on this dispatch day when Sol (or a mock job) stored that date. */
function workOrderBelongsOnDispatchDate(data: WorkOrderDoc, date: string): boolean {
  if (data.status === 'closed') return false;
  return (data.appointmentDate || '').trim() === date;
}

function workOrdersFromSnapshot(
  snapshot: { docs: Array<{ id: string; data: () => unknown }> },
  date: string
): StoredWorkOrder[] {
  const byId = new Map<string, StoredWorkOrder>();
  for (const document of snapshot.docs) {
    const data = document.data() as WorkOrderDoc;
    if (!workOrderBelongsOnDispatchDate(data, date)) continue;
    byId.set(document.id, mapStoredWorkOrder(document.id, data, date));
  }
  return [...byId.values()];
}

export async function listWorkOrdersForDate(date: string): Promise<StoredWorkOrder[]> {
  const snapshot = await getDocs(
    query(collection(db, WORK_ORDERS_COLLECTION), where('appointmentDate', '==', date))
  );
  return workOrdersFromSnapshot(snapshot, date);
}

function collectAssignedIds(plan: DispatchPlan): Set<string> {
  const ids = new Set<string>();
  for (const truck of plan.trucks) {
    for (const stop of truck.stops) ids.add(stop.workOrderId);
  }
  for (const stop of plan.unassigned) ids.add(stop.workOrderId);
  for (const stop of plan.notReady) ids.add(stop.workOrderId);
  return ids;
}

export function mergeWorkOrdersIntoPlan(
  plan: DispatchPlan,
  workOrders: StoredWorkOrder[]
): DispatchPlan {
  const assigned = collectAssignedIds(plan);
  const next: DispatchPlan = {
    ...plan,
    trucks: plan.trucks.map((truck) => ({
      ...truck,
      stops: [...truck.stops],
    })),
    unassigned: [...plan.unassigned],
    notReady: [...plan.notReady],
  };

  const syncStop = (stop: DispatchStop, live: StoredWorkOrder): DispatchStop => ({
    ...stop,
    notes: live.notes || '',
    scheduleEvidenceQuote: live.scheduleEvidenceQuote || '',
  });

  // Drop jobs whose stored appointment date is no longer this day.
  // Move not-ready → unassigned if notes appear; unassigned → not-ready if notes cleared.
  const refreshLane = (stops: DispatchStop[], ready: boolean) =>
    stops.filter((stop) => {
      const live = workOrders.find((order) => order.id === stop.workOrderId);
      if (!live || live.status === 'closed') return false;
      Object.assign(stop, syncStop(stop, live));
      const hasNotes = workOrderHasNotes(live.notes);
      if (ready && !hasNotes) {
        next.notReady.push(syncStop(stop, live));
        return false;
      }
      if (!ready && hasNotes) {
        next.unassigned.push(syncStop(stop, live));
        return false;
      }
      return true;
    });

  next.trucks = next.trucks.map((truck) => ({
    ...truck,
    stops: truck.stops.filter((stop) => {
      const live = workOrders.find((order) => order.id === stop.workOrderId);
      if (!live || live.status === 'closed') return false;
      Object.assign(stop, syncStop(stop, live));
      return true;
    }),
  }));

  next.unassigned = refreshLane(next.unassigned, true);
  next.notReady = refreshLane(next.notReady, false);

  for (const workOrder of workOrders) {
    if (workOrder.status === 'closed') continue;
    if (assigned.has(workOrder.id)) continue;
    const stop = toDispatchStop(workOrder);
    if (workOrderHasNotes(workOrder.notes)) {
      next.unassigned.push(stop);
    } else {
      next.notReady.push(stop);
    }
  }

  return next;
}

export function createEmptyDispatchPlan(date: string): DispatchPlan {
  return {
    date,
    originAddress: DEFAULT_DISPATCH_ORIGIN,
    trucks: createEmptyDispatchTrucks(),
    unassigned: [],
    notReady: [],
  };
}

function planFromSnapshotData(
  date: string,
  data: Record<string, unknown> | undefined
): DispatchPlan {
  if (!data) {
    return createEmptyDispatchPlan(date);
  }

  const plan: DispatchPlan = {
    date,
    originAddress:
      (typeof data.originAddress === 'string' && data.originAddress) ||
      DEFAULT_DISPATCH_ORIGIN,
    trucks: Array.isArray(data.trucks)
      ? (data.trucks as DispatchTruck[])
      : createEmptyDispatchTrucks(),
    unassigned: Array.isArray(data.unassigned)
      ? (data.unassigned as DispatchStop[])
      : [],
    notReady: Array.isArray(data.notReady) ? (data.notReady as DispatchStop[]) : [],
    updatedAt:
      data.updatedAt &&
      typeof data.updatedAt === 'object' &&
      data.updatedAt !== null &&
      'toDate' in data.updatedAt &&
      typeof (data.updatedAt as { toDate?: () => Date }).toDate === 'function'
        ? (data.updatedAt as { toDate: () => Date }).toDate().toISOString()
        : undefined,
  };

  while (plan.trucks.length < 5) {
    const index = plan.trucks.length;
    plan.trucks.push({
      id: `truck${index + 1}`,
      name: `Truck ${index + 1}`,
      set: false,
      stops: [],
    });
  }

  return plan;
}

export async function getDispatchPlan(date: string): Promise<DispatchPlan> {
  const workOrders = await listWorkOrdersForDate(date);
  const planRef = doc(db, DISPATCH_COLLECTION, date);
  const snap = await getDoc(planRef);
  const plan = planFromSnapshotData(
    date,
    snap.exists() ? (snap.data() as Record<string, unknown>) : undefined
  );
  return mergeWorkOrdersIntoPlan(plan, workOrders);
}

const SCHEDULING_REQUESTS_COLLECTION = 'schedulingRequests';

export interface DaySchedulingJob {
  workOrder: StoredWorkOrder;
  dispatchLane: 'truck' | 'unassigned' | 'not_ready' | 'none';
  truckName?: string;
  windowLabel?: string;
  morningTextStatus?: string;
  voiceConfirmationResponse?: string;
  voiceConfirmationDetails?: string;
  scheduleTruckName?: string;
  scheduleTime?: string;
  schedulingStatus?: string;
  availableTimeSlots?: string[];
}

export interface DaySchedulingInfo {
  date: string;
  jobs: DaySchedulingJob[];
  assignedCount: number;
  unassignedCount: number;
  notReadyCount: number;
}

async function loadWorkOrdersByIds(ids: string[]): Promise<StoredWorkOrder[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const loaded: Array<StoredWorkOrder | null> = await Promise.all(
    unique.map(async (id) => {
      const snap = await getDoc(doc(db, WORK_ORDERS_COLLECTION, id));
      if (!snap.exists()) return null;
      return mapStoredWorkOrder(snap.id, snap.data() as WorkOrderDoc);
    })
  );
  return loaded.filter((item): item is StoredWorkOrder => item !== null);
}

export async function findWorkOrderForCall(input: {
  workOrderId?: string;
  workOrderNumber?: string;
}): Promise<StoredWorkOrder | null> {
  const number = (input.workOrderNumber || '').trim();
  if (number) {
    const snapshot = await getDocs(
      query(collection(db, WORK_ORDERS_COLLECTION), where('workOrderNumber', '==', number))
    );
    const matches = snapshot.docs
      .map((document) => mapStoredWorkOrder(document.id, document.data() as WorkOrderDoc))
      .filter((order) => order.status !== 'closed' && order.mock !== true);
    const imported = matches.find((order) => order.autoImported || order.source !== 'plaud_call');
    if (imported) return imported;
    if (matches[0]) return matches[0];
  }
  if (input.workOrderId) {
    const loaded = await loadWorkOrdersByIds([input.workOrderId]);
    if (loaded[0]) return loaded[0];
  }
  return null;
}

export async function getDaySchedulingInfo(
  date: string,
  extraWorkOrderIds: string[] = []
): Promise<DaySchedulingInfo> {
  const [datedOrders, plan, schedule, requestSnap] = await Promise.all([
    listWorkOrdersForDate(date),
    getDispatchPlan(date),
    getSchedule(date),
    getDocs(query(collection(db, SCHEDULING_REQUESTS_COLLECTION), where('date', '==', date))).catch(
      () => ({ docs: [] as { id: string; data: () => Record<string, unknown> }[] })
    ),
  ]);

  const byId = new Map(datedOrders.map((order) => [order.id, order]));
  const missingIds = extraWorkOrderIds.filter((id) => id && !byId.has(id));
  for (const extra of await loadWorkOrdersByIds(missingIds)) {
    byId.set(extra.id, extra);
  }

  const requestsByWorkOrder = new Map<
    string,
    { status?: string; availableTimeSlots?: string[] }
  >();
  for (const document of requestSnap.docs) {
    const data = document.data() as {
      workOrderId?: string;
      status?: string;
      availableTimeSlots?: string[];
    };
    const workOrderId = data.workOrderId || document.id;
    requestsByWorkOrder.set(workOrderId, {
      status: data.status,
      availableTimeSlots: Array.isArray(data.availableTimeSlots)
        ? data.availableTimeSlots
        : [],
    });
  }

  for (const id of byId.keys()) {
    if (requestsByWorkOrder.has(id)) continue;
    const extraRequest = await getDoc(doc(db, SCHEDULING_REQUESTS_COLLECTION, id));
    if (!extraRequest.exists()) continue;
    const data = extraRequest.data() as {
      status?: string;
      availableTimeSlots?: string[];
    };
    requestsByWorkOrder.set(id, {
      status: data.status,
      availableTimeSlots: Array.isArray(data.availableTimeSlots)
        ? data.availableTimeSlots
        : [],
    });
  }

  const jobs: DaySchedulingJob[] = [...byId.values()]
    .sort((left, right) =>
      `${left.appointmentTime}-${left.workOrderNumber}`.localeCompare(
        `${right.appointmentTime}-${right.workOrderNumber}`
      )
    )
    .map((workOrder) => {
      let dispatchLane: DaySchedulingJob['dispatchLane'] = 'none';
      let truckName: string | undefined;
      let matchedStop: DispatchStop | undefined;
      for (const truck of plan.trucks) {
        const stop = truck.stops.find((item) => item.workOrderId === workOrder.id);
        if (stop) {
          dispatchLane = 'truck';
          truckName = truck.name;
          matchedStop = stop;
          break;
        }
      }
      if (!matchedStop) {
        matchedStop = plan.unassigned.find((item) => item.workOrderId === workOrder.id);
        if (matchedStop) dispatchLane = 'unassigned';
      }
      if (!matchedStop) {
        matchedStop = plan.notReady.find((item) => item.workOrderId === workOrder.id);
        if (matchedStop) dispatchLane = 'not_ready';
      }

      let scheduleTruckName: string | undefined;
      let scheduleTime: string | undefined;
      for (const truck of schedule?.trucks || []) {
        const stop = truck.stops.find(
          (item) =>
            item.workOrderNumber === workOrder.workOrderNumber ||
            item.id === workOrder.id
        );
        if (stop) {
          scheduleTruckName = truck.name;
          scheduleTime = stop.time;
          break;
        }
      }

      const request = requestsByWorkOrder.get(workOrder.id);
      return {
        workOrder,
        dispatchLane,
        truckName,
        windowLabel: matchedStop ? formatWindowLabel(matchedStop.window) : undefined,
        morningTextStatus: matchedStop?.morningTextStatus,
        voiceConfirmationResponse: matchedStop?.voiceConfirmationResponse,
        voiceConfirmationDetails: matchedStop?.voiceConfirmationDetails,
        scheduleTruckName,
        scheduleTime,
        schedulingStatus: request?.status,
        availableTimeSlots: request?.availableTimeSlots,
      };
    });

  return {
    date,
    jobs,
    assignedCount: plan.trucks.reduce((count, truck) => count + truck.stops.length, 0),
    unassignedCount: plan.unassigned.length,
    notReadyCount: plan.notReady.length,
  };
}

export interface DispatchDaySummary {
  date: string;
  readyCount: number;
  notReadyCount: number;
  scheduledTruckCount: number;
  scheduledStopCount: number;
}

/** Lightweight day overview for the multi-day dispatch strip. */
export async function getDispatchDaySummary(date: string): Promise<DispatchDaySummary> {
  const plan = await getDispatchPlan(date);
  const scheduledTrucks = plan.trucks.filter((truck) => truck.stops.length > 0);
  return {
    date,
    readyCount: plan.unassigned.length,
    notReadyCount: plan.notReady.length,
    scheduledTruckCount: scheduledTrucks.length,
    scheduledStopCount: scheduledTrucks.reduce(
      (count, truck) => count + truck.stops.length,
      0
    ),
  };
}

/**
 * Live-updates the dispatch plan (including voice call status written by Twilio
 * webhooks) without requiring a manual page reload.
 */
export function subscribeDispatchPlan(
  date: string,
  onChange: (plan: DispatchPlan) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const planRef = doc(db, DISPATCH_COLLECTION, date);
  const workOrdersQuery = query(
    collection(db, WORK_ORDERS_COLLECTION),
    where('appointmentDate', '==', date)
  );
  let cancelled = false;
  let plan: DispatchPlan | null = null;
  let workOrders: StoredWorkOrder[] | null = null;
  let gotPlan = false;
  let gotOrders = false;

  const emit = () => {
    if (cancelled || !gotPlan || !gotOrders || !plan || !workOrders) return;
    onChange(mergeWorkOrdersIntoPlan(plan, workOrders));
  };

  const unsubscribePlan = onSnapshot(
    planRef,
    (snap) => {
      gotPlan = true;
      plan = planFromSnapshotData(
        date,
        snap.exists() ? (snap.data() as Record<string, unknown>) : undefined
      );
      emit();
    },
    (error) => {
      if (!cancelled) onError?.(error);
    }
  );

  const unsubscribeOrders = onSnapshot(
    workOrdersQuery,
    (snapshot) => {
      gotOrders = true;
      workOrders = workOrdersFromSnapshot(snapshot, date);
      emit();
    },
    (error) => {
      if (!cancelled) onError?.(error);
    }
  );

  return () => {
    cancelled = true;
    unsubscribePlan();
    unsubscribeOrders();
  };
}

export async function saveDispatchPlan(plan: DispatchPlan): Promise<void> {
  const planRef = doc(db, DISPATCH_COLLECTION, plan.date);
  await setDoc(
    planRef,
    {
      date: plan.date,
      originAddress: plan.originAddress,
      trucks: plan.trucks,
      unassigned: plan.unassigned,
      notReady: plan.notReady,
      updatedAt: Timestamp.now(),
    },
    { merge: true }
  );
}

async function enrichDistances(plan: DispatchPlan): Promise<DispatchPlan> {
  const origin = await geocodeAddress(plan.originAddress);
  if (!origin) return plan;

  const enrichStop = async (stop: DispatchStop): Promise<DispatchStop> => {
    if (!stop.address) return { ...stop, distanceMiles: null };
    const coords =
      stop.lat != null && stop.lng != null
        ? { lat: stop.lat, lng: stop.lng }
        : await geocodeAddress(stop.address);
    if (!coords) return { ...stop, distanceMiles: null };
    return {
      ...stop,
      lat: coords.lat,
      lng: coords.lng,
      distanceMiles: Math.round(haversineMiles(origin, coords) * 10) / 10,
    };
  };

  return {
    ...plan,
    trucks: await Promise.all(
      plan.trucks.map(async (truck) => ({
        ...truck,
        stops: await Promise.all(truck.stops.map(enrichStop)),
      }))
    ),
    unassigned: await Promise.all(plan.unassigned.map(enrichStop)),
    notReady: await Promise.all(plan.notReady.map(enrichStop)),
  };
}

export async function autoOrderTruckStops(
  plan: DispatchPlan,
  truckId: string
): Promise<DispatchPlan> {
  const withDistances = await enrichDistances(plan);
  return {
    ...withDistances,
    trucks: withDistances.trucks.map((truck) => {
      if (truck.id !== truckId || truck.set) return truck;
      const ordered = applyDefaultWindows(sortFarthestFirst(truck.stops));
      return { ...truck, stops: ordered };
    }),
  };
}

export async function autoOrderAllUnsetTrucks(plan: DispatchPlan): Promise<DispatchPlan> {
  let next = await enrichDistances(plan);
  next = {
    ...next,
    unassigned: sortFarthestFirst(next.unassigned),
    trucks: next.trucks.map((truck) => {
      if (truck.set) return truck;
      return { ...truck, stops: applyDefaultWindows(sortFarthestFirst(truck.stops)) };
    }),
  };
  return next;
}

function stopCoordinates(
  stop: DispatchStop
): { lat: number; lng: number } | null {
  if (stop.lat == null || stop.lng == null) return null;
  return { lat: stop.lat, lng: stop.lng };
}

function truckCentroid(
  stops: DispatchStop[],
  origin: { lat: number; lng: number } | null
): { lat: number; lng: number } | null {
  const points = stops
    .map(stopCoordinates)
    .filter((point): point is { lat: number; lng: number } => Boolean(point));
  if (!points.length) return origin;
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
  };
}

/**
 * Place Ready / Unassigned jobs onto trucks that are not set.
 * Nearby jobs stay together; trucks are load-balanced; each truck is then
 * ordered farthest-from-depot first.
 */
export async function assignUnassignedJobsToTrucks(
  plan: DispatchPlan
): Promise<DispatchPlan> {
  const withDistances = await enrichDistances(plan);
  const trucks = withDistances.trucks.map((truck) => ({
    ...truck,
    stops: [...truck.stops],
  }));
  const openIndexes = trucks
    .map((truck, index) => (truck.set ? -1 : index))
    .filter((index) => index >= 0);
  if (!openIndexes.length) {
    throw new Error('All trucks are set. Reopen a truck first.');
  }
  if (!withDistances.unassigned.length) {
    return withDistances;
  }

  const origin = await geocodeAddress(withDistances.originAddress);
  const jobs = sortFarthestFirst(withDistances.unassigned);
  const alreadyAssigned = openIndexes.reduce(
    (count, index) => count + trucks[index].stops.length,
    0
  );
  const cap = Math.max(
    1,
    Math.ceil((alreadyAssigned + jobs.length) / openIndexes.length)
  );

  for (const job of jobs) {
    const point = stopCoordinates(job);
    let bestIndex = openIndexes[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const index of openIndexes) {
      const truck = trucks[index];
      const centroid = truckCentroid(truck.stops, origin);
      const travel =
        point && centroid ? haversineMiles(point, centroid) : truck.stops.length;
      const overCap = truck.stops.length >= cap ? 1000 : 0;
      const score = travel + overCap + truck.stops.length * 0.05;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    trucks[bestIndex].stops.push(job);
  }

  return {
    ...withDistances,
    unassigned: [],
    trucks: trucks.map((truck) =>
      truck.set
        ? truck
        : { ...truck, stops: applyDefaultWindows(sortFarthestFirst(truck.stops)) }
    ),
  };
}

/** Convert a wall-clock time in America/New_York on YYYY-MM-DD to ISO UTC. */
export function easternWallTimeToIso(
  dateYmd: string,
  hour: number,
  minute = 0
): string {
  const timeZone = 'America/New_York';
  const utcGuess = Date.UTC(
    Number(dateYmd.slice(0, 4)),
    Number(dateYmd.slice(5, 7)) - 1,
    Number(dateYmd.slice(8, 10)),
    hour,
    minute,
    0
  );

  const asLocal = (millis: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(millis));
    const get = (type: string) =>
      parts.find((part) => part.type === type)?.value || '0';
    return Date.UTC(
      Number(get('year')),
      Number(get('month')) - 1,
      Number(get('day')),
      Number(get('hour')) % 24,
      Number(get('minute')),
      Number(get('second'))
    );
  };

  const offset = asLocal(utcGuess) - utcGuess;
  return new Date(utcGuess - offset).toISOString();
}

function morningDocId(date: string, truckId: string, stopId: string): string {
  return `dispatch-${date}-${truckId}-${stopId}`.slice(0, 700);
}

export async function queueMorningTextsForTruck(
  plan: DispatchPlan,
  truck: DispatchTruck
): Promise<DispatchTruck> {
  const confirmationTime = easternWallTimeToIso(
    plan.date,
    Number.isFinite(DISPATCH_MORNING_HOUR) ? DISPATCH_MORNING_HOUR : 7,
    0
  );

  const updatedStops: DispatchStop[] = [];
  for (const stop of truck.stops) {
    const id = morningDocId(plan.date, truck.id, stop.id);
    const ref = doc(db, MORNING_COLLECTION, id);
    await setDoc(ref, {
      phoneNumber: stop.phone,
      customerPhoneNumber: stop.phone,
      customerName: stop.customerName,
      address: stop.address,
      jobType: stop.jobType,
      appointmentTime: formatWindowLabel(stop.window),
      windowStart: stop.window.start,
      windowEnd: stop.window.end,
      confirmationTime,
      status: 'pending',
      testing: true,
      source: 'dispatch',
      dispatchDate: plan.date,
      truckId: truck.id,
      stopId: stop.id,
      workOrderId: stop.workOrderId,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    updatedStops.push({ ...stop, morningTextStatus: 'queued' });
  }

  const updatedTruck: DispatchTruck = {
    ...truck,
    set: true,
    setAt: new Date().toISOString(),
    stops: updatedStops,
  };

  await syncDispatchTruckToSchedule(plan.date, updatedTruck);
  return updatedTruck;
}

async function syncDispatchTruckToSchedule(
  date: string,
  truck: DispatchTruck
): Promise<void> {
  const scheduleRef = doc(db, 'schedules', date);
  const snap = await getDoc(scheduleRef);
  const existingTrucks = snap.exists() && Array.isArray(snap.data().trucks)
    ? snap.data().trucks
    : createEmptyDispatchTrucks().map((item) => ({
        id: item.id,
        name: item.name,
        stops: [],
      }));

  const mappedStops = truck.stops.map((stop) => ({
    id: stop.workOrderId,
    workOrderNumber: stop.workOrderNumber,
    customerName: stop.customerName,
    phone: stop.phone,
    address: stop.address,
    jobType: stop.jobType,
    notes: stop.notes,
    time: stop.window.start,
    ...(stop.lat === undefined ? {} : { lat: stop.lat }),
    ...(stop.lng === undefined ? {} : { lng: stop.lng }),
  }));

  let found = false;
  const trucks = existingTrucks.map(
    (item: { id: string; name?: string; stops?: unknown[] }) => {
      if (item.id !== truck.id) return item;
      found = true;
      return {
        ...item,
        name: truck.name,
        stops: mappedStops,
      };
    }
  );
  if (!found) {
    trucks.push({ id: truck.id, name: truck.name, stops: mappedStops });
  }

  await setDoc(
    scheduleRef,
    {
      date,
      trucks,
      updatedAt: Timestamp.now(),
    },
    { merge: true }
  );
}

export async function cancelMorningTextsForTruck(
  plan: DispatchPlan,
  truck: DispatchTruck
): Promise<DispatchTruck> {
  for (const stop of truck.stops) {
    const id = morningDocId(plan.date, truck.id, stop.id);
    const ref = doc(db, MORNING_COLLECTION, id);
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data().status === 'pending') {
      await deleteDoc(ref);
    }
  }

  return {
    ...truck,
    set: false,
    setAt: undefined,
    stops: truck.stops.map((stop) => ({
      ...stop,
      morningTextStatus: stop.morningTextStatus === 'sent' ? 'sent' : 'none',
    })),
  };
}

/**
 * Removes a job from the dispatch plan and deletes its work order so it is not
 * re-imported on the next board refresh. Pending morning texts for that stop are canceled.
 */
export async function deleteDispatchJob(
  plan: DispatchPlan,
  stopId: string
): Promise<DispatchPlan> {
  let removed: DispatchStop | null = null;
  let truckId: string | null = null;

  if (plan.unassigned.some((stop) => stop.id === stopId)) {
    removed = plan.unassigned.find((stop) => stop.id === stopId) || null;
  } else if (plan.notReady.some((stop) => stop.id === stopId)) {
    removed = plan.notReady.find((stop) => stop.id === stopId) || null;
  } else {
    for (const truck of plan.trucks) {
      const stop = truck.stops.find((item) => item.id === stopId);
      if (stop) {
        removed = stop;
        truckId = truck.id;
        break;
      }
    }
  }

  if (!removed) {
    throw new Error('That job is no longer on the board.');
  }

  if (truckId) {
    const morningRef = doc(db, MORNING_COLLECTION, morningDocId(plan.date, truckId, stopId));
    const morningSnap = await getDoc(morningRef);
    if (morningSnap.exists() && morningSnap.data().status === 'pending') {
      await deleteDoc(morningRef);
    }
  }

  const workOrderRef = doc(db, WORK_ORDERS_COLLECTION, removed.workOrderId || stopId);
  const workOrderSnap = await getDoc(workOrderRef);
  if (workOrderSnap.exists()) {
    await deleteDoc(workOrderRef);
  }

  const next: DispatchPlan = {
    ...plan,
    unassigned: plan.unassigned.filter((stop) => stop.id !== stopId),
    notReady: plan.notReady.filter((stop) => stop.id !== stopId),
    trucks: plan.trucks.map((truck) => {
      if (!truck.stops.some((stop) => stop.id === stopId)) return truck;
      return {
        ...truck,
        stops: applyDefaultWindows(truck.stops.filter((stop) => stop.id !== stopId)),
      };
    }),
  };

  await saveDispatchPlan(next);
  return next;
}

/**
 * Closes a job without deleting it. The stop leaves dispatch while the work
 * order remains in Firestore as operational history.
 */
export async function closeDispatchJob(
  plan: DispatchPlan,
  stopId: string
): Promise<DispatchPlan> {
  const stop =
    plan.unassigned.find((item) => item.id === stopId) ||
    plan.notReady.find((item) => item.id === stopId) ||
    null;

  if (!stop) {
    throw new Error('Only Ready / Unassigned or Not Ready jobs can be closed here.');
  }

  const workOrderRef = doc(db, WORK_ORDERS_COLLECTION, stop.workOrderId || stopId);
  const workOrderSnap = await getDoc(workOrderRef);
  if (workOrderSnap.exists()) {
    await updateDoc(workOrderRef, {
      status: 'closed',
      closedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
  }

  const next: DispatchPlan = {
    ...plan,
    unassigned: plan.unassigned.filter((item) => item.id !== stopId),
    notReady: plan.notReady.filter((item) => item.id !== stopId),
  };
  await saveDispatchPlan(next);
  return next;
}

/** Creates a ready mock job for the selected date so dispatchers can test truck assignment. */
export async function createMockDispatchJob(date: string): Promise<DispatchStop> {
  const stamp = Date.now().toString().slice(-6);
  const workOrderNumber = `TEST-${stamp}`;
  const workOrderId = `${date}-${workOrderNumber}`;
  const stop = toDispatchStop({
    id: workOrderId,
    workOrderNumber,
    customerName: 'Test Customer',
    phone: '+18609643025',
    address: '100 Main Street, Hartford, CT',
    jobType: 'Water heater installation',
    notes: 'Mock dispatch job for testing truck assignment and voice confirmation.',
    sourceFileName: 'mock-test-job',
  });

  await setDoc(
    doc(db, WORK_ORDERS_COLLECTION, workOrderId),
    {
      workOrderNumber,
      customerName: stop.customerName,
      phone: stop.phone,
      address: stop.address,
      jobType: stop.jobType,
      appointmentDate: date,
      appointmentTime: '',
      notes: stop.notes,
      sourceFileName: stop.sourceFileName,
      smsConsent: true,
      status: 'unscheduled',
      mock: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    { merge: true }
  );

  return stop;
}
