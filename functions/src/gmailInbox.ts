import { randomBytes } from "node:crypto";
import * as admin from "firebase-admin";
import { google } from "googleapis";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { runOfficeEmailBriefing, type OfficeEmailInput } from "./emailBriefing";

const ACCOUNTS = "gmailInboxAccounts";
const SECRETS = "gmailInboxSecrets";
const PENDING = "gmailOAuthPending";
const BRIEFINGS = "gmailInboxBriefings";
const GMAIL_REDIRECT = "http://localhost:8199/gmail/callback";
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  // Lets the AI reply pipeline save a draft on the thread for the office to review.
  // Accounts signed in before this scope was added need to sign in again.
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email",
];

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function accountId(email: string): string {
  return email.trim().toLowerCase();
}

function gmailOAuthClient() {
  const clientId = process.env.GMAIL_CLIENT_ID || "";
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    throw new HttpsError(
      "failed-precondition",
      "Gmail sign-in is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET."
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, GMAIL_REDIRECT);
}

function headerOf(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string
): string {
  return (
    headers?.find((header) => (header.name || "").toLowerCase() === name.toLowerCase())?.value ||
    ""
  );
}

function decodeBody(data?: string | null): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

type GmailPart = {
  mimeType?: string | null;
  filename?: string | null;
  body?: { data?: string | null; attachmentId?: string | null; size?: number | null };
  parts?: GmailPart[] | null;
};

function collectAttachments(payload: GmailPart | null | undefined): Array<{
  id: string;
  name: string;
  mimeType: string;
  size: number;
}> {
  const found: Array<{ id: string; name: string; mimeType: string; size: number }> = [];
  const walk = (part?: GmailPart | null) => {
    if (!part) return;
    const name = asText(part.filename);
    const id = asText(part.body?.attachmentId);
    if (name && id) {
      found.push({
        id,
        name,
        mimeType: asText(part.mimeType) || "application/octet-stream",
        size: typeof part.body?.size === "number" ? part.body.size : 0,
      });
    }
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  return found;
}

function extractBody(payload: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: unknown[] | null;
} | null | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBody(payload.body.data);
  }
  const parts = (payload.parts || []) as Array<{
    mimeType?: string | null;
    filename?: string | null;
    body?: { data?: string | null };
    parts?: Array<Record<string, unknown>>;
  }>;
  let text = "";
  let html = "";
  const walk = (items: typeof parts) => {
    for (const part of items) {
      if (part.filename) continue;
      if (part.mimeType === "text/plain" && part.body?.data) {
        const next = decodeBody(part.body.data);
        if (next.length > text.length) text = next;
      } else if (part.mimeType === "text/html" && part.body?.data && !html) {
        html = decodeBody(part.body.data)
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ");
      }
      if (part.parts) walk(part.parts as typeof parts);
    }
  };
  walk(parts);
  return (text || html).replace(/\s+\n/g, "\n").trim();
}

export async function gmailForAccount(email: string) {
  const secret = await admin.firestore().collection(SECRETS).doc(accountId(email)).get();
  const refreshToken = asText(secret.data()?.refreshToken);
  if (!refreshToken) {
    throw new HttpsError("failed-precondition", `${email} is not signed in.`);
  }
  const auth = gmailOAuthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth });
}

async function loadNewInboxMessages(email: string): Promise<{
  emails: OfficeEmailInput[];
  messageIds: string[];
}> {
  const gmail = await gmailForAccount(email);
  const listed = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox newer_than:2d -category:promotions -category:social",
    maxResults: 20,
  });
  const ids = (listed.data.messages || []).map((item) => item.id).filter((id): id is string => Boolean(id));
  const emails: OfficeEmailInput[] = [];
  const messageIds: string[] = [];
  const accountRef = admin.firestore().collection(ACCOUNTS).doc(accountId(email));
  for (const id of ids) {
    const already = await accountRef.collection("processed").doc(id).get();
    if (already.exists) continue;
    const detail = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    const headers = detail.data.payload?.headers || [];
    const body = extractBody(detail.data.payload).slice(0, 12000);
    const subject = headerOf(headers, "Subject");
    if (!body && !subject) continue;
    emails.push({
      from: headerOf(headers, "From"),
      to: headerOf(headers, "To"),
      subject,
      date: headerOf(headers, "Date"),
      body,
    });
    messageIds.push(id);
  }
  return { emails, messageIds };
}

async function processAccountInbox(
  email: string,
  trigger: "manual" | "schedule" | "signin"
): Promise<{ email: string; newCount: number; briefingId?: string }> {
  const { emails, messageIds } = await loadNewInboxMessages(email);
  const accountRef = admin.firestore().collection(ACCOUNTS).doc(accountId(email));
  await accountRef.set(
    {
      email: accountId(email),
      lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      lastError: "",
    },
    { merge: true }
  );
  if (!emails.length) {
    return { email: accountId(email), newCount: 0 };
  }
  const result = await runOfficeEmailBriefing(emails, [accountId(email)]);
  const briefing = await admin.firestore().collection(BRIEFINGS).add({
    accountEmail: accountId(email),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    trigger,
    messageCount: emails.length,
    messageIds,
    result,
  });
  const batch = admin.firestore().batch();
  for (const id of messageIds) {
    batch.set(accountRef.collection("processed").doc(id), {
      at: admin.firestore.FieldValue.serverTimestamp(),
      briefingId: briefing.id,
    });
  }
  batch.set(
    accountRef,
    {
      lastBriefingId: briefing.id,
      lastProcessedCount: emails.length,
    },
    { merge: true }
  );
  await batch.commit();
  return { email: accountId(email), newCount: emails.length, briefingId: briefing.id };
}

export const startGmailInboxOAuth = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 30 },
  async (request) => {
    const hint = asText((request.data as { email?: unknown } | undefined)?.email);
    const state = randomBytes(16).toString("hex");
    await admin.firestore().collection(PENDING).doc(state).set({
      createdAtMs: Date.now(),
      hint,
    });
    const auth = gmailOAuthClient();
    const url = auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GMAIL_SCOPES,
      state,
      include_granted_scopes: true,
      login_hint: hint || undefined,
    });
    return { url, state };
  }
);

export const finishGmailInboxOAuth = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 60 },
  async (request) => {
    const input = (request.data || {}) as { code?: unknown; state?: unknown };
    const code = asText(input.code);
    const state = asText(input.state);
    if (!code || !state) {
      throw new HttpsError("invalid-argument", "Google did not return a complete sign-in.");
    }
    const pendingRef = admin.firestore().collection(PENDING).doc(state);
    const pending = await pendingRef.get();
    if (!pending.exists) {
      throw new HttpsError(
        "failed-precondition",
        "This Google sign-in expired. Click Sign in with Gmail again."
      );
    }
    await pendingRef.delete();
    const auth = gmailOAuthClient();
    const token = await auth.getToken(code);
    auth.setCredentials(token.tokens);
    const oauth2 = google.oauth2({ version: "v2", auth });
    const me = await oauth2.userinfo.get();
    const email = accountId(asText(me.data.email));
    if (!email) {
      throw new HttpsError("internal", "Google did not return the inbox address.");
    }
    const refreshToken =
      asText(token.tokens.refresh_token) ||
      asText((await admin.firestore().collection(SECRETS).doc(email).get()).data()?.refreshToken);
    if (!refreshToken) {
      throw new HttpsError(
        "failed-precondition",
        "Google did not give a refresh token. Sign in again and accept the permission prompt."
      );
    }
    await admin.firestore().collection(SECRETS).doc(email).set({
      refreshToken,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await admin.firestore().collection(ACCOUNTS).doc(email).set(
      {
        email,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: "",
      },
      { merge: true }
    );
    const processed = await processAccountInbox(email, "signin").catch((error) => {
      console.error("First inbox process failed", email, error);
      return { email, newCount: 0 };
    });
    return { email, newCount: processed.newCount };
  }
);

export const listGmailInboxAccounts = onCall({ cors: true, invoker: "public" }, async () => {
  const snapshot = await admin.firestore().collection(ACCOUNTS).get();
  return {
    accounts: snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        email: asText(data.email) || doc.id,
        lastProcessedCount: typeof data.lastProcessedCount === "number" ? data.lastProcessedCount : 0,
        lastBriefingId: asText(data.lastBriefingId),
        lastError: asText(data.lastError),
      };
    }),
  };
});

export const disconnectGmailInbox = onCall(
  { cors: true, invoker: "public" },
  async (request) => {
    const email = accountId(asText((request.data as { email?: unknown })?.email));
    if (!email) throw new HttpsError("invalid-argument", "Inbox address is required.");
    const accountRef = admin.firestore().collection(ACCOUNTS).doc(email);
    const processed = await accountRef.collection("processed").listDocuments();
    await Promise.all(processed.map((doc) => doc.delete()));
    await accountRef.delete();
    await admin.firestore().collection(SECRETS).doc(email).delete();
    return { email };
  }
);

export const processGmailInboxesNow = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 180, memory: "512MiB" },
  async (request) => {
    const wanted = accountId(asText((request.data as { email?: unknown })?.email));
    const snapshot = wanted
      ? await admin.firestore().collection(ACCOUNTS).doc(wanted).get().then((doc) => [doc])
      : (await admin.firestore().collection(ACCOUNTS).get()).docs;
    const results = [];
    for (const doc of snapshot) {
      if (!doc.exists) continue;
      const email = asText(doc.data()?.email) || doc.id;
      try {
        results.push(await processAccountInbox(email, "manual"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await doc.ref.set({ lastError: message }, { merge: true });
        results.push({ email, newCount: 0, error: message });
      }
    }
    return { results };
  }
);

function serializeInboxMessage(
  detail: {
    id?: string | null;
    threadId?: string | null;
    snippet?: string | null;
    internalDate?: string | null;
    labelIds?: string[] | null;
    payload?: {
      headers?: Array<{ name?: string | null; value?: string | null }> | null;
    } | null;
  },
  body = ""
) {
  const headers = detail.payload?.headers || [];
  const labels = detail.labelIds || [];
  return {
    id: asText(detail.id),
    threadId: asText(detail.threadId),
    from: headerOf(headers, "From"),
    to: headerOf(headers, "To"),
    cc: headerOf(headers, "Cc"),
    subject: headerOf(headers, "Subject"),
    date: headerOf(headers, "Date"),
    receivedAt: asText(detail.internalDate),
    snippet: asText(detail.snippet),
    unread: labels.includes("UNREAD"),
    labels,
    attachments: collectAttachments(detail.payload as GmailPart | undefined),
    body,
  };
}

export async function firstInboxEmail(): Promise<string> {
  const snapshot = await admin.firestore().collection(ACCOUNTS).limit(1).get();
  const doc = snapshot.docs[0];
  return doc ? asText(doc.data()?.email) || doc.id : "";
}

export type GmailFullMessage = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  receivedAt: string;
  messageIdHeader: string;
  referencesHeader: string;
  body: string;
  attachments: Array<{ id: string; name: string; mimeType: string; size: number }>;
};

/** Full message (headers + text body + attachment list) for the AI reply pipeline. */
export async function loadGmailMessageFull(
  email: string,
  id: string
): Promise<GmailFullMessage> {
  const gmail = await gmailForAccount(email);
  const detail = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const headers = detail.data.payload?.headers || [];
  return {
    id: asText(detail.data.id) || id,
    threadId: asText(detail.data.threadId),
    from: headerOf(headers, "From"),
    to: headerOf(headers, "To"),
    cc: headerOf(headers, "Cc"),
    subject: headerOf(headers, "Subject"),
    date: headerOf(headers, "Date"),
    receivedAt: asText(detail.data.internalDate),
    messageIdHeader: headerOf(headers, "Message-ID") || headerOf(headers, "Message-Id"),
    referencesHeader: headerOf(headers, "References"),
    body: extractBody(detail.data.payload).slice(0, 40000),
    attachments: collectAttachments(detail.data.payload as GmailPart | undefined),
  };
}

/** Raw attachment bytes. Returns null when the part is empty or too large. */
export async function loadGmailAttachmentBytes(
  email: string,
  messageId: string,
  attachmentId: string,
  maxBytes = 8_000_000
): Promise<Buffer | null> {
  const gmail = await gmailForAccount(email);
  const attachment = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  const data = asText(attachment.data.data);
  if (!data) return null;
  const buffer = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (buffer.length > maxBytes) return null;
  return buffer;
}

function encodeHeaderValue(value: string): string {
  // RFC 2047 encode only when non-ASCII is present.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Saves a reply as a Gmail draft on the original thread. Requires the
 * gmail.compose scope; throws a descriptive error when the account was
 * signed in with the older read-only scope.
 */
export async function createGmailReplyDraft(input: {
  email: string;
  threadId: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): Promise<{ draftId: string; messageId: string }> {
  const gmail = await gmailForAccount(input.email);
  const headers = [
    `From: ${input.email}`,
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : "",
    `Subject: ${encodeHeaderValue(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : "",
    input.references ? `References: ${input.references}` : "",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);
  const raw = Buffer.from([...headers, "", input.body].join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  try {
    const created = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { threadId: input.threadId, raw } },
    });
    return {
      draftId: asText(created.data.id),
      messageId: asText(created.data.message?.id),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/insufficient|permission|scope|403/i.test(message)) {
      throw new Error(
        "Gmail draft needs the compose permission. Sign the inbox in again from the Email page to grant it."
      );
    }
    throw error;
  }
}

export const listGmailInboxMessages = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const input = (request.data || {}) as {
      email?: unknown;
      pageToken?: unknown;
      maxResults?: unknown;
      workOnly?: unknown;
    };
    const wanted = accountId(asText(input.email));
    const email = wanted || (await firstInboxEmail());
    if (!email) {
      throw new HttpsError("failed-precondition", "Sign in a Gmail inbox first.");
    }
    const workOnly = input.workOnly !== false;
    const maxResults = Math.min(
      100,
      Math.max(20, typeof input.maxResults === "number" ? input.maxResults : 80)
    );
    const pageToken = asText(input.pageToken) || undefined;
    const gmail = await gmailForAccount(email);
    const listed = await gmail.users.messages.list({
      userId: "me",
      labelIds: ["INBOX"],
      q: workOnly ? "-category:promotions -category:social" : undefined,
      maxResults,
      pageToken,
    });
    const ids = (listed.data.messages || [])
      .map((item) => item.id)
      .filter((id): id is string => Boolean(id));
    const messages = [];
    for (let index = 0; index < ids.length; index += 10) {
      const chunk = ids.slice(index, index + 10);
      const details = await Promise.all(
        chunk.map((id) =>
          gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
          })
        )
      );
      for (const detail of details) {
        if (detail.data.id) messages.push(serializeInboxMessage(detail.data));
      }
    }
    return {
      email,
      messages,
      nextPageToken: asText(listed.data.nextPageToken),
    };
  }
);

export const searchGmailInboxMessages = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    const input = (request.data || {}) as { email?: unknown; query?: unknown };
    const email = accountId(asText(input.email)) || (await firstInboxEmail());
    const query = asText(input.query).slice(0, 300);
    if (!email) {
      throw new HttpsError("failed-precondition", "Sign in a Gmail inbox first.");
    }
    if (!query) return { email, messages: [] };
    const gmail = await gmailForAccount(email);
    const listed = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 40,
    });
    const ids = (listed.data.messages || [])
      .map((item) => item.id)
      .filter((id): id is string => Boolean(id));
    const messages = [];
    for (let index = 0; index < ids.length; index += 6) {
      const chunk = ids.slice(index, index + 6);
      const details = await Promise.all(
        chunk.map((id) =>
          gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
          })
        )
      );
      for (const detail of details) {
        if (detail.data.id) messages.push(serializeInboxMessage(detail.data));
      }
    }
    return { email, messages };
  }
);

export const getGmailInboxAttachment = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 30, memory: "512MiB" },
  async (request) => {
    const input = (request.data || {}) as {
      email?: unknown;
      messageId?: unknown;
      attachmentId?: unknown;
    };
    const email = accountId(asText(input.email)) || (await firstInboxEmail());
    const messageId = asText(input.messageId);
    const attachmentId = asText(input.attachmentId);
    if (!email) {
      throw new HttpsError("failed-precondition", "Sign in a Gmail inbox first.");
    }
    if (!messageId || !attachmentId) {
      throw new HttpsError("invalid-argument", "Message and attachment ids are required.");
    }
    const gmail = await gmailForAccount(email);
    const attachment = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });
    const data = asText(attachment.data.data);
    if (!data) {
      throw new HttpsError("not-found", "That attachment was empty.");
    }
    if (data.length > 20_000_000) {
      throw new HttpsError("invalid-argument", "That PDF is too large to open here.");
    }
    return { email, data, mimeType: "application/pdf" };
  }
);

export const getGmailInboxMessage = onCall(
  { cors: true, invoker: "public", timeoutSeconds: 30, memory: "512MiB" },
  async (request) => {
    const input = (request.data || {}) as { email?: unknown; id?: unknown };
    const email = accountId(asText(input.email)) || (await firstInboxEmail());
    const id = asText(input.id);
    if (!email) {
      throw new HttpsError("failed-precondition", "Sign in a Gmail inbox first.");
    }
    if (!id) throw new HttpsError("invalid-argument", "Message id is required.");
    const gmail = await gmailForAccount(email);
    const detail = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    return {
      email,
      message: serializeInboxMessage(detail.data, extractBody(detail.data.payload).slice(0, 20000)),
    };
  }
);

export const processGmailInboxesScheduled = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "America/New_York",
    memory: "512MiB",
    timeoutSeconds: 180,
  },
  async () => {
    const snapshot = await admin.firestore().collection(ACCOUNTS).get();
    for (const doc of snapshot.docs) {
      const email = asText(doc.data().email) || doc.id;
      try {
        await processAccountInbox(email, "schedule");
      } catch (error) {
        await doc.ref.set(
          {
            lastError: error instanceof Error ? error.message : String(error),
            lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }
  }
);
