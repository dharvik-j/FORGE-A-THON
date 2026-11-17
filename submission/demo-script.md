# Demo script (≤ 4:00, tasks in order A → B → C)

Rules from the brief: editor visible throughout; each task followed by its on-screen verification; TrueForge session shown briefly during Task B; model waiting time may be cut, but **never cut between giving an instruction and the diff appearing** (speed it up instead). Timestamps below are a plan; replace them with real ones after recording and copy them into the write-up scorecard.

## Before recording

- [ ] `scripts\start-trueforge.ps1` running; TrueForge open at http://localhost:8790 in a browser tab.
- [ ] Two models configured; **FORGE: Set up TrueForge** done; FORGE status bar shows the primary and fallback agents.
- [ ] `workspaces\flask` and `workspaces\flask-taskc` are both fresh (`git status` clean) with `.venv` created.
- [ ] VS Code (F5, "Run FORGE on Flask demo") opened on `workspaces\flask`; font size ≥ 16; FORGE panel open; a Git Bash terminal open with `source .venv/Scripts/activate`.
- [ ] Clear the FORGE panel (reload window) so earlier runs aren't visible.

## 0:00 – 0:10 · Title

Show the FORGE panel and status line ("TrueForge http://localhost:8790 · agent forge-coder · fallback forge-coder-fallback"). One caption: "VS Code extension · agent loop on TrueForge · Flask 3.1.3".

## 0:10 – 0:55 · Task A, inline edit

1. Open `src/flask/helpers.py`, select the whole `get_debug_flag` function.
2. `Ctrl+Alt+K`, type the exact instruction:
   *Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.*
3. Show the panel streaming: `read_file`, `propose_file_change`, then "Waiting for your review".
4. The side-by-side diff and the FORGE Review panel open. Click **Accept** on each hunk, then **Apply**.
5. Terminal (Git Bash):
   `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False`.
   Optionally also `FLASK_DEBUG=N …` → `False`.

Rubric shown: A1 (diff in editor, per-hunk accept/reject), B2 (review before write).

## 0:55 – 2:40 · Task B, agent mode

1. In the FORGE panel, paste the exact request (no file names):
   *Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.*
2. Pause on the **CONTEXT RETRIEVAL** card: candidates scanned, chosen files with reasons, line ranges, tokens used vs budget.
3. Let tool cards stream (search/read/propose). Model waiting may be sped up, not cut.
4. **Show the TrueForge session**: click "Open TrueForge session" → browser shows turns, tool calls, the approval pause (and any subagent threads). ~10 s.
5. Back in VS Code, the review lists ≥ 3 files (`src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`). Accept hunks file by file; to demonstrate per-hunk control, reject one cosmetic hunk if there is one. Apply.
6. The agent runs the tests itself (`run_command`). Then in the terminal:
   - `pytest tests/test_cli.py -q` → passes
   - `flask --help` → `config` listed
   - `flask --app <demo app> config` → masked JSON (`"SECRET_KEY": "***"` …) with ordinary values visible. Use a small demo app with dummy values, e.g. `tests/test_apps/…` or a one-file `demo_app.py` created before recording.
7. **Undo**: run **FORGE: Undo Last Apply**, show `git status` / the files revert, then `Ctrl+Shift+P → FORGE: Undo` is not needed again; re-apply by re-running is not required. (If time is short, show undo on Task A instead.)

Rubric shown: A2, B1, B2 (per-hunk + undo), B4 (approval pause and session), A3 streaming.

## 2:40 – 2:55 · Cancellation (brief)

Send any request (e.g. "Add type hints to every function in src/flask/helpers.py"), click **Cancel** while it streams. Panel shows "■ Cancelled"; `git status` unchanged.

Rubric shown: A3 (immediate cancel, workspace consistent).

## 2:55 – 3:45 · Task C, resilience

1. Run `powershell -File scripts\taskc.ps1 -Break -Fallback google-gemini/gemini-3-1-flash-lite` (already run off-camera is fine). On camera, show TrueForge → Agents → `forge-coder` now using `unreachable-endpoint/broken-model` (base URL `http://127.0.0.1:9/v1`), and `forge-coder-fallback` on a working model.
2. Switch VS Code to the fresh `workspaces\flask-taskc` window (`git status` clean).
3. Repeat Task A exactly.
4. The panel shows the primary attempt failing ("✗ … 401 …" / "Cannot connect"), then "⟳ Fallback: Primary model failed … Retrying with configured fallback agent forge-coder-fallback", then a new TrueForge session streaming on the fallback model. Type in the editor during this to show it stays responsive.
5. The diff appears. **Before accepting**, run `git status` → "nothing to commit, working tree clean". (Optionally accept afterwards and run the Task A check.)
6. Off camera afterwards: `powershell -File scripts\taskc.ps1 -Restore`.

Rubric shown: B3 (automatic fallback, workspace unchanged).

## 3:45 – 4:00 · Close

Repository URL and one line: "Agent loop: TrueForge · tools: FORGE MCP server · models: <primary> / <fallback>".
