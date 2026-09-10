import { useEffect, useRef, useState } from 'react';
import {
  handleRedirectPromise,
  tryAcquireTokenSilent,
} from '../teams-test/auth';
import {
  describeSync,
  emitTeamsLiveSync,
  pullNewTeamsComments,
  subscribeTeamsWatchTarget,
  writeTeamsWatchSince,
  type TeamsWatchTarget,
} from '../services/teamsWatchService';
import {
  subscribeTeamsServerSyncStatus,
  teamsServerSyncIsFresh,
  type TeamsServerSyncStatus,
} from '../services/teamsServerSyncService';

const POLL_MS = 2 * 60 * 1000;

export function useTeamsLiveSync(enabled: boolean) {
  const [target, setTarget] = useState<TeamsWatchTarget | null>(null);
  const targetRef = useRef<TeamsWatchTarget | null>(null);
  const serverStatusRef = useRef<TeamsServerSyncStatus | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    if (!enabled) return;
    return subscribeTeamsWatchTarget(setTarget, (error) => {
      console.warn('Could not load the Teams watch channel:', error);
    });
  }, [enabled]);

  // The server-side sync (stored Microsoft sign-in) pulls the channel every
  // 2 minutes on its own. While it is healthy the browser stays quiet and just
  // relays the server's results into the same status line; if it stops, the
  // browser poll below takes over automatically.
  useEffect(() => {
    if (!enabled) return;
    let lastSeenCheckedAt = '';
    return subscribeTeamsServerSyncStatus(
      (status) => {
        serverStatusRef.current = status;
        const result = status.lastResult;
        if (!result || !status.lastCheckedAt || status.lastCheckedAt === lastSeenCheckedAt) {
          return;
        }
        const firstSnapshot = lastSeenCheckedAt === '';
        lastSeenCheckedAt = status.lastCheckedAt;
        if (teamsServerSyncIsFresh(status)) {
          const watch = targetRef.current;
          if (watch) writeTeamsWatchSince(watch.channelId, status.lastCheckedAt);
        }
        if (firstSnapshot) return;
        if (result.imported || result.updated || result.booked) {
          emitTeamsLiveSync({ ...result, message: describeSync(result) });
        }
      },
      (error) => {
        console.warn('Could not read the server Teams sync status:', error);
      }
    );
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer = 0;

    const pull = async () => {
      if (cancelled || inFlightRef.current) return;
      if (document.visibilityState === 'hidden') return;
      const watch = targetRef.current;
      if (!watch) return;
      if (teamsServerSyncIsFresh(serverStatusRef.current)) return;
      const token = await tryAcquireTokenSilent();
      if (!token || cancelled) return;
      inFlightRef.current = true;
      try {
        await pullNewTeamsComments(watch, token);
      } catch (error) {
        console.warn('Teams live pull failed:', error);
      } finally {
        inFlightRef.current = false;
      }
    };

    void handleRedirectPromise()
      .catch(() => null)
      .then(() => {
        if (cancelled) return;
        void pull();
        timer = window.setInterval(() => {
          void pull();
        }, POLL_MS);
      });

    const onVisible = () => {
      if (document.visibilityState === 'visible') void pull();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, target?.teamId, target?.channelId]);
}
