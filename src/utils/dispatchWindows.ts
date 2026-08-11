import type { ArrivalWindow } from '../types';

/**
 * Default 4-hour windows by stop order on a truck:
 * 1st 8–12, 2nd 10–2, 3rd 12–4, then +2h start each stop (capped).
 */
export function defaultWindowForStopIndex(index: number): ArrivalWindow {
  const startHour = Math.min(8 + index * 2, 15);
  const endHour = Math.min(startHour + 4, 19);
  return {
    start: `${String(startHour).padStart(2, '0')}:00`,
    end: `${String(endHour).padStart(2, '0')}:00`,
  };
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

export const DISPATCH_TRUCK_COUNT = 5;

export const DEFAULT_DISPATCH_ORIGIN =
  import.meta.env.VITE_DISPATCH_ORIGIN_ADDRESS?.trim() ||
  '216 Christian Lane, Berlin, CT';

export function createEmptyDispatchTrucks() {
  return Array.from({ length: DISPATCH_TRUCK_COUNT }, (_, index) => ({
    id: `truck${index + 1}`,
    name: `Truck ${index + 1}`,
    set: false,
    stops: [],
  }));
}
