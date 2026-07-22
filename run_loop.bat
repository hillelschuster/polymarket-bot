@echo off
title Polymarket Bot Loop (auto-restart)
cd /d "c:\Users\הלל\Desktop\algo projects\polymarket bot"
echo ============================================
echo  Polymarket Wallet-Copy Loop
echo  Auto-restarts on crash. Close window to stop.
echo  Started: %date% %time%
echo ============================================
echo.

:loop
echo [%date% %time%] Starting loop...
call npx tsx src/jobs/loop.ts
echo.
echo [%date% %time%] Loop exited (code %errorlevel%). Restarting in 10s...
timeout /t 10 /nobreak >nul
goto loop
