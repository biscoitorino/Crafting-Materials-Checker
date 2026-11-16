# Shared helpers for starting, stopping and inspecting the app.
# Dot-sourced by tray.ps1 and stop.ps1 so there is one definition of each.

$script:Root = Split-Path -Parent $PSScriptRoot
$script:DataDir = Join-Path $script:Root 'data'
$script:PidFile = Join-Path $script:DataDir 'app.pid'
$script:LogFile = Join-Path $script:DataDir 'app.log'
$script:ErrFile = Join-Path $script:DataDir 'app.err.log'

function Get-AppRoot { return $script:Root }
function Get-AppLog { return $script:LogFile }
function Get-AppErrLog { return $script:ErrFile }

function Get-AppPort {
    $envFile = Join-Path $script:Root '.env'
    if (Test-Path $envFile) {
        $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
        if ($line) { return [int]$line.Matches[0].Groups[1].Value }
    }
    return 8790
}

function Get-AppUrl { return "http://127.0.0.1:$(Get-AppPort)/" }

function Find-Node {
    try { return (Get-Command node -ErrorAction Stop).Source } catch {}
    foreach ($candidate in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

# The running app, found by the recorded process id and then, failing that, by
# whoever holds the dashboard port. The second check catches a run started from
# a terminal rather than from the tray.
function Get-AppProcess {
    if (Test-Path $script:PidFile) {
        $savedPid = (Get-Content $script:PidFile -Raw).Trim()
        if ($savedPid -match '^\d+$') {
            try {
                $proc = Get-Process -Id ([int]$savedPid) -ErrorAction Stop
                if ($proc.ProcessName -eq 'node') { return $proc }
            } catch {}
        }
    }

    try {
        $owners = Get-NetTCPConnection -LocalPort (Get-AppPort) -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($ownerPid in $owners) {
            $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq 'node') { return $proc }
        }
    } catch {}

    return $null
}

function Test-AppRunning {
    $proc = Get-AppProcess
    return ($null -ne $proc)
}

function Start-App {
    if (Test-AppRunning) { return $true }

    if (-not (Test-Path $script:DataDir)) {
        New-Item -ItemType Directory -Path $script:DataDir | Out-Null
    }

    $node = Find-Node
    if (-not $node) { return $false }

    # Keep the previous run's output, so a crash is still readable afterwards.
    if (Test-Path $script:LogFile) { Move-Item $script:LogFile "$($script:LogFile).1" -Force }
    if (Test-Path $script:ErrFile) { Move-Item $script:ErrFile "$($script:ErrFile).1" -Force }

    $proc = Start-Process -FilePath $node `
        -ArgumentList '--env-file-if-exists=.env', 'src/index.js' `
        -WorkingDirectory $script:Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $script:LogFile `
        -RedirectStandardError $script:ErrFile `
        -PassThru

    Set-Content -Path $script:PidFile -Value $proc.Id -Encoding ascii
    return $true
}

function Stop-App {
    $stopped = $false
    $proc = Get-AppProcess
    while ($proc) {
        try {
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            $stopped = $true
        } catch {
            break
        }
        Start-Sleep -Milliseconds 300
        $proc = Get-AppProcess
    }
    Remove-Item $script:PidFile -Force -ErrorAction SilentlyContinue
    return $stopped
}

# Waits for the dashboard to answer, so the browser is not opened too early.
function Wait-ForDashboard {
    param([int]$TimeoutSeconds = 25)
    $url = Get-AppUrl
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null
            return $true
        } catch {
            Start-Sleep -Milliseconds 400
        }
    }
    return $false
}
