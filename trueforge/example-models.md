# Example model configuration (no secrets)

Models are configured **in TrueForge**, never in FORGE. FORGE only stores model *names* (`forge.primaryModel`, `forge.fallbackModel`) and the saved agent names.

| Role | TrueForge provider | Where to get a key | Example model id (as listed by `GET /api/v1/models`) |
|---|---|---|---|
| Primary | Google Gemini (catalog) | https://aistudio.google.com/apikey (free tier) | `<provider-name>/gemini-2.5-flash` |
| Fallback | Custom, OpenAI-compatible | https://console.groq.com/keys (free tier); base URL `https://api.groq.com/openai/v1` | `<provider-name>/llama-3.3-70b-versatile` |
| Alternative | Any catalog provider (OpenAI, Anthropic, …) or a local server behind an OpenAI-compatible URL | — | `<provider-name>/<model>` |

A local OpenAI-compatible server (Ollama, vLLM, LM Studio) on `localhost` needs TrueForge started with `OUTBOUND_URL_ALLOWED_HOSTS` including that host (the FORGE start scripts already allow `127.0.0.1` and `localhost`).

After adding providers, run **FORGE: Set up TrueForge** in VS Code (or `node dist/forge-cli.js setup --primary-model <id> --fallback-model <id>`). It saves:

- `forge-coder`: `trueforge/forge-agent.json` + `trueforge/instructions.md` with `model.name = <primary>`
- `forge-coder-fallback`: the same spec with `model.name = <fallback>`

To switch models later, re-run the setup command and pick different models. Nothing in the extension changes.
