# Creates the desktop shortcut for Crafting Materials Checker.
# Run it again any time; it overwrites the shortcut in place.
#
# The shortcut launches the tray icon. The tray menu covers opening the app in
# the browser, stopping, restarting and reading the logs.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

$icon = Join-Path $root 'assets\crafting.ico'
if (-not (Test-Path $icon)) {
    Write-Warning "Icon missing at $icon. Run 'npm run icon' first."
}

$path = Join-Path $desktop 'Crafting Materials Checker.lnk'
$sc = $shell.CreateShortcut($path)
# wscript runs the launcher with no console window at all.
$sc.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$sc.Arguments = '"' + (Join-Path $root 'scripts\launch.vbs') + '"'
$sc.WorkingDirectory = $root
$sc.Description = 'Crafting Materials Checker, FFXIV crafting cost tool'
$sc.IconLocation = "$icon,0"
$sc.Save()

Write-Host "Created $path"
