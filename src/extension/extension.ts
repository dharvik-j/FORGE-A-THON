import * as vscode from 'vscode';
import type { Server } from 'node:http';
import { Workspace } from '../core/workspace';
import { ForgeTools, startMcpHttpServer } from '../core/mcpServer';
import { RunController, RunListener } from '../core/runController';
import { TrueForgeGateway } from '../core/trueforge';
import { DEFAULT_AGENTS, loadAgentTemplate, syncForge } from '../core/setup';
import { ContextResult } from '../core/context';
import { Applier } from './applier';
import { AgentPanel } from './agentPanel';
import { ProposalDocuments, REVIEW_SCHEME, ReviewPanel } from './reviewPanel';

export interface ForgeState {
  ws: Workspace;
  tools: ForgeTools;
  server: Server;
  gateway: TrueForgeGateway;
  controller: RunController;
  applier: Applier;
  review: ReviewPanel;
  fallbackAvailable: boolean;
  lastSessionUrl?: string;
}

let state: ForgeState | undefined;
const output = vscode.window.createOutputChannel('FORGE');

function cfg() {
  const c = vscode.workspace.getConfiguration('forge');
  return {
    url: c.get<string>('trueforgeUrl', 'http://localhost:8790'),
    port: c.get<number>('mcpPort', 3917),
    primaryAgent: c.get<string>('primaryAgent', DEFAULT_AGENTS.primary),
    fallbackAgent: c.get<string>('fallbackAgent', DEFAULT_AGENTS.fallback),
    primaryModel: c.get<string>('primaryModel', ''),
    fallbackModel: c.get<string>('fallbackModel', ''),
    budget: c.get<number>('contextBudgetTokens', 6000),
  };
}

/** The returned object is a small API used by the integration tests (test/vscode). */
export async function activate(context: vscode.ExtensionContext): Promise<{ state: () => ForgeState | undefined }> {
  const panel = new AgentPanel();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }));
  const docs = new ProposalDocuments();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, docs));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'forge.openAgent';
  context.subscriptions.push(status, output);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    status.text = '$(circle-slash) FORGE: open a folder';
    status.show();
    panel.post({ type: 'status', ok: false, text: 'Open a folder to use FORGE.' });
  } else {
    try {
      state = await boot(context, folder.uri.fsPath, panel, docs);
    } catch (e) {
      const msg = (e as Error).message;
      output.appendLine(`[boot] ${msg}`);
      panel.post({ type: 'status', ok: false, text: `FORGE failed to start: ${msg}` });
      void vscode.window.showErrorMessage(`FORGE failed to start: ${msg}`);
    }
  }

  const refreshStatus = async () => {
    if (!state) return;
    const c = cfg();
    try {
      const models = await state.gateway.listModels();
      const primary = await state.gateway.findAgent(c.primaryAgent);
      const fallback = c.fallbackAgent ? await state.gateway.findAgent(c.fallbackAgent) : undefined;
      state.fallbackAvailable = !!fallback;
      const ok = !!primary;
      const text = ok
        ? `TrueForge ${c.url} · agent ${c.primaryAgent}${fallback ? ` · fallback ${c.fallbackAgent}` : ' · no fallback'} · MCP :${c.port}`
        : models.length
          ? `Connected, but agent "${c.primaryAgent}" is missing — run “FORGE: Set up TrueForge”.`
          : 'Connected, but no models are configured in TrueForge (Settings → Models).';
      panel.post({ type: 'status', ok, text });
      status.text = ok ? `$(sparkle) FORGE${fallback ? '' : ' (no fallback)'}` : '$(warning) FORGE: setup needed';
      status.tooltip = text;
    } catch {
      panel.post({ type: 'status', ok: false, text: `TrueForge not reachable at ${c.url}. Start it: npx @truefoundry/trueforge@latest` });
      status.text = '$(debug-disconnect) FORGE: TrueForge offline';
    }
    status.show();
  };
  void refreshStatus();
  const timer = setInterval(() => void refreshStatus(), 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  const listener = (): RunListener => {
    const titles = new Map<string, string>();
    return {
      phase: (phase, detail) => {
        panel.post({ type: 'phase', phase, detail });
        output.appendLine(`[phase] ${phase}${detail ? `: ${detail}` : ''}`);
        if (phase === 'fallback') void vscode.window.showWarningMessage(detail ?? 'Primary model failed; retrying with fallback.');
      },
      attempt: a => {
        if (state) state.lastSessionUrl = a.sessionUrl;
        panel.post({ type: 'attempt', ...a });
        output.appendLine(`[session] ${a.agent} ${a.sessionUrl}`);
      },
      text: t => panel.post({ type: 'text', ...t, threadTitle: titles.get(t.threadId) }),
      toolCall: c => {
        panel.post({ type: 'tool', ...c });
        output.appendLine(`[tool] ${c.name} ${JSON.stringify(c.args).slice(0, 300)}`);
      },
      toolResult: r => panel.post({ type: 'toolResult', ...r, content: r.content.slice(0, 20_000) }),
      thread: t => {
        titles.set(t.threadId, t.title);
        panel.post({ type: 'thread', ...t });
      },
      note: n => panel.post({ type: 'note', text: n }),
      metrics: m => panel.post({ type: 'metrics', ...m }),
    };
  };

  const runTask = async (message: string, title: string, display: string) => {
    if (!state) {
      void vscode.window.showErrorMessage('FORGE is not running in this window (open a folder and check the FORGE output).');
      return;
    }
    if (state.controller.running) {
      void vscode.window.showWarningMessage('A FORGE run is already in progress.');
      return;
    }
    await refreshStatus();
    state.tools.contextBudgetTokens = cfg().budget;
    panel.reveal();
    panel.post({ type: 'user', text: display });
    const controller = state.controller;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'FORGE', cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => void controller.cancel());
        const l = listener();
        const phase = l.phase;
        l.phase = (p, d) => {
          phase(p, d);
          progress.report({ message: p === 'review' ? 'waiting for your review' : p === 'fallback' ? 'primary model failed — using fallback' : p });
        };
        const result = await controller.run({ message, title }, l);
        if (result.status === 'error') void vscode.window.showErrorMessage(`FORGE: ${result.message}`);
      },
    );
  };

  panel.onSend = text => {
    const { pinnedFiles, pinnedSymbols } = parseMentions(text);
    const pins = [
      pinnedFiles.length ? `Pinned files (@mentions): ${pinnedFiles.join(', ')}` : '',
      pinnedSymbols.length ? `Pinned symbols (@mentions): ${pinnedSymbols.join(', ')}` : '',
    ].filter(Boolean);
    const message = pins.length ? `${text}\n\n${pins.join('\n')}\n(Pass these as pinned_files / pinned_symbols to retrieve_context.)` : text;
    void runTask(message, text, text);
  };
  panel.onCancel = () => void state?.controller.cancel();
  panel.onCommand = cmd => void vscode.commands.executeCommand(cmd);

  context.subscriptions.push(
    vscode.commands.registerCommand('forge.openAgent', () => panel.reveal()),
    vscode.commands.registerCommand('forge.cancel', () => state?.controller.cancel()),
    vscode.commands.registerCommand('forge.openSession', () => {
      if (state?.lastSessionUrl) void vscode.env.openExternal(vscode.Uri.parse(state.lastSessionUrl));
      else void vscode.env.openExternal(vscode.Uri.parse(`${cfg().url}/sessions`));
    }),
    vscode.commands.registerCommand('forge.undoLastApply', async () => {
      if (!state) return;
      const last = state.applier.lastBatch;
      if (!last) {
        void vscode.window.showInformationMessage('FORGE has no applied change to undo.');
        return;
      }
      try {
        const b = await state.applier.undoLast();
        if (b) {
          void vscode.window.showInformationMessage(`FORGE reverted: ${b.files.map(f => f.path).join(', ')}`);
          panel.post({ type: 'note', text: `↶ Undid last apply: ${b.files.map(f => f.path).join(', ')}` });
        }
      } catch (e) {
        void vscode.window.showWarningMessage((e as Error).message);
      }
    }),
    vscode.commands.registerCommand('forge.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !state) return;
      const rel = state.ws.relative(editor.document.uri.fsPath);
      if (rel.startsWith('..')) {
        void vscode.window.showWarningMessage('FORGE inline edit works on files inside the open folder.');
        return;
      }
      let sel: vscode.Range = editor.selection;
      if (editor.selection.isEmpty) sel = editor.document.lineAt(editor.selection.active.line).range;
      const selected = editor.document.getText(sel);
      const instruction = await vscode.window.showInputBox({
        title: `FORGE inline edit — ${rel}:${sel.start.line + 1}-${sel.end.line + 1}`,
        prompt: 'Describe the change to the selected code',
        ignoreFocusOut: true,
      });
      if (!instruction) return;
      if (editor.document.isDirty) await editor.document.save();
      const lang = editor.document.languageId;
      const message = [
        'INLINE EDIT of a selected region.',
        `File: ${rel}`,
        `Selected lines: ${sel.start.line + 1}-${sel.end.line + 1} (exact text below)`,
        '```' + lang,
        selected,
        '```',
        `Instruction: ${instruction}`,
        '',
        'Change only the selected region (and anything inside it the instruction requires). Read the file with read_file first, stage the change with propose_file_change, then call submit_changes_for_review.',
      ].join('\n');
      await runTask(message, `Inline edit ${rel}: ${instruction}`, `✎ ${rel}:${sel.start.line + 1}-${sel.end.line + 1}\n${instruction}`);
    }),
    vscode.commands.registerCommand('forge.setup', async () => {
      if (!state) return;
      const c = cfg();
      let models: string[] = [];
      try {
        models = await state.gateway.listModels();
      } catch (e) {
        void vscode.window.showErrorMessage(`TrueForge not reachable at ${c.url}: ${(e as Error).message}`);
        return;
      }
      if (!models.length) {
        void vscode.window.showErrorMessage('No models are configured in TrueForge. Open TrueForge → Settings → Models and add a provider first.', 'Open TrueForge').then(a => {
          if (a) void vscode.env.openExternal(vscode.Uri.parse(`${c.url}/settings`));
        });
        return;
      }
      const primary = await vscode.window.showQuickPick(models, { title: 'FORGE: primary model', placeHolder: c.primaryModel || 'Model the coding agent normally runs on' });
      if (!primary) return;
      const fallback = await vscode.window.showQuickPick(['(none)', ...models.filter(m => m !== primary)], { title: 'FORGE: fallback model (used automatically if the primary fails)' });
      const fb = fallback && fallback !== '(none)' ? fallback : undefined;
      const conf = vscode.workspace.getConfiguration('forge');
      await conf.update('primaryModel', primary, vscode.ConfigurationTarget.Global);
      await conf.update('fallbackModel', fb ?? '', vscode.ConfigurationTarget.Global);
      try {
        const log = await syncForge(state.gateway, loadAgentTemplate(context.extensionPath), {
          mcpUrl: `http://127.0.0.1:${c.port}/mcp`,
          primaryModel: primary,
          fallbackModel: fb,
          primaryAgent: c.primaryAgent,
          fallbackAgent: c.fallbackAgent,
        });
        log.forEach(l => output.appendLine(`[setup] ${l}`));
        void vscode.window.showInformationMessage(`FORGE is set up: ${log.filter(l => !l.startsWith('warning')).join(' · ')}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`FORGE setup failed: ${(e as Error).message}`);
      }
      await refreshStatus();
    }),
    vscode.commands.registerCommand('forge.showOutput', () => output.show()),
  );
  return { state: () => state };
}

async function boot(context: vscode.ExtensionContext, root: string, panel: AgentPanel, docs: ProposalDocuments): Promise<ForgeState> {
  const c = cfg();
  const ws = new Workspace(root);
  const tools = new ForgeTools(ws);
  tools.contextBudgetTokens = c.budget;
  let server: Server;
  try {
    server = await startMcpHttpServer(tools, c.port);
  } catch (e) {
    throw new Error(`could not listen on 127.0.0.1:${c.port} for the MCP server (${(e as Error).message}). Is another VS Code window running FORGE? Change forge.mcpPort and re-run setup.`);
  }
  output.appendLine(`[boot] MCP server http://127.0.0.1:${c.port}/mcp serving ${root}`);
  tools.on('context', (r: ContextResult) => {
    panel.post({ type: 'context', selected: r.selected, candidates: r.candidates, scanned: r.scanned, usedTokens: r.usedTokens, budgetTokens: r.budgetTokens, terms: r.terms });
    output.appendLine(`[context] ${r.selected.map(s => s.path).join(', ')} (~${r.usedTokens}/${r.budgetTokens} tokens)`);
  });
  tools.on('command', (i: { command: string; phase: string; exitCode?: number | null }) => output.appendLine(`[command] ${i.phase} ${i.command}${i.exitCode !== undefined ? ` → ${i.exitCode}` : ''}`));
  const gateway = new TrueForgeGateway(c.url);
  const applier = new Applier(ws);
  const review = new ReviewPanel(context, applier, docs);
  review.onActivity = s => panel.post({ type: 'note', text: s });
  const st: ForgeState = { ws, tools, server, gateway, applier, review, fallbackAvailable: false, controller: undefined as unknown as RunController };
  st.controller = new RunController(gateway, tools, review, () => {
    const cc = cfg();
    return { primary: cc.primaryAgent, fallback: st.fallbackAvailable ? cc.fallbackAgent : undefined };
  });
  context.subscriptions.push({ dispose: () => server.close() });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('forge.trueforgeUrl')) void vscode.window.showInformationMessage('Reload the window to apply the new TrueForge URL.');
    }),
  );
  return st;
}

export function parseMentions(text: string): { pinnedFiles: string[]; pinnedSymbols: string[] } {
  const pinnedFiles: string[] = [];
  const pinnedSymbols: string[] = [];
  for (const m of text.matchAll(/@(symbol:)?([\w./\\-]+)/g)) {
    const val = m[2]!.replace(/[.,;:]+$/, '');
    if (m[1]) pinnedSymbols.push(val);
    else if (state?.ws.exists(val)) pinnedFiles.push(val.replace(/\\/g, '/'));
    else if (/^[A-Za-z_][\w.]*$/.test(val)) pinnedSymbols.push(val);
  }
  return { pinnedFiles, pinnedSymbols };
}

export async function deactivate(): Promise<void> {
  if (state?.controller.running) await state.controller.cancel();
  state?.server.close();
}

