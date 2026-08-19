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

function azureRedirectUri() {
  const origin = window.location.origin.replace(
    'http://127.0.0.1:',
    'http://localhost:'
  );
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  return `${origin}${path}`;
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
        cacheLocation: 'sessionStorage',
      },
    });

let initialized = false;

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

export async function handleRedirectPromise() {
  if (!msalInstance) return null;
  const instance = await ensureMsalInitialized();
  return instance.handleRedirectPromise();
}

export function getActiveAccount(): AccountInfo | null {
  if (!msalInstance) return null;
  const accounts = msalInstance.getAllAccounts();
  return accounts[0] ?? null;
}

export async function signIn() {
  const instance = await ensureMsalInitialized();
  await instance.loginRedirect({ scopes: graphScopes });
}

export async function signOut() {
  const instance = await ensureMsalInitialized();
  const account = getActiveAccount();
  await instance.logoutRedirect({
    account: account ?? undefined,
  });
}

export async function acquireToken() {
  const instance = await ensureMsalInitialized();
  const account = getActiveAccount();
  if (!account) {
    throw new Error('Not signed in');
  }

  try {
    const result = await instance.acquireTokenSilent({
      scopes: graphScopes,
      account,
    });
    return result.accessToken;
  } catch {
    await instance.acquireTokenRedirect({
      scopes: graphScopes,
      account,
    });
    throw new Error('Redirecting for token refresh');
  }
}
