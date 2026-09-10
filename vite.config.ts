import { readFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function resolveGoogleMapsBuildKey(rootDir: string): string {
  const merged: Record<string, string> = {};
  for (const relative of [
    'functions/.env.nj-plumbing',
    'functions/.env',
    '.env.local',
    '.env.production.local',
    '.env',
  ]) {
    const file = resolve(rootDir, relative);
    if (!existsSync(file)) continue;
    Object.assign(merged, parseDotEnv(readFileSync(file, 'utf8')));
  }
  return (
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    merged.VITE_GOOGLE_MAPS_API_KEY ||
    merged.GOOGLE_MAPS_API_KEY ||
    ''
  ).trim();
}

const mapsApiKey = resolveGoogleMapsBuildKey(process.cwd());

function isSharePointUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.endsWith('sharepoint.com') || host.endsWith('onedrive.live.com');
  } catch {
    return false;
  }
}

function sharingUrlWithDownload(sharingUrl: string): string {
  const url = new URL(sharingUrl);
  url.searchParams.set('download', '1');
  return url.toString();
}

function sharingCandidates(sharingUrl: string): string[] {
  return [...new Set([sharingUrlWithDownload(sharingUrl), sharingUrl])];
}

function isSharePointDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host.endsWith('sharepoint.com') ||
    host.endsWith('onedrive.live.com') ||
    host.endsWith('1drv.ms')
  );
}

function looksLikeWorkbook(data: Buffer, contentType: string): boolean {
  if (data.length > 4 && data.subarray(0, 2).toString() === 'PK') return true;
  const type = contentType.toLowerCase();
  return (
    type.includes('spreadsheet') ||
    type.includes('excel') ||
    type.includes('csv') ||
    type.includes('octet-stream')
  );
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*',
};

function createCookieJar() {
  const cookies = new Map<string, { value: string; domain: string }>();
  return {
    header(url: string) {
      const host = new URL(url).hostname.toLowerCase();
      const parts: string[] = [];
      for (const [name, rec] of cookies) {
        if (!host.endsWith(rec.domain.replace(/^\./, '').toLowerCase())) continue;
        parts.push(`${name}=${rec.value}`);
      }
      return parts.join('; ');
    },
    store(response: Response, url: string) {
      const host = new URL(url).hostname;
      const list =
        typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const raw of list) {
        const [pair, ...attrs] = raw.split(';');
        const eq = pair.indexOf('=');
        if (eq < 1) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        let domain = host;
        for (const attr of attrs) {
          const [key, attrValue] = attr.split('=');
          if (key.trim().toLowerCase() === 'domain' && attrValue) {
            domain = attrValue.trim().replace(/^\./, '');
          }
        }
        cookies.set(name, { value, domain });
      }
    },
  };
}

function fileNameFromResponse(response: Response, fallback = 'invoice.xlsx'): string {
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = disposition.match(/filename\*=utf-8''([^;]+)/i);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }
  const quoted = disposition.match(/filename="?([^";]+)"?/i);
  if (quoted?.[1]) return quoted[1];
  try {
    const base = decodeURIComponent(new URL(response.url).pathname).split('/').pop() || '';
    if (/\.(xlsx|xls|csv)$/i.test(base)) return base;
  } catch {
    // Keep the fallback name.
  }
  return fallback;
}

async function fetchKeepingSharePointCookies(url: string): Promise<Response> {
  const jar = createCookieJar();
  let current = url;
  for (let hop = 0; hop < 12; hop++) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        ...BROWSER_HEADERS,
        Cookie: jar.header(current),
      },
    });
    jar.store(response, current);
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get('location');
    await response.arrayBuffer();
    if (!location) return response;
    const next = new URL(location, current);
    if (!isSharePointDownloadHost(next.hostname)) {
      throw new Error('SharePoint sent a Microsoft sign-in page instead of the Excel file.');
    }
    current = next.toString();
  }
  throw new Error('SharePoint redirect loop while downloading the workbook.');
}

async function downloadAnonymousWorkbook(sharingUrl: string): Promise<{
  data: Buffer;
  fileName: string;
  contentType: string;
}> {
  let lastStatus = 0;
  let lastDetail = '';
  for (const url of sharingCandidates(sharingUrl)) {
    try {
      const response = await fetchKeepingSharePointCookies(url);
      lastStatus = response.status;
      if (!response.ok) {
        lastDetail = await response.text().catch(() => '');
        continue;
      }
      const data = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || '';
      if (!looksLikeWorkbook(data, contentType)) {
        lastDetail = 'SharePoint returned a web page instead of the Excel file.';
        continue;
      }
      return { data, fileName: fileNameFromResponse(response), contentType };
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(
    lastStatus
      ? `SharePoint returned ${lastStatus}${lastDetail ? `: ${lastDetail.slice(0, 180)}` : ''}`
      : lastDetail || 'Could not download the workbook'
  );
}

function sharePointWorkbookProxyPlugin(): Plugin {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const incoming = new URL(req.url || '/', 'http://localhost');
    if (incoming.pathname !== '/__bills_workbook') return false;
    const sharingUrl = incoming.searchParams.get('url') || '';
    if (!isSharePointUrl(sharingUrl)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('A SharePoint or OneDrive link is required.');
      return true;
    }
    try {
      const workbook = await downloadAnonymousWorkbook(sharingUrl);
      res.writeHead(200, {
        'Content-Type':
          workbook.contentType ||
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'x-workbook-name': workbook.fileName,
      });
      res.end(workbook.data);
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'SharePoint download failed');
    }
    return true;
  };

  return {
    name: 'sharepoint-workbook-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (await handle(req, res)) return;
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (await handle(req, res)) return;
        next();
      });
    },
  };
}

/**
 * Plaud's public OAuth client only accepts a loopback redirect, same as
 * `plaud login` / MCP (`http://localhost:<port>/auth/callback`).
 */
function plaudLoopbackCallbackPlugin(): Plugin {
  let listener: Server | undefined;
  let redirectUri = '';
  let viteOrigin = 'http://localhost:5173';
  let started = false;

  const startListener = (origin: string) => {
    if (started) return;
    started = true;
    viteOrigin = origin;

    const handle = (req: IncomingMessage, res: ServerResponse) => {
      const incoming = new URL(req.url || '/', 'http://localhost');
      const path = incoming.pathname.replace(/\/+$/, '') || '/';
      const hasOAuth =
        incoming.searchParams.has('code') ||
        incoming.searchParams.has('error') ||
        incoming.searchParams.has('state');
      const isCallback =
        path === '/auth/callback' ||
        path === '/plaud/callback' ||
        path === '/gmail/callback' ||
        path.endsWith('/auth/callback') ||
        (hasOAuth && (path === '/' || path === '/callback'));
      if (!isCallback) {
        console.warn(`Plaud callback 404: ${req.url}`);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(
          'Plaud sign-in return was not recognized. Close this window and click Sign in with Plaud again.'
        );
        return;
      }
      const next = new URL(viteOrigin);
      incoming.searchParams.forEach((value, key) => {
        next.searchParams.set(key, value);
      });
      if (path === '/gmail/callback') {
        next.searchParams.set('view', 'emails');
        next.searchParams.set('gmail', '1');
      } else {
        next.searchParams.set('view', 'calls');
      }
      res.writeHead(302, {
        Location: next.toString(),
      });
      res.end();
    };

    const tryListen = (port: number) => {
      const server = createServer(handle);
      server.once('error', (error: NodeJS.ErrnoException) => {
        server.close();
        if (error.code === 'EADDRINUSE') {
          console.warn(
            `Plaud OAuth callback port ${port} is in use. Sign in with Plaud will open a Plaud window instead.`
          );
          return;
        }
        console.warn('Plaud sign-in callback listener failed:', error.message);
      });
      server.listen(port, '127.0.0.1', () => {
        listener = server;
        redirectUri = `http://localhost:${port}/auth/callback`;
        console.log(`Plaud sign-in callback: ${redirectUri} → ${viteOrigin}/?view=calls`);
      });
    };
    tryListen(8199);
  };

  const attach = (server: ViteDevServer | PreviewServer) => {
    const address = server.httpServer?.address();
    const vitePort =
      typeof address === 'object' && address ? address.port : 5173;
    startListener(`http://localhost:${vitePort}`);
    server.httpServer?.once('close', () => {
      listener?.close();
      listener = undefined;
      started = false;
      redirectUri = '';
    });
  };

  return {
    name: 'plaud-loopback-callback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const incoming = new URL(req.url || '/', 'http://localhost');
        const path = incoming.pathname.replace(/\/+$/, '') || '/';
        if (path === '/auth/callback' || path === '/plaud/callback' || path === '/gmail/callback') {
          const destination = new URL(viteOrigin);
          incoming.searchParams.forEach((value, key) => {
            destination.searchParams.set(key, value);
          });
          if (path === '/gmail/callback') {
            destination.searchParams.set('view', 'emails');
            destination.searchParams.set('gmail', '1');
          } else {
            destination.searchParams.set('view', 'calls');
          }
          res.writeHead(302, { Location: destination.toString() });
          res.end();
          return;
        }
        if (path !== '/__plaud_oauth.json') {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ redirectUri, origin: viteOrigin }));
      });
      return () => attach(server);
    },
    configurePreviewServer(server) {
      return () => attach(server);
    },
  };
}

function plaudBrowserSignInPlugin(): Plugin {
  const helperUrl = pathToFileURL(resolve(process.cwd(), 'electron/plaudBrowserSignIn.mjs')).href;

  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      const path = (req.url || '').split('?')[0];
      if (path !== '/__plaud_desktop.json' && path !== '/__plaud_signin') {
        next();
        return;
      }
      void (async () => {
        const helper = await import(`${helperUrl}?t=${Date.now()}`);
        res.setHeader('Content-Type', 'application/json');
        if (path === '/__plaud_desktop.json') {
          res.end(JSON.stringify({ available: helper.plaudBrowserAvailable() }));
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'POST required' }));
          return;
        }
        const result = await helper.signInWithPlaudBrowser();
        res.end(JSON.stringify(result));
      })().catch((error) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Plaud sign-in failed.',
          })
        );
      });
    });
  };

  return {
    name: 'plaud-browser-signin',
    configureServer(server) {
      attach(server);
    },
    configurePreviewServer(server) {
      attach(server);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), plaudBrowserSignInPlugin(), plaudLoopbackCallbackPlugin(), sharePointWorkbookProxyPlugin()],
  server: {
    allowedHosts: ['.trycloudflare.com'],
  },
  define: mapsApiKey
    ? {
        'import.meta.env.VITE_GOOGLE_MAPS_API_KEY': JSON.stringify(mapsApiKey),
      }
    : {},
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        teamsTest: resolve(__dirname, 'teams-test.html'),
      },
    },
  },
});
