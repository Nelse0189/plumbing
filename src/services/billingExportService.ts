import { collection, onSnapshot, orderBy, query, limit, type Unsubscribe } from 'firebase/firestore';
import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../firebase/config';
import type { JobTicket } from '../types';
import {
  BILLING_EXPORT_SHAREPOINT_URL,
  buildCompletedJobsWorkbook,
  type BillingExportLinePreview,
  type BillingExportTicket,
  type BillingExportWorkbook,
} from '../utils/billingInvoiceExport';

export interface BillingExportRecord {
  id: string;
  serviceDate: string;
  createdAt?: string;
  trigger: 'manual' | 'schedule';
  fileName: string;
  includedCount: number;
  skippedCount: number;
  wroteToSharePoint: false;
}

function asTicket(ticket: JobTicket): BillingExportTicket {
  return {
    id: ticket.id,
    status: ticket.status,
    workOrderNumber: ticket.workOrderNumber,
    customerName: ticket.customerName,
    city: ticket.city,
    serviceDate: ticket.serviceDate,
    jobType: ticket.jobType,
    workPerformed: ticket.followUpNotes || ticket.workPerformed,
    heaterModel: ticket.heaterModel,
    heaterPrice: ticket.heaterPrice,
    permitAmount: ticket.permitAmount,
    laborAmount: ticket.laborAmount,
    totalAmount: ticket.totalAmount,
    materials: ticket.materials,
    extraCharges: ticket.extraCharges,
    signedAt: ticket.signedAt,
    plumberName: ticket.plumberName,
  };
}

export function buildJobTicketBillingWorkbook(
  tickets: JobTicket[],
  serviceDate: string
): BillingExportWorkbook {
  return buildCompletedJobsWorkbook(tickets.map(asTicket), {
    serviceDate,
    sharePointUrl: BILLING_EXPORT_SHAREPOINT_URL,
  });
}

export function downloadBillingWorkbook(workbook: BillingExportWorkbook) {
  const blob = new Blob([workbook.bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = workbook.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export async function requestNightlyBillingExport(serviceDate: string): Promise<{
  fileName: string;
  included: BillingExportLinePreview[];
  skipped: BillingExportLinePreview[];
  bytes?: Uint8Array;
}> {
  const functions = getFunctions(getApp(), 'us-central1');
  const callable = httpsCallable<
    { serviceDate: string },
    {
      fileName: string;
      fileBase64: string;
      included: BillingExportLinePreview[];
      skipped: BillingExportLinePreview[];
    }
  >(functions, 'exportCompletedJobTickets');
  const result = await callable({ serviceDate });
  const bytes = Uint8Array.from(atob(result.data.fileBase64), (char) => char.charCodeAt(0));
  return {
    fileName: result.data.fileName,
    included: result.data.included,
    skipped: result.data.skipped,
    bytes,
  };
}

export function subscribeBillingExports(
  onChange: (exports: BillingExportRecord[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'billingExports'), orderBy('createdAt', 'desc'), limit(12)),
    (snapshot) => {
      onChange(
        snapshot.docs.map((document) => {
          const data = document.data() as Record<string, unknown>;
          const createdAt = data.createdAt;
          return {
            id: document.id,
            serviceDate: typeof data.serviceDate === 'string' ? data.serviceDate : '',
            createdAt:
              createdAt && typeof createdAt === 'object' && 'toDate' in createdAt
                ? (createdAt as { toDate: () => Date }).toDate().toISOString()
                : undefined,
            trigger: data.trigger === 'schedule' ? 'schedule' : 'manual',
            fileName: typeof data.fileName === 'string' ? data.fileName : 'export.xlsx',
            includedCount: typeof data.includedCount === 'number' ? data.includedCount : 0,
            skippedCount: typeof data.skippedCount === 'number' ? data.skippedCount : 0,
            wroteToSharePoint: false,
          };
        })
      );
    },
    (error) => onError?.(error)
  );
}
