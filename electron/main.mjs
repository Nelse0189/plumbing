import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.ELECTRON_START_URL || 'http://localhost:5173';
const PLAUD_URL = 'https://web.plaud.ai/';
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
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    win.loadURL(APP_URL).catch((error) => {
      console.error('Failed to load NJ Plumbing:', error);
    });
    console.log(`NJ Plumbing window opened at ${APP_URL}`);
}

async function signInWithPlaud() {
  const ses = session.fromPartition(PLAUD_PARTITION);
  const existing = await capturePlaudToken(ses, null);
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

    const timer = setInterval(() => {
      void (async () => {
        const token = await capturePlaudToken(ses, child);
        if (token) finish({ token });
      })();
    }, 1500);

    child.on('closed', () => {
      finish({ cancelled: true });
    });

    setTimeout(() => {
      finish({ error: 'Plaud sign-in timed out. Sign in, then try again.' });
    }, 5 * 60 * 1000);
  });
}

app.whenReady().then(() => {
  ipcMain.handle('plaud:sign-in', () => signInWithPlaud());
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
