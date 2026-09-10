import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DirectionsRenderer,
  DirectionsService,
  GoogleMap,
  InfoWindow,
  Marker,
  useJsApiLoader,
} from '@react-google-maps/api';
import type { DispatchStop, FuelSettings, JobTicket, Stop, Truck, TruckGasEstimate } from '../types';
import { DEFAULT_DISPATCH_ORIGIN, formatWindowLabel } from '../utils/dispatchWindows';
import { formatCustomerPhones } from '../utils/customerPhones';
import { geocodeAddress } from '../utils/geocode';
import { estimateTruckGas, defaultFuelSettings, sumFleetGas } from '../utils/gasEstimate';
import { resolveGoogleMapsApiKey } from '../utils/mapsKey';
import { subscribeDispatchPlan } from '../services/dispatchService';
import { subscribeFuelSettings } from '../services/fuelSettingsService';
import { milesFromDirectionsResult } from '../services/gasEstimateService';
import { findJobTicketForStop, jobTicketIsSigned, normalizeWorkOrderKey, subscribeJobTicketsForWorkOrders } from '../services/jobTicketService';
import NotesWithScheduleHighlight from './NotesWithScheduleHighlight';
import JobTicketEditor, { ticketFromStop } from './JobTicketEditor';
import DispatchDayStrip, { formatDispatchDay } from './DispatchDayStrip';
import './JobTicket.css';
import './MapView.css';

interface MapViewProps {
  selectedDate: string;
  onSelectDate: (date: string) => void;
}

const containerStyle = {
  width: '100%',
  height: '600px',
};

const TRUCK_COLORS = ['#d8b24f', '#7eaa92', '#78a9d4', '#d67a90', '#bd9ee8'];

/** Nearby 213 Christian Ln until 216 is geocoded. */
const defaultCenter = {
  lat: 41.63711,
  lng: -72.75087,
};

function originDotIcon(): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 9,
    fillColor: '#e23d3d',
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 2,
    anchor: new google.maps.Point(0, 0),
  };
}

function pinLabel(text: string): google.maps.MarkerLabel {
  return {
    text,
    color: '#111111',
    fontSize: '12px',
    fontWeight: '700',
  };
}

function truckPinIcon(color: string, signed = false): google.maps.Icon {
  const check = signed
    ? `<circle fill="#1f8a4c" stroke="#ffffff" stroke-width="1.4" cx="25" cy="8" r="6.4"/>
       <path fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M22.2 8.1l2.1 2.1 4.1-4.3"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">
    <path fill="${color}" stroke="#1a1a1a" stroke-width="1.5" d="M16 1c-7.2 0-13 5.8-13 13 0 9.8 13 25 13 25s13-15.2 13-25C29 6.8 23.2 1 16 1z"/>
    <circle fill="#f4f1ea" cx="16" cy="14" r="8"/>
    ${check}
  </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(32, 40),
    anchor: new google.maps.Point(16, 40),
    labelOrigin: new google.maps.Point(16, 14),
  };
}

function signedKeysFromTickets(tickets: JobTicket[]): Set<string> {
  const keys = new Set<string>();
  for (const ticket of tickets) {
    if (!jobTicketIsSigned(ticket)) continue;
    for (const value of [ticket.workOrderNumber, ticket.workOrderId, ticket.id]) {
      const key = normalizeWorkOrderKey(value);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function stopIsSigned(stop: Stop, signedKeys: Set<string>): boolean {
  return [stop.workOrderNumber, stop.id].some((value) => {
    const key = normalizeWorkOrderKey(value);
    return Boolean(key && signedKeys.has(key));
  });
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
    phones: stop.phones,
    time: formatWindowLabel(stop.window),
    jobType: stop.jobType,
    notes: stop.notes,
    installDescription: stop.installDescription,
    sourceFileName: stop.sourceFileName,
    lat: stop.lat,
    lng: stop.lng,
    scheduleEvidenceQuote: stop.scheduleEvidenceQuote,
  };
}

function mapStopSource(stop: Stop) {
  return {
    workOrderId: stop.id,
    workOrderNumber: stop.workOrderNumber,
    customerName: stop.customerName,
    phone: stop.phone,
    address: stop.address,
    jobType: stop.jobType,
    notes: stop.notes,
    installDescription: stop.installDescription,
  };
}

function ticketForMapStop(
  stop: Stop,
  tickets: JobTicket[],
  serviceDate: string
): Omit<JobTicket, 'id'> & { id?: string } {
  return findJobTicketForStop(tickets, stop) || ticketFromStop(mapStopSource(stop), serviceDate);
}

function MapWorkOrderModal({
  stop,
  ticket,
  serviceDate,
  onClose,
}: {
  stop: Stop;
  ticket: Omit<JobTicket, 'id'> & { id?: string };
  serviceDate: string;
  onClose: () => void;
}) {
  const [customerSign, setCustomerSign] = useState(false);
  return createPortal(
    <div
      className="map-wo-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Work order ${stop.workOrderNumber || stop.customerName || 'PDF'}`}
    >
      <button type="button" className="map-wo-modal__backdrop" aria-label="Close work order" onClick={onClose} />
      <div className={`map-wo-modal__panel${customerSign ? ' map-wo-modal__panel--sign' : ''}`}>
        {customerSign ? null : (
          <header className="map-wo-modal__header">
            <div>
              <strong>{stop.workOrderNumber || 'No WO#'}</strong>
              <p>{stop.customerName || 'Work order'}</p>
            </div>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </header>
        )}
        <div className={`map-wo-modal__sheet${customerSign ? ' map-wo-modal__sheet--sign' : ''}`}>
          <JobTicketEditor
            key={stop.id}
            serviceDate={serviceDate}
            initialTicket={ticket}
            sourceStop={ticket.id ? undefined : mapStopSource(stop)}
            updateUrl={false}
            customerSign={customerSign}
            onCustomerSignChange={setCustomerSign}
            hideNew
            embedded
            onDeleted={onClose}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}

function MapCanvas({
  apiKey,
  trucks,
  selectedDate,
  originAddress,
  signedKeys,
  onOpenWorkOrder,
}: {
  apiKey: string;
  trucks: Truck[];
  selectedDate: string;
  originAddress: string;
  signedKeys: Set<string>;
  onOpenWorkOrder: (stop: Stop) => void;
}) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'nj-plumbing-google-maps',
    googleMapsApiKey: apiKey,
  });
  const [directions, setDirections] = useState<
    Record<string, google.maps.DirectionsResult>
  >({});
  const [selectedStop, setSelectedStop] = useState<SelectedMapStop | null>(null);
  const [originPosition, setOriginPosition] = useState(defaultCenter);
  const [fuelSettings, setFuelSettings] = useState<FuelSettings>(defaultFuelSettings);
  const mapRef = useRef<google.maps.Map | null>(null);

  useEffect(() => {
    return subscribeFuelSettings(setFuelSettings);
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;

    const applyCoords = (coords: { lat: number; lng: number } | null) => {
      if (!cancelled && coords) setOriginPosition(coords);
    };

    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: originAddress }, (results, status) => {
      if (cancelled) return;
      if (status === 'OK' && results?.[0]) {
        const loc = results[0].geometry.location;
        applyCoords({ lat: loc.lat(), lng: loc.lng() });
        return;
      }
      void geocodeAddress(originAddress).then(applyCoords);
    });

    return () => {
      cancelled = true;
    };
  }, [isLoaded, originAddress]);

  useEffect(() => {
    mapRef.current?.panTo(originPosition);
  }, [originPosition]);

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
          color: TRUCK_COLORS[index % TRUCK_COLORS.length],
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

  const gasEstimates = useMemo(() => {
    return truckRoutes.map((truck) => {
      const miles = milesFromDirectionsResult(
        directions[truck.id],
        originPosition,
        fuelSettings.includeReturnToShop
      );
      return estimateTruckGas({
        truckId: truck.id,
        truckName: truck.driver ? `${truck.name} (${truck.driver})` : truck.name,
        stopCount: truck.stops.length,
        miles: miles.miles,
        milesSource: miles.source,
        settings: fuelSettings,
      });
    });
  }, [directions, fuelSettings, originPosition, truckRoutes]);

  const fleetGas = useMemo(() => sumFleetGas(gasEstimates), [gasEstimates]);
  const estimateByTruck = useMemo(() => {
    const byId: Record<string, TruckGasEstimate> = {};
    for (const estimate of gasEstimates) byId[estimate.truckId] = estimate;
    return byId;
  }, [gasEstimates]);

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
    <div className="map-view__canvas">
    <GoogleMap
      mapContainerStyle={containerStyle}
      center={originPosition}
      zoom={10}
      onLoad={(map) => {
        mapRef.current = map;
        map.panTo(originPosition);
      }}
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
      <Marker
        position={originPosition}
        title={`Depot: ${originAddress}`}
        icon={originDotIcon()}
        zIndex={1000}
      />
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
              origin: originAddress,
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
        const truckLabel = truck.driver
          ? `${truck.name} (${truck.driver})`
          : truck.name;
        return legs.map((leg, index) => {
          const stop = truck.stops[index];
          const stopNumber = index + 1;
          const signed = stop ? stopIsSigned(stop, signedKeys) : false;
          return (
            <Marker
              key={`${truck.id}-stop-${index}`}
              position={leg.end_location}
              icon={truckPinIcon(truck.color, signed)}
              label={pinLabel(String(stopNumber))}
              title={`${truckLabel} stop ${stopNumber}: ${
                stop?.customerName || stop?.address || 'Scheduled stop'
              }${signed ? ' · signed' : ''}`}
              onClick={() => {
                if (!stop) return;
                setSelectedStop({
                  truckName: truckLabel,
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
              icon={truckPinIcon('#d8b24f', stopIsSigned(stop, signedKeys))}
              label={pinLabel(String(index + 1))}
              title={`${index + 1}. ${stop.customerName} - ${stop.address}${
                stopIsSigned(stop, signedKeys) ? ' · signed' : ''
              }`}
            />
          ) : null
        )}
      {selectedStop && (
        <InfoWindow
          position={selectedStop.position}
          options={{ maxWidth: 440, minWidth: 320 }}
          onCloseClick={() => setSelectedStop(null)}
        >
          <div className="map-stop-info">
            <strong className="map-stop-info__kicker">
              {selectedStop.truckName} · Stop {selectedStop.stopNumber}
            </strong>
            <div className="map-stop-info__name">
              {selectedStop.stop.customerName || 'Customer TBD'}
            </div>
            <div className="map-stop-info__line">{selectedStop.stop.address || 'No address'}</div>
            <div className="map-stop-info__line">
              {selectedStop.stop.jobType || 'Job type TBD'}
            </div>
            <div className="map-stop-info__line">
              Scheduled: {selectedStop.stop.time || 'Time TBD'}
            </div>
            {stopIsSigned(selectedStop.stop, signedKeys) && (
              <div className="map-stop-info__signed">✓ Customer signed</div>
            )}
            {formatCustomerPhones(selectedStop.stop) ? (
              <div className="map-stop-info__line">
                Phone: {formatCustomerPhones(selectedStop.stop)}
              </div>
            ) : null}
            {selectedStop.stop.notes ? (
              <div className="map-stop-info__notes">
                <strong>Thread &amp; job notes</strong>
                <NotesWithScheduleHighlight
                  className="map-stop-info__notes-body"
                  notes={selectedStop.stop.notes}
                  scheduleDate={selectedDate}
                  evidenceQuote={selectedStop.stop.scheduleEvidenceQuote}
                />
              </div>
            ) : (
              <p className="map-stop-info__empty-notes">No notes on this work order.</p>
            )}
            <button
              type="button"
              className="map-stop-info__wo-link"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenWorkOrder(selectedStop.stop);
              }}
            >
              Open work order PDF
            </button>
          </div>
        </InfoWindow>
      )}
    </GoogleMap>
    {truckRoutes.length > 0 && (
      <div className="map-view__legend" aria-label="Truck legend">
        <strong>Trucks</strong>
        <ul>
          {truckRoutes.map((truck) => (
            <li key={truck.id}>
              <span
                className="map-view__legend-swatch"
                style={{ backgroundColor: truck.color }}
              />
              <span>
                {truck.driver ? `${truck.name} (${truck.driver})` : truck.name} ·{' '}
                {truck.stops.length} {truck.stops.length === 1 ? 'stop' : 'stops'}
                {estimateByTruck[truck.id]?.gallons
                  ? ` · ${estimateByTruck[truck.id].miles} mi · ${estimateByTruck[truck.id].gallons} gal`
                  : ''}
              </span>
            </li>
          ))}
          <li>
            <span className="map-view__legend-swatch map-view__legend-swatch--depot" />
            <span>Shop (route start)</span>
          </li>
          <li>
            <span className="map-view__legend-swatch map-view__legend-swatch--signed" />
            <span>Customer signed</span>
          </li>
          {fleetGas.trucksWithRoutes > 0 && fleetGas.gallons > 0 && (
            <li>
              <span>
                Fuel today · {fleetGas.miles} mi · {fleetGas.gallons} gal
              </span>
            </li>
          )}
        </ul>
      </div>
    )}
    </div>
  );
}

export default function MapView({ selectedDate, onSelectDate }: MapViewProps) {
  const [apiKey, setApiKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [trucks, setTrucks] = useState<Truck[]>([]);
  const [originAddress, setOriginAddress] = useState(DEFAULT_DISPATCH_ORIGIN);
  const [workOrderTickets, setWorkOrderTickets] = useState<JobTicket[]>([]);
  const [pdfStop, setPdfStop] = useState<Stop | null>(null);
  const signedKeys = useMemo(() => signedKeysFromTickets(workOrderTickets), [workOrderTickets]);

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
      setOriginAddress(plan.originAddress || DEFAULT_DISPATCH_ORIGIN);
      setTrucks(
        plan.trucks.map((truck) => ({
          id: truck.id,
          name: truck.name,
          driver: truck.driver,
          stops: truck.stops.filter((stop) => !stop.cancelled).map(dispatchStopToMapStop),
        }))
      );
    });
  }, [selectedDate]);

  const mapWorkOrders = useMemo(() => {
    const numbers: string[] = [];
    const ids: string[] = [];
    for (const truck of trucks) {
      for (const stop of truck.stops) {
        const raw = String(stop.workOrderNumber || '').trim();
        if (raw) {
          numbers.push(raw);
          const stripped = raw.replace(/^#/, '').replace(/^wo\s*/i, '').trim();
          if (stripped && stripped !== raw) numbers.push(stripped);
        }
        if (stop.id) ids.push(stop.id);
      }
    }
    return { numbers, ids };
  }, [trucks]);

  useEffect(() => {
    return subscribeJobTicketsForWorkOrders(
      mapWorkOrders.numbers,
      mapWorkOrders.ids,
      setWorkOrderTickets
    );
  }, [mapWorkOrders]);

  return (
    <div className="map-view">
      <h2>Map · {formatDispatchDay(selectedDate)}</h2>
      <DispatchDayStrip
        selectedDate={selectedDate}
        onSelectDate={onSelectDate}
        label="Map day overview"
      />
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
          <MapCanvas
            key={selectedDate}
            apiKey={apiKey}
            trucks={trucks}
            selectedDate={selectedDate}
            originAddress={originAddress}
            signedKeys={signedKeys}
            onOpenWorkOrder={setPdfStop}
          />
        </div>
      )}
      {pdfStop ? (
        <MapWorkOrderModal
          stop={pdfStop}
          ticket={ticketForMapStop(pdfStop, workOrderTickets, selectedDate)}
          serviceDate={selectedDate}
          onClose={() => setPdfStop(null)}
        />
      ) : null}
      <div style={{ marginTop: '1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        {trucks.every((truck) => truck.stops.length === 0) ? (
          <p>No stops on trucks for this date. Load jobs on Dispatch first.</p>
        ) : (
          <p>
            Showing truck routes from Dispatch. Routes start at {originAddress}.
          </p>
        )}
      </div>
    </div>
  );
}
