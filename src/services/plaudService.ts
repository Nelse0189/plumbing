import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase/config';
import type { PlaudCall, PlaudConnection, PlaudSyncSummary } from '../types';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app);

export async function getPlaudConnection(): Promise<PlaudConnection> {
  const call = httpsCallable<Record<string, never>, PlaudConnection>(
    functions,
    'getPlaudConnection'
  );
  const result = await call({});
  return result.data;
}

export async function syncPlaudCalls(input: {
  date?: string;
  days?: number;
}): Promise<PlaudSyncSummary> {
  const call = httpsCallable<typeof input, PlaudSyncSummary>(functions, 'syncPlaudCalls');
  const result = await call(input);
  return result.data;
}

export async function importPlaudTranscript(input: {
  transcript: string;
  callerPhone?: string;
  startedAt?: string;
  recordingName?: string;
}): Promise<{ callId: string; workOrderId?: string; appointmentMade?: boolean; status: string }> {
  const call = httpsCallable<typeof input, {
    callId: string;
    workOrderId?: string;
    appointmentMade?: boolean;
    status: string;
  }>(functions, 'importPlaudTranscript');
  const result = await call(input);
  return result.data;
}

export async function listPlaudCalls(date: string): Promise<PlaudCall[]> {
  const call = httpsCallable<{ date: string }, PlaudCall[]>(functions, 'listPlaudCalls');
  const result = await call({ date });
  return result.data;
}

export async function askPlaudCalls(date: string, question: string): Promise<string> {
  const call = httpsCallable<{ date: string; question: string }, { answer: string }>(
    functions,
    'askPlaudCalls'
  );
  const result = await call({ date, question });
  return result.data.answer;
}
