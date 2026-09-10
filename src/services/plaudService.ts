import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase/config';
import type { PlaudCall, PlaudConnection, PlaudSyncSummary } from '../types';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app, 'us-central1');

export async function startPlaudOAuth(origin = window.location.origin): Promise<{ url: string }> {
  const call = httpsCallable<{ origin: string }, { url: string }>(functions, 'startPlaudOAuth');
  const result = await call({ origin });
  return result.data;
}

export async function finishPlaudOAuth(input: {
  code: string;
  state: string;
  verifier?: string;
  redirectUri?: string;
}): Promise<{ connected: boolean }> {
  const call = httpsCallable<typeof input, { connected: boolean }>(functions, 'finishPlaudOAuth');
  const result = await call(input);
  return result.data;
}

export async function connectPlaudWebSession(input: {
  token: string;
  apiBase?: string;
  cookie?: string;
}): Promise<{ connected: boolean; mode?: string }> {
  const call = httpsCallable<typeof input, { connected: boolean; mode?: string }>(
    functions,
    'connectPlaudWebSession',
    { timeout: 120 * 1000 }
  );
  const result = await call(input);
  return result.data;
}

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
  allTime?: boolean;
  files?: Array<{
    id: string;
    name?: string;
    created_at?: string;
    start_at?: string;
    duration?: number;
    serial_number?: string;
  }>;
}): Promise<PlaudSyncSummary> {
  const call = httpsCallable<typeof input, PlaudSyncSummary>(functions, 'syncPlaudCalls', {
    timeout: input.allTime ? 30 * 60 * 1000 : 9 * 60 * 1000,
  });
  const result = await call(input);
  return result.data;
}

export async function processPlaudCalls(input: {
  date?: string;
  days?: number;
  allTime?: boolean;
}): Promise<PlaudSyncSummary> {
  const call = httpsCallable<typeof input, PlaudSyncSummary>(functions, 'processPlaudCalls', {
    timeout: input.allTime ? 30 * 60 * 1000 : 9 * 60 * 1000,
  });
  const result = await call(input);
  return result.data;
}

export async function processPlaudCall(input: {
  callId: string;
  force?: boolean;
}): Promise<PlaudCall> {
  const call = httpsCallable<typeof input, PlaudCall>(functions, 'processPlaudCall', {
    timeout: 9 * 60 * 1000,
  });
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

export async function listPlaudCalls(input: {
  date?: string;
  allTime?: boolean;
}): Promise<PlaudCall[]> {
  const call = httpsCallable<{ date?: string; allTime?: boolean }, PlaudCall[]>(
    functions,
    'listPlaudCalls'
  );
  const result = await call(input);
  return result.data;
}

export async function getPlaudCallAudioUrl(callId: string): Promise<{
  url: string;
  filename: string;
  contentType: string;
}> {
  const call = httpsCallable<{ callId: string }, { url: string; filename: string; contentType: string }>(
    functions,
    'getPlaudCallAudioUrl',
    { timeout: 60 * 1000 }
  );
  const result = await call({ callId });
  return result.data;
}

export function plaudCallAudioProxyUrl(callId: string, download = false): string {
  const params = new URLSearchParams({ callId });
  if (download) params.set('download', '1');
  return `https://us-central1-${firebaseConfig.projectId}.cloudfunctions.net/plaudCallAudio?${params}`;
}

async function blobFromUrl(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail.trim().slice(0, 180) || `Could not download the recording (${response.status}).`);
  }
  return response.blob();
}

export async function downloadPlaudCallAudio(callId: string): Promise<{ blob: Blob; filename: string }> {
  let filename = 'call.mp3';
  try {
    const link = await getPlaudCallAudioUrl(callId);
    filename = link.filename || filename;
    const blob = await blobFromUrl(link.url);
    return { blob, filename };
  } catch {
    const blob = await blobFromUrl(plaudCallAudioProxyUrl(callId, true));
    return { blob, filename };
  }
}

export async function askPlaudCalls(date: string, question: string): Promise<string> {
  const call = httpsCallable<{ date: string; question: string }, { answer: string }>(
    functions,
    'askPlaudCalls'
  );
  const result = await call({ date, question });
  return result.data.answer;
}
