$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Cannot find Node.js. Please install Node.js 20 LTS or newer: https://nodejs.org"
    exit 1
}

& node (Join-Path $ScriptDir "install.js")
exit $LASTEXITCODE

