import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import ScheduleForm from './components/ScheduleForm';
import MapView from './components/MapView';
import DispatchBoard from './components/DispatchBoard';
import CallIntake from './components/CallIntake';
import type { Truck, Schedule } from './types';
import { getTrucksForDate, saveSchedule } from './services/scheduleService';
import { takePlaudConnectTokenFromLocation } from './plaudConnect';
import { formatPlaudCallableError, hasPlaudOAuthCallbackParams, isPlaudOAuthCallbackPath, peekPlaudOAuthPending, claimPlaudOAuthFinish, clearPlaudOAuthPending } from './plaudOAuth';
import { finishPlaudOAuth } from './services/plaudService';
import './App.css';

function consumePlaudQuery(): { connected: boolean; error: string } {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('plaud') === 'connected';
  const error = params.get('plaudError') || '';
  if (connected || error) {
    params.delete('plaud');
    params.delete('plaudError');
    const search = params.toString();
    history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}`
    );
  }
  return { connected, error };
}

const plaudQuery = consumePlaudQuery();

function App() {
  const [selectedDate, setSelectedDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [viewMode, setViewMode] = useState<'dispatch' | 'schedule' | 'map' | 'calls'>(
    () =>
      takePlaudConnectTokenFromLocation() || plaudQuery.connected || plaudQuery.error
        ? 'calls'
        : 'dispatch'
  );
  const [plaudOAuthStatus, setPlaudOAuthStatus] = useState<'idle' | 'working' | 'done' | 'error'>(
    () =>
      isPlaudOAuthCallbackPath() || hasPlaudOAuthCallbackParams() ? 'working' : 'idle'
  );
  const [plaudOAuthError, setPlaudOAuthError] = useState(plaudQuery.error);
  const [trucks, setTrucks] = useState<Truck[]>([
    { id: 'truck1', name: 'Truck 1', stops: [] },
    { id: 'truck2', name: 'Truck 2', stops: [] },
    { id: 'truck3', name: 'Truck 3', stops: [] },
    { id: 'truck4', name: 'Truck 4', stops: [] },
    { id: 'truck5', name: 'Truck 5', stops: [] },
  ]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isPlaudOAuthCallbackPath() && !hasPlaudOAuthCallbackParams()) return;
    if (!claimPlaudOAuthFinish()) return;
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error_description') || params.get('error') || '';
    const code = params.get('code') || '';
    const state = params.get('state') || '';
    if (error) {
      setPlaudOAuthStatus('error');
      setPlaudOAuthError(error);
      setViewMode('calls');
      history.replaceState(null, '', '/');
      return;
    }
    void (async () => {
      try {
        const pending = peekPlaudOAuthPending();
        if (pending && pending.state !== state) {
          throw new Error('Plaud sign-in did not match this page. Click Sign in with Plaud again.');
        }
        if (!pending?.verifier) {
          throw new Error('This Plaud sign-in expired. Click Sign in with Plaud again from this same tab.');
        }
        await finishPlaudOAuth({
          code,
          state,
          verifier: pending.verifier,
          redirectUri: pending.redirectUri,
        });
        clearPlaudOAuthPending();
        window.location.replace('/?plaud=connected');
      } catch (err) {
        setPlaudOAuthStatus('error');
        setPlaudOAuthError(formatPlaudCallableError(err));
        setViewMode('calls');
        history.replaceState(null, '', '/');
      }
    })();
  }, []);

  useEffect(() => {
    const loadSchedule = async () => {
      setLoading(true);
      try {
        const loadedTrucks = await getTrucksForDate(selectedDate);
        setTrucks(loadedTrucks);
      } catch (error) {
        console.error('Failed to load schedule:', error);
        setTrucks([
          { id: 'truck1', name: 'Truck 1', stops: [] },
          { id: 'truck2', name: 'Truck 2', stops: [] },
          { id: 'truck3', name: 'Truck 3', stops: [] },
          { id: 'truck4', name: 'Truck 4', stops: [] },
          { id: 'truck5', name: 'Truck 5', stops: [] },
        ]);
      } finally {
        setLoading(false);
      }
    };

    loadSchedule();
  }, [selectedDate]);

  const handleSaveSchedule = async (updatedTrucks: Truck[]) => {
    setTrucks(updatedTrucks);
    const schedule: Schedule = {
      date: selectedDate,
      trucks: updatedTrucks,
    };
    try {
      await saveSchedule(schedule);
    } catch (error) {
      console.error('Failed to save schedule:', error);
      alert('Failed to save schedule. Please try again.');
    }
  };

  return (
    <div className="app">
      <header style={{
        padding: '1.5rem 2rem',
        borderBottom: '1px solid var(--border)',
        backgroundColor: 'var(--bg-secondary)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '1rem',
      }}>
        <h1 style={{ color: 'var(--accent)', fontSize: '1.5rem', fontWeight: '600' }}>
          NJ Plumbing Scheduling
        </h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            style={{ padding: '0.5rem' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => setViewMode('dispatch')}
              style={{
                backgroundColor: viewMode === 'dispatch' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'dispatch' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'dispatch' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Dispatch
            </button>
            <button
              onClick={() => setViewMode('schedule')}
              style={{
                backgroundColor: viewMode === 'schedule' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'schedule' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'schedule' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Schedule
            </button>
            <button
              onClick={() => setViewMode('map')}
              style={{
                backgroundColor: viewMode === 'map' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'map' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'map' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Map View
            </button>
            <button
              onClick={() => setViewMode('calls')}
              style={{
                backgroundColor: viewMode === 'calls' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'calls' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'calls' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Calls
            </button>
            <a
              href="/teams-test"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.5rem 1rem',
                backgroundColor: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                textDecoration: 'none',
                font: 'inherit',
              }}
            >
              Teams Channels
            </a>
          </div>
        </div>
      </header>

      <main>
        {plaudOAuthStatus === 'working' ? (
          <div style={{
            padding: '3rem 2rem',
            textAlign: 'center',
            color: 'var(--text-secondary)',
          }}>
            Connecting Plaud…
          </div>
        ) : viewMode === 'dispatch' ? (
          <DispatchBoard
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
          />
        ) : viewMode === 'calls' ? (
          <CallIntake
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            oauthNotice={
              plaudOAuthStatus === 'done' || plaudQuery.connected
                ? 'Plaud is connected.'
                : plaudOAuthError
            }
            oauthFailed={plaudOAuthStatus === 'error' || Boolean(plaudQuery.error)}
          />
        ) : viewMode === 'map' ? (
          <MapView selectedDate={selectedDate} />
        ) : loading ? (
          <div style={{
            padding: '2rem',
            textAlign: 'center',
            color: 'var(--text-secondary)'
          }}>
            Loading schedule...
          </div>
        ) : (
          <ScheduleForm
            trucks={trucks}
            selectedDate={selectedDate}
            onSave={handleSaveSchedule}
          />
        )}
      </main>
    </div>
  );
}

export default App;
