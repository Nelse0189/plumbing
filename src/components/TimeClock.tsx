import { useEffect, useMemo, useState } from 'react';
import type { Plumber, TimeShift } from '../types';
import {
  clockInShift,
  clockOutShift,
  formatShiftClock,
  readBrowserLocation,
  recordShiftPing,
  shiftHours,
  subscribeOpenShiftForPlumber,
  watchBrowserLocation,
} from '../services/timeTrackingService';
import {
  getOrCreateDeviceId,
  getSavedPlumberId,
  savePlumberId,
} from '../utils/plumberIdentity';
import {
  isPlumberNativeApp,
  nativeRequestAlwaysLocation,
  nativeStartTracking,
  nativeStopTracking,
} from '../utils/nativePlumber';
import { plumberNamesForIds } from '../services/plumberService';
import './TimeClock.css';

export default function TimeClock({
  plumbers,
  truckId,
  plumberIds,
}: {
  plumbers: Plumber[];
  truckId?: string;
  plumberIds?: string[];
}) {
  const [plumberId, setPlumberId] = useState(getSavedPlumberId);
  const [shift, setShift] = useState<TimeShift | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const native = isPlumberNativeApp();

  const suggested = useMemo(() => {
    if (!plumberIds?.length || !plumbers.length) return [];
    return plumberIds.filter((id) => plumbers.some((person) => person.id === id));
  }, [plumberIds, plumbers]);

  useEffect(() => {
    if (plumberId || suggested.length !== 1) return;
    setPlumberId(suggested[0]);
    savePlumberId(suggested[0]);
  }, [plumberId, suggested]);

  useEffect(() => {
    if (!plumberId) {
      setShift(null);
      return;
    }
    return subscribeOpenShiftForPlumber(plumberId, setShift, (err) => setError(err.message));
  }, [plumberId]);

  useEffect(() => {
    if (!shift) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [shift]);

  useEffect(() => {
    if (!shift || native) return;
    return watchBrowserLocation((gps) => {
      void recordShiftPing(shift.id, gps, 'web').catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }, (err) => setError(err.message));
  }, [shift, native]);

  useEffect(() => {
    if (!shift || !native) return;
    nativeStartTracking({
      plumberId: shift.plumberId,
      shiftId: shift.id,
      deviceId: getOrCreateDeviceId(),
    });
  }, [shift, native]);

  const plumber = plumbers.find((person) => person.id === plumberId);
  const hours = shift ? shiftHours(shift, now) : 0;

  const handleSelect = (id: string) => {
    setPlumberId(id);
    savePlumberId(id);
    setError('');
  };

  const handleClockIn = async () => {
    if (!plumber) {
      setError('Pick your name first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      nativeRequestAlwaysLocation();
      const gps = await readBrowserLocation();
      const shiftId = await clockInShift({
        plumberId: plumber.id,
        plumberName: plumber.name,
        truckId,
        deviceId: getOrCreateDeviceId(),
        gps,
      });
      nativeStartTracking({
        plumberId: plumber.id,
        shiftId,
        deviceId: getOrCreateDeviceId(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClockOut = async () => {
    if (!shift) return;
    setBusy(true);
    setError('');
    try {
      let gps;
      try {
        gps = await readBrowserLocation();
      } catch {
        gps = shift.lastPing;
      }
      await clockOutShift(shift.id, 'manual', gps);
      nativeStopTracking();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="time-clock" aria-label="Time clock">
      <div className="time-clock__row">
        <label>
          Who are you
          <select
            value={plumberId}
            onChange={(event) => handleSelect(event.target.value)}
          >
            <option value="">Select your name</option>
            {plumbers.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        {shift ? (
          <button type="button" disabled={busy} onClick={() => void handleClockOut()}>
            {busy ? 'Saving…' : 'Clock out'}
          </button>
        ) : (
          <button
            type="button"
            className="time-clock__in"
            disabled={busy || !plumber}
            onClick={() => void handleClockIn()}
          >
            {busy ? 'Starting…' : 'Clock in'}
          </button>
        )}
      </div>
      {shift ? (
        <p className="time-clock__status">
          On the clock since {formatShiftClock(shift.clockInAt)} · {hours} hr
          {shift.lastPingAt
            ? ` · GPS ${formatShiftClock(shift.lastPingAt)}`
            : ''}
        </p>
      ) : plumber ? (
        <p className="time-clock__status">Not clocked in.</p>
      ) : (
        <p className="time-clock__status">Select your name, then clock in.</p>
      )}
      <p className="time-clock__hint">
        {native
          ? 'Location keeps running after you lock the phone. If you forget to clock out, the shop close happens when you get back to 216 Christian Lane.'
          : 'Clock in here for hours. For GPS after you lock the phone, use the NJ Plumber iPhone app.'}
      </p>
      {plumberIds?.length && plumber && !plumberIds.includes(plumber.id) ? (
        <p className="time-clock__hint">
          This truck is listed as {plumberNamesForIds(plumberIds, plumbers).join(', ') || 'unassigned'}.
        </p>
      ) : null}
      {error ? <p className="time-clock__error">{error}</p> : null}
    </section>
  );
}
