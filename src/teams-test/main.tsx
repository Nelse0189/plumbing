import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';

/**
 * Azure redirect URI is /teams-test. MSAL v5 popups and silent iframes need this
 * page to run the redirect bridge and stay put — do not boot the app or strip
 * the hash here, or sign-in fails with timed_out.
 */
function fallbackAppUrl() {
  try {
    const desktop =
      sessionStorage.getItem('njplumbing.shell') === 'desktop' ||
      /Electron/i.test(navigator.userAgent) ||
      window.matchMedia('(display-mode: standalone)').matches;
    return desktop ? '/?view=teams&shell=desktop' : '/?view=teams';
  } catch {
    return '/?view=teams';
  }
}

function isNestedWindow() {
  try {
    return Boolean(window.opener) || window.parent !== window;
  } catch {
    return true;
  }
}

void (async () => {
  try {
    await broadcastResponseToMainFrame();
  } catch {
    if (!isNestedWindow()) {
      window.location.replace(fallbackAppUrl());
    }
  }
})();
