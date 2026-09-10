import { doc, onSnapshot, setDoc, serverTimestamp, type Unsubscribe } from 'firebase/firestore';
import { db } from '../firebase/config';
import {
  syncOpenTeamsChannel,
  type TeamsLiveSyncResult,
} from './workOrderService';

const WATCH_DOC = doc(db, 'appConfig', 'teamsWatch');
const LOCAL_WATCH_KEY = 'njplumbing.teamsWatch';
const LOCAL_SINCE_KEY = 'njplumbing.teamsWatchSince';

export interface TeamsWatchTarget {
  teamId: string;
  channelId: string;
  channelName: string;
}

export interface TeamsLiveSyncEvent extends TeamsLiveSyncResult {
  message: string;
}

type StatusListener = (event: TeamsLiveSyncEvent) => void;

const statusListeners = new Set<StatusListener>();

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapWatchTarget(value: unknown): TeamsWatchTarget | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const teamId = asText(record.teamId);
  const channelId = asText(record.channelId);
  if (!teamId || !channelId) return null;
  return {
    teamId,
    channelId,
    channelName: asText(record.channelName) || 'Teams channel',
  };
}

export function readLocalTeamsWatch(): TeamsWatchTarget | null {
  try {
    return mapWatchTarget(JSON.parse(localStorage.getItem(LOCAL_WATCH_KEY) || ''));
  } catch {
    return null;
  }
}

export function writeLocalTeamsWatch(target: TeamsWatchTarget) {
  try {
    localStorage.setItem(LOCAL_WATCH_KEY, JSON.stringify(target));
  } catch {
    // Ignore private-mode / quota errors.
  }
}

export function readTeamsWatchSince(channelId: string): string | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_SINCE_KEY) || '{}') as Record<
      string,
      unknown
    >;
    const value = asText(raw[channelId]);
    return value || null;
  } catch {
    return null;
  }
}

export function writeTeamsWatchSince(channelId: string, iso: string) {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_SINCE_KEY) || '{}') as Record<
      string,
      string
    >;
    raw[channelId] = iso;
    localStorage.setItem(LOCAL_SINCE_KEY, JSON.stringify(raw));
  } catch {
    // Ignore private-mode / quota errors.
  }
}

export async function rememberTeamsWatchTarget(target: TeamsWatchTarget) {
  writeLocalTeamsWatch(target);
  await setDoc(
    WATCH_DOC,
    {
      teamId: target.teamId,
      channelId: target.channelId,
      channelName: target.channelName,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export function subscribeTeamsWatchTarget(
  onChange: (target: TeamsWatchTarget | null) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  onChange(readLocalTeamsWatch());
  return onSnapshot(
    WATCH_DOC,
    (snap) => {
      const target = mapWatchTarget(snap.data());
      if (target) writeLocalTeamsWatch(target);
      onChange(target || readLocalTeamsWatch());
    },
    (error) => onError?.(error)
  );
}

export function subscribeTeamsLiveSync(
  listener: StatusListener
): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function emitTeamsLiveSync(event: TeamsLiveSyncEvent) {
  for (const listener of statusListeners) listener(event);
}

export function describeSync(result: TeamsLiveSyncResult): string {
  if (result.imported || result.updated || result.booked) {
    const parts = [];
    if (result.imported) {
      parts.push(`${result.imported} new PDF${result.imported === 1 ? '' : 's'}`);
    }
    if (result.updated) {
      parts.push(
        `${result.updated} thread${result.updated === 1 ? '' : 's'} with new comments`
      );
    }
    if (result.booked) {
      parts.push(`booked ${result.booked}`);
    }
    return `Teams pull: ${parts.join(', ')}.`;
  }
  if (result.checked) {
    return `Teams pull: ${result.checked} PDF${result.checked === 1 ? '' : 's'} unchanged.`;
  }
  return 'Teams pull: no new comments.';
}

const FIRST_LOOKBACK_MS = 15 * 60 * 1000;
const OVERLAP_MS = 45 * 1000;

export async function pullNewTeamsComments(
  target: TeamsWatchTarget,
  microsoftAccessToken: string
): Promise<TeamsLiveSyncResult> {
  const storedSince = readTeamsWatchSince(target.channelId);
  const sinceMs = storedSince
    ? Date.parse(storedSince) - OVERLAP_MS
    : Date.now() - FIRST_LOOKBACK_MS;
  const sinceIso = new Date(
    Number.isFinite(sinceMs) ? sinceMs : Date.now() - FIRST_LOOKBACK_MS
  ).toISOString();
  const result = await syncOpenTeamsChannel({
    teamId: target.teamId,
    channelId: target.channelId,
    channelName: target.channelName,
    sinceIso,
    microsoftAccessToken,
  });
  writeTeamsWatchSince(target.channelId, result.checkedAt);
  emitTeamsLiveSync({ ...result, message: describeSync(result) });
  return result;
}
