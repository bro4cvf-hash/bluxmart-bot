$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$entry = [IO.Path]::GetFullPath((Join-Path $projectRoot 'src\index.ts'))

$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -and
  ($_.CommandLine -like "*$entry*" -or $_.CommandLine -like '*src\index.ts*')
})
$supervisor = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine -like '*dev-watch.cjs*'
})

if (-not $processes -and -not $supervisor) {
  Write-Host 'BluxBot is not running.' -ForegroundColor Yellow
  exit 1
}
if (-not $processes) {
  Write-Host 'The visible supervisor is running; the bot child is between retries.' -ForegroundColor Yellow
}
if ($supervisor) {
  Write-Host 'Supervisor:' -ForegroundColor Cyan
  $supervisor | Select-Object ProcessId, ParentProcessId, CommandLine | Format-List
}

$processes | Select-Object ProcessId, ParentProcessId, Name, CommandLine | Format-List
$ids = @($processes.ProcessId)
Get-NetTCPConnection -OwningProcess $ids -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, State |
  Format-Table -AutoSize
Write-Host 'Use npm run dev:visible for an interactive, auto-reloading console.' -ForegroundColor Cyan
