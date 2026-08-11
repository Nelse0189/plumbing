import { useEffect, useMemo, useState } from 'react';
import {
  DirectionsRenderer,
  DirectionsService,
  GoogleMap,
  InfoWindow,
  LoadScript,
  Marker,
} from '@react-google-maps/api';
import type { Stop, Truck } from '../types';
import { DEFAULT_DISPATCH_ORIGIN } from '../utils/dispatchWindows';

interface MapViewProps {
  trucks: Truck[];
  selectedDate: string;
}

const containerStyle = {
  width: '100%',
  height: '600px',
};

const defaultCenter = {
  lat: 41.6215,
  lng: -72.7272,
};

interface SelectedMapStop {
  truckName: string;
  stopNumber: number;
  stop: Stop;
  position: google.maps.LatLng | google.maps.LatLngLiteral;
}

export default function MapView({ trucks, selectedDate }: MapViewProps) {
  const [directions, setDirections] = useState<
    Record<string, google.maps.DirectionsResult>
  >({});
  const [selectedStop, setSelectedStop] = useState<SelectedMapStop | null>(null);

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

  const truckRoutes = useMemo(
    () =>
      trucks
        .map((truck, index) => ({
          ...truck,
          color: ['#d8b24f', '#7eaa92', '#78a9d4', '#d67a90', '#bd9ee8'][index % 5],
          stops: truck.stops
            .filter((stop) => Boolean(stop.address?.trim()))
            .slice(0, 25),
        }))
        .filter((truck) => truck.stops.length > 0),
    [trucks]
  );

  const routeKey = useMemo(
    () =>
      truckRoutes
        .map((truck) => `${truck.id}:${truck.stops.map((stop) => stop.address).join('|')}`)
        .join(';'),
    [truckRoutes]
  );

  useEffect(() => {
    setDirections({});
    setSelectedStop(null);
  }, [routeKey]);

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
            <Marker position={defaultCenter} title={`Depot: ${DEFAULT_DISPATCH_ORIGIN}`} />
            {truckRoutes.map((truck) => {
              const lastStop = truck.stops[truck.stops.length - 1];
              const waypoints = truck.stops.slice(0, -1).map((stop) => ({
                location: stop.address,
                stopover: true,
              }));

              return !directions[truck.id] ? (
                <DirectionsService
                  key={`${truck.id}-${routeKey}`}
                  options={{
                    origin: DEFAULT_DISPATCH_ORIGIN,
                    destination: lastStop.address,
                    waypoints,
                    travelMode: 'DRIVING' as google.maps.TravelMode,
                    optimizeWaypoints: false,
                  }}
                  callback={(result, status) => {
                    if (status === 'OK' && result) {
                      setDirections((current) =>
                        current[truck.id]
                          ? current
                          : { ...current, [truck.id]: result }
                      );
                    }
                  }}
                />
              ) : (
                <DirectionsRenderer
                  key={`${truck.id}-route`}
                  directions={directions[truck.id]}
                  options={{
                    suppressMarkers: true,
                    preserveViewport: false,
                    polylineOptions: {
                      strokeColor: truck.color,
                      strokeOpacity: 0.85,
                      strokeWeight: 5,
                    },
                  }}
                />
              );
            })}
            {truckRoutes.flatMap((truck) => {
              const legs = directions[truck.id]?.routes[0]?.legs || [];
              return legs.map((leg, index) => {
                const stop = truck.stops[index];
                return (
                  <Marker
                    key={`${truck.id}-stop-${index}`}
                    position={leg.end_location}
                    label={String(index + 1)}
                    title={`${truck.name} · Stop ${index + 1}: ${
                      stop?.customerName || stop?.address || 'Scheduled stop'
                    }`}
                    onClick={() => {
                      if (!stop) return;
                      setSelectedStop({
                        truckName: truck.name,
                        stopNumber: index + 1,
                        stop,
                        position: leg.end_location,
                      });
                    }}
                  />
                );
              });
            })}
            {truckRoutes.length === 0 &&
              markers.map(
                (marker, index) =>
                  marker && (
                    <Marker
                      key={index}
                      position={marker.position}
                      label={marker.label}
                      title={marker.title}
                    />
                  )
              )}
            {selectedStop && (
              <InfoWindow
                position={selectedStop.position}
                onCloseClick={() => setSelectedStop(null)}
              >
                <div style={{ maxWidth: '260px', color: '#202124', lineHeight: 1.4 }}>
                  <strong>
                    {selectedStop.truckName} · Stop {selectedStop.stopNumber}
                  </strong>
                  <div style={{ marginTop: '0.45rem' }}>
                    <strong>{selectedStop.stop.customerName || 'Customer TBD'}</strong>
                  </div>
                  <div>{selectedStop.stop.address || 'No address'}</div>
                  <div style={{ marginTop: '0.35rem' }}>
                    {selectedStop.stop.jobType || 'Job type TBD'}
                  </div>
                  <div>Scheduled: {selectedStop.stop.time || 'Time TBD'}</div>
                  {selectedStop.stop.phone && (
                    <div>Phone: {selectedStop.stop.phone}</div>
                  )}
                  {selectedStop.stop.notes && (
                    <div
                      style={{
                        marginTop: '0.5rem',
                        paddingTop: '0.45rem',
                        borderTop: '1px solid #dadce0',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      <strong>Notes</strong>
                      <div>{selectedStop.stop.notes}</div>
                    </div>
                  )}
                </div>
              </InfoWindow>
            )}
          </GoogleMap>
        </LoadScript>
      </div>
      <div style={{ marginTop: '1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        {allStops.length === 0 ? (
          <p>No stops scheduled for this date</p>
        ) : (
          <p>
            Showing {allStops.length} stop{allStops.length !== 1 ? 's' : ''} across {trucks.length} truck{trucks.length !== 1 ? 's' : ''}. Routes start at{' '}
            {DEFAULT_DISPATCH_ORIGIN}.
          </p>
        )}
        {truckRoutes.length > 0 && (
          <p style={{ marginTop: '0.5rem' }}>
            Colored lines show each truck’s stop order. Numbered markers identify
            each stop. Routes use the order on the schedule and do not automatically
            reorder stops.
          </p>
        )}
        {truckRoutes.length === 0 && allStops.some(s => !s.lat || !s.lng) && (
          <p style={{ color: 'var(--accent)', marginTop: '0.5rem' }}>
            Note: Some stops may not appear on the map until addresses are geocoded
          </p>
        )}
      </div>
    </div>
  );
}

