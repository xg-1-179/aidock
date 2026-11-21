# Register AIDock direct forwarder as a Windows logon task.
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/install-direct-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install-direct-task.ps1 -Port 41999
# Uninstall:
#   Unregister-ScheduledTask -TaskName AIDockDirectForward -Confirm:$false

param(
  [int]$Port = 41873,
  [string]$Target = '127.0.0.1:3080'
)

$ErrorActionPreference = 'Stop'
$taskName = 'AIDockDirectForward'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'node.exe not found in PATH. Install Node.js and reopen the terminal.' }

$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'tools\direct-forward.js'
if (-not (Test-Path $script)) { $script = Join-Path $repo 'direct-forward.js' }
if (-not (Test-Path $script)) { $script = Join-Path $PSScriptRoot 'direct-forward.js' }
if (-not (Test-Path $script)) { throw "missing $script - run this from the repository root" }

$log = Join-Path $env:USERPROFILE 'Desktop\aidock-direct.log'
$cmdLine = "/c set PORT=$Port&& set TARGET=$Target&& `"$($nodeCmd.Source)`" `"$script`" >> `"$log`" 2>&1"

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdLine -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description ("AIDock direct forward 0.0.0.0:" + $Port + " -> " + $Target) -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Write-Host ("registered and started task " + $taskName + " (port " + $Port + " -> " + $Target + ", log " + $log + ")")
Write-Host ("uninstall: Unregister-ScheduledTask -TaskName " + $taskName + " -Confirm:`$false")
