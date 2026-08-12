# watch_bot.ps1 - Tail the compact operator view (botloop-view.log) live.
# Resolves the repo root from this script's own location. If the bot was never
# started, prints a one-line instruction and exits nonzero. Closing this watcher
# terminal has no effect on the hidden bot process.
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\watch_bot.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'botloop-view.log'
if (-not (Test-Path $log)) {
    Write-Host 'botloop-view.log not found. Start the bot first: powershell -ExecutionPolicy Bypass -File .\start_bot.ps1'
    exit 1
}
Get-Content -Path $log -Tail 80 -Wait
