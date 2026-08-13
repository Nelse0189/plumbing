import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import ScheduleForm from './components/ScheduleForm';
import MapView from './components/MapView';
import BillingPage from './components/BillingPage';
import type { Truck, Schedule } from './types';
import { getTrucksForDate, saveSchedule } from './services/scheduleService';
import './App.css';

function App() {
  const [selectedDate, setSelectedDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [viewMode, setViewMode] = useState<'schedule' | 'map' | 'billing'>('schedule');
  const [trucks, setTrucks] = useState<Truck[]>([
    { id: 'truck1', name: 'Truck 1', stops: [] },
    { id: 'truck2', name: 'Truck 2', stops: [] },
    { id: 'truck3', name: 'Truck 3', stops: [] },
  ]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadSchedule = async () => {
      setLoading(true);
      try {
        const loadedTrucks = await getTrucksForDate(selectedDate);
        setTrucks(loadedTrucks);
      } catch (error) {
        console.error('Failed to load schedule:', error);
        // Fallback to default trucks on error
        setTrucks([
          { id: 'truck1', name: 'Truck 1', stops: [] },
          { id: 'truck2', name: 'Truck 2', stops: [] },
          { id: 'truck3', name: 'Truck 3', stops: [] },
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
              onClick={() => setViewMode('billing')}
              style={{
                backgroundColor: viewMode === 'billing' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: viewMode === 'billing' ? 'var(--bg-primary)' : 'var(--text-primary)',
                borderColor: viewMode === 'billing' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              Billing
            </button>
          </div>
        </div>
      </header>

      <main>
        {loading ? (
          <div style={{ 
            padding: '2rem', 
            textAlign: 'center', 
            color: 'var(--text-secondary)' 
          }}>
            Loading schedule...
          </div>
        ) : viewMode === 'schedule' ? (
          <ScheduleForm
            trucks={trucks}
            selectedDate={selectedDate}
            onSave={handleSaveSchedule}
          />
        ) : viewMode === 'map' ? (
          <MapView trucks={trucks} selectedDate={selectedDate} />
        ) : (
          <BillingPage trucks={trucks} selectedDate={selectedDate} />
        )}
      </main>
    </div>
  );
}

export default App;
