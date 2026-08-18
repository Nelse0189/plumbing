#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env.local ]]; then
  echo ".env.local already exists at $ROOT/.env.local"
  exit 0
fi

if [[ -f functions/.env.nj-plumbing ]]; then
  MAPS="$(grep -E '^GOOGLE_MAPS_API_KEY=' functions/.env.nj-plumbing | cut -d= -f2- || true)"
  cp .env.local.example .env.local
  if [[ -n "${MAPS}" ]]; then
    echo "VITE_GOOGLE_MAPS_API_KEY=${MAPS}" >> .env.local
    echo "Created .env.local with Maps key copied from functions/.env.nj-plumbing"
  else
    echo "Created .env.local — add VITE_GOOGLE_MAPS_API_KEY or GOOGLE_MAPS_API_KEY in functions/.env.nj-plumbing"
  fi
  exit 0
fi

cp .env.local.example .env.local
echo "Created .env.local from example. Add your Maps key, or create functions/.env.nj-plumbing first."
