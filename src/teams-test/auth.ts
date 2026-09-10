import { PublicClientApplication, type AccountInfo } from '@azure/msal-browser';

const clientId = (import.meta.env.VITE_AZURE_CLIENT_ID as string | undefined)?.trim() || '';
const tenantId = (import.meta.env.VITE_AZURE_TENANT_ID as string | undefined)?.trim() || '';

export const azureConfigError =
  !clientId || !tenantId
    ? 'Missing VITE_AZURE_CLIENT_ID or VITE_AZURE_TENANT_ID. Add them to .env.local and rebuild hosting.'
    : null;

export const graphScopes = [
  'User.Read',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'ChannelMessage.Read.All',
  'Files.Read.All',
];

/** Extra delegated scope used only when staff click to post a schedule into Teams. */
export const graphWriteScopes = [...graphScopes, 'ChannelMessage.Send'];

function azureOrigin() {
  return window.location.origin.replace('http://127.0.0.1:', 'http://localhost:');
}

function azureRedirectUri() {
  // Azure app 05f5ddcc-... is registered for /teams-test, not the Bills tab at /.
  return `${azureOrigin()}/teams-test`;
}

export const msalInstance = azureConfigError
  ? null
  : new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri: azureRedirectUri(),
      },
      cache: {
        cacheLocation: 'localStorage',
      },
    });

const DESKTOP_SHELL_KEY = 'njplumbing.shell';
const MSAL_RETURN_KEY = 'njplumbing.msal.returnTo';

let initialized = false;
let redirectHandle: ReturnType<PublicClientApplication['handleRedirectPromise']> | null = null;

export function rememberDesktopShell() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (
      params.get('shell') === 'desktop' ||
      /Electron/i.test(navigator.userAgent) ||
      Boolean(window.plaudDesktop?.available)
    ) {
      sessionStorage.setItem(DESKTOP_SHELL_KEY, 'desktop');
    }
  } catch {
    // Ignore private-mode / missing sessionStorage.
  }
}

export function isDesktopShell() {
  rememberDesktopShell();
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/plumber' || path === '/ticket' || path === '/work-order') {
    return new URLSearchParams(window.location.search).get('shell') === 'desktop';
  }
  try {
    return (
      sessionStorage.getItem(DESKTOP_SHELL_KEY) === 'desktop' ||
      /Electron/i.test(navigator.userAgent) ||
      Boolean(window.plaudDesktop?.available) ||
      window.matchMedia('(display-mode: standalone)').matches
    );
  } catch {
    return false;
  }
}

function currentAppPath() {
  const url = new URL(window.location.href);
  url.hash = '';
  if (url.pathname.startsWith('/teams-test')) {
    url.pathname = '/';
    url.searchParams.set('view', 'teams');
  }
  if (isDesktopShell()) url.searchParams.set('shell', 'desktop');
  return `${url.pathname}${url.search}`;
}

export function postLoginRedirectUrl() {
  try {
    const stored = sessionStorage.getItem(MSAL_RETURN_KEY);
    sessionStorage.removeItem(MSAL_RETURN_KEY);
    if (stored?.startsWith('/')) {
      const url = new URL(stored, window.location.origin);
      if (url.origin === window.location.origin && !url.pathname.startsWith('/teams-test')) {
        if (isDesktopShell()) url.searchParams.set('shell', 'desktop');
        return `${url.pathname}${url.search}`;
      }
    }
  } catch {
    // Fall through to Teams.
  }
  return isDesktopShell() ? '/?view=teams&shell=desktop' : '/?view=teams';
}

function requireMsal() {
  if (!msalInstance) {
    throw new Error(azureConfigError || 'Azure sign-in is not configured');
  }
  return msalInstance;
}

export async function ensureMsalInitialized() {
  const instance = requireMsal();
  if (!initialized) {
    await instance.initialize();
    initialized = true;
  }
  return instance;
}

function clearRedirectParams() {
  const url = new URL(window.location.href);
  let changed = false;
  if (url.hash.length > 1) {
    url.hash = '';
    changed = true;
  }
  for (const key of ['code', 'state', 'session_state', 'client_info', 'error', 'error_description']) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) {
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
}

function isStaleRedirectError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /no_token_request_cache_error|token request found in cache|hash_empty_error/i.test(
    message
  );
}

export async function handleRedirectPromise() {
  if (!msalInstance) return null;
  if (!redirectHandle) {
    redirectHandle = (async () => {
      const instance = await ensureMsalInitialized();
      try {
        return await instance.handleRedirectPromise();
      } catch (error) {
        if (isStaleRedirectError(error)) {
          clearRedirectParams();
          return null;
        }
        throw error;
      }
    })();
  }
  return redirectHandle;
}

export function getActiveAccount(): AccountInfo | null {
  if (!msalInstance) return null;
  const accounts = msalInstance.getAllAccounts();
  return accounts[0] ?? null;
}

let signInInFlight: Promise<void> | null = null;

function clearStuckInteraction() {
  for (const storage of [sessionStorage, localStorage]) {
    const keys = Object.keys(storage).filter((key) =>
      /interaction\.status|msal\..*\.interaction/i.test(key)
    );
    for (const key of keys) storage.removeItem(key);
  }
}

function authErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isPopupFailed(error: unknown) {
  return /timed_out|redirect_bridge|user_cancelled|popup_window_error|popup/i.test(
    authErrorMessage(error)
  );
}

function startRedirectLogin(instance: PublicClientApplication) {
  const returnTo = currentAppPath();
  sessionStorage.setItem(MSAL_RETURN_KEY, returnTo);
  return instance.loginRedirect({
    scopes: graphScopes,
    redirectStartPage: `${azureOrigin()}${returnTo}`,
  });
}

/** 127.0.0.1 and localhost are different origins; Azure is registered on localhost. */
function bounceToAzureOrigin() {
  const current = window.location.origin;
  const azure = azureOrigin();
  if (current === azure) return false;
  const next = new URL(window.location.href);
  next.host = new URL(azure).host;
  window.location.replace(`${next.pathname}${next.search}${next.hash}`);
  return true;
}

export async function signIn() {
  if (bounceToAzureOrigin()) return;
  await handleRedirectPromise();
  if (getActiveAccount()) return;
  if (signInInFlight) return signInInFlight;
  signInInFlight = (async () => {
    const instance = await ensureMsalInitialized();
    // Desktop (Electron / Edge --app) treats window.open as a second app window.
    if (isDesktopShell()) {
      try {
        await startRedirectLogin(instance);
      } catch (error) {
        if (!/timed_out/i.test(authErrorMessage(error))) throw error;
        await instance.loginPopup({ scopes: graphScopes });
      }
      return;
    }
    try {
      await instance.loginPopup({ scopes: graphScopes });
    } catch (error) {
      const message = authErrorMessage(error);
      if (/interaction_in_progress/i.test(message)) {
        clearStuckInteraction();
        try {
          await instance.loginPopup({ scopes: graphScopes });
          return;
        } catch (retryError) {
          if (!isPopupFailed(retryError)) throw retryError;
          await startRedirectLogin(instance);
          return;
        }
      }
      if (isPopupFailed(error)) {
        await startRedirectLogin(instance);
        return;
      }
      throw error;
    }
  })().finally(() => {
    signInInFlight = null;
  });
  return signInInFlight;
}

export async function signOut() {
  const instance = await ensureMsalInitialized();
  const account = getActiveAccount();
  if (isDesktopShell()) {
    await instance.logoutRedirect({
      account: account ?? undefined,
    });
    return;
  }
  try {
    await instance.logoutPopup({
      account: account ?? undefined,
    });
  } catch {
    await instance.logoutRedirect({
      account: account ?? undefined,
    });
  }
}

/** Silent token for background polls. Never opens a popup. */
export async function tryAcquireTokenSilent(): Promise<string | null> {
  if (!msalInstance) return null;
  try {
    const instance = await ensureMsalInitialized();
    const account = getActiveAccount();
    if (!account) return null;
    const result = await instance.acquireTokenSilent({
      scopes: graphScopes,
      account,
    });
    return result.accessToken || null;
  } catch {
    return null;
  }
}

export async function acquireToken(scopes: string[] = graphScopes) {
  const instance = await ensureMsalInitialized();
  const account = getActiveAccount();
  if (!account) {
    throw new Error('Not signed in');
  }

  try {
    const result = await instance.acquireTokenSilent({
      scopes,
      account,
    });
    return result.accessToken;
  } catch {
    if (isDesktopShell()) {
      await instance.acquireTokenRedirect({
        scopes,
        account,
        redirectStartPage: `${azureOrigin()}${currentAppPath()}`,
      });
      throw new Error('Redirecting to Microsoft to refresh sign-in…');
    }
    try {
      const result = await instance.acquireTokenPopup({
        scopes,
        account,
      });
      return result.accessToken;
    } catch (error) {
      if (!isPopupFailed(error)) throw error;
      await instance.acquireTokenRedirect({
        scopes,
        account,
        redirectStartPage: `${azureOrigin()}${currentAppPath()}`,
      });
      throw new Error('Redirecting to Microsoft to refresh sign-in…');
    }
  }
}
