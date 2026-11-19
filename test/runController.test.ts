import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunController, ReviewHost, RunListener } from '../src/core/runController';
import { ForgeTools, REVIEW_TOOL } from '../src/core/mcpServer';
import { Workspace } from '../src/core/workspace';
import type { TrueForgeGateway } from '../src/core/trueforge';

type Ev = Record<string, unknown> & { type: string; id: string };

/** Scripted stand-in for TrueForgeGateway: each startTurn/subscribe call plays the next scripted stream. */
class FakeGateway {
  baseUrl = 'http://fake';
  sessions: string[] = [];
  turns: { session: string; message: string }[] = [];
  approvals: unknown[][] = [];
  cancelled: string[] = [];
  scripts: ((signal: AbortSignal) => AsyncIterable<Ev>)[] = [];
  async createSession(agent: string) {
    const id = `sess-${this.sessions.length + 1}-${agent}`;
    this.sessions.push(id);
    return id;
  }
  async startTurn(session: string, message: string, signal: AbortSignal) {
    this.turns.push({ session, message });
    return this.next(signal);
  }
  async subscribe(_s: string, _t: string, _after: string | undefined, signal: AbortSignal) {
    return this.next(signal);
  }
  async sendApprovals(_s: string, _t: string, events: unknown[]) {
    this.approvals.push(events);
  }
  async cancel(session: string) {
    this.cancelled.push(session);
  }
  sessionUrl(id: string) {
    return `http://fake/sessions/${id}`;
  }
  private next(signal: AbortSignal) {
    const s = this.scripts.shift();
    if (!s) throw new Error('no scripted stream left');
    return s(signal);
  }
}

const done = (id = 'd'): Ev => ({ type: 'turn.done', id, threadId: null, state: { status: 'done', output: null, completedAt: '' } });
const failed = (message: string, id = 'e'): Ev => ({ type: 'turn.done', id, threadId: null, state: { status: 'error', message, completedAt: '' } });
async function* play(...evs: Ev[]) {
  for (const e of evs) yield e;
}

const listener = (log: string[]): RunListener => ({
  phase: (p, d) => log.push(`phase:${p}${d ? `:${d}` : ''}`),
  attempt: a => log.push(`attempt:${a.agent}:${a.fallback}`),
  text: () => {},
  toolCall: c => log.push(`tool:${c.name}`),
  toolResult: () => {},
  thread: () => {},
  note: () => {},
  metrics: () => {},
});

let tools: ForgeTools;
let gw: FakeGateway;
let reviews: number;
const host: ReviewHost = {
  async review({ proposals }) {
    reviews++;
    return { applied: proposals.map(p => ({ path: p.path, acceptedHunks: p.hunks.length, totalHunks: p.hunks.length })), rejected: [] };
  },
};

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-'));
  fs.writeFileSync(path.join(dir, 'a.py'), 'x = 1\n');
  tools = new ForgeTools(new Workspace(dir));
  gw = new FakeGateway();
  reviews = 0;
});

const controller = (fallback?: string) => new RunController(gw as unknown as TrueForgeGateway, tools, host, () => ({ primary: 'primary', fallback }));

describe('RunController', () => {
  it('pauses on the review tool, reviews staged changes, and allows the call', async () => {
    gw.scripts.push(async function* () {
      yield { type: 'turn.created', id: '1', turnId: 't1', threadId: null };
      tools.store.propose('a.py', { edits: [{ old_string: 'x = 1', new_string: 'x = 2' }] });
      yield { type: 'model.message', id: 'm1', threadId: 'main', content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', type: 'function', function: { name: REVIEW_TOOL, arguments: '{"summary":"s"}' }, toolInfo: { type: 'mcp', name: REVIEW_TOOL, serverName: 'forge-workspace', serverId: 'x' } }] };
      yield { type: 'tool.approval_required', id: '2', threadId: 'main', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] };
      yield { type: 'turn.update', id: '3', threadId: null, state: { status: 'paused' } };
    });
    gw.scripts.push(() => play(done()));
    const log: string[] = [];
    const r = await controller().run({ message: 'go', title: 'go' }, listener(log));
    expect(r.status).toBe('done');
    expect(r.applied).toBe(true);
    expect(reviews).toBe(1);
    expect(gw.approvals[0]).toEqual([{ type: 'user.tool_approval', threadId: 'main', toolCallId: 'c1', approval: { status: 'allow' } }]);
    expect(log).toContain('phase:review:1 file(s) waiting for review');
  });

  it('denies a review request when nothing was staged', async () => {
    gw.scripts.push(() =>
      play(
        { type: 'turn.created', id: '1', turnId: 't1', threadId: null },
        { type: 'model.message', id: 'm1', threadId: 'main', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', type: 'function', function: { name: REVIEW_TOOL, arguments: '{}' }, toolInfo: { type: 'mcp', name: REVIEW_TOOL, serverName: 'forge-workspace', serverId: 'x' } }] },
        { type: 'tool.approval_required', id: '2', threadId: 'main', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] },
        { type: 'turn.update', id: '3', threadId: null, state: { status: 'paused' } },
      ),
    );
    gw.scripts.push(() => play(done()));
    await controller().run({ message: 'go', title: 'go' }, listener([]));
    expect(reviews).toBe(0);
    expect((gw.approvals[0] as { approval: { status: string } }[])[0]!.approval.status).toBe('deny');
  });

  it('falls back to the second agent on a provider failure, in a new session', async () => {
    gw.scripts.push(() => play({ type: 'turn.created', id: '1', turnId: 't1', threadId: null }, failed('[Model Error] Request failed (401): Invalid API Key')));
    gw.scripts.push(() => play({ type: 'turn.created', id: '2', turnId: 't2', threadId: null }, done()));
    const log: string[] = [];
    const r = await controller('backup').run({ message: 'task', title: 'task' }, listener(log));
    expect(r.status).toBe('done');
    expect(r.usedFallback).toBe(true);
    expect(gw.sessions).toEqual(['sess-1-primary', 'sess-2-backup']);
    expect(gw.turns.map(t => t.message)).toEqual(['task', 'task']);
    expect(log.some(l => l.startsWith('phase:fallback:Primary model failed'))).toBe(true);
  });

  it('reports a clear error when there is no fallback', async () => {
    gw.scripts.push(() => play(failed('[Model Error] Cannot connect to API: bad port')));
    const r = await controller().run({ message: 'task', title: 'task' }, listener([]));
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/Cannot connect.*no fallback agent is configured/);
  });

  it('resumes the same session after a rate limit instead of failing over', async () => {
    gw.scripts.push(() => play(failed('Request failed (429): quota exceeded. Please retry in 0.001s.')));
    gw.scripts.push(() => play(done()));
    const log: string[] = [];
    const r = await controller('backup').run({ message: 'task', title: 'task' }, listener(log));
    expect(r.status).toBe('done');
    expect(r.usedFallback).toBe(false);
    expect(gw.sessions).toHaveLength(1);
    expect(gw.turns).toHaveLength(2);
    expect(gw.turns[1]!.session).toBe(gw.turns[0]!.session);
    expect(log.some(l => l.startsWith('phase:retrying'))).toBe(true);
  }, 20000);

  it('asks the user before run_command, remembers "for this task", and refuses policy violations unasked', async () => {
    const asked: string[] = [];
    const askingHost: ReviewHost = { ...host, confirmCommand: async ({ command }) => (asked.push(command), 'task') };
    const cmdCall = (id: string, command: string): Ev[] => [
      { type: 'model.message', id: `m${id}`, threadId: 'main', finishReason: 'tool_calls', toolCalls: [{ id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) }, toolInfo: { type: 'mcp', name: 'run_command', serverName: 'forge-workspace', serverId: 'x' } }] },
      { type: 'tool.approval_required', id: `a${id}`, threadId: 'main', toolCalls: [{ id, sourceEventId: `m${id}` }] },
      { type: 'turn.update', id: `u${id}`, threadId: null, state: { status: 'paused' } },
    ];
    let afterFirst = false;
    gw.scripts.push(() => play({ type: 'turn.created', id: '1', turnId: 't1', threadId: null }, ...cmdCall('c1', 'pytest -q')));
    gw.scripts.push(async function* () {
      afterFirst = tools.consumeCommandApproval('pytest -q'); // what the MCP handler does when TrueForge runs the tool
      for (const e of cmdCall('c2', 'pytest -q')) yield e;
    });
    gw.scripts.push(() => play(...cmdCall('c3', 'python -c "import os"')));
    gw.scripts.push(() => play(done()));
    const c = new RunController(gw as unknown as TrueForgeGateway, tools, askingHost, () => ({ primary: 'primary' }));
    const r = await c.run({ message: 'go', title: 'go' }, listener([]));
    expect(r.status).toBe('done');
    expect(afterFirst).toBe(true);
    expect(asked).toEqual(['pytest -q']); // second identical command reused the task approval; the -c one never reached the user
    const statuses = gw.approvals.map(a => (a as { approval: { status: string; reason?: string } }[])[0]!.approval);
    expect(statuses[0]!.status).toBe('allow');
    expect(statuses[1]!.status).toBe('allow');
    expect(statuses[2]!.status).toBe('deny');
    expect(statuses[2]!.reason).toMatch(/policy/);
    expect(tools.consumeCommandApproval('pytest -q')).toBe(false); // cleared when the run ended
  });

  it('denies run_command when the host cannot ask the user', async () => {
    gw.scripts.push(() =>
      play(
        { type: 'turn.created', id: '1', turnId: 't1', threadId: null },
        { type: 'model.message', id: 'm1', threadId: 'main', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"command":"pytest -q"}' }, toolInfo: { type: 'mcp', name: 'run_command', serverName: 'forge-workspace', serverId: 'x' } }] },
        { type: 'tool.approval_required', id: '2', threadId: 'main', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] },
        { type: 'turn.update', id: '3', threadId: null, state: { status: 'paused' } },
      ),
    );
    gw.scripts.push(() => play(done()));
    await controller().run({ message: 'go', title: 'go' }, listener([]));
    expect((gw.approvals[0] as { approval: { status: string } }[])[0]!.approval.status).toBe('deny');
    expect(tools.consumeCommandApproval('pytest -q')).toBe(false);
  });

  it('cancel stops the turn via TrueForge, drops staged edits, and never falls back', async () => {
    gw.scripts.push(signal =>
      (async function* () {
        yield { type: 'turn.created', id: '1', turnId: 't1', threadId: null } as Ev;
        tools.store.propose('a.py', { edits: [{ old_string: 'x = 1', new_string: 'x = 3' }] });
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        yield failed('aborted');
      })(),
    );
    const c = controller('backup');
    const running = c.run({ message: 'task', title: 'task' }, listener([]));
    await new Promise(r => setTimeout(r, 50));
    expect(tools.store.list()).toHaveLength(1);
    await c.cancel();
    const r = await running;
    expect(r.status).toBe('cancelled');
    expect(gw.cancelled).toEqual(['sess-1-primary']);
    expect(gw.sessions).toHaveLength(1);
    expect(tools.store.list()).toHaveLength(0);
    expect(fs.readFileSync(path.join(tools.ws.root, 'a.py'), 'utf8')).toBe('x = 1\n');
  });
});
