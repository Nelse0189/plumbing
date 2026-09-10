import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import type { Request, Response } from "express";

const SHIFTS = "timeShifts";
const SHOP = { lat: 41.63711, lng: -72.75087 };
const SHOP_MILES = 0.25;
const SHOP_DWELL_MS = 15 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function stampToMs(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof admin.firestore.Timestamp) return value.toMillis();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function json(res: Response, status: number, body: Record<string, unknown>) {
  res.status(status).json(body);
}

function easternHour(now = new Date()): number {
  const hourText = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hourCycle: "h23",
  }).format(now);
  return Number.parseInt(hourText, 10);
}

async function closeShift(
  ref: admin.firestore.DocumentReference,
  source: "auto-shop" | "auto-stale",
  gps?: { lat: number; lng: number; accuracy?: number | null },
  at = new Date()
) {
  const patch: Record<string, unknown> = {
    status: "closed",
    clockOutAt: admin.firestore.Timestamp.fromDate(at),
    clockOutSource: source,
  };
  if (gps) {
    patch.clockOut = {
      lat: gps.lat,
      lng: gps.lng,
      accuracy: gps.accuracy ?? null,
      at: at.toISOString(),
    };
    patch.lastPing = patch.clockOut;
    patch.lastPingAt = admin.firestore.Timestamp.fromDate(at);
  }
  await ref.update(patch);
}

async function maybeAutoClose(
  ref: admin.firestore.DocumentReference,
  data: admin.firestore.DocumentData,
  gps: { lat: number; lng: number; accuracy?: number | null },
  at: Date
): Promise<{ closed: boolean; reason?: string }> {
  if (asText(data.status) !== "open") {
    return { closed: true, reason: "already-closed" };
  }
  const atShop = haversineMiles(gps, SHOP) <= SHOP_MILES;
  const leftShop = data.leftShop === true;
  const shopArrivedMs = stampToMs(data.shopArrivedAt);
  const patch: Record<string, unknown> = {
    lastPingAt: admin.firestore.Timestamp.fromDate(at),
    lastPing: { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy ?? null },
  };
  if (!atShop) {
    patch.leftShop = true;
    patch.shopArrivedAt = admin.firestore.FieldValue.delete();
    await ref.update(patch);
    return { closed: false };
  }
  if (!leftShop && data.leftShop !== true) {
    await ref.update(patch);
    return { closed: false };
  }
  if (!shopArrivedMs) {
    patch.shopArrivedAt = admin.firestore.Timestamp.fromDate(at);
    await ref.update(patch);
    return { closed: false };
  }
  if (at.getTime() - shopArrivedMs < SHOP_DWELL_MS) {
    await ref.update(patch);
    return { closed: false };
  }
  const arrived = new Date(shopArrivedMs);
  await closeShift(ref, "auto-shop", gps, arrived);
  return { closed: true, reason: "shop" };
}

export const ingestTimePing = onRequest(
  { cors: true, invoker: "public", memory: "256MiB" },
  async (req: Request, res: Response) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      json(res, 405, { error: "POST only" });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const shiftId = asText(body.shiftId);
    const plumberId = asText(body.plumberId);
    const lat = asNumber(body.lat);
    const lng = asNumber(body.lng);
    if (!shiftId || lat == null || lng == null) {
      json(res, 400, { error: "shiftId, lat, and lng are required" });
      return;
    }
    const accuracy = asNumber(body.accuracy);
    const at = asText(body.at) ? new Date(asText(body.at)) : new Date();
    const when = Number.isNaN(at.getTime()) ? new Date() : at;
    const db = admin.firestore();
    const ref = db.collection(SHIFTS).doc(shiftId);
    const snap = await ref.get();
    if (!snap.exists) {
      json(res, 404, { error: "Unknown shift", closed: true });
      return;
    }
    const data = snap.data() || {};
    if (plumberId && asText(data.plumberId) && asText(data.plumberId) !== plumberId) {
      json(res, 403, { error: "Plumber mismatch", closed: true });
      return;
    }
    const gps = { lat, lng, accuracy };
    await ref.collection("pings").add({
      lat,
      lng,
      accuracy,
      at: admin.firestore.Timestamp.fromDate(when),
      source: asText(body.source) || "ios",
      deviceId: asText(body.deviceId) || null,
    });
    const result = await maybeAutoClose(ref, data, gps, when);
    json(res, 200, { ok: true, ...result });
  }
);

function todayEastern(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isoOf(value: unknown): string {
  const ms = stampToMs(value);
  return ms ? new Date(ms).toISOString() : "";
}

function gpsJson(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const lat = asNumber(record.lat);
  const lng = asNumber(record.lng);
  if (lat == null || lng == null) return null;
  return {
    lat,
    lng,
    accuracy: asNumber(record.accuracy),
    at: asText(record.at) || isoOf(record.at),
  };
}

function shiftJson(
  id: string,
  data: admin.firestore.DocumentData
): Record<string, unknown> {
  return {
    id,
    plumberId: asText(data.plumberId),
    plumberName: asText(data.plumberName),
    truckId: asText(data.truckId) || null,
    date: asText(data.date),
    status: asText(data.status) || "open",
    clockInAt: isoOf(data.clockInAt),
    clockOutAt: isoOf(data.clockOutAt) || null,
    clockOutSource: asText(data.clockOutSource) || null,
    lastPingAt: isoOf(data.lastPingAt) || null,
    lastPing: gpsJson(data.lastPing),
  };
}

function mapRoster(value: unknown): { id: string; name: string; truckId?: string }[] {
  if (!Array.isArray(value)) return [];
  const people: { id: string; name: string; truckId?: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = asText(record.id);
    const name = asText(record.name);
    if (!id || !name) continue;
    const row: { id: string; name: string; truckId?: string } = { id, name };
    const truckId = asText(record.truckId);
    if (truckId) row.truckId = truckId;
    people.push(row);
  }
  return people.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

async function loadRoster(): Promise<{ id: string; name: string; truckId?: string }[]> {
  const snap = await admin.firestore().doc("appConfig/plumbers").get();
  return mapRoster(snap.data()?.people);
}

async function openShiftForPlumber(plumberId: string) {
  const snap = await admin
    .firestore()
    .collection(SHIFTS)
    .where("plumberId", "==", plumberId)
    .where("status", "==", "open")
    .limit(1)
    .get();
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return shiftJson(docSnap.id, docSnap.data());
}

function readGps(body: Record<string, unknown>): {
  lat: number;
  lng: number;
  accuracy: number | null;
} | null {
  const lat = asNumber(body.lat);
  const lng = asNumber(body.lng);
  if (lat == null || lng == null) return null;
  return { lat, lng, accuracy: asNumber(body.accuracy) };
}

export const timeClock = onRequest(
  { cors: true, invoker: "public", memory: "256MiB" },
  async (req: Request, res: Response) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    const db = admin.firestore();
    if (req.method === "GET") {
      const plumberId = asText(req.query.plumberId);
      const plumbers = await loadRoster();
      const shift = plumberId ? await openShiftForPlumber(plumberId) : null;
      json(res, 200, { ok: true, plumbers, shift });
      return;
    }
    if (req.method !== "POST") {
      json(res, 405, { error: "GET or POST only" });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const action = asText(body.action).toLowerCase();
    const deviceId = asText(body.deviceId);
    const gps = readGps(body);

    if (action === "in") {
      const plumberId = asText(body.plumberId);
      const plumbers = await loadRoster();
      const plumber = plumbers.find((person) => person.id === plumberId);
      if (!plumber) {
        json(res, 400, { error: "Pick your name on the app first." });
        return;
      }
      const existing = await openShiftForPlumber(plumberId);
      if (existing) {
        json(res, 200, { ok: true, shift: existing, alreadyOpen: true });
        return;
      }
      if (!gps) {
        json(res, 400, { error: "Allow location, then clock in." });
        return;
      }
      const now = new Date();
      const clockIn = {
        lat: gps.lat,
        lng: gps.lng,
        accuracy: gps.accuracy,
        at: now.toISOString(),
      };
      const atShop = haversineMiles(gps, SHOP) <= SHOP_MILES;
      const ref = await db.collection(SHIFTS).add({
        plumberId: plumber.id,
        plumberName: plumber.name,
        truckId: plumber.truckId || "",
        date: todayEastern(),
        status: "open",
        clockInAt: admin.firestore.Timestamp.fromDate(now),
        clockIn,
        lastPingAt: admin.firestore.Timestamp.fromDate(now),
        lastPing: clockIn,
        leftShop: !atShop,
        deviceId: deviceId || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const snap = await ref.get();
      json(res, 200, { ok: true, shift: shiftJson(ref.id, snap.data() || {}) });
      return;
    }

    if (action === "out") {
      const shiftId = asText(body.shiftId);
      const plumberId = asText(body.plumberId);
      if (!shiftId) {
        json(res, 400, { error: "No open shift." });
        return;
      }
      const ref = db.collection(SHIFTS).doc(shiftId);
      const snap = await ref.get();
      if (!snap.exists) {
        json(res, 404, { error: "Unknown shift", shift: null });
        return;
      }
      const data = snap.data() || {};
      if (plumberId && asText(data.plumberId) !== plumberId) {
        json(res, 403, { error: "Plumber mismatch" });
        return;
      }
      if (asText(data.status) === "closed") {
        json(res, 200, { ok: true, shift: shiftJson(snap.id, data) });
        return;
      }
      const now = new Date();
      const patch: Record<string, unknown> = {
        status: "closed",
        clockOutAt: admin.firestore.Timestamp.fromDate(now),
        clockOutSource: "manual",
      };
      if (gps) {
        const clockOut = {
          lat: gps.lat,
          lng: gps.lng,
          accuracy: gps.accuracy,
          at: now.toISOString(),
        };
        patch.clockOut = clockOut;
        patch.lastPing = clockOut;
        patch.lastPingAt = admin.firestore.Timestamp.fromDate(now);
      }
      await ref.update(patch);
      const updated = await ref.get();
      json(res, 200, {
        ok: true,
        shift: shiftJson(updated.id, updated.data() || {}),
      });
      return;
    }

    json(res, 400, { error: "action must be in or out" });
  }
);

export const closeStaleTimeShifts = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "America/New_York",
    memory: "256MiB",
  },
  async () => {
    const db = admin.firestore();
    const open = await db.collection(SHIFTS).where("status", "==", "open").get();
    const now = Date.now();
    const late = easternHour() >= 22;
    for (const docSnap of open.docs) {
      const data = docSnap.data();
      const lastPingMs =
        stampToMs(data.lastPingAt) || stampToMs(data.clockInAt) || now;
      const lastGps = data.lastPing as
        | { lat?: number; lng?: number; accuracy?: number }
        | undefined;
      const gps =
        lastGps &&
        Number.isFinite(Number(lastGps.lat)) &&
        Number.isFinite(Number(lastGps.lng))
          ? {
              lat: Number(lastGps.lat),
              lng: Number(lastGps.lng),
              accuracy: Number.isFinite(Number(lastGps.accuracy))
                ? Number(lastGps.accuracy)
                : null,
            }
          : undefined;
      const stale = now - lastPingMs >= STALE_MS;
      if (!stale && !late) continue;
      if (gps) {
        const atShop = haversineMiles(gps, SHOP) <= SHOP_MILES;
        const leftShop = data.leftShop === true;
        const shopArrivedMs = stampToMs(data.shopArrivedAt);
        if (atShop && leftShop && shopArrivedMs && now - shopArrivedMs >= SHOP_DWELL_MS) {
          await closeShift(
            docSnap.ref,
            "auto-shop",
            gps,
            new Date(shopArrivedMs)
          );
          continue;
        }
      }
      if (stale || late) {
        await closeShift(
          docSnap.ref,
          "auto-stale",
          gps,
          new Date(lastPingMs)
        );
      }
    }
  }
);
