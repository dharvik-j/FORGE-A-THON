# Competition requirements → implementation → verification

Source: `competition/brief.pdf` (Techfest 2026-27 TrueFoundry Forge-a-thon). Deadline **20 Nov 2026, 23:59 IST**. Status legend: ✅ implemented and verified · 🟡 implemented, awaiting end-to-end run with a configured model · ⬜ not done.

## Eligibility gate (pass/fail)

| Requirement (brief) | Implementation | Verification | Status |
|---|---|---|---|
| Extension is a client of a TrueForge agent; sessions/turns via HTTP API or TS SDK; renders streamed events | `src/core/trueforge.ts` (SDK 0.185.0), `runController.ts`, `agentPanel.ts` | real runs via `forge-cli run` (Task A, Task C) on Gemini through TrueForge | ✅ |
| Editor capabilities exposed as MCP tools; agent decides what to read/change | `src/core/mcpServer.ts`: retrieve_context, list_files, search_workspace, read_file, find_symbol, propose_file_change, list_pending_changes, submit_changes_for_review, run_command | `GET /api/v1/mcp-servers/forge-workspace/tools` through TrueForge lists all 9 tools (done); MCP client test in `test/core.test.ts` | ✅ |
| TrueForge in local mode (`npx @truefoundry/trueforge@latest`) | `scripts/start-trueforge.ps1` (pins 0.185.1, allows loopback) | server running at :8790 | ✅ |
| Model configured in TrueForge (catalog or OpenAI-compatible); extension never calls a provider | No provider SDK/URL in `src/`; agents reference `model.name` only | `grep` for provider hosts in `src/` → none | ✅ (models still to be added by the user) |
| Repo contains the agent definition | `trueforge/forge-agent.json`, `trueforge/instructions.md` | — | ✅ |
| Video shows the TrueForge session for Task B | "Open TrueForge session" button → `http://localhost:8790/sessions/<id>` | during recording | ⬜ |
| No upstream agent loop kept; fork point declared if forked | Written from scratch (README "Starting point") | — | ✅ |

## Mandatory capabilities and rubric anchors

| Rubric | Top anchor | Implementation | Verification | Status |
|---|---|---|---|---|
| A1 Inline edit (10) | diff rendered, per-hunk accept/reject | `forge.inlineEdit` (Ctrl+Alt+K, context menu) → agent stages edit → `vscode.diff` + review panel with per-hunk Accept/Reject | Task A run | 🟡 |
| A2 Agent mode (10) | discovers and edits ≥3 files unprompted | Agent panel; retrieval + search tools; multi-file staging; single review | Task B run; retrieval unit test selects cli.py, test_cli.py, docs/cli.rst | 🟡 |
| A3 Streaming & cancellation (10) | immediate cancel, workspace consistent | `model.message.delta` merge with `mergeEventDelta`; Cancel → `sessions.cancel`, abort stream, kill commands, drop staged edits | `forge-cli run --cancel-after N`, then `git status` | 🟡 |
| B1 Context assembly (15) | budgeted retrieval, strategy stated, visible in Task B | `retrieve_context` (idf scoring, co-location, budget, reasons) + CONTEXT RETRIEVAL card + `@file`/`@symbol:` pins | unit tests on Flask; visible in panel and session | ✅ code / 🟡 demo |
| B2 Diff safety (10) | per-hunk review + working undo on screen | `ProposalStore` (memory only), `applySelectedHunks`, stale-hash refusal, `Applier.undoLast` | unit tests for partial apply / CRLF / no-disk-writes; undo in the extension | 🟡 |
| B3 Resilience (10) | automatic fallback to a second model, workspace unchanged | `RunController`: `turn.done{error}` + provider-shaped message + nothing applied → new session on `forge-coder-fallback` | Task C with an invalid primary key | 🟡 |
| B4 TrueForge depth (10) | MCP tools + approval driving review + a context-engineering feature, explained and visible | `require_approval_for_tools: ["submit_changes_for_review"]` drives the review; deferred tool loading (`preload_tools`), subagents, compaction configured | session view shows approval pause, tool calls, threads | 🟡 |
| C1 Video (10) | A, B, C complete, legible, verified | `submission/demo-script.md` | recording | ⬜ |
| C2 Write-up (15) | architecture, context strategy, model setup, trade-offs, accurate timestamped scorecard, honest limitations | `submission/writeup.md` | after recording | ⬜ |

## Fixed tasks (exact wording, Flask 3.1.3 @ 22d92470)

| Task | Verification on screen | Status |
|---|---|---|
| A: select `get_debug_flag` in `src/flask/helpers.py`, instruction about 'off'/'n' + docstring | `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False` | ✅ headless on gemini-3.5-flash-lite: read → stage → approval pause → applied; off/OFF/n/N → False, 1/yes/on → True |
| B: `flask config` JSON with masking; in `--help`; test; docs; ≥3 files | `pytest tests/test_cli.py -q` passes; `flask config` shows `"***"` | ✅ headless: retrieval chose cli.py/test_cli.py/docs/cli.rst unprompted; 3 files staged, one review, +71/−0; agent ran pytest → 56 passed, 3 skipped; `flask --help` lists config; `flask config` on a demo app masks SECRET/PASSWORD/TOKEN/KEY, valid JSON |
| C: unreachable endpoint or invalid key, repeat A | editor responsive, clear message or automatic fallback, `git status` clean | ✅ headless: primary on 127.0.0.1:9 → "Cannot connect" → automatic fallback to gemini-3.1-flash-lite → diff; git status clean at review time |

Baseline: `pytest tests/test_cli.py -q` on the untouched checkout → 55 passed, 3 skipped (pytest 8.x; pytest 9 breaks Flask 3.1.3's test imports, so the setup script pins `pytest<9`).

## Submission artefacts

| Artefact | Requirement | Where | Status |
|---|---|---|---|
| Demo video | ≤ 4 min, A→B→C in order, each verified, TrueForge session shown in B, no cut between instruction and diff | `submission/demo-script.md` | ⬜ record |
| Write-up PDF | 1–3 pages, 8 headings in order | `submission/writeup.md` → PDF | ⬜ |
| GitHub repo | public, README setup from clean clone, how to start TrueForge and load the agent, example model config, LICENSE, no secrets | this repo | 🟡 (team must push; not done by FORGE) |

Out of scope per brief and not built: tab completion, fine-tuning/hosting models, hosted backend, accounts, Marketplace publishing.
