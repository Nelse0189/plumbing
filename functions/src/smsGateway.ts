import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as admin from "firebase-admin";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";

const SECRET_COLLECTION = "smsGatewaySecrets";
const STATUS_COLLECTION = "smsGatewayStatus";
const OUTBOX_COLLECTION = "smsOutbox";
const INBOX_COLLECTION = "smsInbox";
const CLAIM_TTL_MS = 2 * 60 * 1000;
const SMS_GATEWAY_MEMORY = "512MiB" as const;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeUsPhone(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) {
    return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function gatewayBaseUrl(): string {
  const projectId =
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    "nj-plumbing";
  return `https://us-central1-${projectId}.cloudfunctions.net`;
}

function gatewayUrls() {
  const base = gatewayBaseUrl();
  return {
    pollUrl: `${base}/smsGatewayPoll`,
    ackUrl: `${base}/smsGatewayAck`,
    inboundUrl: `${base}/smsGatewayInbound`,
  };
}

async function readSecretHash(): Promise<string> {
  const snap = await admin
    .firestore()
    .collection(SECRET_COLLECTION)
    .doc("config")
    .get();
  return asText(snap.data()?.tokenHash);
}

function tokenFromRequest(req: Request): string {
  const header = asText(req.get("x-sms-gateway-token"));
  if (header) return header;
  const auth = asText(req.get("authorization"));
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const fromBody = asText((body as { token?: unknown }).token);
  if (fromBody) return fromBody;
  return asText(req.query.token);
}

async function requireDeviceToken(req: Request): Promise<void> {
  const token = tokenFromRequest(req);
  const expected = await readSecretHash();
  if (!expected) {
    throw new HttpsError(
      "failed-precondition",
      "Pair the Android phone from the Phone SMS tab first."
    );
  }
  if (!token || !hashesMatch(hashToken(token), expected)) {
    throw new HttpsError("unauthenticated", "Invalid Phone SMS token.");
  }
}

async function touchDevice(fields: Record<string, unknown> = {}) {
  await admin
    .firestore()
    .collection(STATUS_COLLECTION)
    .doc("phone")
    .set(
      {
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        ...fields,
      },
      { merge: true }
    );
}

async function reclaimStaleClaims() {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - CLAIM_TTL_MS);
  const stale = await admin
    .firestore()
    .collection(OUTBOX_COLLECTION)
    .where("status", "==", "sending")
    .limit(20)
    .get();
  const batch = admin.firestore().batch();
  let writes = 0;
  for (const document of stale.docs) {
    const claimedAt = document.data().claimedAt as
      | admin.firestore.Timestamp
      | undefined;
    if (claimedAt && claimedAt.toMillis() > cutoff.toMillis()) continue;
    batch.update(document.ref, {
      status: "queued",
      claimedAt: admin.firestore.FieldValue.delete(),
    });
    writes += 1;
  }
  if (writes > 0) await batch.commit();
}

function sendHttpsError(res: Response, error: unknown) {
  if (error instanceof HttpsError) {
    const status =
      error.code === "unauthenticated"
        ? 401
        : error.code === "failed-precondition"
          ? 412
          : error.code === "invalid-argument"
            ? 400
            : error.code === "not-found"
              ? 404
              : 400;
    res.status(status).json({ ok: false, error: error.message });
    return;
  }
  console.error("Phone SMS gateway error:", error);
  res.status(500).json({ ok: false, error: "Phone SMS gateway failed." });
}

export const smsGatewayIssueToken = onCall(
  { cors: true, memory: SMS_GATEWAY_MEMORY },
  async () => {
  const token = `sms_${randomBytes(24).toString("base64url")}`;
  const tokenHint = token.slice(-4);
  await admin.firestore().collection(SECRET_COLLECTION).doc("config").set({
    tokenHash: hashToken(token),
    tokenHint,
    rotatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await admin.firestore().collection(STATUS_COLLECTION).doc("phone").set(
    {
      paired: true,
      tokenHint,
      lastSeenAt: null,
      rotatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return {
    token,
    tokenHint,
    ...gatewayUrls(),
  };
});

export const smsGatewayStatus = onCall(
  { cors: true, memory: SMS_GATEWAY_MEMORY },
  async () => {
  const secret = await admin
    .firestore()
    .collection(SECRET_COLLECTION)
    .doc("config")
    .get();
  const status = await admin
    .firestore()
    .collection(STATUS_COLLECTION)
    .doc("phone")
    .get();
  const queued = await admin
    .firestore()
    .collection(OUTBOX_COLLECTION)
    .where("status", "in", ["queued", "sending"])
    .limit(50)
    .get();
  const secretData = secret.data() || {};
  const statusData = status.data() || {};
  const lastSeen = statusData.lastSeenAt as
    | { toDate?: () => Date }
    | undefined;
  return {
    paired: Boolean(asText(secretData.tokenHash)),
    tokenHint: asText(secretData.tokenHint || statusData.tokenHint),
    lastSeenAt: lastSeen?.toDate?.().toISOString() || null,
    queuedCount: queued.size,
    ...gatewayUrls(),
  };
});

export async function queueShopSms(
  to: string,
  body: string,
  source = "phone-sms-tab"
): Promise<{ id: string; to: string }> {
  const normalized = normalizeUsPhone(to);
  const text = asText(body);
  if (!/^\+\d{10,15}$/.test(normalized)) {
    throw new HttpsError("invalid-argument", "Enter a valid US phone number.");
  }
  if (text.length < 1 || text.length > 1600) {
    throw new HttpsError(
      "invalid-argument",
      "Message must be between 1 and 1600 characters."
    );
  }
  const allowedSource =
    source === "dispatch" ||
    source === "phone-sms-tab" ||
    source === "voice-callback" ||
    source === "voice-agent"
      ? source
      : "phone-sms-tab";
  const ref = admin.firestore().collection(OUTBOX_COLLECTION).doc();
  await ref.set({
    to: normalized,
    body: text,
    status: "queued",
    source: allowedSource,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { id: ref.id, to: normalized };
}

export const smsGatewayQueueMessage = onCall(
  { cors: true, memory: SMS_GATEWAY_MEMORY },
  async (request) => {
  const input = request.data as { to?: unknown; body?: unknown; source?: unknown };
  const queued = await queueShopSms(
    asText(input.to),
    asText(input.body),
    asText(input.source)
  );
  return { ok: true, ...queued };
});

export const smsGatewaySimulateInbound = onCall(
  { cors: true, memory: SMS_GATEWAY_MEMORY },
  async (request) => {
    const input = request.data as { from?: unknown; body?: unknown };
    const from = normalizeUsPhone(asText(input.from));
    const body = asText(input.body);
    if (!/^\+\d{10,15}$/.test(from)) {
      throw new HttpsError("invalid-argument", "Enter a valid US phone number.");
    }
    if (body.length < 1 || body.length > 1600) {
      throw new HttpsError(
        "invalid-argument",
        "Message must be between 1 and 1600 characters."
      );
    }
    const ref = admin.firestore().collection(INBOX_COLLECTION).doc();
    await ref.set({
      from,
      body,
      source: "simulated",
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true, id: ref.id };
  }
);

export const smsGatewayPoll = onRequest(
  { cors: true, invoker: "public", memory: SMS_GATEWAY_MEMORY },
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      await requireDeviceToken(req);
      await reclaimStaleClaims();
      const pending = await admin
        .firestore()
        .collection(OUTBOX_COLLECTION)
        .where("status", "==", "queued")
        .limit(1)
        .get();
      if (pending.empty) {
        await touchDevice({ lastPollEmpty: true });
        res.json({ ok: true, messages: [] });
        return;
      }
      const document = pending.docs[0];
      await document.ref.update({
        status: "sending",
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const data = document.data();
      await touchDevice({ lastPollEmpty: false });
      res.json({
        ok: true,
        messages: [
          {
            id: document.id,
            to: asText(data.to),
            message: asText(data.body),
            body: asText(data.body),
          },
        ],
      });
    } catch (error) {
      sendHttpsError(res, error);
    }
  }
);

export const smsGatewayAck = onRequest(
  { cors: true, invoker: "public", memory: SMS_GATEWAY_MEMORY },
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "POST required." });
        return;
      }
      await requireDeviceToken(req);
      const body = (req.body || {}) as {
        id?: unknown;
        status?: unknown;
        error?: unknown;
      };
      const id = asText(body.id);
      const status = asText(body.status).toLowerCase();
      if (!id) {
        throw new HttpsError("invalid-argument", "Message id is required.");
      }
      if (status !== "sent" && status !== "failed") {
        throw new HttpsError("invalid-argument", "status must be sent or failed.");
      }
      const ref = admin.firestore().collection(OUTBOX_COLLECTION).doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        throw new HttpsError("not-found", "Message was not found.");
      }
      await ref.update({
        status,
        error: status === "failed" ? asText(body.error).slice(0, 300) : "",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await touchDevice();
      res.json({ ok: true, id, status });
    } catch (error) {
      sendHttpsError(res, error);
    }
  }
);

export const smsGatewayInbound = onRequest(
  { cors: true, invoker: "public", memory: "1GiB", timeoutSeconds: 120 },
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "POST required." });
        return;
      }
      await requireDeviceToken(req);
      const payload = (req.body || {}) as {
        from?: unknown;
        body?: unknown;
        message?: unknown;
        providerId?: unknown;
        images?: unknown;
      };
      const from = normalizeUsPhone(asText(payload.from));
      const message = asText(payload.body) || asText(payload.message);
      const images = parseInboundImages(payload.images);
      if (!/^\+\d{10,15}$/.test(from)) {
        throw new HttpsError("invalid-argument", "from must be a phone number.");
      }
      if (message.length < 1 && images.length < 1) {
        throw new HttpsError("invalid-argument", "message or image is required.");
      }
      const providerId = asText(payload.providerId).slice(0, 80);
      const documentId = inboxDocumentId(providerId);
      const ref = documentId
        ? admin.firestore().collection(INBOX_COLLECTION).doc(documentId)
        : admin.firestore().collection(INBOX_COLLECTION).doc();
      if (documentId) {
        const existing = await ref.get();
        if (existing.exists) {
          res.json({ ok: true, id: ref.id, duplicate: true });
          return;
        }
      }
      const attachments = await saveInboxImages(ref.id, images);
      await ref.set({
        from,
        body: (message || (attachments.length ? "(picture)" : "")).slice(0, 1600),
        source: attachments.length ? "android-mms" : "android",
        providerId: providerId || "",
        attachments,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await touchDevice({ lastInboundAt: admin.firestore.FieldValue.serverTimestamp() });
      res.json({ ok: true, id: ref.id });
    } catch (error) {
      sendHttpsError(res, error);
    }
  }
);

type InboxImage = { mime: string; name: string; buffer: Buffer };

function inboxDocumentId(providerId: string): string {
  const cleaned = providerId.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
  return cleaned ? `android-${cleaned}` : "";
}

function parseInboundImages(value: unknown): InboxImage[] {
  if (!Array.isArray(value)) return [];
  const out: InboxImage[] = [];
  for (const item of value.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const mime = asText(record.mime || record.contentType).toLowerCase() || "image/jpeg";
    if (!mime.startsWith("image/")) continue;
    const data = asText(record.data);
    if (!data || data.length > 2_000_000) continue;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(data, "base64");
    } catch {
      continue;
    }
    if (buffer.length < 32 || buffer.length > 1_500_000) continue;
    const name = asText(record.name).slice(0, 80) || `image-${out.length + 1}`;
    out.push({ mime, name, buffer });
  }
  return out;
}

async function saveInboxImages(
  docId: string,
  images: InboxImage[]
): Promise<Array<{ path: string; contentType: string; name: string }>> {
  if (!images.length) return [];
  const attachments: Array<{ path: string; contentType: string; name: string }> = [];
  try {
    const bucket = admin.storage().bucket();
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const ext = image.mime.includes("png")
        ? "png"
        : image.mime.includes("gif")
          ? "gif"
          : image.mime.includes("webp")
            ? "webp"
            : "jpg";
      const path = `sms-inbox/${docId}/${index}.${ext}`;
      await bucket.file(path).save(image.buffer, {
        resumable: false,
        contentType: image.mime,
        metadata: { cacheControl: "private, max-age=86400" },
      });
      attachments.push({
        path,
        contentType: image.mime,
        name: image.name,
      });
    }
  } catch (error) {
    console.error("sms inbox image upload failed", error);
    throw new HttpsError("internal", "Could not save picture.");
  }
  if (attachments.length !== images.length) {
    throw new HttpsError("internal", "Could not save picture.");
  }
  return attachments;
}

export const smsInboxMedia = onRequest(
  { cors: true, invoker: "public", memory: "512MiB", timeoutSeconds: 60 },
  async (req, res) => {
    try {
      const id = asText(req.query.id);
      const index = Number(req.query.n);
      if (!id || !Number.isInteger(index) || index < 0 || index > 8) {
        res.status(400).type("text/plain").send("Missing image.");
        return;
      }
      const snap = await admin.firestore().collection(INBOX_COLLECTION).doc(id).get();
      const attachments = Array.isArray(snap.data()?.attachments)
        ? (snap.data()?.attachments as Array<Record<string, unknown>>)
        : [];
      const item = attachments[index];
      const path = asText(item?.path);
      if (!path.startsWith("sms-inbox/")) {
        res.status(404).type("text/plain").send("Image not found.");
        return;
      }
      const [buffer] = await admin.storage().bucket().file(path).download();
      res.setHeader("Content-Type", asText(item?.contentType) || "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.status(200).send(buffer);
    } catch (error) {
      console.error("sms inbox media failed", error);
      res.status(404).type("text/plain").send("Image not found.");
    }
  }
);
