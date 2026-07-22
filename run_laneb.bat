@echo off
setlocal
title Lane B - Resolution Lag Shadow Logger
cd /d "%~dp0"
echo ============================================
echo  Lane B: Resolution-Lag Shadow Logger
echo  Independent from main pipeline.
echo  Storage: data/laneb_shadow.json
echo  Started: %date% %time%
echo ============================================
echo.

:loop
echo [%date% %time%] Starting Lane B...
call npx tsx src/research/laneBLoop.ts
set "EXIT_CODE=%errorlevel%"
echo.
echo [%date% %time%] Lane B exited (code %EXIT_CODE%). Restarting in 10s...
timeout /t 10 /nobreak >nul
goto loop
