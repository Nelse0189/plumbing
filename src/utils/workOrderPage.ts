import { isDesktopShell } from '../teams-test/auth';

export const WORK_ORDER_PATH = '/work-order';

export function isWorkOrderPath(pathname = window.location.pathname): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return path === WORK_ORDER_PATH || path === '/ticket';
}

/** Phone/tablet browser, not the Electron office app. */
export function isPhoneJobTicket(): boolean {
  if (typeof window === 'undefined') return false;
  if (/Electron/i.test(navigator.userAgent) || Boolean(window.plaudDesktop?.available)) {
    return false;
  }
  try {
    return (
      window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(max-width: 900px)').matches
    );
  } catch {
    return false;
  }
}

export function workOrderHref(opts: { ticket?: string; sign?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (opts.ticket) params.set('ticket', opts.ticket);
  if (opts.sign) params.set('sign', '1');
  if (isDesktopShell()) {
    params.set('view', 'ticket');
    params.set('shell', 'desktop');
    return `/?${params.toString()}`;
  }
  const search = params.toString();
  return `${WORK_ORDER_PATH}${search ? `?${search}` : ''}`;
}

/**
 * Web: send office `?view=ticket` links and `/ticket` to the plumber-only page.
 * Electron/desktop: keep the full office chrome and fold those URLs into the ticket tab.
 */
export function canonicalizeWorkOrderLocation(): boolean {
  const params = new URLSearchParams(window.location.search);
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const fromOfficeView = params.get('view') === 'ticket';
  const fromAlias = path === '/ticket';
  const fromWorkOrder = path === WORK_ORDER_PATH;
  if (!fromOfficeView && !fromAlias && !fromWorkOrder) return false;

  const next = workOrderHref({
    ticket: params.get('ticket') || undefined,
    sign: params.get('sign') === '1',
  });
  if (`${path}${window.location.search}` !== next) {
    history.replaceState(null, '', next);
  }
  return !isDesktopShell();
}
