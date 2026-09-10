import { isDesktopShell } from '../teams-test/auth';

export const PLUMBER_PATH = '/plumber';

export function isPlumberPath(pathname = window.location.pathname): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return path === PLUMBER_PATH;
}

export function plumberHref(opts: { date?: string; truck?: string } = {}): string {
  const params = new URLSearchParams();
  if (opts.date) params.set('date', opts.date);
  if (opts.truck) params.set('truck', opts.truck);
  if (isNativePlumberApp()) params.set('app', '1');
  if (isDesktopShell()) {
    params.set('view', 'plumber');
    params.set('shell', 'desktop');
    return `/?${params.toString()}`;
  }
  const search = params.toString();
  return `${PLUMBER_PATH}${search ? `?${search}` : ''}`;
}

export function isNativePlumberApp(search = window.location.search): boolean {
  return new URLSearchParams(search).get('app') === '1';
}

/**
 * Web: the tab-free crew page at /plumber.
 * Electron: keep office chrome and fold those URLs into the Plumber tab.
 */
export function canonicalizePlumberLocation(): boolean {
  const params = new URLSearchParams(window.location.search);
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const fromOfficeView = params.get('view') === 'plumber';
  const fromPath = path === PLUMBER_PATH;
  if (!fromOfficeView && !fromPath) return false;

  const next = plumberHref({
    date: params.get('date') || undefined,
    truck: params.get('truck') || undefined,
  });
  if (`${path}${window.location.search}` !== next) {
    history.replaceState(null, '', next);
  }
  return !isDesktopShell();
}
