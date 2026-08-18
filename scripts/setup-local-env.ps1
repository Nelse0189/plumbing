# Creates .env.local and functions/.env.nj-plumbing from examples (Windows).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$localExample = Join-Path $Root ".env.local.example"
$localTarget = Join-Path $Root ".env.local"
$fnExample = Join-Path $Root "functions\.env.example"
$fnTarget = Join-Path $Root "functions\.env.nj-plumbing"

if (-not (Test-Path $localExample)) {
  Write-Error "Missing $localExample — run: git checkout cursor/restore-maps-key-185f && git pull"
}
if (-not (Test-Path $fnExample)) {
  Write-Error "Missing $fnExample — run: git checkout cursor/restore-maps-key-185f && git pull"
}

if (-not (Test-Path $localTarget)) {
  Copy-Item $localExample $localTarget
  Write-Host "Created .env.local"
} else {
  Write-Host ".env.local already exists — left unchanged"
}

if (-not (Test-Path $fnTarget)) {
  Copy-Item $fnExample $fnTarget
  Write-Host "Created functions\.env.nj-plumbing"
} else {
  Write-Host "functions\.env.nj-plumbing already exists — left unchanged"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. notepad functions\.env.nj-plumbing   (paste real API keys)"
Write-Host "  2. notepad .env.local                    (Maps key if not in functions file)"
Write-Host "  3. npm install && npm run dev"
