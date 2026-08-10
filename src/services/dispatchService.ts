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
    sourceFileName: workOrder.sourceFileName,
    priority: 0,
    window: defaultWindowForStopIndex(index),
    customWindow: false,
    morningTextStatus: 'none',
  };
}

export async function listWorkOrdersForDate(date: string): Promise<StoredWorkOrder[]> {
  const snapshot = await getDocs(
    query(collection(db, WORK_ORDERS_COLLECTION), where('appointmentDate', '==', date))
  );

  return snapshot.docs.map((document) => {
    const data = document.data() as WorkOrder & {
      status?: string;
      selectedTime?: string;
    };
    return {
      id: document.id,
      workOrderNumber: data.workOrderNumber || '',
      customerName: data.customerName || '',
      phone: data.phone || '',
      address: data.address || '',
      jobType: data.jobType || '',
      appointmentDate: data.appointmentDate || date,
      appointmentTime: data.appointmentTime || '',
      notes: data.notes || '',
      sourceFileName: data.sourceFileName || '',
      smsConsent: data.smsConsent === true,
      confidence: data.confidence,
      status: (data.status as StoredWorkOrder['status']) || 'unscheduled',
      selectedTime: data.selectedTime,
    };
  });
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

  // Move not-ready → unassigned if notes appear; unassigned → not-ready if notes cleared
  const refreshLane = (stops: DispatchStop[], ready: boolean) =>
    stops.filter((stop) => {
      const live = workOrders.find((order) => order.id === stop.workOrderId);
      if (!live) return true;
      if (live.status === 'closed') return false;
      const hasNotes = workOrderHasNotes(live.notes);
      stop.notes = live.notes || '';
      if (ready && !hasNotes) {
        next.notReady.push({ ...stop, notes: live.notes || '' });
        return false;
      }
      if (!ready && hasNotes) {
        next.unassigned.push({ ...stop, notes: live.notes || '' });
        return false;
      }
      return true;
    });

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
  let cancelled = false;
  let requestId = 0;
  let workOrdersCache: StoredWorkOrder[] | null = null;

  const unsubscribe = onSnapshot(
    planRef,
    (snap) => {
      const currentRequest = ++requestId;
      void (async () => {
        try {
          if (!workOrdersCache) {
            workOrdersCache = await listWorkOrdersForDate(date);
          }
          if (cancelled || currentRequest !== requestId) return;
          const plan = planFromSnapshotData(
            date,
            snap.exists() ? (snap.data() as Record<string, unknown>) : undefined
          );
          onChange(mergeWorkOrdersIntoPlan(plan, workOrdersCache));
        } catch (err) {
          if (cancelled || currentRequest !== requestId) return;
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    },
    (error) => {
      if (!cancelled) onError?.(error);
    }
  );

  return () => {
    cancelled = true;
    unsubscribe();
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
    lat: stop.lat,
    lng: stop.lng,
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
