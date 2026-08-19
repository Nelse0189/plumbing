import { useEffect, useMemo, useState } from 'react';
import {
  DirectionsRenderer,
  DirectionsService,
  GoogleMap,
  InfoWindow,
  Marker,
  useJsApiLoader,
} from '@react-google-maps/api';
import type { DispatchStop, Stop, Truck } from '../types';
import { DEFAULT_DISPATCH_ORIGIN, formatWindowLabel } from '../utils/dispatchWindows';
import { resolveGoogleMapsApiKey } from '../utils/mapsKey';
import { subscribeDispatchPlan } from '../services/dispatchService';
import NotesWithScheduleHighlight from './NotesWithScheduleHighlight';

interface MapViewProps {
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

function pinLabel(text: string): google.maps.MarkerLabel {
  return {
    text,
    color: '#111111',
    fontSize: '12px',
    fontWeight: '700',
  };
}

function truckPinIcon(color: string): google.maps.Icon {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">
    <path fill="${color}" stroke="#1a1a1a" stroke-width="1.5" d="M16 1c-7.2 0-13 5.8-13 13 0 9.8 13 25 13 25s13-15.2 13-25C29 6.8 23.2 1 16 1z"/>
    <circle fill="#f4f1ea" cx="16" cy="14" r="8"/>
  </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(32, 40),
    anchor: new google.maps.Point(16, 40),
    labelOrigin: new google.maps.Point(16, 14),
  };
}

interface SelectedMapStop {
  truckName: string;
  stopNumber: number;
  stop: Stop;
  position: google.maps.LatLng | google.maps.LatLngLiteral;
}

function dispatchStopToMapStop(stop: DispatchStop): Stop {
  return {
    id: stop.id,
    workOrderNumber: stop.workOrderNumber,
    address: stop.address,
    customerName: stop.customerName,
    phone: stop.phone,
    time: formatWindowLabel(stop.window),
    jobType: stop.jobType,
    notes: stop.notes,
    lat: stop.lat,
    lng: stop.lng,
    scheduleEvidenceQuote: stop.scheduleEvidenceQuote,
  };
}

function MapCanvas({
  apiKey,
  trucks,
  selectedDate,
}: {
  apiKey: string;
  trucks: Truck[];
  selectedDate: string;
}) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'nj-plumbing-google-maps',
    googleMapsApiKey: apiKey,
  });
  const [directions, setDirections] = useState<
    Record<string, google.maps.DirectionsResult>
  >({});
  const [selectedStop, setSelectedStop] = useState<SelectedMapStop | null>(null);

  const allStops = useMemo(() => {
    return trucks.flatMap((truck) =>
      truck.stops.map((stop) => ({
        ...stop,
        truckName: truck.name,
        truckId: truck.id,
      }))
    );
  }, [trucks]);

  const truckRoutes = useMemo(
    () =>
      trucks
        .map((truck, index) => ({
          ...truck,
          color: ['#d8b24f', '#7eaa92', '#78a9d4', '#d67a90', '#bd9ee8'][index % 5],
          stops: truck.stops.filter((stop) => Boolean(stop.address?.trim())).slice(0, 25),
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

  if (loadError) {
    return (
      <p style={{ color: 'var(--text-secondary)', padding: '1.5rem' }}>
        Google Maps failed to load. Check that the browser key allows this site and that
        Maps JavaScript API is enabled.
      </p>
    );
  }

  if (!isLoaded) {
    return (
      <p style={{ color: 'var(--text-secondary)', padding: '1.5rem' }}>Loading map…</p>
    );
  }

  return (
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
                  current[truck.id] ? current : { ...current, [truck.id]: result }
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
                strokeOpacity: 0.45,
                strokeWeight: 6,
              },
            }}
          />
        );
      })}
      {truckRoutes.flatMap((truck) => {
        const legs = directions[truck.id]?.routes[0]?.legs || [];
        return legs.map((leg, index) => {
          const stop = truck.stops[index];
          const stopNumber = index + 1;
          return (
            <Marker
              key={`${truck.id}-stop-${index}`}
              position={leg.end_location}
              icon={truckPinIcon(truck.color)}
              label={pinLabel(String(stopNumber))}
              title={`${truck.name} stop ${stopNumber}: ${
                stop?.customerName || stop?.address || 'Scheduled stop'
              }`}
              onClick={() => {
                if (!stop) return;
                setSelectedStop({
                  truckName: truck.name,
                  stopNumber,
                  stop,
                  position: leg.end_location,
                });
              }}
            />
          );
        });
      })}
      {truckRoutes.length === 0 &&
        allStops.map((stop, index) =>
          stop.lat && stop.lng ? (
            <Marker
              key={stop.id || index}
              position={{ lat: stop.lat, lng: stop.lng }}
              label={pinLabel(String(index + 1))}
              title={`${index + 1}. ${stop.customerName} - ${stop.address}`}
            />
          ) : null
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
            {selectedStop.stop.phone && <div>Phone: {selectedStop.stop.phone}</div>}
            {selectedStop.stop.notes && (
              <div
                style={{
                  marginTop: '0.5rem',
                  paddingTop: '0.45rem',
                  borderTop: '1px solid #dadce0',
                  whiteSpace: 'pre-wrap',
                }}
              >
                <strong>Thread &amp; job notes</strong>
                <NotesWithScheduleHighlight
                  notes={selectedStop.stop.notes}
                  scheduleDate={selectedDate}
                  evidenceQuote={selectedStop.stop.scheduleEvidenceQuote}
                />
              </div>
            )}
          </div>
        </InfoWindow>
      )}
    </GoogleMap>
  );
}

export default function MapView({ selectedDate }: MapViewProps) {
  const [apiKey, setApiKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [trucks, setTrucks] = useState<Truck[]>([]);

  useEffect(() => {
    let cancelled = false;
    void resolveGoogleMapsApiKey()
      .then((key) => {
        if (cancelled) return;
        setApiKey(key);
        setKeyStatus(key ? 'ready' : 'missing');
      })
      .catch(() => {
        if (cancelled) return;
        setApiKey('');
        setKeyStatus('missing');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return subscribeDispatchPlan(selectedDate, (plan) => {
      setTrucks(
        plan.trucks.map((truck) => ({
          id: truck.id,
          name: truck.name,
          driver: truck.driver,
          stops: truck.stops.map(dispatchStopToMapStop),
        }))
      );
    });
  }, [selectedDate]);

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      <h2 style={{ marginBottom: '1rem', color: 'var(--accent)' }}>
        Map View - {selectedDate}
      </h2>
      {keyStatus === 'loading' ? (
        <p style={{ color: 'var(--text-secondary)' }}>Loading map…</p>
      ) : keyStatus === 'missing' || !apiKey ? (
        <div
          style={{
            padding: '2rem',
            border: '1px solid var(--border)',
            backgroundColor: 'var(--bg-secondary)',
            textAlign: 'center',
            color: 'var(--text-secondary)',
          }}
        >
          <p style={{ marginBottom: '1rem' }}>Google Maps API key not configured</p>
          <p style={{ fontSize: '0.85rem' }}>
            Add <code>VITE_GOOGLE_MAPS_API_KEY</code> to <code>.env.local</code> and restart
            the dev server, or save the key on Firestore <code>appConfig/public</code> as{' '}
            <code>googleMapsApiKey</code>.
          </p>
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--border)',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: '4px',
            overflow: 'hidden',
          }}
        >
          <MapCanvas apiKey={apiKey} trucks={trucks} selectedDate={selectedDate} />
        </div>
      )}
      <div style={{ marginTop: '1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        {trucks.every((truck) => truck.stops.length === 0) ? (
          <p>No stops on trucks for this date. Load jobs on Dispatch first.</p>
        ) : (
          <p>
            Showing truck routes from Dispatch. Routes start at {DEFAULT_DISPATCH_ORIGIN}.
          </p>
        )}
      </div>
    </div>
  );
}
