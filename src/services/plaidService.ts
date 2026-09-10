import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase/config';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app, 'us-central1');

export type PlaidItemSummary = {
  itemId: string;
  institutionName: string;
  environment: string;
};

export type PlaidConnection = {
  environment: string;
  configured: boolean;
  items: PlaidItemSummary[];
};

export type PlaidTransaction = {
  transactionId: string;
  date: string;
  name: string;
  merchantName: string;
  amount: number;
  pending: boolean;
  category: string;
};

export async function connectPlaidSandboxBank(): Promise<{
  itemId: string;
  institutionName: string;
  environment: string;
}> {
  const call = httpsCallable<
    Record<string, never>,
    { itemId: string; institutionName: string; environment: string }
  >(functions, 'connectPlaidSandboxBank');
  const result = await call({});
  return result.data;
}

export async function createPlaidLinkToken(origin = window.location.origin): Promise<{
  linkToken: string;
  environment: string;
}> {
  const call = httpsCallable<{ origin: string }, { linkToken: string; environment: string }>(
    functions,
    'createPlaidLinkToken'
  );
  const result = await call({ origin: origin.replace(/\/$/, '') });
  return result.data;
}

export async function exchangePlaidPublicToken(input: {
  publicToken: string;
  institution?: { name?: string; institution_id?: string };
}): Promise<{ itemId: string; institutionName: string; environment: string }> {
  const call = httpsCallable<typeof input, { itemId: string; institutionName: string; environment: string }>(
    functions,
    'exchangePlaidPublicToken'
  );
  const result = await call(input);
  return result.data;
}

export async function getPlaidConnection(): Promise<PlaidConnection> {
  const call = httpsCallable<Record<string, never>, PlaidConnection>(functions, 'getPlaidConnection');
  const result = await call({});
  return result.data;
}

export async function syncPlaidTransactions(): Promise<{
  added: number;
  modified: number;
  removed: number;
}> {
  const call = httpsCallable<Record<string, never>, { added: number; modified: number; removed: number }>(
    functions,
    'syncPlaidTransactions',
    { timeout: 120_000 }
  );
  const result = await call({});
  return result.data;
}

export async function listPlaidTransactions(): Promise<PlaidTransaction[]> {
  const call = httpsCallable<Record<string, never>, { transactions: PlaidTransaction[] }>(
    functions,
    'listPlaidTransactions'
  );
  const result = await call({});
  return result.data.transactions || [];
}

export function formatPlaidCallableError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: string }).message).replace(/^FirebaseError:\s*/i, '');
  }
  return error instanceof Error ? error.message : String(error);
}
