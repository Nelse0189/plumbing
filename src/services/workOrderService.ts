import { getApps, initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db, firebaseConfig } from '../firebase/config';
import type { StoredWorkOrder, WorkOrder } from '../types';
import { parseCustomerPhones } from '../utils/customerPhones';

export const SCHEDULE_LOOKBACK_DAYS = 7;

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app, 'us-central1');

export async function extractWorkOrder(
  text: string,
  sourceFileName: string,
  microsoftAccessToken: string,
  channelNote = ''
): Promise<WorkOrder> {
  const callable = httpsCallable<
    {
      text: string;
      sourceFileName: string;
      microsoftAccessToken: string;
      channelNote?: string;
    },
    WorkOrder
  >(functions, 'extractWorkOrder');
  const result = await callable({
    text,
    sourceFileName,
    microsoftAccessToken,
    channelNote,
  });
  return result.data;
}

export interface ChannelPdfImportResult {
  cached: boolean;
  workOrderId: string;
  workOrder: StoredWorkOrder;
}

export async function startTeamsChannelImport(input: {
  teamId: string;
  channelId: string;
  channelName: string;
  days: number;
  microsoftAccessToken: string;
}): Promise<{ runId: string; status: 'queued' }> {
  const callable = httpsCallable<typeof input, { runId: string; status: 'queued' }>(
    functions,
    'startTeamsChannelImport'
  );
  const result = await callable(input);
  return result.data;
}

export interface TeamsLiveSyncResult {
  checkedAt: string;
  channelName: string;
  checked: number;
  imported: number;
  updated: number;
  unchanged: number;
  failed: number;
  booked: number;
  scanned: number;
}

export async function syncOpenTeamsChannel(input: {
  teamId: string;
  channelId: string;
  channelName: string;
  sinceIso: string;
  microsoftAccessToken: string;
}): Promise<TeamsLiveSyncResult> {
  const callable = httpsCallable<typeof input, TeamsLiveSyncResult>(
    functions,
    'syncOpenTeamsChannel',
    { timeout: 180000 }
  );
  const result = await callable(input);
  return result.data;
}

export async function importChannelPdfWorkOrder(input: {
  text: string;
  channelNote?: string;
  sourceFileName: string;
  teamId: string;
  channelId: string;
  messageId: string;
  attachmentId: string;
  force?: boolean;
  microsoftAccessToken: string;
}): Promise<ChannelPdfImportResult> {
  const callable = httpsCallable<typeof input, ChannelPdfImportResult>(
    functions,
    'importChannelPdfWorkOrder'
  );
  const result = await callable(input);
  return result.data;
}

export interface TeamsPostImportResult {
  status: 'imported' | 'cached' | 'unchanged';
  cached: boolean;
  booked: number;
  workOrderId: string;
  workOrder: StoredWorkOrder;
}

/**
 * Import a text-only Teams order post (no PDF attached), e.g. when the
 * work-order PDF system was down and the office typed
 * "NEW ORDER <customer> <town>" into the channel.
 */
export async function importTeamsPostWorkOrder(input: {
  teamId: string;
  channelId: string;
  messageId: string;
  force?: boolean;
  microsoftAccessToken: string;
}): Promise<TeamsPostImportResult> {
  const callable = httpsCallable<typeof input, TeamsPostImportResult>(
    functions,
    'importTeamsPostWorkOrder',
    { timeout: 120000 }
  );
  const result = await callable(input);
  return result.data;
}

export async function saveWorkOrder(
  workOrder: WorkOrder,
  microsoftAccessToken: string,
  workOrderId?: string
): Promise<{
  success: boolean;
  workOrderId: string;
  status: 'unscheduled';
}> {
  const callable = httpsCallable<
    {
      workOrder: WorkOrder;
      workOrderId?: string;
      microsoftAccessToken: string;
    },
    {
      success: boolean;
      workOrderId: string;
      status: 'unscheduled';
    }
  >(functions, 'saveWorkOrder');
  const result = await callable({
    workOrder,
    workOrderId,
    microsoftAccessToken,
  });
  return result.data;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function serializeStoredWorkOrder(
  id: string,
  data: Record<string, unknown>
): StoredWorkOrder {
  const status = asText(data.status);
  return {
    id,
    workOrderNumber: asText(data.workOrderNumber),
    customerName: asText(data.customerName),
    phone: asText(data.phone),
    phones: parseCustomerPhones(data.phones as string[] | undefined, asText(data.phone)),
    address: asText(data.address),
    jobType: asText(data.jobType),
    appointmentDate: asText(data.appointmentDate),
    appointmentTime: asText(data.appointmentTime),
    notes: asText(data.notes),
    scheduleEvidenceQuote: asText(data.scheduleEvidenceQuote),
    sourceFileName: asText(data.sourceFileName),
    installDescription: asText(data.installDescription),
    pdfServiceDate: asText(data.pdfServiceDate),
    duplicateOfWorkOrderNumber: asText(data.duplicateOfWorkOrderNumber),
    smsConsent: data.smsConsent === true,
    confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
    status:
      status === 'needs_review' ||
      status === 'unscheduled' ||
      status === 'scheduling' ||
      status === 'scheduled' ||
      status === 'closed'
        ? status
        : 'unscheduled',
    manualSchedule: data.manualSchedule === true,
    selectedTime: asText(data.selectedTime) || undefined,
    teamsTeamId: asText(data.teamsTeamId) || undefined,
    teamsChannelId: asText(data.teamsChannelId) || undefined,
    teamsMessageId: asText(data.teamsMessageId) || undefined,
    teamsAttachmentId: asText(data.teamsAttachmentId) || undefined,
    source: asText(data.source) || undefined,
    autoImported: data.autoImported === true,
    callSummary: asText(data.callSummary) || undefined,
    permitPulled: data.permitPulled === true,
    permitPulledAt: asText(data.permitPulledAt) || undefined,
    retailerUploaded: data.retailerUploaded === true,
    retailerUploadedAt: asText(data.retailerUploadedAt) || undefined,
  };
}

export async function patchWorkOrderFields(
  id: string,
  patch: {
    customerName?: string;
    phone?: string;
    phones?: string[];
    address?: string;
    jobType?: string;
    installDescription?: string;
    notes?: string;
    permitPulled?: boolean;
    permitPulledAt?: string | null;
    retailerUploaded?: boolean;
    retailerUploadedAt?: string | null;
  }
): Promise<void> {
  const documentId = id.trim();
  if (!documentId) return;
  await setDoc(
    doc(db, 'workOrders', documentId),
    {
      ...patch,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function setWorkOrderOfficeChecks(
  id: string,
  field: 'permitPulled' | 'retailerUploaded',
  done: boolean
): Promise<void> {
  const at = done ? new Date().toISOString() : null;
  if (field === 'permitPulled') {
    await patchWorkOrderFields(id, { permitPulled: done, permitPulledAt: at });
    return;
  }
  await patchWorkOrderFields(id, { retailerUploaded: done, retailerUploadedAt: at });
}

export async function getStoredWorkOrder(id: string): Promise<StoredWorkOrder | null> {
  const documentId = id.trim();
  if (!documentId) return null;
  const snap = await getDoc(doc(db, 'workOrders', documentId));
  if (!snap.exists()) return null;
  return serializeStoredWorkOrder(snap.id, snap.data() as Record<string, unknown>);
}

export function subscribeWorkOrdersForDate(
  date: string,
  onChange: (workOrders: StoredWorkOrder[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'workOrders'), where('appointmentDate', '==', date)),
    (snapshot) => {
      onChange(
        snapshot.docs.map((document) =>
          serializeStoredWorkOrder(document.id, document.data() as Record<string, unknown>)
        )
      );
    },
    onError
  );
}

export function formatWorkOrderError(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: string }).code)
      : '';
  const message = err instanceof Error ? err.message : String(err);
  if (
    code.includes('unauthenticated') ||
    /sign-in is required|session is no longer valid/i.test(message)
  ) {
    return 'Microsoft sign-in expired. Sign in again, then retry.';
  }
  if (
    code.includes('internal') ||
    /^internal$/i.test(message.trim()) ||
    /^INTERNAL$/i.test(message.trim())
  ) {
    return 'Could not complete that request. Try again.';
  }
  return (
    message
      .replace(/^FirebaseError:\s*/i, '')
      .replace(/^(INTERNAL|UNKNOWN):?\s*/i, '')
      .trim() || 'Could not complete that request.'
  );
}

export async function listWorkOrders(
  microsoftAccessToken: string,
  channelId?: string
): Promise<StoredWorkOrder[]> {
  const callable = httpsCallable<
    { microsoftAccessToken: string; channelId?: string },
    StoredWorkOrder[]
  >(functions, 'listWorkOrders');
  const result = await callable({
    microsoftAccessToken,
    ...(channelId ? { channelId } : {}),
  });
  return result.data;
}

export async function findWorkOrdersByNumber(number: string): Promise<StoredWorkOrder[]> {
  const compact = number
    .trim()
    .toLocaleLowerCase()
    .replace(/^wo[\s#:_-]*/i, '')
    .replace(/[\s\-_]/g, '');
  if (!compact) return [];
  const variants = [...new Set([number.trim(), compact, `WO ${compact}`, `WO-${compact}`])];
  const snapshots = await Promise.all(
    variants.map((value) =>
      getDocs(query(collection(db, 'workOrders'), where('workOrderNumber', '==', value), limit(8)))
    )
  );
  const byId = new Map<string, StoredWorkOrder>();
  for (const snapshot of snapshots) {
    for (const document of snapshot.docs) {
      byId.set(
        document.id,
        serializeStoredWorkOrder(document.id, document.data() as Record<string, unknown>)
      );
    }
  }
  return [...byId.values()].filter((order) => {
    const stored = order.workOrderNumber
      .trim()
      .toLocaleLowerCase()
      .replace(/^wo[\s#:_-]*/i, '')
      .replace(/[\s\-_]/g, '');
    return stored === compact || stored.includes(compact);
  });
}

export function subscribeWorkOrders(
  onChange: (workOrders: StoredWorkOrder[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const cutoff = Timestamp.fromMillis(
    Date.now() - SCHEDULE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );
  return onSnapshot(
    query(collection(db, 'workOrders'), where('updatedAt', '>=', cutoff), limit(250)),
    (snapshot) => {
      const workOrders = snapshot.docs
        .flatMap((document) => {
          try {
            return [
              serializeStoredWorkOrder(
                document.id,
                document.data() as Record<string, unknown>
              ),
            ];
          } catch (error) {
            console.warn('Skipped a work order that could not be read:', document.id, error);
            return [];
          }
        })
        .sort((left, right) =>
          `${left.appointmentDate}-${left.appointmentTime}`.localeCompare(
            `${right.appointmentDate}-${right.appointmentTime}`
          )
        );
      onChange(workOrders);
    },
    onError
  );
}

/**
 * Staff picked the service day by hand from the scheduling database. Writes
 * the date straight onto the work order so Dispatch picks it up, and marks it
 * manualSchedule so AI schedule detection never overwrites it.
 */
export async function manuallyScheduleWorkOrder(
  workOrderId: string,
  appointmentDate: string,
  appointmentTime = ''
): Promise<void> {
  const date = appointmentDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Pick a service date first.');
  }
  const time = appointmentTime.trim();
  await setDoc(
    doc(db, 'workOrders', workOrderId),
    {
      appointmentDate: date,
      ...(time ? { appointmentTime: time } : {}),
      status: 'scheduled',
      manualSchedule: true,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function detectWorkOrderSchedules(force = false): Promise<{
  scanned: number;
  booked: number;
  skipped: number;
  costUsd: number;
}> {
  const callable = httpsCallable<
    { force?: boolean },
    { scanned: number; booked: number; skipped: number; costUsd: number }
  >(functions, 'detectWorkOrderSchedules', { timeout: 540000 });
  const result = await callable(force ? { force: true } : {});
  return result.data;
}

export async function reinterpretWorkOrderSchedules(
  _microsoftAccessToken?: string
): Promise<{
  scanned: number;
  booked: number;
  skipped: number;
  unscheduled: number;
  costUsd: number;
}> {
  const callable = httpsCallable<
    Record<string, never>,
    {
      scanned: number;
      booked: number;
      skipped: number;
      unscheduled: number;
      costUsd: number;
    }
  >(functions, 'reinterpretWorkOrderSchedules', { timeout: 540000 });
  const result = await callable({});
  return result.data;
}

export async function initiateWorkOrderScheduling(
  workOrderId: string,
  microsoftAccessToken: string
): Promise<{
  success: boolean;
  alreadyPending?: boolean;
  messageSid?: string;
  testRecipient: string;
  availableTimeSlots?: string[];
}> {
  const callable = httpsCallable<
    { workOrderId: string; microsoftAccessToken: string },
    {
      success: boolean;
      alreadyPending?: boolean;
      messageSid?: string;
      testRecipient: string;
      availableTimeSlots?: string[];
    }
  >(functions, 'initiateWorkOrderScheduling');
  const result = await callable({ workOrderId, microsoftAccessToken });
  return result.data;
}
