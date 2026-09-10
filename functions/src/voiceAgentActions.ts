import { randomBytes } from "node:crypto";
import * as admin from "firebase-admin";
import { queueShopSms, normalizeUsPhone } from "./smsGateway";

const PENDING = "voiceAgentPendingActions";
const CONFIRM_TTL_MS = 5 * 60 * 1000;
const WINDOW_SLOTS = [
  { start: "10:00", end: "12:00" },
  { start: "11:30", end: "15:30" },
  { start: "13:00", end: "17:00" },
  { start: "14:00", end: "18:00" },
  { start: "15:00", end: "19:00" },
];
/** 216 Christian Lane, Berlin, CT — same fallback the board uses. */
const SHOP_COORDS = { lat: 41.63711, lng: -72.75087 };
const TRUCK_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

type StopRec = Record<string, unknown> & { id: string };
type TruckRec = Record<string, unknown> & {
  id: string;
  name?: string;
  driver?: string;
  plumberIds?: string[];
  /** Locked route: morning texts queued from this truck. */
  set?: boolean;
  stops: StopRec[];
};
type PlanRec = {
  date: string;
  originAddress?: string;
  trucks: TruckRec[];
  unassigned: StopRec[];
  notReady: StopRec[];
};
type PlumberRec = { id: string; name: string; truckId?: string };
type TruckPhoneRec = { id: string; label: string; phone: string };
type JobHit = {
  date: string;
  stopId?: string;
  truckId?: string | null;
  truckName?: string;
  workOrderId: string;
  workOrderNumber: string;
  customerName: string;
  phone: string;
  phones: string[];
  address: string;
  jobType: string;
  status: string;
  cancelled: boolean;
  smsConsent: boolean;
  location: "truck" | "unassigned" | "notReady" | "workOrderOnly";
  score: number;
};
type StaffHit = {
  plumberId: string;
  name: string;
  truckId: string;
  truckName: string;
  phones: TruckPhoneRec[];
  score: number;
};
type PendingSms = {
  type: "send_sms";
  recipients: Array<{ phone: string; name: string }>;
  body: string;
  recipientKind: "plumber" | "customer";
};
type PendingJob = {
  type: "cancel_job";
  job: JobHit;
};
type PendingAssign = {
  type: "assign_job";
  job: JobHit;
  truckId: string;
  truckName: string;
};
type PendingUnassign = {
  type: "unassign_job";
  job: JobHit;
};
type PendingAutoAssign = {
  type: "auto_assign";
  date: string;
  jobIds: string[];
  truckIds: string[];
};
type PendingPayload =
  | PendingSms
  | PendingJob
  | PendingAssign
  | PendingUnassign
  | PendingAutoAssign;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBool(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return text === "true" || text === "yes" || text === "1";
  }
  return false;
}

function db() {
  return admin.firestore();
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: asText(process.env.BUSINESS_TIME_ZONE) || "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function phoneDigits(value: string): string {
  return value.replace(/\D/g, "").slice(-10);
}

function formatPhone(value: string): string {
  const digits = phoneDigits(value);
  if (digits.length !== 10) return value.trim();
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function uniqueJobPhones(...values: Array<string | string[] | undefined | null>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const digits = phoneDigits(raw);
    if (digits.length !== 10 || seen.has(digits)) return;
    seen.add(digits);
    found.push(normalizeUsPhone(raw) || `+1${digits}`);
  };
  for (const value of values) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) add(String(item || ""));
      continue;
    }
    add(String(value));
  }
  return found;
}

function phonesFromRecord(data: Record<string, unknown>): string[] {
  const listed = Array.isArray(data.phones)
    ? data.phones.map((item) => String(item || ""))
    : [];
  return uniqueJobPhones(listed, asText(data.phone));
}

function last4(value: string): string {
  const digits = phoneDigits(value);
  return digits.length === 10 ? digits.slice(-4) : value.trim();
}

function hay(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fuzzyScore(query: string, ...fields: string[]): number {
  const q = hay(query);
  if (!q) return 0;
  const text = hay(fields.join(" "));
  if (!text) return 0;
  if (text === q) return 100;
  if (text.includes(q)) return 86;
  const tokens = q.split(" ").filter((token) => token.length >= 2);
  if (!tokens.length) return 0;
  const hits = tokens.filter((token) => text.includes(token)).length;
  if (!hits) return 0;
  return Math.round((hits / tokens.length) * 70);
}

function applyDefaultWindows(stops: StopRec[]): StopRec[] {
  return stops.map((stop, index) => {
    if (stop.customWindow === true) return stop;
    return { ...stop, window: WINDOW_SLOTS[index % WINDOW_SLOTS.length] };
  });
}

function stopPoint(stop: StopRec): { lat: number; lng: number } | null {
  const lat = Number(stop.lat);
  const lng = Number(stop.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
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

function stopDistance(stop: StopRec): number | null {
  const stored = Number(stop.distanceMiles);
  if (Number.isFinite(stored)) return stored;
  const point = stopPoint(stop);
  return point ? Math.round(haversineMiles(SHOP_COORDS, point) * 10) / 10 : null;
}

/** Farthest from the shop runs first; priority beats distance. Mirrors the board. */
function sortFarthestFirst(stops: StopRec[]): StopRec[] {
  return [...stops].sort((left, right) => {
    const priorityDelta = Number(right.priority || 0) - Number(left.priority || 0);
    if (priorityDelta !== 0) return priorityDelta;
    return (stopDistance(right) ?? -1) - (stopDistance(left) ?? -1);
  });
}

function truckCentroid(stops: StopRec[]): { lat: number; lng: number } {
  const points = stops.map(stopPoint).filter((point): point is { lat: number; lng: number } => Boolean(point));
  if (!points.length) return SHOP_COORDS;
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
  };
}

function activeStops(stops: StopRec[]): StopRec[] {
  return stops.filter((stop) => stop.cancelled !== true);
}

function stopLabel(stop: StopRec): string {
  const bits = [asText(stop.customerName), asText(stop.jobType), asText(stop.address)].filter(Boolean);
  return bits.join(", ") || asText(stop.workOrderNumber) || "a job";
}

function speakList(items: string[]): string {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatWindow(window: unknown): string {
  if (!window || typeof window !== "object") return "";
  const rec = window as { start?: unknown; end?: unknown };
  const start = asText(rec.start);
  const end = asText(rec.end);
  if (!start || !end) return "";
  return `${start}–${end}`;
}

function windowsEqual(left: unknown, right: unknown): boolean {
  return formatWindow(left) === formatWindow(right) && Boolean(formatWindow(left));
}

function parseTruckId(value: string): string {
  const text = hay(value);
  const direct = text.match(/truck\s*(\d)/);
  if (direct) return `truck${direct[1]}`;
  const word = text.match(/truck\s+(one|two|three|four|five|six|seven)/);
  if (word) return `truck${TRUCK_WORDS[word[1]]}`;
  if (/^truck[1-7]$/.test(text.replace(/\s/g, ""))) return text.replace(/\s/g, "");
  return "";
}

function asStopArray(value: unknown): StopRec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => ({
      ...item,
      id: asText(item.id) || `stop-${index}`,
    }));
}

function asTruckArray(value: unknown): TruckRec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => ({
      ...item,
      id: asText(item.id) || `truck${index + 1}`,
      name: asText(item.name) || `Truck ${index + 1}`,
      driver: asText(item.driver) || undefined,
      set: item.set === true,
      plumberIds: Array.isArray(item.plumberIds)
        ? item.plumberIds.map((id) => asText(id)).filter(Boolean)
        : [],
      stops: asStopArray(item.stops),
    }));
}

function planFromData(date: string, data: FirebaseFirestore.DocumentData | undefined): PlanRec {
  return {
    date,
    originAddress: asText(data?.originAddress) || undefined,
    trucks: asTruckArray(data?.trucks),
    unassigned: asStopArray(data?.unassigned),
    notReady: asStopArray(data?.notReady),
  };
}

function compactJob(job: JobHit) {
  return {
    date: job.date,
    workOrderId: job.workOrderId,
    workOrderNumber: job.workOrderNumber,
    customerName: job.customerName,
    phone: job.phone,
    phones: job.phones,
    address: job.address,
    jobType: job.jobType,
    status: job.status,
    cancelled: job.cancelled,
    smsConsent: job.smsConsent,
    truckName: job.truckName || "",
    location: job.location,
  };
}

function jobFromStop(
  date: string,
  stop: StopRec,
  location: JobHit["location"],
  truck?: TruckRec
): JobHit {
  return {
    date,
    stopId: asText(stop.id),
    truckId: truck?.id || null,
    truckName: asText(truck?.name),
    workOrderId: asText(stop.workOrderId) || asText(stop.id),
    workOrderNumber: asText(stop.workOrderNumber),
    customerName: asText(stop.customerName),
    phone: asText(stop.phone),
    phones: phonesFromRecord(stop),
    address: asText(stop.address),
    jobType: asText(stop.jobType),
    status: asText(stop.status),
    cancelled: stop.cancelled === true,
    smsConsent: stop.smsConsent === true,
    location,
    score: 0,
  };
}

function jobFromWorkOrder(id: string, data: FirebaseFirestore.DocumentData): JobHit {
  const date = asText(data.appointmentDate);
  return {
    date,
    workOrderId: id,
    workOrderNumber: asText(data.workOrderNumber) || id,
    customerName: asText(data.customerName),
    phone: asText(data.phone),
    phones: phonesFromRecord(data as Record<string, unknown>),
    address: asText(data.address),
    jobType: asText(data.jobType),
    status: asText(data.status),
    cancelled: data.cancelled === true,
    smsConsent: data.smsConsent === true,
    location: "workOrderOnly",
    score: 0,
  };
}

function scoreJob(
  job: JobHit,
  input: {
    workOrderNumber?: string;
    customerName?: string;
    phone?: string;
    address?: string;
    jobType?: string;
    query?: string;
  }
): number {
  let score = 0;
  const number = asText(input.workOrderNumber);
  if (number && hay(job.workOrderNumber) === hay(number)) score += 100;
  else if (number) score += fuzzyScore(number, job.workOrderNumber);
  const phone = phoneDigits(asText(input.phone));
  if (phone && job.phones.some((item) => phoneDigits(item) === phone)) score += 90;
  if (input.customerName) score += fuzzyScore(input.customerName, job.customerName);
  if (input.address) score += fuzzyScore(input.address, job.address);
  if (input.jobType) score += fuzzyScore(input.jobType, job.jobType);
  if (input.query) {
    score += fuzzyScore(
      input.query,
      job.workOrderNumber,
      job.customerName,
      job.address,
      job.jobType,
      job.phone,
      job.phones.join(" "),
      job.truckName || ""
    );
  }
  return score;
}

function collectPlanJobs(date: string, plan: PlanRec): JobHit[] {
  const jobs: JobHit[] = [];
  for (const truck of plan.trucks) {
    for (const stop of truck.stops) jobs.push(jobFromStop(date, stop, "truck", truck));
  }
  for (const stop of plan.unassigned) jobs.push(jobFromStop(date, stop, "unassigned"));
  for (const stop of plan.notReady) jobs.push(jobFromStop(date, stop, "notReady"));
  return jobs;
}

async function loadPlan(date: string): Promise<PlanRec | null> {
  const snap = await db().collection("dispatchPlans").doc(date).get();
  if (!snap.exists) return null;
  return planFromData(date, snap.data());
}

async function savePlan(plan: PlanRec) {
  await db()
    .collection("dispatchPlans")
    .doc(plan.date)
    .set(
      {
        date: plan.date,
        trucks: plan.trucks,
        unassigned: plan.unassigned,
        notReady: plan.notReady,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

async function cancelPendingMorningText(date: string, truckId: string, stopId: string) {
  const id = `dispatch-${date}-${truckId}-${stopId}`.slice(0, 700);
  const ref = db().collection("morningConfirmations").doc(id);
  const snap = await ref.get();
  if (snap.exists && asText(snap.data()?.status) === "pending") {
    await ref.delete();
  }
}

async function refreshMorningWindows(date: string, previous: TruckRec | undefined, next: TruckRec) {
  if (!previous) return;
  const before = new Map(previous.stops.map((stop) => [stop.id, stop]));
  for (const stop of next.stops) {
    const prior = before.get(stop.id);
    if (!prior || windowsEqual(prior.window, stop.window)) continue;
    const id = `dispatch-${date}-${next.id}-${stop.id}`.slice(0, 700);
    const ref = db().collection("morningConfirmations").doc(id);
    const snap = await ref.get();
    if (!snap.exists || asText(snap.data()?.status) !== "pending") continue;
    const window = stop.window as { start?: string; end?: string } | undefined;
    await ref.update({
      appointmentTime: formatWindow(window),
      windowStart: asText(window?.start),
      windowEnd: asText(window?.end),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function syncTruckSchedule(date: string, truck: TruckRec) {
  const ref = db().collection("schedules").doc(date);
  const snap = await ref.get();
  const existing = Array.isArray(snap.data()?.trucks) ? (snap.data()?.trucks as Array<Record<string, unknown>>) : [];
  const mappedStops = truck.stops
    .filter((stop) => stop.cancelled !== true)
    .map((stop) => ({
      id: asText(stop.workOrderId) || stop.id,
      workOrderNumber: asText(stop.workOrderNumber),
      customerName: asText(stop.customerName),
      phone: asText(stop.phone),
      address: asText(stop.address),
      jobType: asText(stop.jobType),
      notes: asText(stop.notes),
      time: asText((stop.window as { start?: unknown } | undefined)?.start),
    }));
  let found = false;
  const trucks = existing.map((item) => {
    if (asText(item.id) !== truck.id) return item;
    found = true;
    return {
      ...item,
      name: truck.name,
      driver: truck.driver,
      plumberIds: truck.plumberIds || [],
      stops: mappedStops,
    };
  });
  if (!found) {
    trucks.push({
      id: truck.id,
      name: truck.name,
      driver: truck.driver,
      plumberIds: truck.plumberIds || [],
      stops: mappedStops,
    });
  }
  await ref.set(
    {
      date,
      trucks,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

function mapPlumbers(value: unknown): PlumberRec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => ({
      id: asText(item.id) || `pl-${index}`,
      name: asText(item.name),
      truckId: "truckId" in item ? asText(item.truckId) : undefined,
    }))
    .filter((item) => item.name);
}

function mapPhones(value: unknown): TruckPhoneRec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => ({
      id: asText(item.id) || `tp-${index}`,
      label: asText(item.label),
      phone: asText(item.phone),
    }))
    .filter((item) => phoneDigits(item.phone).length === 10);
}

async function loadStaff(): Promise<{
  plumbers: PlumberRec[];
  phones: Record<string, TruckPhoneRec[]>;
}> {
  const [peopleSnap, phoneSnap] = await Promise.all([
    db().collection("appConfig").doc("plumbers").get(),
    db().collection("appConfig").doc("truckPhones").get(),
  ]);
  const phonesRaw = phoneSnap.data()?.trucks;
  const phones: Record<string, TruckPhoneRec[]> = {};
  if (phonesRaw && typeof phonesRaw === "object") {
    for (const [truckId, list] of Object.entries(phonesRaw as Record<string, unknown>)) {
      phones[truckId] = mapPhones(list);
    }
  }
  return { plumbers: mapPlumbers(peopleSnap.data()?.people), phones };
}

function truckLabel(truckId: string, trucks: TruckRec[]): string {
  const truck = trucks.find((item) => item.id === truckId);
  return asText(truck?.name) || truckId.replace(/^truck/i, "Truck ");
}

function staffHits(
  plumbers: PlumberRec[],
  phones: Record<string, TruckPhoneRec[]>,
  trucks: TruckRec[],
  query: string
): StaffHit[] {
  const hits: StaffHit[] = [];
  const wantedTruck = parseTruckId(query);
  for (const plumber of plumbers) {
    const truckId =
      plumber.truckId ||
      trucks.find((truck) => (truck.plumberIds || []).includes(plumber.id))?.id ||
      "";
    const truck = trucks.find((item) => item.id === truckId);
    const score = Math.max(
      fuzzyScore(query, plumber.name, asText(truck?.driver), asText(truck?.name), truckId),
      wantedTruck && wantedTruck === truckId ? 90 : 0
    );
    hits.push({
      plumberId: plumber.id,
      name: plumber.name,
      truckId,
      truckName: truckLabel(truckId, trucks),
      phones: phones[truckId] || [],
      score: query ? score : 50,
    });
  }
  if (wantedTruck && !hits.some((hit) => hit.truckId === wantedTruck)) {
    hits.push({
      plumberId: "",
      name: asText(trucks.find((item) => item.id === wantedTruck)?.driver) || truckLabel(wantedTruck, trucks),
      truckId: wantedTruck,
      truckName: truckLabel(wantedTruck, trucks),
      phones: phones[wantedTruck] || [],
      score: 80,
    });
  }
  return hits
    .filter((hit) => (query ? hit.score >= 35 : true))
    .sort((left, right) => right.score - left.score);
}

async function loadJobsForDate(date: string): Promise<JobHit[]> {
  const [plan, orders] = await Promise.all([
    loadPlan(date),
    db().collection("workOrders").where("appointmentDate", "==", date).limit(80).get(),
  ]);
  const found = new Map<string, JobHit>();
  if (plan) {
    for (const job of collectPlanJobs(date, plan)) {
      found.set(job.workOrderId || job.stopId || job.workOrderNumber, job);
    }
  }
  for (const doc of orders.docs) {
    const job = jobFromWorkOrder(doc.id, doc.data());
    const key = job.workOrderId || job.workOrderNumber;
    if (!found.has(key)) found.set(key, job);
    else {
      const current = found.get(key)!;
      if (!current.smsConsent && job.smsConsent) current.smsConsent = true;
      if (!current.phone && job.phone) current.phone = job.phone;
      current.phones = uniqueJobPhones(current.phones, job.phones);
      if (!current.status && job.status) current.status = job.status;
    }
  }
  return Array.from(found.values());
}

async function resolveJobs(input: {
  workOrderNumber?: string;
  customerName?: string;
  phone?: string;
  address?: string;
  jobType?: string;
  query?: string;
  date?: string;
}): Promise<JobHit[]> {
  const date = asText(input.date);
  const dates = isIsoDate(date) ? [date] : [todayIso()];
  if (!isIsoDate(date)) {
    const today = new Date(`${todayIso()}T12:00:00`);
    for (let offset = 1; offset <= 6; offset += 1) {
      const next = new Date(today.getTime() - offset * 24 * 60 * 60 * 1000);
      dates.push(next.toISOString().slice(0, 10));
    }
  }
  const number = asText(input.workOrderNumber);
  const hits: JobHit[] = [];
  if (number) {
    const [byNumber, byId] = await Promise.all([
      db().collection("workOrders").where("workOrderNumber", "==", number).limit(8).get(),
      db().collection("workOrders").doc(number).get(),
    ]);
    byNumber.docs.forEach((doc) => hits.push(jobFromWorkOrder(doc.id, doc.data())));
    if (byId.exists) hits.push(jobFromWorkOrder(byId.id, byId.data() || {}));
  }
  const phone = asText(input.phone);
  if (phone) {
    const digits = phoneDigits(phone);
    const variants = Array.from(
      new Set([phone, digits, `+1${digits}`, `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`])
    ).filter((item) => item.length >= 10);
    if (variants.length) {
      const sliced = variants.slice(0, 8);
      const [byPhone, byPhones] = await Promise.all([
        db().collection("workOrders").where("phone", "in", sliced).limit(12).get(),
        db()
          .collection("workOrders")
          .where("phones", "array-contains-any", sliced)
          .limit(12)
          .get()
          .catch(() => null),
      ]);
      byPhone.docs.forEach((doc) => hits.push(jobFromWorkOrder(doc.id, doc.data())));
      byPhones?.docs.forEach((doc) => hits.push(jobFromWorkOrder(doc.id, doc.data())));
    }
  }
  for (const day of dates) {
    const dayJobs = await loadJobsForDate(day);
    hits.push(...dayJobs);
  }
  const unique = new Map<string, JobHit>();
  for (const job of hits) {
    const key = `${job.date}|${job.workOrderId || job.workOrderNumber}`;
    const scored = { ...job, score: scoreJob(job, input) };
    const current = unique.get(key);
    if (!current || scored.score > current.score) unique.set(key, scored);
  }
  const ranked = Array.from(unique.values())
    .filter((job) => job.score >= 40)
    .sort((left, right) => right.score - left.score);
  if (ranked.length) return ranked.slice(0, 8);
  return Array.from(unique.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .filter((job) => job.score > 0);
}

function pickJobs(jobs: JobHit[]): { job?: JobHit; ambiguous?: JobHit[] } {
  if (!jobs.length) return {};
  if (jobs.length === 1) return { job: jobs[0] };
  if (jobs[0].score >= jobs[1].score + 18) return { job: jobs[0] };
  return { ambiguous: jobs.slice(0, 5) };
}

async function isOptedOut(phone: string): Promise<boolean> {
  const digits = phoneDigits(phone);
  if (digits.length !== 10) return false;
  const variants = [`+1${digits}`, `1${digits}`, digits, `+${digits}`];
  for (const variant of variants) {
    const snap = await db().collection("smsOptOuts").doc(encodeURIComponent(variant)).get();
    if (snap.exists) return true;
  }
  const snap = await db().collection("smsOptOuts").where("phoneNumber", "in", variants).limit(1).get();
  return !snap.empty;
}

async function shopPhoneWarning(): Promise<string> {
  const snap = await db().collection("smsGatewayStatus").doc("phone").get();
  const seen = snap.data()?.lastSeenAt as { toDate?: () => Date } | undefined;
  const at = seen?.toDate?.()?.getTime();
  if (!at) return "Shop phone has not checked in. The text will queue until the Android app is running.";
  if (Date.now() - at > 45 * 1000) {
    return "Shop phone last checked in more than a minute ago. The text will queue until the Android app is running.";
  }
  return "";
}

async function writePending(payload: PendingPayload): Promise<string> {
  const id = randomBytes(12).toString("hex");
  await db()
    .collection(PENDING)
    .doc(id)
    .set({
      payload,
      createdAt: Date.now(),
      expiresAt: Date.now() + CONFIRM_TTL_MS,
    });
  return id;
}

async function takePending(
  id: string,
  type: PendingPayload["type"]
): Promise<{ ok: true; payload: PendingPayload } | { ok: false; error: string }> {
  const confirmationId = asText(id);
  if (!confirmationId) {
    return {
      ok: false,
      error:
        "This action needs a spoken confirmation. Call again without confirmed to get a confirmationId, read speakThis, then call with confirmed true and that confirmationId.",
    };
  }
  const ref = db().collection(PENDING).doc(confirmationId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, error: "That confirmation expired. Preview the action again." };
  const data = snap.data() || {};
  const expiresAt = Number(data.expiresAt || 0);
  if (Date.now() > expiresAt) {
    await ref.delete();
    return { ok: false, error: "That confirmation expired. Preview the action again." };
  }
  const payload = data.payload as PendingPayload | undefined;
  if (!payload || payload.type !== type) {
    return { ok: false, error: "That confirmation was for a different action. Preview it again." };
  }
  await ref.delete();
  return { ok: true, payload };
}

function spokenJob(job: JobHit): string {
  const bits = [
    job.customerName || "the customer",
    job.workOrderNumber ? `work order ${job.workOrderNumber}` : "",
    job.jobType,
    job.address,
    job.truckName ? `on ${job.truckName}` : "",
    job.date,
  ].filter(Boolean);
  return bits.join(", ");
}

export function extraAgentTools() {
  return [
    {
      type: "function",
      name: "lookup_staff",
      description:
        "Live plumber roster, truck assignments, and truck phone numbers. Use before texting a plumber or when staff ask who is on a truck.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional plumber name, truck name, or truck number.",
          },
          date: { type: "string", description: "Optional YYYY-MM-DD. Defaults to today." },
        },
      },
    },
    {
      type: "function",
      name: "lookup_sms_thread",
      description: "Load recent shop-phone texts to or from a plumber or customer number.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string" },
          plumberName: { type: "string" },
          customerName: { type: "string" },
          workOrderNumber: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "send_sms",
      description:
        "Queue a shop-phone text to a plumber (truck roster) or a customer (work-order phone). Always preview first. On the first call omit confirmed. Speak speakThis. Only after the user clearly says yes, call again with confirmed true and the returned confirmationId. Never invent a phone number.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["plumber", "customer"] },
          message: { type: "string", description: "The exact text to send." },
          plumberName: { type: "string" },
          truckId: { type: "string" },
          workOrderNumber: { type: "string" },
          customerName: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          jobType: { type: "string" },
          query: { type: "string", description: "Free text to find the plumber or customer if names are messy." },
          date: { type: "string" },
          confirmed: { type: "boolean" },
          confirmationId: { type: "string" },
        },
        required: ["kind", "message"],
      },
    },
    {
      type: "function",
      name: "cancel_job",
      description:
        "Cancel a job on the dispatch board. The stop is flagged cancelled and taken off the truck; the work order is kept and staff can undo it on the board. Use when staff say cancel, kill, or get rid of the job. If they only want it off the truck but still scheduled, use unassign_job instead. Preview first, then confirm.",
      parameters: {
        type: "object",
        properties: {
          workOrderNumber: { type: "string" },
          customerName: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          jobType: { type: "string" },
          query: { type: "string" },
          date: { type: "string" },
          confirmed: { type: "boolean" },
          confirmationId: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "assign_job_to_truck",
      description:
        "Put one job from Ready / Unassigned (or another truck) onto a truck for the day. Use when staff say put the Smith job on truck 3, give that to Dylan, or move it to truck 1. The truck is then re-ordered farthest-first and windows refresh. Preview first, then confirm.",
      parameters: {
        type: "object",
        properties: {
          truck: {
            type: "string",
            description: "Truck number or name, or the plumber's name (for example: truck 3, three, Dylan).",
          },
          workOrderNumber: { type: "string" },
          customerName: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          jobType: { type: "string" },
          query: { type: "string" },
          date: { type: "string", description: "Optional YYYY-MM-DD. Defaults to today." },
          confirmed: { type: "boolean" },
          confirmationId: { type: "string" },
        },
        required: ["truck"],
      },
    },
    {
      type: "function",
      name: "unassign_job",
      description:
        "Take a job off its truck and put it back in Ready / Unassigned. Not a cancel; the job stays on the board waiting for a truck. Preview first, then confirm.",
      parameters: {
        type: "object",
        properties: {
          workOrderNumber: { type: "string" },
          customerName: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          jobType: { type: "string" },
          query: { type: "string" },
          date: { type: "string" },
          confirmed: { type: "boolean" },
          confirmationId: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "auto_assign_jobs",
      description:
        "Set up the trucks: spread every Ready / Unassigned job across the trucks that are not yet set, keeping nearby jobs together and load-balancing, then order each truck farthest-first. Same as the board's auto-assign button. Use when staff say set up the trucks, assign the ready jobs, or build today's routes. Preview first, then confirm.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Optional YYYY-MM-DD. Defaults to today." },
          confirmed: { type: "boolean" },
          confirmationId: { type: "string" },
        },
      },
    },
  ];
}

export async function enrichDayLookup<T extends { date: string; dispatchTrucks: unknown[] }>(
  payload: T
) {
  const [{ plumbers, phones }, plan] = await Promise.all([
    loadStaff(),
    loadPlan(payload.date),
  ]);
  const trucks = plan?.trucks || [];
  const dispatchTrucks = payload.dispatchTrucks.map((raw) => {
    const truck = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = asText(truck.id);
    const assigned = plumbers.filter(
      (plumber) =>
        plumber.truckId === id || (trucks.find((item) => item.id === id)?.plumberIds || []).includes(plumber.id)
    );
    return {
      ...truck,
      plumbers: assigned.map((item) => item.name),
      phones: (phones[id] || []).map((item) => ({
        label: item.label,
        phone: formatPhone(item.phone),
      })),
    };
  });
  return { ...payload, dispatchTrucks };
}

export async function lookupWorkOrderLive(input: {
  workOrderNumber?: string;
  customerName?: string;
  phone?: string;
  address?: string;
  jobType?: string;
  query?: string;
  date?: string;
}) {
  const jobs = await resolveJobs(input);
  return {
    matches: jobs.map(compactJob),
    note: jobs.length ? undefined : "No close matches. Try a work-order number, a fuller name, or today's date.",
  };
}

async function lookupStaff(query: string, date: string) {
  const day = isIsoDate(date) ? date : todayIso();
  const [staff, plan] = await Promise.all([loadStaff(), loadPlan(day)]);
  const trucks = plan?.trucks || [];
  const hits = staffHits(staff.plumbers, staff.phones, trucks, query);
  return {
    date: day,
    people: hits.map((hit) => ({
      plumberId: hit.plumberId,
      name: hit.name,
      truckId: hit.truckId,
      truckName: hit.truckName,
      phones: hit.phones.map((phone) => ({
        label: phone.label,
        phone: formatPhone(phone.phone),
      })),
    })),
  };
}

async function lookupSmsThread(input: {
  phone?: string;
  plumberName?: string;
  customerName?: string;
  workOrderNumber?: string;
}) {
  let phone = asText(input.phone);
  let who = "";
  if (!phone && asText(input.plumberName)) {
    const staff = await lookupStaff(input.plumberName || "", todayIso());
    const first = staff.people.find((person) => person.phones.length);
    phone = first?.phones[0]?.phone || "";
    who = first?.name || "";
    if (staff.people.filter((person) => person.phones.length).length > 1) {
      return {
        ambiguous: staff.people,
        speakThis: "I found more than one plumber. Which person should I open the text thread for?",
      };
    }
  }
  if (!phone && (asText(input.customerName) || asText(input.workOrderNumber))) {
    const jobs = await resolveJobs({
      customerName: input.customerName,
      workOrderNumber: input.workOrderNumber,
      query: input.customerName,
    });
    const picked = pickJobs(jobs);
    if (picked.ambiguous) {
      return {
        ambiguous: picked.ambiguous.map(compactJob),
        speakThis: "I found more than one customer. Which job should I open the text thread for?",
      };
    }
    phone = picked.job?.phone || "";
    who = picked.job?.customerName || "";
  }
  const digits = phoneDigits(phone);
  if (digits.length !== 10) {
    return { error: "I need a phone number, plumber name, or customer name to load a text thread." };
  }
  const [outbox, inbox] = await Promise.all([
    db().collection("smsOutbox").orderBy("createdAt", "desc").limit(80).get(),
    db().collection("smsInbox").orderBy("receivedAt", "desc").limit(80).get(),
  ]);
  const stamp = (value: unknown) => {
    if (value && typeof value === "object" && "toDate" in value) {
      try {
        return (value as { toDate: () => Date }).toDate().toISOString();
      } catch {
        return "";
      }
    }
    return "";
  };
  const messages = [
    ...outbox.docs
      .filter((doc) => phoneDigits(asText(doc.data().to)) === digits)
      .map((doc) => ({
        direction: "out" as const,
        body: asText(doc.data().body).slice(0, 400),
        status: asText(doc.data().status),
        at: stamp(doc.data().sentAt) || stamp(doc.data().createdAt),
      })),
    ...inbox.docs
      .filter((doc) => phoneDigits(asText(doc.data().from)) === digits)
      .map((doc) => ({
        direction: "in" as const,
        body: asText(doc.data().body).slice(0, 400),
        at: stamp(doc.data().receivedAt),
      })),
  ]
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-20);
  return {
    who,
    phone: formatPhone(phone),
    messages,
    note: messages.length ? undefined : "No shop-phone texts found for that number.",
  };
}

async function previewOrConfirm(
  args: Record<string, unknown>,
  type: PendingPayload["type"],
  build: () => Promise<
    | { payload: PendingPayload; speakThis: string; preview: Record<string, unknown> }
    | { error: string }
    | { ambiguous: unknown; speakThis: string }
  >
): Promise<{ mode: "execute"; payload: PendingPayload } | { mode: "reply"; value: unknown }> {
  if (asBool(args.confirmed)) {
    const pending = await takePending(asText(args.confirmationId), type);
    if (!pending.ok) return { mode: "reply", value: { error: pending.error } };
    return { mode: "execute", payload: pending.payload };
  }
  const built = await build();
  if ("payload" in built) {
    const confirmationId = await writePending(built.payload);
    return {
      mode: "reply",
      value: {
        needsConfirmation: true,
        confirmationId,
        speakThis: built.speakThis,
        preview: built.preview,
      },
    };
  }
  return { mode: "reply", value: built };
}

async function sendSms(args: Record<string, unknown>) {
  const result = await previewOrConfirm(args, "send_sms", async () => {
    const kind = asText(args.kind) === "plumber" ? "plumber" : asText(args.kind) === "customer" ? "customer" : "";
    const message = asText(args.message).slice(0, 1600);
    if (!kind) return { error: "kind must be plumber or customer." };
    if (!message) return { error: "A message is required." };
    const recipients: Array<{ phone: string; name: string }> = [];
    let consentNote = "";
    if (kind === "plumber") {
      const query = asText(args.plumberName) || asText(args.truckId) || asText(args.query) || asText(args.phone);
      if (!query && !asText(args.phone)) {
        return { error: "Name a plumber, a truck, or a phone number." };
      }
      if (asText(args.phone) && phoneDigits(asText(args.phone)).length === 10 && !asText(args.plumberName)) {
        recipients.push({ phone: normalizeUsPhone(asText(args.phone)), name: asText(args.plumberName) || "plumber" });
      } else {
        const staff = await lookupStaff(query, asText(args.date) || todayIso());
        const withPhones = staff.people.filter((person) => person.phones.length);
        if (!withPhones.length) return { error: "No truck phone is saved for that plumber." };
        const other = withPhones[1];
        if (other && withPhones[0].plumberId !== other.plumberId) {
          return {
            ambiguous: withPhones.map((person) => ({
              name: person.name,
              truckName: person.truckName,
              phones: person.phones,
            })),
            speakThis: "I found more than one plumber with a phone. Which one should I text?",
          };
        }
        const person = withPhones[0];
        if (!person) return { error: "No truck phone is saved for that plumber." };
        for (const phone of person.phones) {
          recipients.push({
            phone: normalizeUsPhone(phone.phone),
            name: phone.label ? `${person.name} (${phone.label})` : person.name,
          });
        }
      }
    } else {
      const jobs = await resolveJobs({
        workOrderNumber: asText(args.workOrderNumber),
        customerName: asText(args.customerName),
        phone: asText(args.phone),
        address: asText(args.address),
        jobType: asText(args.jobType),
        query: asText(args.query) || asText(args.customerName) || asText(args.jobType),
        date: asText(args.date),
      });
      const picked = pickJobs(jobs);
      if (picked.ambiguous) {
        return {
          ambiguous: picked.ambiguous.map(compactJob),
          speakThis: "I found more than one customer. Which job should I text about?",
        };
      }
      if (!picked.job) return { error: "I could not find that customer or work order." };
      if (!phoneDigits(picked.job.phone) && picked.job.phones.length === 0) {
        return { error: "That work order has no phone number." };
      }
      if (!picked.job.smsConsent) {
        consentNote = "No SMS consent is on file for this customer.";
      }
      const jobPhones = uniqueJobPhones(picked.job.phones, picked.job.phone);
      const namedPhone = phoneDigits(asText(args.phone));
      const selected = namedPhone
        ? jobPhones.filter((phone) => phoneDigits(phone) === namedPhone)
        : jobPhones;
      if (namedPhone && selected.length === 0) {
        return { error: "That number is not on this work order." };
      }
      for (const phone of selected.length ? selected : jobPhones) {
        recipients.push({
          phone: normalizeUsPhone(phone),
          name: picked.job.customerName || "customer",
        });
      }
    }
    for (const recipient of recipients) {
      if (await isOptedOut(recipient.phone)) {
        return { error: `${recipient.name} has opted out of texts. I will not send.` };
      }
    }
    const warning = await shopPhoneWarning();
    const names = [...new Set(recipients.map((item) => item.name))].join(" and ");
    const endings = recipients.map((item) => last4(item.phone)).join(" and ");
    const extra = [consentNote, warning].filter(Boolean).join(" ");
    const speakThis = [
      recipients.length > 1
        ? `Text ${names} at ${recipients.length} numbers ending in ${endings}: ${message}.`
        : `Text ${names}, number ending in ${endings}: ${message}.`,
      extra,
      "Send it?",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      payload: {
        type: "send_sms" as const,
        recipients,
        body: message,
        recipientKind: kind,
      },
      speakThis,
      preview: {
        kind,
        recipients: recipients.map((item) => ({ name: item.name, phone: formatPhone(item.phone) })),
        message,
        consentNote,
        shopPhone: warning || "Shop phone is checking in.",
      },
    };
  });
  if (result.mode !== "execute" || result.payload.type !== "send_sms") {
    return result.mode === "reply" ? result.value : { error: "Confirmation was for a different action." };
  }
  const queued = [];
  for (const recipient of result.payload.recipients) {
    if (await isOptedOut(recipient.phone)) {
      return { error: `${recipient.name} opted out before send. Nothing was queued.` };
    }
    queued.push(await queueShopSms(recipient.phone, result.payload.body, "voice-agent"));
  }
  return {
    ok: true,
    queued,
    speakThis: `Queued ${queued.length === 1 ? "the text" : `${queued.length} texts`} to the shop phone.`,
  };
}

function findStop(plan: PlanRec, job: JobHit): { stop: StopRec; truckId: string | null } | null {
  const stopId = asText(job.stopId);
  const workOrderId = asText(job.workOrderId);
  const match = (stop: StopRec) =>
    stop.id === stopId ||
    asText(stop.workOrderId) === workOrderId ||
    asText(stop.workOrderNumber) === job.workOrderNumber;
  const unassigned = plan.unassigned.find(match);
  if (unassigned) return { stop: unassigned, truckId: null };
  const notReady = plan.notReady.find(match);
  if (notReady) return { stop: notReady, truckId: null };
  for (const truck of plan.trucks) {
    const stop = truck.stops.find(match);
    if (stop) return { stop, truckId: truck.id };
  }
  return null;
}

async function loadJobForMutation(args: Record<string, unknown>) {
  const jobs = await resolveJobs({
    workOrderNumber: asText(args.workOrderNumber),
    customerName: asText(args.customerName),
    phone: asText(args.phone),
    address: asText(args.address),
    jobType: asText(args.jobType),
    query: asText(args.query) || asText(args.customerName) || asText(args.jobType) || asText(args.address),
    date: asText(args.date),
  });
  const picked = pickJobs(jobs);
  if (picked.ambiguous) {
    return {
      kind: "ambiguous" as const,
      ambiguous: picked.ambiguous.map(compactJob),
      speakThis: "I found more than one job. Which work order should I change?",
    };
  }
  if (!picked.job) return { kind: "error" as const, error: "I could not find that job." };
  return { kind: "job" as const, job: picked.job };
}

async function cancelJobTool(args: Record<string, unknown>) {
  const result = await previewOrConfirm(args, "cancel_job", async () => {
    const loaded = await loadJobForMutation(args);
    if (loaded.kind === "error") return { error: loaded.error };
    if (loaded.kind === "ambiguous") {
      return { ambiguous: loaded.ambiguous, speakThis: loaded.speakThis };
    }
    return {
      payload: { type: "cancel_job" as const, job: loaded.job },
      speakThis: `Cancel ${spokenJob(loaded.job)}? It stays saved and is flagged cancelled on the board.`,
      preview: compactJob(loaded.job),
    };
  });
  if (result.mode !== "execute" || result.payload.type !== "cancel_job") {
    return result.mode === "reply" ? result.value : { error: "Confirmation was for a different action." };
  }
  return cancelJob(result.payload.job);
}

function stopFromJob(job: JobHit): StopRec {
  return {
    id: job.workOrderId || job.workOrderNumber,
    workOrderId: job.workOrderId,
    workOrderNumber: job.workOrderNumber,
    customerName: job.customerName,
    phone: job.phone,
    phones: job.phones,
    address: job.address,
    jobType: job.jobType,
    notes: "",
    priority: 0,
    window: WINDOW_SLOTS[0],
    customWindow: false,
    smsConsent: job.smsConsent,
  };
}

async function resolveTruck(
  spoken: string,
  trucks: TruckRec[],
  date: string
): Promise<{ truck: TruckRec } | { error: string } | { ambiguous: unknown; speakThis: string }> {
  const text = asText(spoken);
  if (!text) return { error: "Which truck?" };
  const byNumber = parseTruckId(text);
  if (byNumber) {
    const truck = trucks.find((item) => item.id === byNumber);
    if (!truck) return { error: `${truckLabel(byNumber, trucks)} is not on the board for ${date}.` };
    return { truck };
  }
  const staff = await lookupStaff(text, date);
  const withTruck = staff.people.filter((person) => person.truckId);
  const truckIds = [...new Set(withTruck.map((person) => person.truckId))];
  if (truckIds.length === 1) {
    const truck = trucks.find((item) => item.id === truckIds[0]);
    if (!truck) return { error: `${withTruck[0].name} is on ${withTruck[0].truckName}, which is not on the board for ${date}.` };
    return { truck };
  }
  if (truckIds.length > 1) {
    return {
      ambiguous: withTruck.map((person) => ({ name: person.name, truckName: person.truckName })),
      speakThis: "I found more than one plumber. Which truck did you mean?",
    };
  }
  return { error: `I could not find a truck or plumber called ${text}.` };
}

function removeStopEverywhere(plan: PlanRec, stopId: string): PlanRec {
  return {
    ...plan,
    unassigned: plan.unassigned.filter((stop) => stop.id !== stopId),
    notReady: plan.notReady.filter((stop) => stop.id !== stopId),
    trucks: plan.trucks.map((truck) =>
      truck.stops.some((stop) => stop.id === stopId)
        ? { ...truck, stops: applyDefaultWindows(truck.stops.filter((stop) => stop.id !== stopId)) }
        : truck
    ),
  };
}

async function finishTruckChange(plan: PlanRec, next: PlanRec, truckIds: string[]) {
  await savePlan(next);
  for (const truckId of truckIds) {
    const previous = plan.trucks.find((item) => item.id === truckId);
    const truck = next.trucks.find((item) => item.id === truckId);
    if (!truck) continue;
    await refreshMorningWindows(plan.date, previous, truck);
    await syncTruckSchedule(plan.date, truck);
  }
}

async function assignJobToTruck(args: Record<string, unknown>) {
  const result = await previewOrConfirm(args, "assign_job", async () => {
    const loaded = await loadJobForMutation(args);
    if (loaded.kind === "error") return { error: loaded.error };
    if (loaded.kind === "ambiguous") {
      return { ambiguous: loaded.ambiguous, speakThis: loaded.speakThis };
    }
    const job = loaded.job;
    const date = job.date || asText(args.date) || todayIso();
    const plan = await loadPlan(date);
    if (!plan) return { error: `There is no dispatch board for ${date} yet. Open Dispatch for that day first.` };
    const picked = await resolveTruck(asText(args.truck), plan.trucks, date);
    if ("error" in picked) return { error: picked.error };
    if ("ambiguous" in picked) return picked;
    const truck = picked.truck;
    if (job.cancelled) return { error: `${spokenJob(job)} is cancelled. Un-cancel it on the board first.` };
    if (truck.set) {
      return { error: `${truck.name} is already set with morning texts. Reopen it on the dispatch board first.` };
    }
    if (job.truckId === truck.id) return { error: `${spokenJob(job)} is already on ${truck.name}.` };
    const from = job.truckName ? `from ${job.truckName}` : "from Ready";
    return {
      payload: { type: "assign_job" as const, job, truckId: truck.id, truckName: asText(truck.name) },
      speakThis: `Put ${spokenJob(job)} on ${truck.name}${truck.driver ? ` with ${truck.driver}` : ""}, ${from}? It will have ${activeStops(truck.stops).length + 1} stops.`,
      preview: { job: compactJob(job), truck: { id: truck.id, name: truck.name, driver: truck.driver || "" } },
    };
  });
  if (result.mode !== "execute" || result.payload.type !== "assign_job") {
    return result.mode === "reply" ? result.value : { error: "Confirmation was for a different action." };
  }
  const { job, truckId } = result.payload;
  const date = job.date || todayIso();
  const plan = await loadPlan(date);
  if (!plan) return { error: `The board for ${date} disappeared. Nothing changed.` };
  const truck = plan.trucks.find((item) => item.id === truckId);
  if (!truck) return { error: "That truck is no longer on the board. Nothing changed." };
  if (truck.set) return { error: `${truck.name} was set in the meantime. Nothing changed.` };
  const found = findStop(plan, job);
  const stop = found?.stop || stopFromJob(job);
  const touched = [truckId, ...(found?.truckId && found.truckId !== truckId ? [found.truckId] : [])];
  const without = removeStopEverywhere(plan, stop.id);
  const next: PlanRec = {
    ...without,
    trucks: without.trucks.map((item) =>
      item.id === truckId
        ? { ...item, stops: applyDefaultWindows(sortFarthestFirst([...item.stops, stop])) }
        : item
    ),
  };
  await finishTruckChange(plan, next, touched);
  const updated = next.trucks.find((item) => item.id === truckId);
  const position = (updated?.stops.findIndex((item) => item.id === stop.id) ?? -1) + 1;
  const window = formatWindow(updated?.stops.find((item) => item.id === stop.id)?.window);
  return {
    ok: true,
    action: "assigned",
    speakThis: `Put ${spokenJob(job)} on ${truck.name} as stop ${position || "?"}${window ? `, window ${window}` : ""}.`,
  };
}

async function unassignJob(args: Record<string, unknown>) {
  const result = await previewOrConfirm(args, "unassign_job", async () => {
    const loaded = await loadJobForMutation(args);
    if (loaded.kind === "error") return { error: loaded.error };
    if (loaded.kind === "ambiguous") {
      return { ambiguous: loaded.ambiguous, speakThis: loaded.speakThis };
    }
    const job = loaded.job;
    if (job.location !== "truck" || !job.truckId) {
      return { error: `${spokenJob(job)} is not on a truck. It is already in ${job.location === "notReady" ? "Not ready" : "Ready"}.` };
    }
    const plan = await loadPlan(job.date || todayIso());
    const truck = plan?.trucks.find((item) => item.id === job.truckId);
    if (truck?.set) {
      return { error: `${truck.name} is already set with morning texts. Reopen it on the dispatch board first.` };
    }
    return {
      payload: { type: "unassign_job" as const, job },
      speakThis: `Take ${spokenJob(job)} off ${job.truckName} and put it back in Ready?`,
      preview: compactJob(job),
    };
  });
  if (result.mode !== "execute" || result.payload.type !== "unassign_job") {
    return result.mode === "reply" ? result.value : { error: "Confirmation was for a different action." };
  }
  const job = result.payload.job;
  const plan = await loadPlan(job.date || todayIso());
  if (!plan) return { error: "The board for that day disappeared. Nothing changed." };
  const found = findStop(plan, job);
  if (!found || !found.truckId) return { error: `${spokenJob(job)} is no longer on a truck. Nothing changed.` };
  await cancelPendingMorningText(plan.date, found.truckId, found.stop.id);
  const without = removeStopEverywhere(plan, found.stop.id);
  const next: PlanRec = { ...without, unassigned: [...without.unassigned, { ...found.stop, morningTextStatus: "none" }] };
  await finishTruckChange(plan, next, [found.truckId]);
  return {
    ok: true,
    action: "unassigned",
    speakThis: `${spokenJob(job)} is back in Ready. ${job.truckName} was re-ordered.`,
  };
}

function planAutoAssign(plan: PlanRec): { next: PlanRec; placed: Array<{ stop: StopRec; truckId: string }>; openIds: string[] } | { error: string } {
  const trucks = plan.trucks.map((truck) => ({ ...truck, stops: [...truck.stops] }));
  const openIndexes = trucks.map((truck, index) => (truck.set ? -1 : index)).filter((index) => index >= 0);
  if (!openIndexes.length) return { error: "All trucks are set. Reopen a truck on the board first." };
  const jobs = sortFarthestFirst(activeStops(plan.unassigned));
  const cancelled = plan.unassigned.filter((stop) => stop.cancelled === true);
  if (!jobs.length) return { error: "Ready is empty. There are no unassigned jobs to place." };
  const alreadyAssigned = openIndexes.reduce((count, index) => count + trucks[index].stops.length, 0);
  const cap = Math.max(1, Math.ceil((alreadyAssigned + jobs.length) / openIndexes.length));
  const placed: Array<{ stop: StopRec; truckId: string }> = [];
  for (const job of jobs) {
    const point = stopPoint(job);
    let bestIndex = openIndexes[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const index of openIndexes) {
      const truck = trucks[index];
      const travel = point ? haversineMiles(point, truckCentroid(truck.stops)) : truck.stops.length;
      const overCap = truck.stops.length >= cap ? 1000 : 0;
      const score = travel + overCap + truck.stops.length * 0.05;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    trucks[bestIndex].stops.push(job);
    placed.push({ stop: job, truckId: trucks[bestIndex].id });
  }
  return {
    next: {
      ...plan,
      unassigned: cancelled,
      trucks: trucks.map((truck) =>
        truck.set ? truck : { ...truck, stops: applyDefaultWindows(sortFarthestFirst(truck.stops)) }
      ),
    },
    placed,
    openIds: openIndexes.map((index) => trucks[index].id),
  };
}

function describePlacement(plan: PlanRec, placed: Array<{ stop: StopRec; truckId: string }>): string {
  const byTruck = new Map<string, string[]>();
  for (const item of placed) {
    const list = byTruck.get(item.truckId) || [];
    list.push(asText(item.stop.customerName) || asText(item.stop.workOrderNumber) || "a job");
    byTruck.set(item.truckId, list);
  }
  return speakList(
    [...byTruck.entries()].map(([truckId, names]) => `${truckLabel(truckId, plan.trucks)}: ${speakList(names)}`)
  );
}

async function autoAssignJobs(args: Record<string, unknown>) {
  const result = await previewOrConfirm(args, "auto_assign", async () => {
    const date = isIsoDate(asText(args.date)) ? asText(args.date) : todayIso();
    const plan = await loadPlan(date);
    if (!plan) return { error: `There is no dispatch board for ${date} yet. Open Dispatch for that day first.` };
    const planned = planAutoAssign(plan);
    if ("error" in planned) return { error: planned.error };
    const openNames = planned.openIds.map((id) => truckLabel(id, plan.trucks));
    return {
      payload: {
        type: "auto_assign" as const,
        date,
        jobIds: planned.placed.map((item) => item.stop.id),
        truckIds: planned.openIds,
      },
      speakThis: `Put ${planned.placed.length} ready ${planned.placed.length === 1 ? "job" : "jobs"} across ${speakList(openNames)}? ${describePlacement(plan, planned.placed)}. Go ahead?`,
      preview: {
        date,
        trucks: openNames,
        placement: planned.placed.map((item) => ({
          truck: truckLabel(item.truckId, plan.trucks),
          job: stopLabel(item.stop),
        })),
      },
    };
  });
  if (result.mode !== "execute" || result.payload.type !== "auto_assign") {
    return result.mode === "reply" ? result.value : { error: "Confirmation was for a different action." };
  }
  const { date, jobIds, truckIds } = result.payload;
  const plan = await loadPlan(date);
  if (!plan) return { error: `The board for ${date} disappeared. Nothing changed.` };
  const currentReady = new Set(activeStops(plan.unassigned).map((stop) => stop.id));
  const stillOpen = plan.trucks.filter((truck) => !truck.set).map((truck) => truck.id);
  const sameJobs = jobIds.length === currentReady.size && jobIds.every((id) => currentReady.has(id));
  const sameTrucks = truckIds.length === stillOpen.length && truckIds.every((id) => stillOpen.includes(id));
  if (!sameJobs || !sameTrucks) {
    return { error: "The board changed since the preview. Ask me to set up the trucks again." };
  }
  const planned = planAutoAssign(plan);
  if ("error" in planned) return { error: planned.error };
  await finishTruckChange(plan, planned.next, planned.openIds);
  return {
    ok: true,
    action: "auto-assigned",
    speakThis: `Done. ${describePlacement(plan, planned.placed)}. Trucks are ordered farthest-first; set each truck on the board when you are ready to text customers.`,
  };
}

async function cancelJob(job: JobHit) {
  const date = job.date || todayIso();
  const plan = await loadPlan(date);
  if (!plan) {
    await db()
      .collection("workOrders")
      .doc(job.workOrderId)
      .set(
        {
          cancelled: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    return { ok: true, action: "cancelled", speakThis: `Marked ${spokenJob(job)} cancelled. It was not on a dispatch board.` };
  }
  const found = findStop(plan, job);
  if (!found) {
    await db()
      .collection("workOrders")
      .doc(job.workOrderId)
      .set(
        {
          cancelled: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    return { ok: true, action: "cancelled", speakThis: `Marked ${spokenJob(job)} cancelled. It was not on today's board.` };
  }
  const patched: StopRec = {
    ...found.stop,
    cancelled: true,
    morningTextStatus: found.stop.morningTextStatus === "queued" ? "none" : found.stop.morningTextStatus,
  };
  if (found.truckId) {
    await cancelPendingMorningText(plan.date, found.truckId, found.stop.id);
    const previous = plan.trucks.find((item) => item.id === found.truckId);
    const next: PlanRec = {
      ...plan,
      trucks: plan.trucks.map((truck) => {
        if (truck.id !== found.truckId) return truck;
        return { ...truck, stops: applyDefaultWindows(truck.stops.filter((stop) => stop.id !== found.stop.id)) };
      }),
      unassigned: [...plan.unassigned.filter((stop) => stop.id !== found.stop.id), patched],
      notReady: plan.notReady.filter((stop) => stop.id !== found.stop.id),
    };
    await savePlan(next);
    const truck = next.trucks.find((item) => item.id === found.truckId);
    if (truck) {
      await refreshMorningWindows(plan.date, previous, truck);
      await syncTruckSchedule(plan.date, truck);
    }
  } else {
    await savePlan({
      ...plan,
      unassigned: plan.unassigned.map((stop) => (stop.id === found.stop.id ? patched : stop)),
      notReady: plan.notReady.map((stop) => (stop.id === found.stop.id ? patched : stop)),
    });
  }
  return {
    ok: true,
    action: "cancelled",
    speakThis: `Cancelled ${spokenJob(job)}. It is flagged on the board and the work order is still saved.`,
  };
}

export async function runOfficeAction(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "lookup_staff") return lookupStaff(asText(args.query), asText(args.date));
  if (name === "lookup_sms_thread") {
    return lookupSmsThread({
      phone: asText(args.phone),
      plumberName: asText(args.plumberName),
      customerName: asText(args.customerName),
      workOrderNumber: asText(args.workOrderNumber),
    });
  }
  if (name === "send_sms") return sendSms(args);
  if (name === "cancel_job") return cancelJobTool(args);
  if (name === "assign_job_to_truck") return assignJobToTruck(args);
  if (name === "unassign_job") return unassignJob(args);
  if (name === "auto_assign_jobs") return autoAssignJobs(args);
  if (name === "close_job" || name === "delete_job") {
    return {
      error:
        "Closing and deleting jobs are not available by voice. Cancel is the only removal; close or delete on the dispatch board.",
    };
  }
  return { error: `Unknown tool: ${name}` };
}
