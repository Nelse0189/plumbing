import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 5173;
const BIND_HOST = '0.0.0.0';
const APP_URL = `http://localhost:${PORT}`;

function waitForPort(port, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for ${APP_URL}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    shell: true,
    windowsHide: false,
  });
  child.on('exit', (code) => {
    if (code) process.exitCode = code ?? 1;
  });
  return child;
}

const vite = run('npx.cmd', [
  'vite',
  '--host',
  BIND_HOST,
  '--port',
  String(PORT),
  '--strictPort',
]);
console.log(`Starting NJ Plumbing desktop at ${APP_URL}…`);

try {
  await waitForPort(PORT);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  vite.kill();
  process.exit(1);
}

console.log('Opening the NJ Plumbing window…');
const electron = run('npx.cmd', ['electron', 'electron/main.mjs'], {
  ELECTRON_START_URL: APP_URL,
});

const shutdown = () => {
  electron.kill();
  vite.kill();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

electron.on('exit', () => {
  vite.kill();
  process.exit();
});
