Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$port = 2603
$outLog = Join-Path $root "server.log"
$errLog = Join-Path $root "server.err.log"
$launcherLog = Join-Path $root "launcher.log"

function Write-LaunchLog([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
  $line | Out-File -FilePath $launcherLog -Append -Encoding utf8
}

Write-LaunchLog "launch.ps1 start"

try {
  $node = Get-Command node -ErrorAction Stop
} catch {
  Write-Host "Node.js not found (the 'node' command is unavailable)." -ForegroundColor Red
  Write-Host "Please install Node.js (LTS) and try again."
  Write-LaunchLog "Node.js not found"
  Read-Host "Press Enter to close"
  exit 1
}

function Test-Port([int]$p) {
  try {
    $c = New-Object Net.Sockets.TcpClient("127.0.0.1", $p)
    $c.Close()
    return $true
  } catch {
    return $false
  }
}

if (Test-Port $port) {
  Write-Host ("Port {0} is already in use. Opening the game..." -f $port)
  Write-LaunchLog ("Port in use: {0}" -f $port)
  Start-Process ("http://localhost:{0}/" -f $port)
  exit 0
}

if (Test-Path $outLog) { Remove-Item $outLog -Force -ErrorAction SilentlyContinue }
if (Test-Path $errLog) { Remove-Item $errLog -Force -ErrorAction SilentlyContinue }

Write-Host "Starting Tagteam server..."
Write-LaunchLog "Starting server.mjs"

$server = Start-Process -FilePath $node.Source -ArgumentList @("server.mjs") -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Write-LaunchLog ("Server PID={0}" -f $server.Id)

$ok = $false
for ($i = 0; $i -lt 150; $i++) {
  if (Test-Port $port) { $ok = $true; break }
  Start-Sleep -Milliseconds 200
  try { if ($server.HasExited) { break } } catch {}
}

if (-not $ok) {
  Write-Host ("Failed to start server on port {0}." -f $port) -ForegroundColor Red
  Write-Host ("Open {0} / {1} to see details." -f $outLog, $errLog)
  Write-LaunchLog "Server failed to listen"
  if (Test-Path $errLog) { Start-Process notepad.exe $errLog }
  elseif (Test-Path $outLog) { Start-Process notepad.exe $outLog }
  exit 1
}

Write-LaunchLog "Server is listening; opening browser"
Start-Process ("http://localhost:{0}/" -f $port)
Write-Host ("Opened: http://localhost:{0}/" -f $port)
Write-LaunchLog "Launcher exit 0"
exit 0
