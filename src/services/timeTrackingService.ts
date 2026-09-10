import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import type { TimeClockOutSource, TimeGpsPoint, TimeShift } from '../types';
import { haversineMiles } from '../utils/distance';
import { DEFAULT_DISPATCH_ORIGIN_COORDS } from '../utils/dispatchWindows';

export const TIME_SHIFTS_COLLECTION = 'timeShifts';

const PING_MIN_INTERVAL_MS = 90_000;
const PING_MIN_MOVE_MILES = 0.12;
const lastPingWrite = new Map<string, { at: number; lat: number; lng: number }>();

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  const stamp = value as { toDate?: () => Date };
  if (typeof stamp.toDate === 'function') return stamp.toDate().toISOString();
  return undefined;
}

function asGps(value: unknown): TimeGpsPoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const lat = Number(record.lat);
  const lng = Number(record.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  const accuracy = Number(record.accuracy);
  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? accuracy : undefined,
    at: asIso(record.at),
  };
}

export function easternDateFromIso(iso: string, now = new Date()): string {
  const date = iso ? new Date(iso) : now;
  if (Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function todayEasternDate(): string {
  return easternDateFromIso(new Date().toISOString());
}

export function formatShiftClock(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function shiftHours(shift: TimeShift, now = Date.now()): number {
  const start = Date.parse(shift.clockInAt);
  if (!Number.isFinite(start)) return 0;
  const end = shift.clockOutAt ? Date.parse(shift.clockOutAt) : now;
  if (!Number.isFinite(end) || end <= start) return 0;
  return Math.round(((end - start) / 3_600_000) * 10) / 10;
}

export function mapsPinHref(point?: TimeGpsPoint): string | null {
  if (!point) return null;
  return `https://maps.google.com/?q=${point.lat},${point.lng}`;
}

function mapShift(id: string, data: Record<string, unknown>): TimeShift | null {
  const plumberId = asText(data.plumberId);
  const plumberName = asText(data.plumberName);
  const date = asText(data.date);
  const clockInAt = asIso(data.clockInAt);
  if (!plumberId || !plumberName || !date || !clockInAt) return null;
  const status = asText(data.status) === 'closed' ? 'closed' : 'open';
  const shift: TimeShift = {
    id,
    plumberId,
    plumberName,
    date,
    status,
    clockInAt,
  };
  const truckId = asText(data.truckId);
  if (truckId) shift.truckId = truckId;
  const clockOutAt = asIso(data.clockOutAt);
  if (clockOutAt) shift.clockOutAt = clockOutAt;
  const source = asText(data.clockOutSource) as TimeClockOutSource;
  if (
    source === 'manual' ||
    source === 'auto-shop' ||
    source === 'auto-stale' ||
    source === 'office'
  ) {
    shift.clockOutSource = source;
  }
  const clockIn = asGps(data.clockIn);
  if (clockIn) shift.clockIn = clockIn;
  const clockOut = asGps(data.clockOut);
  if (clockOut) shift.clockOut = clockOut;
  const lastPingAt = asIso(data.lastPingAt);
  if (lastPingAt) shift.lastPingAt = lastPingAt;
  const lastPing = asGps(data.lastPing);
  if (lastPing) shift.lastPing = lastPing;
  if (data.leftShop === true) shift.leftShop = true;
  const shopArrivedAt = asIso(data.shopArrivedAt);
  if (shopArrivedAt) shift.shopArrivedAt = shopArrivedAt;
  const deviceId = asText(data.deviceId);
  if (deviceId) shift.deviceId = deviceId;
  return shift;
}

export function subscribeShiftsForDate(
  date: string,
  onChange: (shifts: TimeShift[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const shiftsQuery = query(
    collection(db, TIME_SHIFTS_COLLECTION),
    where('date', '==', date),
    orderBy('clockInAt', 'asc')
  );
  return onSnapshot(
    shiftsQuery,
    (snap) => {
      const shifts: TimeShift[] = [];
      for (const item of snap.docs) {
        const mapped = mapShift(item.id, item.data() as Record<string, unknown>);
        if (mapped) shifts.push(mapped);
      }
      onChange(shifts);
    },
    (error) => onError?.(error)
  );
}

export function subscribeOpenShiftForPlumber(
  plumberId: string,
  onChange: (shift: TimeShift | null) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const openQuery = query(
    collection(db, TIME_SHIFTS_COLLECTION),
    where('plumberId', '==', plumberId),
    where('status', '==', 'open')
  );
  return onSnapshot(
    openQuery,
    (snap) => {
      const shifts: TimeShift[] = [];
      for (const item of snap.docs) {
        const mapped = mapShift(item.id, item.data() as Record<string, unknown>);
        if (mapped) shifts.push(mapped);
      }
      shifts.sort((a, b) => a.clockInAt.localeCompare(b.clockInAt));
      onChange(shifts[shifts.length - 1] || null);
    },
    (error) => onError?.(error)
  );
}

export function subscribeOpenShifts(
  onChange: (shifts: TimeShift[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const openQuery = query(
    collection(db, TIME_SHIFTS_COLLECTION),
    where('status', '==', 'open')
  );
  return onSnapshot(
    openQuery,
    (snap) => {
      const shifts: TimeShift[] = [];
      for (const item of snap.docs) {
        const mapped = mapShift(item.id, item.data() as Record<string, unknown>);
        if (mapped) shifts.push(mapped);
      }
      shifts.sort((a, b) => a.plumberName.localeCompare(b.plumberName, undefined, { sensitivity: 'base' }));
      onChange(shifts);
    },
    (error) => onError?.(error)
  );
}

export async function clockInShift(input: {
  plumberId: string;
  plumberName: string;
  truckId?: string;
  deviceId: string;
  gps: TimeGpsPoint;
}): Promise<string> {
  const now = new Date();
  const clockIn: TimeGpsPoint = {
    lat: input.gps.lat,
    lng: input.gps.lng,
    accuracy: input.gps.accuracy,
    at: now.toISOString(),
  };
  const atShop =
    haversineMiles(clockIn, DEFAULT_DISPATCH_ORIGIN_COORDS) <= 0.25;
  const ref = await addDoc(collection(db, TIME_SHIFTS_COLLECTION), {
    plumberId: input.plumberId,
    plumberName: input.plumberName,
    truckId: input.truckId || '',
    date: todayEasternDate(),
    status: 'open',
    clockInAt: Timestamp.fromDate(now),
    clockIn,
    lastPingAt: Timestamp.fromDate(now),
    lastPing: clockIn,
    leftShop: !atShop,
    deviceId: input.deviceId,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function clockOutShift(
  shiftId: string,
  source: TimeClockOutSource,
  gps?: TimeGpsPoint
): Promise<void> {
  const now = new Date();
  const patch: Record<string, unknown> = {
    status: 'closed',
    clockOutAt: Timestamp.fromDate(now),
    clockOutSource: source,
  };
  if (gps) {
    patch.clockOut = {
      lat: gps.lat,
      lng: gps.lng,
      accuracy: gps.accuracy,
      at: now.toISOString(),
    };
    patch.lastPing = patch.clockOut;
    patch.lastPingAt = Timestamp.fromDate(now);
  }
  await updateDoc(doc(db, TIME_SHIFTS_COLLECTION, shiftId), patch);
}

export async function recordShiftPing(
  shiftId: string,
  gps: TimeGpsPoint,
  source: 'web' | 'ios' = 'web'
): Promise<void> {
  const now = Date.now();
  const previous = lastPingWrite.get(shiftId);
  const moved = previous
    ? haversineMiles(previous, { lat: gps.lat, lng: gps.lng })
    : Infinity;
  if (previous && now - previous.at < PING_MIN_INTERVAL_MS && moved < PING_MIN_MOVE_MILES) {
    return;
  }
  lastPingWrite.set(shiftId, { at: now, lat: gps.lat, lng: gps.lng });
  const at = gps.at ? new Date(gps.at) : new Date();
  const point = {
    lat: gps.lat,
    lng: gps.lng,
    accuracy: gps.accuracy ?? null,
    at: Timestamp.fromDate(Number.isNaN(at.getTime()) ? new Date() : at),
    source,
  };
  const shiftRef = doc(db, TIME_SHIFTS_COLLECTION, shiftId);
  await Promise.all([
    updateDoc(shiftRef, {
      lastPingAt: point.at,
      lastPing: { lat: point.lat, lng: point.lng, accuracy: point.accuracy },
    }),
    addDoc(collection(shiftRef, 'pings'), point),
  ]);
}

export function watchBrowserLocation(
  onPoint: (gps: TimeGpsPoint) => void,
  onError?: (error: Error) => void
): () => void {
  if (!navigator.geolocation) {
    onError?.(new Error('This phone cannot share location.'));
    return () => undefined;
  }
  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      onPoint({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: new Date(pos.timestamp).toISOString(),
      });
    },
    (err) => onError?.(new Error(err.message || 'Location permission denied.')),
    { enableHighAccuracy: true, maximumAge: 30_000, timeout: 25_000 }
  );
  return () => navigator.geolocation.clearWatch(watchId);
}

export function readBrowserLocation(): Promise<TimeGpsPoint> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This phone cannot share location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          at: new Date(pos.timestamp).toISOString(),
        });
      },
      (err) => reject(new Error(err.message || 'Allow location to clock in.')),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 15_000 }
    );
  });
}
