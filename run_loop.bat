@echo off
title Polymarket Bot Loop (auto-restart)
cd /d "c:\Users\הלל\Desktop\algo projects\polymarket bot"
rem Canonical DB (Windows view): C:\home\hillel\polymarket-bot-dev.db
set DATABASE_URL=file:C:/home/hillel/polymarket-bot-dev.db
echo ============================================
echo  Polymarket Wallet-Copy Loop
echo  DB: %DATABASE_URL%
echo  Auto-restarts on crash. Close window to stop.
echo  Output below is LIVE (also appended to botloop.log)
echo  Started: %date% %time%
echo ============================================
echo.

:loop
echo [%date% %time%] Starting loop...
rem Stream each output line to this console in real time AND append to botloop.log (UTF-8).
rem run_loop.ps1 self-locates and tolerates log-writer failures (no more $sw null crash).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_loop.ps1"
echo.
echo [%date% %time%] Loop exited (code %errorlevel%). Restarting in 10s...
timeout /t 10 /nobreak >nul
goto loop
