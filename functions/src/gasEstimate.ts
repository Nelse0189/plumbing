import { defineString } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";

const strGoogleMapsApiKey = defineString("GOOGLE_MAPS_API_KEY", { default: "" });
const strEiaApiKey = defineString("EIA_API_KEY", { default: "" });

const EIA_SERIES_ID = "PET.EMM_EPMR_PTE_R1X_DPG.W";

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mapsKey(): string {
  return (
    asText(strGoogleMapsApiKey.value()) ||
    asText(process.env.GOOGLE_MAPS_API_KEY) ||
    asText(process.env.VITE_GOOGLE_MAPS_API_KEY)
  );
}

function eiaKey(): string {
  return asText(strEiaApiKey.value()) || asText(process.env.EIA_API_KEY);
}

type TruckInput = { id: string; stops: string[] };

type TruckMiles = {
  miles: number;
  durationMinutes: number;
};

async function fetchRouteMiles(
  origin: string,
  stops: string[],
  apiKey: string
): Promise<TruckMiles> {
  const clean = stops.map((stop) => asText(stop)).filter(Boolean).slice(0, 25);
  if (!clean.length) return { miles: 0, durationMinutes: 0 };

  const params = new URLSearchParams({
    origin,
    destination: origin,
    mode: "driving",
    key: apiKey,
  });
  params.set("waypoints", clean.join("|"));

  const response = await fetch(
    `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`
  );
  if (!response.ok) {
    throw new Error(`Directions HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    status?: string;
    error_message?: string;
    routes?: Array<{
      legs?: Array<{
        distance?: { value?: number };
        duration?: { value?: number };
      }>;
    }>;
  };
  if (data.status !== "OK") {
    throw new Error(data.error_message || data.status || "Directions failed");
  }
  const legs = data.routes?.[0]?.legs || [];
  const meters = legs.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0);
  const seconds = legs.reduce((sum, leg) => sum + (leg.duration?.value || 0), 0);
  return {
    miles: Math.round((meters / 1609.344) * 10) / 10,
    durationMinutes: Math.round(seconds / 60),
  };
}

const SHOP_COORDS = { lat: 41.63711, lng: -72.75087 };
const PLACES_REFERER = "https://nj-plumbing.web.app/";

type NearbyStation = {
  id: string;
  name: string;
  address: string;
  miles: number;
  pricePerGallon: number | null;
  priceUpdatedAt?: string;
};

function moneyToUsd(price?: { units?: string | number; nanos?: number } | null): number | null {
  if (!price) return null;
  const units = typeof price.units === "number" ? price.units : Number(price.units || 0);
  const nanos = typeof price.nanos === "number" ? price.nanos : 0;
  const value = units + nanos / 1e9;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 1000) / 1000;
}

function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function isCitgo(station: Pick<NearbyStation, "name" | "address">): boolean {
  return /\bcitgo\b/i.test(`${station.name} ${station.address}`);
}

async function fetchNearbyStations(origin: { lat: number; lng: number }): Promise<{
  stations: NearbyStation[];
  preferred: NearbyStation | null;
}> {
  const apiKey = mapsKey();
  if (!apiKey) return { stations: [], preferred: null };

  const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.fuelOptions",
      Referer: PLACES_REFERER,
    },
    body: JSON.stringify({
      includedTypes: ["gas_station"],
      maxResultCount: 20,
      rankPreference: "DISTANCE",
      locationRestriction: {
        circle: {
          center: { latitude: origin.lat, longitude: origin.lng },
          radius: 10000,
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
    throw new Error(data.error?.message || `Places HTTP ${response.status}`);
  }

  const stations = (data.places || [])
    .map((place) => {
      const lat = Number(place.location?.latitude);
      const lng = Number(place.location?.longitude);
      const regular = (place.fuelOptions?.fuelPrices || []).find(
        (row) => row.type === "REGULAR_UNLEADED"
      );
      const name =
        typeof place.displayName === "string"
          ? place.displayName
          : place.displayName?.text || "";
      return {
        id: String(place.id || ""),
        name,
        address: place.formattedAddress || "",
        miles:
          Number.isFinite(lat) && Number.isFinite(lng)
            ? Math.round(haversineMiles(origin, { lat, lng }) * 10) / 10
            : 0,
        pricePerGallon: moneyToUsd(regular?.price),
        priceUpdatedAt: regular?.updateTime,
      };
    })
    .filter((station) => station.name)
    .sort((left, right) => left.miles - right.miles);

  const priced = stations.filter(
    (station) => station.pricePerGallon != null && station.pricePerGallon > 0
  );
  const preferred =
    priced.filter(isCitgo).sort((left, right) => left.miles - right.miles)[0] ||
    priced[0] ||
    null;
  return { stations: stations.slice(0, 8), preferred };
}

export const fetchNearbyGasPrices = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 30, memory: "256MiB" },
  async (request) => {
    const data = (request.data as { lat?: unknown; lng?: unknown } | undefined) || {};
    const lat = typeof data.lat === "number" ? data.lat : SHOP_COORDS.lat;
    const lng = typeof data.lng === "number" ? data.lng : SHOP_COORDS.lng;
    try {
      return await fetchNearbyStations({ lat, lng });
    } catch (error) {
      throw new HttpsError(
        "internal",
        error instanceof Error ? error.message : "Places lookup failed"
      );
    }
  }
);

async function fetchEiaNewEnglandRegular(): Promise<{
  pricePerGallon: number;
  period: string;
} | null> {
  const apiKey = eiaKey();
  if (!apiKey) return null;
  const url = new URL(`https://api.eia.gov/v2/seriesid/${EIA_SERIES_ID}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("length", "1");
  const response = await fetch(url.toString());
  if (!response.ok) return null;
  const data = (await response.json()) as {
    response?: { data?: Array<{ period?: string; value?: number | string }> };
  };
  const row = data.response?.data?.[0];
  const price = typeof row?.value === "number" ? row.value : Number(row?.value);
  const period = asText(row?.period);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { pricePerGallon: Math.round(price * 1000) / 1000, period };
}

export const estimateDispatchFuel = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    const origin = asText((request.data as { origin?: unknown } | undefined)?.origin);
    const trucksInput = (request.data as { trucks?: unknown } | undefined)?.trucks;
    if (!origin) {
      throw new HttpsError("invalid-argument", "origin is required.");
    }
    if (!Array.isArray(trucksInput)) {
      throw new HttpsError("invalid-argument", "trucks is required.");
    }

    const trucks: TruckInput[] = trucksInput
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as { id?: unknown; stops?: unknown };
        const id = asText(record.id);
        if (!id || !Array.isArray(record.stops)) return null;
        return {
          id,
          stops: record.stops.map((stop) => asText(stop)).filter(Boolean),
        };
      })
      .filter((item): item is TruckInput => Boolean(item));

    const apiKey = mapsKey();
    const eia = await fetchEiaNewEnglandRegular();
    const milesByTruck: Record<string, TruckMiles> = {};

    if (apiKey) {
      const results = await Promise.all(
        trucks.map(async (truck) => {
          try {
            return [truck.id, await fetchRouteMiles(origin, truck.stops, apiKey)] as const;
          } catch (error) {
            console.warn("estimateDispatchFuel directions", truck.id, error);
            return [truck.id, { miles: 0, durationMinutes: 0 }] as const;
          }
        })
      );
      for (const [id, miles] of results) {
        milesByTruck[id] = miles;
      }
    }

    return {
      trucks: milesByTruck,
      eiaPricePerGallon: eia?.pricePerGallon ?? null,
      eiaPeriod: eia?.period || null,
    };
  }
);
