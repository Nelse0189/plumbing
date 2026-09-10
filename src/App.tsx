import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import ScheduleForm from './components/ScheduleForm';
import MapView from './components/MapView';
import DispatchBoard from './components/DispatchBoard';
import CallIntake from './components/CallIntake';
import BillsAnalysis from './components/BillsAnalysis';
import InternalJobs from './components/InternalJobs';
import TeamsChannels from './components/TeamsChannels';
import PhoneSms from './components/PhoneSms';
import EmailBriefing from './components/EmailBriefing';
import VoiceAgent from './components/VoiceAgent';
import JobTicketPage from './components/JobTicket';
import PlumberBoard from './components/PlumberBoard';
import DayWork from './components/DayWork';
import type { Truck, Schedule } from './types';
import { peekPendingSharePointLoad } from './services/billWorkbookService';
import { getTrucksForDate, saveSchedule } from './services/scheduleService';
import { takePlaudConnectTokenFromLocation } from './plaudConnect';
import { formatPlaudCallableError, capturePlaudOAuthCallback, peekPlaudOAuthPending, runPlaudOAuthFinishOnce, clearPlaudOAuthPending } from './plaudOAuth';
import { finishPlaudOAuth } from './services/plaudService';
import { isDesktopShell, rememberDesktopShell } from './teams-test/auth';
import { useTeamsLiveSync } from './hooks/useTeamsLiveSync';
import {
  canonicalizeWorkOrderLocation,
  isWorkOrderPath,
  WORK_ORDER_PATH,
} from './utils/workOrderPage';
import {
  canonicalizePlumberLocation,
  isPlumberPath,
} from './utils/plumberPage';
import './App.css';

type ViewMode =
  | 'dispatch'
  | 'day'
  | 'schedule'
  | 'map'
  | 'calls'
  | 'internal'
  | 'bills'
  | 'teams'
  | 'sms'
  | 'emails'
  | 'agent'
  | 'ticket'
  | 'plumber';

rememberDesktopShell();
const onWorkOrderRoute = canonicalizeWorkOrderLocation() || isWorkOrderPath();
const plumberWorkOrderPage = !isDesktopShell() && onWorkOrderRoute;
const plumberFieldPage =
  canonicalizePlumberLocation() || (!isDesktopShell() && isPlumberPath());

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

const plaudCallback = capturePlaudOAuthCallback();
const plaudQuery = consumePlaudQuery();

function initialViewMode(): ViewMode {
  if (plumberWorkOrderPage || plumberFieldPage) return 'dispatch';
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  if (view === 'ticket' || (isDesktopShell() && isWorkOrderPath())) return 'ticket';
  if (view === 'plumber' || (isDesktopShell() && isPlumberPath())) return 'plumber';
  if (view === 'sms') return 'sms';
  if (view === 'emails' || params.get('gmail') === '1') return 'emails';
  if (view === 'agent') return 'agent';
  if (view === 'teams') return 'teams';
  if (view === 'bills' || peekPendingSharePointLoad()) return 'bills';
  if (view === 'calls') return 'calls';
  if (view === 'internal') return 'internal';
  if (view === 'day') return 'day';
  if (view === 'schedule') return 'schedule';
  if (view === 'map') return 'map';
  if (view === 'dispatch') return 'dispatch';
  if (takePlaudConnectTokenFromLocation() || plaudQuery.connected || plaudQuery.error || plaudCallback) {
    return 'calls';
  }
  return 'dispatch';
}

function initialSelectedDate(): string {
  const date = new URLSearchParams(window.location.search).get('date');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return format(new Date(), 'yyyy-MM-dd');
}

function App() {
  const [selectedDate, setSelectedDate] = useState<string>(initialSelectedDate);
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  const [customerSign, setCustomerSign] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('sign') === '1';
  });
  const [plaudOAuthStatus, setPlaudOAuthStatus] = useState<'idle' | 'working' | 'done' | 'error'>(
    () => (plaudCallback ? 'working' : 'idle')
  );
  const [plaudOAuthError, setPlaudOAuthError] = useState(plaudQuery.error);
  const [trucks, setTrucks] = useState<Truck[]>([
    { id: 'truck1', name: 'Truck 1', stops: [] },
    { id: 'truck2', name: 'Truck 2', stops: [] },
    { id: 'truck3', name: 'Truck 3', stops: [] },
    { id: 'truck4', name: 'Truck 4', stops: [] },
    { id: 'truck5', name: 'Truck 5', stops: [] },
    { id: 'truck6', name: 'Truck 6', stops: [] },
    { id: 'truck7', name: 'Truck 7', stops: [] },
  ]);
  const [loading, setLoading] = useState(true);
  useTeamsLiveSync(!plumberWorkOrderPage && !plumberFieldPage);

  useEffect(() => {
    if (!plaudCallback) return;
    let cancelled = false;
    void runPlaudOAuthFinishOnce(async () => {
      if (plaudCallback.error) {
        throw new Error(plaudCallback.error);
      }
      const pending = peekPlaudOAuthPending();
      if (pending && pending.state !== plaudCallback.state) {
        throw new Error('Plaud sign-in did not match this page. Click Sign in with Plaud again.');
      }
      if (!plaudCallback.code || !plaudCallback.state) {
        throw new Error('Plaud did not return a complete sign-in. Click Sign in with Plaud again.');
      }
      await finishPlaudOAuth({
        code: plaudCallback.code,
        state: plaudCallback.state,
        verifier: pending?.verifier,
        redirectUri: pending?.redirectUri,
      });
      clearPlaudOAuthPending();
    })
      .then(() => {
        if (cancelled) return;
        const next = new URLSearchParams();
        next.set('view', 'calls');
        next.set('plaud', 'connected');
        if (isDesktopShell()) next.set('shell', 'desktop');
        window.location.replace(`/?${next.toString()}`);
      })
      .catch((err) => {
        if (cancelled) return;
        setPlaudOAuthStatus('error');
        setPlaudOAuthError(formatPlaudCallableError(err));
        setViewMode('calls');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (plumberWorkOrderPage) {
      document.title = 'Work Order · NJ Plumbing';
      return;
    }
    if (plumberFieldPage) {
      document.title = 'Plumber schedule · NJ Plumbing';
      return;
    }
    document.title = 'NJ Plumbing Scheduling';
  }, []);

  useEffect(() => {
    if (plumberWorkOrderPage || plumberFieldPage || plaudOAuthStatus === 'working') return;
    const params = new URLSearchParams(window.location.search);
    if (viewMode !== 'ticket') {
      params.delete('ticket');
      params.delete('sign');
    }
    if (params.get('view') !== viewMode) {
      params.set('view', viewMode);
    }
    const next = `/?${params.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      history.replaceState(null, '', next);
    }
  }, [viewMode, plaudOAuthStatus]);

  useEffect(() => {
    if (plumberWorkOrderPage || plumberFieldPage) return;
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
          { id: 'truck6', name: 'Truck 6', stops: [] },
          { id: 'truck7', name: 'Truck 7', stops: [] },
        ]);
      } finally {
        setLoading(false);
      }
    };

    loadSchedule();
  }, [selectedDate]);

  const selectView = (mode: ViewMode) => {
    if (mode !== 'ticket') setCustomerSign(false);
    setViewMode(mode);
  };

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

  if (plumberFieldPage) {
    return (
      <div className="app app--plumber">
        <header className="plumber-header">
          <div>
            <h1>NJ Plumbing</h1>
            <p>Plumber schedule</p>
          </div>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            aria-label="Service date"
          />
        </header>
        <main>
          <PlumberBoard selectedDate={selectedDate} onSelectDate={setSelectedDate} />
        </main>
      </div>
    );
  }

  if (plumberWorkOrderPage) {
    return (
      <div className="app app--work-order">
        <header className="work-order-header" hidden={customerSign}>
          <h1>NJ Plumbing Work Order</h1>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            aria-label="Service date"
          />
        </header>
        <main>
          <JobTicketPage
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            customerSign={customerSign}
            onCustomerSignChange={setCustomerSign}
          />
        </main>
      </div>
    );
  }

  return (
    <div className={`app${viewMode === 'dispatch' ? ' app--dispatch' : ''}`}>
      <header
        className="app-header"
        style={{
        display: customerSign ? 'none' : 'flex',
        flexDirection: 'row',
        padding: '1.5rem 2rem',
        borderBottom: '1px solid var(--border)',
        backgroundColor: 'var(--bg-secondary)',
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
              onClick={() => selectView('dispatch')}
              style={{
                backgroundColor: viewMode === 'dispatch' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'dispatch' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'dispatch' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Dispatch
            </button>
            <button
              onClick={() => selectView('day')}
              style={{
                backgroundColor: viewMode === 'day' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'day' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'day' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Day Work
            </button>
            <button
              onClick={() => selectView('schedule')}
              style={{
                backgroundColor: viewMode === 'schedule' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'schedule' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'schedule' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Schedule
            </button>
            <button
              onClick={() => selectView('map')}
              style={{
                backgroundColor: viewMode === 'map' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'map' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'map' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Map View
            </button>
            <button
              onClick={() => selectView('calls')}
              style={{
                backgroundColor: viewMode === 'calls' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'calls' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'calls' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Calls
            </button>
            <button
              onClick={() => selectView('internal')}
              style={{
                backgroundColor: viewMode === 'internal' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'internal' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'internal' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              N&J Jobs
            </button>
            <button
              onClick={() => selectView('bills')}
              style={{
                backgroundColor: viewMode === 'bills' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'bills' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'bills' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Bills
            </button>
            <button
              onClick={() => selectView('teams')}
              style={{
                backgroundColor: viewMode === 'teams' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'teams' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'teams' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Teams Channels
            </button>
            <button
              onClick={() => selectView('sms')}
              style={{
                backgroundColor: viewMode === 'sms' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'sms' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'sms' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Phone SMS
            </button>
            <button
              onClick={() => selectView('emails')}
              style={{
                backgroundColor: viewMode === 'emails' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'emails' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'emails' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Inbox
            </button>
            <button
              onClick={() => selectView('agent')}
              style={{
                backgroundColor: viewMode === 'agent' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'agent' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'agent' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Voice Agent
            </button>
            {isDesktopShell() ? (
              <button
                onClick={() => selectView('plumber')}
                style={{
                  backgroundColor: viewMode === 'plumber' ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: viewMode === 'plumber' ? 'var(--bg-primary)' : 'var(--text-primary)',
                  borderColor: viewMode === 'plumber' ? 'var(--accent)' : 'var(--border)',
                }}
              >
                Plumber
              </button>
            ) : null}
            <button
              onClick={() => {
                if (isDesktopShell()) {
                  selectView('ticket');
                  return;
                }
                window.location.assign(WORK_ORDER_PATH);
              }}
              style={{
                backgroundColor: viewMode === 'ticket' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'ticket' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'ticket' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Job Ticket
            </button>
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
        ) : (
          <>
            <div style={{ display: viewMode === 'dispatch' ? 'contents' : 'none' }}>
              <DispatchBoard
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
              />
            </div>
            {viewMode === 'calls' ? (
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
              <MapView selectedDate={selectedDate} onSelectDate={setSelectedDate} />
            ) : viewMode === 'day' ? (
              <DayWork selectedDate={selectedDate} onSelectDate={setSelectedDate} />
            ) : viewMode === 'bills' ? (
              <BillsAnalysis />
            ) : viewMode === 'internal' ? (
              <InternalJobs selectedDate={selectedDate} />
            ) : viewMode === 'teams' ? (
              <TeamsChannels />
            ) : viewMode === 'sms' ? (
              <PhoneSms />
            ) : viewMode === 'emails' ? (
              <EmailBriefing />
            ) : viewMode === 'agent' ? (
              <VoiceAgent />
            ) : viewMode === 'ticket' ? (
              <JobTicketPage
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
                customerSign={customerSign}
                onCustomerSignChange={setCustomerSign}
              />
            ) : viewMode === 'plumber' ? (
              <PlumberBoard
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
                editable
              />
            ) : viewMode === 'dispatch' ? null : loading ? (
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
          </>
        )}
      </main>
    </div>
  );
}

export default App;
