import { getApps, initializeApp } from 'firebase/app';
import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db, firebaseConfig } from '../firebase/config';
import type { TeamsLiveSyncResult } from './workOrderService';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app, 'us-central1');

const STATUS_DOC = doc(db, 'appConfig', 'teamsServerSync');

/** Server sync is considered alive when its last pass finished within this window. */
export const TEAMS_SERVER_SYNC_FRESH_MS = 6 * 60 * 1000;

export interface TeamsServerSyncStatus {
  connected: boolean;
  needsReconnect: boolean;
  account: string;
  displayName: string;
  connectedAt: string;
  lastCheckedAt: string;
  lastError: string;
  lastErrorAt: string;
  lastTrigger: string;
  runningSinceMs: number;
  lastResult: TeamsLiveSyncResult | null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapStatus(value: unknown): TeamsServerSyncStatus {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const rawResult = record.lastResult;
  const lastResult =
    rawResult && typeof rawResult === 'object'
      ? (rawResult as TeamsLiveSyncResult)
      : null;
  return {
    connected: record.connected === true,
    needsReconnect: record.needsReconnect === true,
    account: asText(record.account),
    displayName: asText(record.displayName),
    connectedAt: asText(record.connectedAt),
    lastCheckedAt: asText(record.lastCheckedAt),
    lastError: asText(record.lastError),
    lastErrorAt: asText(record.lastErrorAt),
    lastTrigger: asText(record.lastTrigger),
    runningSinceMs: typeof record.runningSinceMs === 'number' ? record.runningSinceMs : 0,
    lastResult,
  };
}

export function subscribeTeamsServerSyncStatus(
  onChange: (status: TeamsServerSyncStatus) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    STATUS_DOC,
    (snap) => onChange(mapStatus(snap.data())),
    (error) => onError?.(error)
  );
}

/** True when the server pulled the channel recently enough that the browser can skip its own poll. */
export function teamsServerSyncIsFresh(
  status: TeamsServerSyncStatus | null,
  now = Date.now()
): boolean {
  if (!status || !status.connected || status.needsReconnect) return false;
  const last = Date.parse(status.lastCheckedAt);
  return Number.isFinite(last) && now - last < TEAMS_SERVER_SYNC_FRESH_MS;
}

export async function startTeamsServerConnect(
  microsoftAccessToken: string
): Promise<{ url: string; redirectUri: string }> {
  const params = new URLSearchParams(window.location.search);
  params.set('view', 'teams');
  const returnTo = `${window.location.origin}/?${params.toString()}`;
  const callable = httpsCallable<
    { microsoftAccessToken: string; returnTo: string },
    { url: string; redirectUri: string }
  >(functions, 'startTeamsServerConnect');
  const result = await callable({ microsoftAccessToken, returnTo });
  return result.data;
}

export async function disconnectTeamsServerSync(microsoftAccessToken: string): Promise<void> {
  const callable = httpsCallable<{ microsoftAccessToken: string }, { ok: boolean }>(
    functions,
    'disconnectTeamsServerSync'
  );
  await callable({ microsoftAccessToken });
}

export async function runTeamsServerSyncNow(
  microsoftAccessToken: string
): Promise<TeamsLiveSyncResult> {
  const callable = httpsCallable<{ microsoftAccessToken: string }, TeamsLiveSyncResult>(
    functions,
    'runTeamsServerSyncNow',
    { timeout: 180000 }
  );
  return (await callable({ microsoftAccessToken })).data;
}
