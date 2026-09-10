import { haversineMiles } from './distance';
import type {
  FuelSettings,
  GasMilesSource,
  GasReceiptFlag,
  NearbyGasStation,
  TruckFuelProfile,
  TruckGasEstimate,
} from '../types';

export const DEFAULT_WORK_VAN_MPG = 12;
export const DEFAULT_IDLE_BUFFER_PCT = 15;
export const DEFAULT_HIGH_PRICE_DELTA = 0.35;
export const DEFAULT_TANK_GALLONS = 25;
/** Used only until Places, EIA, or a shop price is saved. */
export const FALLBACK_GAS_PRICE = 3.19;
export const ROAD_CIRCUITY = 1.3;

export function defaultFuelSettings(): FuelSettings {
  return {
    pricePerGallon: null,
    defaultMpg: DEFAULT_WORK_VAN_MPG,
    includeReturnToShop: true,
    idleBufferPct: DEFAULT_IDLE_BUFFER_PCT,
    highPriceDelta: DEFAULT_HIGH_PRICE_DELTA,
    tankGallons: DEFAULT_TANK_GALLONS,
    trucks: {},
  };
}

export function clampMpg(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WORK_VAN_MPG;
  return Math.min(40, Math.max(4, Math.round(value * 10) / 10));
}

export function clampPrice(value: number): number {
  if (!Number.isFinite(value)) return FALLBACK_GAS_PRICE;
  return Math.min(9.99, Math.max(1, Math.round(value * 1000) / 1000));
}

export function resolvedGasPrice(settings: FuelSettings): {
  pricePerGallon: number;
  source: 'manual' | 'places' | 'eia' | 'fallback';
} {
  if (settings.pricePerGallon != null && settings.pricePerGallon > 0) {
    return { pricePerGallon: clampPrice(settings.pricePerGallon), source: 'manual' };
  }
  if (settings.placesPricePerGallon != null && settings.placesPricePerGallon > 0) {
    return { pricePerGallon: clampPrice(settings.placesPricePerGallon), source: 'places' };
  }
  if (settings.eiaPricePerGallon != null && settings.eiaPricePerGallon > 0) {
    return { pricePerGallon: clampPrice(settings.eiaPricePerGallon), source: 'eia' };
  }
  return { pricePerGallon: FALLBACK_GAS_PRICE, source: 'fallback' };
}

export function stationPriceLabel(station: Pick<NearbyGasStation, 'name' | 'address'>): string {
  const street = station.address.split(',')[0]?.trim();
  if (street && street.toLowerCase() !== station.name.toLowerCase()) {
    return `${station.name} · ${street}`;
  }
  return station.name || 'nearby station';
}

export function isCitgoStation(station: Pick<NearbyGasStation, 'name' | 'address'>): boolean {
  return /\bcitgo\b/i.test(`${station.name} ${station.address}`);
}

export function pickPreferredGasStation(stations: NearbyGasStation[]): NearbyGasStation | null {
  const priced = stations.filter(
    (station) => station.pricePerGallon != null && station.pricePerGallon > 0
  );
  const citgo = priced
    .filter(isCitgoStation)
    .sort((left, right) => left.miles - right.miles);
  return citgo[0] || priced[0] || null;
}

export function mpgForTruck(settings: FuelSettings, truckId: string): number {
  const override = settings.trucks[truckId]?.mpg;
  return clampMpg(override || settings.defaultMpg || DEFAULT_WORK_VAN_MPG);
}

export function formatGasUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '$0.00';
  return `$${amount.toFixed(2)}`;
}

export function classifyGasReceipt(
  receiptUsd: number | null | undefined,
  budgetUsd: number,
  tankFillUsd: number
): GasReceiptFlag {
  if (receiptUsd == null || !Number.isFinite(receiptUsd) || receiptUsd <= 0) {
    return 'none';
  }
  if (receiptUsd <= budgetUsd * 1.25) return 'ok';
  if (receiptUsd <= tankFillUsd * 1.1) return 'fill_up';
  return 'high';
}

export function estimateTruckGas(input: {
  truckId: string;
  truckName: string;
  stopCount: number;
  miles: number;
  milesSource: GasMilesSource;
  settings: FuelSettings;
  receiptUsd?: number | null;
}): TruckGasEstimate {
  const { pricePerGallon } = resolvedGasPrice(input.settings);
  const mpg = mpgForTruck(input.settings, input.truckId);
  const gallons = input.miles > 0 ? input.miles / mpg : 0;
  const routeCostUsd = gallons * pricePerGallon;
  const budgetUsd = routeCostUsd * (1 + (input.settings.idleBufferPct || 0) / 100);
  const tankFillUsd = (input.settings.tankGallons || DEFAULT_TANK_GALLONS) * pricePerGallon;
  return {
    truckId: input.truckId,
    truckName: input.truckName,
    stopCount: input.stopCount,
    miles: Math.round(input.miles * 10) / 10,
    gallons: Math.round(gallons * 10) / 10,
    mpg,
    pricePerGallon,
    routeCostUsd: Math.round(routeCostUsd * 100) / 100,
    budgetUsd: Math.round(budgetUsd * 100) / 100,
    tankFillUsd: Math.round(tankFillUsd * 100) / 100,
    highPumpPrice: Math.round((pricePerGallon + input.settings.highPriceDelta) * 100) / 100,
    milesSource: input.milesSource,
    receiptUsd: input.receiptUsd,
    receiptFlag: classifyGasReceipt(input.receiptUsd, budgetUsd, tankFillUsd),
  };
}

export function repriceEstimates(
  estimates: TruckGasEstimate[],
  settings: FuelSettings
): TruckGasEstimate[] {
  return estimates.map((item) =>
    estimateTruckGas({
      truckId: item.truckId,
      truckName: item.truckName,
      stopCount: item.stopCount,
      miles: item.miles,
      milesSource: item.milesSource,
      settings,
      receiptUsd: item.receiptUsd,
    })
  );
}

export function sumFleetGas(estimates: TruckGasEstimate[]): {
  miles: number;
  gallons: number;
  budgetUsd: number;
  trucksWithRoutes: number;
} {
  return estimates.reduce(
    (sum, item) => {
      if (item.stopCount === 0) return sum;
      return {
        miles: Math.round((sum.miles + item.miles) * 10) / 10,
        gallons: Math.round((sum.gallons + item.gallons) * 10) / 10,
        budgetUsd: Math.round((sum.budgetUsd + item.budgetUsd) * 100) / 100,
        trucksWithRoutes: sum.trucksWithRoutes + 1,
      };
    },
    { miles: 0, gallons: 0, budgetUsd: 0, trucksWithRoutes: 0 }
  );
}

type GeoPoint = { lat: number; lng: number };

function asFiniteNumber(value: unknown): number | null {
  const miles = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(miles) && miles > 0 ? miles : null;
}

export function radialRouteMiles(
  stops: Array<{ distanceMiles?: number | null }>,
  includeReturnToShop: boolean
): { miles: number; source: GasMilesSource } {
  const distances = stops
    .map((stop) => asFiniteNumber(stop.distanceMiles))
    .filter((miles): miles is number => miles != null);
  if (distances.length === 0) return { miles: 0, source: 'none' };
  const farthest = Math.max(...distances);
  const hops =
    distances.length > 1
      ? distances.reduce((sum, miles) => sum + miles, 0) * 0.12
      : 0;
  return {
    miles: farthest * (includeReturnToShop ? 2 : 1) + hops,
    source: 'haversine',
  };
}

export function chainedRoadMiles(
  origin: GeoPoint | null,
  stops: Array<{ lat?: number; lng?: number }>,
  includeReturnToShop: boolean
): { miles: number; source: GasMilesSource } {
  const points: GeoPoint[] = [];
  if (origin) points.push(origin);
  for (const stop of stops) {
    const lat = asFiniteNumber(stop.lat);
    const lng = asFiniteNumber(stop.lng);
    if (lat != null && lng != null) {
      points.push({ lat, lng });
    }
  }
  if (points.length < 2) return { miles: 0, source: 'none' };

  let miles = 0;
  for (let i = 1; i < points.length; i += 1) {
    miles += haversineMiles(points[i - 1], points[i]);
  }
  if (includeReturnToShop && origin) {
    miles += haversineMiles(points[points.length - 1], origin);
  }
  return { miles: miles * ROAD_CIRCUITY, source: 'haversine' };
}

export function mergeTruckFuel(
  trucks: Record<string, TruckFuelProfile>,
  truckId: string,
  patch: TruckFuelProfile
): Record<string, TruckFuelProfile> {
  return {
    ...trucks,
    [truckId]: {
      ...trucks[truckId],
      ...patch,
    },
  };
}
