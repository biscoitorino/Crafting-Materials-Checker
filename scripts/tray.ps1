# Crafting Materials Checker tray icon.
#
# Runs the app in the background and puts a hammer in the notification area so
# you can tell at a glance whether it is up: full colour when running, grey when
# stopped. Right click for the menu, double click to open the app.

$ErrorActionPreference = 'Stop'

# One tray icon at a time, however many times the shortcut is clicked. This is
# checked before anything slow, so a duplicate launch exits straight away
# instead of sitting around loading assemblies it will never use.
$mutex = New-Object System.Threading.Mutex($false, 'Global\CraftingMaterialsCheckerTray')
if (-not $mutex.WaitOne(0, $false)) {
    exit 0
}

. (Join-Path $PSScriptRoot 'app.ps1')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Get-AppRoot
$iconLive = Join-Path $root 'assets\crafting.ico'
$iconIdle = Join-Path $root 'assets\crafting-idle.ico'

function Get-Icon([string]$file) {
    if (Test-Path $file) { return New-Object System.Drawing.Icon($file) }
    return [System.Drawing.SystemIcons]::Application
}

$runningIcon = Get-Icon $iconLive
$stoppedIcon = Get-Icon $iconIdle

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $stoppedIcon
$notify.Text = 'Crafting Materials Checker'
$notify.Visible = $true

$context = New-Object System.Windows.Forms.ApplicationContext

function Show-Balloon([string]$title, [string]$body) {
    $notify.BalloonTipTitle = $title
    $notify.BalloonTipText = $body
    $notify.ShowBalloonTip(3000)
}

# Tray text is capped at 63 characters, so keep the tooltip short.
function Update-State {
    if (Test-AppRunning) {
        $notify.Icon = $runningIcon
        $notify.Text = "Crafting Materials Checker - running on port $(Get-AppPort)"
    } else {
        $notify.Icon = $stoppedIcon
        $notify.Text = 'Crafting Materials Checker - stopped'
    }
}

function Invoke-Start {
    if (Test-AppRunning) { return }
    if (-not (Start-App)) {
        Show-Balloon 'Crafting Materials Checker' 'Node.js was not found. Install it from nodejs.org.'
        return
    }
    Update-State
    Show-Balloon 'Crafting Materials Checker' 'Starting up.'
}

function Invoke-Stop {
    if (Stop-App) { Show-Balloon 'Crafting Materials Checker' 'Stopped.' }
    Update-State
}

function Invoke-Restart {
    Stop-App | Out-Null
    Start-Sleep -Milliseconds 400
    Invoke-Start
    Show-Balloon 'Crafting Materials Checker' 'Restarting.'
}

function Invoke-OpenDashboard {
    if (-not (Test-AppRunning)) {
        Invoke-Start
        Wait-ForDashboard -TimeoutSeconds 25 | Out-Null
    }
    Start-Process (Get-AppUrl)
}

function Invoke-ShowLogs {
    $log = Get-AppLog
    $err = Get-AppErrLog
    # A visible console that follows the log, closed with Ctrl+C or the X.
    $command = "`$Host.UI.RawUI.WindowTitle='Crafting Materials Checker logs'; " +
        "Write-Host 'Following the log. Close this window when you are done.' -ForegroundColor Yellow; " +
        "Get-Content -Path '$log','$err' -Tail 40 -Wait -ErrorAction SilentlyContinue"
    Start-Process powershell -ArgumentList '-NoProfile', '-NoExit', '-Command', $command
}

# --- menu -------------------------------------------------------------------

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add('Open in browser')
$miOpen.add_Click({ Invoke-OpenDashboard })
$miOpen.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miStartStop = $menu.Items.Add('Stop')
$miStartStop.add_Click({
    if (Test-AppRunning) { Invoke-Stop } else { Invoke-Start }
})

$miRestart = $menu.Items.Add('Restart')
$miRestart.add_Click({ Invoke-Restart })

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miLogs = $menu.Items.Add('Show logs')
$miLogs.add_Click({ Invoke-ShowLogs })

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miExit = $menu.Items.Add('Quit (stops the app)')
$miExit.add_Click({
    Stop-App | Out-Null
    $notify.Visible = $false
    $notify.Dispose()
    $context.ExitThread()
})

# Refresh the menu each time it opens, so it always reflects the real state.
$menu.add_Opening({
    $running = Test-AppRunning
    if ($running) {
        $miStartStop.Text = 'Stop'
        $miRestart.Enabled = $true
    } else {
        $miStartStop.Text = 'Start'
        $miRestart.Enabled = $false
    }
    Update-State
})

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Invoke-OpenDashboard }
})

# --- run --------------------------------------------------------------------

# Poll for state changes, so the icon is still right if the app is stopped or
# started from somewhere other than this menu.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ Update-State })
$timer.Start()

Invoke-Start
Update-State

try {
    [System.Windows.Forms.Application]::Run($context)
} finally {
    $timer.Stop()
    $notify.Visible = $false
    $notify.Dispose()
    $mutex.ReleaseMutex()
}
