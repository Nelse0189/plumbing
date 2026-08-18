#!/usr/bin/env node
/**
 * Splits env.template into .env.local and functions/.env.nj-plumbing
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = resolve(root, 'env.template');

if (!existsSync(templatePath)) {
  console.error('Missing env.template at repo root.');
  process.exit(1);
}

const text = readFileSync(templatePath, 'utf8');
const lines = text.split('\n');

const frontend = [];
const functions = [];
let section = '';

for (const line of lines) {
  if (line.includes('FILE: .env.local')) {
    section = 'frontend';
    continue;
  }
  if (line.includes('FILE: functions/.env.nj-plumbing')) {
    section = 'functions';
    continue;
  }
  if (!section) continue;
  if (line.startsWith('# >>>') || line.startsWith('# <<')) continue;
  if (section === 'frontend') frontend.push(line);
  if (section === 'functions') functions.push(line);
}

const localPath = resolve(root, '.env.local');
const fnPath = resolve(root, 'functions', '.env.nj-plumbing');

const localBody = frontend.join('\n').trim() + '\n';
const fnBody =
  [
    '# Generated from env.template — edit placeholders, then redeploy functions as needed.',
    '',
    functions.join('\n').trim(),
    '',
  ].join('\n');

if (existsSync(localPath)) {
  console.log('.env.local already exists — left unchanged');
} else {
  writeFileSync(localPath, localBody, 'utf8');
  console.log('Created .env.local');
}

if (existsSync(fnPath)) {
  console.log('functions/.env.nj-plumbing already exists — left unchanged');
} else {
  writeFileSync(fnPath, fnBody, 'utf8');
  console.log('Created functions/.env.nj-plumbing');
}

console.log('');
console.log('Edit your keys:');
console.log('  notepad functions\\.env.nj-plumbing   (OPENAI_API_KEY, PLAUD, Twilio, …)');
console.log('  notepad .env.local                    (VITE_GOOGLE_MAPS_API_KEY, …)');
