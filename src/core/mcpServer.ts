import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { MAX_READ_LINES, Workspace, formatLines, globToRegExp, toPosix } from './workspace';
import { SymbolIndex, searchWorkspace } from './search';
import { ContextResult, retrieveContext } from './context';
import { ProposalStore, removedLines, unifiedDiff } from './proposals';
import { CommandRunner } from './commands';

export const MCP_SERVER_NAME = 'forge-workspace';
export const REVIEW_TOOL = 'submit_changes_for_review';

export interface ReviewOutcome {
  applied: { path: string; acceptedHunks: number; totalHunks: number }[];
  rejected: { path: string; reason: string }[];
  note?: string;
}

/** Events the extension listens to so the UI can show structured activity, not only raw tool text. */
export interface ForgeToolEvents {
  context: (result: ContextResult) => void;
  command: (info: { command: string; phase: 'start' | 'end'; exitCode?: number | null; durationMs?: number }) => void;
}

export class ForgeTools extends EventEmitter {
  readonly index: SymbolIndex;
  readonly store: ProposalStore;
  readonly runner: CommandRunner;
  contextBudgetTokens = 6000;
  /** Set by the run controller for the active turn; aborted on cancel. */
  signal: AbortSignal | undefined;
  private pendingOutcome: ReviewOutcome | undefined;

  constructor(readonly ws: Workspace) {
    super();
    this.index = new SymbolIndex(ws);
    this.store = new ProposalStore(ws);
    this.runner = new CommandRunner(ws.root);
  }

  /** Called by the extension after the user finished reviewing, right before it approves the review tool call. */
  setReviewOutcome(o: ReviewOutcome): void {
    this.pendingOutcome = o;
  }

  takeReviewOutcome(): ReviewOutcome | undefined {
    const o = this.pendingOutcome;
    this.pendingOutcome = undefined;
    return o;
  }

  emitTyped<K extends keyof ForgeToolEvents>(event: K, ...args: Parameters<ForgeToolEvents[K]>): void {
    this.emit(event, ...args);
  }
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${t}` }], isError: true });

function guard<A>(fn: (a: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}

export function buildMcpServer(tools: ForgeTools): McpServer {
  const { ws, index, store } = tools;
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });

  server.registerTool(
    'retrieve_context',
    {
      title: 'Retrieve relevant code',
      description:
        'Ranked, budgeted retrieval over the whole repository. Give it the task in plain language; it extracts search terms, scores every source/test/doc file (term frequency weighted by rarity, path and symbol matches), and returns the most relevant files with the reason each was chosen and line-numbered excerpts that fit within a token budget. Call this FIRST for any task, then read_file for anything you need in full.',
      inputSchema: {
        task: z.string().describe('The task or question, in plain language'),
        pinned_files: z.array(z.string()).optional().describe('Workspace-relative files the user explicitly mentioned (@file)'),
        pinned_symbols: z.array(z.string()).optional().describe('Symbols the user explicitly mentioned (@symbol)'),
        budget_tokens: z.number().int().optional().describe('Approximate token budget for excerpts (default from settings)'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ task, pinned_files, pinned_symbols, budget_tokens }) => {
      const result = retrieveContext(ws, index, task, {
        budgetTokens: budget_tokens ?? tools.contextBudgetTokens,
        pinnedFiles: pinned_files,
        pinnedSymbols: pinned_symbols,
      });
      tools.emitTyped('context', result);
      return text(result.rendered);
    }),
  );

  server.registerTool(
    'list_files',
    {
      title: 'List workspace files',
      description: 'List text files in the workspace (vendored, generated, binary and secret files are excluded). Optionally filter with a glob such as "src/**/*.py" or "docs/*.rst".',
      inputSchema: { glob: z.string().optional(), limit: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    },
    guard(({ glob, limit }) => {
      const files = ws.listFiles();
      const re = glob ? globToRegExp(glob) : undefined;
      const matched = files.filter(f => !re || re.test(f.rel));
      const max = Math.min(limit ?? 200, 500);
      const lines = matched.slice(0, max).map(f => `${f.rel} (${f.size} B)`);
      return text(`${matched.length} file(s)${matched.length > max ? `, showing ${max}` : ''}:\n${lines.join('\n')}`);
    }),
  );

  server.registerTool(
    'search_workspace',
    {
      title: 'Search code',
      description: 'Search file contents (literal by default, or a JavaScript regular expression with regex=true). Returns path:line: text for each match.',
      inputSchema: {
        query: z.string(),
        regex: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
        path_glob: z.string().optional().describe('Restrict to files matching this glob, e.g. "tests/*.py"'),
        max_results: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ query, regex, case_sensitive, path_glob, max_results }) => {
      const r = searchWorkspace(ws, query, { regex, caseSensitive: case_sensitive, pathGlob: path_glob, maxResults: max_results });
      if (!r.matches.length) return text(`No matches for ${JSON.stringify(query)}.`);
      return text(
        `${r.matches.length} match(es) in ${r.filesMatched} file(s)${r.truncated ? ' (truncated; narrow with path_glob)' : ''}:\n` +
          r.matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n'),
      );
    }),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description: `Read a workspace file with line numbers. Use start_line/end_line for large files (max ${MAX_READ_LINES} lines per call). Line-number prefixes ("  12| ") are not part of the file.`,
      inputSchema: { path: z.string(), start_line: z.number().int().optional(), end_line: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    },
    guard(({ path, start_line, end_line }) => {
      const pending = store.list().find(p => p.path === toPosix(path).replace(/^\.\//, ''));
      const r = pending ? formatLines(pending.proposed, start_line, end_line) : ws.readLines(path, start_line, end_line);
      const note = r.truncated || r.end < r.total ? `\n[showing lines ${r.start}-${r.end} of ${r.total}; request more with start_line]` : '';
      const head = pending
        ? `${path} — STAGED VERSION including your unapplied change ${pending.id} (not on disk yet; further edits apply to this text) (lines ${r.start}-${r.end} of ${r.total})`
        : `${path} (lines ${r.start}-${r.end} of ${r.total})`;
      return text(`${head}\n${r.text}${note}`);
    }),
  );

  server.registerTool(
    'find_symbol',
    {
      title: 'Find symbol',
      description: 'Find where a function, class or method is defined (e.g. "get_debug_flag" or "FlaskGroup.list_commands") and where it is referenced.',
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(({ name }) => {
      const r = index.find(name);
      const defs = r.definitions.map(d => `${d.path}:${d.line}-${d.endLine} ${d.kind} ${d.container ? `${d.container}.` : ''}${d.name}: ${d.signature}`);
      const refs = r.references.slice(0, 30).map(m => `${m.path}:${m.line}: ${m.text}`);
      return text(`Definitions (${defs.length}):\n${defs.join('\n') || '(none)'}\n\nReferences (${r.references.length}${r.references.length > 30 ? ', first 30' : ''}):\n${refs.join('\n') || '(none)'}`);
    }),
  );

  server.registerTool(
    'propose_file_change',
    {
      title: 'Stage a file change',
      description:
        'Stage a change to ONE file for human review. Nothing is written to disk. Existing files: pass "edits", each an exact old_string/new_string replacement (old_string copied from read_file without line-number prefixes, matching indentation, unique in the file). Every line in old_string that is not repeated in new_string is DELETED, so to insert code next to existing code, include the existing lines in new_string too (e.g. old_string = the decorator line of the next function, new_string = your new function + that same decorator line). New files: pass "content". Calling again for the same file stacks on the previously staged version (read_file shows that staged version). Check the returned diff: lines starting with "-" will be removed.',
      inputSchema: {
        path: z.string().describe('Workspace-relative path'),
        edits: z
          .array(z.object({ old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }))
          .optional(),
        content: z.string().optional().describe('Full content for a NEW file only'),
        summary: z.string().describe('One line describing the change'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(({ path, edits, content, summary }) => {
      const p = store.propose(path, { edits, content, summary });
      const removed = removedLines(p);
      const warn = removed.length
        ? `\n\nWARNING: this change DELETES ${removed.length} existing line(s) that are not re-added anywhere in it:\n${removed.slice(0, 12).map(l => `  - ${l}`).join('\n')}${removed.length > 12 ? '\n  …' : ''}\nIf the task did not ask you to remove them, restore them with another propose_file_change edit before submitting.`
        : '';
      return text(`Staged ${p.id} for ${p.path}${p.isNew ? ' (new file)' : ''}: +${p.additions} -${p.deletions} in ${p.hunks.length} hunk(s). Not yet applied.${warn}\n\n${unifiedDiff(p)}`);
    }),
  );

  server.registerTool(
    'list_pending_changes',
    {
      title: 'List staged changes',
      description: 'List changes staged with propose_file_change that have not yet been reviewed.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(() => {
      const list = store.list();
      if (!list.length) return text('No staged changes.');
      return text(list.map(p => `${p.id} ${p.path}${p.isNew ? ' (new)' : ''} +${p.additions} -${p.deletions}, ${p.hunks.length} hunk(s): ${p.summary}`).join('\n'));
    }),
  );

  server.registerTool(
    REVIEW_TOOL,
    {
      title: 'Submit staged changes for human review',
      description:
        'Ask the user to review every staged change. The user sees each hunk and may accept or reject it individually; only accepted hunks are written to disk. Call this ONCE after staging all files for the task. The result tells you exactly which files/hunks were applied and which were rejected.',
      inputSchema: { summary: z.string().describe('What the change does and why these files') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guard(() => {
      const outcome = tools.takeReviewOutcome();
      if (!outcome) {
        return text('Not applied: this approval did not come from the FORGE review panel, so nothing was written. Staged changes are unchanged.');
      }
      const lines = [
        ...outcome.applied.map(a => `APPLIED ${a.path}: ${a.acceptedHunks}/${a.totalHunks} hunk(s)`),
        ...outcome.rejected.map(r => `REJECTED ${r.path}: ${r.reason}`),
      ];
      if (outcome.note) lines.push(outcome.note);
      return text(`Review finished.\n${lines.join('\n')}`);
    }),
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run a command',
      description:
        'Run one program in the workspace root without a shell (no pipes or redirects). Allowed: python, pytest, flask, git (read-only), node, npm test. A project virtualenv (.venv) is used automatically. Environment variables may be prefixed, e.g. "FLASK_DEBUG=off python -c \\"...\\"". Use it to run tests after your changes have been applied.',
      inputSchema: { command: z.string(), timeout_seconds: z.number().int().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guard(async ({ command, timeout_seconds }) => {
      tools.emitTyped('command', { command, phase: 'start' });
      const r = await tools.runner.run(command, { timeoutMs: (timeout_seconds ?? 120) * 1000, signal: tools.signal });
      tools.emitTyped('command', { command, phase: 'end', exitCode: r.exitCode, durationMs: r.durationMs });
      const status = r.cancelled ? 'CANCELLED' : r.timedOut ? 'TIMED OUT' : `exit code ${r.exitCode}`;
      return text(`$ ${command}\n${status} (${r.durationMs} ms)\n--- stdout ---\n${r.stdout || '(empty)'}\n--- stderr ---\n${r.stderr || '(empty)'}`);
    }),
  );

  return server;
}

/** Stateless Streamable HTTP MCP endpoint on 127.0.0.1. A fresh McpServer/transport pair serves each request. */
export function startMcpHttpServer(tools: ForgeTools, port: number): Promise<http.Server> {
  const httpServer = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const server = buildMcpServer(tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null }));
    }
  });
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve(httpServer));
  });
}
