# FORGE -  EditorNative Coding Agent on TrueForge

FORGE is a VS Code extension whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge) (TrueFoundry's open-source agent harness), built for the Techfest 2026-27 TrueFoundry Forge-a-thon, Round 1.

- **Inline edit** (`Ctrl+Alt+K`): select code, describe the change, review the diff hunk by hunk, apply.
- **Agent mode** (FORGE sidebar): one request drives a TrueForge agent through a tool loop that retrieves context, reads, searches, stages multi-file edits, asks for review, and runs tests.
- **Context assembly**: budgeted, explainable repository retrieval as an MCP tool, plus `@file` / `@symbol:` pins.
- **Diff review**: every change is staged, shown per hunk with accept/reject, applied with `WorkspaceEdit`, and undoable as a batch.
- **Streaming and cancellation**: tokens and tool activity stream from TrueForge events; Cancel stops the TrueForge turn, kills running commands, and drops staged edits.
- **Resilience**: when the primary model fails, the same request is re-run automatically on a fallback agent configured with a different model.

**Starting point:** written from scratch on the VS Code Extension API, the official TrueForge TypeScript SDK and the MCP TypeScript SDK. No upstream coding-agent project was forked.

## How it fits together

```
VS Code extension ──SDK (HTTP+SSE)──▶ TrueForge (local mode, agent loop, model calls, approvals, subagents)
   ▲  hosts MCP server (127.0.0.1:3917/mcp) ◀──MCP Streamable HTTP── tool calls
   │  review panel + WorkspaceEdit apply/undo
   └── the folder open in VS Code (e.g. Flask 3.1.3)
```

The extension never calls a model provider. Models and keys are configured only in TrueForge. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/TECHNICAL_DECISIONS.md](docs/TECHNICAL_DECISIONS.md).

## Quick start (Windows)

Install first: [Node.js](https://nodejs.org) ≥ 22.14, [Git](https://git-scm.com), [Python 3](https://www.python.org) (with the `py` launcher), [VS Code](https://code.visualstudio.com) ≥ 1.95 (with "Add to PATH"). Then, in PowerShell:

```powershell
git clone https://github.com/dharvik-j/FORGE-A-THON.git forge
cd forge
powershell -ExecutionPolicy Bypass -File setup.ps1    # once: packages, build, Flask demo repos
powershell -ExecutionPolicy Bypass -File start.ps1    # every time: TrueForge + VS Code with FORGE loaded
```

Then do the two steps no script can do for you, because they need your own API keys:
1. In TrueForge (it opens at http://localhost:8790): **Settings → Models**, add two models (see [step 2](#2-configure-two-models-in-trueforge)).
2. In the VS Code window that opened: `Ctrl+Shift+P` → **FORGE: Set up TrueForge**, pick the two models.

Now try [the tasks](#fixed-competition-tasks). For Task C, open the clean checkout with `start.ps1 flask-taskc`. The sections below explain each step in detail.

## Just the extension: one file

[`release/forge-agent-0.1.0.vsix`](release/forge-agent-0.1.0.vsix) is the whole extension, already built, in one file (~350 KB). No Node build is needed to use it.

1. Install it: in VS Code, open Extensions → `⋯` menu → **Install from VSIX…** and pick the file. Or run `code --install-extension forge-agent-0.1.0.vsix`.
2. Start TrueForge (Node.js needed) in PowerShell, and leave it running. The first line lets TrueForge reach FORGE on 127.0.0.1:
   ```powershell
   $env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'; $env:MODEL_HTTP_HEADERS_TIMEOUT_MS='120000'
   npx -y @truefoundry/trueforge@0.185.1
   ```
3. Add two models in TrueForge, then run **FORGE: Set up TrueForge** in VS Code.
4. Open any project folder. FORGE appears in the left bar.

Use one VS Code window at a time: the first window running FORGE takes port 3917. To uninstall, use the Extensions view.

## Setup from a clean clone, step by step (Windows PowerShell)

Prerequisites: Node.js ≥ 22.14, Git, Python 3 (`py` launcher), VS Code ≥ 1.95.

```powershell
git clone https://github.com/dharvik-j/FORGE-A-THON.git forge; cd forge
npm install
npm run build
```

### 1. Start TrueForge locally

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-trueforge.ps1
```

This runs `npx @truefoundry/trueforge@0.185.1` with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`. TrueForge blocks loopback addresses for outbound MCP/model traffic by default, and FORGE's MCP server lives on 127.0.0.1. Leave it running and open http://localhost:8790.

(macOS/Linux: `scripts/start-trueforge.sh`.)

### 2. Configure two models in TrueForge

In TrueForge: **Settings → Models**.
- Primary: e.g. **Google Gemini** (a free key from Google AI Studio) → Configure → paste key → Create.
- Fallback: a different provider, e.g. **Add custom provider** → base URL `https://api.groq.com/openai/v1`, a Groq key, model `llama-3.3-70b-versatile`. Any OpenAI-compatible endpoint works, including a local one.

Keys stay in TrueForge. See [trueforge/example-models.md](trueforge/example-models.md).

### 3. Get the demo repository

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-flask.ps1          # workspaces\flask  (Tasks A and B)
powershell -ExecutionPolicy Bypass -File scripts\setup-flask.ps1 -Name flask-taskc   # clean checkout for Task C
```

This clones `pallets/flask`, checks out tag `3.1.3` (commit `22d92470`), verifies the commit, and creates `.venv` with Flask (editable) and `pytest<9`.

### 4. Launch the extension and connect it

Open this folder in VS Code and press **F5** (configuration "Run FORGE on Flask demo"). A second VS Code window opens on `workspaces/flask` with FORGE loaded. Then, in that window:

1. Command Palette → **FORGE: Set up TrueForge**. Pick the primary and fallback models. This:
   - registers the MCP connector `forge-workspace` → `http://127.0.0.1:3917/mcp` (`POST /api/v1/settings/mcp-servers`);
   - saves the agents `forge-coder` and `forge-coder-fallback` from [trueforge/forge-agent.json](trueforge/forge-agent.json) + [trueforge/instructions.md](trueforge/instructions.md) (`POST /api/v1/agents`).
2. Open the **FORGE** activity-bar icon. The status line should read `TrueForge … · agent forge-coder · fallback forge-coder-fallback`.

Headless alternative (same code, no editor), for example to register the agents from a terminal:

```powershell
node dist\forge-cli.js setup --primary-model "<provider>/<model>" --fallback-model "<provider>/<model>"
```

Model ids are listed by `curl http://localhost:8790/api/v1/models`.

Re-run setup whenever `trueforge/forge-agent.json` or `trueforge/instructions.md` changes, so TrueForge has the current agent spec. Until you do, an old spec without the `run_command` gate makes every agent command fail with "not approved". That failure is safe: nothing runs.

**Commands need your approval.** When the agent wants to run something (normally the tests), VS Code shows a modal dialog with the exact command line: **Run once**, **Allow this command for this task**, or close it to deny. Only test and check programs are allowed; see [docs/TECHNICAL_DECISIONS.md](docs/TECHNICAL_DECISIONS.md#run_command-policy). In the headless CLI, commands are denied unless you pass `--commands allow`.

## Using it

| Action | How |
|---|---|
| Inline edit | Select code → `Ctrl+Alt+K` (or right-click → FORGE: Inline Edit Selection) → type the instruction |
| Agent mode | FORGE sidebar → type a request → `Ctrl+Enter` |
| Pin context | `@src/pkg/file.py` or `@symbol:function_name` in the request |
| Review | The review panel opens beside a side-by-side diff. Accept/Reject each hunk (or a whole file, or all), then **Apply** |
| Undo | **FORGE: Undo Last Apply** (reverts every file of the last applied batch), or `Ctrl+Z` per file |
| Cancel | **Cancel** in the panel, the notification's Cancel button, or `Ctrl+Alt+Esc` |
| See the TrueForge session | “Open TrueForge session” in the panel, or **FORGE: Open TrueForge Session** |

## Fixed competition tasks

Run these inside `workspaces\flask`, using its venv: `.\.venv\Scripts\Activate.ps1`.

**Task A — inline edit.** Open `src/flask/helpers.py`, select `get_debug_flag`, press `Ctrl+Alt+K`, and enter:
> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Review and accept the hunks. Verify:
```powershell
$env:FLASK_DEBUG='off'; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"   # False
```
(In Git Bash the brief's exact command works: `FLASK_DEBUG=off python -c "…"`.)

**Task B — agent mode.** In the FORGE panel, with no files mentioned:
> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

Watch the CONTEXT RETRIEVAL card, review the hunks across files, apply. Verify with `pytest tests/test_cli.py -q`, `flask --help`, and `flask --app <any app> config`.

**Task C — resilience.** Point the primary agent at an unreachable endpoint. The fallback keeps a working model.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\taskc.ps1 -Break -Fallback google-gemini/gemini-3-1-flash-lite
```

This creates a TrueForge custom provider `unreachable-endpoint` (`http://127.0.0.1:9/v1`) if needed and re-saves `forge-coder` on it. Repeat Task A in a clean checkout (`workspaces\flask-taskc`). FORGE shows "Primary model failed (… Cannot connect to API …). Retrying with configured fallback agent" and the fallback session produces the diff. `git status` stays clean until you accept. Afterwards:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\taskc.ps1 -Restore -Primary google-gemini/gemini-3-5-flash-lite -Fallback google-gemini/gemini-3-1-flash-lite
```

(Breaking a key instead also works: an invalid key gives `401` and triggers the same fallback.)

## Development

```powershell
npm run typecheck     # tsc strict
npm test              # vitest: workspace safety, search/symbols, retrieval on Flask, proposals/hunks, command policy, MCP over HTTP
npm run build         # esbuild → dist/extension.js, dist/forge-cli.js
npm run package       # VSIX (not published)
```

Repository layout: `src/core` (editor-independent: workspace access, search, retrieval, proposals, commands, MCP server, TrueForge adapter, run controller), `src/extension` (VS Code UI: panel, review, applier, commands), `src/cli` (headless harness), `trueforge/` (agent definition and instructions), `scripts/`, `test/`, `docs/`, `submission/`.

## Licence and attribution

MIT (see [LICENSE](LICENSE)). Built on the TrueForge SDK (MIT, TrueFoundry), `@modelcontextprotocol/sdk` (MIT), `diff`/jsdiff (BSD-3-Clause), and `zod` (MIT). The Flask repository used for the demo is BSD-3-Clause and is not part of this repository.
