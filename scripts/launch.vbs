' Launches the Crafting Materials Checker tray icon with no console window.
' The desktop shortcut points here.
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "tray.ps1""", 0, False
