import * as vscode from 'vscode';
import { Proposal, removedLines } from '../core/proposals';
import { ReviewOutcome } from '../core/mcpServer';
import { ReviewHost, ReviewRequest } from '../core/runController';
import { Applier, StaleProposalError } from './applier';
import { nonce, escapeHtml } from './html';

export const REVIEW_SCHEME = 'forge-review';

type Decision = 'accept' | 'reject';

/** Serves the original and proposed text of staged changes to VS Code's diff editor. */
export class ProposalDocuments implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  set(uri: vscode.Uri, text: string) {
    this.docs.set(uri.toString(), text);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }
}

/**
 * The human checkpoint. Opened when TrueForge pauses the turn on `submit_changes_for_review`; the user decides each
 * hunk, and only accepted hunks are applied (via Applier) before the extension answers the approval.
 */
export class ReviewPanel implements ReviewHost {
  private panel: vscode.WebviewPanel | undefined;
  private current: { proposals: Proposal[]; decisions: Map<string, Map<number, Decision>>; summary: string; stale: Set<string>; resolve: (o: ReviewOutcome & { dismissed?: boolean }) => void } | undefined;
  onActivity: ((s: string) => void) | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private applier: Applier,
    private docs: ProposalDocuments,
  ) {}

  review(req: ReviewRequest): Promise<ReviewOutcome & { dismissed?: boolean }> {
    return new Promise(async resolve => {
      const stale = new Set(await this.applier.findStale(req.proposals));
      const decisions = new Map(req.proposals.map(p => [p.id, new Map<number, Decision>()]));
      this.current = { proposals: req.proposals, decisions, summary: req.summary, stale, resolve };
      for (const p of req.proposals) {
        this.docs.set(this.docUri(p, 'original'), p.original);
        this.docs.set(this.docUri(p, 'proposed'), p.proposed);
      }
      const onAbort = () => this.finish({ applied: [], rejected: [], dismissed: true });
      req.signal.addEventListener('abort', onAbort, { once: true });
      await this.openDiff(req.proposals[0]!);
      this.show();
    });
  }

  private docUri(p: Proposal, side: 'original' | 'proposed'): vscode.Uri {
    return vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${p.id}/${side}/${p.path}` });
  }

  private async openDiff(p: Proposal) {
    await vscode.commands.executeCommand('vscode.diff', this.docUri(p, 'original'), this.docUri(p, 'proposed'), `FORGE proposal: ${p.path}${p.isNew ? ' (new file)' : ''}`, {
      preview: true,
      viewColumn: vscode.ViewColumn.One,
    });
  }

  private show() {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('forge.review', 'FORGE Review', { viewColumn: vscode.ViewColumn.Two, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
      this.panel.onDidDispose(() => {
        if (process.env.FORGE_DEBUG_REVIEW) console.log('[review] panel disposed', new Error().stack);
        this.panel = undefined;
        if (this.current) this.finish({ applied: [], rejected: this.current.proposals.map(p => ({ path: p.path, reason: 'review closed' })), dismissed: true });
      });
      this.panel.webview.onDidReceiveMessage(m => void this.onMessage(m));
    }
    this.panel.reveal(vscode.ViewColumn.Two);
    this.render();
  }

  private finish(o: ReviewOutcome & { dismissed?: boolean }) {
    const cur = this.current;
    if (!cur) return;
    this.current = undefined;
    cur.resolve(o);
    if (this.panel) {
      this.panel.webview.html = this.doneHtml(o);
    }
  }

  private async onMessage(m: { type: string; id?: string; hunk?: number; decision?: Decision }) {
    const cur = this.current;
    if (!cur) return;
    const p = cur.proposals.find(x => x.id === m.id);
    switch (m.type) {
      case 'decide':
        if (p && m.hunk !== undefined && m.decision) cur.decisions.get(p.id)!.set(m.hunk, m.decision);
        break;
      case 'file':
        if (p && m.decision) for (const h of p.hunks) cur.decisions.get(p.id)!.set(h.index, m.decision);
        break;
      case 'all':
        for (const q of cur.proposals) for (const h of q.hunks) cur.decisions.get(q.id)!.set(h.index, m.decision ?? 'accept');
        break;
      case 'diff':
        if (p) await this.openDiff(p);
        return;
      case 'apply':
        await this.apply();
        return;
      case 'dismiss':
        this.finish({ applied: [], rejected: cur.proposals.map(x => ({ path: x.path, reason: 'review cancelled by user' })), dismissed: true });
        return;
    }
    this.render();
  }

  private async apply() {
    const cur = this.current!;
    const selection: { proposal: Proposal; accepted: Set<number> }[] = [];
    const rejected: ReviewOutcome['rejected'] = [];
    for (const p of cur.proposals) {
      const d = cur.decisions.get(p.id)!;
      const accepted = new Set(p.hunks.filter(h => d.get(h.index) === 'accept').map(h => h.index));
      const rejectedHunks = p.hunks.length - accepted.size;
      if (cur.stale.has(p.path)) {
        rejected.push({ path: p.path, reason: 'file changed after the proposal was made (stale); not applied' });
        continue;
      }
      if (!accepted.size) rejected.push({ path: p.path, reason: 'all hunks rejected by user' });
      else {
        selection.push({ proposal: p, accepted });
        if (rejectedHunks) rejected.push({ path: p.path, reason: `${rejectedHunks} of ${p.hunks.length} hunk(s) rejected by user (the rest were applied)` });
      }
    }
    if (!selection.length) {
      this.finish({ applied: [], rejected });
      return;
    }
    try {
      const batch = await this.applier.apply(selection, cur.summary || 'FORGE change');
      this.onActivity?.(`Applied ${batch.files.length} file(s). "FORGE: Undo Last Apply" reverts them.`);
      this.finish({
        applied: selection.map(s => ({ path: s.proposal.path, acceptedHunks: s.accepted.size, totalHunks: s.proposal.hunks.length })),
        rejected,
      });
      for (const f of batch.files) await vscode.window.showTextDocument(f.uri, { preview: false, preserveFocus: true, viewColumn: vscode.ViewColumn.One });
    } catch (e) {
      if (e instanceof StaleProposalError) {
        void vscode.window.showWarningMessage(e.message);
        cur.stale = new Set(await this.applier.findStale(cur.proposals));
        this.render();
      } else {
        void vscode.window.showErrorMessage(`FORGE could not apply the change: ${(e as Error).message}`);
      }
    }
  }

  private render() {
    if (!this.panel || !this.current) return;
    const cur = this.current;
    const n = nonce();
    let total = 0;
    let decided = 0;
    let accepted = 0;
    const files = cur.proposals
      .map(p => {
        const d = cur.decisions.get(p.id)!;
        const stale = cur.stale.has(p.path);
        const hunks = p.hunks
          .map(h => {
            total++;
            const dec = d.get(h.index);
            if (dec) decided++;
            if (dec === 'accept') accepted++;
            const body = h.lines
              .filter(l => !l.startsWith('\\'))
              .map(l => `<div class="ln ${l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx'}"><span class="g">${escapeHtml(l[0] ?? ' ')}</span>${escapeHtml(l.slice(1)) || '&nbsp;'}</div>`)
              .join('');
            const removes = removedLines(p, h.index).length;
            return `<section class="hunk ${dec ?? 'undecided'}">
              <header><span class="loc">@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</span>${removes ? `<span class="tag warn" title="Lines removed by this hunk are not re-added anywhere in the change">deletes ${removes} existing line(s)</span>` : ''}
              <span class="state">${dec === 'accept' ? 'Accepted' : dec === 'reject' ? 'Rejected' : 'Undecided'}</span>
              <button data-act="decide" data-id="${p.id}" data-hunk="${h.index}" data-decision="accept" class="${dec === 'accept' ? 'on' : ''}">Accept</button>
              <button data-act="decide" data-id="${p.id}" data-hunk="${h.index}" data-decision="reject" class="${dec === 'reject' ? 'on' : ''}">Reject</button></header>
              <pre>${body}</pre></section>`;
          })
          .join('');
        return `<article class="file">
          <h2><span class="path">${escapeHtml(p.path)}</span>${p.isNew ? '<span class="tag">new file</span>' : ''}${stale ? '<span class="tag warn">stale — changed since proposed</span>' : ''}
          <span class="stats"><span class="a">+${p.additions}</span> <span class="d">−${p.deletions}</span> · ${p.hunks.length} hunk(s)</span></h2>
          <div class="filebar"><button data-act="diff" data-id="${p.id}">Open side-by-side diff</button>
          <button data-act="file" data-id="${p.id}" data-decision="accept">Accept file</button>
          <button data-act="file" data-id="${p.id}" data-decision="reject">Reject file</button></div>
          ${hunks}</article>`;
      })
      .join('');
    const ready = decided === total;
    this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">${REVIEW_CSS}</style></head><body>
<div class="top"><div><h1>Review proposed changes</h1><p class="sum">${escapeHtml(cur.summary || 'The agent staged these changes. Nothing has been written to disk yet.')}</p></div>
<div class="actions"><span class="count">${decided}/${total} hunks decided · ${accepted} accepted</span>
<button data-act="all" data-decision="accept">Accept all</button><button data-act="all" data-decision="reject">Reject all</button>
<button data-act="apply" class="primary" ${ready ? '' : 'disabled'} title="${ready ? '' : 'Decide every hunk first'}">${accepted ? `Apply ${accepted} accepted hunk(s)` : 'Finish (apply nothing)'}</button>
<button data-act="dismiss">Cancel review</button></div></div>
${files}
<script nonce="${n}">const vs=acquireVsCodeApi();document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;vs.postMessage({type:b.dataset.act,id:b.dataset.id,hunk:b.dataset.hunk!==undefined?Number(b.dataset.hunk):undefined,decision:b.dataset.decision});});</script>
</body></html>`;
  }

  private doneHtml(o: ReviewOutcome & { dismissed?: boolean }): string {
    const n = nonce();
    const rows = [
      ...o.applied.map(a => `<li class="ok">Applied ${escapeHtml(a.path)} — ${a.acceptedHunks}/${a.totalHunks} hunk(s)</li>`),
      ...o.rejected.map(r => `<li class="no">Not applied ${escapeHtml(r.path)} — ${escapeHtml(r.reason)}</li>`),
    ].join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}';"><style nonce="${n}">${REVIEW_CSS}</style></head>
<body><div class="top"><div><h1>${o.dismissed ? 'Review closed' : 'Review finished'}</h1><p class="sum">${o.applied.length ? 'Applied changes can be reverted with “FORGE: Undo Last Apply”.' : 'No files were changed.'}</p></div></div><ul class="done">${rows}</ul></body></html>`;
  }
}

const REVIEW_CSS = `
:root{--add:rgba(46,160,67,.18);--del:rgba(248,81,73,.18)}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:0 16px 32px;margin:0}
.top{position:sticky;top:0;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);padding:12px 0;display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:flex-start;z-index:2}
h1{font-size:15px;margin:0 0 4px;font-weight:600}.sum{margin:0;opacity:.8;max-width:60ch}
.actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.count{opacity:.75;margin-right:6px;font-variant-numeric:tabular-nums}
button{font:inherit;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid transparent;border-radius:3px;padding:3px 10px;cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button.primary:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.45;cursor:default}button.on{outline:1px solid var(--vscode-focusBorder)}
.file{margin-top:18px;border:1px solid var(--vscode-panel-border);border-radius:4px;overflow:hidden}
.file h2{margin:0;font-size:13px;font-weight:600;padding:8px 10px;background:var(--vscode-sideBarSectionHeader-background);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.path{font-family:var(--vscode-editor-font-family)}.stats{margin-left:auto;font-weight:400;opacity:.85}.a{color:var(--vscode-gitDecoration-addedResourceForeground)}.d{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.tag{font-size:11px;font-weight:400;padding:1px 6px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.tag.warn{background:var(--vscode-inputValidation-warningBackground)}
.filebar{display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border)}
.hunk{border-top:1px solid var(--vscode-panel-border)}.hunk header{display:flex;gap:6px;align-items:center;padding:4px 10px;background:var(--vscode-editorGroupHeader-tabsBackground)}
.loc{font-family:var(--vscode-editor-font-family);opacity:.7}.state{margin-left:auto;font-size:11px;opacity:.85}
.hunk.accept{box-shadow:inset 3px 0 0 var(--vscode-gitDecoration-addedResourceForeground)}.hunk.reject{box-shadow:inset 3px 0 0 var(--vscode-gitDecoration-deletedResourceForeground)}.hunk.reject pre{opacity:.5}
pre{margin:0;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);overflow-x:auto}
.ln{white-space:pre;padding:0 10px}.ln.add{background:var(--add)}.ln.del{background:var(--del)}.g{display:inline-block;width:1.4em;opacity:.6;user-select:none}
.done{list-style:none;padding:0}.done li{padding:6px 0;border-bottom:1px solid var(--vscode-panel-border)}.done .ok::before{content:'✓ ';color:var(--vscode-gitDecoration-addedResourceForeground)}.done .no::before{content:'✗ ';color:var(--vscode-gitDecoration-deletedResourceForeground)}
`;
