@echo off
title Polymarket Bot DB Compaction
rem Self-locating: works from any launch cwd.
cd /d "%~dp0"
rem Canonical DB (Windows view): C:\home\hillel\polymarket-bot-dev.db
set DATABASE_URL=file:C:/home/hillel/polymarket-bot-dev.db
set LOG=compact.log
echo ============================================ >> %LOG%
echo  Daily DB compaction (stale data only) >> %LOG%
echo  DB: %DATABASE_URL% >> %LOG%
echo ============================================ >> %LOG%

rem --- Stop the bot chain if it is running ---
for /f "usebackq delims=" %%S in (`powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\stop_bot.ps1"`) do set BOTSTATE=%%S
echo [%date% %time%] bot state: %BOTSTATE% >> %LOG%

rem --- Compact (logs to compact.log). "call" is required: npx is npx.cmd,
rem a batch file, and a batch invoked without "call" never returns control. ---
call npx tsx scripts\compactDb.ts >> %LOG% 2>&1
set EXITCODE=%errorlevel%
echo [%date% %time%] compaction exit code: %EXITCODE% >> %LOG%

rem --- Restart the bot only if it was running before ---
if "%BOTSTATE%"=="BOT_RUNNING=True" (
  echo [%date% %time%] restarting bot... >> %LOG%
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_bot.ps1"
) else (
  echo [%date% %time%] bot was not running; leaving it stopped >> %LOG%
)
echo [%date% %time%] compaction done >> %LOG%
