import { getApp } from 'firebase/app';
import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../firebase/config';
import type { ChatPin } from '../utils/inboxChatContext';
import type { PastedEmail } from '../utils/parsePastedEmails';

const WATCH_KEY = "njplumbing.emailWatchlist";

export interface EmailBriefingItem {
  from: string;
  subject: string;
  urgency: "high" | "normal" | "low";
  summary: string;
  action: string;
}

export interface EmailBriefingResult {
  headline: string;
  briefing: string[];
  actions: string[];
  money: string[];
  scheduling: string[];
  emails: EmailBriefingItem[];
}

export function loadWatchAddresses(): string[] {
  try {
    const raw = localStorage.getItem(WATCH_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function saveWatchAddresses(addresses: string[]) {
  localStorage.setItem(WATCH_KEY, JSON.stringify(addresses));
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

export interface GmailInboxAccount {
  email: string;
  lastProcessedCount: number;
  lastBriefingId: string;
  lastError: string;
}

function functionsClient() {
  return getFunctions(getApp(), 'us-central1');
}

export function captureGmailOAuthCallback(
  search = window.location.search
): { code: string; state: string; error: string } | null {
  const params = new URLSearchParams(search);
  if (params.get('gmail') !== '1' && params.get('view') !== 'emails') return null;
  const code = params.get('code') || '';
  const state = params.get('state') || '';
  const error = params.get('error') || '';
  if (!code && !error) return null;
  return { code, state, error };
}

export function clearGmailOAuthQuery() {
  const params = new URLSearchParams(window.location.search);
  ['code', 'state', 'error', 'gmail', 'scope'].forEach((key) => params.delete(key));
  params.set('view', 'emails');
  const search = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
}

export async function startGmailInboxSignIn(email?: string): Promise<string> {
  const callable = httpsCallable<{ email?: string }, { url: string }>(
    functionsClient(),
    'startGmailInboxOAuth'
  );
  const result = await callable(email ? { email } : {});
  return result.data.url;
}

export async function finishGmailInboxSignIn(input: {
  code: string;
  state: string;
}): Promise<{ email: string; newCount: number }> {
  const callable = httpsCallable<typeof input, { email: string; newCount: number }>(
    functionsClient(),
    'finishGmailInboxOAuth'
  );
  return (await callable(input)).data;
}

export async function listGmailInboxAccounts(): Promise<GmailInboxAccount[]> {
  const callable = httpsCallable<Record<string, never>, { accounts: GmailInboxAccount[] }>(
    functionsClient(),
    'listGmailInboxAccounts'
  );
  return (await callable({})).data.accounts || [];
}

export interface GmailInboxMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  receivedAt: string;
  snippet: string;
  unread: boolean;
  body?: string;
  labels?: string[];
  attachments?: GmailInboxAttachment[];
}

export interface GmailInboxAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

function parseInboxMessage(raw: Record<string, unknown>): GmailInboxMessage {
  return {
    id: String(raw.id || ''),
    threadId: String(raw.threadId || ''),
    from: String(raw.from || ''),
    to: String(raw.to || ''),
    cc: String(raw.cc || ''),
    subject: String(raw.subject || ''),
    date: String(raw.date || ''),
    receivedAt: String(raw.receivedAt || ''),
    snippet: String(raw.snippet || ''),
    unread: raw.unread === true,
    body: typeof raw.body === 'string' ? raw.body : '',
    labels: Array.isArray(raw.labels)
      ? raw.labels.filter((item): item is string => typeof item === 'string')
      : [],
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const row = item as Record<string, unknown>;
          const id = String(row.id || '').trim();
          const name = String(row.name || '').trim();
          if (!id || !name) return [];
          return [
            {
              id,
              name,
              mimeType: String(row.mimeType || ''),
              size: Number(row.size) || 0,
            },
          ];
        })
      : [],
  };
}

export async function listGmailInboxMessages(
  email?: string,
  pageToken?: string,
  workOnly = true
): Promise<{
  email: string;
  messages: GmailInboxMessage[];
  nextPageToken: string;
}> {
  const callable = httpsCallable<
    { email?: string; pageToken?: string; workOnly?: boolean },
    { email: string; messages: Array<Record<string, unknown>>; nextPageToken?: string }
  >(functionsClient(), 'listGmailInboxMessages', { timeout: 120000 });
  const result = await callable({
    ...(email ? { email } : {}),
    ...(pageToken ? { pageToken } : {}),
    workOnly,
  });
  return {
    email: result.data.email || email || '',
    messages: (result.data.messages || []).map(parseInboxMessage),
    nextPageToken: result.data.nextPageToken || '',
  };
}

export async function getGmailInboxMessage(
  email: string,
  id: string
): Promise<GmailInboxMessage> {
  const callable = httpsCallable<
    { email: string; id: string },
    { message: Record<string, unknown> }
  >(functionsClient(), 'getGmailInboxMessage');
  const result = await callable({ email, id });
  return parseInboxMessage(result.data.message || {});
}

export async function downloadGmailInboxAttachment(
  email: string,
  messageId: string,
  attachmentId: string
): Promise<ArrayBuffer> {
  const callable = httpsCallable<
    { email: string; messageId: string; attachmentId: string },
    { data: string; mimeType?: string }
  >(functionsClient(), 'getGmailInboxAttachment', { timeout: 30000 });
  const result = await callable({ email, messageId, attachmentId });
  const raw = (result.data.data || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + (raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4)));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export async function disconnectGmailInbox(email: string): Promise<void> {
  const callable = httpsCallable<{ email: string }, { email: string }>(
    functionsClient(),
    'disconnectGmailInbox'
  );
  await callable({ email });
}

export async function processGmailInboxesNow(email?: string): Promise<{
  results: Array<{ email: string; newCount: number; error?: string }>;
}> {
  const callable = httpsCallable<
    { email?: string },
    { results: Array<{ email: string; newCount: number; error?: string }> }
  >(functionsClient(), 'processGmailInboxesNow');
  return (await callable(email ? { email } : {})).data;
}

export interface SavedEmailBriefing {
  id: string;
  accountEmail: string;
  createdAt?: string;
  trigger: string;
  messageCount: number;
  result: EmailBriefingResult;
}

export function subscribeGmailBriefings(
  onChange: (items: SavedEmailBriefing[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'gmailInboxBriefings'), orderBy('createdAt', 'desc'), limit(8)),
    (snapshot) => {
      onChange(
        snapshot.docs.map((document) => {
          const data = document.data() as Record<string, unknown>;
          const createdAt = data.createdAt;
          return {
            id: document.id,
            accountEmail: typeof data.accountEmail === 'string' ? data.accountEmail : '',
            createdAt:
              createdAt && typeof createdAt === 'object' && 'toDate' in createdAt
                ? (createdAt as { toDate: () => Date }).toDate().toISOString()
                : undefined,
            trigger: typeof data.trigger === 'string' ? data.trigger : '',
            messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
            result: parseBriefingResult(
              data.result && typeof data.result === 'object'
                ? (data.result as Record<string, unknown>)
                : {}
            ),
          };
        })
      );
    },
    (error) => onError?.(error)
  );
}

export function parseBriefingResult(data: Record<string, unknown>): EmailBriefingResult {
  const items = Array.isArray(data.emails) ? data.emails : [];
  return {
    headline: typeof data.headline === 'string' ? data.headline : 'Email briefing',
    briefing: asStringList(data.briefing),
    actions: asStringList(data.actions),
    money: asStringList(data.money),
    scheduling: asStringList(data.scheduling),
    emails: items.map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const urgency = row.urgency === 'high' || row.urgency === 'low' ? row.urgency : 'normal';
      return {
        from: String(row.from || ''),
        subject: String(row.subject || ''),
        urgency,
        summary: String(row.summary || ''),
        action: String(row.action || ''),
      };
    }),
  };
}

export async function searchGmailInboxMessages(
  email: string,
  query: string
): Promise<GmailInboxMessage[]> {
  const callable = httpsCallable<
    { email: string; query: string },
    { messages: Array<Record<string, unknown>> }
  >(functionsClient(), 'searchGmailInboxMessages', { timeout: 60000 });
  const result = await callable({ email, query });
  return (result.data.messages || []).map(parseInboxMessage);
}

export interface EmailChatUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  model: string;
}

export interface EmailChatMessage {
  role: 'user' | 'assistant';
  content: string;
  usage?: EmailChatUsage;
}

export interface SavedInboxChat {
  id: string;
  title: string;
  inboxEmail: string;
  messages: EmailChatMessage[];
  pins: ChatPin[];
  used: Array<{ from: string; subject: string }>;
  createdAt?: string;
  updatedAt?: string;
}

const INBOX_CHATS = collection(db, 'emailInboxChats');

function firestoreTime(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : undefined;
}

function parseChatUsage(value: unknown): EmailChatUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  return {
    promptTokens: Number(row.promptTokens) || 0,
    cachedTokens: Number(row.cachedTokens) || 0,
    completionTokens: Number(row.completionTokens) || 0,
    totalTokens: Number(row.totalTokens) || 0,
    costUsd: Number(row.costUsd) || 0,
    model: String(row.model || ''),
  };
}

function parseSavedInboxChat(
  id: string,
  data: Record<string, unknown>
): SavedInboxChat {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const pins = Array.isArray(data.pins) ? data.pins : [];
  const used = Array.isArray(data.used) ? data.used : [];
  return {
    id,
    title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Inbox chat',
    inboxEmail: typeof data.inboxEmail === 'string' ? data.inboxEmail : '',
    messages: messages.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : '';
      const content = typeof row.content === 'string' ? row.content : '';
      if (!role || !content) return [];
      const usage = parseChatUsage(row.usage);
      return [{ role, content, ...(usage ? { usage } : {}) }];
    }),
    pins: pins.flatMap((item): ChatPin[] => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const label = String(row.label || '').trim();
      if (row.type === 'message' && typeof row.id === 'string' && row.id && label) {
        return [{ type: 'message', id: row.id, label }];
      }
      if (row.type === 'person' && typeof row.query === 'string' && row.query && label) {
        return [{ type: 'person', query: row.query, label }];
      }
      return [];
    }),
    used: used.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      return [{ from: String(row.from || ''), subject: String(row.subject || '') }];
    }),
    createdAt: firestoreTime(data.createdAt),
    updatedAt: firestoreTime(data.updatedAt),
  };
}

export function subscribeInboxChats(
  onChange: (chats: SavedInboxChat[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(INBOX_CHATS, orderBy('updatedAt', 'desc'), limit(40)),
    (snapshot) => {
      onChange(
        snapshot.docs.map((document) =>
          parseSavedInboxChat(document.id, document.data() as Record<string, unknown>)
        )
      );
    },
    (error) => onError?.(error)
  );
}

export async function saveInboxChat(input: {
  id?: string;
  title: string;
  inboxEmail: string;
  messages: EmailChatMessage[];
  pins: ChatPin[];
  used: Array<{ from: string; subject: string }>;
}): Promise<string> {
  const ref = input.id ? doc(INBOX_CHATS, input.id) : doc(INBOX_CHATS);
  await setDoc(
    ref,
    {
      title: input.title.slice(0, 120),
      inboxEmail: input.inboxEmail,
      messages: input.messages,
      pins: input.pins,
      used: input.used,
      updatedAt: serverTimestamp(),
      ...(input.id ? {} : { createdAt: serverTimestamp() }),
    },
    { merge: true }
  );
  return ref.id;
}

export async function deleteInboxChat(id: string): Promise<void> {
  await deleteDoc(doc(INBOX_CHATS, id));
}

export async function askAboutOfficeEmail(
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  emails: Array<{ from: string; to: string; subject: string; date: string; body: string }>,
  pasted = ''
): Promise<{
  answer: string;
  used: Array<{ from: string; subject: string }>;
  usage: EmailChatUsage;
}> {
  const callable = httpsCallable<
    {
      question: string;
      history: Array<{ role: string; content: string }>;
      emails: Array<{ from: string; to: string; subject: string; date: string; body: string }>;
      email?: string;
    },
    {
      answer: string;
      used?: Array<{ from?: string; subject?: string }>;
      usage?: Partial<EmailChatUsage>;
    }
  >(functionsClient(), 'askAboutOfficeEmail', { timeout: 120000 });
  const response = await callable({
    question,
    history,
    emails,
    ...(pasted ? { email: pasted } : {}),
  });
  const usage = response.data.usage || {};
  return {
    answer: response.data.answer || '',
    used: (response.data.used || []).map((item) => ({
      from: String(item.from || ''),
      subject: String(item.subject || ''),
    })),
    usage: {
      promptTokens: Number(usage.promptTokens) || 0,
      cachedTokens: Number(usage.cachedTokens) || 0,
      completionTokens: Number(usage.completionTokens) || 0,
      totalTokens: Number(usage.totalTokens) || 0,
      costUsd: Number(usage.costUsd) || 0,
      model: String(usage.model || ''),
    },
  };
}

export interface EmailReplyReference {
  customerName: string;
  retailerOrderNumber: string;
  workOrderNumber: string;
  phone: string;
  address: string;
  town: string;
  date: string;
  note: string;
}

export interface EmailReplyMatch {
  workOrderId: string;
  workOrderNumber: string;
  customerName: string;
  address: string;
  appointmentDate: string;
  status?: string;
  permitPulled?: boolean;
  retailerUploaded?: boolean;
  score: number;
  reasons: string[];
}

export interface EmailReplyResolved {
  reference: EmailReplyReference;
  match: EmailReplyMatch | null;
  ambiguous: EmailReplyMatch[];
}

export interface EmailCorrespondent {
  id: string;
  email: string;
  name: string;
  company: string;
  role: string;
  messageCount: number;
  notesMarkdown: string;
  recentWorkOrders: string[];
}

export interface EmailReplyDraft {
  id: string;
  inbox: string;
  messageId: string;
  threadId: string;
  subject: string;
  to: string;
  cc: string;
  reply: string;
  confidence: 'high' | 'medium' | 'low';
  answered: string[];
  unresolved: string[];
  citations: Array<{ collection: string; id: string; title: string }>;
  internalNotes: string;
  intent: string;
  questions: string[];
  attachmentNotes: string[];
  matches: EmailReplyResolved[];
  vectorHits: Array<{ collection: string; id: string; title: string; score: number; date: string }>;
  attachmentsRead: { images: string[]; pdfs: string[]; skipped: string[] };
  correspondent: EmailCorrespondent | null;
  gmailDraftId: string;
  gmailDraftError: string;
  costUsd: number;
  model: string;
  elapsedMs: number;
}

function parseReplyMatch(raw: unknown): EmailReplyMatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  return {
    workOrderId: String(row.workOrderId || ''),
    workOrderNumber: String(row.workOrderNumber || ''),
    customerName: String(row.customerName || ''),
    address: String(row.address || ''),
    appointmentDate: String(row.appointmentDate || ''),
    status: typeof row.status === 'string' ? row.status : undefined,
    permitPulled: typeof row.permitPulled === 'boolean' ? row.permitPulled : undefined,
    retailerUploaded: typeof row.retailerUploaded === 'boolean' ? row.retailerUploaded : undefined,
    score: Number(row.score) || 0,
    reasons: asStringList(row.reasons),
  };
}

function parseCorrespondent(raw: unknown): EmailCorrespondent | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  return {
    id: String(row.id || ''),
    email: String(row.email || ''),
    name: String(row.name || ''),
    company: String(row.company || ''),
    role: String(row.role || ''),
    messageCount: Number(row.messageCount) || 0,
    notesMarkdown: String(row.notesMarkdown || ''),
    recentWorkOrders: asStringList(row.recentWorkOrders),
  };
}

/**
 * Runs the extract → resolve → vector-search → draft pipeline on one inbox
 * message. The draft is stored in Firestore and (when the inbox has the
 * compose scope) saved as a Gmail draft on the thread. Nothing is sent.
 */
export interface PastedEmailForReply {
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  date?: string;
  body: string;
  /** Screenshots or PDFs as base64 data URLs. */
  files?: Array<{ name: string; dataUrl: string }>;
}

export async function draftEmailReply(input: {
  email?: string;
  messageId?: string;
  pasted?: PastedEmailForReply;
  saveGmailDraft?: boolean;
}): Promise<EmailReplyDraft> {
  const callable = httpsCallable<
    { email?: string; messageId?: string; pasted?: PastedEmailForReply; saveGmailDraft?: boolean },
    Record<string, unknown>
  >(functionsClient(), 'draftEmailReply', { timeout: 300000 });
  const data = (await callable(input)).data || {};
  const extraction =
    data.extraction && typeof data.extraction === 'object'
      ? (data.extraction as Record<string, unknown>)
      : {};
  const usage = data.usage && typeof data.usage === 'object' ? (data.usage as Record<string, unknown>) : {};
  const attachmentsRead =
    data.attachmentsRead && typeof data.attachmentsRead === 'object'
      ? (data.attachmentsRead as Record<string, unknown>)
      : {};
  const confidence = data.confidence === 'high' || data.confidence === 'low' ? data.confidence : 'medium';
  return {
    id: String(data.id || ''),
    inbox: String(data.inbox || input.email || ''),
    messageId: String(data.messageId || input.messageId || ''),
    threadId: String(data.threadId || ''),
    subject: String(data.subject || ''),
    to: String(data.to || ''),
    cc: String(data.cc || ''),
    reply: String(data.reply || ''),
    confidence,
    answered: asStringList(data.answered),
    unresolved: asStringList(data.unresolved),
    citations: Array.isArray(data.citations)
      ? data.citations.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const row = item as Record<string, unknown>;
          return [{ collection: String(row.collection || ''), id: String(row.id || ''), title: String(row.title || '') }];
        })
      : [],
    internalNotes: String(data.internalNotes || ''),
    intent: String(extraction.intent || ''),
    questions: asStringList(extraction.questions),
    attachmentNotes: asStringList(extraction.attachmentNotes),
    matches: Array.isArray(data.matches)
      ? data.matches.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const row = item as Record<string, unknown>;
          const ref = row.reference && typeof row.reference === 'object' ? (row.reference as Record<string, unknown>) : {};
          return [
            {
              reference: {
                customerName: String(ref.customerName || ''),
                retailerOrderNumber: String(ref.retailerOrderNumber || ''),
                workOrderNumber: String(ref.workOrderNumber || ''),
                phone: String(ref.phone || ''),
                address: String(ref.address || ''),
                town: String(ref.town || ''),
                date: String(ref.date || ''),
                note: String(ref.note || ''),
              },
              match: parseReplyMatch(row.match),
              ambiguous: Array.isArray(row.ambiguous)
                ? row.ambiguous.flatMap((hit) => {
                    const parsed = parseReplyMatch(hit);
                    return parsed ? [parsed] : [];
                  })
                : [],
            },
          ];
        })
      : [],
    vectorHits: Array.isArray(data.vectorHits)
      ? data.vectorHits.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const row = item as Record<string, unknown>;
          return [
            {
              collection: String(row.collection || ''),
              id: String(row.id || ''),
              title: String(row.title || ''),
              score: Number(row.score) || 0,
              date: String(row.date || ''),
            },
          ];
        })
      : [],
    attachmentsRead: {
      images: asStringList(attachmentsRead.images),
      pdfs: asStringList(attachmentsRead.pdfs),
      skipped: asStringList(attachmentsRead.skipped),
    },
    correspondent: parseCorrespondent(data.correspondent),
    gmailDraftId: String(data.gmailDraftId || ''),
    gmailDraftError: String(data.gmailDraftError || ''),
    costUsd: Number(usage.costUsd) || 0,
    model: String(usage.model || ''),
    elapsedMs: Number(data.elapsedMs) || 0,
  };
}

export async function getEmailCorrespondent(email: string): Promise<EmailCorrespondent | null> {
  const callable = httpsCallable<{ email: string }, Record<string, unknown>>(
    functionsClient(),
    'getEmailCorrespondent'
  );
  const data = (await callable({ email })).data || {};
  const parsed = parseCorrespondent(data);
  return parsed && parsed.messageCount > 0 ? parsed : null;
}

export async function summarizeOfficeEmails(
  emails: PastedEmail[],
  watchAddresses: string[]
): Promise<EmailBriefingResult> {
  const callable = httpsCallable<
    { emails: PastedEmail[]; watchAddresses: string[] },
    { result: Record<string, unknown> }
  >(functionsClient(), 'summarizeOfficeEmails');
  const response = await callable({ emails, watchAddresses });
  return parseBriefingResult(response.data.result || {});
}
