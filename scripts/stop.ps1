# Stops Crafting Materials Checker from a terminal.
# Day to day you would use the tray menu instead; this is here for scripting.

. (Join-Path $PSScriptRoot 'app.ps1')

if (Stop-App) {
    Write-Host 'Stopped Crafting Materials Checker.'
} else {
    Write-Host 'Crafting Materials Checker was not running.'
}
