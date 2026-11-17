# Clones the pinned Flask release used by the competition (3.1.3, commit 22d92470) into workspaces\<Name>
# and creates a virtualenv with Flask installed in editable mode plus a compatible pytest.
# Never touches an existing checkout.
param([string]$Name = "flask")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "workspaces\$Name"
if (Test-Path $dest) { Write-Host "$dest already exists; leaving it untouched."; exit 0 }
New-Item -ItemType Directory -Force (Join-Path $root "workspaces") | Out-Null
git clone https://github.com/pallets/flask.git $dest
git -C $dest -c advice.detachedHead=false checkout 3.1.3
$head = git -C $dest rev-parse HEAD
if (-not $head.StartsWith("22d92470")) { throw "Unexpected commit $head (expected 22d92470...)" }
py -m venv (Join-Path $dest ".venv")
$py = Join-Path $dest ".venv\Scripts\python.exe"
& $py -m pip install --quiet -e $dest "pytest<9"
Write-Host "Flask 3.1.3 ready at $dest (commit $head)."
Write-Host "Verify: & '$py' -m pytest '$dest\tests\test_cli.py' -q"
