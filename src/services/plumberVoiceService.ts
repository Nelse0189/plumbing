import { getApp } from 'firebase/app';
import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../firebase/config';

const functions = getFunctions(getApp(), 'us-central1');

export type PlumberCallStatus =
  | 'queued'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'processed'
  | 'no-answer'
  | 'busy'
  | 'canceled'
  | 'failed'
  | 'awaiting_transcript';

export interface PlumberJobCall {
  callId: string;
  plumberPhone: string;
  customerPhone: string;
  status: PlumberCallStatus | string;
  error?: string;
}

export async function startPlumberJobCall(input: {
  dispatchDate: string;
  truckId: string;
  stopId: string;
  customerPhone?: string;
  plumberPhone?: string;
}): Promise<PlumberJobCall> {
  const callable = httpsCallable<typeof input, PlumberJobCall>(
    functions,
    'startPlumberJobCall',
    { timeout: 60 * 1000 }
  );
  const result = await callable(input);
  return result.data;
}

export function subscribePlumberCall(
  callId: string,
  onChange: (call: PlumberJobCall) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, 'plumberCalls', callId),
    (snap) => {
      const data = snap.data() || {};
      onChange({
        callId: snap.id,
        plumberPhone: typeof data.plumberPhone === 'string' ? data.plumberPhone : '',
        customerPhone: typeof data.customerPhone === 'string' ? data.customerPhone : '',
        status: typeof data.status === 'string' ? data.status : 'queued',
        error: typeof data.error === 'string' ? data.error : undefined,
      });
    },
    (error) => onError?.(error)
  );
}
