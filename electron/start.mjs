import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 5173;
const BIND_HOST = '0.0.0.0';
const APP_URL = `http://localhost:${PORT}/?shell=desktop`;
const electronExe = require('electron');
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const browserCandidates = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function waitForPort(port, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
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

function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
  child.on('error', (error) => {
    console.error(`Failed to start ${command}:`, error.message);
  });
  return child;
}

function findBrowser() {
  return browserCandidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function spawnElectron() {
  return new Promise((resolve, reject) => {
    const child = spawn(electronExe, ['electron/main.mjs'], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_START_URL: APP_URL },
      stdio: 'inherit',
      shell: false,
      windowsHide: false,
    });
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

console.log(`Starting NJ Plumbing desktop at ${APP_URL}…`);

let vite = null;
if (await isPortOpen(PORT)) {
  console.log(`Vite is already running on ${PORT}; reusing it.`);
} else {
  vite = run(process.execPath, [
    viteBin,
    '--host',
    BIND_HOST,
    '--port',
    String(PORT),
    '--strictPort',
  ]);
}

try {
  await waitForPort(PORT);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  vite?.kill();
  process.exit(1);
}

console.log('Opening the NJ Plumbing window…');

let appProcess;
try {
  appProcess = await spawnElectron();
} catch (error) {
  const browser = findBrowser();
  console.warn(
    'Electron is blocked by Windows Smart App Control (spawn UNKNOWN).',
  );
  if (!browser) {
    console.error(
      `Open ${APP_URL} in your browser instead, or turn Smart App Control off in Windows Security → App & browser control.`,
    );
    vite?.kill();
    process.exit(1);
  }
  console.warn(`Opening Edge/Chrome app window instead: ${browser}`);
  appProcess = run(browser, [
    `--app=${APP_URL}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'njplumbing-desktop')}`,
  ]);
}

const shutdown = () => {
  appProcess?.kill();
  vite?.kill();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

appProcess.on('exit', () => {
  vite?.kill();
  process.exit();
});
