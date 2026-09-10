import { getApps, initializeApp } from 'firebase/app';
import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db, firebaseConfig } from '../firebase/config';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app, 'us-central1');

export type VoiceKnowledgeStatus = {
  status?: 'idle' | 'running' | 'error';
  lastIndexedAt?: string;
  lastTodayIndexAt?: string;
  chunkCount?: number;
  documentCount?: number;
  collectionCount?: number;
  error?: string;
};

export type VoiceAgentSession = {
  clientSecret: string;
  model: string;
  voice: string;
  knowledge?: VoiceKnowledgeStatus;
};

function callableError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: string }).message).replace(/^FirebaseError:\s*/i, '');
  }
  return 'Request failed.';
}

export async function createVoiceAgentSession(): Promise<VoiceAgentSession> {
  const call = httpsCallable<Record<string, never>, VoiceAgentSession>(
    functions,
    'createVoiceAgentSession',
    { timeout: 120 * 1000 }
  );
  try {
    return (await call({})).data;
  } catch (error) {
    throw new Error(callableError(error));
  }
}

export async function runVoiceAgentTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const call = httpsCallable<{ name: string; arguments: Record<string, unknown> }, unknown>(
    functions,
    'searchVoiceKnowledge',
    { timeout: 120 * 1000 }
  );
  try {
    return (await call({ name, arguments: args })).data;
  } catch (error) {
    throw new Error(callableError(error));
  }
}

export async function reindexVoiceKnowledge(): Promise<VoiceKnowledgeStatus> {
  const call = httpsCallable<Record<string, never>, VoiceKnowledgeStatus>(
    functions,
    'reindexVoiceKnowledge',
    { timeout: 1800 * 1000 }
  );
  try {
    return (await call({})).data;
  } catch (error) {
    throw new Error(callableError(error));
  }
}

export function subscribeVoiceKnowledgeStatus(
  onChange: (status: VoiceKnowledgeStatus | null) => void
): Unsubscribe {
  return onSnapshot(doc(db, 'voiceKnowledgeMeta', 'status'), (snap) => {
    onChange(snap.exists() ? (snap.data() as VoiceKnowledgeStatus) : null);
  });
}
