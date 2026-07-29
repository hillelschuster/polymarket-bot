@echo off
title Polymarket Bot Loop (auto-restart)
cd /d "c:\Users\הלל\Desktop\algo projects\polymarket bot"
set DATABASE_URL=file:/home/hillel/polymarket-bot-dev.db
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
powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $sw=New-Object IO.StreamWriter('botloop.log',$true,[Text.Encoding]::UTF8); $sw.AutoFlush=$true; & npx tsx src/jobs/loop.ts 2>&1 | ForEach-Object { [Console]::WriteLine($_); $sw.WriteLine($_) }; $sw.Close(); exit $LASTEXITCODE"
echo.
echo [%date% %time%] Loop exited (code %errorlevel%). Restarting in 10s...
timeout /t 10 /nobreak >nul
goto loop
