# Read-only bot health check. Prints BOT_RUNNING=True/False. Never kills anything.
$filter = {
  $_.CommandLine -and
  ($_.CommandLine -notmatch 'polymarket-anomaly') -and
  (
    ($_.CommandLine -match 'polymarket bot' -and $_.CommandLine -match '(run_loop\.bat|loop\.ts)') -or
    ($_.CommandLine -match 'src[/\\]jobs[/\\]loop\.ts')
  )
}
$found = @(Get-CimInstance Win32_Process | Where-Object $filter)
if ($found.Count -gt 0) { Write-Output "BOT_RUNNING=True" } else { Write-Output "BOT_RUNNING=False" }
