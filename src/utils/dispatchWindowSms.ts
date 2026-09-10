import { format, parseISO } from 'date-fns';
import type { DispatchPlan, DispatchStop } from '../types';
import { formatWindowLabel, windowKey, windowsEqual } from './dispatchWindows';

const HEAD_PLUMBER_PHONE = '860-543-9082';

function formatDispatchDate(date: string): string {
  try {
    return format(parseISO(date), 'EEEE, MMM d');
  } catch {
    return date;
  }
}

function firstName(stop: DispatchStop): string {
  return (stop.customerName || 'there').trim().split(/\s+/)[0] || 'there';
}

function jobBit(stop: DispatchStop): string {
  const job = stop.jobType?.trim();
  return job ? ` for your ${job}` : '';
}

export function defaultCustomerWindowSms(stop: DispatchStop, scheduleDate: string): string {
  const window = formatWindowLabel(stop.window);
  const day = formatDispatchDate(scheduleDate);
  return `Hi ${firstName(stop)}, NJ Plumbing is scheduled ${day} between ${window}${jobBit(stop)}. Please reply if you need to reschedule. To reach the head plumber directly, call ${HEAD_PLUMBER_PHONE}.`;
}

export function updatedCustomerWindowSms(stop: DispatchStop, scheduleDate: string): string {
  const window = formatWindowLabel(stop.window);
  const day = formatDispatchDate(scheduleDate);
  return `Hi ${firstName(stop)}, your time frame has been updated. NJ Plumbing is now scheduled ${day} between ${window}${jobBit(stop)}. Please reply if you need to reschedule. To reach the head plumber directly, call ${HEAD_PLUMBER_PHONE}.`;
}

export function stopNeedsUpdatedWindowSms(stop: DispatchStop): boolean {
  const notified = stop.windowSmsNotifiedKey?.trim();
  if (!notified) return false;
  return notified !== windowKey(stop.window);
}

export function customerWindowSms(stop: DispatchStop, scheduleDate: string): string {
  return stopNeedsUpdatedWindowSms(stop)
    ? updatedCustomerWindowSms(stop, scheduleDate)
    : defaultCustomerWindowSms(stop, scheduleDate);
}

export function looksLikeWindowSms(body: string): boolean {
  return /NJ Plumbing is (?:now )?scheduled|your time frame has been updated/i.test(
    body
  );
}

export function phoneHadSentWindowSms(
  phone: string,
  outbox: Array<{ to: string; body: string; status: string }>,
  digitsOf: (value: string) => string
): boolean {
  const digits = digitsOf(phone);
  if (!digits) return false;
  return outbox.some(
    (item) =>
      digitsOf(item.to) === digits &&
      item.status === 'sent' &&
      looksLikeWindowSms(item.body)
  );
}

export function windowSmsWasAlreadySent(
  stop: DispatchStop,
  outbox: Array<{ to: string; body: string; status: string }>,
  digitsOf: (value: string) => string
): boolean {
  return (
    stop.morningTextStatus === 'sent' ||
    Boolean(stop.windowSmsNotifiedKey?.trim()) ||
    phoneHadSentWindowSms(stop.phone, outbox, digitsOf)
  );
}

export function markUpdatedWindowSmsForRemainingStops(
  previousStops: DispatchStop[],
  nextStops: DispatchStop[],
  wasSent: (stop: DispatchStop) => boolean
): DispatchStop[] {
  const previousById = new Map(previousStops.map((stop) => [stop.id, stop]));
  return nextStops.map((stop) => {
    const previous = previousById.get(stop.id);
    if (!previous) return stop;
    if (windowsEqual(previous.window, stop.window)) return stop;
    if (!wasSent(previous) && !wasSent(stop)) return stop;
    return {
      ...stop,
      windowSmsNotifiedKey:
        stop.windowSmsNotifiedKey ||
        previous.windowSmsNotifiedKey ||
        windowKey(previous.window),
    };
  });
}

export function applyUpdatedWindowSmsDefaultsToPlan(
  previous: DispatchPlan,
  next: DispatchPlan,
  wasSent: (stop: DispatchStop) => boolean
): DispatchPlan {
  return {
    ...next,
    trucks: next.trucks.map((truck) => {
      const previousTruck = previous.trucks.find((item) => item.id === truck.id);
      if (!previousTruck) return truck;
      return {
        ...truck,
        stops: markUpdatedWindowSmsForRemainingStops(
          previousTruck.stops,
          truck.stops,
          wasSent
        ),
      };
    }),
  };
}

export function windowSmsDefaultSignature(plan: DispatchPlan): string {
  return plan.trucks
    .flatMap((truck) =>
      truck.stops.map((stop) => `${stop.id}:${stop.windowSmsNotifiedKey || ''}`)
    )
    .join('|');
}
