import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probePlaud } from './plaudBrowserSignIn.mjs';
import { listPlaudLibrary } from './plaudLibrary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.ELECTRON_START_URL || 'http://localhost:5173';
const PLAUD_URL = 'https://web.plaud.ai/';
const TRANSIENT_LOAD_ERRORS = new Set([
  'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_FAILED',
  'ERR_EMPTY_RESPONSE',
]);

// Windows often flaps adapters (VPN, Wi-Fi, Hyper-V) while Chromium starts.
// Pin localhost to IPv4 so the first load does not bounce between ::1 and 127.0.0.1.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP localhost 127.0.0.1');

function isTransientLoadError(error) {
  const code = String(error?.code || error?.message || '');
  for (const name of TRANSIENT_LOAD_ERRORS) {
    if (code.includes(name)) return true;
  }
  return false;
}

async function loadAppUrl(win, url, attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (win.isDestroyed()) return;
    try {
      await win.loadURL(url);
      return;
    } catch (error) {
      const last = attempt === attempts;
      if (!isTransientLoadError(error) || last) {
        console.error('Failed to load NJ Plumbing:', error);
        return;
      }
      const waitMs = Math.min(250 * 2 ** (attempt - 1), 2000);
      console.warn(
        `Retrying window load (${attempt}/${attempts}) after ${error.code || error.message}…`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
const PLAUD_PARTITION = 'persist:plaud';
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const PREFERRED_COOKIE_NAMES = [
  'pld_wt',
  'pld-wt',
  'pld_ut',
  'pld-ut',
  'pld_token',
  'tokenstr',
  'token',
];

function jwtFrom(value) {
  const match = String(value || '').match(JWT_RE);
  return match ? match[0] : '';
}

async function tokenFromCookies(ses) {
  const cookies = [
    ...(await ses.cookies.get({ domain: 'plaud.ai' })),
    ...(await ses.cookies.get({ domain: '.plaud.ai' })),
    ...(await ses.cookies.get({ url: 'https://web.plaud.ai' })),
    ...(await ses.cookies.get({ url: 'https://api.plaud.ai' })),
  ];
  const byName = new Map();
  for (const cookie of cookies) {
    byName.set(String(cookie.name || '').toLowerCase(), cookie.value || '');
  }
  for (const name of PREFERRED_COOKIE_NAMES) {
    const found = jwtFrom(byName.get(name) || '');
    if (found) return found;
  }
  for (const cookie of cookies) {
    const found = jwtFrom(cookie.value);
    if (found) return found;
  }
  return '';
}

async function tokenFromPage(win) {
  if (!win || win.isDestroyed()) return '';
  try {
    return await win.webContents.executeJavaScript(`(() => {
      const jwt = (value) => {
        const match = String(value || '').match(/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/);
        return match ? match[0] : '';
      };
      const fromStore = (store) => {
        try {
          for (let i = 0; i < store.length; i++) {
            const value = store.getItem(store.key(i) || '') || '';
            const found = jwt(value);
            if (found) return found;
            try {
              const parsed = JSON.parse(value);
              const list = Array.isArray(parsed) ? parsed : (parsed && (parsed.list || parsed.data || [parsed]));
              for (const item of list || []) {
                const nested = jwt(item?.workspaceToken || item?.access_token || item?.token || '');
                if (nested) return nested;
              }
            } catch {}
          }
        } catch {}
        return '';
      };
      return jwt(document.cookie) || fromStore(localStorage) || fromStore(sessionStorage);
    })()`);
  } catch {
    return '';
  }
}

async function capturePlaudToken(ses, win) {
  return (await tokenFromCookies(ses)) || (await tokenFromPage(win));
}

async function cookieHeaderFromSession(ses) {
  const lists = await Promise.all([
    ses.cookies.get({ domain: 'plaud.ai' }),
    ses.cookies.get({ domain: '.plaud.ai' }),
    ses.cookies.get({ url: 'https://web.plaud.ai' }),
    ses.cookies.get({ url: 'https://api.plaud.ai' }),
  ]);
  const seen = new Set();
  const parts = [];
  for (const list of lists) {
    for (const cookie of list) {
      const name = String(cookie.name || '');
      if (!name || seen.has(name)) continue;
      seen.add(name);
      parts.push(`${name}=${cookie.value || ''}`);
    }
  }
  return parts.join('; ');
}

async function verifiedPlaudToken(tokenOrCookie, ses) {
  const captured = String(tokenOrCookie || '').trim();
  if (ses) {
    const listed = await listPlaudLibrary(ses, { cookieHeader: captured, authorization: captured });
    if (listed.files.length && listed.token) return listed.token;
  }
  if (!captured) return '';
  try {
    const probed = (await probePlaud(captured)) || '';
    const jwt = jwtFrom(probed);
    return jwtTyp(jwt) === 'WT' ? `pld_wt=${jwt}` : probed;
  } catch (error) {
    console.warn('Plaud probe failed', error instanceof Error ? error.message : error);
    return '';
  }
}

function jwtTyp(token) {
  try {
    const part = String(token || '').split('.')[1] || '';
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
    return String(JSON.parse(Buffer.from(padded, 'base64').toString('utf8')).typ || '').toUpperCase();
  } catch {
    return '';
  }
}

function isMicrosoftLoginUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'login.microsoftonline.com' ||
      host === 'login.microsoft.com' ||
      host === 'login.live.com' ||
      host.endsWith('.login.microsoftonline.com')
    );
  } catch {
    return false;
  }
}

let mainWindow = null;

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1';
}

function isPlaudCallbackUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    const hasOAuth =
      parsed.searchParams.has('code') ||
      parsed.searchParams.has('error') ||
      parsed.searchParams.has('state');
    const callbackPath =
      path === '/auth/callback' ||
      path === '/plaud/callback' ||
      path === '/gmail/callback' ||
      path.endsWith('/auth/callback') ||
      path.endsWith('/plaud/callback');
    if (
      isLoopbackHost(parsed.hostname) &&
      (callbackPath || (parsed.port === '8199' && hasOAuth))
    ) {
      return true;
    }
    // Plaud sometimes stays on web.plaud.ai/auth/callback after login
    // instead of sending the browser to localhost:8199.
    if (
      hasOAuth &&
      callbackPath &&
      (parsed.hostname === 'plaud.ai' || parsed.hostname.endsWith('.plaud.ai'))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function appUrlFromPlaudCallback(url) {
  const incoming = new URL(url);
  const next = new URL(APP_URL.includes('?') ? APP_URL : `${APP_URL.replace(/\/$/, '')}/`);
  incoming.searchParams.forEach((value, key) => {
    next.searchParams.set(key, value);
  });
  const path = incoming.pathname.replace(/\/+$/, '') || '/';
  if (path === '/gmail/callback') {
    next.searchParams.set('view', 'emails');
    next.searchParams.set('gmail', '1');
  } else {
    next.searchParams.set('view', 'calls');
  }
  next.searchParams.set('shell', 'desktop');
  return next.toString();
}

function returnPlaudCallbackToApp(fromWin, url) {
  const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : fromWin;
  void loadAppUrl(target, appUrlFromPlaudCallback(url));
  target.show();
  target.focus();
  if (fromWin && fromWin !== target && !fromWin.isDestroyed()) {
    fromWin.close();
  }
}

function attachPlaudCallbackCapture(win) {
  const intercept = (event, url) => {
    if (!isPlaudCallbackUrl(url)) return;
    event.preventDefault();
    returnPlaudCallbackToApp(win, url);
  };
  const recover = (_event, url) => {
    if (!isPlaudCallbackUrl(url)) return;
    returnPlaudCallbackToApp(win, url);
  };
  win.webContents.on('will-navigate', intercept);
  win.webContents.on('will-redirect', intercept);
  win.webContents.on('did-navigate', recover);
  win.webContents.on('did-navigate-in-page', recover);
  win.webContents.on('did-frame-navigate', (event, url) => recover(event, url));
}

function isPlaudAuthPopupUrl(url) {
  if (url === 'about:blank' || isMicrosoftLoginUrl(url)) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'accounts.google.com' ||
      host.endsWith('.google.com') ||
      host === 'appleid.apple.com' ||
      host === 'plaud.ai' ||
      host.endsWith('.plaud.ai')
    );
  } catch {
    return false;
  }
}

function attachWindowOpenHandler(win, { allowPlaudAuth = false } = {}) {
  attachPlaudCallbackCapture(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPlaudCallbackUrl(url)) {
      returnPlaudCallbackToApp(win, url);
      return { action: 'deny' };
    }
    if (url === 'about:blank' || isMicrosoftLoginUrl(url) || (allowPlaudAuth && isPlaudAuthPopupUrl(url))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 740,
          title: allowPlaudAuth ? 'Sign in to Plaud' : 'Sign in to Microsoft',
          autoHideMenuBar: true,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            partition: allowPlaudAuth ? PLAUD_PARTITION : undefined,
          },
        },
      };
    }
    if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
      try {
        const path = new URL(url).pathname;
        if (path.startsWith('/teams-test')) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 520,
              height: 740,
              title: 'Sign in to Microsoft',
              autoHideMenuBar: true,
              webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
              },
            },
          };
        }
      } catch {
        // Fall through and load in the existing window.
      }
      win.loadURL(url).catch((error) => {
        console.error('Failed to load in existing window:', error);
      });
      return { action: 'deny' };
    }
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      return { action: 'deny' };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    attachWindowOpenHandler(child, { allowPlaudAuth });
  });
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'NJ Plumbing',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
    mainWindow = win;
    attachWindowOpenHandler(win, { allowPlaudAuth: true });
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone') {
        callback(true);
        return;
      }
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      return permission === 'media' || permission === 'audioCapture' || permission === 'microphone';
    });
    void loadAppUrl(win, APP_URL);
    console.log(`NJ Plumbing window opened at ${APP_URL}`);
}

function listenForPlaudAuthHeaders(ses, onToken) {
  const filter = { urls: ['https://*.plaud.ai/*', 'https://plaud.ai/*'] };
  const take = (details) => {
    const headers = details.requestHeaders || {};
    const auth = headers.Authorization || headers.authorization || '';
    const cookie = headers.Cookie || headers.cookie || '';
    const url = String(details.url || '');
    if (/file\/simple\/web/i.test(url) && (auth || cookie)) {
      onToken(auth || cookie, url);
      return;
    }
    const token =
      jwtFrom(String(auth).replace(/^(bearer|wt|ut|wrt)\s+/i, '')) || jwtFrom(cookie);
    if (token && jwtTyp(token) === 'WT') onToken(cookie || token, url);
  };
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    take(details);
    callback({ requestHeaders: details.requestHeaders });
  });
}

async function signInWithPlaud() {
  const ses = session.fromPartition(PLAUD_PARTITION);
  const existing = await verifiedPlaudToken(await cookieHeaderFromSession(ses), ses);
  if (existing) return { token: existing };

  const child = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Sign in to Plaud',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PLAUD_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  attachWindowOpenHandler(child, { allowPlaudAuth: true });
  child.loadURL(PLAUD_URL);

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (!child.isDestroyed()) child.close();
      resolve(result);
    };

    listenForPlaudAuthHeaders(ses, (token) => {
      void verifiedPlaudToken(token, ses).then((verified) => {
        if (verified) finish({ token: verified });
      });
    });

    const timer = setInterval(() => {
      void (async () => {
        const captured = await cookieHeaderFromSession(ses);
        const verified = await verifiedPlaudToken(captured, ses);
        if (verified) finish({ token: verified });
      })();
    }, 1500);

    child.on('closed', () => {
      finish({ cancelled: true });
    });

    setTimeout(() => {
      finish({
        error:
          'Plaud sign-in timed out. Stay on web.plaud.ai until your recordings are visible, then try again.',
      });
    }, 5 * 60 * 1000);
  });
}

function asNodeBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (Array.isArray(bytes)) return Buffer.from(bytes);
  if (bytes && bytes.type === 'Buffer' && Array.isArray(bytes.data)) {
    return Buffer.from(bytes.data);
  }
  throw new Error('Could not open the PDF.');
}

function safePdfFileName(fileName) {
  const base = String(fileName || 'work-order.pdf').replace(/[^\w.-]+/g, '_');
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

function findEdge() {
  const candidates = [
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function openPdfFile(filePath) {
  const edge = findEdge();
  if (edge) {
    const child = spawn(edge, [filePath], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return;
  }
  return shell.openPath(filePath).then((error) => {
    if (error) throw new Error(error);
  });
}

function openPrintHtml(filePath) {
  const edge = findEdge();
  const fileUrl = pathToFileURL(filePath).href;
  if (!edge) {
    throw new Error('Microsoft Edge is required to print work orders.');
  }
  const child = spawn(edge, ['--new-window', fileUrl], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

app.whenReady().then(() => {
  ipcMain.handle('desktop:open-pdf', async (_event, payload = {}) => {
    const fileName = safePdfFileName(payload.fileName);
    const buffer = payload.base64
      ? Buffer.from(String(payload.base64), 'base64')
      : asNodeBuffer(payload.bytes);
    if (!buffer.length) throw new Error('The PDF was empty.');
    const tmp = path.join(os.tmpdir(), `nj-plumbing-${Date.now()}-${fileName}`);
    await fs.writeFile(tmp, buffer);
    await openPdfFile(tmp);
  });
  ipcMain.handle('desktop:print-html', async (_event, payload = {}) => {
    const html = String(payload.html || '');
    if (!html.includes('<img')) throw new Error('Nothing to print.');
    const tmp = path.join(os.tmpdir(), `nj-plumbing-print-${Date.now()}.html`);
    await fs.writeFile(tmp, html, 'utf8');
    openPrintHtml(tmp);
  });
  ipcMain.handle('plaud:sign-in', () => signInWithPlaud());
  ipcMain.handle('plaud:list-library', async (_event, options = {}) => {
    const ses = session.fromPartition(PLAUD_PARTITION);
    const cookieHeader = await cookieHeaderFromSession(ses);
    try {
      const listed = await listPlaudLibrary(ses, {
        cookieHeader,
        date: options.date,
        allTime: options.allTime === true,
      });
      if (!listed.files.length) {
        return {
          files: [],
          token: '',
          error:
            'No recordings found from this Plaud login. Keep the recordings list visible in Plaud, then try Sync again.',
        };
      }
      return listed;
    } catch (error) {
      return {
        files: [],
        token: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
