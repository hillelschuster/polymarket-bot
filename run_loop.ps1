# run_loop.ps1 - Live wrapper for the polymarket bot loop.
# Botloop.log stays a byte-for-byte raw capture of every node line; the attached
# console shows a compact operator view (fast-pass summaries, slow-path one-liners,
# verbatim errors/warnings/Copy/PnL lines). Self-locates so it works regardless of
# launch cwd, and never lets a logging failure kill the bot loop (log is optional).
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

# Second append-only writer for the compact operator view (botloop-view.log).
# Mirrors exactly what the compact console prints (nothing suppressed there is
# written here). Same tolerance as above: a failure disables the view writer and
# never breaks the raw botloop.log capture or the bot loop.
$viewPath = Join-Path $PSScriptRoot 'botloop-view.log'
$view = $null
try {
    $view = New-Object System.IO.StreamWriter($viewPath, $true, (New-Object System.Text.UTF8Encoding($false)))
    $view.AutoFlush = $true
} catch {
    Write-Host ("WARN: cannot open view log '" + $viewPath + "': " + $_.Exception.Message) -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Console formatter. Raw lines are ALWAYS written to botloop.log unchanged;
# this only decides what the console mirror prints. State: a buffered line
# awaiting its partner (leaderboard+wallet counts, politics preamble+summary)
# and an in-progress multi-line skip-reason object. Anything unrecognized
# prints unchanged, never disappears.
# ---------------------------------------------------------------------------
$script:inv = [System.Globalization.CultureInfo]::InvariantCulture
$script:pendLine = ''   # buffered compact line awaiting a continuation
$script:pendType = ''   # 'refresh' | 'polPreamble' | 'polDone' | 'calDone'
$script:foldActive = $false
$script:foldBuf = @()
$script:foldKind = ''   # 'pol' | 'cal'
$script:polSignals = 0
$script:calBaskets = 0

function ConvertTo-CompactLine {
    param([string]$Line)

    # --- inside a folded multi-line skip-reason object ---
    if ($script:foldActive) {
        if ($Line -match '^\s*\}\s*$') {
            $compact = ''
            if ($script:foldBuf.Count) { $compact = '{' + ($script:foldBuf -join ', ') + '}' }
            $out = @()
            if ($script:pendLine) { $out += $script:pendLine }
            $show = ($script:foldKind -eq 'pol' -and $script:polSignals -gt 0) -or
                    ($script:foldKind -eq 'cal' -and $script:calBaskets -gt 0)
            if ($show -and $compact) { $out += '  ' + $compact }
            $script:foldActive = $false
            $script:foldBuf = @()
            $script:foldKind = ''
            $script:pendLine = ''
            $script:pendType = ''
            return ,$out
        }
        if ($Line -match '^\s*[^:]+:\s*\d+,?\s*$') {
            $e = $Line.Trim() -replace "'", '' -replace ':\s*', ':' -replace ',$', ''
            $script:foldBuf += $e
            return ,@()
        }
        # unexpected line inside the object: close the fold, print everything raw
        $out = @()
        if ($script:pendLine) { $out += $script:pendLine }
        $script:foldActive = $false
        $script:foldBuf = @()
        $script:foldKind = ''
        $script:pendLine = ''
        $script:pendType = ''
        $out += $Line
        return ,$out
    }

    # --- pending-line continuations ---
    # blank lines never flush pending state (they carry the section rhythm),
    # and the step header between leaderboard-done and wallets-done is skipped
    if ($Line -eq '' -and $script:pendType) { return ,@('') }
    if ($script:pendType -eq 'refresh' -and $Line -match '^===\s+scan:wallets\s*===$') { return ,@() }
    if ($script:pendType -eq 'refresh' -and $Line -match '^scanWallets done: (\d+) wallets scored$') {
        $out = $script:pendLine + ' | scored ' + ([long]$Matches[1]).ToString('N0', $script:inv) + ' wallets'
        $script:pendLine = ''
        $script:pendType = ''
        return ,@($out)
    }
    if ($script:pendType -eq 'polPreamble' -and $Line -match '^scanPoliticalFavorites done: (\d+) scanned, (\d+) signals, (\d+) skipped$') {
        $script:polSignals = [int]$Matches[2]
        $script:pendLine += ' | ' + $Matches[1] + ' scanned | ' + $Matches[2] + ' signals | ' + $Matches[3] + ' skipped'
        $script:pendType = 'polDone'
        return ,@()
    }
    if ($script:pendType -eq 'polDone' -or $script:pendType -eq 'calDone') {
        if ($Line -match '^  skip reasons: \{(.+)\}$') {
            $entries = @($Matches[1] -split ',' | ForEach-Object {
                ($_.Trim() -replace "'", '' -replace ':\s*', ':')
            })
            $compact = '{' + ($entries -join ', ') + '}'
            $out = @($script:pendLine)
            $show = ($script:pendType -eq 'polDone' -and $script:polSignals -gt 0) -or
                    ($script:pendType -eq 'calDone' -and $script:calBaskets -gt 0)
            if ($show) { $out += '  ' + $compact }
            $script:pendLine = ''
            $script:pendType = ''
            return ,$out
        }
        if ($Line -match '^  skip reasons: \{$') {
            $script:foldActive = $true
            $script:foldBuf = @()
            $script:foldKind = 'pol'
            if ($script:pendType -eq 'calDone') { $script:foldKind = 'cal' }
            return ,@()
        }
        # no skip-reasons block: emit the buffered summary, reprocess this line fresh
        $out = @($script:pendLine)
        $script:pendLine = ''
        $script:pendType = ''
        return ,($out + (ConvertTo-CompactLine $Line))
    }
    if ($script:pendType -eq 'refresh' -or $script:pendType -eq 'polPreamble') {
        $out = @($script:pendLine)
        $script:pendLine = ''
        $script:pendType = ''
        return ,($out + (ConvertTo-CompactLine $Line))
    }

    # --- suppress known noise ---
    if ($Line -match '^===\s+[\w:-]+\s*===$') { return ,@() }
    if ($Line -match '^  scope [\w-]+: \d+ wallets$') { return ,@() }
    if ($Line -match '^updateRules: rules at v\d+, in sync with code \(no changes\)$') { return ,@() }

    # --- collapse routine success lines ---
    if ($Line -match '^monitorTrades done: (\d+) trades from (\d+) wallets in (\d+)s \((\d+) wallet failures\)$') {
        return ,@(('{0,-8} {1} trades | {2} wallets | {3} failed | {4}s' -f 'monitor',
            ([long]$Matches[1]).ToString('N0', $script:inv),
            ([long]$Matches[2]).ToString('N0', $script:inv),
            $Matches[4], $Matches[3]))
    }
    if ($Line -match '^scoreTrades done: (\d+) scored, (\d+) paper_copy, (\d+) stale, (\d+) no-quote, (\d+) dedup, (\d+) gates$') {
        return ,@(('{0,-8} {1} scored | {2} copied | {3} stale | {4} no quote | {5} dedup | {6} gates' -f 'signals',
            $Matches[1], $Matches[2], $Matches[3], $Matches[4], $Matches[5], $Matches[6]))
    }
    if ($Line -match '^paperUpdatePnl done: (\d+) executable marks, (\d+) skipped$') {
        return ,@(('{0,-8} {1} executable | {2} skipped' -f 'marks', $Matches[1], $Matches[2]))
    }
    if ($Line -match '^reviewOutcomes done: (\d+) trades resolved$') {
        return ,@(('{0,-8} {1} resolved' -f 'outcomes', $Matches[1]))
    }
    if ($Line -match '^scanLeaderboard done: (\d+) unique wallets from (\d+) scopes, scan \S+$') {
        $script:pendLine = ('{0,-8} leaderboard {1} wallets' -f 'refresh', ([long]$Matches[1]).ToString('N0', $script:inv))
        $script:pendType = 'refresh'
        return ,@()
    }
    if ($Line -match '^scanWallets done: (\d+) wallets scored$') {
        return ,@(('{0,-8} scored {1} wallets' -f 'refresh', ([long]$Matches[1]).ToString('N0', $script:inv)))
    }
    if ($Line -match '^scanPoliticalFavorites: (\d+) total markets, (\d+) political$') {
        $script:pendLine = ('{0,-8} {1} markets, {2} pol' -f 'politics', $Matches[1], $Matches[2])
        $script:pendType = 'polPreamble'
        return ,@()
    }
    if ($Line -match '^scanPoliticalFavorites done: (\d+) scanned, (\d+) signals, (\d+) skipped$') {
        $script:polSignals = [int]$Matches[2]
        $script:pendLine = ('{0,-8} {1} scanned | {2} signals | {3} skipped' -f 'politics', $Matches[1], $Matches[2], $Matches[3])
        $script:pendType = 'polDone'
        return ,@()
    }
    if ($Line -match '^scanCalendarArbitrage done: (\d+) markets, (\d+) pairs, (\d+) baskets$') {
        $script:calBaskets = [int]$Matches[3]
        $script:pendLine = ('{0,-8} {1} markets | {2} pairs | {3} baskets' -f 'calendar', $Matches[1], $Matches[2], $Matches[3])
        $script:pendType = 'calDone'
        return ,@()
    }

    # --- everything else (COPY:, PnL:, errors, retries, pass lines, blanks) verbatim ---
    return ,@($Line)
}

# ---------------------------------------------------------------------------
# Live loop: raw capture to botloop.log (unchanged bytes), compact console.
# PS_COMPACT_TEST=1 loads the formatter only (parser/fixture testing).
# ---------------------------------------------------------------------------
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ($env:PS_COMPACT_TEST) {
    if ($sw) { $sw.Close() }
    if ($view) { $view.Close() }
} else {
    $lastBlank = $false   # collapse runs of blank lines in the console mirror
    & node --env-file=.env --import=tsx src/jobs/loop.ts 2>&1 | ForEach-Object {
        if ($sw) { $sw.WriteLine($_) }
        try { $out = ConvertTo-CompactLine $_ } catch { $out = @($_) }
        foreach ($o in $out) {
            if ($o -eq '' -and $lastBlank) { continue }
            $lastBlank = ($o -eq '')
            if ($script:view) { try { $script:view.WriteLine($o) } catch { $script:view = $null } }
            [Console]::WriteLine($o)
        }
    }
    if ($sw) { $sw.Close() }
    if ($view) { $view.Close() }
    exit $LASTEXITCODE
}
