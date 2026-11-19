# FORGE — Final Audit Report

Audit date: 19 Nov 2026. Auditor: Claude Code (Opus 5.5), acting on the team's audit brief.
Scope: the FORGE repository (`C:\Users\dharv\FORGE`), its Git history, build output, the packaged VSIX, the local TrueForge instance's public-facing behaviour, and the two Flask checkouts under `workspaces/`.

Rules followed during the audit: nothing was pushed, published, deleted, rotated or rewritten. No secret values were printed. All scans ran locally; the only outbound call was `npm audit`, which sends dependency names and versions from `package-lock.json` to the npm registry. Live runs used the scratch checkout `workspaces/flask-dev` and dummy credentials. The TrueForge model and agent configuration was read but not changed.

Changes this audit made outside the report:
- Rebuilt `dist/`, which is gitignored.
- Applied the Task A and Task B live runs to the scratch checkout `workspaces/flask-dev`, saved their diffs, then reverted them.
- Wrote throwaway files to the session scratchpad.

---

## 1. Executive summary

**Status: READY AFTER REMEDIATION**

**Secrets:** no API key, token, password or private key was found in:
- the working tree or the single commit;
- the build output or the packaged VSIX;
- the TrueForge log.

The repository has **no remote** and has never been pushed, so nothing is public yet. Provider keys are stored by TrueForge outside the project (`%LOCALAPPDATA%\trueforge`), and its API returns them masked.

**What must be fixed before the repository goes public:**
1. **Personal email in the commit.** Commit `051f7fc`'s author field is a personal Gmail address, different from the one in the competition material. Pushing would publish it.
2. **Three HIGH security findings, each reproduced by a live probe.**
   - The agent's `run_command` tool can run arbitrary code with no user approval. This bypasses the "never silently modify files" guarantee and the secrets-file protection.
   - On Windows, `npm`/`npx` arguments can inject cmd.exe commands.
   - The local MCP endpoint accepts requests with any `Host` header and has no authentication. A web page using DNS rebinding, or any local process, could drive the tools while VS Code is open.
3. **Task B is unreliable on the currently configured models.** Today's live run with `gemini-3-5-flash-lite` ended correctly, but only after 4 review cycles in 4 min 42 s. The first cycle offered a `flask config` that crashed. That is too slow and too fragile for a 4-minute video.

**What works, verified live through TrueForge today:**
- Task A: correct behaviour on every value tested.
- Multi-file retrieval: Task B found `cli.py`, `test_cli.py` and `docs/cli.rst` without being told.
- Per-hunk review, rate-limit resume in the same session, and git status clean at review time.
- Clean-clone install, build, unit tests and VSIX packaging all pass.

---

## 2. Competition completion scorecard

| Requirement | Status | Evidence |
|---|---|---|
| TrueForge agent execution | PASS | No direct provider calls: a search of `src/` found no OpenAI, Anthropic or Google endpoints or SDKs, and the only HTTP targets are TrueForge (`localhost:8790`) and FORGE's own MCP server. Live sessions today: `01m7r15eqhfawyskz448cfbdm0` (Task A) and `01m7r1tdffcefp6zw9va43zz67` (Task B). |
| MCP integration | PASS | The `forge-workspace` connector serves 9 tools; TrueForge listed them in both live runs. Deferred loading worked (`list_tools` was called). |
| Inline edit | PARTIAL | The live inline-edit message (the same text the extension builds) produced a correct 1-hunk diff. The keybinding and selection capture are covered by the VS Code integration suite, but nobody has walked through them on screen. |
| Autonomous multi-file agent | PASS (quality caveat) | From the one task sentence, the agent staged `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst` with no file named, ran the tests, and fixed its own bug. The first implementation was wrong (see Task B). |
| Context retrieval | PASS | Live: 6 of 174 candidates selected, ~5271 of 6000 tokens, with per-file reasons. Exclusions and refusal of secrets files are unit-tested and probed (`read_file .env` refused). `@file` and `@symbol` are unit-tested only. |
| Diff review | PASS | Real unified hunks come from jsdiff. Integration checks pass: staging never touches disk; partial apply goes through `WorkspaceEdit`; stale proposals are refused. The review UI has not been checked by eye. |
| Per-hunk acceptance/rejection | PASS | Integration check "per-hunk apply writes only the accepted hunk", plus unit tests for partial hunks. |
| Undo | PASS | Integration check "undo restores the batch"; undo refuses if a file was edited after apply. |
| Streaming | PASS | Live runs streamed `model.message.delta`, tool calls and results. |
| Cancellation | PASS (prior run) | The server-side turn ended `cancelled (client-cancelled)` on 18 Nov. Today, the unit test checks that cancel calls the gateway, clears the store and does not fall back. Not re-run live today. |
| Model fallback | PASS (prior run) | Unit tests pass. The live fallback run was on 18 Nov. Re-running it needs the primary agent rebound to the unreachable endpoint, a config change this audit was not allowed to make. |
| Task A verification | PASS | Live today. Results in §7. |
| Task B verification | PARTIAL | Live today, and the final result is correct: 56 passed, 3 skipped; `config` in `--help`; valid JSON with masking. But the first review cycle offered a crashing implementation, and the agent needed 4 review cycles in 4 min 42 s. That could fail on camera with `gemini-3-5-flash-lite`. |
| Task C verification | BLOCKED (today) | It passed on 18 Nov (primary on `127.0.0.1:9` failed, fallback produced a correct diff, git status clean). It was not re-run under this audit's no-config-change rule. |
| Packaging | PASS | Clean clone: `npm run package` exit 0. The VSIX has 10 files, no source maps, no `src/`, and no secrets or local paths. |
| Submission documentation | PARTIAL | `writeup.md` still has team placeholders, `package.json` still has `repository: REPLACE_ME`, and there is no video yet. One doc inaccuracy: `trueforge/instructions.md` says `run_command` runs "without a shell", which is false for `npm` and `npx` on Windows. |

---

## 3. Secret and credential audit

| Finding | Category | Location | Git-tracked? | In history? | Publicly accessible? | Severity |
|---|---|---|---|---|---|---|
| No credentials found | — | — | — | — | — | — |
| Upstream Flask test fixture named `.env` | Filename match only (upstream test data, no credentials) | `workspaces/flask*/tests/test_apps/.env` | No (FORGE ignores `workspaces/`); it is tracked in upstream Flask | No | No | INFO |
| VS Code test profile databases | Filename match (`*.db`) | `.vscode-test/user-data/**` | No (ignored) | No | No | INFO |

**How this was checked:**
- **Scanner:** `gitleaks`, `trufflehog` and `detect-secrets` are **not installed**, so I used a local redacting regex scanner. It covers 17 content rules and 6 filename rules, including Google, OpenAI, Anthropic, Groq, GitHub, GitLab, AWS, Slack and Stripe keys, private keys, GCP service accounts, JWTs, bearer tokens, credentials in URLs, Azure connection strings, and generic `key/secret/password/token = "..."` assignments. It prints only path, line, rule, length and an 8-character hash. Because it is regex-based, it may miss secrets with unusual formats. **A full gitleaks or trufflehog scan was not done.**
- **Scopes:**
  - All 44 tracked files.
  - Every reachable commit, extracted with `git archive`. There is 1 commit; there are no branches besides `main`, no tags and no stashes.
  - `git fsck --unreachable`: no dangling objects.
  - `dist/` (5 files, including source maps), the packaged VSIX (10 files), `workspaces/` excluding `.venv`, `.git` and `__pycache__` (480 files), and `.vscode-test/` excluding binaries (482 files).
  - The TrueForge server log (1.9 MB), counted with no values printed: 0 hits for Google, Groq or OpenAI key shapes, `x-goog-api-key`, bearer tokens or `key=` query strings.
- **Storage:** provider keys are held by TrueForge in `%LOCALAPPDATA%\trueforge\Data\db\db.sqlite`, outside the repo. `GET /api/v1/settings/model-providers` returns `manifest.auth.api_key` **masked**, and FORGE never reads that field. The only key-handling script, `scripts/set-provider-key.ps1`, uses `Read-Host -AsSecureString` and sends the key straight to TrueForge.
- **Ignore rules:** `.gitignore` excludes `.env`, `.env.*` (allowing `.env.example`), `*.log`, `*.vsix`, `dist/`, `workspaces/` and `.vscode-test/`. `.vscodeignore` is an allowlist: it ships only `dist/extension.js`, `trueforge/**`, `media/**`, `package.json`, `README.md` and `LICENSE`.

---

## 4. GitHub/public exposure audit

| Item | Result |
|---|---|
| Remote repository | **None configured** (`git remote -v` is empty) |
| Visibility | Not applicable: nothing is hosted |
| Push status | Never pushed |
| Branches / tags | `main` only; no tags; no stashes |
| Commit-history scan | 1 commit (`051f7fc`) scanned: no secrets |
| Releases / artifacts / Actions / Pages | None: there is no `.github/` folder and no remote. The local VSIX exists only in the audit's scratch clone. |
| Public access verification | **Cannot be established**: nothing is published. Repeat this check after the first push. |

`gh` is not installed, so no GitHub metadata could be queried. There was nothing to query anyway.

---

## 5. Personal/private information audit

| Item | Where | Risk | Recommendation |
|---|---|---|---|
| **Personal Gmail address as commit author email** (redacted) | Metadata of commit `051f7fc` | **Published on the first push.** It cannot be removed later without rewriting history. | Before pushing, set `git config user.email` to your GitHub noreply address, then amend this single unpushed commit. That is a history rewrite, so it needs your approval. |
| Local Windows username | Not in tracked files, `dist/`, source maps or the VSIX (searched for `C:\Users`, the username and email patterns) | None found | — |
| Competition brief PDF | `competition/brief.pdf` (tracked) | Third-party document that would be redistributed publicly | Remove it from the repo unless the organisers allow redistribution, and link to the official source instead. |
| Team details | `submission/writeup.md` placeholders | Not personal data. These are deliberate TODOs. | Fill in before submitting. |

There were no phone numbers, IDs or private IPs, and no screenshots or recordings in the repo.

---

## 6. Application security findings

### Remediation status (19 Nov 2026, after the audit, with the team's approval)

HIGH-1, HIGH-2 and HIGH-3 are **FIXED** and re-verified. The original findings are kept below for the record.

**What changed:**
- **`src/core/commands.ts`:**
  - `node`, `npx` and `tox` are no longer allowed.
  - `python` runs only as `-m pytest|unittest|flask|mypy|ruff` or `--version`.
  - Flask `--app`/`FLASK_APP` values may not contain call arguments.
  - git options that write files or run other programs are refused, as are `ruff --fix` and `ruff format`.
  - Arguments that name a secrets file (`.env`, `HEAD:.env`, …) are refused.
  - The agent may only set allowlisted environment variables, which partly addresses MEDIUM-1.
  - Arguments for programs that run through cmd.exe (`npm.cmd`) must be plain tokens.
- **`trueforge/forge-agent.json`:** `run_command` is added to `require_approval_for_tools`.
- **`src/core/runController.ts`:**
  - Before asking the user, it checks the command against the policy and denies violations.
  - It then asks the host, `ReviewHost.confirmCommand`: the extension shows a modal dialog (**Run once** / **Allow this command for this task**), and the CLI uses `--commands deny|allow`, defaulting to deny.
  - On approval, it issues a one-shot token.
- **`src/core/mcpServer.ts`:**
  - `run_command` refuses any call without a matching token.
  - `rejectRequest` returns 403 for a non-loopback `Host` or any `Origin` header.

**Re-verification:**
- `npm run typecheck`: exit 0.
- `npm test`: **31 passed**, including 5 new tests covering the policy matrix, cmd.exe metacharacters, the one-shot token, the Host/Origin 403s, and the approval flow in the run controller.
- The VS Code suite, pinned to 1.146.0, passed **8/8**.
- The original probes were replayed against the rebuilt server. The forged Host and the `Origin` request both got **403**. `python -c`, the npm `&echo` injection and plain `pytest` without approval were all refused ("did not approve"). `read_file .env` was still refused, and no file was written.
- Live through TrueForge (agents re-synced with the same models):
  - Task A applied correctly. This shows TrueForge's own requests pass the Host/Origin check.
  - A run with `--commands allow` paused for approval, ran `pytest tests/test_helpers.py -q`, and returned the real result.
  - The same run with `--commands deny` got "User denied tool call", and nothing ran.

**Still open:**
- MEDIUM-1: child processes still inherit the parent environment; only agent-set variables are restricted.
- MEDIUM-2: upstream TrueForge behaviour.
- LOW-1 to LOW-4.
- Residual: another same-user local process can still call read-only tools and stage proposals. Proposals only reach disk through the review panel.

### HIGH-1: `run_command` executes arbitrary code without user approval
- **Where:** `src/core/commands.ts:19-22` (the allowlist includes `python`, `py`, `node` and `npx`, with no argument restrictions beyond a small deny regex). `trueforge/forge-agent.json` `require_approval_for_tools` lists only `submit_changes_for_review`.
- **Impact:** the model, or text in a malicious repository that prompt-injects it, can:
  - run `python -c …` or `node -e …`;
  - run `npx <any package>`, which downloads and executes code from npm;
  - read files the secrets filter blocks, such as `.env` via `python -c` or `git show HEAD:.env`;
  - write or delete files on disk, **bypassing the per-hunk review**.

  This contradicts the design promise that the agent never silently modifies files.
- **Evidence:** probe against a throwaway workspace on port 3999.
  - `python -c "print(open('.env').read())"` returned the dummy `.env` contents, while `read_file .env` was refused.
  - `python -c "open('pwn.txt','w')…"` created `pwn.txt` with no review.
- **Fix, either option:**
  - (a) Add `run_command` to `require_approval_for_tools` and show the exact command in the editor for Allow/Deny. `RunController` currently auto-denies every approval that is not the review tool, so it needs a command-approval prompt.
  - (b) Restrict commands to fixed shapes (`pytest …`, `python -m pytest …`, `flask --help`, read-only `git`); reject `-c`, `-e`, `--eval` and `-m` (except `pytest`); and remove `npx` and `node`.

  Doing both is best.

### HIGH-2: cmd.exe command injection through `npm`/`npx` on Windows
- **Where:** `src/core/commands.ts:95` maps `npm`/`npx` to `.cmd` files, and `:119` spawns them with `shell: true`. `parseCommandLine` allows `& | < > ^ %` inside quotes, and Node concatenates the arguments into a cmd.exe command line without escaping them.
- **Impact:** any shell command runs, bypassing the allowlist, the deny regex and the shell-operator check.
- **Evidence:** `npm run x "&echo FORGE_INJECTED_%USERNAME%"` printed `FORGE_INJECTED_<username>`, with the variable expanded by cmd.exe (redacted here).
- **Fix:** remove `npm`/`npx` from the allowlist, or run `node <path-to-npm-cli.js>` with `shell: false`. If a shell is unavoidable, reject `& | < > ^ % "` and line breaks in every argument.

### HIGH-3: MCP endpoint has no authentication and no Host/Origin validation (DNS rebinding)
- **Where:** `src/core/mcpServer.ts:264-294`. The listener binds to 127.0.0.1, which is good, but the `StreamableHTTPServerTransport` is created without `enableDnsRebindingProtection`/`allowedHosts`, and no token is checked.
- **Impact:** a web page in the user's browser can rebind a domain to 127.0.0.1 and POST JSON to the fixed, publicly documented port 3917. Any local process or local user can do the same. Combined with HIGH-1 or HIGH-2, this gives code execution in the workspace whenever VS Code is open with FORGE running.
- **Evidence:** `tools/list` and `tools/call` succeeded with `Host: attacker.example:3999` and `Origin: http://attacker.example:3999`.
- **Fix:**
  - Reject requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, and any request that carries an `Origin` header. The SDK's `enableDnsRebindingProtection` with `allowedHosts` does this.
  - Additionally, require a random per-install secret header. Only do this if TrueForge MCP connectors support custom headers; check the TrueForge docs first and don't assume they do.

### MEDIUM-1: Agent-run processes inherit the full environment
- **Where:** `src/core/commands.ts:118` (`env: { ...process.env, ... }`). The agent can also set arbitrary variables (`NODE_OPTIONS`, `PYTHONSTARTUP`, …).
- **Impact:** any API keys the user has in their environment can be printed by an agent-run command. The output goes back to the model provider through TrueForge.
- **Evidence:** a child process saw 100 environment variables, 1 of them with a name matching `KEY|TOKEN`. Names and values were not displayed.
- **Fix:** pass an allowlisted environment (`PATH`, `SYSTEMROOT`, `TEMP`/`TMP`, `USERPROFILE`/`HOME`, `VIRTUAL_ENV`, `PYTHONIOENCODING`, `FLASK_*`), and reject agent-supplied variables outside a small allowlist.

### MEDIUM-2: TrueForge's local API is unauthenticated and accepts any Host header
- **Where:** upstream TrueForge 0.185.1. It listens on `[::1]:8790` only, which is good. `GET /api/v1/agents` with `Host: attacker.example` returned 200.
- **Impact:** through DNS rebinding, a web page could start sessions that use the user's saved provider key, spending quota. Saved keys are returned masked, so they cannot be read this way. This is not FORGE code.
- **Fix:** document the risk; run TrueForge only while working; consider reporting it upstream.

### LOW-1: Secrets filtering is by filename only
- **Where:** `src/core/workspace.ts:10-16`.
- **Impact:** secrets hard-coded in ordinary files such as `config.py` are sent to the model through `read_file` or `retrieve_context`, and `service-account*.json` is not matched.
- **Fix:** add content-pattern redaction to tool outputs, and extend the filename patterns.

### LOW-2: Deletion warning fires on ordinary in-place edits
- **Where:** `src/core/proposals.ts:94-106`.
- **Impact:** in the live Task A run, the changed `return` line was reported as "DELETES 1 existing line". This is noise that may confuse reviewers and the model.
- **Fix:** pair each removed line with a similar added line in the same hunk before calling it a deletion.

### LOW-3: Dev-dependency advisories
- **Evidence:** `npm audit` reports 2 moderate issues: `minimatch` ReDoS through `@vscode/vsce`. Both are dev-only and are not in the VSIX. Production dependencies: `@modelcontextprotocol/sdk`, `@truefoundry/trueforge-sdk` (pinned), `diff`, `zod`. Install scripts exist only in dev dependencies (`esbuild`, `@vscode/vsce-sign`, `fsevents`). Licences are MIT/BSD/ISC-compatible.
- **Fix:** run `npm audit fix` when vsce ships a fix.

### LOW-4: VS Code integration runner downloads the latest stable VS Code
- **Where:** `scripts/test-vscode.mjs:20` (no `version`).
- **Impact:** results are not reproducible. Today the runner stalled on a 388 MB download of 1.147.0; it passed when run with `version: '1.146.0'` from a scratch copy.
- **Fix:** pin the version.

### INFORMATIONAL
- Webviews use a CSP of `default-src 'none'` with nonced script and style. HTML is escaped through `escapeHtml`, and the only `innerHTML` write clears the log.
- The extension does not declare `untrustedWorkspaces`, so VS Code disables it in Restricted Mode (the safe default).
- Workspace confinement covers absolute paths, `..`, `.git` and realpath symlink escapes (unit-tested). Reads are capped at 256 KB and 250 lines.
- Commands have a timeout (default 120 s, maximum 600 s), output is capped at 12k, process trees are killed on cancel, and the working directory is the workspace root.
- Retry loops are bounded: at most 4 same-session resumes per attempt and at most 2 attempts (primary and fallback). Cancel never falls back.

---

## 7. Test results

| # | Command | Where | Exit | Result |
|---|---|---|---|---|
| 1 | `npm ci` | clean clone | 0 | Lockfile consistent; installed |
| 2 | `npm run typecheck` | clean clone | 0 | No errors |
| 3 | `npm run build` | clean clone | 0 | `dist/extension.js` and `dist/forge-cli.js` |
| 4 | `npm test` | clean clone | 0 | 23 passed, 3 skipped. The skipped Flask-retrieval tests need `workspaces/flask`, which a clean clone lacks. |
| 5 | `npm test` | main repo | 0 | 26 passed |
| 6 | `npm run package` | clean clone | 0 | `forge-agent-0.1.0.vsix`, 10 files, 346.7 KB |
| 7 | `node scripts/test-vscode.mjs` | main repo | — | Stopped after more than 10 minutes, stuck downloading VS Code 1.147.0 (LOW-4) |
| 8 | same suite pinned to `version: '1.146.0'` (scratch copy of the runner) | main repo | 0 | **8/8** integration checks passed |
| 9 | Lint | — | — | No lint script configured: not run |
| 10 | `npm audit` (online, dependency metadata only) | main repo | — | 2 moderate (dev-only) |
| 11 | MCP security probes (forged Host, `.env` read, `python -c`, npm injection, env access) | throwaway workspace | — | 1 control held (`read_file .env` refused); 5 bypasses confirmed (HIGH-1..3, MEDIUM-1) |
| 12 | **Task A live**: `node dist/forge-cli.js run --workspace workspaces/flask-dev --task-file <exact inline-edit message> --approve all` | scratch checkout | 0 | Status done, applied, no fallback, 13 s. Diff: `{"0","false","no","off","n"}` plus a docstring line. |
| 13 | Task A behaviour (`FLASK_DEBUG=<v>`, calling `get_debug_flag()`) | scratch checkout | 0 | `off`/`OFF`/`Off`/`n`/`N`/`0`/`false`/`FALSE`/`no`/`No`/empty/unset → False; `1`/`true`/`yes`/`on`/`y` → True |
| 14 | `pytest tests/test_helpers.py -q` | scratch, after Task A | 1 | 34 passed, 1 failed (`test_async_view`). It **fails identically on the untouched checkout**: a pre-existing Python 3.14/Windows issue, not caused by FORGE. |
| 15 | **Task B live** (exact task sentence, `--approve all`): `node dist/forge-cli.js run --workspace workspaces/flask-dev --task-file <task B> --approve all` | scratch checkout | 0 | Status done, no fallback, 4 min 42 s, 47 tool calls, 4 rate-limit resumes in the same session. Retrieval: 6 of 174 files, ~5271 of 6000 tokens. **The first review applied a broken `flask config`** (`TypeError: timedelta is not JSON serializable`), and its own new test failed. The agent ran the tests, saw the failure, and fixed it over **3 more review cycles**. |
| 16 | `pytest tests/test_cli.py -q` (after Task B) | scratch | 0 | **56 passed, 3 skipped** (baseline 55 passed, 3 skipped; plus the new `TestConfig::test_config`) |
| 17 | `flask --help` | scratch | 0 | Lists `config  Show the config for the app.` |
| 18 | `flask --app demo_app config` (dummy credentials) | scratch | 0 | Valid JSON, 35 keys. `SECRET_KEY`, `DATABASE_PASSWORD`, `API_TOKEN` and `STRIPE_KEY` → `"***"`; `APP_NAME` and `ITEMS_PER_PAGE` visible; no dummy secret leaked. Masking is case-sensitive (a lowercase `api_key_lower` stays visible), which matches the task's upper-case wording. |
| 19 | Final Task B diff | scratch | — | `src/flask/cli.py` +25, `tests/test_cli.py` +33, `docs/cli.rst` +17, nothing deleted. Saved to the scratchpad, then the checkout was reverted. |

Not run today:
- Live cancellation and Task C/fallback. Both need either a mid-run cancel timing or a model-config change; prior live evidence is from 18 Nov.
- A manual click-through of the VS Code UI.

---

## 8. Required fixes before publication

1. **Credential exposure:** none found. No action needed. Install `gitleaks` and run `gitleaks git --redact` and `gitleaks dir --redact` once before the first push, for a scanner-grade confirmation.
2. **Private data:** replace the personal Gmail address in commit `051f7fc`'s author field with your GitHub noreply address (amend the unpushed commit, with your approval). Decide whether to keep `competition/brief.pdf`.
3. **Public Git history:** nothing is public yet. Once you push, everything in history is permanent, so do steps 1–2 first.
4. **Application security:** ~~fix HIGH-1, HIGH-2 and HIGH-3~~ **done** (see §6, Remediation status). Remaining: MEDIUM-1, passing an allowlisted environment to child processes.
5. **Competition requirements:**
   - Make Task B reliable for the demo: use `gemini-3-5-flash` (its daily quota should have reset), or another stronger model, as the primary.
   - Re-run Task C live before recording.
6. **Docs and packaging:**
   - Fill in the team section, replace `REPLACE_ME` in `package.json`, and record the video.
   - Correct the "without a shell" claim in `trueforge/instructions.md`.
   - Pin the VS Code version in `test-vscode.mjs`.

## 9. Credential rotation recommendations

No credential was found in any tracked file, commit, build output, VSIX or log, and nothing has been pushed, so **no rotation is required**.

Keys saved in TrueForge stay in `%LOCALAPPDATA%\trueforge`. That includes the Gemini key and the deliberately broken `unreachable-endpoint` test provider; the Groq provider has no key saved. Rotate the Gemini key only if that SQLite file, a screen recording showing the key, or the TrueForge settings UI with the key visible is ever shared. Avoid opening the provider settings page while you record the demo video.

## 10. Final publication decision

**SAFE ONLY AFTER FIXES**

No credentials are exposed, and nothing is public yet. Publishing as-is would still:
- permanently publish a personal email address in the commit metadata;
- ship an extension with three reproduced HIGH issues, where the agent or a malicious web page can run code on the user's machine without approval. That is the opposite of the project's safety claims, and evaluators who read `commands.ts` will spot it.

Fix §8 items 2 and 4, re-run the scans and tests, then publish.

**Update after remediation (19 Nov):** the three HIGH findings are fixed and re-verified (§6). The decision stays **SAFE ONLY AFTER FIXES** until the commit author email is replaced (§5). That is the remaining blocker before the first push.
