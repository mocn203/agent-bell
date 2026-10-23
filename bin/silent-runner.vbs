Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node """ & Replace(WScript.ScriptFullName, "silent-runner.vbs", "runner.js", 1, -1, 1) & """", 0, False
