/**
 * AI-assisted email replies.
 *
 * Pipeline for one inbound message (e.g. a Home Depot / 1-800 Heaters permit
 * question):
 *
 *   1. EXTRACT  — a vision-capable model acts as a dumb pipe: it reads the
 *                 email text plus any image / PDF attachments (screenshots of
 *                 spreadsheets, highlighted tables) and returns only the
 *                 identifiers it sees: names, retailer PO numbers, our sales
 *                 order numbers, phones, addresses, towns, dates, and the
 *                 questions being asked. It does not answer anything.
 *   2. RESOLVE  — deterministic matching of those identifiers against the
 *                 work-order catalog (exact WO#, phone digits, fuzzy name +
 *                 town + service date, retailer number in PDF text), then a
 *                 job timeline is assembled for every match from Firestore
 *                 (work order, job tickets, dispatch stop, Plaud calls, SMS,
 *                 prior emails).
 *   3. SEARCH   — Firestore vector search (findNearest) over the company
 *                 embedding index for whatever the algorithmic pass could not
 *                 pin down, plus the sender's questions.
 *   4. DRAFT    — the model writes a reply grounded only in that evidence,
 *                 lists what it could not answer, cites the records it used,
 *                 and refreshes the running markdown memory we keep for the
 *                 correspondent. The draft is saved to Firestore and, when
 *                 the inbox has the compose scope, to Gmail as a draft on the
 *                 thread. Nothing is auto-sent.
 */
import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import OpenAI from "openai";
import { costFromUsage } from "./emailBriefing";
import {
  accountId,
  createGmailReplyDraft,
  firstInboxEmail,
  loadGmailAttachmentBytes,
  loadGmailMessageFull,
  type GmailFullMessage,
} from "./gmailInbox";
import { indexDocument, searchKnowledge, type KnowledgeSearchHit } from "./voiceAgent";

const EMAIL_MESSAGES = "emailMessages";
const REPLY_DRAFTS = "emailReplyDrafts";
const CORRESPONDENTS = "emailCorrespondents";

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 6_000_000;
const MAX_PDF_ATTACHMENTS = 3;
const MAX_PDF_TEXT = 12000;
const MAX_EMAIL_BODY = 16000;
const CATALOG_TTL_MS = 3 * 60 * 1000;
const MATCH_THRESHOLD = 60;
const AMBIGUOUS_GAP = 15;
const VECTOR_HITS_PER_QUERY = 5;
const VECTOR_HITS_TOTAL = 14;

type Extraction = {
  senderName: string;
  senderEmail: string;
  senderCompany: string;
  senderPhone: string;
  senderRole: string;
  intent: string;
  questions: string[];
  urgency: "high" | "normal" | "low";
  references: ExtractedReference[];
  attachmentNotes: string[];
};

type ExtractedReference = {
  customerName: string;
  retailerOrderNumber: string;
  workOrderNumber: string;
  phone: string;
  address: string;
  town: string;
  date: string;
  note: string;
};

type CatalogRow = {
  id: string;
  workOrderNumber: string;
  customerName: string;
  phones: string[];
  address: string;
  jobType: string;
  status: string;
  appointmentDate: string;
  appointmentTime: string;
  pdfServiceDate: string;
  installDescription: string;
  notes: string;
  sourceFileName: string;
  permitPulled: boolean;
  permitPulledAt: string;
  retailerUploaded: boolean;
  retailerUploadedAt: string;
  duplicateOfWorkOrderNumber: string;
  hay: string;
  nameKey: string;
  lastName: string;
};

type MatchReason = string;

type ResolvedReference = {
  reference: ExtractedReference;
  match?: { row: CatalogRow; score: number; reasons: MatchReason[] };
  ambiguous?: Array<{ row: CatalogRow; score: number; reasons: MatchReason[] }>;
};

type JobTimeline = {
  workOrder: Record<string, unknown>;
  jobTickets: Array<Record<string, unknown>>;
  dispatch: Record<string, unknown> | null;
  calls: Array<Record<string, unknown>>;
  sms: Array<Record<string, unknown>>;
  priorEmails: Array<Record<string, unknown>>;
};

type CorrespondentRecord = {
  id: string;
  email: string;
  domain: string;
  name: string;
  company: string;
  phone: string;
  role: string;
  notesMarkdown: string;
  messageCount: number;
  recentSubjects: string[];
  recentWorkOrders: string[];
  firstSeenAt?: string;
  lastSeenAt?: string;
};

type DraftResult = {
  subject: string;
  reply: string;
  confidence: "high" | "medium" | "low";
  answered: string[];
  unresolved: string[];
  citations: Array<{ collection: string; id: string; title: string }>;
  internalNotes: string;
  correspondentNotes: string;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asList(value: unknown, max = 40): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asText(item)).filter(Boolean).slice(0, max);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function openaiClient(): OpenAI {
  const apiKey = asText(process.env.OPENAI_API_KEY);
  if (!apiKey) throw new HttpsError("failed-precondition", "OPENAI_API_KEY is not configured");
  return new OpenAI({ apiKey });
}

function emailModel(): string {
  return asText(process.env.OPENAI_EMAIL_MODEL) || asText(process.env.OPENAI_MODEL) || "gpt-5.6-sol";
}

function companyName(): string {
  return asText(process.env.COMPANY_NAME) || "N&J Plumbing";
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

function parseJsonObject(text: string): Record<string, unknown> {
  const stripped = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("AI response did not contain a JSON object");
  return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
}

function phoneDigits(value: string): string {
  return value.replace(/\D/g, "").slice(-10);
}

function hay(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nameKey(value: string): string {
  return hay(value)
    .split(" ")
    .filter((token) => token.length > 1 && !["mr", "mrs", "ms", "dr", "jr", "sr", "ii", "iii"].includes(token))
    .sort()
    .join(" ");
}

function lastNameOf(value: string): string {
  const tokens = hay(value)
    .split(" ")
    .filter((token) => token.length > 1 && !["jr", "sr", "ii", "iii"].includes(token));
  return tokens[tokens.length - 1] || "";
}

function parseAddressHeader(value: string): { name: string; email: string } {
  const match = value.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].trim(), email: match[2].trim().toLowerCase() };
  const bare = value.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return { name: bare ? "" : value.trim(), email: bare ? bare[0].toLowerCase() : "" };
}

/** Normalize many date spellings (9/3/2026, Sept 3, 2026-09-03) to YYYY-MM-DD. */
function normalizeDate(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const us = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: businessTimeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(parsed);
  }
  return "";
}

function daysBetween(a: string, b: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const left = Date.parse(`${a}T12:00:00Z`);
  const right = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.abs(Math.round((left - right) / 86_400_000));
}

/** Copy of a write payload with FieldValue sentinels removed, safe to hand to the indexer. */
function indexable(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value instanceof admin.firestore.FieldValue) continue;
    out[key] = value;
  }
  return out;
}

function stampIso(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
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

// ---------------------------------------------------------------------------
// Stage 1 — extraction ("dumb pipe")
// ---------------------------------------------------------------------------

/** Cheap, deterministic pre-pass so obvious identifiers survive even if the model misses them. */
function regexReferences(text: string): ExtractedReference[] {
  const found = new Map<string, ExtractedReference>();
  const add = (key: string, patch: Partial<ExtractedReference>) => {
    if (found.has(key)) return;
    found.set(key, {
      customerName: "",
      retailerOrderNumber: "",
      workOrderNumber: "",
      phone: "",
      address: "",
      town: "",
      date: "",
      note: "regex",
      ...patch,
    });
  };
  for (const match of text.matchAll(/\b(?:wo|w\.?o\.?|work[\s_-]*order|sales[\s_-]*order|order(?:\s*(?:number|no|#))?)[\s#:._-]*(\d{5,8})\b/gi)) {
    add(`wo:${match[1]}`, { workOrderNumber: match[1] });
  }
  // Home Depot / retailer PO style: a letter followed by 7-10 digits (F61774126).
  for (const match of text.matchAll(/\b([A-Z]\d{7,10})\b/g)) {
    add(`po:${match[1]}`, { retailerOrderNumber: match[1] });
  }
  for (const match of text.matchAll(/(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g)) {
    const digits = `${match[1]}${match[2]}${match[3]}`;
    // Skip obvious non-phones (order numbers already matched above are 5-8 digits).
    if (/^(?:0|1)/.test(digits)) continue;
    add(`ph:${digits}`, { phone: digits });
  }
  return [...found.values()];
}

function readExtraction(raw: Record<string, unknown>, fallbackFrom: string): Extraction {
  const refsRaw = Array.isArray(raw.references) ? raw.references : [];
  const references: ExtractedReference[] = refsRaw
    .map((item) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        customerName: asText(row.customerName).slice(0, 120),
        retailerOrderNumber: asText(row.retailerOrderNumber).replace(/\s+/g, "").slice(0, 40),
        workOrderNumber: asText(row.workOrderNumber).replace(/\D/g, "").slice(0, 12),
        phone: phoneDigits(asText(row.phone)),
        address: asText(row.address).slice(0, 200),
        town: asText(row.town).slice(0, 80),
        date: normalizeDate(asText(row.date)),
        note: asText(row.note).slice(0, 300),
      };
    })
    .filter(
      (ref) =>
        ref.customerName || ref.retailerOrderNumber || ref.workOrderNumber || ref.phone || ref.address
    )
    .slice(0, 40);
  const header = parseAddressHeader(fallbackFrom);
  const urgency = asText(raw.urgency).toLowerCase();
  return {
    senderName: asText(raw.senderName).slice(0, 120) || header.name,
    senderEmail: asText(raw.senderEmail).toLowerCase().slice(0, 200) || header.email,
    senderCompany: asText(raw.senderCompany).slice(0, 120),
    senderPhone: asText(raw.senderPhone).slice(0, 40),
    senderRole: asText(raw.senderRole).slice(0, 120),
    intent: asText(raw.intent).slice(0, 600),
    questions: asList(raw.questions, 12).map((item) => item.slice(0, 300)),
    urgency: urgency === "high" || urgency === "low" ? urgency : "normal",
    references,
    attachmentNotes: asList(raw.attachmentNotes, 10).map((item) => item.slice(0, 300)),
  };
}

function mergeReferences(primary: ExtractedReference[], extra: ExtractedReference[]): ExtractedReference[] {
  const out = [...primary];
  const has = (pred: (ref: ExtractedReference) => boolean) => out.some(pred);
  for (const ref of extra) {
    if (ref.workOrderNumber && has((r) => r.workOrderNumber === ref.workOrderNumber)) continue;
    if (
      ref.retailerOrderNumber &&
      has((r) => r.retailerOrderNumber.toUpperCase() === ref.retailerOrderNumber.toUpperCase())
    ) {
      continue;
    }
    if (ref.phone && has((r) => r.phone === ref.phone)) continue;
    out.push(ref);
  }
  return out;
}

async function pdfText(buffer: Buffer): Promise<string> {
  // Loaded on demand for the same reason as in index.ts: pdf-parse pulls in
  // pdfjs + a native canvas binding at require time.
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

type AttachmentContext = {
  images: Array<{ name: string; dataUrl: string }>;
  pdfTexts: Array<{ name: string; text: string }>;
  skipped: string[];
};

/** Attachments supplied inline (pasted email with screenshots) instead of fetched from Gmail. */
async function inlineAttachmentContext(
  files: Array<{ name: string; dataUrl: string }>
): Promise<AttachmentContext> {
  const images: Array<{ name: string; dataUrl: string }> = [];
  const pdfTexts: Array<{ name: string; text: string }> = [];
  const skipped: string[] = [];
  for (const file of files.slice(0, MAX_IMAGE_ATTACHMENTS + MAX_PDF_ATTACHMENTS)) {
    const match = file.dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    if (!match) {
      skipped.push(`${file.name} (not a base64 data URL)`);
      continue;
    }
    const mime = match[1].toLowerCase();
    const approxBytes = Math.floor((match[2].length * 3) / 4);
    if (/^image\/(png|jpe?g|gif|webp)$/.test(mime)) {
      if (approxBytes > MAX_IMAGE_BYTES) {
        skipped.push(`${file.name} (image too large)`);
      } else if (images.length < MAX_IMAGE_ATTACHMENTS) {
        images.push({ name: file.name, dataUrl: file.dataUrl });
      } else {
        skipped.push(`${file.name} (image limit reached)`);
      }
    } else if (mime === "application/pdf" && pdfTexts.length < MAX_PDF_ATTACHMENTS) {
      try {
        const text = await pdfText(Buffer.from(match[2], "base64"));
        pdfTexts.push({ name: file.name, text: text.slice(0, MAX_PDF_TEXT) });
      } catch (error) {
        skipped.push(`${file.name} (PDF unreadable: ${error instanceof Error ? error.message : "error"})`);
      }
    } else {
      skipped.push(`${file.name} (${mime})`);
    }
  }
  return { images, pdfTexts, skipped };
}

async function gatherAttachmentContext(
  email: string,
  message: GmailFullMessage
): Promise<AttachmentContext> {
  const images: Array<{ name: string; dataUrl: string }> = [];
  const pdfTexts: Array<{ name: string; text: string }> = [];
  const skipped: string[] = [];
  for (const attachment of message.attachments) {
    const mime = attachment.mimeType.toLowerCase();
    const isImage = /^image\/(png|jpe?g|gif|webp)$/.test(mime);
    const isPdf = mime === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf");
    if (isImage && images.length < MAX_IMAGE_ATTACHMENTS) {
      const bytes = await loadGmailAttachmentBytes(email, message.id, attachment.id, MAX_IMAGE_BYTES);
      if (!bytes) {
        skipped.push(`${attachment.name} (image too large)`);
        continue;
      }
      images.push({ name: attachment.name, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` });
    } else if (isPdf && pdfTexts.length < MAX_PDF_ATTACHMENTS) {
      const bytes = await loadGmailAttachmentBytes(email, message.id, attachment.id);
      if (!bytes) {
        skipped.push(`${attachment.name} (PDF too large)`);
        continue;
      }
      try {
        pdfTexts.push({ name: attachment.name, text: (await pdfText(bytes)).slice(0, MAX_PDF_TEXT) });
      } catch (error) {
        skipped.push(`${attachment.name} (PDF unreadable: ${error instanceof Error ? error.message : "error"})`);
      }
    } else {
      skipped.push(`${attachment.name} (${attachment.mimeType || "unknown type"})`);
    }
  }
  return { images, pdfTexts, skipped };
}

async function extractFromEmail(
  message: GmailFullMessage,
  attachments: { images: Array<{ name: string; dataUrl: string }>; pdfTexts: Array<{ name: string; text: string }> }
): Promise<{ extraction: Extraction; usage: ReturnType<typeof costFromUsage> }> {
  const client = openaiClient();
  const model = emailModel();
  const headerLines = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    message.cc ? `Cc: ${message.cc}` : "",
    `Date: ${message.date}`,
    `Subject: ${message.subject}`,
  ].filter(Boolean);
  const textBlock = [
    ...headerLines,
    "",
    message.body.slice(0, MAX_EMAIL_BODY),
    ...attachments.pdfTexts.map((pdf) => `\n\n=== ATTACHMENT TEXT: ${pdf.name} ===\n${pdf.text}`),
  ].join("\n");
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: textBlock },
  ];
  for (const image of attachments.images) {
    content.push({ type: "text", text: `Attached image: ${image.name}` });
    content.push({ type: "image_url", image_url: { url: image.dataUrl, detail: "high" } });
  }
  const result = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          `You are an extraction pipe for ${companyName()}, a Connecticut plumbing company that installs water heaters for 1-800 Heaters, Home Depot, and Lowe's.`,
          "Read the email and every attached image or table. Extract ONLY what is literally written. Do not answer, do not guess, do not add records that are not visible.",
          "Images are often screenshots of spreadsheets or highlighted rows; transcribe every row that names a customer or job as its own reference.",
          "Identifier hints: our sales-order / work-order numbers are 6 digits (e.g. 979932). Retailer PO or lead numbers look like a letter plus 8 digits (e.g. F61774126). Keep them separate.",
          "Return JSON only:",
          "{",
          '  "senderName": string, "senderEmail": string, "senderCompany": string, "senderPhone": string, "senderRole": string,',
          '  "intent": string (one sentence: what the sender wants from us),',
          '  "questions": string[] (each distinct ask, verbatim-ish),',
          '  "urgency": "high"|"normal"|"low",',
          '  "references": [{',
          '    "customerName": string, "retailerOrderNumber": string, "workOrderNumber": string,',
          '    "phone": string, "address": string, "town": string,',
          '    "date": string (as written), "note": string (status text on that row, e.g. "Sold. Paid in full")',
          "  }],",
          '  "attachmentNotes": string[] (what each image/PDF contains, one line each)',
          "}",
        ].join("\n"),
      },
      { role: "user", content },
    ],
  });
  const text = result.choices[0]?.message.content;
  if (!text) throw new HttpsError("internal", "OpenAI returned an empty extraction");
  const extraction = readExtraction(parseJsonObject(text), message.from);
  const senderDigits = phoneDigits(extraction.senderPhone);
  const hasNamedReference = extraction.references.some(
    (ref) => ref.customerName || ref.retailerOrderNumber || ref.workOrderNumber || ref.address
  );
  const fromRegex = regexReferences(
    `${message.subject}\n${message.body}\n${attachments.pdfTexts.map((pdf) => pdf.text).join("\n")}`
  ).filter((ref) => {
    if (!ref.phone) return true;
    // The sender's own number (signature block) is never a job reference.
    if (senderDigits && ref.phone === senderDigits) return false;
    // A bare phone is only worth chasing when the email gave us nothing better.
    return !hasNamedReference;
  });
  extraction.references = mergeReferences(extraction.references, fromRegex);
  return { extraction, usage: costFromUsage(result.model || model, result.usage) };
}

// ---------------------------------------------------------------------------
// Stage 2 — algorithmic resolution against the work-order catalog
// ---------------------------------------------------------------------------

let catalogCache: { at: number; rows: CatalogRow[] } | null = null;

function catalogRow(id: string, data: Record<string, unknown>): CatalogRow {
  const phones = new Set<string>();
  const addPhone = (value: unknown) => {
    const digits = phoneDigits(asText(value));
    if (digits.length === 10) phones.add(digits);
  };
  addPhone(data.phone);
  if (Array.isArray(data.phones)) data.phones.forEach(addPhone);
  const customerName = asText(data.customerName);
  const installDescription = asText(data.installDescription).slice(0, 1200);
  const notes = asText(data.notes).slice(0, 1200);
  const row: CatalogRow = {
    id,
    workOrderNumber: asText(data.workOrderNumber),
    customerName,
    phones: [...phones],
    address: asText(data.address),
    jobType: asText(data.jobType),
    status: asText(data.status),
    appointmentDate: asText(data.appointmentDate),
    appointmentTime: asText(data.appointmentTime),
    pdfServiceDate: asText(data.pdfServiceDate),
    installDescription,
    notes,
    sourceFileName: asText(data.sourceFileName),
    permitPulled: data.permitPulled === true,
    permitPulledAt: asText(data.permitPulledAt),
    retailerUploaded: data.retailerUploaded === true,
    retailerUploadedAt: asText(data.retailerUploadedAt),
    duplicateOfWorkOrderNumber: asText(data.duplicateOfWorkOrderNumber),
    hay: "",
    nameKey: nameKey(customerName),
    lastName: lastNameOf(customerName),
  };
  row.hay = hay(
    [row.workOrderNumber, customerName, row.address, installDescription, notes, row.sourceFileName].join(" ")
  );
  return row;
}

async function loadCatalog(): Promise<CatalogRow[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.rows;
  const rows: CatalogRow[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query: FirebaseFirestore.Query = admin
      .firestore()
      .collection("workOrders")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(400);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) rows.push(catalogRow(doc.id, doc.data() as Record<string, unknown>));
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 400 || rows.length >= 20000) break;
  }
  catalogCache = { at: Date.now(), rows };
  return rows;
}

function scoreRow(row: CatalogRow, ref: ExtractedReference): { score: number; reasons: MatchReason[] } {
  let score = 0;
  const reasons: MatchReason[] = [];
  if (ref.workOrderNumber) {
    if (row.workOrderNumber === ref.workOrderNumber || row.id === ref.workOrderNumber) {
      score += 100;
      reasons.push(`work order #${ref.workOrderNumber}`);
    } else if (row.hay.includes(hay(ref.workOrderNumber))) {
      score += 45;
      reasons.push(`#${ref.workOrderNumber} appears in record text`);
    }
  }
  if (ref.retailerOrderNumber) {
    if (row.hay.includes(hay(ref.retailerOrderNumber))) {
      score += 90;
      reasons.push(`retailer number ${ref.retailerOrderNumber} in record`);
    }
  }
  if (ref.phone && ref.phone.length === 10 && row.phones.includes(ref.phone)) {
    score += 90;
    reasons.push("phone number");
  }
  if (ref.customerName && row.customerName) {
    const refKey = nameKey(ref.customerName);
    const refLast = lastNameOf(ref.customerName);
    if (refKey && refKey === row.nameKey) {
      score += 80;
      reasons.push("full name");
    } else if (refLast && refLast === row.lastName) {
      const refFirst = hay(ref.customerName).split(" ")[0] || "";
      const rowFirst = hay(row.customerName).split(" ")[0] || "";
      if (refFirst && rowFirst && (refFirst === rowFirst || refFirst[0] === rowFirst[0])) {
        score += 62;
        reasons.push("last name + first initial");
      } else {
        score += 42;
        reasons.push("last name");
      }
    } else if (refLast && refLast.length >= 4 && row.hay.includes(refLast)) {
      score += 20;
      reasons.push("name fragment");
    }
  }
  if (ref.town) {
    const town = hay(ref.town);
    if (town && hay(row.address).includes(town)) {
      score += 15;
      reasons.push(`town ${ref.town}`);
    }
  }
  if (ref.address) {
    const tokens = hay(ref.address).split(" ").filter((token) => token.length >= 3);
    const addressHay = hay(row.address);
    const hits = tokens.filter((token) => addressHay.includes(token)).length;
    if (tokens.length && hits / tokens.length >= 0.6) {
      score += Math.round(50 * (hits / tokens.length));
      reasons.push("address");
    }
  }
  if (ref.date) {
    const candidates = [row.appointmentDate, row.pdfServiceDate].filter(Boolean);
    let best: number | null = null;
    for (const candidate of candidates) {
      const gap = daysBetween(ref.date, candidate);
      if (gap !== null && (best === null || gap < best)) best = gap;
    }
    if (best === 0) {
      score += 20;
      reasons.push(`service date ${ref.date}`);
    } else if (best !== null && best <= 3) {
      score += 10;
      reasons.push(`service date within ${best} day(s)`);
    } else if (best !== null && best > 45 && score > 0 && score < 100) {
      // Same-name customer from a very different period: probably a different job.
      score -= 15;
      reasons.push(`date is ${best} days off`);
    }
  }
  return { score, reasons };
}

function resolveReference(ref: ExtractedReference, catalog: CatalogRow[]): ResolvedReference {
  const scored = catalog
    .map((row) => ({ row, ...scoreRow(row, ref) }))
    .filter((hit) => hit.score >= MATCH_THRESHOLD)
    .sort((left, right) => right.score - left.score);
  if (!scored.length) return { reference: ref };
  const [top, second] = scored;
  if (!second || top.score >= second.score + AMBIGUOUS_GAP || top.row.workOrderNumber === second.row.workOrderNumber) {
    return { reference: ref, match: top };
  }
  return { reference: ref, ambiguous: scored.slice(0, 4) };
}

function compactWorkOrder(row: CatalogRow): Record<string, unknown> {
  return {
    id: row.id,
    workOrderNumber: row.workOrderNumber,
    customerName: row.customerName,
    address: row.address,
    jobType: row.jobType,
    status: row.status,
    appointmentDate: row.appointmentDate,
    appointmentTime: row.appointmentTime,
    pdfServiceDate: row.pdfServiceDate,
    permitPulled: row.permitPulled,
    permitPulledAt: row.permitPulledAt,
    retailerUploaded: row.retailerUploaded,
    retailerUploadedAt: row.retailerUploadedAt,
    duplicateOfWorkOrderNumber: row.duplicateOfWorkOrderNumber,
    installDescription: row.installDescription.slice(0, 500),
    notes: row.notes.slice(0, 900),
    sourceFileName: row.sourceFileName,
  };
}

async function loadTimeline(row: CatalogRow): Promise<JobTimeline> {
  const db = admin.firestore();
  const number = row.workOrderNumber;
  const phoneVariants = row.phones.flatMap((digits) => [`+1${digits}`, digits, `1${digits}`]).slice(0, 10);
  const [tickets, plan, calls, smsIn, smsOut, priorEmails] = await Promise.all([
    number
      ? db.collection("jobTickets").where("workOrderNumber", "==", number).limit(5).get()
      : Promise.resolve(null),
    row.appointmentDate ? db.collection("dispatchPlans").doc(row.appointmentDate).get() : Promise.resolve(null),
    number
      ? db.collection("plaudCalls").where("workOrderNumber", "==", number).limit(3).get().catch(() => null)
      : Promise.resolve(null),
    phoneVariants.length
      ? db.collection("smsInbox").where("from", "in", phoneVariants).limit(12).get().catch(() => null)
      : Promise.resolve(null),
    phoneVariants.length
      ? db.collection("smsOutbox").where("to", "in", phoneVariants).limit(12).get().catch(() => null)
      : Promise.resolve(null),
    number
      ? db
          .collection(EMAIL_MESSAGES)
          .where("linkedWorkOrderNumbers", "array-contains", number)
          .limit(6)
          .get()
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const jobTickets = (tickets?.docs || []).map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      serviceDate: asText(data.serviceDate),
      status: asText(data.status),
      plumberName: asText(data.plumberName),
      workPerformed: asText(data.workPerformed).slice(0, 900),
      followUpNotes: asText(data.followUpNotes).slice(0, 400),
      heaterModel: asText(data.heaterModel),
      serialNumber: asText(data.serialNumber),
      heaterLocation: asText(data.heaterLocation),
      tankWarrantyYears: asText(data.tankWarrantyYears),
      permitAmount: asText(data.permitAmount),
      totalAmount: asText(data.totalAmount),
      signedAt: asText(data.signedAt),
    };
  });

  let dispatch: Record<string, unknown> | null = null;
  const planData = plan?.exists ? (plan.data() as Record<string, unknown>) : null;
  if (planData) {
    const findStop = (stops: unknown, where: string, truckName = ""): Record<string, unknown> | null => {
      if (!Array.isArray(stops)) return null;
      for (const stop of stops as Array<Record<string, unknown>>) {
        if (asText(stop.workOrderId) === row.id || (number && asText(stop.workOrderNumber) === number)) {
          return {
            date: row.appointmentDate,
            location: where,
            truckName,
            window: stop.window,
            cancelled: stop.cancelled === true,
            movedToDate: asText(stop.movedToDate),
            morningTextStatus: asText(stop.morningTextStatus),
            voiceConfirmationResponse: asText(stop.voiceConfirmationResponse),
            notes: asText(stop.notes).slice(0, 300),
          };
        }
      }
      return null;
    };
    const trucks = Array.isArray(planData.trucks) ? (planData.trucks as Array<Record<string, unknown>>) : [];
    for (const truck of trucks) {
      dispatch = findStop(truck.stops, "truck", asText(truck.name) || asText(truck.driver));
      if (dispatch) break;
    }
    dispatch = dispatch || findStop(planData.unassigned, "unassigned") || findStop(planData.notReady, "notReady");
  }

  const callsOut = (calls?.docs || []).map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      callDate: asText(data.callDate),
      summary: asText(data.summary).slice(0, 700),
      appointmentMade: data.appointmentMade === true,
      appointmentDate: asText(data.appointmentDate),
    };
  });

  const sms: Array<Record<string, unknown>> = [];
  for (const doc of smsIn?.docs || []) {
    const data = doc.data();
    sms.push({ direction: "in", at: stampIso(data.receivedAt), from: asText(data.from), body: asText(data.body).slice(0, 400) });
  }
  for (const doc of smsOut?.docs || []) {
    const data = doc.data();
    sms.push({ direction: "out", at: stampIso(data.createdAt), to: asText(data.to), status: asText(data.status), body: asText(data.body).slice(0, 400) });
  }
  sms.sort((left, right) => String(left.at).localeCompare(String(right.at)));

  const priorEmailRows = (priorEmails?.docs || []).map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      date: asText(data.date),
      from: asText(data.from),
      subject: asText(data.subject),
      summary: asText(data.intent) || asText(data.body).slice(0, 300),
    };
  });

  return {
    workOrder: compactWorkOrder(row),
    jobTickets,
    dispatch,
    calls: callsOut,
    sms: sms.slice(-16),
    priorEmails: priorEmailRows,
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — vector search for what the algorithm could not pin down
// ---------------------------------------------------------------------------

async function vectorContext(
  extraction: Extraction,
  resolved: ResolvedReference[],
  message: GmailFullMessage
): Promise<{ queries: string[]; hits: KnowledgeSearchHit[] }> {
  const queries: string[] = [];
  if (extraction.intent) queries.push(extraction.intent);
  for (const question of extraction.questions.slice(0, 4)) queries.push(question);
  for (const item of resolved) {
    if (item.match) continue;
    const ref = item.reference;
    // A bare phone number (usually the sender's signature) is not worth a semantic query.
    if (!ref.customerName && !ref.retailerOrderNumber && !ref.workOrderNumber && !ref.address) continue;
    const text = [ref.customerName, ref.retailerOrderNumber, ref.workOrderNumber, ref.address, ref.town, ref.date, ref.note]
      .filter(Boolean)
      .join(" ");
    if (text.length >= 4) queries.push(text);
  }
  if (!queries.length && message.subject) queries.push(message.subject);
  const seen = new Set<string>();
  const hits: KnowledgeSearchHit[] = [];
  for (const query of queries.slice(0, 8)) {
    let found: KnowledgeSearchHit[] = [];
    try {
      found = await searchKnowledge(query, { limit: VECTOR_HITS_PER_QUERY });
    } catch (error) {
      console.warn("email vector search failed", query, error);
      continue;
    }
    for (const hit of found) {
      const key = `${hit.collection}/${hit.id}/${hit.text.slice(0, 40)}`;
      if (seen.has(key)) continue;
      // Skip chunks about this very email or drafts: they are not evidence.
      if (hit.collection === REPLY_DRAFTS) continue;
      if (hit.collection === EMAIL_MESSAGES && hit.id === message.id) continue;
      seen.add(key);
      hits.push(hit);
    }
  }
  hits.sort((left, right) => right.score - left.score);
  return { queries, hits: hits.slice(0, VECTOR_HITS_TOTAL) };
}

// ---------------------------------------------------------------------------
// Correspondent memory
// ---------------------------------------------------------------------------

function correspondentId(email: string): string {
  return sha(email.trim().toLowerCase()).slice(0, 32);
}

async function loadCorrespondent(email: string, name: string): Promise<CorrespondentRecord> {
  const id = correspondentId(email);
  const snap = await admin.firestore().collection(CORRESPONDENTS).doc(id).get();
  const data = (snap.data() || {}) as Record<string, unknown>;
  const domain = email.split("@")[1] || "";
  return {
    id,
    email: email.toLowerCase(),
    domain,
    name: asText(data.name) || name,
    company: asText(data.company),
    phone: asText(data.phone),
    role: asText(data.role),
    notesMarkdown: asText(data.notesMarkdown),
    messageCount: Number(data.messageCount) || 0,
    recentSubjects: asList(data.recentSubjects, 10),
    recentWorkOrders: asList(data.recentWorkOrders, 20),
    firstSeenAt: stampIso(data.firstSeenAt) || undefined,
    lastSeenAt: stampIso(data.lastSeenAt) || undefined,
  };
}

async function saveCorrespondent(
  record: CorrespondentRecord,
  extraction: Extraction,
  message: GmailFullMessage,
  notesMarkdown: string,
  workOrderNumbers: string[]
): Promise<CorrespondentRecord> {
  const merged: CorrespondentRecord = {
    ...record,
    name: extraction.senderName || record.name,
    company: extraction.senderCompany || record.company,
    phone: extraction.senderPhone || record.phone,
    role: extraction.senderRole || record.role,
    notesMarkdown: notesMarkdown || record.notesMarkdown,
    messageCount: record.messageCount + 1,
    recentSubjects: [message.subject, ...record.recentSubjects.filter((item) => item !== message.subject)]
      .filter(Boolean)
      .slice(0, 10),
    recentWorkOrders: [...workOrderNumbers, ...record.recentWorkOrders.filter((item) => !workOrderNumbers.includes(item))].slice(0, 20),
  };
  const ref = admin.firestore().collection(CORRESPONDENTS).doc(record.id);
  const payload: Record<string, unknown> = {
    email: merged.email,
    domain: merged.domain,
    name: merged.name,
    company: merged.company,
    phone: merged.phone,
    role: merged.role,
    notesMarkdown: merged.notesMarkdown.slice(0, 6000),
    messageCount: merged.messageCount,
    recentSubjects: merged.recentSubjects,
    recentWorkOrders: merged.recentWorkOrders,
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageId: message.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!record.firstSeenAt) payload.firstSeenAt = admin.firestore.FieldValue.serverTimestamp();
  await ref.set(payload, { merge: true });
  try {
    await indexDocument(CORRESPONDENTS, record.id, indexable(payload));
  } catch (error) {
    console.warn("correspondent index failed", error);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Stage 4 — drafting
// ---------------------------------------------------------------------------

function readDraft(raw: Record<string, unknown>, fallbackSubject: string): DraftResult {
  const confidence = asText(raw.confidence).toLowerCase();
  const citationsRaw = Array.isArray(raw.citations) ? raw.citations : [];
  return {
    subject: asText(raw.subject).slice(0, 200) || fallbackSubject,
    reply: asText(raw.reply).slice(0, 8000),
    confidence: confidence === "high" || confidence === "low" ? confidence : "medium",
    answered: asList(raw.answered, 12),
    unresolved: asList(raw.unresolved, 12),
    citations: citationsRaw
      .map((item) => {
        const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return {
          collection: asText(row.collection).slice(0, 60),
          id: asText(row.id).slice(0, 120),
          title: asText(row.title).slice(0, 200),
        };
      })
      .filter((item) => item.collection || item.title)
      .slice(0, 20),
    internalNotes: asText(raw.internalNotes).slice(0, 2000),
    correspondentNotes: asText(raw.correspondentNotes).slice(0, 6000),
  };
}

async function draftReply(input: {
  message: GmailFullMessage;
  extraction: Extraction;
  resolved: ResolvedReference[];
  timelines: JobTimeline[];
  vector: { queries: string[]; hits: KnowledgeSearchHit[] };
  correspondent: CorrespondentRecord;
  attachmentsSkipped: string[];
}): Promise<{ draft: DraftResult; usage: ReturnType<typeof costFromUsage> }> {
  const client = openaiClient();
  const model = emailModel();
  const evidence = {
    today: todayIso(),
    email: {
      from: input.message.from,
      to: input.message.to,
      cc: input.message.cc,
      date: input.message.date,
      subject: input.message.subject,
      body: input.message.body.slice(0, MAX_EMAIL_BODY),
      attachmentsNotRead: input.attachmentsSkipped,
    },
    extraction: input.extraction,
    matches: input.resolved.map((item) => ({
      reference: item.reference,
      matched: item.match
        ? { workOrderNumber: item.match.row.workOrderNumber, customerName: item.match.row.customerName, score: item.match.score, reasons: item.match.reasons }
        : null,
      ambiguous: item.ambiguous?.map((hit) => ({
        workOrderNumber: hit.row.workOrderNumber,
        customerName: hit.row.customerName,
        address: hit.row.address,
        appointmentDate: hit.row.appointmentDate,
        score: hit.score,
        reasons: hit.reasons,
      })),
    })),
    jobTimelines: input.timelines,
    semanticSearch: input.vector.hits.map((hit) => ({
      collection: hit.collection,
      id: hit.id,
      title: hit.title,
      date: hit.date,
      score: hit.score,
      text: hit.text,
    })),
    correspondent: {
      email: input.correspondent.email,
      name: input.correspondent.name,
      company: input.correspondent.company,
      role: input.correspondent.role,
      messageCount: input.correspondent.messageCount,
      recentSubjects: input.correspondent.recentSubjects,
      recentWorkOrders: input.correspondent.recentWorkOrders,
      notesMarkdown: input.correspondent.notesMarkdown,
    },
  };
  const result = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          `You draft email replies for the office at ${companyName()}, a licensed plumbing company in Connecticut that installs water heaters for 1-800 Heaters / Home Depot / Lowe's customers.`,
          "You are writing to a business partner or customer, not to staff. The office will review before sending, but write it ready to send.",
          "GROUNDING: state only facts present in jobTimelines, semanticSearch, or correspondent notes. Never invent dates, permit numbers, prices, serial numbers, or promises. If a record does not show something (e.g. permitPulled is false or missing), say we are checking and will follow up; do not claim it was done.",
          "For each reference the sender listed, answer row by row (name, their number, what we have: our WO#, install date, status, permit / upload flags, plumber, model + serial if the ticket has them).",
          "If a reference is unmatched or ambiguous, say plainly that we could not locate it and ask for the detail that would resolve it (address, phone, or our order number).",
          "Do not include internal notes, pricing, payment details, other customers' information, or anything from records that is not about the referenced jobs.",
          "Tone: brief, warm, professional, plain text. Greet by first name when known. Sign off as the office of the company (no personal name unless the correspondent notes say who usually signs).",
          "Also maintain the running markdown memory for this correspondent: who they are, company/role, what they usually ask for, how they like things formatted, open items and their dates. Rewrite the full notes (max ~1500 chars), merging old notes with what this email adds. Keep it factual.",
          "Return JSON only:",
          "{",
          '  "subject": string (reply subject, usually "Re: ..."),',
          '  "reply": string (the plain-text email body),',
          '  "confidence": "high"|"medium"|"low",',
          '  "answered": string[] (what the reply settles),',
          '  "unresolved": string[] (what the office must still do or find before sending),',
          '  "citations": [{ "collection": string, "id": string, "title": string }],',
          '  "internalNotes": string (for the office only: caveats, suggested follow-ups),',
          '  "correspondentNotes": string (full updated markdown memory)',
          "}",
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify(evidence) },
    ],
  });
  const text = result.choices[0]?.message.content;
  if (!text) throw new HttpsError("internal", "OpenAI returned an empty draft");
  const subject = input.message.subject.startsWith("Re:") ? input.message.subject : `Re: ${input.message.subject}`;
  return { draft: readDraft(parseJsonObject(text), subject), usage: costFromUsage(result.model || model, result.usage) };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function replyRecipients(message: GmailFullMessage, inbox: string): { to: string; cc: string } {
  const sender = parseAddressHeader(message.from);
  const others = [message.to, message.cc]
    .flatMap((header) => header.split(",").map((part) => part.trim()).filter(Boolean))
    .filter((part) => {
      const parsed = parseAddressHeader(part);
      return parsed.email && parsed.email !== inbox.toLowerCase() && parsed.email !== sender.email;
    });
  return { to: message.from, cc: [...new Set(others)].join(", ") };
}

export type PastedEmailInput = {
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  date?: string;
  body: string;
  /** Screenshots / PDFs as base64 data URLs. */
  files?: Array<{ name: string; dataUrl: string }>;
};

function readPasted(raw: unknown): PastedEmailInput | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const files = Array.isArray(row.files)
    ? row.files.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const file = item as Record<string, unknown>;
        const dataUrl = asText(file.dataUrl);
        if (!dataUrl.startsWith("data:")) return [];
        return [{ name: asText(file.name) || "attachment", dataUrl }];
      })
    : [];
  const pasted: PastedEmailInput = {
    from: asText(row.from).slice(0, 300),
    to: asText(row.to).slice(0, 300),
    cc: asText(row.cc).slice(0, 300),
    subject: asText(row.subject).slice(0, 300),
    date: asText(row.date).slice(0, 80),
    body: asText(row.body).slice(0, 40000),
    files,
  };
  if (!pasted.body && !pasted.subject && !files.length) return null;
  return pasted;
}

export async function answerEmail(input: {
  email?: string;
  messageId?: string;
  pasted?: PastedEmailInput | null;
  saveGmailDraft?: boolean;
}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let inbox = accountId(asText(input.email));
  let message: GmailFullMessage;
  let attachments: AttachmentContext;
  let fromGmail = false;

  if (input.pasted) {
    const pasted = input.pasted;
    const id = `pasted-${sha(`${pasted.from}|${pasted.subject}|${pasted.date}|${pasted.body}`).slice(0, 24)}`;
    message = {
      id,
      threadId: "",
      from: pasted.from,
      to: pasted.to || "",
      cc: pasted.cc || "",
      subject: pasted.subject,
      date: pasted.date || "",
      receivedAt: "",
      messageIdHeader: "",
      referencesHeader: "",
      body: pasted.body,
      attachments: (pasted.files || []).map((file) => ({
        id: "",
        name: file.name,
        mimeType: file.dataUrl.slice(5, file.dataUrl.indexOf(";")),
        size: 0,
      })),
    };
    attachments = await inlineAttachmentContext(pasted.files || []);
  } else {
    inbox = inbox || (await firstInboxEmail());
    if (!inbox) throw new HttpsError("failed-precondition", "Sign in a Gmail inbox first.");
    const messageId = asText(input.messageId);
    if (!messageId) throw new HttpsError("invalid-argument", "Message id is required.");
    message = await loadGmailMessageFull(inbox, messageId);
    attachments = await gatherAttachmentContext(inbox, message);
    fromGmail = true;
  }

  // 1. Extract.
  const { extraction, usage: extractUsage } = await extractFromEmail(message, attachments);

  // 2. Resolve algorithmically + build timelines.
  const catalog = await loadCatalog();
  const resolved = extraction.references.map((ref) => resolveReference(ref, catalog));
  const matchedRows = new Map<string, CatalogRow>();
  for (const item of resolved) {
    if (item.match) matchedRows.set(item.match.row.id, item.match.row);
  }
  const timelines: JobTimeline[] = [];
  for (const row of [...matchedRows.values()].slice(0, 12)) {
    timelines.push(await loadTimeline(row));
  }
  const workOrderNumbers = [...new Set([...matchedRows.values()].map((row) => row.workOrderNumber).filter(Boolean))];

  // 3. Vector search for the rest.
  const vector = await vectorContext(extraction, resolved, message);

  // Correspondent memory (read before drafting so the model sees history).
  const sender = parseAddressHeader(message.from);
  const senderEmail = extraction.senderEmail || sender.email;
  const correspondent = senderEmail
    ? await loadCorrespondent(senderEmail, extraction.senderName || sender.name)
    : null;

  // 4. Draft.
  const { draft, usage: draftUsage } = await draftReply({
    message,
    extraction,
    resolved,
    timelines,
    vector,
    correspondent:
      correspondent || {
        id: "",
        email: "",
        domain: "",
        name: extraction.senderName,
        company: extraction.senderCompany,
        phone: "",
        role: "",
        notesMarkdown: "",
        messageCount: 0,
        recentSubjects: [],
        recentWorkOrders: [],
      },
    attachmentsSkipped: attachments.skipped,
  });

  // Persist the email itself so it becomes part of the searchable record.
  const db = admin.firestore();
  const emailDoc: Record<string, unknown> = {
    gmailAccount: inbox,
    source: fromGmail ? "gmail" : "pasted",
    threadId: message.threadId,
    from: message.from,
    fromEmail: senderEmail,
    fromDomain: senderEmail.split("@")[1] || "",
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    date: message.date,
    receivedAt: message.receivedAt,
    body: message.body.slice(0, 20000),
    attachments: message.attachments.map((item) => ({ name: item.name, mimeType: item.mimeType, size: item.size })),
    attachmentNotes: extraction.attachmentNotes,
    intent: extraction.intent,
    questions: extraction.questions,
    urgency: extraction.urgency,
    references: extraction.references,
    linkedWorkOrderNumbers: workOrderNumbers,
    linkedWorkOrderIds: [...matchedRows.keys()],
    correspondentId: correspondent?.id || "",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection(EMAIL_MESSAGES).doc(message.id).set(emailDoc, { merge: true });
  try {
    await indexDocument(EMAIL_MESSAGES, message.id, indexable(emailDoc));
  } catch (error) {
    console.warn("email index failed", error);
  }

  let correspondentOut: CorrespondentRecord | null = correspondent;
  if (correspondent) {
    correspondentOut = await saveCorrespondent(correspondent, extraction, message, draft.correspondentNotes, workOrderNumbers);
  }

  // Gmail draft (best effort; needs compose scope).
  let gmailDraftId = "";
  let gmailDraftError = "";
  const recipients = replyRecipients(message, inbox);
  if (fromGmail && input.saveGmailDraft !== false && draft.reply) {
    try {
      const created = await createGmailReplyDraft({
        email: inbox,
        threadId: message.threadId,
        to: recipients.to,
        cc: recipients.cc,
        subject: draft.subject,
        body: draft.reply,
        inReplyTo: message.messageIdHeader || undefined,
        references: [message.referencesHeader, message.messageIdHeader].filter(Boolean).join(" ") || undefined,
      });
      gmailDraftId = created.draftId;
    } catch (error) {
      gmailDraftError = error instanceof Error ? error.message : String(error);
    }
  }

  const usage = {
    extract: extractUsage,
    draft: draftUsage,
    costUsd: Math.round(((extractUsage.costUsd || 0) + (draftUsage.costUsd || 0)) * 1e6) / 1e6,
    model: draftUsage.model,
  };

  const matches = resolved.map((item) => ({
    reference: item.reference,
    match: item.match
      ? {
          workOrderId: item.match.row.id,
          workOrderNumber: item.match.row.workOrderNumber,
          customerName: item.match.row.customerName,
          address: item.match.row.address,
          appointmentDate: item.match.row.appointmentDate,
          status: item.match.row.status,
          permitPulled: item.match.row.permitPulled,
          retailerUploaded: item.match.row.retailerUploaded,
          score: item.match.score,
          reasons: item.match.reasons,
        }
      : null,
    ambiguous: (item.ambiguous || []).map((hit) => ({
      workOrderId: hit.row.id,
      workOrderNumber: hit.row.workOrderNumber,
      customerName: hit.row.customerName,
      address: hit.row.address,
      appointmentDate: hit.row.appointmentDate,
      score: hit.score,
      reasons: hit.reasons,
    })),
  }));

  const draftRef = db.collection(REPLY_DRAFTS).doc();
  const stored = {
    gmailAccount: inbox,
    messageId: message.id,
    threadId: message.threadId,
    from: message.from,
    to: recipients.to,
    cc: recipients.cc,
    originalSubject: message.subject,
    subject: draft.subject,
    reply: draft.reply,
    confidence: draft.confidence,
    answered: draft.answered,
    unresolved: draft.unresolved,
    citations: draft.citations,
    internalNotes: draft.internalNotes,
    extraction,
    matches,
    vectorQueries: vector.queries,
    vectorHits: vector.hits.map((hit) => ({ collection: hit.collection, id: hit.id, title: hit.title, score: hit.score })),
    attachmentsSkipped: attachments.skipped,
    linkedWorkOrderNumbers: workOrderNumbers,
    correspondentId: correspondent?.id || "",
    gmailDraftId,
    gmailDraftError,
    status: "draft",
    usage,
    elapsedMs: Date.now() - startedAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await draftRef.set(stored);

  return {
    id: draftRef.id,
    inbox,
    messageId: message.id,
    threadId: message.threadId,
    subject: draft.subject,
    to: recipients.to,
    cc: recipients.cc,
    reply: draft.reply,
    confidence: draft.confidence,
    answered: draft.answered,
    unresolved: draft.unresolved,
    citations: draft.citations,
    internalNotes: draft.internalNotes,
    extraction,
    matches,
    timelines,
    vectorHits: vector.hits,
    attachmentsRead: {
      images: attachments.images.map((image) => image.name),
      pdfs: attachments.pdfTexts.map((pdf) => pdf.name),
      skipped: attachments.skipped,
    },
    correspondent: correspondentOut
      ? {
          id: correspondentOut.id,
          email: correspondentOut.email,
          name: correspondentOut.name,
          company: correspondentOut.company,
          role: correspondentOut.role,
          messageCount: correspondentOut.messageCount,
          notesMarkdown: correspondentOut.notesMarkdown,
          recentWorkOrders: correspondentOut.recentWorkOrders,
        }
      : null,
    gmailDraftId,
    gmailDraftError,
    usage,
    elapsedMs: Date.now() - startedAt,
  };
}

export const draftEmailReply = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {
    const input = (request.data || {}) as {
      email?: unknown;
      messageId?: unknown;
      pasted?: unknown;
      saveGmailDraft?: unknown;
    };
    const pasted = readPasted(input.pasted);
    if (!pasted && !asText(input.messageId)) {
      throw new HttpsError("invalid-argument", "Provide a Gmail message id or a pasted email.");
    }
    return answerEmail({
      email: asText(input.email),
      messageId: asText(input.messageId),
      pasted,
      saveGmailDraft: input.saveGmailDraft !== false,
    });
  }
);

export const getEmailCorrespondent = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 30 },
  async (request) => {
    const input = (request.data || {}) as { email?: unknown };
    const email = asText(input.email).toLowerCase();
    if (!email.includes("@")) throw new HttpsError("invalid-argument", "An email address is required.");
    const record = await loadCorrespondent(email, "");
    return {
      id: record.id,
      email: record.email,
      name: record.name,
      company: record.company,
      role: record.role,
      phone: record.phone,
      messageCount: record.messageCount,
      notesMarkdown: record.notesMarkdown,
      recentSubjects: record.recentSubjects,
      recentWorkOrders: record.recentWorkOrders,
      firstSeenAt: record.firstSeenAt || "",
      lastSeenAt: record.lastSeenAt || "",
    };
  }
);
