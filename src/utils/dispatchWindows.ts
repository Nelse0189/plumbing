import type { ArrivalWindow } from '../types';

/** Standard arrival windows offered on the dispatch board. */
export const DISPATCH_TIME_SLOTS: ArrivalWindow[] = [
  { start: '10:00', end: '12:00' },
  { start: '11:30', end: '15:30' },
  { start: '13:00', end: '17:00' },
  { start: '14:00', end: '18:00' },
  { start: '15:00', end: '19:00' },
];

export function windowKey(window: ArrivalWindow): string {
  return `${window.start}|${window.end}`;
}

export function windowsEqual(a: ArrivalWindow, b: ArrivalWindow): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * Default windows by stop order on a truck:
 * 1st 10–12, 2nd 11:30–3:30, 3rd 1–5, 4th 2–6, 5th 3–7, then wrap.
 */
export function defaultWindowForStopIndex(index: number): ArrivalWindow {
  return DISPATCH_TIME_SLOTS[index % DISPATCH_TIME_SLOTS.length];
}

export function applyDefaultWindows<T extends { customWindow: boolean; window: ArrivalWindow }>(
  stops: T[]
): T[] {
  return stops.map((stop, index) =>
    stop.customWindow
      ? stop
      : { ...stop, window: defaultWindowForStopIndex(index) }
  );
}

export function formatWindowLabel(window: ArrivalWindow): string {
  return `${formatClock(window.start)}–${formatClock(window.end)}`;
}

function formatClock(hhmm: string): string {
  const [hourText, minuteText = '00'] = hhmm.split(':');
  const hour = Number.parseInt(hourText, 10);
  if (Number.isNaN(hour)) return hhmm;
  const meridiem = hour >= 12 ? 'PM' : 'AM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minuteText === '00' ? `${twelve} ${meridiem}` : `${twelve}:${minuteText} ${meridiem}`;
}

export const DISPATCH_TRUCK_COUNT = 7;

export const DEFAULT_DISPATCH_ORIGIN =
  import.meta.env.VITE_DISPATCH_ORIGIN_ADDRESS?.trim() ||
  '216 Christian Lane, Berlin, CT';

/** 216 Christian Lane, Berlin, CT — used when live geocoding is blocked. */
export const DEFAULT_DISPATCH_ORIGIN_COORDS = {
  lat: 41.63711,
  lng: -72.75087,
};

export function createEmptyDispatchTrucks() {
  return Array.from({ length: DISPATCH_TRUCK_COUNT }, (_, index) => ({
    id: `truck${index + 1}`,
    name: `Truck ${index + 1}`,
    plumberIds: [] as string[],
    set: false,
    stops: [],
  }));
}
