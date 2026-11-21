$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-web-proxy*' }
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force
  Write-Host ("killed {0}" -f $p.ProcessId)
}
if (-not $procs) { Write-Host 'no proxy process' }
