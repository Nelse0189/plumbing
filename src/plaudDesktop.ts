export type PlaudDesktopSignInResult = {
  token?: string;
  cancelled?: boolean;
  error?: string;
};

export type PlaudDesktopLibraryFile = {
  id: string;
  name?: string;
  created_at?: string;
  start_at?: string;
  duration?: number;
  serial_number?: string;
};

export type PlaudDesktopLibraryResult = {
  files?: PlaudDesktopLibraryFile[];
  token?: string;
  total?: number;
  error?: string;
};

type PlaudDesktopApi = {
  available: true;
  signIn: () => Promise<PlaudDesktopSignInResult>;
  listLibrary: (options?: {
    date?: string;
    allTime?: boolean;
  }) => Promise<PlaudDesktopLibraryResult>;
  openPdf?: (base64: string, fileName: string) => Promise<void>;
  printHtml?: (html: string, fileName: string) => Promise<void>;
};

declare global {
  interface Window {
    plaudDesktop?: PlaudDesktopApi;
  }
}

let browserSignInAvailable: boolean | null = null;

export function isPlaudDesktop(): boolean {
  return Boolean(window.plaudDesktop?.available);
}

export async function canSignInWithPlaudWindow(): Promise<boolean> {
  if (isPlaudDesktop()) return true;
  if (browserSignInAvailable !== null) return browserSignInAvailable;
  try {
    const response = await fetch('/__plaud_desktop.json', { cache: 'no-store' });
    if (!response.ok) {
      browserSignInAvailable = false;
      return false;
    }
    const data = (await response.json()) as { available?: boolean };
    browserSignInAvailable = Boolean(data.available);
    return browserSignInAvailable;
  } catch {
    browserSignInAvailable = false;
    return false;
  }
}

function resultToken(result: PlaudDesktopSignInResult): string {
  if (result.token) return result.token;
  if (result.cancelled) {
    throw new Error('Plaud sign-in was closed before a login was found.');
  }
  throw new Error(result.error || 'Plaud sign-in failed.');
}

export async function signInWithPlaudDesktop(): Promise<string> {
  if (window.plaudDesktop) {
    return resultToken(await window.plaudDesktop.signIn());
  }
  const response = await fetch('/__plaud_signin', { method: 'POST' });
  if (response.status === 404) {
    throw new Error('Desktop Plaud sign-in is not available in the browser.');
  }
  const result = (await response.json()) as PlaudDesktopSignInResult;
  return resultToken(result);
}
