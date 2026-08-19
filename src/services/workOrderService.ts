import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase/config';
import type { StoredWorkOrder, WorkOrder } from '../types';

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

export async function detectWorkOrderSchedules(): Promise<{
  scanned: number;
  booked: number;
  skipped: number;
  costUsd: number;
}> {
  const callable = httpsCallable<
    Record<string, never>,
    { scanned: number; booked: number; skipped: number; costUsd: number }
  >(functions, 'detectWorkOrderSchedules', { timeout: 540000 });
  const result = await callable({});
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
