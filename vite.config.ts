import { readFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
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
      const path = incoming.pathname.replace(/\/$/, '') || '/';
      if (path !== '/auth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(302, {
        Location: `${viteOrigin}/auth/callback${incoming.search}`,
      });
      res.end();
    };

    const tryListen = (port: number) => {
      if (port > 8219) {
        console.warn('Plaud sign-in could not bind a local callback port (8199–8219).');
        return;
      }
      const server = createServer(handle);
      server.once('error', (error: NodeJS.ErrnoException) => {
        server.close();
        if (error.code === 'EADDRINUSE') {
          tryListen(port + 1);
          return;
        }
        console.warn('Plaud sign-in callback listener failed:', error.message);
      });
      server.listen(port, '0.0.0.0', () => {
        listener = server;
        redirectUri = `http://localhost:${port}/auth/callback`;
        console.log(`Plaud sign-in callback: ${redirectUri} → ${viteOrigin}/auth/callback`);
      });
    };
    tryListen(8199);
  };

  const attach = (server: ViteDevServer) => {
    const address = server.httpServer?.address();
    const vitePort =
      typeof address === 'object' && address ? address.port : 5173;
    startListener(`http://localhost:${vitePort}`);
  };

  return {
    name: 'plaud-loopback-callback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0];
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), plaudLoopbackCallbackPlugin()],
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
