# FORGE — an editor-native coding agent on TrueForge

## 1. Team

<!-- TODO(team): names, college/employer, GitHub handles. Not filled in by tooling. -->
| Member | College / employer | GitHub |
|---|---|---|
| _name_ | _affiliation_ | _@handle_ |

## 2. Starting point

From scratch. No upstream coding-agent project was forked. Built on the VS Code Extension API, the official TrueForge TypeScript SDK (`@truefoundry/trueforge-sdk` 0.185.0) and the MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32). Diffing uses `jsdiff` (BSD-3). TrueForge runs unmodified in local mode (v0.185.1).

## 3. Architecture on TrueForge

**How the extension talks to TrueForge.** The extension is an SDK client of a saved TrueForge agent (`forge-coder`). A run is `sessions.create({agent:{name}})` → `createTurnStream` (SSE). Streamed `model.message` + `model.message.delta` events are merged by id with `mergeEventDelta` and rendered as they arrive. Tool calls, `tool.response`, `thread.created/done` (subagents) and compaction events appear as cards in the panel. Cancel calls `sessions.cancel`.

**Editor capabilities as MCP tools.** The extension hosts an MCP server (Streamable HTTP on `127.0.0.1:3917`), registered in TrueForge as the connector `forge-workspace` through `POST /api/v1/settings/mcp-servers`. Tools: `retrieve_context`, `search_workspace`, `find_symbol`, `read_file`, `list_files`, `propose_file_change`, `list_pending_changes`, `submit_changes_for_review`, `run_command`. The agent decides what to read and change. The extension only serves the tools and the human checkpoint.

**Approvals drive the diff review.** `propose_file_change` only stages edits in memory. `submit_changes_for_review` is listed in the agent's `require_approval_for_tools`, so TrueForge pauses the turn with `tool.approval_required`. FORGE then:
1. opens the per-hunk review;
2. applies only accepted hunks through one `WorkspaceEdit`;
3. answers with `user.tool_approval` (allow, or deny with reasons when everything was rejected).

The tool result tells the agent exactly what reached disk. TrueForge approvals are all-or-nothing per call, so the per-hunk decision lives on our side of the checkpoint. We document this rather than pretend otherwise.

**Commands are approved too.** `run_command` is also in `require_approval_for_tools`. FORGE checks the command against a narrow policy (test and check programs only; no `python -c`, `node` or `npx`; no secrets files; no cmd.exe metacharacters), then asks the user in a modal dialog. The MCP server runs a command only with a one-shot token from that approval. The endpoint also rejects non-loopback `Host` headers and browser `Origin` headers, which blocks DNS rebinding.

**Harness features used.**
- Deferred tool loading: core tools in `preload_tools`, the rest discovered through TrueForge's `list_tools`/`call_tool`.
- Dynamic subagents, enabled.
- Context compaction at 40k input tokens.
- The Sessions UI is used as the audit trail.

The agent definition is `trueforge/forge-agent.json` + `trueforge/instructions.md`.

**Findings that shaped the design.**
- TrueForge's outbound guard blocks loopback by default. We start it with `OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1","localhost"]`.
- Its 20 s model header timeout is too short for "thinking" models, so we raise `MODEL_HTTP_HEADERS_TIMEOUT_MS`.
- MCP connectors are remote-only, so the server lives in the extension host.

## 4. How context is selected

Retrieval is a tool the agent calls first (`retrieve_context`), so the choice is visible in the session and the agent can read further.
- **Terms.** The request is split into identifier words (snake/camel case), with stop- and intent-words removed and light stemming.
- **Candidates.** All indexable files. VCS, venvs, build output, binaries and secrets are excluded.
- **Scoring.** idf-weighted term frequency, plus path-token matches, plus symbols defined with requested names, scaled by query coverage.
- **Co-location boost.** Tests and docs that share the best source file's module name get a boost (`cli.py` → `test_cli.py`, `cli.rst`).
- **Required categories.** One test file and one doc file are included when the request asks for tests or documentation.

**Budget.** The default is 6,000 tokens (configurable). It is estimated as characters/4 and labelled as an estimate. It is shared in proportion to score. Within a file, top lines expand to their enclosing function or class (≤ 45 lines) or ±4 lines, and windows are dropped lowest-priority-first when over budget.

**Output.** Candidates scanned, the chosen files with *why*, line ranges, and tokens used vs budget. The panel renders this as the CONTEXT RETRIEVAL card.

`@file` / `@symbol:` mentions become pinned inputs that are always included. Measured on Flask 3.1.3, the Task B request yields <!-- fill from run --> as the top files out of 174 candidates within the budget.

## 5. Model setup

| Role | Model | Where it ran | Approx. cost |
|---|---|---|---|
| Primary | Google Gemini `gemini-3.5-flash-lite` (TrueForge catalog provider `google-gemini`) | Google AI Studio API, free tier | $0 (free tier; limits: 250k input tokens/min observed) |
| Fallback | Google Gemini `gemini-3.1-flash-lite` (same catalog provider, separate model and quota) | Google AI Studio API, free tier | $0 |
| Task C failure | TrueForge custom provider `unreachable-endpoint` → `http://127.0.0.1:9/v1` (`scripts/taskc.ps1 -Break`) | nowhere (connection refused) | — |

Keys live only in TrueForge (Settings → Models). The extension stores model names, never keys, and never calls a provider. To switch models, run **FORGE: Set up TrueForge** and pick from TrueForge's model list; it re-saves `forge-coder` / `forge-coder-fallback`.

**Resilience.**
- *Rate limits:* when a turn ends on a provider rate limit (429 / "retry in N s"), FORGE waits and continues **the same session**, keeping history and staged edits. This is retry with backoff.
- *Fallback:* when a turn ends in a provider error and nothing was applied, FORGE clears staged edits and re-runs the request on `forge-coder-fallback`, a second model, with no user action. User cancellation never triggers fallback.

Larger Gemini models (`gemini-3.5-flash`, `gemini-flash-latest`) returned 503 "high demand" or timed out on the free tier during development, so flash-lite is the primary.

## 6. Scorecard

<!-- Fill timestamps from the final recording only. -->
| Criterion | Video | Claim |
|---|---|---|
| A1 Inline edit | mm:ss | Diff rendered in the editor; hunks accepted individually in the review panel |
| A2 Agent mode | mm:ss | One request; agent found and changed cli.py, test_cli.py, docs/cli.rst unprompted |
| A3 Streaming & cancellation | mm:ss | Tokens stream from TrueForge events; Cancel stops the turn, `git status` unchanged |
| B1 Context assembly | mm:ss | CONTEXT RETRIEVAL card: files chosen with reasons, ranges, ~tokens / budget |
| B2 Diff safety | mm:ss | Per-hunk review; nothing on disk before Apply; Undo Last Apply reverts the batch |
| B3 Resilience | mm:ss | Invalid primary key → automatic fallback agent → diff; `git status` clean before accept |
| B4 TrueForge depth | mm:ss | MCP tools; approval pause drives review; deferred tool loading / subagents visible in session |
| C1 Video | — | Tasks A, B, C in order, each verified on screen |
| C2 Write-up | — | This document |

## 7. Tools used

- VS Code, Node.js 24, TypeScript, esbuild, vitest.
- TrueForge 0.185.1 (local mode), `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, jsdiff, zod.
- Python 3.14 + pytest 8 for Flask.
- **AI coding assistant:** Claude Code (Anthropic) was used to research the TrueForge source and docs, write the code, and run the tests.

## 8. Known limitations and what another month would do

- Fallback detection is based on the failed turn's error message. An unusual provider message would show as an error without fallback.
- Retrieval tokens are estimated (chars/4). Symbols use indentation/regex extraction, not a parser.
- Free-tier models are small. On Task B they sometimes make an edit that drops neighbouring code. The review shows it as red lines, but we rely on the human (and the post-apply test run) to catch it.
- One VS Code window per MCP port.
- Sandbox-only TrueForge features (Skills, Code Mode, large-response offloading) are unavailable on Windows without Daytona, so they are not used.
- *Another month:*
  - tree-sitter symbols and a reference graph for retrieval;
  - embedding-based reranking within the same budget;
  - a TrueForge-side model-fallback contribution (a `fallback_models` field in the agent spec) instead of client-side fallback;
  - inline (in-editor) hunk widgets in place of a review webview;
  - automatic syntax and test checks of staged changes before review.
