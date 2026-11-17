# Task C helper. "Break" points the primary FORGE agent at an unreachable OpenAI-compatible endpoint
# (a custom TrueForge provider on 127.0.0.1:9, created if missing) while the fallback agent keeps a working model.
# "Restore" points the primary back at a real model. Neither touches any API key.
#
#   powershell -File scripts\taskc.ps1 -Break   -Fallback google-gemini/gemini-3-1-flash-lite
#   powershell -File scripts\taskc.ps1 -Restore -Primary google-gemini/gemini-3-5-flash-lite -Fallback google-gemini/gemini-3-1-flash-lite
param(
  [switch]$Break,
  [switch]$Restore,
  [string]$Primary = "google-gemini/gemini-3-5-flash-lite",
  [string]$Fallback = "google-gemini/gemini-3-1-flash-lite",
  [string]$TrueForge = "http://localhost:8790"
)
$ErrorActionPreference = "Stop"
$cli = Join-Path (Split-Path -Parent $PSScriptRoot) "dist\forge-cli.js"
if ($Break -eq $Restore) { throw "Pass exactly one of -Break or -Restore." }
if ($Break) {
  $providers = (Invoke-RestMethod "$TrueForge/api/v1/settings/model-providers").data | ForEach-Object name
  if ($providers -notcontains "unreachable-endpoint") {
    $body = @{ manifest = @{ type = "custom"; name = "unreachable-endpoint"; base_url = "http://127.0.0.1:9/v1";
      models = @(@{ model_id = "broken-model"; name = "broken-model"; properties = @{ context_length = 8192; max_output_tokens = 1024 } }) } } | ConvertTo-Json -Depth 10
    Invoke-RestMethod "$TrueForge/api/v1/settings/model-providers" -Method Post -ContentType "application/json" -Body $body | Out-Null
    Write-Host "Created TrueForge provider 'unreachable-endpoint' (http://127.0.0.1:9/v1)."
  }
  node $cli setup --trueforge $TrueForge --primary-model "unreachable-endpoint/broken-model" --fallback-model $Fallback
} else {
  node $cli setup --trueforge $TrueForge --primary-model $Primary --fallback-model $Fallback
}
