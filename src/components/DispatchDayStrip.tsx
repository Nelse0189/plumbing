import { useEffect, useMemo, useState } from 'react';
import {
  getDispatchDaySummary,
  type DispatchDaySummary,
} from '../services/dispatchService';
import './DispatchDayStrip.css';

export function addDaysToIsoDate(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + offset));
  return next.toISOString().slice(0, 10);
}

export function formatDispatchDay(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T00:00:00Z`));
}

export function weekAroundDate(selectedDate: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDaysToIsoDate(selectedDate, index - 2));
}

export default function DispatchDayStrip({
  selectedDate,
  onSelectDate,
  refreshKey = 0,
  label = 'Dispatch day overview',
}: {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  refreshKey?: number;
  label?: string;
}) {
  const dates = useMemo(() => weekAroundDate(selectedDate), [selectedDate]);
  const [summaries, setSummaries] = useState<DispatchDaySummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(dates.map(getDispatchDaySummary)).then((next) => {
      if (!cancelled) setSummaries(next);
    });
    return () => {
      cancelled = true;
    };
  }, [dates, refreshKey]);

  return (
    <section className="dispatch-days" aria-label={label}>
      {dates.map((date) => {
        const summary = summaries.find((item) => item.date === date);
        return (
          <button
            key={date}
            type="button"
            className={`dispatch-days__day${
              date === selectedDate ? ' dispatch-days__day--selected' : ''
            }`}
            onClick={() => onSelectDate(date)}
          >
            <strong>{formatDispatchDay(date)}</strong>
            <span>{summary ? `${summary.readyCount} ready` : 'Loading…'}</span>
            <span>
              {summary
                ? `${summary.scheduledTruckCount} truck${
                    summary.scheduledTruckCount === 1 ? '' : 's'
                  } · ${summary.scheduledStopCount} stops`
                : ' '}
            </span>
            {summary?.notReadyCount ? (
              <small>{summary.notReadyCount} not ready</small>
            ) : null}
          </button>
        );
      })}
    </section>
  );
}
