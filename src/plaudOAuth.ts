const PLAUD_OAUTH_CLIENT_ID = 'client_9c501dad-8a0d-40b2-a7b0-d1cb8787f674';
const PLAUD_OAUTH_AUTHORIZE_URL = 'https://web.plaud.ai/platform/oauth';
const PENDING_KEY = 'njPlumbingPlaudOAuth';

export type PlaudOAuthPending = {
  verifier: string;
  state: string;
  redirectUri: string;
};

let finishPromise: Promise<void> | null = null;

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

export async function beginPlaudOAuth(): Promise<string> {
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

export type PlaudOAuthCallback = {
  code: string;
  state: string;
  error: string;
};

export function capturePlaudOAuthCallback(
  pathname = window.location.pathname,
  search = window.location.search
): PlaudOAuthCallback | null {
  const params = new URLSearchParams(search);
  const path = pathname.replace(/\/$/, '') || '/';
  const code = params.get('code') || '';
  const state = params.get('state') || '';
  const error = params.get('error_description') || params.get('error') || '';
  const isCallbackPath = path === '/auth/callback' || path === '/plaud/callback';
  if (!isCallbackPath && !code && !state && !error) return null;
  if (!code && !state && !error) return null;
  return { code, state, error };
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

export function runPlaudOAuthFinishOnce(run: () => Promise<void>): Promise<void> {
  if (!finishPromise) finishPromise = run();
  return finishPromise;
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
  if (code.includes('not-found') || /NOT_FOUND|not found/i.test(message)) {
    return 'Plaud sign-in is not on the server yet. Deploy functions, then click Sign in with Plaud again.';
  }
  if (code.includes('unavailable') || code.includes('deadline')) {
    return 'Could not reach the NJ Plumbing server. Wait a few seconds, then click Sign in with Plaud again.';
  }
  if (/fetch failed|failed to fetch|could not reach plaud/i.test(message)) {
    return 'Google Cloud could not talk to Plaud from the server. Your login was still captured if you stayed on the Plaud home page — click Sign in with Plaud once more.';
  }
  if (/-3901|token type does not match/i.test(message)) {
    return 'Plaud rejected the saved login type. Click Reconnect Plaud, sign in at web.plaud.ai, and wait until this app connects.';
  }
  if (code.includes('internal') || /^internal$/i.test(message.trim())) {
    return 'Plaud failed on the server. Try Sync this day again, or click Reconnect Plaud if it keeps failing.';
  }
  if (typeof details === 'string' && details.trim()) return details;
  return message.replace(/^(INTERNAL|UNKNOWN|FAILED-PRECONDITION):?\s*/i, '') || 'Plaud sign-in failed.';
}
