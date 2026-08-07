import { PublicClientApplication, type AccountInfo } from '@azure/msal-browser';

const clientId = import.meta.env.VITE_AZURE_CLIENT_ID as string;
const tenantId = import.meta.env.VITE_AZURE_TENANT_ID as string;

if (!clientId || !tenantId) {
  throw new Error(
    'Missing VITE_AZURE_CLIENT_ID or VITE_AZURE_TENANT_ID in .env.local'
  );
}

export const graphScopes = [
  'User.Read',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'ChannelMessage.Read.All',
  'Files.Read.All',
];

export const msalInstance = new PublicClientApplication({
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri: window.location.origin + window.location.pathname,
  },
  cache: {
    cacheLocation: 'sessionStorage',
  },
});

let initialized = false;

export async function ensureMsalInitialized() {
  if (!initialized) {
    await msalInstance.initialize();
    initialized = true;
  }
}

export async function handleRedirectPromise() {
  await ensureMsalInitialized();
  return msalInstance.handleRedirectPromise();
}

export function getActiveAccount(): AccountInfo | null {
  const accounts = msalInstance.getAllAccounts();
  return accounts[0] ?? null;
}

export async function signIn() {
  await ensureMsalInitialized();
  await msalInstance.loginRedirect({ scopes: graphScopes });
}

export async function signOut() {
  await ensureMsalInitialized();
  const account = getActiveAccount();
  await msalInstance.logoutRedirect({
    account: account ?? undefined,
  });
}

export async function acquireToken() {
  await ensureMsalInitialized();
  const account = getActiveAccount();
  if (!account) {
    throw new Error('Not signed in');
  }

  try {
    const result = await msalInstance.acquireTokenSilent({
      scopes: graphScopes,
      account,
    });
    return result.accessToken;
  } catch {
    await msalInstance.acquireTokenRedirect({
      scopes: graphScopes,
      account,
    });
    throw new Error('Redirecting for token refresh');
  }
}
