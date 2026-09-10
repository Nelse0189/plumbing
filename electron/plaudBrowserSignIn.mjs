import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLAUD_URL = 'https://web.plaud.ai/';
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
const PROFILE_DIR = path.join(os.tmpdir(), 'njplumbing-plaud-profile');
const DEBUG_PORT_START = 9333;
const SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;

const browserCandidates = [
  process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

let inFlight = null;

function jwtFrom(value) {
  const match = String(value || '').match(JWT_RE);
  return match ? match[0] : '';
}

export function findPlaudBrowser() {
  return browserCandidates.find((candidate) => fs.existsSync(candidate)) || '';
}

export function plaudBrowserAvailable() {
  return Boolean(findPlaudBrowser());
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function findFreePort(start) {
  for (let port = start; port < start + 20; port += 1) {
    if (!(await isPortOpen(port))) return port;
    if (await jsonVersion(port)) return port;
  }
  return start;
}

async function jsonGet(port, pathname) {
  const url = `http://127.0.0.1:${port}${pathname}`;
  const methods = pathname.startsWith('/json/new') ? ['PUT', 'GET'] : ['GET'];
  for (const method of methods) {
    const response = await fetch(url, { method }).catch(() => null);
    if (!response?.ok) continue;
    const type = response.headers.get('content-type') || '';
    if (type.includes('json')) return response.json().catch(() => null);
    return response.text().catch(() => null);
  }
  return null;
}

async function jsonVersion(port) {
  return jsonGet(port, '/json/version');
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out inspecting the Plaud window.')), 8000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not inspect the Plaud window.'));
      });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'Plaud window inspect failed.'));
        else resolve(msg.result || {});
        return;
      }
      if (msg.method && this.listeners.has(msg.method)) {
        for (const fn of this.listeners.get(msg.method)) fn(msg.params || {});
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const list = this.listeners.get(method) || [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
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

function isWebSessionToken(token) {
  const typ = jwtTyp(token);
  return typ === 'WT' || typ === 'UT';
}

function cookieHeaderFromList(cookies) {
  return (cookies || [])
    .filter((cookie) => String(cookie.domain || '').includes('plaud.ai'))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function tokenFromCookieList(cookies) {
  const header = cookieHeaderFromList(cookies);
  if (/pld_wt=|pld_ut=/i.test(header)) return header;
  const byName = new Map();
  for (const cookie of cookies || []) {
    byName.set(String(cookie.name || '').toLowerCase(), cookie.value || '');
  }
  for (const name of PREFERRED_COOKIE_NAMES) {
    const found = jwtFrom(byName.get(name) || '');
    if (found && isWebSessionToken(found)) return found;
  }
  for (const cookie of cookies || []) {
    const found = jwtFrom(cookie.value);
    if (found && isWebSessionToken(found)) return found;
  }
  return header || '';
}

const PAGE_TOKEN_SCRIPT = `(() => {
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
  return /pld_wt=|pld_ut=/i.test(document.cookie || '')
    ? document.cookie
    : (jwt(document.cookie) || fromStore(localStorage) || fromStore(sessionStorage));
})()`;

function pickJwt(value) {
  const text = String(value || '');
  const pairs = new Map();
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    pairs.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  for (const name of PREFERRED_COOKIE_NAMES) {
    const found = jwtFrom(pairs.get(name) || '');
    if (found && isWebSessionToken(found)) return found;
  }
  const all = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
  return all.find((token) => isWebSessionToken(token)) || '';
}

export async function probePlaud(tokenOrCookie) {
  const jwt = pickJwt(tokenOrCookie);
  if (!jwt) return '';
  const cookie = /pld_wt=|pld_ut=/i.test(tokenOrCookie)
    ? tokenOrCookie
    : jwtTyp(jwt) === 'WT'
      ? `pld_wt=${jwt}`
      : jwtTyp(jwt) === 'UT'
        ? `pld_ut=${jwt}`
        : '';
  const bases = ['https://api.plaud.ai', 'https://api-eu.plaud.ai', 'https://api-euc1.plaud.ai'];
  const seen = new Set();
  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    if (seen.has(base)) continue;
    seen.add(base);
    const response = await fetch(
      `${base}/file/simple/web?skip=0&limit=5&is_trash=0&sort_by=start_time&is_desc=true`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/json',
          'app-platform': 'web',
          'edit-from': 'web',
          Origin: 'https://web.plaud.ai',
          Referer: 'https://web.plaud.ai/',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      }
    ).catch(() => null);
    if (!response) continue;
    const payload = await response.json().catch(() => ({}));
    const redirect = payload?.data?.domains?.api || payload?.data?.api;
    if (payload?.status === -302 && typeof redirect === 'string' && redirect.startsWith('https://')) {
      bases.push(redirect.replace(/\/$/, ''));
      continue;
    }
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const total = Number(payload?.data_file_total ?? data?.data_file_total ?? 0);
    const files = data?.data_file_list || payload?.data_file_list || [];
    if (response.ok && (total > 0 || (Array.isArray(files) && files.length > 0))) {
      const used = jwtTyp(jwt) === 'WT' ? jwt : pickJwt(cookie) || jwt;
      return jwtTyp(used) === 'WT' ? `pld_wt=${used}` : cookie || jwt;
    }
    if (jwtTyp(jwt) !== 'UT') continue;
    const listed = await fetch(`${base}/team-app/workspaces/list?need_personal_workspace=true`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
        'app-platform': 'web',
        Origin: 'https://web.plaud.ai',
        Referer: 'https://web.plaud.ai/',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }).catch(() => null);
    const listedPayload = listed ? await listed.json().catch(() => ({})) : {};
    const workspaces = listedPayload?.data?.workspaces || [];
    const workspaceId = String(workspaces[0]?.workspace_id || workspaces[0]?.id || '');
    if (!listed?.ok || !workspaceId) continue;
    const minted = await fetch(
      `${base}/user-app/auth/workspace/token/${encodeURIComponent(workspaceId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'app-platform': 'web',
          Origin: 'https://web.plaud.ai',
          Referer: 'https://web.plaud.ai/',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: '{}',
      }
    ).catch(() => null);
    const mintedPayload = minted ? await minted.json().catch(() => ({})) : {};
    const workspaceToken =
      mintedPayload?.data?.workspace_token ||
      mintedPayload?.data?.workspaceToken ||
      mintedPayload?.data?.token ||
      '';
    if (!workspaceToken) continue;
    const mintedCookie = `pld_wt=${workspaceToken}`;
    const verified = await probePlaud(mintedCookie);
    if (verified) return verified;
  }
  return '';
}

async function liveSessionFromBrowser(port) {
  const captured = (await captureFromBrowser(port)) || (await captureFromPages(port));
  if (!captured) return '';
  return probePlaud(captured);
}

function headerToken(headers, url = '') {
  if (url && !/api(?:-eu)?\.plaud\.ai/i.test(url)) return '';
  if (!headers) return '';
  const auth =
    headers.Authorization ||
    headers.authorization ||
    headers['Authorization'] ||
    headers['authorization'] ||
    '';
  return jwtFrom(String(auth).replace(/^(bearer|wt|ut|wrt)\s+/i, ''));
}

async function captureFromBrowser(port) {
  const version = await jsonVersion(port);
  if (!version?.webSocketDebuggerUrl) return '';
  const browser = new Cdp(version.webSocketDebuggerUrl);
  await browser.open();
  try {
    let cookies = [];
    try {
      const stored = await browser.send('Storage.getCookies', {});
      cookies = stored.cookies || [];
    } catch {
      try {
        await browser.send('Network.enable', {});
        const all = await browser.send('Network.getAllCookies', {});
        cookies = all.cookies || [];
      } catch {
        cookies = [];
      }
    }
    return tokenFromCookieList(
      cookies.filter((cookie) => String(cookie.domain || '').includes('plaud.ai'))
    );
  } finally {
    browser.close();
  }
}

async function captureFromPages(port) {
  const targets = (await jsonGet(port, '/json/list')) || [];
  const pages = (Array.isArray(targets) ? targets : []).filter(
    (target) =>
      target.webSocketDebuggerUrl &&
      /plaud\.ai/i.test(String(target.url || '')) &&
      (target.type === 'page' || target.type === 'webview' || !target.type)
  );
  for (const page of pages) {
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    try {
      await cdp.open();
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: PAGE_TOKEN_SCRIPT,
        returnByValue: true,
      });
      const value = String(evaluated?.result?.value || '');
      cdp.close();
      if (value && (/pld_wt=|pld_ut=/i.test(value) || isWebSessionToken(value))) return value;
    } catch {
      cdp.close();
    }
  }
  return '';
}

async function watchNetworkForToken(port, onToken) {
  const targets = (await jsonGet(port, '/json/list')) || [];
  const pages = (Array.isArray(targets) ? targets : []).filter(
    (target) => target.webSocketDebuggerUrl && (target.type === 'page' || target.type === 'webview' || !target.type)
  );
  const sessions = [];
  for (const page of pages) {
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    try {
      await cdp.open();
      const take = (params) => {
        const url = String(params.request?.url || params.url || '');
        const headers = params.request?.headers || params.headers || {};
        const cookie = headers.Cookie || headers.cookie || '';
        const token = headerToken(headers, url) || jwtFrom(cookie);
        if (/api(?:-eu)?\.plaud\.ai/i.test(url) && (/pld_wt=|pld_ut=/i.test(cookie) || (token && isWebSessionToken(token)))) {
          onToken(cookie || token);
        }
      };
      cdp.on('Network.requestWillBeSent', take);
      cdp.on('Network.requestWillBeSentExtraInfo', take);
      await cdp.send('Network.enable', {});
      sessions.push(cdp);
    } catch {
      cdp.close();
    }
  }
  return () => {
    for (const session of sessions) session.close();
  };
}

async function openPlaudTab(port) {
  const opened =
    (await jsonGet(port, `/json/new?${PLAUD_URL}`)) ||
    (await jsonGet(port, `/json/new?${encodeURIComponent(PLAUD_URL)}`));
  if (opened) return;
  const targets = (await jsonGet(port, '/json/list')) || [];
  const hasPlaud = (Array.isArray(targets) ? targets : []).some((target) =>
    /plaud\.ai/i.test(String(target.url || ''))
  );
  if (hasPlaud) return;
  throw new Error('Could not open the Plaud sign-in window.');
}

function spawnPlaudBrowser(browser, port, profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    browser,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      PLAUD_URL,
    ],
    {
      stdio: 'ignore',
      windowsHide: false,
      detached: false,
    }
  );
  child.unref?.();
  return child;
}

async function waitForDebugger(port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const version = await jsonVersion(port);
    if (version?.webSocketDebuggerUrl) return version;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The Plaud window opened, but this app could not read the login from it.');
}

async function signInOnce() {
  const browser = findPlaudBrowser();
  if (!browser) {
    return {
      error:
        'Edge or Chrome is required for Plaud sign-in on this PC. Install Microsoft Edge, then try again.',
    };
  }

  const port = await findFreePort(DEBUG_PORT_START);
  const existing = await jsonVersion(port);
  let child = null;
  const profileDir = existing ? PROFILE_DIR : PROFILE_DIR;
  if (!existing) {
    child = spawnPlaudBrowser(browser, port, profileDir);
  } else {
    try {
      await openPlaudTab(port);
    } catch {
      child = spawnPlaudBrowser(browser, port, `${PROFILE_DIR}-${Date.now()}`);
    }
  }

  try {
    await waitForDebugger(port);
  } catch (error) {
    child?.kill();
    return { error: error instanceof Error ? error.message : String(error) };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let stopNetwork = () => {};
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      stopNetwork();
      resolve(result);
    };

    const timer = setInterval(() => {
      void (async () => {
        try {
          const token = await liveSessionFromBrowser(port);
          if (token) finish({ token });
        } catch {
          /* keep polling */
        }
      })();
    }, 2000);

    void watchNetworkForToken(port, (token) => {
      void probePlaud(token).then((verified) => {
        if (verified) finish({ token: verified });
      });
    }).then((stop) => {
      stopNetwork = stop;
    });

    if (child) {
      child.on('exit', () => {
        void jsonVersion(port).then((alive) => {
          if (!alive) finish({ cancelled: true });
        });
      });
    }

    const timeout = setTimeout(() => {
      finish({
        error:
          'Plaud sign-in timed out. In the Plaud window, stay on web.plaud.ai until your recordings list is visible, then try again.',
      });
    }, SIGNIN_TIMEOUT_MS);
  });
}

export function signInWithPlaudBrowser() {
  if (inFlight) return inFlight;
  inFlight = signInOnce().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
