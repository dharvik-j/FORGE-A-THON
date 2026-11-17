/**
 * Runs inside a real VS Code extension host (see scripts/test-vscode.mjs). Exercises activation, command
 * registration, the MCP server, WorkspaceEdit-based per-hunk apply, stale refusal, batch undo, and the review panel.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ForgeState } from '../../src/extension/extension';
import type { ReviewOutcome } from '../../src/core/mcpServer';

type Case = [string, () => Promise<void>];
const lf = (s: string) => s.replace(/\r\n/g, '\n');

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('forge-athon.forge-agent');
  assert.ok(ext, 'extension present');
  const api = (await ext.activate()) as { state: () => ForgeState | undefined };
  const st = api.state();
  assert.ok(st, 'FORGE booted on the test workspace');
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const file = path.join(root, 'pkg', 'mod.py');
  const original = Array.from({ length: 40 }, (_, i) => `line_${i + 1} = ${i + 1}`).join('\n') + '\n';

  const uri = vscode.Uri.file(file);
  /** Reset through the editor so the open TextDocument and the disk agree, as they would for a real user. */
  const reset = async () => {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.getText() !== original) {
      const e = new vscode.WorkspaceEdit();
      e.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), original);
      await vscode.workspace.applyEdit(e);
    }
    if (doc.isDirty) await doc.save();
    if (lf(fs.readFileSync(file, 'utf8')) !== original) fs.writeFileSync(file, original);
    st.ws.invalidate();
    st.tools.store.clear();
  };
  const stage = () =>
    st.tools.store.propose('pkg/mod.py', {
      edits: [
        { old_string: 'line_3 = 3', new_string: 'line_3 = 300' },
        { old_string: 'line_30 = 30', new_string: 'line_30 = 3000' },
      ],
      summary: 'two separate hunks',
    });
  const disk = () => lf(fs.readFileSync(file, 'utf8'));

  const cases: Case[] = [
    ['commands are registered', async () => {
      const cmds = await vscode.commands.getCommands(true);
      for (const c of ['forge.inlineEdit', 'forge.openAgent', 'forge.cancel', 'forge.undoLastApply', 'forge.setup', 'forge.openSession']) assert.ok(cmds.includes(c), c);
    }],
    ['MCP server answers on the configured port', async () => {
      const port = vscode.workspace.getConfiguration('forge').get<number>('mcpPort');
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      const body = await r.text();
      assert.ok(body.includes('submit_changes_for_review'), body.slice(0, 200));
    }],
    ['staging never touches disk', async () => {
      await reset();
      const p = stage();
      assert.equal(p.hunks.length, 2);
      assert.equal(disk(), original);
    }],
    ['per-hunk apply writes only the accepted hunk, via WorkspaceEdit', async () => {
      await reset();
      const p = stage();
      await st.applier.apply([{ proposal: p, accepted: new Set([1]) }], 'test');
      const now = disk();
      assert.ok(now.includes('line_3 = 3\n'), 'rejected hunk untouched');
      assert.ok(now.includes('line_30 = 3000\n'), 'accepted hunk applied');
    }],
    ['undo restores the batch', async () => {
      const b = await st.applier.undoLast();
      assert.ok(b);
      assert.equal(disk(), original);
    }],
    ['stale proposals are refused', async () => {
      await reset();
      const p = stage();
      const doc = await vscode.workspace.openTextDocument(uri);
      const userEdit = new vscode.WorkspaceEdit();
      userEdit.replace(uri, doc.lineAt(9).range, 'line_10 = user_edit');
      await vscode.workspace.applyEdit(userEdit);
      await assert.rejects(st.applier.apply([{ proposal: p, accepted: new Set([0, 1]) }], 'stale'), /changed after/);
      assert.ok(doc.getText().includes('user_edit'), 'user edit preserved');
      assert.ok(!doc.getText().includes('3000'), 'proposal not applied');
      await doc.save();
    }],
    ['review panel: per-hunk decisions → apply → outcome', async () => {
      await reset();
      const p = stage();
      const ac = new AbortController();
      const pending = st.review.review({ proposals: [p], summary: 'test review', signal: ac.signal });
      await new Promise(r => setTimeout(r, 1500));
      const send = (m: object) => (st.review as unknown as { onMessage(m: object): Promise<void> }).onMessage(m);
      await send({ type: 'decide', id: p.id, hunk: 0, decision: 'accept' });
      await send({ type: 'decide', id: p.id, hunk: 1, decision: 'reject' });
      await send({ type: 'apply' });
      const outcome = (await pending) as ReviewOutcome;
      console.log('    outcome:', JSON.stringify(outcome));
      assert.deepEqual(outcome.applied, [{ path: 'pkg/mod.py', acceptedHunks: 1, totalHunks: 2 }]);
      assert.match(outcome.rejected[0]!.reason, /1 of 2 hunk/);
      assert.ok(disk().includes('line_3 = 300\n') && disk().includes('line_30 = 30\n'));
      await st.applier.undoLast();
      assert.equal(disk(), original);
    }],
    ['review panel: cancel (abort) applies nothing', async () => {
      await reset();
      const p = stage();
      const ac = new AbortController();
      const pending = st.review.review({ proposals: [p], summary: 'cancel me', signal: ac.signal });
      await new Promise(r => setTimeout(r, 800));
      ac.abort();
      const outcome = await pending;
      assert.equal(outcome.dismissed, true);
      assert.equal(outcome.applied.length, 0);
      assert.equal(disk(), original);
    }],
  ];

  const failures: string[] = [];
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${(e as Error).message}`);
      failures.push(name);
    }
  }
  await reset();
  console.log(`\n${cases.length - failures.length}/${cases.length} VS Code integration checks passed`);
  if (failures.length) throw new Error(`failed: ${failures.join(', ')}`);
}
