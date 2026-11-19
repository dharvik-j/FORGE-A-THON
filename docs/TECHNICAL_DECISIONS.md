# Technical decisions

Everything below was verified against TrueForge **v0.185.1** (server, `npx @truefoundry/trueforge@0.185.1`), the TypeScript SDK **`@truefoundry/trueforge-sdk@0.185.0`**, the TrueForge repository at commit `bc1b5894` (docs in `docs/`, source in `packages/`), and `@modelcontextprotocol/sdk@1.32.2`.

## Architecture in one paragraph

The VS Code extension is a **client** of a saved TrueForge agent and, in the same process, the **host of a Streamable-HTTP MCP server** (`forge-workspace`, `http://127.0.0.1:3917/mcp`) that exposes the open folder as tools. TrueForge owns the loop: model calls, tool calling, streaming, session state, approvals, subagents and compaction. The extension never calls a model provider. File edits are only **staged** by a tool; the gated tool `submit_changes_for_review` pauses the TrueForge turn (`tool.approval_required`), the extension opens a per-hunk review, applies only accepted hunks through `WorkspaceEdit`, and answers the approval (`user.tool_approval` allow/deny). The agent then learns exactly what was applied from the tool result.

## Verified TrueForge integration surface

| Purpose | SDK call / endpoint | Verified in |
|---|---|---|
| Connectivity, model list | `client.models.list()` → `GET /api/v1/models` | `docs/openapi.json`, SDK `resources/models` |
| Register the MCP connector | `client.settings.mcpServers.create/createOrUpdate({ manifest: { type: 'remote', name, url, description } })` → `POST/PUT /api/v1/settings/mcp-servers` | `docs/openapi.json` (`RemoteMCPServerManifest`) |
| Save agents (primary/fallback) | `client.agents.create({ name, description, manifest })`, `client.agents.update(id, …)`, `client.agents.list()` | SDK `CreateAgentRequest`, `docs/create-agent/overview.mdx` |
| Open a session | `client.sessions.create({ agent: { name } , title })` | `docs/api/use-agent.mdx` §Sessions |
| Stream a turn | `client.sessions.createTurnStream(id, { input: [{ type: 'user.message', content }] })` | `docs/api/quickstart.mdx` |
| Merge streamed tokens | `isEventDelta`, `mergeEventDelta` (deltas share the base `model.message` id) | `docs/api/overview.mdx` §Delta, SDK `events.d.ts` |
| Pause for approval | events `tool.approval_required` → `turn.update {status:'paused'}` | `docs/api/use-agent.mdx` §Handle pauses |
| Answer approval | `subscribeToTurn(id, turnId, { afterEventId })` **then** `createTurnEvents(id, turnId, { events: [{ type: 'user.tool_approval', threadId, toolCallId, approval: { status: 'allow' } \| { status: 'deny', reason } }] })` | same; SDK `UserToolApprovalInputEvent` |
| Cancel | `client.sessions.cancel(sessionId)` → `POST /api/v1/sessions/{id}/cancel`; aborts the model request, waits for in-flight MCP calls, ends with `turn.done {status:'cancelled', reason:'client-cancelled'}` | `docs/api/use-agent.mdx` §Cancel a turn |
| Terminal state | `turn.done.state.status` ∈ `done` / `cancelled` (with `reason`) / `error` (with `message`) | `docs/api/use-agent.mdx` §turn.done, SDK `TurnStateError` |
| Subagents | `config.dynamic_sub_agents.enabled` (default on); `thread.created` / `thread.done` events, `thread_id` on every event | `docs/key-features/subagents.mdx` |
| Deferred tool loading | `mcp_servers[].preload: false` + `preload_tools: [...]`; deferred tools are reached through `list_tools` / `get_tool_info` / `call_tool` meta tools | `docs/key-features/deferred-tool-loading.mdx` |
| Compaction | `config.context_management.compaction` with `trigger: { type: 'input_tokens', value }`; events `thread.context_compaction_started/finished` | `docs/create-agent/overview.mdx`, SDK `TurnStreamingEvent` |

### Findings that shaped the design (not in the brief or obvious from docs)

1. **Localhost is blocked by default.** TrueForge's outbound guard (`packages/trueforge-core/src/core/util/ssrfGuard.ts`) denies `127.0.0.0/8` and `.localhost` for MCP and model traffic unless `OUTBOUND_URL_ALLOWED_HOSTS` lists them. FORGE's launch scripts start TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`. Verified: after that, `GET /api/v1/mcp-servers/forge-workspace/tools` lists all FORGE tools.
2. **MCP transport is remote only** (`streamable-http` or `sse`, see `mcp.initialize` event docs). There is no stdio launch, so the MCP server runs inside the extension host on 127.0.0.1 and is registered by URL.
3. **Approvals are all-or-nothing per tool call** (`allow` or `deny` + reason, no argument rewriting). Per-hunk review is therefore implemented on our side of the checkpoint: the user's per-hunk decisions are applied by the extension, then the call is allowed; if every hunk is rejected the call is denied with the reasons. The MCP tool reports exactly what happened back to the agent. If someone approves the call from the TrueForge UI instead, the tool writes nothing (there is no review outcome to apply).
4. **There is no model fallback in TrueForge.** The agent spec has a single `model`; `docs/models.mdx` lists automatic model selection as *planned*. TrueForge does retry model HTTP calls (`MODEL_HTTP_MAX_RETRIES=2`, exponential backoff from 1 s with jitter, for 408/429/503 and connect timeouts — `outboundFetch.ts`, `ssrfGuard.ts`). FORGE adds fallback at the client: two saved agents (`forge-coder`, `forge-coder-fallback`) on different models; when a turn ends `error` with a provider-shaped message and nothing was applied, a new session on the fallback agent runs the same request.
5. **Sandbox-only features are out of reach locally on Windows.** Skills, Code Mode and large-tool-response offloading require a sandbox; the only provider is Daytona (cloud), and the local sandbox fallback is macOS/Linux only (server log: `LocalSandboxProvider supports macOS and Linux only`). FORGE disables `large_tool_response` and caps tool output itself.
6. **The SDK and settings API can create connectors and agents**, so setup is scripted (`FORGE: Set up TrueForge`, `npm run setup:trueforge`). Model providers (API keys) are entered by the user in TrueForge's UI; FORGE never sees keys.
7. Only one turn is active per session and a new message cancels the running one, so every FORGE run uses its own session.

## Context strategy

`retrieve_context` (MCP tool, `src/core/context.ts`) is the first call of every run:

1. Terms: identifiers and words from the request, split on snake/camel case, stop- and intent-words removed, light stemming.
2. Candidates: every indexable file (excludes VCS, venvs, build output, binaries, secrets). Each file is tokenised the same way.
3. Score: Σ idf(term) · log2(1 + count) + 4·idf for path-token hits + 3 per defined symbol named in the request, scaled by query coverage. Changelogs are down-weighted.
4. Co-location: tests/docs sharing a module name with the best source file (`cli.py` → `test_cli.py`, `cli.rst`) are boosted, because a change to a module must keep its tests and docs in step.
5. Diversity: the best source file is always taken; the best test file / doc file are added when the request asks for tests / documentation; then anything above 35 % of the top score, up to 6 files.
6. Budget: a token budget (default 6 000, setting `forge.contextBudgetTokens`, estimated at 4 chars/token and stated as an estimate) is shared in proportion to score. Within a file the highest-scoring lines are expanded to their enclosing function/class (≤ 45 lines) or ±4 lines, merged, and dropped lowest-priority-first when over budget.
7. Output: candidate count, chosen files with *why* (path match, co-location, defined symbols, top term counts), line ranges, and tokens used vs budget. The extension shows this as the CONTEXT RETRIEVAL card; the same text is in the TrueForge session as the tool response.

`@path/to/file` and `@symbol:name` in the agent panel become `pinned_files` / `pinned_symbols`, which are always included first.

Unit-tested on Flask 3.1.3: for the Task B request the retriever selects `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst` within budget, without being told any path.

## TrueForge context-engineering features used

- **Deferred tool loading**: the core seven tools are listed in `preload_tools`; `list_files` and `list_pending_changes` stay deferred and are reached through TrueForge's `list_tools`/`call_tool` meta tools when needed. FORGE unwraps `call_tool` events so the UI and approval logic see the real tool.
- **Subagents** are enabled; the instructions allow delegating broad exploration, and `thread.created`/`thread.done` are rendered in the panel and visible in the TrueForge session.
- **Compaction** is enabled with an explicit 60 000-token trigger; compaction events are surfaced in the panel.

## Diff safety

- Proposals live in memory (`ProposalStore`) with the original text and a SHA-256 base hash. Nothing writes to disk except the extension's `Applier` after the user decides.
- Hunks come from `diff.structuredPatch` (3 lines of context); accepted subsets are applied with `diff.applyPatch` on the original text. CRLF files keep CRLF.
- Before applying, the current editor/disk text is re-hashed; a changed file is reported as stale and never overwritten.
- Applying is one `WorkspaceEdit` across all files, saved afterwards. Each batch is recorded; **FORGE: Undo Last Apply** reverts the whole batch (and deletes files it created) if the files are still as FORGE left them. Ctrl+Z also works per file.
- Cancel aborts the stream, closes the review (dismissed), kills running commands, clears staged proposals, and calls `sessions.cancel`. Because staging never touches disk, a cancelled run leaves the workspace unchanged.

## run_command policy

Every command needs the user's approval, enforced at three points:

1. **TrueForge.** `run_command` is in the agent's `require_approval_for_tools`, so TrueForge pauses the turn before the tool runs.
2. **The editor.** The run controller checks the command against the policy below, then asks the user in a modal dialog: **Run once**, **Allow this command for this task**, or close the dialog to deny. Only then does it answer `user.tool_approval`. The headless CLI denies commands unless you pass `--commands allow`.
3. **The MCP server.** An approval is a one-shot token for that exact command line. `run_command` refuses any call without a token, including a call that reaches the MCP port from somewhere other than an approved TrueForge turn.

**Policy (defence in depth, checked before the user is asked):**
- Argv is parsed with quote handling and no shell.
- **Programs:** `pytest`; `python`/`py` only as `-m pytest|unittest|flask|mypy|ruff` or `--version` (no `-c`, scripts or other modules); `flask` (an `--app`/`FLASK_APP` value may not contain call arguments, because Flask evaluates `module:factory(args)`); read-only `git` subcommands, without `--output`, `-O`, `--ext-diff` or `--textconv`; `npm test`/`npm run`; `ruff check` (not `--fix` or `format`); `mypy`. `node`, `npx` and `tox` are not allowed.
- **Environment:** the agent may only set `FLASK_*`, `PYTEST_ADDOPTS`, `CI`, `NO_COLOR`, `PYTHONHASHSEED`, `PYTHONWARNINGS` and `TZ`.
- **Secrets files:** any argument that names one (`.env`, `HEAD:.env`, keys, credentials) is refused.
- **Windows `.cmd` shims:** `npm.cmd` has to run through cmd.exe, so every argument must be a plain token, with no spaces or `& | < > ^ % " ( ) , ; =`.
- **Other limits:** installs and deletions are refused, and the workspace `.venv` is used automatically. Timeout is 120 s by default (600 s maximum), output is capped at 12 000 characters per stream, and process trees are killed on timeout or cancel (`taskkill /T /F` on Windows).

**The MCP endpoint** (`127.0.0.1:3917`) accepts only a loopback `Host` (`127.0.0.1`, `localhost` or `[::1]` with the server's port) and no `Origin` header. This blocks DNS-rebinding and cross-site requests from web pages: TrueForge calls the endpoint server-side, so it sends neither.

**Residual risk:** another process running as the same user can still call the read-only tools and stage proposals. Proposals only reach disk through the review panel.

## Alternatives rejected

- **Forking Cline/Continue/Roo**: their agent loops are deeply coupled to their UIs; removing them would cost more than writing a focused UI on VS Code's own diff editor and webviews.
- **Extension-side prompt stuffing**: putting retrieved code into the prompt would hide context selection from the harness. Retrieval is a tool the agent calls, so it is visible in the session and the agent decides to read more.
- **Gating `propose_file_change` itself**: that would pause the turn once per file and could leave a half-reviewed multi-file change on cancel. Staging all files and reviewing once keeps multi-file changes atomic.
- **stdio MCP**: not supported by TrueForge's connector model.

## Lessons from real runs (Gemini free tier, Flask 3.1.3)

| Observation | Change |
|---|---|
| `gemini-flash-latest` / `gemini-3.5-flash` exceeded TrueForge's 20 s model header timeout (thinking before the first byte) | Start TrueForge with `MODEL_HTTP_HEADERS_TIMEOUT_MS=120000` (start scripts) |
| Free tier: 250k input tokens/min, 503 "high demand", dropped connections (`ECONNRESET`) mid-task | Transient failures resume **the same session** (turns chain, staged edits kept) with backoff honouring "retry in N s"; only persistent provider failures (401, unreachable endpoint, exhausted retries) fail over to the fallback agent |
| After staging, the model re-read the file, saw the disk version, and its next edit no longer matched | `read_file` returns the staged text (labelled) when a change is pending |
| The model replaced a sibling's decorator line instead of inserting before it, and once tried `content: "# full rewrite"` on an existing file | `content` is refused for existing files; tool description and instructions explain that `old_string` text not repeated in `new_string` is deleted |
| A weak model deleted unrelated imports | `propose_file_change` reports lines a change deletes without re-adding them (`WARNING: … DELETES n existing line(s)`), and the review panel tags such hunks "deletes n existing line(s)" |
| Agent passed a paraphrase to `retrieve_context` and got weaker results | Instructions: pass the user's request verbatim; exploration budget (~8 reads) before staging |

## Known limitations

- Fallback detection relies on the error message of a failed turn; a provider failure with an unusual message would be shown as an error without fallback.
- Token counts in retrieval are estimates (chars/4); TrueForge's own per-turn token metrics are shown from `turn.done.metrics`.
- Symbol extraction is regex/indentation based (Python, JS/TS), not a full parser.
- One VS Code window per MCP port; a second window needs a different `forge.mcpPort` and a re-run of setup.
