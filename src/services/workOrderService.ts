import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase/config';
import type { WorkOrder } from '../types';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app);

export async function extractWorkOrder(
  text: string,
  sourceFileName: string,
  microsoftAccessToken: string
): Promise<WorkOrder> {
  const callable = httpsCallable<
    {
      text: string;
      sourceFileName: string;
      microsoftAccessToken: string;
    },
    WorkOrder
  >(functions, 'extractWorkOrder');
  const result = await callable({ text, sourceFileName, microsoftAccessToken });
  return result.data;
}

export async function saveWorkOrder(
  workOrder: WorkOrder,
  microsoftAccessToken: string
): Promise<{
  success: boolean;
  workOrderId: string;
  reminderQueued: boolean;
  confirmationScheduledFor: string | null;
}> {
  const callable = httpsCallable<
    { workOrder: WorkOrder; microsoftAccessToken: string },
    {
      success: boolean;
      workOrderId: string;
      reminderQueued: boolean;
      confirmationScheduledFor: string | null;
    }
  >(functions, 'saveWorkOrder');
  const result = await callable({ workOrder, microsoftAccessToken });
  return result.data;
}

