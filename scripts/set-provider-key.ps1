# Sets (or replaces) the API key of a model provider already configured in TrueForge, e.g. a custom
# OpenAI-compatible provider whose key did not get saved from the UI. The key is read with hidden input and
# sent only to the local TrueForge server; it is not printed or written anywhere.
#
#   powershell -ExecutionPolicy Bypass -File scripts\set-provider-key.ps1 -Name groq
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$TrueForge = "http://localhost:8790"
)
$ErrorActionPreference = "Stop"
$list = Invoke-RestMethod -Uri "$TrueForge/api/v1/settings/model-providers" -Method Get
$provider = $list.data | Where-Object { $_.name -eq $Name }
if (-not $provider) { throw "No model provider named '$Name' in TrueForge. Configured: $(($list.data | ForEach-Object name) -join ', ')" }
$manifest = if ($provider.manifest) { $provider.manifest } else { $provider }

$secure = Read-Host -AsSecureString "API key for '$Name' (input hidden)"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ([string]::IsNullOrWhiteSpace($key)) { throw "Empty key; nothing changed." }

$body = [ordered]@{}
foreach ($p in $manifest.PSObject.Properties) { if ($p.Name -ne 'auth') { $body[$p.Name] = $p.Value } }
$body['auth'] = @{ api_key = $key.Trim() }
$json = @{ manifest = $body } | ConvertTo-Json -Depth 20
$key = $null
Invoke-RestMethod -Uri "$TrueForge/api/v1/settings/model-providers" -Method Put -ContentType "application/json" -Body $json | Out-Null
Write-Host "Saved a new API key for '$Name'."
