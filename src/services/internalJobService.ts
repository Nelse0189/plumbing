import {
  collection,
  doc,
  getDocs,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  deleteDoc,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import type { StoredWorkOrder, WorkOrder } from '../types';

export const INTERNAL_JOB_SOURCE = 'nj-internal';

const WORK_ORDERS_COLLECTION = 'workOrders';

export type InternalJobInput = Pick<
  WorkOrder,
  | 'workOrderNumber'
  | 'customerName'
  | 'phone'
  | 'address'
  | 'jobType'
  | 'appointmentDate'
  | 'appointmentTime'
  | 'notes'
  | 'smsConsent'
>;

function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed;
}

function internalRecordId(appointmentDate: string, workOrderNumber: string): string {
  const safe = workOrderNumber.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `internal-${appointmentDate}-${safe}`.slice(0, 120);
}

function mapDoc(documentId: string, data: Record<string, unknown>): StoredWorkOrder {
  return {
    id: documentId,
    workOrderNumber: String(data.workOrderNumber || ''),
    customerName: String(data.customerName || ''),
    phone: String(data.phone || ''),
    address: String(data.address || ''),
    jobType: String(data.jobType || ''),
    appointmentDate: String(data.appointmentDate || ''),
    appointmentTime: String(data.appointmentTime || ''),
    notes: String(data.notes || ''),
    scheduleEvidenceQuote: String(data.scheduleEvidenceQuote || ''),
    sourceFileName: String(data.sourceFileName || 'N&J internal job'),
    smsConsent: data.smsConsent === true,
    status: (data.status as StoredWorkOrder['status']) || 'unscheduled',
    source: String(data.source || INTERNAL_JOB_SOURCE),
  };
}

export function validateInternalJob(input: InternalJobInput): string | null {
  const missing: string[] = [];
  if (!input.customerName.trim()) missing.push('customer name');
  if (!input.phone.trim()) missing.push('phone');
  if (!input.address.trim()) missing.push('address');
  if (!input.jobType.trim()) missing.push('job type');
  if (!input.appointmentDate.trim()) missing.push('appointment date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.appointmentDate.trim())) {
    return 'Appointment date must use YYYY-MM-DD.';
  }
  if (input.appointmentTime && !/^\d{2}:\d{2}$/.test(input.appointmentTime.trim())) {
    return 'Appointment time must use HH:MM (24-hour).';
  }
  if (missing.length > 0) {
    return `Missing: ${missing.join(', ')}.`;
  }
  return null;
}

export async function listInternalJobsForDate(date: string): Promise<StoredWorkOrder[]> {
  const snapshot = await getDocs(
    query(collection(db, WORK_ORDERS_COLLECTION), where('appointmentDate', '==', date))
  );
  return snapshot.docs
    .map((document) => mapDoc(document.id, document.data() as Record<string, unknown>))
    .filter((job) => job.source === INTERNAL_JOB_SOURCE)
    .sort((left, right) =>
      (right.workOrderNumber || '').localeCompare(left.workOrderNumber || '', undefined, {
        numeric: true,
      })
    );
}

export async function saveInternalJob(
  input: InternalJobInput,
  existingId?: string
): Promise<{ workOrderId: string }> {
  const error = validateInternalJob(input);
  if (error) throw new Error(error);

  const workOrderNumber =
    input.workOrderNumber.trim() ||
    `NJ-${input.appointmentDate.replace(/-/g, '')}-${Date.now().toString().slice(-4)}`;
  const recordId = existingId || internalRecordId(input.appointmentDate, workOrderNumber);

  await setDoc(
    doc(db, WORK_ORDERS_COLLECTION, recordId),
    {
      workOrderNumber,
      customerName: input.customerName.trim(),
      phone: normalizePhone(input.phone),
      address: input.address.trim(),
      jobType: input.jobType.trim(),
      appointmentDate: input.appointmentDate.trim(),
      appointmentTime: input.appointmentTime.trim(),
      notes: input.notes.trim(),
      sourceFileName: 'N&J internal job',
      smsConsent: input.smsConsent,
      smsConsentMethod: input.smsConsent ? 'verbal_internal_entry' : 'not_provided',
      source: INTERNAL_JOB_SOURCE,
      status: 'unscheduled',
      updatedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
    },
    { merge: true }
  );

  return { workOrderId: recordId };
}

export async function updateInternalJob(
  workOrderId: string,
  input: InternalJobInput
): Promise<void> {
  const error = validateInternalJob(input);
  if (error) throw new Error(error);

  await updateDoc(doc(db, WORK_ORDERS_COLLECTION, workOrderId), {
    workOrderNumber:
      input.workOrderNumber.trim() ||
      `NJ-${input.appointmentDate.replace(/-/g, '')}-${Date.now().toString().slice(-4)}`,
    customerName: input.customerName.trim(),
    phone: normalizePhone(input.phone),
    address: input.address.trim(),
    jobType: input.jobType.trim(),
    appointmentDate: input.appointmentDate.trim(),
    appointmentTime: input.appointmentTime.trim(),
    notes: input.notes.trim(),
    smsConsent: input.smsConsent,
    source: INTERNAL_JOB_SOURCE,
    updatedAt: Timestamp.now(),
  });
}

export async function deleteInternalJob(workOrderId: string): Promise<void> {
  await deleteDoc(doc(db, WORK_ORDERS_COLLECTION, workOrderId));
}
