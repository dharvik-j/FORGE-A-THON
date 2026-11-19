import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Workspace, isSensitivePath } from '../src/core/workspace';
import { SymbolIndex, extractSymbols, searchWorkspace } from '../src/core/search';
import { retrieveContext, extractTerms } from '../src/core/context';
import { ProposalStore, applySelectedHunks, computeHunks, applyEdits, removedLines } from '../src/core/proposals';
import * as http from 'node:http';
import { parseCommandLine, validateCommand, validateShellArgs, CommandRunner } from '../src/core/commands';
import { ForgeTools, startMcpHttpServer, rejectRequest } from '../src/core/mcpServer';
import { normalizeToolCall, rateLimitDelayMs } from '../src/core/runController';
import { isProviderFailure } from '../src/core/trueforge';

const FLASK = path.resolve(__dirname, '../workspaces/flask');
const hasFlask = fs.existsSync(path.join(FLASK, 'src/flask/cli.py'));

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  fs.mkdirSync(path.join(tmp, 'pkg'));
  fs.mkdirSync(path.join(tmp, 'tests'));
  fs.mkdirSync(path.join(tmp, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'pkg/app.py'), 'import os\n\n\ndef load(name):\n    """Load."""\n    return os.environ.get(name)\n\n\nclass Thing:\n    def run(self):\n        return load("X")\n');
  fs.writeFileSync(path.join(tmp, 'tests/test_app.py'), 'from pkg.app import load\n\n\ndef test_load():\n    assert load("NOPE") is None\n');
  fs.writeFileSync(path.join(tmp, '.env'), 'SECRET_KEY=hunter2\n');
  fs.writeFileSync(path.join(tmp, 'node_modules/x/index.js'), 'load()');
  fs.writeFileSync(path.join(tmp, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('workspace safety', () => {
  it('blocks traversal, absolute paths and .git', () => {
    const ws = new Workspace(tmp);
    expect(() => ws.resolve('../outside.txt')).toThrow(/escapes/);
    expect(() => ws.resolve('pkg/../../x')).toThrow(/escapes/);
    expect(() => ws.resolve('C:/Windows/win.ini')).toThrow(/absolute/);
    expect(() => ws.resolve('.git/config')).toThrow(/\.git/);
    expect(ws.resolve('pkg/app.py')).toBe(path.join(ws.root, 'pkg', 'app.py'));
  });
  it('excludes secrets, vendored folders and refuses to read .env', () => {
    const ws = new Workspace(tmp);
    const files = ws.listFiles().map(f => f.rel);
    expect(files).toContain('pkg/app.py');
    expect(files).not.toContain('.env');
    expect(files.some(f => f.startsWith('node_modules'))).toBe(false);
    expect(() => ws.readText('.env')).toThrow(/secrets/);
    expect(isSensitivePath('config/id_rsa')).toBe(true);
    expect(isSensitivePath('src/keys.py')).toBe(false);
  });
  it('reads line windows with numbers', () => {
    const r = new Workspace(tmp).readLines('pkg/app.py', 4, 6);
    expect(r.text.split('\n')[0]).toMatch(/^4\| def load/);
    expect(r.total).toBe(11);
  });
});

describe('search and symbols', () => {
  it('finds python defs with block extents and container', () => {
    const syms = extractSymbols('pkg/app.py', fs.readFileSync(path.join(tmp, 'pkg/app.py'), 'utf8'));
    const load = syms.find(s => s.name === 'load')!;
    expect(load.line).toBe(4);
    expect(load.endLine).toBe(6);
    expect(syms.find(s => s.name === 'run')!.container).toBe('Thing');
  });
  it('searches literally and by regex, finds references', () => {
    const ws = new Workspace(tmp);
    expect(searchWorkspace(ws, 'load(').matches.length).toBeGreaterThanOrEqual(2);
    expect(searchWorkspace(ws, '^def ', { regex: true }).matches.map(m => m.path)).toEqual(['pkg/app.py', 'tests/test_app.py']);
    const r = new SymbolIndex(ws).find('load');
    expect(r.definitions).toHaveLength(1);
    expect(r.references.length).toBeGreaterThanOrEqual(2);
  });
});

describe('proposals and per-hunk apply', () => {
  const original = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const proposed = original.replace('line 3\n', 'line three\n').replace('line 30\n', 'line thirty\nline 30b\n');
  it('produces separate hunks and applies any subset', () => {
    const { hunks, additions, deletions } = computeHunks(original, proposed, 'f.txt');
    expect(hunks).toHaveLength(2);
    expect(additions).toBe(3);
    expect(deletions).toBe(2);
    expect(applySelectedHunks(original, hunks, new Set([0, 1]))).toBe(proposed);
    expect(applySelectedHunks(original, hunks, new Set())).toBe(original);
    const onlySecond = applySelectedHunks(original, hunks, new Set([1]));
    expect(onlySecond).toContain('line 3\n');
    expect(onlySecond).toContain('line thirty\nline 30b\n');
    const onlyFirst = applySelectedHunks(original, hunks, new Set([0]));
    expect(onlyFirst).toContain('line three\n');
    expect(onlyFirst).not.toContain('thirty');
  });
  it('flags real deletions but not in-place edits', () => {
    const a = 'import ast\nimport os\nimport re\n\nx = 1\n';
    const b = 'import json\nimport os\n\nx = 2\n';
    const { hunks } = computeHunks(a, b, 'm.py');
    expect(removedLines({ hunks }).sort()).toEqual(['import ast', 'import re', 'x = 1'].sort());
    const moved = computeHunks('a = 1\nb = 2\n', 'b = 2\na = 1\n', 'm.py');
    expect(removedLines(moved)).toEqual([]);
  });
  it('handles files without a trailing newline', () => {
    const a = 'x\ny\nz';
    const b = 'x\nY\nz';
    const { hunks } = computeHunks(a, b, 'n.txt');
    expect(applySelectedHunks(a, hunks, new Set([0]))).toBe(b);
  });
  it('preserves CRLF line endings', () => {
    const ws = new Workspace(tmp);
    const store = new ProposalStore(ws);
    const p = store.propose('crlf.txt', { edits: [{ old_string: 'two', new_string: 'TWO' }] });
    expect(p.proposed).toBe('one\r\nTWO\r\nthree\r\n');
    expect(applySelectedHunks(p.original, p.hunks, new Set([0]))).toBe('one\r\nTWO\r\nthree\r\n');
  });
  it('rejects ambiguous or missing edits and never writes to disk', () => {
    const ws = new Workspace(tmp);
    const store = new ProposalStore(ws);
    expect(() => applyEdits('a a', [{ old_string: 'a', new_string: 'b' }])).toThrow(/occurs 2 times/);
    expect(() => store.propose('pkg/app.py', { edits: [{ old_string: 'nope', new_string: 'x' }] })).toThrow(/not found/);
    const before = fs.readFileSync(path.join(tmp, 'pkg/app.py'), 'utf8');
    const p1 = store.propose('pkg/app.py', { edits: [{ old_string: '"""Load."""', new_string: '"""Load a variable."""' }], summary: 'doc' });
    const p2 = store.propose('pkg/app.py', { edits: [{ old_string: 'return load("X")', new_string: 'return load("Y")' }], summary: 'run' });
    expect(p2.id).toBe(p1.id);
    expect(p2.proposed).toContain('Load a variable.');
    expect(p2.proposed).toContain('load("Y")');
    expect(fs.readFileSync(path.join(tmp, 'pkg/app.py'), 'utf8')).toBe(before);
    expect(() => store.propose('.env', { content: 'x' })).toThrow(/secrets/);
    expect(() => store.propose('pkg/app.py', { content: 'x' })).toThrow(/already exists/);
    const created = store.propose('pkg/new_mod.py', { content: 'X = 1\n' });
    expect(created.isNew).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'pkg/new_mod.py'))).toBe(false);
  });
});

describe('command policy', () => {
  it('parses env prefixes and quotes', () => {
    const r = parseCommandLine(`FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`);
    expect(r.env).toEqual({ FLASK_DEBUG: 'off' });
    expect(r.argv).toEqual(['python', '-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())']);
  });
  it('rejects shells, unknown programs, writes and installs', () => {
    expect(() => parseCommandLine('pytest | tee x')).toThrow(/operator/);
    expect(() => validateCommand(['rm', '-rf', '.'])).toThrow(/not an allowed/);
    expect(() => validateCommand(['git', 'reset', '--hard'])).toThrow(/read-only/);
    expect(() => validateCommand(['python', '-m', 'pip', 'install', 'x'])).toThrow(/installation/);
    expect(() => validateCommand(['C:/evil/python.exe'])).toThrow();
    expect(() => validateCommand(['pytest', 'tests/test_cli.py', '-q'])).not.toThrow();
  });
  it('refuses general-purpose code execution and secret reads (audit HIGH-1)', () => {
    const reject = (line: string) => {
      const { env, argv } = parseCommandLine(line);
      return () => validateCommand(argv, env);
    };
    for (const bad of [
      'python -c "print(1)"',
      'py -3 -c "print(1)"',
      'python script.py',
      'python -m http.server',
      'node -e "1"',
      'npx cowsay hi',
      'tox',
      'git show HEAD:.env',
      'git log --output=out.txt',
      'git grep -O foo',
      'git -c core.pager=x log',
      'ruff check --fix .',
      'ruff format .',
      `flask --app "os:system('calc')" routes`,
      `python -m flask --app "os:system('calc')" routes`,
      `FLASK_APP="os:system('calc')" flask routes`,
      'NODE_OPTIONS=--require=x pytest',
      'PYTHONSTARTUP=x.py pytest',
      'pytest --rootdir=. .env',
    ]) {
      expect(reject(bad), bad).toThrow();
    }
    for (const ok of [
      'pytest tests/test_cli.py -q',
      'pytest -k secrets -q',
      'python -m pytest tests -q',
      'py -3 -m pytest -q',
      'python --version',
      'flask --help',
      'flask --app demo_app config',
      'flask --app "app:create_app()" routes',
      'FLASK_DEBUG=off pytest tests/test_helpers.py -q',
      'git show HEAD:src/flask/cli.py',
      'git diff --stat',
      'ruff check src',
      'npm test',
    ]) {
      expect(reject(ok), ok).not.toThrow();
    }
  });
  it('refuses cmd.exe metacharacters for .cmd programs (audit HIGH-2)', () => {
    for (const bad of ['&echo x', 'a b', '%USERNAME%', 'x^y', '(x)', 'a|b', 'x"y', 'a,b', 'a=b']) expect(() => validateShellArgs([bad]), bad).toThrow(/cmd\.exe/);
    expect(() => validateShellArgs(['run', 'lint:ci', '--', '--watch'])).not.toThrow();
  });
  it('enforces timeouts and cancellation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-run-'));
    fs.writeFileSync(path.join(dir, 'slow_test.py'), 'import time, unittest\n\n\nclass T(unittest.TestCase):\n    def test_slow(self):\n        time.sleep(20)\n');
    const runner = new CommandRunner(dir);
    const t = await runner.run('python -m unittest slow_test', { timeoutMs: 1500 });
    expect(t.timedOut).toBe(true);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const c = await runner.run('python -m unittest slow_test', { signal: ac.signal });
    expect(c.cancelled).toBe(true);
  }, 30000);
});

describe('event helpers', () => {
  it('unwraps deferred call_tool meta calls', () => {
    const call = {
      id: 'c1',
      type: 'function' as const,
      function: { name: 'call_tool', arguments: JSON.stringify({ server_name: 'forge-workspace', tool_name: 'read_file', arguments: { path: 'a.py' } }) },
      toolInfo: { type: 'truefoundry-system', name: 'call_tool' },
    };
    const n = normalizeToolCall(call as never, 'main');
    expect(n.name).toBe('read_file');
    expect(n.server).toBe('forge-workspace');
    expect(n.args).toEqual({ path: 'a.py' });
  });
  it('resumes after transient provider conditions but not after auth/connect failures', () => {
    expect(rateLimitDelayMs('Request failed (429): quota exceeded. Please retry in 20.07s.', 0)).toBe(22070);
    expect(rateLimitDelayMs('[Model Error] This model is currently experiencing high demand.', 0)).toBe(10000);
    expect(rateLimitDelayMs('[Model Error] Request failed (503): overloaded', 1)).toBe(20000);
    expect(rateLimitDelayMs('Request failed (401): Invalid API Key', 0)).toBeUndefined();
    expect(rateLimitDelayMs('Cannot connect to API: connect ECONNREFUSED', 0)).toBeUndefined();
    expect(rateLimitDelayMs('Cannot connect to API: bad port', 0)).toBeUndefined();
    expect(rateLimitDelayMs('[Model Error] Cannot connect to API: Headers Timeout Error', 0)).toBe(5000);
    expect(rateLimitDelayMs('[Model Error] Cannot connect to API: Headers Timeout Error', 1)).toBeUndefined();
    expect(rateLimitDelayMs('[Model Error] Cannot connect to API: read ECONNRESET', 0)).toBe(10000);
    expect(rateLimitDelayMs('quota exceeded: requests per day', 0)).toBeUndefined();
  });
  it('classifies provider failures', () => {
    expect(isProviderFailure('401 Unauthorized: invalid x-api-key')).toBe(true);
    expect(isProviderFailure('connect ECONNREFUSED 127.0.0.1:9')).toBe(true);
  });
});

describe.runIf(hasFlask)('context retrieval on Flask 3.1.3', () => {
  const taskB =
    'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
  it('selects CLI source, CLI tests and CLI docs within budget without being told', () => {
    const ws = new Workspace(FLASK);
    const r = retrieveContext(ws, new SymbolIndex(ws), taskB, { budgetTokens: 6000 });
    const paths = r.selected.map(s => s.path);
    expect(paths).toContain('src/flask/cli.py');
    expect(paths).toContain('tests/test_cli.py');
    expect(paths).toContain('docs/cli.rst');
    expect(r.usedTokens).toBeLessThanOrEqual(6000);
    expect(r.selected.every(s => s.reason.length > 0 && s.ranges.length > 0)).toBe(true);
    expect(r.scanned).toBeGreaterThan(50);
  });
  it('finds get_debug_flag for the Task A instruction and honours pins', () => {
    const ws = new Workspace(FLASK);
    const r = retrieveContext(ws, new SymbolIndex(ws), "Treat the values 'off' and 'n' as false as well in get_debug_flag", { budgetTokens: 2000, pinnedFiles: ['src/flask/helpers.py'] });
    expect(r.selected[0]!.path).toBe('src/flask/helpers.py');
    expect(r.selected[0]!.pinned).toBe(true);
    expect(r.rendered).toContain('def get_debug_flag');
    expect(r.usedTokens).toBeLessThanOrEqual(2000);
  });
  it('extracts useful terms', () => {
    expect(extractTerms('Add flask config command masking SECRET')).toEqual(expect.arrayContaining(['flask', 'config', 'command', 'mask', 'secret']));
  });
});

describe('MCP server over Streamable HTTP', () => {
  it('lists tools and serves read_file / propose_file_change through a real MCP client', async () => {
    const tools = new ForgeTools(new Workspace(tmp));
    const port = 39170 + Math.floor(Math.random() * 500);
    const server = await startMcpHttpServer(tools, port);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(['find_symbol', 'list_files', 'list_pending_changes', 'propose_file_change', 'read_file', 'retrieve_context', 'run_command', 'search_workspace', 'submit_changes_for_review']);
    const read = (await client.callTool({ name: 'read_file', arguments: { path: 'pkg/app.py' } })) as { content: { text: string }[] };
    expect(read.content[0]!.text).toContain('def load');
    const bad = (await client.callTool({ name: 'read_file', arguments: { path: '../../etc/passwd' } })) as { content: { text: string }[]; isError?: boolean };
    expect(bad.isError).toBe(true);
    const staged = (await client.callTool({ name: 'propose_file_change', arguments: { path: 'pkg/app.py', edits: [{ old_string: 'Load.', new_string: 'Load it.' }], summary: 't' } })) as { content: { text: string }[] };
    expect(staged.content[0]!.text).toMatch(/Staged chg_/);
    const unapproved = (await client.callTool({ name: 'submit_changes_for_review', arguments: { summary: 'x' } })) as { content: { text: string }[] };
    expect(unapproved.content[0]!.text).toMatch(/Not applied/);
    expect(fs.readFileSync(path.join(tmp, 'pkg/app.py'), 'utf8')).toContain('"""Load."""');
    const notApproved = (await client.callTool({ name: 'run_command', arguments: { command: 'python --version' } })) as { content: { text: string }[]; isError?: boolean };
    expect(notApproved.isError).toBe(true);
    expect(notApproved.content[0]!.text).toMatch(/did not approve/);
    tools.approveCommand('python --version');
    const approved = (await client.callTool({ name: 'run_command', arguments: { command: 'python --version' } })) as { content: { text: string }[]; isError?: boolean };
    expect(approved.content[0]!.text).toMatch(/exit code 0/);
    const reused = (await client.callTool({ name: 'run_command', arguments: { command: 'python --version' } })) as { isError?: boolean };
    expect(reused.isError).toBe(true); // approvals are one-shot
    await client.close();
    server.close();
  }, 20000);

  it('refuses foreign Host headers and browser Origins (audit HIGH-3)', async () => {
    expect(rejectRequest({ headers: { host: '127.0.0.1:3917' } }, 3917)).toBeUndefined();
    expect(rejectRequest({ headers: { host: 'localhost:3917', 'sec-fetch-mode': 'cors' } }, 3917)).toBeUndefined();
    expect(rejectRequest({ headers: { host: 'attacker.example:3917' } }, 3917)).toMatch(/Host/);
    expect(rejectRequest({ headers: { host: '127.0.0.1:3917', origin: 'http://attacker.example' } }, 3917)).toMatch(/Origin/);
    expect(rejectRequest({ headers: {} }, 3917)).toMatch(/Host/);

    const tools = new ForgeTools(new Workspace(tmp));
    const port = 39700 + Math.floor(Math.random() * 200);
    const server = await startMcpHttpServer(tools, port);
    const post = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      });
    expect(await post({ host: `attacker.example:${port}` })).toBe(403);
    expect(await post({ host: `127.0.0.1:${port}`, origin: 'http://attacker.example' })).toBe(403);
    expect(await post({ host: `127.0.0.1:${port}` })).toBe(200);
    server.close();
  });
});
