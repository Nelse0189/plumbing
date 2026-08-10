import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase/config';
import type { StoredWorkOrder, WorkOrder } from '../types';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app);

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

export async function saveWorkOrder(
  workOrder: WorkOrder,
  microsoftAccessToken: string
): Promise<{
  success: boolean;
  workOrderId: string;
  status: 'unscheduled';
}> {
  const callable = httpsCallable<
    { workOrder: WorkOrder; microsoftAccessToken: string },
    {
      success: boolean;
      workOrderId: string;
      status: 'unscheduled';
    }
  >(functions, 'saveWorkOrder');
  const result = await callable({ workOrder, microsoftAccessToken });
  return result.data;
}

export async function listWorkOrders(
  microsoftAccessToken: string
): Promise<StoredWorkOrder[]> {
  const callable = httpsCallable<
    { microsoftAccessToken: string },
    StoredWorkOrder[]
  >(functions, 'listWorkOrders');
  const result = await callable({ microsoftAccessToken });
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

