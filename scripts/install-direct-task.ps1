# 注册 AIDock 直连转发为登录自启的计划任务（Windows）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/install-direct-task.ps1 [-Port 41873]

param(
  [int]$Port = 41873
)

$ErrorActionPreference = 'Stop'
$taskName = 'AIDockDirectForward'
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw 'PATH 里找不到 node，请先装 Node.js 并重新打开终端。' }

$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'tools\direct-forward.js'
if (-not (Test-Path $script)) { throw "找不到 $script（请在仓库根目录执行）" }

$log = Join-Path $env:USERPROFILE 'Desktop\aidock-direct.log'
$action = New-ScheduledTaskAction -Execute $node.Source `
  -Argument "`"$script`"" `
  -WorkingDirectory $repo
$action.Arguments = "`"$script`""
$env_line = "PORT=$Port"

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

# 环境变量通过 cmd 包一层，避免直接改系统环境。
$cmdLine = "/c set PORT=$Port&& `"$($node.Source)`" `"$script`" > `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdLine -WorkingDirectory $repo

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'AIDock 直连转发：0.0.0.0:PORT -> 127.0.0.1:3080（透明转发，手机端经公网直连）' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host "已注册并启动计划任务 $taskName（端口 $Port，日志 $log）"
Write-Host "卸载：Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
