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
import { notesDuplicateAnotherWorkOrder } from '../utils/duplicateWorkOrder';
import { customerPhonesOf, parseCustomerPhones } from '../utils/customerPhones';
import { getSchedule } from './scheduleService';
import { geocodeAddress } from '../utils/geocode';
import { haversineMiles, sortFarthestFirst } from '../utils/distance';
import {
  applyDefaultWindows,
  createEmptyDispatchTrucks,
  DEFAULT_DISPATCH_ORIGIN,
  defaultWindowForStopIndex,
  formatWindowLabel,
  windowsEqual,
} from '../utils/dispatchWindows';
import {
  applyPlumberAssignmentsToPlan,
  loadPlumbers,
  mapPlumbers,
  PLUMBERS_DOC,
} from './plumberService';

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

/** Manual and mock jobs are ready even without Teams/PDF notes. */
function workOrderIsReadyForDispatch(workOrder: {
  notes?: string;
  source?: string;
  mock?: boolean;
}): boolean {
  if (workOrder.mock || workOrder.source === 'manual') return true;
  return workOrderHasNotes(workOrder.notes);
}

function toDispatchStop(
  workOrder: Pick<
    StoredWorkOrder,
    | 'id'
    | 'workOrderNumber'
    | 'customerName'
    | 'phone'
    | 'phones'
    | 'address'
    | 'jobType'
    | 'notes'
    | 'scheduleEvidenceQuote'
    | 'sourceFileName'
    | 'installDescription'
  >,
  index = 0
): DispatchStop {
  return {
    id: workOrder.id,
    workOrderId: workOrder.id,
    workOrderNumber: workOrder.workOrderNumber,
    customerName: workOrder.customerName,
    phone: workOrder.phone,
    phones: customerPhonesOf(workOrder),
    address: workOrder.address,
    jobType: workOrder.jobType,
    notes: workOrder.notes || '',
    scheduleEvidenceQuote: workOrder.scheduleEvidenceQuote || '',
    sourceFileName: workOrder.sourceFileName,
    installDescription: workOrder.installDescription || '',
    priority: 0,
    window: defaultWindowForStopIndex(index),
    customWindow: false,
    morningTextStatus: 'none',
  };
}

type WorkOrderDoc = WorkOrder & {
  status?: string;
  manualSchedule?: boolean;
  selectedTime?: string;
  callSummary?: string;
  source?: string;
  autoImported?: boolean;
  mock?: boolean;
  permitPulled?: boolean;
  permitPulledAt?: string;
  retailerUploaded?: boolean;
  retailerUploadedAt?: string;
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
    phones: parseCustomerPhones(data.phones, data.phone),
    address: data.address || '',
    jobType: data.jobType || '',
    appointmentDate: data.appointmentDate || fallbackDate,
    appointmentTime: data.appointmentTime || '',
    notes: data.notes || '',
    scheduleEvidenceQuote: data.scheduleEvidenceQuote || '',
    sourceFileName: data.sourceFileName || '',
    installDescription: data.installDescription || '',
    pdfServiceDate: data.pdfServiceDate || '',
    duplicateOfWorkOrderNumber: data.duplicateOfWorkOrderNumber || '',
    smsConsent: data.smsConsent === true,
    confidence: data.confidence,
    status: (data.status as StoredWorkOrder['status']) || 'unscheduled',
    manualSchedule: data.manualSchedule === true,
    selectedTime: data.selectedTime,
    callSummary: data.callSummary || '',
    source: data.source || '',
    autoImported: data.autoImported === true,
    mock: data.mock === true,
    permitPulled: data.permitPulled === true,
    permitPulledAt: data.permitPulledAt || undefined,
    retailerUploaded: data.retailerUploaded === true,
    retailerUploadedAt: data.retailerUploadedAt || undefined,
    teamsTeamId: data.teamsTeamId,
    teamsChannelId: data.teamsChannelId,
    teamsMessageId: data.teamsMessageId,
    teamsAttachmentId: data.teamsAttachmentId,
  };
}

function workOrderIsDuplicate(data: {
  duplicateOfWorkOrderNumber?: string;
  workOrderNumber?: string;
  notes?: string;
}): boolean {
  if ((data.duplicateOfWorkOrderNumber || '').trim()) return true;
  return notesDuplicateAnotherWorkOrder(data.notes || '', data.workOrderNumber || '');
}

/** A job belongs on this dispatch day when Sol (or a mock job) stored that date. */
function workOrderBelongsOnDispatchDate(data: WorkOrderDoc, date: string): boolean {
  if (data.status === 'closed') return false;
  // A hand-scheduled job always dispatches, even when the notes read like a
  // duplicate order; staff explicitly asked for it on the board.
  if (data.manualSchedule !== true && workOrderIsDuplicate(data)) return false;
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

export function workOrderKey(stop: Pick<DispatchStop, 'id' | 'workOrderId'>): string {
  return (stop.workOrderId || stop.id).trim();
}

function collectAssignedIds(plan: DispatchPlan): Set<string> {
  const ids = new Set<string>();
  for (const truck of plan.trucks) {
    for (const stop of truck.stops) ids.add(workOrderKey(stop));
  }
  for (const stop of plan.unassigned) ids.add(workOrderKey(stop));
  for (const stop of plan.notReady) ids.add(workOrderKey(stop));
  return ids;
}

/** Trucks that already have this work order as an active stop. */
export function trucksCarryingWorkOrder(
  plan: DispatchPlan,
  workOrderId: string
): DispatchTruck[] {
  const key = workOrderId.trim();
  if (!key) return [];
  return plan.trucks.filter((truck) =>
    truck.stops.some((stop) => workOrderKey(stop) === key && !stop.cancelled)
  );
}

function workOrderHasOtherStops(plan: DispatchPlan, stop: DispatchStop): boolean {
  return listWorkOrderStops(plan, workOrderKey(stop)).some((item) => item.stop.id !== stop.id);
}

function listWorkOrderStops(
  plan: DispatchPlan,
  workOrderId: string
): Array<{ stop: DispatchStop; truckId: string | null }> {
  const key = workOrderId.trim();
  const hits: Array<{ stop: DispatchStop; truckId: string | null }> = [];
  for (const truck of plan.trucks) {
    for (const stop of truck.stops) {
      if (workOrderKey(stop) === key) hits.push({ stop, truckId: truck.id });
    }
  }
  for (const stop of plan.unassigned) {
    if (workOrderKey(stop) === key) hits.push({ stop, truckId: null });
  }
  for (const stop of plan.notReady) {
    if (workOrderKey(stop) === key) hits.push({ stop, truckId: null });
  }
  return hits;
}

export function planWithoutStop(plan: DispatchPlan, stopId: string): DispatchPlan {
  return {
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
}

function newDispatchCopyStopId(workOrderId: string): string {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `${workOrderId}__copy-${stamp}`.slice(0, 140);
}

/** Same job, new stop id — used when two trucks go to one work order. */
export function cloneDispatchStopForCopy(stop: DispatchStop): DispatchStop {
  const workOrderId = workOrderKey(stop);
  const copy: DispatchStop = {
    ...stop,
    id: newDispatchCopyStopId(workOrderId),
    workOrderId,
    copiedFromStopId: stop.id,
    cancelled: false,
    customWindow: true,
    morningTextStatus: 'none',
  };
  delete copy.movedToDate;
  delete copy.windowSmsNotifiedKey;
  delete copy.voiceCallStatus;
  delete copy.voiceConfirmationResponse;
  delete copy.voiceConfirmationDetails;
  delete copy.voiceConfirmationAt;
  delete copy.voiceWantsHumanCallback;
  delete copy.voiceHumanCallbackDetails;
  delete copy.voiceConfirmationId;
  delete copy.voiceConversationId;
  return copy;
}

/**
 * Puts the same work order on another truck without taking it off the first.
 * Windows stay as they are so both crews can share the customer arrival time.
 */
export function duplicateDispatchStopToTruck(
  plan: DispatchPlan,
  stopId: string,
  targetTruckId: string
): DispatchPlan {
  const found = findStopOnPlan(plan, stopId);
  if (!found) {
    throw new Error('That job is no longer on the board.');
  }
  if (found.stop.cancelled) {
    throw new Error('Restore the job before copying it to another truck.');
  }
  const target = plan.trucks.find((truck) => truck.id === targetTruckId);
  if (!target) {
    throw new Error('That truck is not on this day’s board.');
  }
  if (target.set) {
    throw new Error(`Reopen ${target.name} before adding a copy.`);
  }
  const key = workOrderKey(found.stop);
  if (target.stops.some((stop) => workOrderKey(stop) === key)) {
    throw new Error(`That job is already on ${target.name}.`);
  }
  const copy = cloneDispatchStopForCopy(found.stop);
  return {
    ...plan,
    trucks: plan.trucks.map((truck) => {
      if (truck.id !== targetTruckId) return truck;
      return { ...truck, stops: applyDefaultWindows([...truck.stops, copy]) };
    }),
  };
}

/**
 * Work orders referenced by the saved plan that are no longer in this day's
 * query, keyed by work-order id. `null` means the document was deleted.
 */
export type OffDayWorkOrders = ReadonlyMap<string, StoredWorkOrder | null>;

function syncStopWithLiveOrder(stop: DispatchStop, live: StoredWorkOrder): DispatchStop {
  const phones = customerPhonesOf(live);
  return {
    ...stop,
    notes: live.notes || '',
    scheduleEvidenceQuote: live.scheduleEvidenceQuote || '',
    phone: phones[0] || live.phone || stop.phone,
    phones,
  };
}

/**
 * When a saved stop's work order moved to another day, return the stop marked
 * cancelled with `movedToDate` so the board shows where it went instead of
 * silently dropping it. Returns null when the stop should simply be dropped
 * (deleted, closed, duplicate, or a same-day sibling copy).
 */
function movedStopFor(
  stop: DispatchStop,
  date: string,
  offDayOrders?: OffDayWorkOrders
): DispatchStop | null {
  const order = offDayOrders?.get(stop.workOrderId);
  if (!order) return null;
  if (order.status === 'closed') return null;
  if (order.manualSchedule !== true && workOrderIsDuplicate(order)) return null;
  const movedToDate = (order.appointmentDate || '').trim();
  if (movedToDate === date) return null;
  return {
    ...syncStopWithLiveOrder(stop, order),
    cancelled: true,
    movedToDate,
    morningTextStatus:
      stop.morningTextStatus === 'queued' ? 'none' : stop.morningTextStatus ?? 'none',
  };
}

/** Saved truck stops whose work order has moved off this day (still need persisting). */
export function findMovedTruckStops(
  plan: DispatchPlan,
  workOrders: StoredWorkOrder[],
  offDayOrders: OffDayWorkOrders
): Array<{ truckId: string; stop: DispatchStop }> {
  const liveIds = new Set(workOrders.map((order) => order.id));
  const moved: Array<{ truckId: string; stop: DispatchStop }> = [];
  for (const truck of plan.trucks) {
    for (const stop of truck.stops) {
      if (liveIds.has(stop.workOrderId)) continue;
      const patched = movedStopFor(stop, plan.date, offDayOrders);
      if (patched) moved.push({ truckId: truck.id, stop: patched });
    }
  }
  return moved;
}

export function mergeWorkOrdersIntoPlan(
  plan: DispatchPlan,
  workOrders: StoredWorkOrder[],
  offDayOrders?: OffDayWorkOrders
): DispatchPlan {
  const uniqueOrders: StoredWorkOrder[] = [];
  const seenNumbers = new Map<string, number>();
  for (const order of workOrders) {
    const number = order.workOrderNumber.trim();
    if (!number) {
      uniqueOrders.push(order);
      continue;
    }
    const existingIndex = seenNumbers.get(number);
    if (existingIndex === undefined) {
      seenNumbers.set(number, uniqueOrders.length);
      uniqueOrders.push(order);
      continue;
    }
    const current = uniqueOrders[existingIndex];
    const preferNew =
      Boolean(order.scheduleEvidenceQuote?.trim()) &&
      !current.scheduleEvidenceQuote?.trim()
        ? true
        : Boolean(current.scheduleEvidenceQuote?.trim()) &&
            !order.scheduleEvidenceQuote?.trim()
          ? false
          : (order.notes || '').length > (current.notes || '').length;
    if (preferNew) uniqueOrders[existingIndex] = order;
  }
  workOrders = uniqueOrders.filter(
    (order) => order.manualSchedule === true || !workOrderIsDuplicate(order)
  );
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

  const syncStop = syncStopWithLiveOrder;
  const listedInLanes = (stopId: string) =>
    next.unassigned.some((item) => item.id === stopId) ||
    next.notReady.some((item) => item.id === stopId);

  // Jobs whose stored appointment date is no longer this day are shown as
  // cancelled with the new date (or dropped when closed/deleted/duplicate).
  // Move not-ready → unassigned if notes appear; unassigned → not-ready if notes cleared.
  const refreshLane = (stops: DispatchStop[], ready: boolean) =>
    stops.filter((stop) => {
      const live = workOrders.find((order) => order.id === stop.workOrderId);
      if (!live) {
        const moved = movedStopFor(stop, plan.date, offDayOrders);
        if (!moved) return false;
        if (ready) {
          Object.assign(stop, moved);
          return true;
        }
        if (!listedInLanes(stop.id)) next.unassigned.push(moved);
        return false;
      }
      if (live.status === 'closed' || workOrderIsDuplicate(live)) return false;
      Object.assign(stop, syncStop(stop, live));
      if (stop.movedToDate !== undefined) {
        // The job came back to this day; clear the moved marker.
        delete stop.movedToDate;
        stop.cancelled = false;
      }
      const hasNotes = workOrderIsReadyForDispatch(live);
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

  next.trucks = next.trucks.map((truck) => {
    const kept: DispatchStop[] = [];
    for (const stop of truck.stops) {
      const live = workOrders.find((order) => order.id === stop.workOrderId);
      if (!live) {
        const moved = movedStopFor(stop, plan.date, offDayOrders);
        if (moved && !listedInLanes(stop.id)) next.unassigned.push(moved);
        continue;
      }
      if (live.status === 'closed' || workOrderIsDuplicate(live)) continue;
      Object.assign(stop, syncStop(stop, live));
      if (stop.cancelled) {
        if (!listedInLanes(stop.id)) next.unassigned.push({ ...stop });
        continue;
      }
      kept.push(stop);
    }
    return {
      ...truck,
      stops: kept.length === truck.stops.length ? kept : applyDefaultWindows(kept),
    };
  });

  next.unassigned = refreshLane(next.unassigned, true);
  next.notReady = refreshLane(next.notReady, false);

  for (const workOrder of workOrders) {
    if (workOrder.status === 'closed') continue;
    if (assigned.has(workOrder.id)) continue;
    const stop = toDispatchStop(workOrder);
    if (workOrderIsReadyForDispatch(workOrder)) {
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
      ? (data.trucks as DispatchTruck[]).map((truck) => ({
          ...truck,
          plumberIds: Array.isArray(truck.plumberIds)
            ? truck.plumberIds.filter(
                (id): id is string => typeof id === 'string' && id.trim().length > 0
              )
            : [],
        }))
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

  const defaults = createEmptyDispatchTrucks();
  const byId = new Map(plan.trucks.map((truck) => [truck.id, truck]));
  plan.trucks = [
    ...defaults.map((slot) => byId.get(slot.id) ?? slot),
    ...plan.trucks.filter((truck) => !defaults.some((slot) => slot.id === truck.id)),
  ];

  return plan;
}

export async function getDispatchPlan(date: string): Promise<DispatchPlan> {
  const planRef = doc(db, DISPATCH_COLLECTION, date);
  const [workOrders, snap, plumbers] = await Promise.all([
    listWorkOrdersForDate(date),
    getDoc(planRef),
    loadPlumbers(),
  ]);
  const plan = planFromSnapshotData(
    date,
    snap.exists() ? (snap.data() as Record<string, unknown>) : undefined
  );
  return applyPlumberAssignmentsToPlan(mergeWorkOrdersIntoPlan(plan, workOrders), plumbers);
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
  let plumbers = mapPlumbers(undefined);
  let gotPlan = false;
  let gotOrders = false;
  // Work orders the saved plan references that fell out of this day's query
  // (date moved, closed, deleted). Watched individually so a moved job shows
  // as "Moved to <date>" instead of vanishing.
  const offDayOrders = new Map<string, StoredWorkOrder | null>();
  const offDaySubscriptions = new Map<string, Unsubscribe>();
  const persistedMoves = new Set<string>();
  let persisting = false;

  const watchOffDayOrders = () => {
    if (!plan || !workOrders) return;
    const liveIds = new Set(workOrders.map((order) => order.id));
    const wanted = new Set<string>();
    for (const id of collectAssignedIds(plan)) {
      if (id && !liveIds.has(id)) wanted.add(id);
    }
    for (const [id, unsubscribe] of offDaySubscriptions) {
      if (wanted.has(id)) continue;
      unsubscribe();
      offDaySubscriptions.delete(id);
      offDayOrders.delete(id);
    }
    for (const id of wanted) {
      if (offDaySubscriptions.has(id)) continue;
      const unsubscribe = onSnapshot(
        doc(db, WORK_ORDERS_COLLECTION, id),
        (snap) => {
          offDayOrders.set(
            id,
            snap.exists() ? mapStoredWorkOrder(snap.id, snap.data() as WorkOrderDoc) : null
          );
          emit();
        },
        (error) => {
          if (!cancelled) onError?.(error);
        }
      );
      offDaySubscriptions.set(id, unsubscribe);
    }
  };

  // A moved job still sitting on a saved truck would be texted the old-day
  // morning confirmation by the server; take it off the truck in Firestore.
  const persistMovedTruckStops = () => {
    if (persisting || !plan || !workOrders) return;
    const moved = findMovedTruckStops(plan, workOrders, offDayOrders).filter(
      ({ stop }) => !persistedMoves.has(`${stop.id}|${stop.movedToDate}`)
    );
    if (moved.length === 0) return;
    persisting = true;
    const basePlan = plan;
    for (const { stop } of moved) persistedMoves.add(`${stop.id}|${stop.movedToDate}`);
    void (async () => {
      try {
        const movedIds = new Set(moved.map(({ stop }) => stop.id));
        const previousTrucks = basePlan.trucks;
        const nextPlan: DispatchPlan = {
          ...basePlan,
          trucks: basePlan.trucks.map((truck) => {
            const kept = truck.stops.filter((stop) => !movedIds.has(stop.id));
            return kept.length === truck.stops.length
              ? truck
              : { ...truck, stops: applyDefaultWindows(kept) };
          }),
          unassigned: [
            ...basePlan.unassigned.filter((stop) => !movedIds.has(stop.id)),
            ...moved.map(({ stop }) => stop),
          ],
          notReady: basePlan.notReady.filter((stop) => !movedIds.has(stop.id)),
        };
        await saveDispatchPlan(nextPlan);
        for (const { truckId, stop } of moved) {
          await cancelPendingMorningText(basePlan.date, truckId, stop.id);
        }
        for (const truck of nextPlan.trucks) {
          const previous = previousTrucks.find((item) => item.id === truck.id);
          if (!previous || previous === truck) continue;
          await refreshPendingMorningWindowsForTruck(basePlan.date, previous, truck);
          await syncDispatchTruckToSchedule(basePlan.date, truck);
        }
      } catch (error) {
        for (const { stop } of moved) persistedMoves.delete(`${stop.id}|${stop.movedToDate}`);
        if (!cancelled) onError?.(error as Error);
      } finally {
        persisting = false;
      }
    })();
  };

  const emit = () => {
    if (cancelled || !gotPlan || !gotOrders || !plan || !workOrders) return;
    watchOffDayOrders();
    persistMovedTruckStops();
    onChange(
      applyPlumberAssignmentsToPlan(
        mergeWorkOrdersIntoPlan(plan, workOrders, offDayOrders),
        plumbers
      )
    );
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

  const unsubscribePlumbers = onSnapshot(
    PLUMBERS_DOC,
    (snap) => {
      plumbers = mapPlumbers(snap.data()?.people);
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
    unsubscribePlumbers();
    for (const unsubscribe of offDaySubscriptions.values()) unsubscribe();
    offDaySubscriptions.clear();
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
  const jobs = sortFarthestFirst(
    withDistances.unassigned.filter((stop) => !stop.cancelled)
  );
  const cancelledJobs = withDistances.unassigned.filter((stop) => stop.cancelled);
  if (!jobs.length) {
    return {
      ...withDistances,
      unassigned: cancelledJobs,
    };
  }
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
    unassigned: cancelledJobs,
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

export async function cancelPendingMorningText(
  date: string,
  truckId: string,
  stopId: string
): Promise<void> {
  const morningRef = doc(db, MORNING_COLLECTION, morningDocId(date, truckId, stopId));
  const morningSnap = await getDoc(morningRef);
  if (morningSnap.exists() && morningSnap.data().status === 'pending') {
    await deleteDoc(morningRef);
  }
}

export async function updatePendingMorningTextWindow(
  date: string,
  truckId: string,
  stop: DispatchStop
): Promise<void> {
  const morningRef = doc(db, MORNING_COLLECTION, morningDocId(date, truckId, stop.id));
  const morningSnap = await getDoc(morningRef);
  if (!morningSnap.exists() || morningSnap.data().status !== 'pending') return;
  await updateDoc(morningRef, {
    appointmentTime: formatWindowLabel(stop.window),
    windowStart: stop.window.start,
    windowEnd: stop.window.end,
    updatedAt: Timestamp.now(),
  });
}

export async function refreshPendingMorningWindowsForTruck(
  date: string,
  previous: DispatchTruck | undefined,
  next: DispatchTruck
): Promise<void> {
  if (!previous) return;
  const previousById = new Map(previous.stops.map((stop) => [stop.id, stop]));
  for (const stop of next.stops) {
    const before = previousById.get(stop.id);
    if (!before || windowsEqual(before.window, stop.window)) continue;
    await updatePendingMorningTextWindow(date, next.id, stop);
  }
}

export async function refreshPendingMorningWindowsForPlan(
  previous: DispatchPlan,
  next: DispatchPlan
): Promise<void> {
  await Promise.all(
    next.trucks.map((truck) =>
      refreshPendingMorningWindowsForTruck(
        next.date,
        previous.trucks.find((item) => item.id === truck.id),
        truck
      )
    )
  );
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
    if (stop.cancelled) {
      updatedStops.push(stop);
      continue;
    }
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

export async function syncDispatchTruckToSchedule(
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

  const mappedStops = truck.stops
    .filter((stop) => !stop.cancelled)
    .map((stop) => ({
    id: stop.workOrderId,
    workOrderNumber: stop.workOrderNumber,
    customerName: stop.customerName,
    phone: stop.phone,
    phones: stop.phones || [],
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
        driver: truck.driver,
        plumberIds: truck.plumberIds || [],
        stops: mappedStops,
      };
    }
  );
  if (!found) {
    trucks.push({
      id: truck.id,
      name: truck.name,
      driver: truck.driver,
      plumberIds: truck.plumberIds || [],
      stops: mappedStops,
    });
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

async function persistRemovedStop(
  plan: DispatchPlan,
  stopId: string,
  truckId: string | null
): Promise<DispatchPlan> {
  if (truckId) {
    await cancelPendingMorningText(plan.date, truckId, stopId);
  }
  const next = planWithoutStop(plan, stopId);
  await saveDispatchPlan(next);
  if (truckId) {
    const previousTruck = plan.trucks.find((item) => item.id === truckId);
    const truck = next.trucks.find((item) => item.id === truckId);
    if (truck) {
      await refreshPendingMorningWindowsForTruck(plan.date, previousTruck, truck);
      await syncDispatchTruckToSchedule(plan.date, truck);
    }
  }
  return next;
}

/**
 * Removes a job from the dispatch plan and deletes its work order so it is not
 * re-imported on the next board refresh. Pending morning texts for that stop are canceled.
 * If the same work order is still on another truck, only this stop is removed.
 */
export async function deleteDispatchJob(
  plan: DispatchPlan,
  stopId: string
): Promise<DispatchPlan> {
  const found = findStopOnPlan(plan, stopId);
  if (!found) {
    throw new Error('That job is no longer on the board.');
  }

  if (!workOrderHasOtherStops(plan, found.stop)) {
    const workOrderRef = doc(db, WORK_ORDERS_COLLECTION, found.stop.workOrderId || stopId);
    const workOrderSnap = await getDoc(workOrderRef);
    if (workOrderSnap.exists()) {
      await deleteDoc(workOrderRef);
    }
  }

  return persistRemovedStop(plan, stopId, found.truckId);
}

/**
 * Closes a job without deleting it. The stop leaves dispatch while the work
 * order remains in Firestore as operational history.
 */
export async function closeDispatchJob(
  plan: DispatchPlan,
  stopId: string
): Promise<DispatchPlan> {
  const found = findStopOnPlan(plan, stopId);
  if (!found) {
    throw new Error('That job is no longer on the board.');
  }

  if (!workOrderHasOtherStops(plan, found.stop)) {
    const workOrderRef = doc(db, WORK_ORDERS_COLLECTION, found.stop.workOrderId || stopId);
    const workOrderSnap = await getDoc(workOrderRef);
    if (workOrderSnap.exists()) {
      await updateDoc(workOrderRef, {
        status: 'closed',
        closedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
    }
  }

  return persistRemovedStop(plan, stopId, found.truckId);
}

export function mapStopOnPlan(
  plan: DispatchPlan,
  stopId: string,
  updater: (stop: DispatchStop) => DispatchStop
): DispatchPlan {
  return {
    ...plan,
    unassigned: plan.unassigned.map((stop) => (stop.id === stopId ? updater(stop) : stop)),
    notReady: plan.notReady.map((stop) => (stop.id === stopId ? updater(stop) : stop)),
    trucks: plan.trucks.map((truck) => ({
      ...truck,
      stops: truck.stops.map((stop) => (stop.id === stopId ? updater(stop) : stop)),
    })),
  };
}

function findStopOnPlan(
  plan: DispatchPlan,
  stopId: string
): { stop: DispatchStop; truckId: string | null } | null {
  const unassigned = plan.unassigned.find((item) => item.id === stopId);
  if (unassigned) return { stop: unassigned, truckId: null };
  const notReady = plan.notReady.find((item) => item.id === stopId);
  if (notReady) return { stop: notReady, truckId: null };
  for (const truck of plan.trucks) {
    const stop = truck.stops.find((item) => item.id === stopId);
    if (stop) return { stop, truckId: truck.id };
  }
  return null;
}

/**
 * Marks a job cancelled. If it was on a truck, it is moved to Ready /
 * Unassigned and pending morning texts for that stop are dropped.
 */
export async function setDispatchJobCancelled(
  plan: DispatchPlan,
  stopId: string,
  cancelled: boolean
): Promise<DispatchPlan> {
  const found = findStopOnPlan(plan, stopId);
  if (!found) {
    throw new Error('That job is no longer on the board.');
  }

  const patched: DispatchStop = {
    ...found.stop,
    cancelled,
    morningTextStatus:
      cancelled && found.stop.morningTextStatus === 'queued'
        ? 'none'
        : found.stop.morningTextStatus,
  };

  if (cancelled && workOrderHasOtherStops(plan, found.stop)) {
    return persistRemovedStop(plan, stopId, found.truckId);
  }

  if (cancelled && found.truckId) {
    await cancelPendingMorningText(plan.date, found.truckId, stopId);
    const next: DispatchPlan = {
      ...plan,
      trucks: plan.trucks.map((truck) => {
        if (truck.id !== found.truckId) return truck;
        return {
          ...truck,
          stops: applyDefaultWindows(truck.stops.filter((stop) => stop.id !== stopId)),
        };
      }),
      unassigned: [...plan.unassigned.filter((stop) => stop.id !== stopId), patched],
      notReady: plan.notReady.filter((stop) => stop.id !== stopId),
    };
    await saveDispatchPlan(next);
    const previousTruck = plan.trucks.find((item) => item.id === found.truckId);
    const truck = next.trucks.find((item) => item.id === found.truckId);
    if (truck) {
      await refreshPendingMorningWindowsForTruck(plan.date, previousTruck, truck);
      await syncDispatchTruckToSchedule(plan.date, truck);
    }
    return next;
  }

  const next = mapStopOnPlan(plan, stopId, () => patched);
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
      phones: stop.phones || ['+18609643025'],
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

export type ManualDispatchJobInput = {
  workOrderNumber: string;
  customerName: string;
  phone: string;
  address: string;
  jobType: string;
  appointmentDate: string;
  appointmentTime: string;
  notes: string;
  smsConsent: boolean;
};

function normalizeDispatchPhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed;
}

export function validateManualDispatchJob(input: ManualDispatchJobInput): string | null {
  const missing: string[] = [];
  if (!input.customerName.trim()) missing.push('customer name');
  if (!input.phone.trim()) missing.push('phone');
  if (!input.address.trim()) missing.push('address');
  if (!input.jobType.trim()) missing.push('job type');
  if (!input.appointmentDate.trim()) missing.push('appointment date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.appointmentDate.trim())) {
    return 'Appointment date must use YYYY-MM-DD.';
  }
  if (input.appointmentTime && !/^\d{2}:\d{2}(?::\d{2})?$/.test(input.appointmentTime.trim())) {
    return 'Appointment time must use HH:MM (24-hour).';
  }
  if (missing.length > 0) {
    return `Missing: ${missing.join(', ')}.`;
  }
  return null;
}

/** Creates a dispatcher-entered work order and returns the dispatch stop. */
export async function createManualDispatchJob(
  input: ManualDispatchJobInput
): Promise<DispatchStop> {
  const error = validateManualDispatchJob(input);
  if (error) throw new Error(error);

  const appointmentDate = input.appointmentDate.trim();
  const stamp = Date.now().toString().slice(-4);
  const workOrderNumber =
    input.workOrderNumber.trim() ||
    `MAN-${appointmentDate.replace(/-/g, '')}-${stamp}`;
  const safe = workOrderNumber.replace(/[^a-zA-Z0-9_-]/g, '-');
  const workOrderId = `manual-${appointmentDate}-${safe}`.slice(0, 120);
  const phones = parseCustomerPhones(input.phone);
  const phone = phones[0] || normalizeDispatchPhone(input.phone);
  const notes = input.notes.trim();
  const stop = toDispatchStop({
    id: workOrderId,
    workOrderNumber,
    customerName: input.customerName.trim(),
    phone,
    phones,
    address: input.address.trim(),
    jobType: input.jobType.trim(),
    notes,
    sourceFileName: 'manual-dispatch',
  });

  await setDoc(
    doc(db, WORK_ORDERS_COLLECTION, workOrderId),
    {
      workOrderNumber,
      customerName: stop.customerName,
      phone: stop.phone,
      phones: stop.phones || phones,
      address: stop.address,
      jobType: stop.jobType,
      appointmentDate,
      appointmentTime: input.appointmentTime.trim().slice(0, 5),
      notes,
      sourceFileName: 'manual-dispatch',
      smsConsent: input.smsConsent,
      smsConsentMethod: input.smsConsent ? 'verbal_dispatch_entry' : 'not_provided',
      source: 'manual',
      status: 'unscheduled',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    { merge: true }
  );

  return stop;
}
