# Architecture

```
┌──────────────────────────── VS Code extension host ─────────────────────────────┐
│ src/extension                                                                    │
│   extension.ts   commands, status, inline edit, @mention parsing                 │
│   agentPanel.ts  sidebar webview: stream, tool cards, CONTEXT RETRIEVAL, cancel  │
│   reviewPanel.ts per-hunk review webview + vscode.diff of staged changes         │
│   applier.ts     WorkspaceEdit apply, stale-hash check, batch undo               │
│ src/core (no vscode dependency; also driven by src/cli/forge-cli.ts)             │
│   runController.ts  one run = session → streamed turn → pauses → done/error      │
│                     cancel, provider-failure classification, fallback attempt    │
│   trueforge.ts      adapter over @truefoundry/trueforge-sdk                       │
│   mcpServer.ts      MCP tools on http://127.0.0.1:3917/mcp (Streamable HTTP)     │
│   context.ts        budgeted retrieval    search.ts  search + symbol index       │
│   proposals.ts      staged edits, hunks, partial apply   commands.ts  run_command │
│   workspace.ts      root confinement, exclusions, secret filtering               │
└───────────────▲───────────────────────────────────────────────────▲──────────────┘
                │ SDK: sessions.create / createTurnStream /          │ MCP tools/call
                │ subscribeToTurn / createTurnEvents / cancel        │
┌───────────────┴───────────────────────────────────────────────────┴──────────────┐
│ TrueForge 0.185.1, local mode (SQLite) — agent loop, model calls, streaming,     │
│ tool approvals, subagents, deferred tool loading, compaction, Sessions UI        │
└───────────────────────────────────▲──────────────────────────────────────────────┘
                                    │ provider API (keys live only in TrueForge)
                               primary model / fallback model
```

## One agent-mode run

1. `sessions.create({ agent: { name: 'forge-coder' } })`, then `createTurnStream` with the user's request.
2. The agent calls `retrieve_context` (the panel shows the selected files, reasons and budget), then `search_workspace` / `find_symbol` / `read_file` as needed. Subagents may be spawned (`thread.created`).
3. The agent stages edits with `propose_file_change` (in memory, diff returned to the agent) for every file it needs.
4. It calls `submit_changes_for_review`, which is gated by `require_approval_for_tools`. TrueForge emits `tool.approval_required` and `turn.update{paused}`.
5. FORGE opens the review: a side-by-side diff plus per-hunk Accept/Reject. On Apply, accepted hunks go through one `WorkspaceEdit` (stale files are refused). FORGE stores the outcome, subscribes after the last event id, and sends `user.tool_approval` allow, or deny with reasons if everything was rejected.
6. TrueForge runs the tool. It returns the stored outcome (`APPLIED path: n/m hunks`, `REJECTED …`) so the agent knows the real state. The agent runs `pytest` via `run_command` and summarises.
7. `turn.done{done}` ends the run. On `turn.done{error}` with a provider-shaped message and nothing applied, FORGE clears staged edits and repeats steps 1–6 on `forge-coder-fallback`.

## Cancel

`RunController.cancel()` sets the cancelled flag, aborts the SSE stream and any open review, kills running commands, clears staged proposals, and calls `sessions.cancel(sessionId)`. Late events are ignored and fallback is never triggered by a cancel.
