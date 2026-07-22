@echo off
title Lane B - Resolution Lag Shadow Logger
cd /d "c:\Users\הלל\Desktop\algo projects\polymarket bot"
echo ============================================
echo  Lane B: Resolution-Lag Shadow Logger
echo  Independent from main pipeline.
echo  Storage: data/laneb_shadow.json
echo  Started: %date% %time%
echo ============================================
echo.

:loop
echo [%date% %time%] Starting Lane B scan loop...
call npx tsx src/research/laneBLoop.ts
echo.
echo [%date% %time%] Lane B exited (code %errorlevel%). Restarting in 10s...
timeout /t 10 /nobreak >nul
goto loop
