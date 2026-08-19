const PLAUD_OAUTH_CLIENT_ID = 'client_9c501dad-8a0d-40b2-a7b0-d1cb8787f674';
const PLAUD_OAUTH_AUTHORIZE_URL = 'https://web.plaud.ai/platform/oauth';
const PENDING_KEY = 'njPlumbingPlaudOAuth';

export type PlaudOAuthPending = {
  verifier: string;
  state: string;
  redirectUri: string;
};

let finishLock = false;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomUrlToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Base64Url(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64Url(new Uint8Array(hash));
}

export async function beginPlaudOAuth(origin = window.location.origin): Promise<string> {
  const verifier = randomUrlToken(32);
  const state = randomUrlToken(16);
  let redirectUri = '';
  for (let attempt = 0; attempt < 12 && !redirectUri; attempt += 1) {
    try {
      const response = await fetch('/__plaud_oauth.json', { cache: 'no-store' });
      if (response.ok) {
        const data = (await response.json()) as { redirectUri?: string };
        if (data.redirectUri && data.redirectUri.startsWith('http://localhost:')) {
          redirectUri = data.redirectUri;
          break;
        }
      }
    } catch {
      /* retry */
    }
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  }
  if (!redirectUri) {
    throw new Error(
      'This app is not ready to receive Plaud’s return login. Stop other Plaud tools using port 8199, restart npm run dev, then try again.'
    );
  }
  const pending: PlaudOAuthPending = { verifier, state, redirectUri };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL(PLAUD_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', PLAUD_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', await sha256Base64Url(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

export function isPlaudOAuthCallbackPath(pathname = window.location.pathname): boolean {
  const path = pathname.replace(/\/$/, '') || '/';
  return path === '/auth/callback' || path === '/plaud/callback';
}

export function hasPlaudOAuthCallbackParams(search = window.location.search): boolean {
  const params = new URLSearchParams(search);
  return Boolean(params.get('code') && params.get('state'));
}

export function peekPlaudOAuthPending(): PlaudOAuthPending | null {
  const raw = localStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PlaudOAuthPending;
    if (!parsed.verifier || !parsed.state || !parsed.redirectUri) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPlaudOAuthPending() {
  localStorage.removeItem(PENDING_KEY);
}

export function claimPlaudOAuthFinish(): boolean {
  if (finishLock) return false;
  finishLock = true;
  return true;
}

export function formatPlaudCallableError(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: string }).code)
      : '';
  const details =
    err && typeof err === 'object' && 'details' in err
      ? (err as { details?: unknown }).details
      : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (
    code.includes('not-found') ||
    message === 'internal' ||
    /NOT_FOUND|not found/i.test(message)
  ) {
    return 'Plaud sign-in is not on the server yet. Deploy functions, then click Sign in with Plaud again.';
  }
  if (typeof details === 'string' && details.trim()) return details;
  if (/400/.test(message)) {
    return 'Plaud rejected the sign-in. Click Sign in with Plaud again from this same tab.';
  }
  return message.replace(/^(INTERNAL|UNKNOWN):?\s*/i, '') || 'Plaud sign-in failed.';
}
