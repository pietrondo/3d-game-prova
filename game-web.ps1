# game-web.ps1 — idempotent launcher for the built game's static server.
#
# The pattern is the forum's (forum-web-serve.ps1), and it exists for the same
# two reasons found the hard way there:
#
#   1. A server started inside an agent's shell is a CHILD of that shell and dies
#      with it. A link posted anywhere then stops working with no error anywhere.
#      Start-Process launches it DETACHED so it outlives whoever started it.
#   2. Starting it twice leaves a window with no listener, or fails on a port that
#      a previous run still holds. The listener is checked FIRST and the launcher
#      says "already up" instead of starting a second one.
#
# Usage:
#   .\game-web.ps1            # start if needed, print the URL
#   .\game-web.ps1 -Open      # start if needed and open the browser

[CmdletBinding()]
param(
    [int]$Port = 5180,
    [switch]$Open,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$log = Join-Path $root 'game-web.log'
$url = "http://127.0.0.1:$Port/"

function Test-Listening([int]$p) {
    return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

if ($Stop) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { Write-Host "nessun server sulla porta $Port"; exit 0 }
    Stop-Process -Id $conn[0].OwningProcess -Force
    Write-Host "server sulla porta $Port fermato"
    exit 0
}

if (Test-Listening $Port) {
    Write-Host "gia' attivo: $url"
    if ($Open) { Start-Process $url }
    exit 0
}

if (-not (Test-Path (Join-Path $root 'dist\index.html'))) {
    Write-Host "dist/ manca o e' vuota: eseguo npm run build"
    Push-Location $root
    try { npm run build | Out-Null } finally { Pop-Location }
    if (-not (Test-Path (Join-Path $root 'dist\index.html'))) {
        throw "la build non ha prodotto dist/index.html"
    }
}

# Detached, with the console redirected to a log: Start-Process owns the process,
# so it survives this shell and anything that started it.
Start-Process -FilePath 'python' `
    -ArgumentList @((Join-Path $root 'serve.py'), '--port', $Port) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError (Join-Path $root 'game-web.err.log')

# Wait for the listener rather than sleeping a fixed amount: a blind sleep is
# either too short (the link 404s) or a lie about how long startup takes.
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and -not (Test-Listening $Port)) { Start-Sleep -Milliseconds 200 }

if (Test-Listening $Port) {
    Write-Host "avviato: $url"
    if ($Open) { Start-Process $url }
} else {
    Write-Host "non si e' avviato; log in $log"
    if (Test-Path $log) { Get-Content $log -Tail 10 }
    exit 1
}
