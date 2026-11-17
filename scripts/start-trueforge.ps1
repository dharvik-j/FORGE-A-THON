# Starts TrueForge in local mode with loopback allowed for outbound calls, so it can reach FORGE's
# MCP server on 127.0.0.1 (TrueForge blocks loopback/private addresses by default).
param([int]$Port = 8790, [string]$Version = "0.185.1")
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'
$env:PORT = "$Port"
# Thinking models (e.g. Gemini) can take >20 s before the first streamed byte; TrueForge's default is 20 s.
$env:MODEL_HTTP_HEADERS_TIMEOUT_MS = "120000"
npx -y "@truefoundry/trueforge@$Version"
