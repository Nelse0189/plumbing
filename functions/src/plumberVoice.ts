import * as admin from "firebase-admin";
import OpenAI, { toFile } from "openai";
import twilio from "twilio";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";

const CALLS = "plumberCalls";
const PLAUD_CALLS = "plaudCalls";
const TRUCK_PHONES_DOC = "appConfig/truckPhones";
const FUNCTION_BASE = "https://us-central1-nj-plumbing.cloudfunctions.net";
const WHISPER_USD_PER_MINUTE = 0.006;

type TruckPhone = { id?: unknown; phone?: unknown; label?: unknown };

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function jsonBody(req: Request): Record<string, string> {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

function normalizeUsPhone(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) {
    return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

function isE164Phone(value: string): boolean {
  return /^\+\d{10,15}$/.test(value);
}

function coerceUsPhone(value: string): string {
  const normalized = normalizeUsPhone(asText(value));
  return isE164Phone(normalized) ? normalized : "";
}

function phoneKey(value: string): string {
  return value.replace(/\D/g, "").slice(-10);
}

function easternDate(at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(at);
}

function companyName(): string {
  return asText(process.env.COMPANY_NAME) || "NJ Plumbing";
}

function twilioSid(): string {
  return asText(process.env.TWILIO_ACCOUNT_SID);
}

function twilioToken(): string {
  return asText(process.env.TWILIO_AUTH_TOKEN);
}

function twilioNumber(): string {
  return coerceUsPhone(asText(process.env.TWILIO_PHONE_NUMBER));
}

function customerCallerId(): string {
  return coerceUsPhone(asText(process.env.TWILIO_VOICE_CALLER_ID)) || twilioNumber();
}

function requireTwilioVoice() {
  if (!twilioSid() || !twilioToken() || !twilioNumber()) {
    throw new HttpsError(
      "failed-precondition",
      "Twilio voice is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER."
    );
  }
}

function twilioClient() {
  requireTwilioVoice();
  return twilio(twilioSid(), twilioToken());
}

function webhookUrl(name: string, callId: string): string {
  return `${FUNCTION_BASE}/${name}?callId=${encodeURIComponent(callId)}`;
}

function assertTwilioSignature(req: Request): boolean {
  const signature = asText(req.get("X-Twilio-Signature"));
  const token = twilioToken();
  if (!token || !signature) return false;
  const host = asText(req.get("x-forwarded-host")) || asText(req.get("host"));
  const proto = asText(req.get("x-forwarded-proto")) || "https";
  const url = `${proto}://${host}${req.originalUrl}`;
  const params = jsonBody(req);
  if (twilio.validateRequest(token, signature, url, params)) return true;
  const withoutQuery = `${proto}://${host}${req.path}`;
  return twilio.validateRequest(token, signature, withoutQuery, params);
}

function twiml(res: Response, xml: string) {
  res.type("text/xml").status(200).send(urlXml(xml));
}

function urlXml(xml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${xml}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function dialCustomerTwiml(callId: string, customerName: string, customerPhone: string): string {
  const who = asText(customerName) || "the customer";
  const recordingUrl = webhookUrl("handlePlumberCallRecording", callId);
  const dialResultUrl = webhookUrl("handlePlumberCallDialResult", callId);
  return [
    "<Response>",
    `<Say voice="alice">This call is recorded. Connecting you to ${escapeXml(who)}.</Say>`,
    `<Dial callerId="${escapeXml(customerCallerId())}" answerOnBridge="true" timeout="40" record="record-from-answer-dual" recordingStatusCallback="${escapeXml(
      recordingUrl
    )}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed" action="${escapeXml(
      dialResultUrl
    )}" method="POST">`,
    `<Number>${escapeXml(customerPhone)}</Number>`,
    "</Dial>",
    "</Response>",
  ].join("");
}

function hangupTwiml(message: string): string {
  return `<Response><Say voice="alice">${escapeXml(message)}</Say><Hangup/></Response>`;
}

async function loadCall(callId: string): Promise<Record<string, unknown> | null> {
  if (!callId) return null;
  const snap = await admin.firestore().collection(CALLS).doc(callId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() || {}) };
}

async function patchCall(callId: string, patch: Record<string, unknown>) {
  await admin.firestore().collection(CALLS).doc(callId).set(
    {
      ...patch,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

function phonesFromRoster(value: unknown, truckId?: string): string[] {
  if (!value || typeof value !== "object") return [];
  const trucks = (value as { trucks?: unknown }).trucks;
  if (!trucks || typeof trucks !== "object") return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    const phone = coerceUsPhone(asText(raw));
    const key = phoneKey(phone);
    if (!phone || !key || seen.has(key)) return;
    seen.add(key);
    found.push(phone);
  };
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && typeof item === "object") add((item as TruckPhone).phone);
    }
  };
  if (truckId) walk((trucks as Record<string, unknown>)[truckId]);
  if (found.length) return found;
  for (const list of Object.values(trucks as Record<string, unknown>)) walk(list);
  return found;
}

async function plumberPhonesForTruck(truckId: string): Promise<string[]> {
  const snap = await admin.firestore().doc(TRUCK_PHONES_DOC).get();
  const fromTruck = phonesFromRoster(snap.data(), truckId);
  if (fromTruck.length) return fromTruck;
  const fallback = coerceUsPhone(asText(process.env.HEAD_PLUMBER_PHONE));
  return fallback ? [fallback] : [];
}

async function allPlumberPhones(): Promise<string[]> {
  const snap = await admin.firestore().doc(TRUCK_PHONES_DOC).get();
  const fromRoster = phonesFromRoster(snap.data());
  if (fromRoster.length) return fromRoster;
  const fallback = coerceUsPhone(asText(process.env.HEAD_PLUMBER_PHONE));
  return fallback ? [fallback] : [];
}

function uniquePhones(...values: Array<string | string[] | undefined | null>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      const phone = coerceUsPhone(asText(item));
      const key = phoneKey(phone);
      if (!phone || !key || seen.has(key)) continue;
      seen.add(key);
      found.push(phone);
    }
  }
  return found;
}

async function jobPhonesForStop(input: {
  dispatchDate: string;
  truckId: string;
  stopId: string;
}): Promise<{
  customerPhones: string[];
  customerName: string;
  workOrderId: string;
  workOrderNumber: string;
  address: string;
}> {
  const planDoc = await admin.firestore().collection("dispatchPlans").doc(input.dispatchDate).get();
  if (!planDoc.exists) {
    throw new HttpsError("not-found", "Dispatch plan was not found");
  }
  const plan = planDoc.data() as {
    trucks?: Array<{ id?: unknown; stops?: Array<Record<string, unknown>> }>;
  };
  const truck = Array.isArray(plan.trucks)
    ? plan.trucks.find((candidate) => asText(candidate.id) === input.truckId)
    : undefined;
  const stop = truck?.stops?.find((candidate) => asText(candidate.id) === input.stopId);
  if (!stop) {
    throw new HttpsError("not-found", "Dispatch stop was not found");
  }
  const workOrderId = asText(stop.workOrderId) || input.stopId;
  let workOrderPhones: string[] = [];
  let workOrderNumber = asText(stop.workOrderNumber);
  let customerName = asText(stop.customerName);
  let address = asText(stop.address);
  if (workOrderId) {
    const orderSnap = await admin.firestore().collection("workOrders").doc(workOrderId).get();
    if (orderSnap.exists) {
      const data = orderSnap.data() || {};
      workOrderPhones = uniquePhones(
        Array.isArray(data.phones) ? data.phones.map((item) => String(item || "")) : [],
        asText(data.phone)
      );
      workOrderNumber = asText(data.workOrderNumber) || workOrderNumber;
      customerName = asText(data.customerName) || customerName;
      address = asText(data.address) || address;
    }
  }
  return {
    customerPhones: uniquePhones(
      Array.isArray(stop.phones) ? stop.phones.map((item) => String(item || "")) : [],
      asText(stop.phone),
      workOrderPhones
    ),
    customerName,
    workOrderId,
    workOrderNumber,
    address,
  };
}

async function findTodayJobForIncoming(fromPhone: string): Promise<{
  dispatchDate: string;
  truckId: string;
  stopId: string;
  customerName: string;
  workOrderId: string;
  workOrderNumber: string;
  address: string;
} | null> {
  const dispatchDate = easternDate();
  const planDoc = await admin.firestore().collection("dispatchPlans").doc(dispatchDate).get();
  if (!planDoc.exists) return null;
  const want = phoneKey(fromPhone);
  const plan = planDoc.data() as {
    trucks?: Array<{ id?: unknown; stops?: Array<Record<string, unknown>> }>;
  };
  for (const truck of plan.trucks || []) {
    const truckId = asText(truck.id);
    for (const stop of truck.stops || []) {
      if (stop.cancelled === true) continue;
      const phones = uniquePhones(
        Array.isArray(stop.phones) ? stop.phones.map((item) => String(item || "")) : [],
        asText(stop.phone)
      );
      if (phones.some((phone) => phoneKey(phone) === want)) {
        return {
          dispatchDate,
          truckId,
          stopId: asText(stop.id),
          customerName: asText(stop.customerName),
          workOrderId: asText(stop.workOrderId) || asText(stop.id),
          workOrderNumber: asText(stop.workOrderNumber),
          address: asText(stop.address),
        };
      }
    }
  }
  return null;
}

function plaudDocumentId(callId: string): string {
  return `plaud-plumber-${callId}`.slice(0, 700);
}

function whisperCostUsd(durationMs?: number): number {
  const minutes = Math.max(
    (typeof durationMs === "number" && durationMs > 0 ? durationMs : 1000) / 60000,
    1 / 60
  );
  return Math.round(minutes * WHISPER_USD_PER_MINUTE * 1e6) / 1e6;
}

async function downloadTwilioRecording(recordingSid: string): Promise<Buffer> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    twilioSid()
  )}/Recordings/${encodeURIComponent(recordingSid)}.mp3`;
  const auth = Buffer.from(`${twilioSid()}:${twilioToken()}`).toString("base64");
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    throw new Error(`Twilio recording download failed (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function transcribeRecording(
  audio: Buffer,
  durationMs?: number
): Promise<{ text: string; costUsd: number }> {
  const apiKey = asText(process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const openai = new OpenAI({ apiKey });
  const result = await openai.audio.transcriptions.create({
    file: await toFile(audio, "plumber-call.mp3"),
    model: "whisper-1",
    language: "en",
    response_format: "text",
  });
  return {
    text: asText(typeof result === "string" ? result : (result as { text?: string }).text),
    costUsd: whisperCostUsd(durationMs),
  };
}

async function writePlaudCall(input: {
  callId: string;
  startedAt: string;
  durationMs?: number;
  plumberPhone: string;
  customerPhone: string;
  customerName: string;
  workOrderId: string;
  workOrderNumber: string;
  address: string;
  recordingSid: string;
  transcript: string;
  costUsd?: number;
  direction: string;
}) {
  const startedAt = input.startedAt || new Date().toISOString();
  const transcript = asText(input.transcript);
  const summary = transcript
    ? `Recorded plumber ${input.direction} call with ${input.customerName || "customer"}${
        input.workOrderNumber ? ` (WO ${input.workOrderNumber})` : ""
      }.`
    : "";
  await admin.firestore().collection(PLAUD_CALLS).doc(plaudDocumentId(input.callId)).set(
    {
      callId: `plumber-${input.callId}`,
      callDate: easternDate(new Date(startedAt)),
      startedAt,
      recordingName: `${companyName()} plumber call${
        input.workOrderNumber ? ` · WO ${input.workOrderNumber}` : ""
      }`,
      durationMs: typeof input.durationMs === "number" ? input.durationMs : null,
      callerPhone: input.customerPhone,
      phone: input.customerPhone,
      customerName: input.customerName,
      address: input.address,
      workOrderId: input.workOrderId || undefined,
      workOrderNumber: input.workOrderNumber || undefined,
      transcript,
      summary,
      plaudSummary: summary,
      customerServiceTips: [],
      appointmentMade: false,
      status: transcript.length >= 20 ? "processed" : "awaiting_transcript",
      source: "plumber-phone",
      twilioRecordingSid: input.recordingSid,
      plumberCallId: input.callId,
      openaiCostUsd: input.costUsd || 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export async function loadPlumberCallAudio(callId: string): Promise<{
  buffer: Buffer;
  filename: string;
  contentType: string;
}> {
  const requested = asText(callId).replace(/^plaud-plumber-/, "").replace(/^plaud-/, "");
  const call = await loadCall(requested);
  const recordingSid = asText(call?.twilioRecordingSid);
  if (!recordingSid) {
    const plaud = await admin.firestore().collection(PLAUD_CALLS).doc(plaudDocumentId(requested)).get();
    const sid = asText(plaud.data()?.twilioRecordingSid);
    if (!sid) {
      throw new HttpsError("failed-precondition", "This plumber call has no recording yet.");
    }
    const buffer = await downloadTwilioRecording(sid);
    return {
      buffer,
      filename: `plumber-call-${requested}.mp3`,
      contentType: "audio/mpeg",
    };
  }
  const buffer = await downloadTwilioRecording(recordingSid);
  return {
    buffer,
    filename: `plumber-call-${requested}.mp3`,
    contentType: "audio/mpeg",
  };
}

export const startPlumberJobCall = onCall({ cors: true, timeoutSeconds: 60 }, async (request) => {
  const input = request.data as {
    dispatchDate?: unknown;
    truckId?: unknown;
    stopId?: unknown;
    customerPhone?: unknown;
    plumberPhone?: unknown;
  };
  const dispatchDate = asText(input.dispatchDate);
  const truckId = asText(input.truckId);
  const stopId = asText(input.stopId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dispatchDate) || !truckId || !stopId) {
    throw new HttpsError("invalid-argument", "A dispatch date, truck, and stop are required");
  }
  requireTwilioVoice();
  const job = await jobPhonesForStop({ dispatchDate, truckId, stopId });
  const requestedCustomer = coerceUsPhone(asText(input.customerPhone));
  const customerPhone =
    requestedCustomer && job.customerPhones.some((phone) => phoneKey(phone) === phoneKey(requestedCustomer))
      ? requestedCustomer
      : job.customerPhones[0] || "";
  if (!customerPhone) {
    throw new HttpsError("failed-precondition", "This job does not have a valid customer phone number");
  }
  const truckPhones = await plumberPhonesForTruck(truckId);
  const requestedPlumber = coerceUsPhone(asText(input.plumberPhone));
  const plumberPhone =
    requestedPlumber && truckPhones.some((phone) => phoneKey(phone) === phoneKey(requestedPlumber))
      ? requestedPlumber
      : truckPhones[0] || "";
  if (!plumberPhone) {
    throw new HttpsError(
      "failed-precondition",
      "Add this truck's cell on Dispatch so we can ring the plumber's Android phone."
    );
  }
  if (phoneKey(plumberPhone) === phoneKey(customerPhone)) {
    throw new HttpsError("failed-precondition", "The plumber phone and customer phone are the same number.");
  }

  const callRef = admin.firestore().collection(CALLS).doc();
  const callId = callRef.id;
  const startedAt = new Date().toISOString();
  await callRef.set({
    direction: "outbound",
    status: "queued",
    dispatchDate,
    truckId,
    stopId,
    workOrderId: job.workOrderId,
    workOrderNumber: job.workOrderNumber,
    customerName: job.customerName,
    customerPhone,
    plumberPhone,
    address: job.address,
    startedAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    const call = await twilioClient().calls.create({
      to: plumberPhone,
      from: twilioNumber(),
      url: webhookUrl("handlePlumberCallConnect", callId),
      method: "POST",
      statusCallback: webhookUrl("handlePlumberCallStatus", callId),
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    await patchCall(callId, { plumberCallSid: call.sid, status: "ringing" });
    return {
      callId,
      plumberPhone,
      customerPhone,
      status: "ringing",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchCall(callId, { status: "failed", error: message.slice(0, 280) });
    throw new HttpsError(
      "internal",
      message.slice(0, 180) || "Could not start the recorded call"
    );
  }
});

export const handlePlumberCallConnect = onRequest(
  { invoker: "public", cors: false },
  async (req, res) => {
    if (!assertTwilioSignature(req)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    const callId = asText(req.query.callId);
    const call = await loadCall(callId);
    const customerPhone = coerceUsPhone(asText(call?.customerPhone));
    if (!call || !customerPhone) {
      twiml(res, hangupTwiml("This call is no longer available. Goodbye."));
      return;
    }
    await patchCall(callId, {
      status: "in-progress",
      plumberCallSid: asText(jsonBody(req).CallSid) || call.plumberCallSid,
    });
    twiml(res, dialCustomerTwiml(callId, asText(call.customerName), customerPhone));
  }
);

export const handlePlumberCallDialResult = onRequest(
  { invoker: "public", cors: false },
  async (req, res) => {
    if (!assertTwilioSignature(req)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    const callId = asText(req.query.callId);
    const body = jsonBody(req);
    const dialStatus = asText(body.DialCallStatus).toLowerCase();
    await patchCall(callId, {
      customerCallSid: asText(body.DialCallSid),
      dialStatus,
    });
    if (dialStatus && dialStatus !== "completed") {
      const call = await loadCall(callId);
      await patchCall(callId, { status: dialStatus === "busy" ? "busy" : "no-answer" });
      const inbound = asText(call?.direction) === "inbound";
      twiml(
        res,
        hangupTwiml(
          inbound
            ? "We could not reach the plumber. Please try again later."
            : "The customer did not answer. Goodbye."
        )
      );
      return;
    }
    twiml(res, "<Response><Hangup/></Response>");
  }
);

export const handlePlumberCallStatus = onRequest(
  { invoker: "public", cors: false },
  async (req, res) => {
    if (!assertTwilioSignature(req)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    const callId = asText(req.query.callId);
    const body = jsonBody(req);
    const callStatus = asText(body.CallStatus).toLowerCase();
    const mapped =
      callStatus === "completed"
        ? "completed"
        : callStatus === "busy"
          ? "busy"
          : callStatus === "no-answer" || callStatus === "canceled" || callStatus === "failed"
            ? callStatus
            : callStatus === "in-progress"
              ? "in-progress"
              : callStatus === "ringing"
                ? "ringing"
                : undefined;
    if (mapped) {
      await patchCall(callId, {
        status: mapped,
        plumberCallSid: asText(body.CallSid),
      });
    }
    res.status(204).send("");
  }
);

export const handlePlumberCallRecording = onRequest(
  { invoker: "public", cors: false, timeoutSeconds: 300, memory: "1GiB" },
  async (req, res) => {
    if (!assertTwilioSignature(req)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    const callId = asText(req.query.callId);
    const body = jsonBody(req);
    const recordingSid = asText(body.RecordingSid);
    const durationSeconds = Number(body.RecordingDuration);
    const durationMs =
      Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds * 1000 : undefined;
    if (!callId || !recordingSid) {
      res.status(204).send("");
      return;
    }
    const call = await loadCall(callId);
    await patchCall(callId, {
      status: "completed",
      twilioRecordingSid: recordingSid,
      recordingUrl: asText(body.RecordingUrl),
      durationMs: durationMs ?? null,
    });
    try {
      const audio = await downloadTwilioRecording(recordingSid);
      const transcribed = await transcribeRecording(audio, durationMs);
      await patchCall(callId, {
        transcript: transcribed.text,
        openaiCostUsd: transcribed.costUsd,
        status: transcribed.text.length >= 20 ? "processed" : "awaiting_transcript",
      });
      await writePlaudCall({
        callId,
        startedAt: asText(call?.startedAt) || new Date().toISOString(),
        durationMs,
        plumberPhone: asText(call?.plumberPhone),
        customerPhone: asText(call?.customerPhone),
        customerName: asText(call?.customerName),
        workOrderId: asText(call?.workOrderId),
        workOrderNumber: asText(call?.workOrderNumber),
        address: asText(call?.address),
        recordingSid,
        transcript: transcribed.text,
        costUsd: transcribed.costUsd,
        direction: asText(call?.direction) || "outbound",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await patchCall(callId, {
        status: "failed",
        error: message.slice(0, 280),
      });
      console.error("plumber call transcription failed", { callId, error: message });
    }
    res.status(204).send("");
  }
);

function inboundDialTwiml(callId: string, plumberPhone: string, customerPhone: string): string {
  const recordingUrl = webhookUrl("handlePlumberCallRecording", callId);
  const dialResultUrl = webhookUrl("handlePlumberCallDialResult", callId);
  const callerId = customerPhone || twilioNumber();
  return [
    "<Response>",
    `<Say voice="alice">${escapeXml(companyName())}. This call is recorded.</Say>`,
    `<Dial callerId="${escapeXml(callerId)}" answerOnBridge="true" timeout="28" record="record-from-answer-dual" recordingStatusCallback="${escapeXml(
      recordingUrl
    )}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed" action="${escapeXml(
      dialResultUrl
    )}" method="POST">`,
    `<Number>${escapeXml(plumberPhone)}</Number>`,
    "</Dial>",
    "</Response>",
  ].join("");
}

export const handlePlumberInbound = onRequest(
  { invoker: "public", cors: false },
  async (req, res) => {
    if (!assertTwilioSignature(req)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    if (!twilioSid() || !twilioToken() || !twilioNumber()) {
      twiml(res, hangupTwiml("This line is not configured. Goodbye."));
      return;
    }
    const body = jsonBody(req);
    const from = coerceUsPhone(asText(body.From));
    const plumberPhones = await allPlumberPhones();
    const plumberPhone = plumberPhones[0] || "";
    if (!plumberPhone) {
      twiml(
        res,
        hangupTwiml("We could not reach a plumber. Please try again later.")
      );
      return;
    }
    const matched = from ? await findTodayJobForIncoming(from) : null;
    const callRef = admin.firestore().collection(CALLS).doc();
    const callId = callRef.id;
    const startedAt = new Date().toISOString();
    await callRef.set({
      direction: "inbound",
      status: "ringing",
      dispatchDate: matched?.dispatchDate || easternDate(),
      truckId: matched?.truckId || "",
      stopId: matched?.stopId || "",
      workOrderId: matched?.workOrderId || "",
      workOrderNumber: matched?.workOrderNumber || "",
      customerName: matched?.customerName || "",
      customerPhone: from,
      plumberPhone,
      address: matched?.address || "",
      inboundCallSid: asText(body.CallSid),
      startedAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    twiml(res, inboundDialTwiml(callId, plumberPhone, from));
  }
);
