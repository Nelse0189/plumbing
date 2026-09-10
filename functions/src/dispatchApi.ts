import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";

const DISPATCH_COLLECTION = "dispatchPlans";

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function todayEastern(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function jsonSafe(value: unknown): unknown {
  if (value == null) return value;
  if (
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    return (value as admin.firestore.Timestamp).toDate().toISOString();
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(nested);
    }
    return out;
  }
  return value;
}

function formatClock(hhmm: string): string {
  const [hourText, minuteText = "00"] = hhmm.split(":");
  const hour = Number.parseInt(hourText, 10);
  if (Number.isNaN(hour)) return hhmm;
  const meridiem = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minuteText === "00"
    ? `${twelve} ${meridiem}`
    : `${twelve}:${minuteText} ${meridiem}`;
}

function withWindowLabel(stop: Record<string, unknown>, index: number) {
  const window =
    stop.window && typeof stop.window === "object"
      ? { ...(stop.window as Record<string, unknown>) }
      : {};
  const start = asText(window.start);
  const end = asText(window.end);
  return {
    ...stop,
    stopIndex: index + 1,
    window: {
      ...window,
      start,
      end,
      label: start && end ? `${formatClock(start)}–${formatClock(end)}` : "",
    },
  };
}

type Plumber = { id: string; name: string; truckId?: string };
type TruckPhone = { id: string; label: string; phone: string };

function mapPlumbers(value: unknown): Plumber[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = asText(record.id);
      const name = asText(record.name);
      if (!id || !name) return null;
      const plumber: Plumber = { id, name };
      if ("truckId" in record) plumber.truckId = asText(record.truckId);
      return plumber;
    })
    .filter((item): item is Plumber => Boolean(item));
}

function mapTruckPhones(value: unknown): Record<string, TruckPhone[]> {
  if (!value || typeof value !== "object") return {};
  const roster: Record<string, TruckPhone[]> = {};
  for (const [truckId, phones] of Object.entries(value as Record<string, unknown>)) {
    if (!truckId || !Array.isArray(phones)) continue;
    roster[truckId] = phones
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const phone = asText(record.phone);
        if (!phone) return null;
        return {
          id: asText(record.id),
          label: asText(record.label),
          phone,
        };
      })
      .filter((item): item is TruckPhone => Boolean(item));
  }
  return roster;
}

async function todaysDispatch() {
  const date = todayEastern();
  const db = admin.firestore();
  const [planSnap, plumberSnap, phoneSnap] = await Promise.all([
    db.collection(DISPATCH_COLLECTION).doc(date).get(),
    db.collection("appConfig").doc("plumbers").get(),
    db.collection("appConfig").doc("truckPhones").get(),
  ]);
  const plumbers = mapPlumbers(plumberSnap.data()?.people);
  const truckPhones = mapTruckPhones(phoneSnap.data()?.trucks);
  const data = (jsonSafe(planSnap.data() || {}) || {}) as Record<string, unknown>;
  const trucksIn = Array.isArray(data.trucks) ? data.trucks : [];
  const trucks = trucksIn.map((truckValue) => {
    const truck =
      truckValue && typeof truckValue === "object"
        ? { ...(truckValue as Record<string, unknown>) }
        : {};
    const id = asText(truck.id);
    const rosterIds = plumbers
      .filter((plumber) => plumber.truckId === id)
      .map((plumber) => plumber.id);
    const storedIds = Array.isArray(truck.plumberIds)
      ? truck.plumberIds.map((value) => asText(value)).filter(Boolean)
      : [];
    const plumberIds = rosterIds.length ? rosterIds : storedIds;
    const plumberNames = plumberIds
      .map((plumberId) => plumbers.find((plumber) => plumber.id === plumberId)?.name)
      .filter((name): name is string => Boolean(name));
    const stops = (Array.isArray(truck.stops) ? truck.stops : []).map((stop, index) =>
      withWindowLabel(
        stop && typeof stop === "object" ? { ...(stop as Record<string, unknown>) } : {},
        index
      )
    );
    return {
      ...truck,
      id,
      name: asText(truck.name) || id,
      driver: plumberNames.join(", ") || asText(truck.driver),
      plumberIds,
      plumbers: plumberNames,
      phones: truckPhones[id] || [],
      gasReceiptUsd:
        typeof truck.gasReceiptUsd === "number" ? truck.gasReceiptUsd : truck.gasReceiptUsd ?? null,
      set: truck.set === true,
      setAt: asText(truck.setAt),
      stops,
    };
  });

  const mapLane = (value: unknown) =>
    (Array.isArray(value) ? value : []).map((stop, index) =>
      withWindowLabel(
        stop && typeof stop === "object" ? { ...(stop as Record<string, unknown>) } : {},
        index
      )
    );

  return {
    ok: true as const,
    date,
    exists: planSnap.exists,
    originAddress: asText(data.originAddress),
    updatedAt: asText(data.updatedAt),
    trucks,
    unassigned: mapLane(data.unassigned),
    notReady: mapLane(data.notReady),
    plumbers,
    truckPhones,
  };
}

export const listDispatch = onRequest(
  { cors: true, invoker: "public", memory: "512MiB" },
  async (req: Request, res: Response) => {
    try {
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      if (req.method !== "GET" && req.method !== "POST") {
        res.status(405).json({ ok: false, error: "Use GET or POST" });
        return;
      }
      res.status(200).json(await todaysDispatch());
    } catch (error) {
      console.error("listDispatch failed:", error);
      res.status(500).json({ ok: false, error: "Could not load dispatch." });
    }
  }
);
