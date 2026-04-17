import { useMemo } from 'react';
import { GoogleMap, LoadScript, Marker } from '@react-google-maps/api';
import type { Truck } from '../types';

interface MapViewProps {
  trucks: Truck[];
  selectedDate: string;
}

const containerStyle = {
  width: '100%',
  height: '600px',
};

const defaultCenter = {
  lat: 40.7128,
  lng: -74.0060,
};

export default function MapView({ trucks, selectedDate }: MapViewProps) {
  const allStops = useMemo(() => {
    return trucks.flatMap(truck =>
      truck.stops.map(stop => ({
        ...stop,
        truckName: truck.name,
        truckId: truck.id,
      }))
    );
  }, [trucks]);

  const markers = useMemo(() => {
    return allStops.map((stop) => {
      if (stop.lat && stop.lng) {
        return {
          position: { lat: stop.lat, lng: stop.lng },
          label: stop.time,
          title: `${stop.customerName} - ${stop.address}`,
        };
      }
      return null;
    }).filter(Boolean);
  }, [allStops]);

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    return (
      <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
        <h2 style={{ marginBottom: '1rem', color: 'var(--accent)' }}>
          Map View - {selectedDate}
        </h2>
        <div style={{
          padding: '2rem',
          border: '1px solid var(--border)',
          backgroundColor: 'var(--bg-secondary)',
          textAlign: 'center',
          color: 'var(--text-secondary)',
        }}>
          <p style={{ marginBottom: '1rem' }}>Google Maps API key not configured</p>
          <p style={{ fontSize: '0.85rem' }}>
            Please add VITE_GOOGLE_MAPS_API_KEY to your .env file
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      <h2 style={{ marginBottom: '1rem', color: 'var(--accent)' }}>
        Map View - {selectedDate}
      </h2>
      <div style={{
        border: '1px solid var(--border)',
        backgroundColor: 'var(--bg-secondary)',
        borderRadius: '4px',
        overflow: 'hidden',
      }}>
        <LoadScript googleMapsApiKey={apiKey}>
          <GoogleMap
            mapContainerStyle={containerStyle}
            center={defaultCenter}
            zoom={10}
            options={{
              styles: [
                {
                  featureType: 'all',
                  elementType: 'geometry',
                  stylers: [{ color: '#323437' }],
                },
                {
                  featureType: 'all',
                  elementType: 'labels.text.stroke',
                  stylers: [{ color: '#323437' }],
                },
                {
                  featureType: 'all',
                  elementType: 'labels.text.fill',
                  stylers: [{ color: '#d1d0c5' }],
                },
                {
                  featureType: 'water',
                  elementType: 'geometry',
                  stylers: [{ color: '#2c2e31' }],
                },
                {
                  featureType: 'road',
                  elementType: 'geometry',
                  stylers: [{ color: '#3c3e41' }],
                },
              ],
              disableDefaultUI: false,
              zoomControl: true,
            }}
          >
            {markers.map((marker, index) => (
              marker && (
                <Marker
                  key={index}
                  position={marker.position}
                  label={marker.label}
                  title={marker.title}
                />
              )
            ))}
          </GoogleMap>
        </LoadScript>
      </div>
      <div style={{ marginTop: '1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        {allStops.length === 0 ? (
          <p>No stops scheduled for this date</p>
        ) : (
          <p>
            Showing {allStops.length} stop{allStops.length !== 1 ? 's' : ''} across {trucks.length} truck{trucks.length !== 1 ? 's' : ''}
          </p>
        )}
        {allStops.some(s => !s.lat || !s.lng) && (
          <p style={{ color: 'var(--accent)', marginTop: '0.5rem' }}>
            Note: Some stops may not appear on the map until addresses are geocoded
          </p>
        )}
      </div>
    </div>
  );
}

