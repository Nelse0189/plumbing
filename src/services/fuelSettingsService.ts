import {
  doc,
  onSnapshot,
  setDoc,
  Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import type { FuelSettings, NearbyGasStation, TruckFuelProfile } from '../types';
import {
  clampMpg,
  clampPrice,
  DEFAULT_HIGH_PRICE_DELTA,
  DEFAULT_IDLE_BUFFER_PCT,
  DEFAULT_TANK_GALLONS,
  DEFAULT_WORK_VAN_MPG,
  defaultFuelSettings,
} from '../utils/gasEstimate';

const FUEL_DOC = doc(db, 'appConfig', 'fuel');

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapTruckProfiles(value: unknown): Record<string, TruckFuelProfile> {
  if (!value || typeof value !== 'object') return {};
  const trucks: Record<string, TruckFuelProfile> = {};
  for (const [id, profile] of Object.entries(value as Record<string, unknown>)) {
    if (!id || !profile || typeof profile !== 'object') continue;
    const mpg = asNumber((profile as { mpg?: unknown }).mpg);
    trucks[id] = mpg ? { mpg: clampMpg(mpg) } : {};
  }
  return trucks;
}

function mapNearbyStations(value: unknown): NearbyGasStation[] {
  if (!Array.isArray(value)) return [];
  const stations: NearbyGasStation[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = asText(record.name);
    const price = asNumber(record.pricePerGallon);
    if (!name) continue;
    stations.push({
      id: asText(record.id),
      name,
      address: asText(record.address),
      miles: Math.round((asNumber(record.miles) || 0) * 10) / 10,
      pricePerGallon: price && price > 0 ? clampPrice(price) : null,
      priceUpdatedAt: asText(record.priceUpdatedAt) || undefined,
    });
  }
  return stations.slice(0, 8);
}

export function mapFuelSettings(value: unknown): FuelSettings {
  const defaults = defaultFuelSettings();
  if (!value || typeof value !== 'object') return defaults;
  const record = value as Record<string, unknown>;
  const price = asNumber(record.pricePerGallon);
  const eiaPrice = asNumber(record.eiaPricePerGallon);
  const placesPrice = asNumber(record.placesPricePerGallon);
  return {
    pricePerGallon: price && price > 0 ? clampPrice(price) : null,
    defaultMpg: clampMpg(asNumber(record.defaultMpg) || defaults.defaultMpg),
    includeReturnToShop: record.includeReturnToShop !== false,
    idleBufferPct:
      asNumber(record.idleBufferPct) ?? DEFAULT_IDLE_BUFFER_PCT,
    highPriceDelta: asNumber(record.highPriceDelta) ?? DEFAULT_HIGH_PRICE_DELTA,
    tankGallons: asNumber(record.tankGallons) || DEFAULT_TANK_GALLONS,
    trucks: mapTruckProfiles(record.trucks),
    eiaPricePerGallon: eiaPrice && eiaPrice > 0 ? clampPrice(eiaPrice) : null,
    eiaPeriod: asText(record.eiaPeriod) || undefined,
    placesPricePerGallon: placesPrice && placesPrice > 0 ? clampPrice(placesPrice) : null,
    placesStationName: asText(record.placesStationName) || undefined,
    placesStationId: asText(record.placesStationId) || undefined,
    placesFetchedAt: asText(record.placesFetchedAt) || undefined,
    placesStations: mapNearbyStations(record.placesStations),
    updatedAt:
      record.updatedAt &&
      typeof record.updatedAt === 'object' &&
      record.updatedAt !== null &&
      'toDate' in record.updatedAt &&
      typeof (record.updatedAt as { toDate?: () => Date }).toDate === 'function'
        ? (record.updatedAt as { toDate: () => Date }).toDate().toISOString()
        : asText(record.updatedAt) || undefined,
  };
}

export function subscribeFuelSettings(
  onChange: (settings: FuelSettings) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    FUEL_DOC,
    (snap) => {
      onChange(mapFuelSettings(snap.data()));
    },
    (error) => {
      onError?.(error);
    }
  );
}

export async function saveFuelSettings(settings: FuelSettings): Promise<FuelSettings> {
  const next = mapFuelSettings({
    ...settings,
    defaultMpg: clampMpg(settings.defaultMpg || DEFAULT_WORK_VAN_MPG),
    idleBufferPct: settings.idleBufferPct ?? DEFAULT_IDLE_BUFFER_PCT,
    highPriceDelta: settings.highPriceDelta ?? DEFAULT_HIGH_PRICE_DELTA,
    tankGallons: settings.tankGallons || DEFAULT_TANK_GALLONS,
  });
  await setDoc(
    FUEL_DOC,
    {
      pricePerGallon: next.pricePerGallon,
      defaultMpg: next.defaultMpg,
      includeReturnToShop: next.includeReturnToShop,
      idleBufferPct: next.idleBufferPct,
      highPriceDelta: next.highPriceDelta,
      tankGallons: next.tankGallons,
      trucks: next.trucks,
      eiaPricePerGallon: next.eiaPricePerGallon ?? null,
      eiaPeriod: next.eiaPeriod || null,
      placesPricePerGallon: next.placesPricePerGallon ?? null,
      placesStationName: next.placesStationName || null,
      placesStationId: next.placesStationId || null,
      placesFetchedAt: next.placesFetchedAt || null,
      placesStations: next.placesStations || [],
      updatedAt: Timestamp.now(),
    },
    { merge: true }
  );
  return next;
}

export async function saveTruckMpg(
  settings: FuelSettings,
  truckId: string,
  mpg: number
): Promise<FuelSettings> {
  return saveFuelSettings({
    ...settings,
    trucks: {
      ...settings.trucks,
      [truckId]: { mpg: clampMpg(mpg) },
    },
  });
}

export async function saveShopGasPrice(
  settings: FuelSettings,
  pricePerGallon: number | null
): Promise<FuelSettings> {
  return saveFuelSettings({
    ...settings,
    pricePerGallon: pricePerGallon && pricePerGallon > 0 ? clampPrice(pricePerGallon) : null,
  });
}
