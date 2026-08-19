$ErrorActionPreference = "Stop"
node (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "setup-local-env.mjs")
