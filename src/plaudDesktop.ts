export type PlaudDesktopSignInResult = {
  token?: string;
  cancelled?: boolean;
  error?: string;
};

type PlaudDesktopApi = {
  available: true;
  signIn: () => Promise<PlaudDesktopSignInResult>;
};

declare global {
  interface Window {
    plaudDesktop?: PlaudDesktopApi;
  }
}

export function isPlaudDesktop(): boolean {
  return Boolean(window.plaudDesktop?.available);
}

export async function signInWithPlaudDesktop(): Promise<string> {
  if (!window.plaudDesktop) {
    throw new Error('Desktop Plaud sign-in is not available in the browser.');
  }
  const result = await window.plaudDesktop.signIn();
  if (result.token) return result.token;
  if (result.cancelled) {
    throw new Error('Plaud sign-in was closed before a login was found.');
  }
  throw new Error(result.error || 'Plaud sign-in failed.');
}
