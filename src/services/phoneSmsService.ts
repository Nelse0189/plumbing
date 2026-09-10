import { getApps, initializeApp } from 'firebase/app';
import {
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db, firebaseConfig } from '../firebase/config';
import type { StoredWorkOrder } from '../types';
import { customerPhonesMatch, customerPhonesOf } from '../utils/customerPhones';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app, 'us-central1');

export interface PhoneSmsStatus {
  paired: boolean;
  tokenHint: string;
  lastSeenAt: string | null;
  queuedCount: number;
  pollUrl: string;
  ackUrl: string;
  inboundUrl: string;
}

export interface PhoneSmsTokenResult extends PhoneSmsStatus {
  token: string;
}

export interface PhoneSmsOutboxItem {
  id: string;
  to: string;
  body: string;
  status: string;
  error?: string;
  createdAt?: string;
  sentAt?: string;
}

export type SmsThreadItem = {
  id: string;
  direction: 'out' | 'in';
  body: string;
  status?: string;
  error?: string;
  at?: string;
};

export interface PhoneSmsInboxItem {
  id: string;
  from: string;
  body: string;
  source?: string;
  receivedAt?: string;
  attachments?: PhoneSmsAttachment[];
}

export type PhoneSmsAttachment = {
  path: string;
  contentType: string;
  name: string;
};

export function smsInboxMediaUrl(id: string, index: number): string {
  const params = new URLSearchParams({ id, n: String(index) });
  return `https://us-central1-${firebaseConfig.projectId}.cloudfunctions.net/smsInboxMedia?${params}`;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asTime(value: unknown): string | undefined {
  const stamp = value as { toDate?: () => Date } | undefined;
  return stamp?.toDate?.().toISOString();
}

export async function getPhoneSmsStatus(): Promise<PhoneSmsStatus> {
  const callable = httpsCallable<Record<string, never>, PhoneSmsStatus>(
    functions,
    'smsGatewayStatus'
  );
  const result = await callable({});
  return result.data;
}

export async function issuePhoneSmsToken(): Promise<PhoneSmsTokenResult> {
  const callable = httpsCallable<Record<string, never>, PhoneSmsTokenResult>(
    functions,
    'smsGatewayIssueToken'
  );
  const result = await callable({});
  return result.data;
}

export async function queuePhoneSms(
  to: string,
  body: string,
  source: 'phone-sms-tab' | 'dispatch' = 'phone-sms-tab'
): Promise<{ id: string; to: string }> {
  const callable = httpsCallable<
    { to: string; body: string; source?: string },
    { id: string; to: string }
  >(functions, 'smsGatewayQueueMessage');
  const result = await callable({ to, body, source });
  return result.data;
}

export async function simulatePhoneSmsInbound(
  from: string,
  body: string
): Promise<{ id: string }> {
  const callable = httpsCallable<{ from: string; body: string }, { id: string }>(
    functions,
    'smsGatewaySimulateInbound'
  );
  const result = await callable({ from, body });
  return result.data;
}

export function subscribePhoneSmsOutbox(
  onChange: (items: PhoneSmsOutboxItem[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'smsOutbox'), orderBy('createdAt', 'desc'), limit(80)),
    (snapshot) => {
      onChange(
        snapshot.docs.map((document) => {
          const data = document.data() as Record<string, unknown>;
          return {
            id: document.id,
            to: asText(data.to),
            body: asText(data.body),
            status: asText(data.status) || 'queued',
            error: asText(data.error) || undefined,
            createdAt: asTime(data.createdAt),
            sentAt: asTime(data.sentAt),
          };
        })
      );
    },
    onError
  );
}

export function subscribePhoneSmsInbox(
  onChange: (items: PhoneSmsInboxItem[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'smsInbox'), orderBy('receivedAt', 'desc'), limit(40)),
    (snapshot) => {
      onChange(
        snapshot.docs.map((document) => {
          const data = document.data() as Record<string, unknown>;
          return {
            id: document.id,
            from: asText(data.from),
            body: asText(data.body),
            source: asText(data.source) || undefined,
            receivedAt: asTime(data.receivedAt),
            attachments: Array.isArray(data.attachments)
              ? data.attachments
                  .map((item) => {
                    if (!item || typeof item !== 'object') return null;
                    const record = item as Record<string, unknown>;
                    const path = asText(record.path);
                    if (!path) return null;
                    return {
                      path,
                      contentType: asText(record.contentType) || 'image/jpeg',
                      name: asText(record.name) || 'image',
                    };
                  })
                  .filter((item): item is PhoneSmsAttachment => Boolean(item))
              : undefined,
          };
        })
      );
    },
    onError
  );
}

export type SmsReplyContact = {
  id: string;
  workOrderNumber: string;
  customerName: string;
  phone: string;
  address: string;
  jobType: string;
  appointmentDate: string;
  appointmentTime: string;
  status: string;
};

function phoneLookupVariants(phone: string): string[] {
  const trimmed = phone.trim();
  const digits = smsPhoneDigits(trimmed);
  const variants = [trimmed];
  if (digits) {
    variants.push(digits, `+1${digits}`, `+${digits}`, `1${digits}`);
  }
  return [...new Set(variants.filter(Boolean))];
}

function contactFromDoc(
  id: string,
  data: {
    workOrderNumber?: string;
    customerName?: string;
    phone?: string;
    address?: string;
    jobType?: string;
    appointmentDate?: string;
    appointmentTime?: string;
    status?: string;
  }
): SmsReplyContact {
  return {
    id,
    workOrderNumber: asText(data.workOrderNumber),
    customerName: asText(data.customerName),
    phone: asText(data.phone),
    address: asText(data.address),
    jobType: asText(data.jobType),
    appointmentDate: asText(data.appointmentDate),
    appointmentTime: asText(data.appointmentTime),
    status: asText(data.status) || 'unscheduled',
  };
}

function contactFromWorkOrder(order: StoredWorkOrder): SmsReplyContact {
  return contactFromDoc(order.id, order);
}

function dedupeContacts(matches: SmsReplyContact[]): SmsReplyContact[] {
  const byKey = new Map<string, SmsReplyContact>();
  for (const match of matches) {
    const key = match.workOrderNumber || match.id;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, match);
      continue;
    }
    const currentScore =
      (current.appointmentDate ? 2 : 0) + (current.customerName ? 1 : 0);
    const nextScore =
      (match.appointmentDate ? 2 : 0) + (match.customerName ? 1 : 0);
    if (nextScore > currentScore) byKey.set(key, match);
  }
  return [...byKey.values()].sort((left, right) =>
    `${right.appointmentDate}-${left.workOrderNumber}`.localeCompare(
      `${left.appointmentDate}-${right.workOrderNumber}`
    )
  );
}

export function contactsForSmsPhone(
  phone: string,
  orders: StoredWorkOrder[]
): SmsReplyContact[] {
  const digits = smsPhoneDigits(phone);
  if (!digits) return [];
  return dedupeContacts(
    orders
      .filter((order) =>
        customerPhonesOf(order).some((item) => customerPhonesMatch(item, phone))
      )
      .map(contactFromWorkOrder)
  );
}

export async function lookupSmsReplyContacts(
  phone: string
): Promise<SmsReplyContact[]> {
  const variants = phoneLookupVariants(phone);
  if (variants.length === 0) return [];
  const sliced = variants.slice(0, 10);
  const [byPhone, byPhones] = await Promise.all([
    getDocs(
      query(collection(db, 'workOrders'), where('phone', 'in', sliced), limit(20))
    ),
    getDocs(
      query(
        collection(db, 'workOrders'),
        where('phones', 'array-contains-any', sliced),
        limit(20)
      )
    ).catch(() => null),
  ]);
  const seen = new Set<string>();
  const docs = [...byPhone.docs, ...(byPhones?.docs || [])].filter((document) => {
    if (seen.has(document.id)) return false;
    seen.add(document.id);
    return true;
  });
  return dedupeContacts(
    docs.map((document) =>
      contactFromDoc(document.id, document.data() as Parameters<typeof contactFromDoc>[1])
    )
  );
}

export function smsPhoneDigits(value: string): string {
  return value.replace(/\D/g, '').slice(-10);
}

export function formatSmsStatus(status: string): string {
  if (status === 'sent') return 'Sent';
  if (status === 'sending') return 'Sending';
  if (status === 'failed') return 'Failed';
  if (status === 'queued') return 'Queued';
  return status || 'Queued';
}

export function smsThreadForPhone(
  phone: string,
  outbox: PhoneSmsOutboxItem[],
  inbox: PhoneSmsInboxItem[]
): SmsThreadItem[] {
  const digits = smsPhoneDigits(phone);
  if (!digits) return [];
  const items: SmsThreadItem[] = [
    ...outbox
      .filter((item) => smsPhoneDigits(item.to) === digits)
      .map((item) => ({
        id: `out-${item.id}`,
        direction: 'out' as const,
        body: item.body,
        status: item.status,
        error: item.error,
        at: item.sentAt || item.createdAt,
      })),
    ...inbox
      .filter((item) => smsPhoneDigits(item.from) === digits)
      .map((item) => ({
        id: `in-${item.id}`,
        direction: 'in' as const,
        body: item.body,
        at: item.receivedAt,
      })),
  ];
  return items.sort((left, right) => {
    const leftKey =
      left.at ||
      (left.direction === 'out' &&
      (left.status === 'queued' || left.status === 'sending')
        ? '9999-12-31T23:59:59.000Z'
        : '');
    const rightKey =
      right.at ||
      (right.direction === 'out' &&
      (right.status === 'queued' || right.status === 'sending')
        ? '9999-12-31T23:59:59.000Z'
        : '');
    return leftKey.localeCompare(rightKey);
  });
}

export function subscribePhoneSmsDevice(
  onChange: (lastSeenAt: string | null) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    collection(db, 'smsGatewayStatus'),
    (snapshot) => {
      const phone = snapshot.docs.find((document) => document.id === 'phone');
      onChange(asTime(phone?.data()?.lastSeenAt) || null);
    },
    onError
  );
}
