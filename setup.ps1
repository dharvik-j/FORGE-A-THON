# One-time setup for FORGE on Windows. Run from the FORGE folder:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
# Installs packages, builds the extension, and fetches the Flask demo repos.
# Safe to re-run: it never deletes anything, and existing Flask checkouts are left untouched.
param([switch]$SkipFlask)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Need([string]$cmd, [string]$hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "'$cmd' was not found. $hint" }
}
function Run([string]$what, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)." }
}

Write-Host '== 1/4 Checking prerequisites'
Need node 'Install Node.js 22.14 or newer from https://nodejs.org and reopen PowerShell.'
Need git 'Install Git from https://git-scm.com and reopen PowerShell.'
Need py 'Install Python 3 from https://www.python.org (keep "py launcher" ticked) and reopen PowerShell.'
$nodeVersion = [version]((node --version).TrimStart('v'))
if ($nodeVersion -lt [version]'22.14.0') { throw "Node.js $nodeVersion is too old; FORGE needs 22.14 or newer." }
if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
  Write-Warning "VS Code's 'code' command is not on PATH. start.ps1 needs it: reinstall VS Code with 'Add to PATH' ticked."
}

Write-Host '== 2/4 Installing packages (npm ci)'
Run 'npm ci' { npm ci --no-audit --no-fund }

Write-Host '== 3/4 Building the extension'
Run 'npm run build' { npm run build }

if ($SkipFlask) {
  Write-Host '== 4/4 Skipping the Flask demo repos (-SkipFlask)'
} else {
  Write-Host '== 4/4 Fetching the Flask demo repos (Flask 3.1.3)'
  & (Join-Path $root 'scripts\setup-flask.ps1')
  & (Join-Path $root 'scripts\setup-flask.ps1') -Name flask-taskc
}

Write-Host ''
Write-Host 'Setup finished. Next:'
Write-Host '  1. powershell -ExecutionPolicy Bypass -File start.ps1'
Write-Host '     (starts TrueForge and opens VS Code on the Flask demo with FORGE loaded)'
Write-Host '  2. In TrueForge (http://localhost:8790): Settings -> Models, add two models with your own API keys.'
Write-Host '  3. In the VS Code window: Ctrl+Shift+P -> "FORGE: Set up TrueForge", pick the two models.'
