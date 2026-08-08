# run_loop.ps1 - Live wrapper for the polymarket bot loop.
# Streams bot output to the console AND appends it to botloop.log (UTF-8).
# Self-locates so it works regardless of launch cwd, and never lets a logging
# failure kill the bot loop (the log writer is optional).
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$logPath = Join-Path $PSScriptRoot 'botloop.log'
$sw = $null
try {
    $sw = New-Object System.IO.StreamWriter($logPath, $true, (New-Object System.Text.UTF8Encoding($false)))
    $sw.AutoFlush = $true
} catch {
    Write-Host ("WARN: cannot open log '" + $logPath + "': " + $_.Exception.Message) -ForegroundColor Yellow
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
& npx tsx src/jobs/loop.ts 2>&1 | ForEach-Object {
    [Console]::WriteLine($_)
    if ($sw) { $sw.WriteLine($_) }
}
if ($sw) { $sw.Close() }
exit $LASTEXITCODE