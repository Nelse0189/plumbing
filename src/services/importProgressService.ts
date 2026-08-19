import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase/config';

const IMPORT_RUNS_COLLECTION = 'workOrderImportRuns';

export interface WorkOrderImportProgress {
  id: string;
  channelId: string;
  channelName: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'canceled';
  total: number;
  processed: number;
  imported: number;
  cached: number;
  failed: number;
  message?: string;
  pdfCostUsd?: number;
  scheduleCostUsd?: number;
  openaiCostUsd?: number;
  updatedAt?: string;
}

export function formatUsd(amount?: number): string {
  const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  if (value <= 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function serializeProgress(
  id: string,
  data: Record<string, unknown>
): WorkOrderImportProgress {
  const updatedAt = data.updatedAt as { toDate?: () => Date } | undefined;
  return {
    id,
    channelId: typeof data.channelId === 'string' ? data.channelId : '',
    channelName: typeof data.channelName === 'string' ? data.channelName : 'Teams channel',
    status:
      data.status === 'queued' ||
      data.status === 'completed' ||
      data.status === 'failed' ||
      data.status === 'canceled'
        ? data.status
        : 'processing',
    total: typeof data.total === 'number' ? data.total : 0,
    processed: typeof data.processed === 'number' ? data.processed : 0,
    imported: typeof data.imported === 'number' ? data.imported : 0,
    cached: typeof data.cached === 'number' ? data.cached : 0,
    failed: typeof data.failed === 'number' ? data.failed : 0,
    message: typeof data.message === 'string' ? data.message : undefined,
    pdfCostUsd: asNumber(data.pdfCostUsd),
    scheduleCostUsd: asNumber(data.scheduleCostUsd),
    openaiCostUsd: asNumber(data.openaiCostUsd),
    updatedAt: updatedAt?.toDate?.().toISOString(),
  };
}

export async function saveWorkOrderImportProgress(
  progress: Omit<WorkOrderImportProgress, 'id' | 'updatedAt'>
) {
  await setDoc(
    doc(db, IMPORT_RUNS_COLLECTION, progress.channelId),
    {
      ...progress,
      updatedAt: Timestamp.now(),
    },
    { merge: true }
  );
}

export async function cancelWorkOrderImport(runId: string) {
  await updateDoc(doc(db, IMPORT_RUNS_COLLECTION, runId), {
    status: 'canceled',
    message: 'Canceled by user.',
    updatedAt: Timestamp.now(),
  });
}

export function subscribeLatestWorkOrderImportProgress(
  onChange: (progress: WorkOrderImportProgress | null) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(
      collection(db, IMPORT_RUNS_COLLECTION),
      orderBy('updatedAt', 'desc'),
      limit(1)
    ),
    (snapshot) => {
      const first = snapshot.docs[0];
      onChange(
        first
          ? serializeProgress(first.id, first.data() as Record<string, unknown>)
          : null
      );
    },
    onError
  );
}
