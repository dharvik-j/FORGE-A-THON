/**
 * Headless FORGE harness: the same MCP server, TrueForge adapter and run controller the VS Code extension uses,
 * driven from a terminal. Used for setup and for end-to-end verification without an editor.
 *
 *   node dist/forge-cli.js setup --primary-model <provider/model> [--fallback-model <provider/model>]
 *   node dist/forge-cli.js serve --workspace <dir>
 *   node dist/forge-cli.js run   --workspace <dir> --task "<text>" [--approve all|none|first-hunk] [--commands deny|allow] [--cancel-after <sec>]
 *
 * --commands defaults to deny: the agent's run_command calls are refused unless you pass --commands allow, which
 * stands in for the editor's per-command approval dialog (commands still have to pass the FORGE command policy).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Workspace } from '../core/workspace';
import type { ContextResult } from '../core/context';
import { ForgeTools, startMcpHttpServer } from '../core/mcpServer';
import { RunController, ReviewHost } from '../core/runController';
import { TrueForgeGateway } from '../core/trueforge';
import { applySelectedHunks, hashText } from '../core/proposals';
import { loadAgentTemplate, syncForge, DEFAULT_AGENTS } from '../core/setup';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const repoRoot = path.resolve(__dirname, '..');
const baseUrl = arg('trueforge', process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790')!;
const port = Number(arg('port', process.env.FORGE_MCP_PORT ?? '3917'));
const gateway = new TrueForgeGateway(baseUrl);

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'setup') {
    const primaryModel = arg('primary-model');
    if (!primaryModel) throw new Error('--primary-model <provider/model> is required (see GET /api/v1/models)');
    const out = await syncForge(gateway, loadAgentTemplate(repoRoot), {
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      primaryModel,
      fallbackModel: arg('fallback-model'),
      primaryAgent: arg('primary-agent', DEFAULT_AGENTS.primary)!,
      fallbackAgent: arg('fallback-agent', DEFAULT_AGENTS.fallback)!,
    });
    console.log(out.join('\n'));
    return;
  }

  const wsDir = arg('workspace');
  if (!wsDir) throw new Error('--workspace <dir> is required');
  const ws = new Workspace(wsDir);
  const tools = new ForgeTools(ws);
  const server = await startMcpHttpServer(tools, port);
  console.error(`[forge] MCP server on http://127.0.0.1:${port}/mcp serving ${ws.root}`);
  if (cmd === 'serve') return;

  const approve = arg('approve', 'all')!;
  const commands = arg('commands', 'deny')!;
  if (commands !== 'deny' && commands !== 'allow') throw new Error('--commands must be "deny" or "allow"');
  const host: ReviewHost = {
    async confirmCommand({ command }) {
      console.log(`\n[approval] run_command ${JSON.stringify(command)} -> ${commands === 'allow' ? 'allowed (--commands allow)' : 'denied (pass --commands allow to permit)'}`);
      return commands === 'allow' ? 'once' : 'deny';
    },
    async review({ proposals }) {
      try {
        const status = execFileSync('git', ['status', '--porcelain'], { cwd: ws.root, encoding: 'utf8' }).trim();
        console.log(`\n[review] git status before applying: ${status ? `\n${status}` : 'clean (nothing written yet)'}`);
      } catch {
        /* not a git repository */
      }
      const applied: { path: string; acceptedHunks: number; totalHunks: number }[] = [];
      const rejected: { path: string; reason: string }[] = [];
      for (const p of proposals) {
        console.log(`\n[review] ${p.path}${p.isNew ? ' (new)' : ''} +${p.additions} -${p.deletions}, ${p.hunks.length} hunk(s)`);
        const accept = approve === 'all' ? new Set(p.hunks.map(h => h.index)) : approve === 'first-hunk' ? new Set([0]) : new Set<number>();
        if (!accept.size) {
          rejected.push({ path: p.path, reason: 'rejected by user' });
          continue;
        }
        const abs = ws.resolve(p.path);
        const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
        if (hashText(current) !== p.baseHash) {
          rejected.push({ path: p.path, reason: 'file changed on disk since the proposal was made (stale)' });
          continue;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, applySelectedHunks(p.original, p.hunks, accept));
        applied.push({ path: p.path, acceptedHunks: accept.size, totalHunks: p.hunks.length });
      }
      ws.invalidate();
      return { applied, rejected };
    },
  };
  const controller = new RunController(gateway, tools, host, () => ({
    primary: arg('agent', DEFAULT_AGENTS.primary)!,
    fallback: arg('fallback', DEFAULT_AGENTS.fallback),
  }));
  tools.on('context', (r: ContextResult) => console.log(`\n[context] ${r.selected.length}/${r.candidates} files, ~${r.usedTokens}/${r.budgetTokens} tokens: ${r.selected.map(s => s.path).join(', ')}`));
  const task = arg('task') ?? (arg('task-file') ? fs.readFileSync(arg('task-file')!, 'utf8') : undefined);
  if (!task) throw new Error('--task or --task-file is required');
  const cancelAfter = arg('cancel-after');
  if (cancelAfter) setTimeout(() => {
    console.log(`\n[forge] cancelling after ${cancelAfter}s`);
    void controller.cancel();
  }, Number(cancelAfter) * 1000);

  let lastText = '';
  const result = await controller.run(
    { message: task, title: task.slice(0, 80) },
    {
      phase: (p, d) => console.log(`\n[phase] ${p}${d ? `: ${d}` : ''}`),
      attempt: a => console.log(`[attempt] agent=${a.agent} session=${a.sessionId} fallback=${a.fallback} ${a.sessionUrl}`),
      text: t => {
        if (t.text.startsWith(lastText)) process.stdout.write(t.text.slice(lastText.length));
        else process.stdout.write(`\n[${t.threadId}] ${t.text}`);
        lastText = t.text;
      },
      toolCall: c => {
        lastText = '';
        console.log(`\n[tool] ${c.threadId !== 'main' ? `(${c.threadId}) ` : ''}${c.name} ${JSON.stringify(c.args).slice(0, 220)}`);
      },
      toolResult: r => console.log(`[result] ${r.name}${r.isError ? ' ERROR' : ''}: ${r.content.replace(/\s+/g, ' ').slice(0, 260)}`),
      thread: t => console.log(`[subagent] ${t.status} ${t.title} ${t.input ? `— ${t.input.slice(0, 160)}` : ''}`),
      note: n => console.log(`[note] ${n}`),
      metrics: m => console.log(`[metrics] tokens=${m.totalTokens ?? '?'} cost=$${m.costUsd ?? '?'}`),
    },
  );
  console.log(`\n[forge] result: ${JSON.stringify(result)}`);
  server.close();
  process.exit(result.status === 'done' ? 0 : 1);
}

main().catch(e => {
  console.error(`[forge] ${(e as Error).stack ?? e}`);
  process.exit(2);
});
