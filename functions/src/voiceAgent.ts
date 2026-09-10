import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

/** firebase-admin 12 does not re-export VectorValue; derive it from the factory. */
type VectorValue = ReturnType<typeof FieldValue.vector>;
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import OpenAI from "openai";
import {
  enrichDayLookup,
  extraAgentTools,
  lookupWorkOrderLive,
  runOfficeAction,
} from "./voiceAgentActions";

const CHUNKS = "voiceKnowledgeChunks";
const SOURCES = "voiceKnowledgeSources";
const META = "voiceKnowledgeMeta";
const META_DOC = "status";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;
const CHUNK_CHARS = 3500;
const CHUNK_OVERLAP = 200;
const EMBED_BATCH = 48;
const SEARCH_TOP_K = 8;
/**
 * Firestore KNN uses COSINE *distance* (0 = identical, 2 = opposite).
 * 0.85 distance ≈ the old 0.15 cosine-similarity floor.
 */
const SEARCH_MAX_DISTANCE = 0.85;
/**
 * Bump when the stored chunk shape changes so a reindex rewrites every chunk
 * even when the source text hash is unchanged. v2 = embeddings stored as
 * Firestore vector values (required by findNearest).
 */
const INDEX_FORMAT = 2;
const TODAY_INDEX_MAX_AGE_MS = 60 * 60 * 1000;

const SKIP_COLLECTIONS = new Set([
  CHUNKS,
  SOURCES,
  META,
  "emailReplyDrafts",
  "gmailInboxSecrets",
  "gmailOAuthPending",
  "smsGatewaySecrets",
  "plaidItems",
  "plaudAuth",
  "plaudOAuthPending",
  "voiceSipSessions",
  "voiceAgentPendingActions",
]);

const SKIP_FIELDS = new Set([
  "accessToken",
  "amountPaid",
  "apiKey",
  "cardExp",
  "cardOrCheckNumber",
  "clientSecret",
  "cookie",
  "customerInitial",
  "customerSignature",
  "driversLicense",
  "fileBase64",
  "idToken",
  "pairingToken",
  "password",
  "plaidAccessToken",
  "publicToken",
  "refreshToken",
  "routingNumber",
  "secret",
  "verifier",
  "webhookSecret",
]);

type KnowledgeStatus = {
  status: "idle" | "running" | "error";
  lastIndexedAt?: string;
  lastTodayIndexAt?: string;
  chunkCount?: number;
  documentCount?: number;
  collectionCount?: number;
  error?: string;
  startedAt?: string;
};

type ChunkRecord = {
  sourceCollection: string;
  sourceId: string;
  chunkIndex: number;
  title: string;
  text: string;
  date?: string;
  embedding: VectorValue;
  hash: string;
  format: number;
  updatedAt: FirebaseFirestore.FieldValue;
};

export type KnowledgeSearchHit = {
  score: number;
  title: string;
  collection: string;
  id: string;
  date: string;
  text: string;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function openaiKey(): string {
  return asText(process.env.OPENAI_API_KEY);
}

function openaiClient(): OpenAI {
  const apiKey = openaiKey();
  if (!apiKey) {
    throw new HttpsError("failed-precondition", "OPENAI_API_KEY is not configured");
  }
  return new OpenAI({ apiKey });
}

function realtimeModel(): string {
  return asText(process.env.OPENAI_REALTIME_MODEL) || "gpt-realtime-mini";
}

function realtimeVoice(): string {
  return asText(process.env.OPENAI_REALTIME_VOICE) || "marin";
}

function companyName(): string {
  return asText(process.env.COMPANY_NAME) || "NJ Plumbing";
}

function businessTimeZone(): string {
  return asText(process.env.BUSINESS_TIME_ZONE) || "America/New_York";
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function spokenNow(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: businessTimeZone(),
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceDocId(collectionId: string, documentId: string): string {
  return sha(`${collectionId}/${documentId}`).slice(0, 40);
}

function chunkDocId(collectionId: string, documentId: string, index: number): string {
  return sha(`${collectionId}/${documentId}/${index}`).slice(0, 40);
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function stampToText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof admin.firestore.Timestamp) return value.toDate().toISOString();
  if (typeof value === "object" && "toDate" in (value as object)) {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return "";
    }
  }
  return "";
}

function shouldSkipKey(key: string): boolean {
  if (SKIP_FIELDS.has(key)) return true;
  const lower = key.toLowerCase();
  return (
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("signature") ||
    lower.endsWith("base64")
  );
}

function flattenValue(value: unknown, key: string, depth: number): string[] {
  if (depth > 6 || value == null) return [];
  if (shouldSkipKey(key)) return [];
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    if (text.length > 120000) return [`${key}: ${text.slice(0, 120000)}`];
    return [`${key}: ${text}`];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [`${key}: ${String(value)}`];
  }
  const stamped = stampToText(value);
  if (stamped && (value instanceof admin.firestore.Timestamp || typeof value !== "object")) {
    return [`${key}: ${stamped}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenValue(item, `${key}[${index}]`, depth + 1));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([child, childValue]) =>
      flattenValue(childValue, key ? `${key}.${child}` : child, depth + 1)
    );
  }
  return [];
}

function documentTitle(collectionId: string, documentId: string, data: Record<string, unknown>): string {
  const number = asText(data.workOrderNumber);
  const name = asText(data.customerName) || asText(data.recordingName) || asText(data.name);
  const date =
    asText(data.appointmentDate) ||
    asText(data.serviceDate) ||
    asText(data.callDate) ||
    asText(data.dispatchDate) ||
    asText(data.date);
  const parts = [collectionId, number || documentId, name, date].filter(Boolean);
  return parts.join(" · ").slice(0, 180);
}

function documentDate(data: Record<string, unknown>, documentId: string): string {
  for (const key of [
    "appointmentDate",
    "serviceDate",
    "callDate",
    "dispatchDate",
    "date",
    "windowDate",
  ]) {
    const value = asText(data[key]);
    if (isIsoDate(value)) return value;
  }
  if (isIsoDate(documentId)) return documentId;
  return "";
}

function documentToText(
  collectionId: string,
  documentId: string,
  data: Record<string, unknown>
): { title: string; text: string; date: string } {
  const title = documentTitle(collectionId, documentId, data);
  const lines = flattenValue(data, "", 0);
  const header = [
    `collection: ${collectionId}`,
    `id: ${documentId}`,
    title ? `title: ${title}` : "",
  ].filter(Boolean);
  return {
    title,
    date: documentDate(data, documentId),
    text: [...header, ...lines].join("\n").trim(),
  };
}

function splitChunks(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + CHUNK_CHARS);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP);
  }
  return chunks;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const openai = openaiClient();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const result = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMS,
    });
    const byIndex = new Map(result.data.map((row) => [row.index, row.embedding]));
    for (let j = 0; j < batch.length; j += 1) {
      const embedding = byIndex.get(j);
      if (!embedding || embedding.length !== EMBEDDING_DIMS) {
        throw new Error("OpenAI returned an incomplete embedding batch");
      }
      vectors.push(embedding);
    }
  }
  return vectors;
}

async function readStatus(): Promise<KnowledgeStatus> {
  const snap = await admin.firestore().collection(META).doc(META_DOC).get();
  return (snap.data() || { status: "idle" }) as KnowledgeStatus;
}

async function writeStatus(patch: Partial<KnowledgeStatus>) {
  await admin.firestore().collection(META).doc(META_DOC).set(
    {
      ...patch,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export async function indexDocument(
  collectionId: string,
  documentId: string,
  data: Record<string, unknown>
): Promise<{ chunks: number; embedded: boolean }> {
  const converted = documentToText(collectionId, documentId, data);
  if (converted.text.length < 12) return { chunks: 0, embedded: false };
  const pieces = splitChunks(converted.text);
  const contentHash = sha(pieces.join("\n---\n"));
  const sourceId = sourceDocId(collectionId, documentId);
  const sourceRef = admin.firestore().collection(SOURCES).doc(sourceId);
  const prior = await sourceRef.get();
  const priorCount = Number(prior.data()?.chunkCount || 0);
  const priorFormat = Number(prior.data()?.format || 1);
  if (
    prior.exists &&
    asText(prior.data()?.hash) === contentHash &&
    priorFormat === INDEX_FORMAT
  ) {
    return { chunks: priorCount, embedded: false };
  }
  const embeddings = await embedTexts(pieces);
  const batch = admin.firestore().batch();
  pieces.forEach((text, index) => {
    const record: ChunkRecord = {
      sourceCollection: collectionId,
      sourceId: documentId,
      chunkIndex: index,
      title: converted.title,
      text,
      // Firestore rejects `undefined`; keep the field present so the
      // date + embedding composite index stays consistent.
      date: converted.date || "",
      // Firestore's vector index ignores plain arrays; this must be a vector value.
      embedding: FieldValue.vector(embeddings[index]),
      hash: contentHash,
      format: INDEX_FORMAT,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    batch.set(admin.firestore().collection(CHUNKS).doc(chunkDocId(collectionId, documentId, index)), record);
  });
  for (let extra = pieces.length; extra < priorCount; extra += 1) {
    batch.delete(
      admin.firestore().collection(CHUNKS).doc(chunkDocId(collectionId, documentId, extra))
    );
  }
  batch.set(sourceRef, {
    sourceCollection: collectionId,
    sourceId: documentId,
    hash: contentHash,
    format: INDEX_FORMAT,
    chunkCount: pieces.length,
    date: converted.date || "",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return { chunks: pieces.length, embedded: true };
}

async function indexSnapshot(
  collectionId: string,
  docs: FirebaseFirestore.QueryDocumentSnapshot[]
): Promise<{ documents: number; chunks: number; embedded: number }> {
  let documents = 0;
  let chunks = 0;
  let embedded = 0;
  for (const doc of docs) {
    const result = await indexDocument(collectionId, doc.id, doc.data() as Record<string, unknown>);
    documents += 1;
    chunks += result.chunks;
    if (result.embedded) embedded += 1;
  }
  return { documents, chunks, embedded };
}

async function paginateCollection(
  collectionId: string,
  onPage: (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => Promise<void>,
  maxDocs = 1200
) {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let seen = 0;
  for (;;) {
    let query: FirebaseFirestore.Query = admin
      .firestore()
      .collection(collectionId)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(80);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    const remaining = Math.max(0, maxDocs - seen);
    const take = snap.docs.slice(0, remaining);
    if (take.length) await onPage(take);
    seen += take.length;
    cursor = snap.docs[snap.docs.length - 1];
    if (seen >= maxDocs || snap.size < 80) break;
  }
}

async function indexNamedDocs(
  rows: Array<{ collectionId: string; docs: FirebaseFirestore.DocumentSnapshot[] }>
): Promise<{ documents: number; chunks: number }> {
  let documents = 0;
  let chunks = 0;
  for (const row of rows) {
    for (const doc of row.docs) {
      if (!doc.exists) continue;
      const result = await indexDocument(
        row.collectionId,
        doc.id,
        (doc.data() || {}) as Record<string, unknown>
      );
      documents += 1;
      chunks += result.chunks;
    }
  }
  return { documents, chunks };
}

async function indexToday(): Promise<{ documents: number; chunks: number }> {
  const date = todayIso();
  const db = admin.firestore();
  const [dispatch, schedule] = await Promise.all([
    db.collection("dispatchPlans").doc(date).get(),
    db.collection("schedules").doc(date).get(),
  ]);
  const optional = await Promise.all(
    [
      ["workOrders", "appointmentDate"],
      ["jobTickets", "serviceDate"],
      ["plaudCalls", "callDate"],
      ["voiceConfirmations", "dispatchDate"],
    ].map(async ([collectionId, field]) => {
      try {
        return {
          collectionId,
          docs: (await db.collection(collectionId).where(field, "==", date).limit(200).get()).docs,
        };
      } catch (error) {
        console.warn(`voice agent today index skipped ${collectionId}`, error);
        return { collectionId, docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] };
      }
    })
  );
  const result = await indexNamedDocs([
    { collectionId: "dispatchPlans", docs: [dispatch] },
    { collectionId: "schedules", docs: [schedule] },
    ...optional,
  ]);
  await writeStatus({ lastTodayIndexAt: new Date().toISOString() });
  return result;
}

async function reindexAll(): Promise<KnowledgeStatus> {
  const started = new Date().toISOString();
  await writeStatus({ status: "running", startedAt: started, error: "" });
  try {
    const collections = await admin.firestore().listCollections();
    let documentCount = 0;
    let chunkCount = 0;
    let collectionCount = 0;
    for (const collectionRef of collections) {
      if (SKIP_COLLECTIONS.has(collectionRef.id)) continue;
      collectionCount += 1;
      await paginateCollection(collectionRef.id, async (docs) => {
        const result = await indexSnapshot(collectionRef.id, docs);
        documentCount += result.documents;
        chunkCount += result.chunks;
      }, 1200);
    }
    const status: KnowledgeStatus = {
      status: "idle",
      lastIndexedAt: new Date().toISOString(),
      lastTodayIndexAt: new Date().toISOString(),
      chunkCount,
      documentCount,
      collectionCount,
      error: "",
      startedAt: started,
    };
    await writeStatus(status);
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Indexing failed";
    await writeStatus({ status: "error", error: message, startedAt: started });
    throw error;
  }
}

function agentTools() {
  return [
    {
      type: "function",
      name: "search_company_data",
      description:
        "Semantic search over embedded NJ Plumbing Firebase records: work orders, dispatch, schedules, job tickets, Plaud calls, SMS, inbox notes, and related office data. Use this for questions about customers, jobs, history, and anything not tied to a single known date or work-order number.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search question or keywords, including names, addresses, phones, or job details.",
          },
          date: {
            type: "string",
            description: "Optional YYYY-MM-DD to prefer records from that day.",
          },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "lookup_by_date",
      description:
        "Load the live dispatch plan, truck schedule, work orders, and job tickets for one calendar day.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Day to look up as YYYY-MM-DD. Use today if the user says today.",
          },
        },
        required: ["date"],
      },
    },
    {
      type: "function",
      name: "lookup_work_order",
      description:
        "Find a work order by number, customer name, phone, address, job type, or a short spoken query. Uses live records and fuzzy matching.",
      parameters: {
        type: "object",
        properties: {
          workOrderNumber: { type: "string" },
          customerName: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          jobType: { type: "string" },
          query: {
            type: "string",
            description: "Free text such as a last name plus job type or street.",
          },
          date: { type: "string" },
        },
      },
    },
    ...extraAgentTools(),
  ];
}

function agentInstructions(): string {
  return [
    `You are the office voice assistant for ${companyName()}, a plumbing company in Connecticut.`,
    `Right now it is ${spokenNow()} (${businessTimeZone()}). Today is ${todayIso()}.`,
    "You are talking to office staff over a live microphone, not to a customer.",
    "Keep spoken answers short and specific. Name customers, trucks, windows, and work-order numbers when you have them.",
    "For any factual question about jobs, dispatch, customers, calls, tickets, SMS, or history, call a tool before answering.",
    "Use lookup_by_date for a day's board. Use lookup_work_order for a job. Use lookup_staff for plumbers and truck phones. Use lookup_sms_thread for recent texts. Use search_company_data for everything else.",
    "You can text plumbers and customers through the shop phone with send_sms, and you can cancel_job (reversible on the board).",
    "You can set up the trucks: auto_assign_jobs spreads every Ready / Unassigned job across the open trucks; assign_job_to_truck puts one job on a named truck or plumber; unassign_job sends a job back to Ready.",
    "Cancel only when they say cancel, kill, or get rid of a job. If they say take it off the truck, use unassign_job. You cannot close or delete jobs; if asked, say that has to be done on the dispatch board.",
    "For send_sms, cancel_job, assign_job_to_truck, unassign_job, and auto_assign_jobs: first call the tool without confirmed. Speak the returned speakThis question and wait. Only after they clearly say yes, call again with confirmed true and that confirmationId. Never set confirmed true on the first call. Never invent a phone number.",
    "If a tool returns ambiguous matches, ask which one. If it returns an error, say so.",
    "If tools return nothing, say you could not find it. Never invent jobs, times, or dollar amounts.",
    "Do not read card numbers, routing numbers, signatures, or API secrets even if they appear in search text.",
    "If the user just greets you, greet them back and offer to look up today's dispatch, set up the trucks, text someone, or cancel a job.",
  ].join(" ");
}

function sessionConfig() {
  return {
    session: {
      type: "realtime",
      model: realtimeModel(),
      instructions: agentInstructions(),
      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.6,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
        },
        output: { voice: realtimeVoice() },
      },
      tools: agentTools(),
      tool_choice: "auto",
    },
  };
}

function compactWorkOrder(id: string, data: FirebaseFirestore.DocumentData) {
  return {
    id,
    workOrderNumber: asText(data.workOrderNumber),
    customerName: asText(data.customerName),
    phone: asText(data.phone),
    address: asText(data.address),
    jobType: asText(data.jobType),
    appointmentDate: asText(data.appointmentDate),
    appointmentTime: asText(data.appointmentTime),
    status: asText(data.status),
    notes: asText(data.notes).slice(0, 800),
    installDescription: asText(data.installDescription).slice(0, 400),
  };
}

async function lookupByDate(date: string) {
  if (!isIsoDate(date)) {
    return { error: "date must be YYYY-MM-DD" };
  }
  const db = admin.firestore();
  const [dispatch, schedule, workOrders, tickets] = await Promise.all([
    db.collection("dispatchPlans").doc(date).get(),
    db.collection("schedules").doc(date).get(),
    db.collection("workOrders").where("appointmentDate", "==", date).limit(80).get(),
    db.collection("jobTickets").where("serviceDate", "==", date).limit(80).get(),
  ]);
  const dispatchData = dispatch.data() as { trucks?: Array<Record<string, unknown>> } | undefined;
  const trucks = Array.isArray(dispatchData?.trucks)
    ? dispatchData!.trucks.map((truck) => {
        const stops = Array.isArray(truck.stops) ? (truck.stops as Array<Record<string, unknown>>) : [];
        return {
          id: asText(truck.id),
          name: asText(truck.name),
          driver: asText(truck.driver),
          stops: stops.slice(0, 20).map((stop) => ({
            workOrderNumber: asText(stop.workOrderNumber),
            customerName: asText(stop.customerName),
            address: asText(stop.address),
            phone: asText(stop.phone),
            jobType: asText(stop.jobType),
            window: stop.window,
            cancelled: stop.cancelled === true,
            notes: asText(stop.notes).slice(0, 240),
          })),
        };
      })
    : [];
  return {
    date,
    dispatchTrucks: trucks,
    scheduleExists: schedule.exists,
    workOrders: workOrders.docs.map((doc) => compactWorkOrder(doc.id, doc.data())),
    jobTickets: tickets.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        workOrderNumber: asText(data.workOrderNumber),
        customerName: asText(data.customerName),
        address: asText(data.address),
        jobType: asText(data.jobType),
        plumberName: asText(data.plumberName),
        status: asText(data.status),
        workPerformed: asText(data.workPerformed).slice(0, 400),
      };
    }),
  };
}

/**
 * Semantic search over the embedded company records using Firestore's native
 * KNN vector index (`findNearest`). Returns hits sorted best-first with
 * `score` as cosine similarity (1 = identical) for continuity with callers.
 */
export async function searchKnowledge(
  query: string,
  options: { date?: string; limit?: number; maxDistance?: number } = {}
): Promise<KnowledgeSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const [vector] = await embedTexts([q.slice(0, 4000)]);
  const limit = Math.min(200, Math.max(1, options.limit ?? SEARCH_TOP_K));
  let base: FirebaseFirestore.Query = admin.firestore().collection(CHUNKS);
  if (options.date && isIsoDate(options.date)) {
    base = base.where("date", "==", options.date);
  }
  const snap = await base
    .findNearest({
      vectorField: "embedding",
      queryVector: FieldValue.vector(vector),
      limit,
      distanceMeasure: "COSINE",
      distanceResultField: "vectorDistance",
      distanceThreshold: options.maxDistance ?? SEARCH_MAX_DISTANCE,
    })
    .get();
  const hits: KnowledgeSearchHit[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as ChunkRecord & { vectorDistance?: number };
    if (!data.text) continue;
    const distance = typeof data.vectorDistance === "number" ? data.vectorDistance : 1;
    hits.push({
      score: Math.round((1 - distance) * 1000) / 1000,
      title: data.title,
      collection: data.sourceCollection,
      id: data.sourceId,
      date: data.date || "",
      text: data.text.slice(0, 1400),
    });
  }
  hits.sort((left, right) => right.score - left.score);
  return hits;
}

async function searchCompanyData(query: string, date?: string) {
  const q = query.trim();
  if (q.length < 2) return { results: [], note: "Query was empty." };
  const results = await searchKnowledge(q, { date });
  if (results.length) return { results };
  const status = await readStatus();
  return {
    results,
    note: Number(status.chunkCount || 0) > 0
      ? "No close matches in the embedding index."
      : "The embedding index is empty. Ask staff to tap Index company data, then retry.",
  };
}

export async function runVoiceAgentTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (name === "search_company_data") {
    return searchCompanyData(asText(args.query), asText(args.date) || undefined);
  }
  if (name === "lookup_by_date") {
    const payload = await lookupByDate(asText(args.date) || todayIso());
    if ("error" in payload) return payload;
    return enrichDayLookup(payload);
  }
  if (name === "lookup_work_order") {
    return lookupWorkOrderLive({
      workOrderNumber: asText(args.workOrderNumber),
      customerName: asText(args.customerName),
      phone: asText(args.phone),
      address: asText(args.address),
      jobType: asText(args.jobType),
      query: asText(args.query),
      date: asText(args.date),
    });
  }
  return runOfficeAction(name, args);
}

function ephemeralKeyFrom(payload: Record<string, unknown>): string {
  if (typeof payload.value === "string" && payload.value) return payload.value;
  const nested = payload.client_secret;
  if (nested && typeof nested === "object") {
    const value = (nested as { value?: unknown }).value;
    if (typeof value === "string" && value) return value;
  }
  return "";
}

async function mintRealtimeSecret(): Promise<{ value: string; model: string; voice: string }> {
  const apiKey = openaiKey();
  if (!apiKey) {
    throw new HttpsError("failed-precondition", "OPENAI_API_KEY is not configured");
  }
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(sessionConfig()),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      asText((payload.error as { message?: unknown } | undefined)?.message) ||
      asText(payload.error) ||
      `OpenAI client secret failed (${response.status})`;
    throw new HttpsError("internal", message.slice(0, 300));
  }
  const value = ephemeralKeyFrom(payload);
  if (!value) {
    throw new HttpsError("internal", "OpenAI did not return a realtime client secret");
  }
  return { value, model: realtimeModel(), voice: realtimeVoice() };
}

export const createVoiceAgentSession = onCall(
  { cors: true, timeoutSeconds: 120, memory: "1GiB" },
  async () => {
    const secret = await mintRealtimeSecret();
    const status = await readStatus();
    const lastToday = Date.parse(asText(status.lastTodayIndexAt));
    const todayStale = !Number.isFinite(lastToday) || Date.now() - lastToday > TODAY_INDEX_MAX_AGE_MS;
    if (todayStale) {
      try {
        await indexToday();
      } catch (error) {
        console.error("voice agent today index failed", error);
      }
    }
    const latest = await readStatus();
    return {
      clientSecret: secret.value,
      model: secret.model,
      voice: secret.voice,
      knowledge: latest,
    };
  }
);

export const searchVoiceKnowledge = onCall(
  { cors: true, timeoutSeconds: 120, memory: "1GiB" },
  async (request) => {
    const input = request.data as { name?: unknown; arguments?: unknown };
    const name = asText(input.name);
    const args =
      input.arguments && typeof input.arguments === "object"
        ? (input.arguments as Record<string, unknown>)
        : {};
    if (!name) throw new HttpsError("invalid-argument", "A tool name is required");
    return runVoiceAgentTool(name, args);
  }
);

export const getVoiceKnowledgeStatus = onCall({ cors: true }, async () => readStatus());

export const reindexVoiceKnowledge = onCall(
  { cors: true, timeoutSeconds: 1800, memory: "1GiB" },
  async () => reindexAll()
);

export const reindexVoiceKnowledgeScheduled = onSchedule(
  {
    schedule: "every day 03:20",
    timeZone: "America/New_York",
    timeoutSeconds: 1800,
    memory: "1GiB",
  },
  async () => {
    await reindexAll();
  }
);
