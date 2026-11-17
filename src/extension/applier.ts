import * as vscode from 'vscode';
import { Proposal, applySelectedHunks, hashText } from '../core/proposals';
import { Workspace } from '../core/workspace';

export interface AppliedFile {
  path: string;
  uri: vscode.Uri;
  before: string | undefined;
  after: string;
}

export interface ApplyBatch {
  id: number;
  label: string;
  files: AppliedFile[];
  at: number;
}

export class StaleProposalError extends Error {}

/**
 * Applies accepted hunks through VS Code's WorkspaceEdit (so the change is one editor operation and Ctrl+Z works),
 * keeps a record of every batch, and can undo the most recent batch across all of its files.
 */
export class Applier {
  private history: ApplyBatch[] = [];
  private seq = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private ws: Workspace) {}

  get lastBatch(): ApplyBatch | undefined {
    return this.history[this.history.length - 1];
  }

  async currentText(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return undefined;
    }
  }

  /** Returns the paths whose on-disk/in-editor content no longer matches what the agent saw. */
  async findStale(proposals: Proposal[]): Promise<string[]> {
    const stale: string[] = [];
    for (const p of proposals) {
      const uri = vscode.Uri.file(this.ws.resolve(p.path));
      const cur = await this.currentText(uri);
      if (p.isNew ? cur !== undefined : cur === undefined || hashText(cur) !== p.baseHash) stale.push(p.path);
    }
    return stale;
  }

  async apply(selection: { proposal: Proposal; accepted: Set<number> }[], label: string): Promise<ApplyBatch> {
    const edit = new vscode.WorkspaceEdit();
    const files: AppliedFile[] = [];
    for (const { proposal: p, accepted } of selection) {
      if (!accepted.size) continue;
      const uri = vscode.Uri.file(this.ws.resolve(p.path));
      const cur = await this.currentText(uri);
      if (p.isNew ? cur !== undefined : cur === undefined || hashText(cur) !== p.baseHash) {
        throw new StaleProposalError(`${p.path} changed after the agent proposed this edit; refusing to overwrite it.`);
      }
      const next = applySelectedHunks(p.original, p.hunks, accepted);
      if (p.isNew) {
        edit.createFile(uri, { ignoreIfExists: false, contents: Buffer.from(next, 'utf8') });
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), next);
      }
      files.push({ path: p.path, uri, before: p.isNew ? undefined : p.original, after: next });
    }
    if (!files.length) throw new Error('nothing to apply');
    const ok = await vscode.workspace.applyEdit(edit, { isRefactoring: false });
    if (!ok) throw new Error('VS Code rejected the edit');
    for (const f of files) {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === f.uri.toString());
      if (doc?.isDirty) await doc.save();
    }
    this.ws.invalidate();
    const batch: ApplyBatch = { id: ++this.seq, label, files, at: Date.now() };
    this.history.push(batch);
    this.changed.fire();
    return batch;
  }

  /** Revert the most recent applied batch, provided nobody edited those files since. */
  async undoLast(): Promise<ApplyBatch | undefined> {
    const batch = this.history[this.history.length - 1];
    if (!batch) return undefined;
    const edit = new vscode.WorkspaceEdit();
    for (const f of batch.files) {
      const cur = await this.currentText(f.uri);
      if (cur !== undefined && hashText(cur) !== hashText(f.after)) {
        throw new StaleProposalError(`${f.path} was edited after FORGE applied it; undo it manually (Ctrl+Z) to keep your edits.`);
      }
      if (f.before === undefined) edit.deleteFile(f.uri, { ignoreIfNotExists: true });
      else {
        const doc = await vscode.workspace.openTextDocument(f.uri);
        edit.replace(f.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), f.before);
      }
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected the undo edit');
    for (const f of batch.files) {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === f.uri.toString());
      if (doc?.isDirty) await doc.save();
    }
    this.history.pop();
    this.ws.invalidate();
    this.changed.fire();
    return batch;
  }
}
