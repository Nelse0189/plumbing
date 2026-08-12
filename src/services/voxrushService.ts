import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase/config';
import type { VoxrushCall } from '../types';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app);

export async function mockVoxrushCall(input: {
  transcript: string;
  callerPhone?: string;
  startedAt?: string;
}): Promise<{ callId: string; workOrderId: string; appointmentMade: boolean }> {
  const call = httpsCallable<typeof input, {
    callId: string;
    workOrderId: string;
    appointmentMade: boolean;
  }>(functions, 'mockVoxrushCall');
  const result = await call(input);
  return result.data;
}

export async function listVoxrushCalls(date: string): Promise<VoxrushCall[]> {
  const call = httpsCallable<{ date: string }, VoxrushCall[]>(functions, 'listVoxrushCalls');
  const result = await call({ date });
  return result.data;
}

export async function askVoxrushCalls(date: string, question: string): Promise<string> {
  const call = httpsCallable<{ date: string; question: string }, { answer: string }>(
    functions,
    'askVoxrushCalls'
  );
  const result = await call({ date, question });
  return result.data.answer;
}
