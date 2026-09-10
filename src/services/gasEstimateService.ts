import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import type {
  DispatchTruck,
  FuelSettings,
  GasMilesSource,
  NearbyGasStation,
  TruckGasEstimate,
} from '../types';
import { haversineMiles } from '../utils/distance';
import { DEFAULT_DISPATCH_ORIGIN_COORDS } from '../utils/dispatchWindows';
import { loadGoogleMapsJs, resolveGoogleMapsApiKey } from '../utils/mapsKey';
import {
  chainedRoadMiles,
  clampPrice,
  defaultFuelSettings,
  estimateTruckGas,
  pickPreferredGasStation,
  radialRouteMiles,
} from '../utils/gasEstimate';

export interface TruckRouteMiles {
  miles: number;
  source: GasMilesSource;
}

export interface EstimateDispatchFuelResult {
  trucks: Record<string, { miles: number; durationMinutes?: number }>;
  eiaPricePerGallon?: number | null;
  eiaPeriod?: string;
}

export interface NearbyGasPrices {
  stations: NearbyGasStation[];
  preferred: NearbyGasStation | null;
  error?: string;
}

const PLACES_CACHE_MS = 30 * 60 * 1000;
const PLACES_RADIUS_METERS = 10000;
const PLACES_CACHE_VERSION = 'citgo-v1';
let placesCache: { at: number; key: string; result: NearbyGasPrices } | null = null;

function googleMoneyToUsd(price?: {
  units?: string | number;
  nanos?: number;
} | null): number | null {
  if (!price) return null;
  const units = typeof price.units === 'number' ? price.units : Number(price.units || 0);
  const nanos = typeof price.nanos === 'number' ? price.nanos : 0;
  const value = units + nanos / 1e9;
  if (!Number.isFinite(value) || value <= 0) return null;
  return clampPrice(value);
}

function originCacheKey(origin: { lat: number; lng: number }): string {
  return `${PLACES_CACHE_VERSION}|${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}`;
}

export async function fetchNearbyGasStations(
  origin: { lat: number; lng: number } = DEFAULT_DISPATCH_ORIGIN_COORDS
): Promise<NearbyGasPrices> {
  const cacheKey = originCacheKey(origin);
  if (
    placesCache &&
    placesCache.key === cacheKey &&
    Date.now() - placesCache.at < PLACES_CACHE_MS
  ) {
    return placesCache.result;
  }

  try {
    const callable = httpsCallable<
      { lat: number; lng: number },
      NearbyGasPrices
    >(getFunctions(getApp(), 'us-central1'), 'fetchNearbyGasPrices', {
      timeout: 8000,
    });
    const result = await callable({ lat: origin.lat, lng: origin.lng });
    if (result.data?.preferred?.pricePerGallon) {
      placesCache = { at: Date.now(), key: cacheKey, result: result.data };
      return result.data;
    }
  } catch (error) {
    console.warn('fetchNearbyGasPrices function unavailable', error);
  }

  const apiKey = await resolveGoogleMapsApiKey();
  if (!apiKey) {
    return { stations: [], preferred: null, error: 'Maps key missing' };
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.location,places.fuelOptions',
      },
      body: JSON.stringify({
        includedTypes: ['gas_station'],
        maxResultCount: 20,
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: {
            center: { latitude: origin.lat, longitude: origin.lng },
            radius: PLACES_RADIUS_METERS,
          },
        },
      }),
    });
    const data = (await response.json()) as {
      error?: { message?: string };
      places?: Array<{
        id?: string;
        displayName?: { text?: string } | string;
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
        fuelOptions?: {
          fuelPrices?: Array<{
            type?: string;
            updateTime?: string;
            price?: { units?: string | number; nanos?: number };
          }>;
        };
      }>;
    };
    if (!response.ok) {
      return {
        stations: [],
        preferred: null,
        error: data.error?.message || `Places HTTP ${response.status}`,
      };
    }

    const stations = (data.places || [])
      .map((place) => {
        const lat = Number(place.location?.latitude);
        const lng = Number(place.location?.longitude);
        const regular = (place.fuelOptions?.fuelPrices || []).find(
          (row) => row.type === 'REGULAR_UNLEADED'
        );
        const name =
          typeof place.displayName === 'string'
            ? place.displayName
            : place.displayName?.text || '';
        const miles =
          Number.isFinite(lat) && Number.isFinite(lng)
            ? haversineMiles(origin, { lat, lng })
            : 0;
        return {
          id: String(place.id || ''),
          name,
          address: place.formattedAddress || '',
          miles: Math.round(miles * 10) / 10,
          pricePerGallon: googleMoneyToUsd(regular?.price),
          priceUpdatedAt: regular?.updateTime,
        } satisfies NearbyGasStation;
      })
      .filter((station) => station.name)
      .sort((left, right) => left.miles - right.miles);

    const preferred = pickPreferredGasStation(stations);
    const listed = [...stations]
      .sort((left, right) => {
        const leftPreferred = preferred != null && left.id === preferred.id;
        const rightPreferred = preferred != null && right.id === preferred.id;
        if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
        if (left.pricePerGallon == null && right.pricePerGallon == null) {
          return left.miles - right.miles;
        }
        if (left.pricePerGallon == null) return 1;
        if (right.pricePerGallon == null) return -1;
        return left.pricePerGallon - right.pricePerGallon;
      })
      .slice(0, 8);

    const result: NearbyGasPrices = { stations: listed, preferred };
    placesCache = { at: Date.now(), key: cacheKey, result };
    return result;
  } catch (error) {
    return {
      stations: [],
      preferred: null,
      error: error instanceof Error ? error.message : 'Places lookup failed',
    };
  }
}

const milesCache = new Map<string, TruckRouteMiles>();

function routeCacheKey(
  origin: string,
  truckId: string,
  stops: string[],
  includeReturn: boolean
): string {
  return `${includeReturn ? '1' : '0'}|${origin}|${truckId}|${stops.join('>')}`;
}

function milesFromGoogleLegs(
  legs: Array<{ distance?: { value?: number } }> | undefined
): number {
  if (!legs?.length) return 0;
  return legs.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0) / 1609.344;
}

async function drivingMilesFromMapsJs(
  origin: string,
  stops: string[]
): Promise<number | null> {
  const ready = await loadGoogleMapsJs();
  if (!ready || stops.length === 0 || !window.google?.maps?.DirectionsService) {
    return null;
  }
  return new Promise((resolve) => {
    const service = new google.maps.DirectionsService();
    service.route(
      {
        origin,
        destination: origin,
        waypoints: stops.slice(0, 25).map((address) => ({
          location: address,
          stopover: true,
        })),
        travelMode: google.maps.TravelMode.DRIVING,
        optimizeWaypoints: false,
      },
      (result, status) => {
        if (status === google.maps.DirectionsStatus.OK && result) {
          const miles = milesFromGoogleLegs(
            result.routes[0]?.legs.map((leg) => ({
              distance: { value: leg.distance?.value },
            }))
          );
          resolve(miles > 0 ? miles : null);
          return;
        }
        resolve(null);
      }
    );
  });
}

async function fetchDirectionsMilesFn(
  origin: string,
  trucks: Array<{ id: string; stops: string[] }>
): Promise<EstimateDispatchFuelResult | null> {
  try {
    const callable = httpsCallable<
      { origin: string; trucks: Array<{ id: string; stops: string[] }> },
      EstimateDispatchFuelResult
    >(getFunctions(getApp(), 'us-central1'), 'estimateDispatchFuel', {
      timeout: 45000,
    });
    const result = await callable({ origin, trucks });
    return result.data;
  } catch (error) {
    console.warn('estimateDispatchFuel function unavailable', error);
    return null;
  }
}

export function milesFromDirectionsResult(
  result: google.maps.DirectionsResult | undefined,
  origin: { lat: number; lng: number } | null,
  includeReturnToShop: boolean
): TruckRouteMiles {
  const legs = result?.routes?.[0]?.legs;
  const miles = milesFromGoogleLegs(
    legs?.map((leg) => ({ distance: { value: leg.distance?.value } }))
  );
  if (miles <= 0) return { miles: 0, source: 'none' };
  if (!includeReturnToShop || !origin || !legs?.length) {
    return { miles, source: 'directions' };
  }
  const last = legs[legs.length - 1]?.end_location;
  if (!last) return { miles, source: 'directions' };
  const end = { lat: last.lat(), lng: last.lng() };
  const returnMiles = chainedRoadMiles(origin, [end], true).miles;
  return { miles: miles + returnMiles, source: 'directions' };
}

function stopCoords(
  stops: Array<{ lat?: number; lng?: number }>
): Array<{ lat?: number; lng?: number }> {
  return stops.map((stop) => {
    const lat = Number(stop.lat);
    const lng = Number(stop.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
    return {};
  });
}

export async function resolveTruckRouteMiles(input: {
  originAddress: string;
  originCoords: { lat: number; lng: number } | null;
  truck: Pick<DispatchTruck, 'id' | 'stops'>;
  includeReturnToShop: boolean;
  drivingMiles?: number;
}): Promise<TruckRouteMiles> {
  const liveStops = input.truck.stops.filter((stop) => !stop.cancelled);
  const stops = liveStops
    .map((stop) => stop.address?.trim())
    .filter((address): address is string => Boolean(address));
  if (stops.length === 0) return { miles: 0, source: 'none' };

  if (input.drivingMiles != null && input.drivingMiles > 0) {
    return { miles: input.drivingMiles, source: 'directions' };
  }

  const cacheKey = routeCacheKey(
    input.originAddress,
    input.truck.id,
    stops,
    input.includeReturnToShop
  );
  const cached = milesCache.get(cacheKey);
  if (cached && cached.miles > 0) return cached;

  const driving = await drivingMilesFromMapsJs(input.originAddress, stops);
  if (driving && driving > 0) {
    const resolved = { miles: driving, source: 'directions' as const };
    milesCache.set(cacheKey, resolved);
    return resolved;
  }

  const origin = input.originCoords || DEFAULT_DISPATCH_ORIGIN_COORDS;
  const approx = chainedRoadMiles(
    origin,
    stopCoords(liveStops),
    input.includeReturnToShop
  );
  if (approx.miles > 0) {
    milesCache.set(cacheKey, approx);
    return approx;
  }
  const radial = radialRouteMiles(liveStops, input.includeReturnToShop);
  if (radial.miles > 0) {
    milesCache.set(cacheKey, radial);
  }
  return radial;
}

export async function estimateTrucksGas(input: {
  originAddress: string;
  trucks: DispatchTruck[];
  settings?: FuelSettings;
  drivingMilesByTruck?: Record<string, number>;
}): Promise<{
  estimates: TruckGasEstimate[];
  settings: FuelSettings;
  eiaPricePerGallon?: number | null;
  eiaPeriod?: string;
}> {
  const settings = input.settings || defaultFuelSettings();
  const routed = input.trucks.filter((truck) =>
    truck.stops.some((stop) => !stop.cancelled && stop.address?.trim())
  );
  const originCoords = DEFAULT_DISPATCH_ORIGIN_COORDS;
  let functionResult: EstimateDispatchFuelResult | null = null;
  if (routed.length > 0) {
    functionResult = await fetchDirectionsMilesFn(
      input.originAddress,
      routed.map((truck) => ({
        id: truck.id,
        stops: truck.stops
          .filter((stop) => !stop.cancelled)
          .map((stop) => stop.address?.trim())
          .filter((address): address is string => Boolean(address)),
      }))
    );
    if (functionResult?.trucks) {
      for (const [truckId, value] of Object.entries(functionResult.trucks)) {
        if (value.miles > 0) {
          const truck = routed.find((item) => item.id === truckId);
          const stops =
            truck?.stops
              .filter((stop) => !stop.cancelled)
              .map((stop) => stop.address?.trim())
              .filter((address): address is string => Boolean(address)) || [];
          milesCache.set(
            routeCacheKey(
              input.originAddress,
              truckId,
              stops,
              settings.includeReturnToShop
            ),
            { miles: value.miles, source: 'directions' }
          );
        }
      }
    }
  }

  const estimates = await Promise.all(
    input.trucks.map(async (truck) => {
      const miles = await resolveTruckRouteMiles({
        originAddress: input.originAddress,
        originCoords,
        truck,
        includeReturnToShop: settings.includeReturnToShop,
        drivingMiles: input.drivingMilesByTruck?.[truck.id],
      });
      return estimateTruckGas({
        truckId: truck.id,
        truckName: truck.name,
        stopCount: truck.stops.filter((stop) => !stop.cancelled).length,
        miles: miles.miles,
        milesSource: miles.source,
        settings,
        receiptUsd: truck.gasReceiptUsd,
      });
    })
  );

  return {
    estimates,
    settings,
    eiaPricePerGallon: functionResult?.eiaPricePerGallon,
    eiaPeriod: functionResult?.eiaPeriod,
  };
}
