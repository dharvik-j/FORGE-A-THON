# Starts everything FORGE needs. Run from the FORGE folder after setup.ps1:
#   powershell -ExecutionPolicy Bypass -File start.ps1            # Tasks A and B
#   powershell -ExecutionPolicy Bypass -File start.ps1 flask-taskc  # clean checkout for Task C
# 1. Starts TrueForge in its own window, unless it is already running on port 8790.
# 2. Opens TrueForge in the browser.
# 3. Opens VS Code on workspaces\<Workspace> with FORGE loaded (the same as F5 in this folder).
param([string]$Workspace = 'flask')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (-not (Test-Path (Join-Path $root 'dist\extension.js'))) { throw 'FORGE is not built yet. Run setup.ps1 first.' }
$ws = Join-Path $root "workspaces\$Workspace"
if (-not (Test-Path $ws)) { throw "$ws does not exist. Run setup.ps1 first." }
if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
  throw "VS Code's 'code' command is not on PATH. Open this folder in VS Code and press F5 instead."
}

# Tries IPv4 and IPv6 loopback: TrueForge listens on localhost, which may be ::1 only.
function Test-Port([int]$port) {
  foreach ($address in '127.0.0.1', '::1') {
    $ip = [System.Net.IPAddress]::Parse($address)
    $client = New-Object System.Net.Sockets.TcpClient($ip.AddressFamily)
    try { $client.Connect($ip, $port); return $true } catch { } finally { $client.Close() }
  }
  return $false
}

if (Test-Port 3917) {
  Write-Warning 'Port 3917 is already in use, probably by another VS Code window running FORGE. Close it first, or FORGE will not start in the new window.'
}

if (Test-Port 8790) {
  Write-Host 'TrueForge is already running on port 8790.'
} else {
  $script = Join-Path $root 'scripts\start-trueforge.ps1'
  Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"")
  Write-Host 'Starting TrueForge in a new window (the first time it downloads, which takes a minute or two)...'
  $deadline = (Get-Date).AddMinutes(5)
  while (-not (Test-Port 8790)) {
    if ((Get-Date) -gt $deadline) { throw 'TrueForge did not start within 5 minutes. Check its window for errors.' }
    Start-Sleep -Seconds 2
  }
  Write-Host 'TrueForge is up. Keep its window open while you use FORGE.'
}

Start-Process 'http://localhost:8790'
& code "--extensionDevelopmentPath=$root" "$ws"
Write-Host "VS Code is opening on $ws with FORGE loaded. Look for the FORGE icon in the left bar."
