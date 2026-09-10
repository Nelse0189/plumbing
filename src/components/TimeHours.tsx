import { useEffect, useMemo, useState } from 'react';
import type { TimeShift } from '../types';
import {
  clockOutShift,
  formatShiftClock,
  mapsPinHref,
  shiftHours,
  subscribeOpenShifts,
  subscribeShiftsForDate,
} from '../services/timeTrackingService';
import './TimeClock.css';

function sourceLabel(shift: TimeShift): string {
  if (shift.status === 'open') return 'Still on the clock';
  if (shift.clockOutSource === 'auto-shop') return 'Closed at shop (GPS)';
  if (shift.clockOutSource === 'auto-stale') return 'Closed from last GPS';
  if (shift.clockOutSource === 'office') return 'Closed by shop';
  return 'Clocked out';
}

export default function TimeHours({ selectedDate }: { selectedDate: string }) {
  const [dayShifts, setDayShifts] = useState<TimeShift[]>([]);
  const [openShifts, setOpenShifts] = useState<TimeShift[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    return subscribeShiftsForDate(selectedDate, setDayShifts, (err) => setError(err.message));
  }, [selectedDate]);

  useEffect(() => {
    return subscribeOpenShifts(setOpenShifts, (err) => setError(err.message));
  }, []);

  const rows = useMemo(() => {
    const byId = new Map<string, TimeShift>();
    for (const shift of dayShifts) byId.set(shift.id, shift);
    for (const shift of openShifts) {
      if (shift.date !== selectedDate) byId.set(shift.id, shift);
    }
    return [...byId.values()].sort((a, b) =>
      a.plumberName.localeCompare(b.plumberName, undefined, { sensitivity: 'base' })
    );
  }, [dayShifts, openShifts, selectedDate]);

  const handleClose = async (shift: TimeShift) => {
    setBusyId(shift.id);
    setError('');
    try {
      await clockOutShift(shift.id, 'office', shift.lastPing);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="time-hours" aria-label="Crew hours">
      <h2>Crew hours</h2>
      <p className="time-hours__lede">
        Clock-in from the plumber phone. If they forget to clock out, GPS at the
        shop or a stale last ping closes the day.
      </p>
      {error ? <p className="time-clock__error">{error}</p> : null}
      {rows.length === 0 ? (
        <p className="time-hours__empty">No one has clocked in on this day.</p>
      ) : (
        rows.map((shift) => {
          const pin = mapsPinHref(shift.lastPing);
          const hours = shiftHours(shift);
          return (
            <article key={shift.id} className="time-hours__row">
              <div className="time-hours__name">
                <strong>{shift.plumberName}</strong>
                <span className="time-hours__hrs">{hours} hr</span>
              </div>
              <p className={`time-hours__meta${shift.status === 'open' ? ' time-hours__open' : ''}`}>
                {formatShiftClock(shift.clockInAt)}
                {shift.clockOutAt ? ` – ${formatShiftClock(shift.clockOutAt)}` : ' – now'}
                {' · '}
                {sourceLabel(shift)}
                {shift.lastPingAt ? ` · last GPS ${formatShiftClock(shift.lastPingAt)}` : ''}
              </p>
              <div className="time-hours__actions">
                {pin ? (
                  <a href={pin} target="_blank" rel="noreferrer">
                    Last location
                  </a>
                ) : null}
                {shift.status === 'open' ? (
                  <button
                    type="button"
                    disabled={busyId === shift.id}
                    onClick={() => void handleClose(shift)}
                  >
                    {busyId === shift.id ? 'Closing…' : 'Clock out'}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}
