import { useState, useEffect } from 'react';
import type { Stop, Truck } from '../types';
import { geocodeAddress } from '../utils/geocode';
import { initiateSMScheduling } from '../services/smsService';

interface ScheduleFormProps {
  trucks: Truck[];
  selectedDate: string;
  onSave: (trucks: Truck[]) => void;
}

export default function ScheduleForm({ trucks, selectedDate, onSave }: ScheduleFormProps) {
  const [localTrucks, setLocalTrucks] = useState<Truck[]>(trucks);
  const [selectedTruckId, setSelectedTruckId] = useState<string>(trucks[0]?.id || '');
  const [showAddStop, setShowAddStop] = useState(false);
  const [showAddTruck, setShowAddTruck] = useState(false);
  const [newStop, setNewStop] = useState<Partial<Stop>>({
    address: '',
    customerName: '',
    phone: '',
    time: '',
    notes: '',
  });
  const [newTruck, setNewTruck] = useState<Partial<Truck>>({
    name: '',
    driver: '',
  });
  const [sendingSMS, setSendingSMS] = useState<string | null>(null);

  // Sync local trucks when trucks prop changes
  useEffect(() => {
    setLocalTrucks(trucks);
    if (trucks.length > 0 && (!selectedTruckId || !trucks.find(t => t.id === selectedTruckId))) {
      setSelectedTruckId(trucks[0].id);
    }
  }, [trucks]);

  const selectedTruck = localTrucks.find(t => t.id === selectedTruckId);

  // Generate available time slots (every hour from 8 AM to 5 PM)
  const generateAvailableTimeSlots = (): string[] => {
    const slots: string[] = [];
    const allStops = localTrucks.flatMap(t => t.stops);
    const bookedTimes = new Set(allStops.map(s => s.time));

    for (let hour = 8; hour <= 17; hour++) {
      const timeSlot = `${hour.toString().padStart(2, '0')}:00`;
      if (!bookedTimes.has(timeSlot)) {
        slots.push(timeSlot);
      }
    }
    return slots;
  };

  const handleInitiateSMS = async (stop: Stop) => {
    if (!stop.phone) {
      alert('Phone number is required for SMS scheduling');
      return;
    }

    setSendingSMS(stop.id);
    try {
      const availableSlots = generateAvailableTimeSlots();
      if (availableSlots.length === 0) {
        alert('No available time slots for this date');
        return;
      }

      await initiateSMScheduling(
        stop.phone,
        stop.customerName,
        stop.address,
        selectedDate,
        availableSlots
      );

      alert('SMS scheduling initiated! The customer will receive a text message.');
    } catch (error) {
      console.error('Error initiating SMS:', error);
      alert('Failed to send SMS. Please check your Firebase Functions configuration.');
    } finally {
      setSendingSMS(null);
    }
  };

  const handleAddStop = async () => {
    if (!selectedTruck || !newStop.address || !newStop.customerName || !newStop.time) {
      alert('Please fill in address, customer name, and time');
      return;
    }

    // Geocode the address
    const coordinates = await geocodeAddress(newStop.address!);

    const stop: Stop = {
      id: Date.now().toString(),
      address: newStop.address!,
      customerName: newStop.customerName!,
      phone: newStop.phone || '',
      time: newStop.time!,
      notes: newStop.notes || '',
      lat: coordinates?.lat,
      lng: coordinates?.lng,
    };

    const updatedTrucks = localTrucks.map(truck =>
      truck.id === selectedTruckId
        ? { ...truck, stops: [...truck.stops, stop] }
        : truck
    );

    setLocalTrucks(updatedTrucks);
    setNewStop({ address: '', customerName: '', phone: '', time: '', notes: '' });
    setShowAddStop(false);
    onSave(updatedTrucks);
  };

  const handleDeleteStop = (truckId: string, stopId: string) => {
    const updatedTrucks = localTrucks.map(truck =>
      truck.id === truckId
        ? { ...truck, stops: truck.stops.filter(s => s.id !== stopId) }
        : truck
    );
    setLocalTrucks(updatedTrucks);
    onSave(updatedTrucks);
  };

  const handleAddTruck = () => {
    if (!newTruck.name || newTruck.name.trim() === '') {
      alert('Please enter a truck name');
      return;
    }

    const truck: Truck = {
      id: `truck${Date.now()}`,
      name: newTruck.name.trim(),
      driver: newTruck.driver?.trim() || undefined,
      stops: [],
    };

    const updatedTrucks = [...localTrucks, truck];
    setLocalTrucks(updatedTrucks);
    setSelectedTruckId(truck.id);
    setNewTruck({ name: '', driver: '' });
    setShowAddTruck(false);
    onSave(updatedTrucks);
  };

  const handleDeleteTruck = (truckId: string) => {
    if (localTrucks.length <= 1) {
      alert('You must have at least one truck');
      return;
    }

    if (!confirm('Are you sure you want to delete this truck? All stops will be removed.')) {
      return;
    }

    const updatedTrucks = localTrucks.filter(t => t.id !== truckId);
    setLocalTrucks(updatedTrucks);
    
    // Select the first remaining truck if the deleted one was selected
    if (selectedTruckId === truckId && updatedTrucks.length > 0) {
      setSelectedTruckId(updatedTrucks[0].id);
    } else if (updatedTrucks.length === 0) {
      setSelectedTruckId('');
    }
    
    onSave(updatedTrucks);
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ color: 'var(--accent)' }}>Schedule for {selectedDate}</h2>
          <button
            onClick={() => setShowAddTruck(!showAddTruck)}
            style={{
              backgroundColor: 'var(--accent)',
              color: 'var(--bg-primary)',
              borderColor: 'var(--accent)',
            }}
          >
            {showAddTruck ? 'Cancel' : '+ Add Truck'}
          </button>
        </div>

        {showAddTruck && (
          <div style={{
            padding: '1rem',
            marginBottom: '1rem',
            border: '1px solid var(--border)',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: '4px',
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
              <input
                type="text"
                placeholder="Truck Name *"
                value={newTruck.name}
                onChange={(e) => setNewTruck({ ...newTruck, name: e.target.value })}
                style={{ padding: '0.5rem' }}
              />
              <input
                type="text"
                placeholder="Driver Name (optional)"
                value={newTruck.driver || ''}
                onChange={(e) => setNewTruck({ ...newTruck, driver: e.target.value })}
                style={{ padding: '0.5rem' }}
              />
            </div>
            <button onClick={handleAddTruck} style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-primary)' }}>
              Add Truck
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          {localTrucks.map(truck => (
            <div key={truck.id} style={{ position: 'relative', display: 'inline-block' }}>
              <button
                onClick={() => setSelectedTruckId(truck.id)}
                style={{
                  backgroundColor: selectedTruckId === truck.id ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: selectedTruckId === truck.id ? 'var(--bg-primary)' : 'var(--text-primary)',
                  borderColor: selectedTruckId === truck.id ? 'var(--accent)' : 'var(--border)',
                  paddingRight: '2rem',
                }}
              >
                {truck.name} ({truck.stops.length} stops)
                {truck.driver && ` - ${truck.driver}`}
              </button>
              {localTrucks.length > 1 && (
                <button
                  onClick={() => handleDeleteTruck(truck.id)}
                  style={{
                    position: 'absolute',
                    right: '0.25rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    backgroundColor: 'transparent',
                    color: 'var(--error)',
                    border: 'none',
                    fontSize: '1.2rem',
                    cursor: 'pointer',
                    padding: '0.25rem',
                    lineHeight: 1,
                  }}
                  title="Delete truck"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {selectedTruck && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ color: 'var(--text-primary)' }}>{selectedTruck.name}</h3>
            <button onClick={() => setShowAddStop(!showAddStop)}>
              {showAddStop ? 'Cancel' : '+ Add Stop'}
            </button>
          </div>

          {showAddStop && (
            <div style={{
              padding: '1rem',
              marginBottom: '1rem',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--bg-secondary)',
            }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
                <input
                  type="text"
                  placeholder="Customer Name *"
                  value={newStop.customerName}
                  onChange={(e) => setNewStop({ ...newStop, customerName: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="Address *"
                  value={newStop.address}
                  onChange={(e) => setNewStop({ ...newStop, address: e.target.value })}
                />
                <input
                  type="tel"
                  placeholder="Phone"
                  value={newStop.phone}
                  onChange={(e) => setNewStop({ ...newStop, phone: e.target.value })}
                />
                <input
                  type="time"
                  placeholder="Time *"
                  value={newStop.time}
                  onChange={(e) => setNewStop({ ...newStop, time: e.target.value })}
                />
              </div>
              <textarea
                placeholder="Notes"
                value={newStop.notes}
                onChange={(e) => setNewStop({ ...newStop, notes: e.target.value })}
                style={{ width: '100%', minHeight: '60px', marginBottom: '0.5rem' }}
              />
              <button onClick={handleAddStop}>Save Stop</button>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {selectedTruck.stops.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', padding: '1rem' }}>No stops scheduled</p>
            ) : (
              selectedTruck.stops
                .sort((a, b) => a.time.localeCompare(b.time))
                .map((stop) => (
                  <div
                    key={stop.id}
                    style={{
                      padding: '1rem',
                      border: '1px solid var(--border)',
                      backgroundColor: 'var(--bg-secondary)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.75rem',
                    }}
                  >
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr auto',
                        gap: '1rem',
                        alignItems: 'center',
                      }}
                    >
                      <div style={{ color: 'var(--accent)', fontWeight: '600', minWidth: '80px' }}>
                        {stop.time}
                      </div>
                      <div>
                        <div style={{ fontWeight: '600', marginBottom: '0.5rem' }}>
                          {stop.customerName || 'Customer Name: Not provided in transcript'}
                        </div>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                          <strong>Address:</strong> {stop.address || 'Not provided in transcript'}
                        </div>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                          <strong>Phone:</strong> {stop.phone || 'Not provided in transcript'}
                        </div>
                        {stop.notes && (
                          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem', fontStyle: 'italic' }}>
                            <strong>Notes:</strong> {stop.notes}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        {stop.phone && (
                          <button
                            onClick={() => handleInitiateSMS(stop)}
                            disabled={sendingSMS === stop.id}
                            style={{
                              color: 'var(--success)',
                              borderColor: 'var(--success)',
                              opacity: sendingSMS === stop.id ? 0.5 : 1,
                              fontSize: '0.85rem',
                              padding: '0.4rem 0.8rem',
                            }}
                          >
                            {sendingSMS === stop.id ? 'Sending...' : '📱 SMS Schedule'}
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteStop(selectedTruck.id, stop.id)}
                          style={{ color: 'var(--error)', borderColor: 'var(--error)', fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {(stop.callSummary ||
                      (stop.customerServiceTips && stop.customerServiceTips.length > 0)) && (
                      <div
                        role="region"
                        aria-label="Call summary and customer service tips"
                        style={{
                          fontSize: '0.85rem',
                          color: 'var(--text-secondary)',
                          marginTop: '0.25rem',
                          backgroundColor: 'var(--bg-primary)',
                          borderRadius: '4px',
                          padding: '0.75rem',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <div
                          style={{
                            fontSize: '0.7rem',
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            color: 'var(--accent)',
                            marginBottom: '0.5rem',
                            fontWeight: 600,
                          }}
                        >
                          From call / voicemail
                        </div>
                        {stop.callSummary && (
                          <div style={{ lineHeight: 1.55, marginBottom: '0.75rem' }}>
                            <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.25rem' }}>
                              Call summary
                            </div>
                            <p style={{ margin: 0 }}>{stop.callSummary}</p>
                          </div>
                        )}
                        {stop.customerServiceTips && stop.customerServiceTips.length > 0 && (
                          <div>
                            <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.35rem' }}>
                              Customer service tips
                            </div>
                            <ul style={{ margin: 0, paddingLeft: '1.15rem' }}>
                              {stop.customerServiceTips.map((tip, i) => (
                                <li key={i} style={{ marginBottom: '0.35rem' }}>
                                  {tip}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

