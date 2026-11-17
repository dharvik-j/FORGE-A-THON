#!/usr/bin/env bash
# Starts TrueForge in local mode with loopback allowed for outbound calls (needed to reach FORGE's MCP server).
set -euo pipefail
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
export MODEL_HTTP_HEADERS_TIMEOUT_MS="${MODEL_HTTP_HEADERS_TIMEOUT_MS:-120000}"
export PORT="${PORT:-8790}"
exec npx -y "@truefoundry/trueforge@${TRUEFORGE_VERSION:-0.185.1}"
