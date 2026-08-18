import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
