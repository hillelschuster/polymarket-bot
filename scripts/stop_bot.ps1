# Stops the Polymarket bot loop chain (run_loop.bat -> powershell -> npx -> tsx).
# Targets ONLY processes of THIS project, never the separate 'polymarket-anomaly'
# project (its loop is src/loop.ts, excluded explicitly).
#
# Waits for the DB to be QUIET (no writes for 15s, max 10 min) before killing so
# the bot is never interrupted mid-statement — that would print a "failed to
# execute statement" error in its console. A hung bot writes nothing, so a quiet
# DB is safe to kill whether it is sleeping or stuck.
#
# Prints BOT_RUNNING=True/False so the caller knows whether to restart it.
$filter = {
  $_.CommandLine -and
  ($_.CommandLine -notmatch 'polymarket-anomaly') -and
  (
    ($_.CommandLine -match 'polymarket bot' -and $_.CommandLine -match '(run_loop\.bat|run_loop\.ps1|loop\.ts)') -or
    ($_.CommandLine -match 'src[/\\]jobs[/\\]loop\.ts') -or
    ($_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'run_loop\.bat' -and $_.CommandLine -notmatch 'polymarket-anomaly')
  )
}

# Wait for a quiet DB (last write > 15s ago), polling every 5s, max 10 min.
$db = Get-Item "C:\home\hillel\polymarket-bot-dev.db" -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddMinutes(10)
while ($db -and (Get-Date) -lt $deadline) {
  $db.Refresh()
  if (((Get-Date) - $db.LastWriteTime).TotalSeconds -gt 15) { break }
  Start-Sleep -Seconds 5
}

$first = @(Get-CimInstance Win32_Process | Where-Object $filter)
$wasRunning = $first.Count -gt 0
foreach ($p in $first) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$second = @(Get-CimInstance Win32_Process | Where-Object $filter)
foreach ($p in $second) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
if ($wasRunning) { Write-Output "BOT_RUNNING=True" } else { Write-Output "BOT_RUNNING=False" }
