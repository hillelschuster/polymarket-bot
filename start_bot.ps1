# start_bot.ps1 - Launch the bot loop DETACHED (hidden, background).
# Starts the existing run_loop.bat chain as a new hidden Windows process so that
# closing this launcher terminal, or the watcher, does NOT stop the bot. The bot
# mirrors its compact console to botloop-view.log at the repo root; tail it live
# with scripts\watch_bot.ps1.
# Usage: powershell -ExecutionPolicy Bypass -File .\start_bot.ps1
$ErrorActionPreference = 'Stop'
$bat = Join-Path $PSScriptRoot 'run_loop.bat'
Start-Process -FilePath $bat -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Write-Host "Bot started detached. View it live: powershell -ExecutionPolicy Bypass -File .\scripts\watch_bot.ps1 (tails botloop-view.log)"
