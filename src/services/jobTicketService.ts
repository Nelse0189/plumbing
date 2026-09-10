import { getApps, initializeApp } from 'firebase/app';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db, firebaseConfig } from '../firebase/config';
import type {
  JobTicket,
  JobTicketAuditAction,
  JobTicketAuditChange,
  JobTicketAuditEvent,
  JobTicketMaterial,
} from '../types';
import {
  clampWoFontSize,
  combinedAddress,
  DEFAULT_WO_FONT_SIZE,
  parseJobAddress,
} from '../utils/heatersWorkOrder';

const COLLECTION = 'jobTickets';

export const emptyMaterials = (): JobTicketMaterial[] =>
  Array.from({ length: 5 }, () => ({ description: '', qty: '', amount: '' }));

export const emptyExtraCharges = (): JobTicketMaterial[] =>
  Array.from({ length: 7 }, () => ({ description: '', qty: '', amount: '' }));

export function emptyJobTicket(serviceDate: string): Omit<JobTicket, 'id'> {
  return {
    workOrderNumber: '',
    customerName: '',
    phone: '',
    address: '',
    street: '',
    city: '',
    zip: '',
    jobType: '',
    serviceDate,
    workPerformed: '',
    followUpNotes: '',
    heaterModel: '',
    serialNumber: '',
    heaterLocation: '',
    tankWarrantyYears: '',
    dwellingType: '',
    heaterPrice: '',
    permitAmount: '',
    materials: emptyMaterials(),
    extraCharges: emptyExtraCharges(),
    laborAmount: '',
    totalAmount: '',
    plumberName: '',
    paymentMethod: '',
    driversLicense: '',
    cardOrCheckNumber: '',
    routingNumber: '',
    cardExp: '',
    amountPaid: '',
    customerSignedName: '',
    customerSignature: '',
    customerInitial: '',
    authorizationAccepted: false,
    status: 'draft',
    formTemplate: 'heaters',
    pdfFontSize: DEFAULT_WO_FONT_SIZE,
  };
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stamp(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && 'toDate' in value) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return undefined;
}

function materialsFrom(value: unknown, count: number): JobTicketMaterial[] {
  const rows = Array.isArray(value) ? value : [];
  const next = rows.slice(0, count).map((row) => {
    const item = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    return {
      description: asText(item.description),
      qty: asText(item.qty),
      amount: asText(item.amount),
    };
  });
  while (next.length < count) next.push({ description: '', qty: '', amount: '' });
  return next;
}

export function serializeJobTicket(id: string, data: Record<string, unknown>): JobTicket {
  const rawStreet = asText(data.street);
  const rawCity = asText(data.city);
  const rawZip = asText(data.zip);
  const address = asText(data.address) || combinedAddress(rawStreet, rawCity, rawZip);
  const shouldSplitCity =
    !rawCity ||
    /^[A-Za-z]{2}$/.test(rawCity) ||
    rawStreet === address ||
    /,\s*[A-Za-z]/.test(rawStreet);
  const parsed = shouldSplitCity ? parseJobAddress(rawStreet || address) : null;
  const street = parsed?.street || rawStreet || address;
  const city = rawCity || parsed?.city || '';
  const zip = rawZip || parsed?.zip || '';
  const followUpNotes = asText(data.followUpNotes) || asText(data.workPerformed);
  return {
    id,
    workOrderId: asText(data.workOrderId) || undefined,
    workOrderNumber: asText(data.workOrderNumber),
    customerName: asText(data.customerName),
    phone: asText(data.phone),
    address,
    street,
    city,
    zip,
    jobType: asText(data.jobType),
    serviceDate: asText(data.serviceDate),
    workPerformed: followUpNotes,
    followUpNotes,
    heaterModel: asText(data.heaterModel),
    serialNumber: asText(data.serialNumber),
    heaterLocation: asText(data.heaterLocation),
    tankWarrantyYears: asText(data.tankWarrantyYears),
    dwellingType: asText(data.dwellingType),
    heaterPrice: asText(data.heaterPrice),
    permitAmount: asText(data.permitAmount),
    materials: materialsFrom(data.materials, 5),
    extraCharges: materialsFrom(data.extraCharges, 7),
    laborAmount: asText(data.laborAmount),
    totalAmount: asText(data.totalAmount),
    plumberName: asText(data.plumberName),
    paymentMethod: asText(data.paymentMethod),
    driversLicense: asText(data.driversLicense),
    cardOrCheckNumber: asText(data.cardOrCheckNumber),
    routingNumber: asText(data.routingNumber),
    cardExp: asText(data.cardExp),
    amountPaid: asText(data.amountPaid),
    customerSignedName: asText(data.customerSignedName),
    customerSignature: asText(data.customerSignature),
    customerInitial: asText(data.customerInitial),
    signedAt: stamp(data.signedAt),
    authorizationAccepted: data.authorizationAccepted === true,
    status: asText(data.status) === 'signed' ? 'signed' : 'draft',
    formTemplate: asText(data.formTemplate) === 'nj' ? 'nj' : 'heaters',
    pdfFontSize: clampWoFontSize(data.pdfFontSize),
    createdAt: stamp(data.createdAt),
    updatedAt: stamp(data.updatedAt),
  };
}

function payloadFromTicket(ticket: Omit<JobTicket, 'id' | 'createdAt' | 'updatedAt'> | JobTicket) {
  const address = combinedAddress(ticket.street, ticket.city, ticket.zip) || ticket.address;
  return {
    workOrderId: ticket.workOrderId || '',
    workOrderNumber: ticket.workOrderNumber,
    customerName: ticket.customerName,
    phone: ticket.phone,
    address,
    street: ticket.street,
    city: ticket.city,
    zip: ticket.zip,
    jobType: ticket.jobType,
    serviceDate: ticket.serviceDate,
    workPerformed: ticket.followUpNotes || ticket.workPerformed,
    followUpNotes: ticket.followUpNotes || ticket.workPerformed,
    heaterModel: ticket.heaterModel,
    serialNumber: ticket.serialNumber,
    heaterLocation: ticket.heaterLocation,
    tankWarrantyYears: ticket.tankWarrantyYears,
    dwellingType: ticket.dwellingType,
    heaterPrice: ticket.heaterPrice,
    permitAmount: ticket.permitAmount,
    materials: ticket.materials,
    extraCharges: ticket.extraCharges,
    laborAmount: ticket.laborAmount,
    totalAmount: ticket.totalAmount,
    plumberName: ticket.plumberName,
    paymentMethod: ticket.paymentMethod,
    driversLicense: ticket.driversLicense,
    cardOrCheckNumber: ticket.cardOrCheckNumber,
    routingNumber: ticket.routingNumber,
    cardExp: ticket.cardExp,
    amountPaid: ticket.amountPaid,
    customerSignedName: ticket.customerSignedName,
    customerSignature: ticket.customerSignature,
    customerInitial: ticket.customerInitial,
    signedAt: ticket.signedAt || null,
    authorizationAccepted: ticket.authorizationAccepted,
    status: ticket.status,
    formTemplate: ticket.formTemplate === 'heaters' ? 'heaters' : 'nj',
    pdfFontSize: clampWoFontSize(ticket.pdfFontSize),
    updatedAt: serverTimestamp(),
  };
}

export async function listJobTicketsForDate(serviceDate: string): Promise<JobTicket[]> {
  const snapshot = await getDocs(query(collection(db, COLLECTION), where('serviceDate', '==', serviceDate)));
  const tickets = snapshot.docs.map((document) =>
    serializeJobTicket(document.id, document.data() as Record<string, unknown>)
  );
  tickets.sort((a, b) => {
    const byName = a.customerName.localeCompare(b.customerName);
    if (byName) return byName;
    return a.workOrderNumber.localeCompare(b.workOrderNumber, undefined, { numeric: true });
  });
  return tickets;
}

export function jobTicketIsSigned(ticket: JobTicket): boolean {
  return ticket.status === 'signed' || Boolean(ticket.customerSignature?.trim());
}

export function normalizeWorkOrderKey(value?: string): string {
  return String(value || '')
    .trim()
    .replace(/^#/, '')
    .replace(/^wo\s*/i, '')
    .toLowerCase();
}

/** Prefer a signed ticket, then the most recently updated one. */
export function findJobTicketForStop(
  tickets: JobTicket[],
  stop: { id?: string; workOrderId?: string; workOrderNumber?: string }
): JobTicket | undefined {
  const keys = [stop.workOrderNumber, stop.workOrderId, stop.id]
    .map((value) => normalizeWorkOrderKey(value))
    .filter(Boolean);
  if (!keys.length) return undefined;
  const matches = tickets.filter((ticket) =>
    [ticket.workOrderNumber, ticket.workOrderId, ticket.id].some((value) => {
      const key = normalizeWorkOrderKey(value);
      return Boolean(key && keys.includes(key));
    })
  );
  if (!matches.length) return undefined;
  matches.sort((a, b) => {
    const signedDelta = Number(jobTicketIsSigned(b)) - Number(jobTicketIsSigned(a));
    if (signedDelta) return signedDelta;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
  return matches[0];
}

function chunkValues(values: string[], size = 30): string[][] {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const groups: string[][] = [];
  for (let index = 0; index < unique.length; index += size) {
    groups.push(unique.slice(index, index + size));
  }
  return groups;
}

export function subscribeJobTicketsForDate(
  serviceDate: string,
  onChange: (tickets: JobTicket[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, COLLECTION), where('serviceDate', '==', serviceDate)),
    (snapshot) => {
      onChange(
        snapshot.docs.map((document) =>
          serializeJobTicket(document.id, document.data() as Record<string, unknown>)
        )
      );
    },
    (error) => onError?.(error)
  );
}

/** Live tickets for these work orders, including signatures from earlier service dates. */
export function subscribeJobTicketsForWorkOrders(
  workOrderNumbers: string[],
  workOrderIds: string[],
  onChange: (tickets: JobTicket[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const numberGroups = chunkValues(workOrderNumbers);
  const idGroups = chunkValues(workOrderIds);
  if (!numberGroups.length && !idGroups.length) {
    onChange([]);
    return () => {};
  }

  const unsubscribers: Unsubscribe[] = [];
  const byQuery = new Map<string, JobTicket[]>();
  const emit = () => {
    const merged = new Map<string, JobTicket>();
    for (const tickets of byQuery.values()) {
      for (const ticket of tickets) merged.set(ticket.id, ticket);
    }
    onChange([...merged.values()]);
  };

  const listen = (key: string, field: 'workOrderNumber' | 'workOrderId', values: string[]) => {
    unsubscribers.push(
      onSnapshot(
        query(collection(db, COLLECTION), where(field, 'in', values)),
        (snapshot) => {
          byQuery.set(
            key,
            snapshot.docs.map((document) =>
              serializeJobTicket(document.id, document.data() as Record<string, unknown>)
            )
          );
          emit();
        },
        (error) => onError?.(error)
      )
    );
  };

  numberGroups.forEach((values, index) => listen(`number-${index}`, 'workOrderNumber', values));
  idGroups.forEach((values, index) => listen(`id-${index}`, 'workOrderId', values));
  return () => unsubscribers.forEach((stop) => stop());
}

export function subscribeJobTickets(
  onChange: (tickets: JobTicket[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, COLLECTION), orderBy('updatedAt', 'desc'), limit(40)),
    (snapshot) => {
      onChange(
        snapshot.docs.map((document) =>
          serializeJobTicket(document.id, document.data() as Record<string, unknown>)
        )
      );
    },
    (error) => onError?.(error)
  );
}

export function subscribeJobTicket(
  id: string,
  onChange: (ticket: JobTicket | null) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, COLLECTION, id),
    (snapshot) => {
      onChange(
        snapshot.exists()
          ? serializeJobTicket(snapshot.id, snapshot.data() as Record<string, unknown>)
          : null
      );
    },
    (error) => onError?.(error)
  );
}

export async function createJobTicket(
  ticket: Omit<JobTicket, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const ref = await addDoc(collection(db, COLLECTION), {
    ...payloadFromTicket(ticket),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function saveJobTicket(ticket: JobTicket): Promise<void> {
  await updateDoc(doc(db, COLLECTION, ticket.id), payloadFromTicket(ticket));
}

export async function deleteJobTicket(id: string): Promise<void> {
  await deleteDoc(doc(db, COLLECTION, id));
}

const AUDIT = 'audit';

const SNAPSHOT_KEYS = [
  'workOrderNumber',
  'customerName',
  'phone',
  'street',
  'city',
  'zip',
  'jobType',
  'serviceDate',
  'followUpNotes',
  'heaterModel',
  'serialNumber',
  'heaterLocation',
  'tankWarrantyYears',
  'dwellingType',
  'heaterPrice',
  'permitAmount',
  'laborAmount',
  'totalAmount',
  'plumberName',
  'paymentMethod',
  'driversLicense',
  'formTemplate',
  'pdfFontSize',
  'status',
  'customerSignedName',
] as const;

function redactSignature(value: string): string {
  return value ? '(signed)' : '(empty)';
}

export function ticketAuditSnapshot(
  ticket: Omit<JobTicket, 'id'> & { id?: string }
): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of SNAPSHOT_KEYS) {
    snapshot[key] = String(ticket[key] ?? '');
  }
  snapshot.customerSignature = redactSignature(ticket.customerSignature);
  snapshot.customerInitial = redactSignature(ticket.customerInitial);
  snapshot.materials = ticket.materials
    .map((row) => [row.description, row.amount].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' | ');
  return snapshot;
}

export function ticketAuditDiff(
  before: Record<string, string> | null,
  after: Record<string, string>
): Record<string, JobTicketAuditChange> {
  const changes: Record<string, JobTicketAuditChange> = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after)]);
  for (const key of keys) {
    const from = before?.[key] || '';
    const to = after[key] || '';
    if (from !== to) changes[key] = { from, to };
  }
  return changes;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function serializeAudit(id: string, data: Record<string, unknown>): JobTicketAuditEvent {
  const changes = data.changes && typeof data.changes === 'object' ? data.changes : {};
  return {
    id,
    at: stamp(data.at),
    clientAt: asText(data.clientAt),
    action: asText(data.action) as JobTicketAuditAction,
    changes: changes as Record<string, JobTicketAuditChange>,
    prevHash: asText(data.prevHash),
    hash: asText(data.hash),
  };
}

export async function appendJobTicketAudit(
  ticketId: string,
  action: JobTicketAuditAction,
  changes: Record<string, JobTicketAuditChange>
): Promise<void> {
  const latest = await getDocs(
    query(collection(db, COLLECTION, ticketId, AUDIT), orderBy('at', 'desc'), limit(1))
  );
  const prevHash = latest.docs[0]
    ? asText(latest.docs[0].data().hash) || `ticket:${ticketId}`
    : `ticket:${ticketId}`;
  const clientAt = new Date().toISOString();
  const payload = JSON.stringify({
    ticketId,
    action,
    clientAt,
    changes,
    prevHash,
  });
  const hash = await sha256Hex(payload);
  await addDoc(collection(db, COLLECTION, ticketId, AUDIT), {
    at: serverTimestamp(),
    clientAt,
    action,
    changes,
    prevHash,
    hash,
  });
}

export function subscribeJobTicketAudit(
  ticketId: string,
  onChange: (events: JobTicketAuditEvent[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, COLLECTION, ticketId, AUDIT), orderBy('at', 'desc'), limit(25)),
    (snapshot) => {
      onChange(
        snapshot.docs.map((document) =>
          serializeAudit(document.id, document.data() as Record<string, unknown>)
        )
      );
    },
    (error) => onError?.(error)
  );
}

export function suggestedTotal(ticket: Pick<
  JobTicket,
  'materials' | 'extraCharges' | 'laborAmount' | 'heaterPrice' | 'permitAmount'
>): string {
  const amounts = [
    ticket.heaterPrice,
    ticket.permitAmount,
    ticket.laborAmount,
    ...ticket.materials.map((row) => row.amount),
    ...ticket.extraCharges.map((row) => row.amount),
  ]
    .map((value) => Number.parseFloat(String(value).replace(/[^0-9.-]/g, '')))
    .filter((value) => Number.isFinite(value));
  if (!amounts.length) return '';
  return amounts.reduce((sum, value) => sum + value, 0).toFixed(2);
}

export async function summarizeHeaterType(
  text: string
): Promise<{ heaterType: string; model: string }> {
  const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
  const functions = getFunctions(app, 'us-central1');
  const callable = httpsCallable<{ text: string }, { heaterType: string; model: string }>(
    functions,
    'summarizeHeaterType'
  );
  const result = await callable({ text: text.slice(0, 4000) });
  return {
    heaterType: (result.data.heaterType || '').trim(),
    model: (result.data.model || '').trim(),
  };
}
