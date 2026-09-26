$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $projectRoot

$entry = [IO.Path]::GetFullPath((Join-Path $projectRoot 'src\index.ts'))
$watcher = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\dev-watch.cjs'))

if (-not (Test-Path -LiteralPath $watcher)) {
  throw "The development watcher is missing: $watcher"
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  foreach ($candidate in @('C:\Program Files\nodejs\node.exe', "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path -LiteralPath $candidate) {
      $node = Get-Item -LiteralPath $candidate
      break
    }
  }
}
if (-not $node) {
  throw 'Node.js was not found. Install Node.js 24.x and try again.'
}

$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -and
  ($_.CommandLine -like "*$entry*" -or $_.CommandLine -like '*src\index.ts*' -or $_.CommandLine -like "*$watcher*")
}
if ($existing) {
  Write-Host "BluxBot is already running. PID(s): $($existing.ProcessId -join ', ')" -ForegroundColor Yellow
  Write-Host 'Close the existing visible terminal before starting another copy.' -ForegroundColor Yellow
  exit 1
}

$Host.UI.RawUI.WindowTitle = 'BluxBot - visible live development'
$env:TS_NODE_TRANSPILE_ONLY = '1'
$logDir = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDir 'bluxbot.log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

Write-Host 'BluxBot visible development console' -ForegroundColor Cyan
Write-Host "Project: $projectRoot"
Write-Host "Log: $logFile"
Write-Host 'Watching src - edits reload automatically. Ctrl+C stops the bot.' -ForegroundColor DarkGray
Write-Host ''

$nodePath = if ($node.Source) { $node.Source } else { $node.FullName }
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $nodePath $watcher 2>&1 | Tee-Object -FilePath $logFile
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "BluxBot exited with code $exitCode"
  }
} catch {
  $ErrorActionPreference = $previousErrorAction
  Write-Host "[start-visible] $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
