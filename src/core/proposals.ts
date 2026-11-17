import { createHash, randomUUID } from 'node:crypto';
import { applyPatch, structuredPatch, createTwoFilesPatch } from 'diff';
import { Workspace, WorkspaceError, isSensitivePath } from './workspace';

export interface Edit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface Hunk {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface Proposal {
  id: string;
  path: string;
  isNew: boolean;
  original: string;
  baseHash: string;
  proposed: string;
  summary: string;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  createdAt: number;
}

/** Content hash used for stale checks. Line endings are normalised so CRLF/LF-only differences are not "edits". */
export function hashText(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Detect the dominant line ending so edits made with \n do not flip a CRLF file. */
function eol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export function applyEdits(original: string, edits: Edit[]): string {
  const nl = eol(original);
  let text = original.replace(/\r\n/g, '\n');
  edits.forEach((e, i) => {
    const oldS = (e.old_string ?? '').replace(/\r\n/g, '\n');
    const newS = (e.new_string ?? '').replace(/\r\n/g, '\n');
    if (oldS === '') throw new WorkspaceError(`edit ${i + 1}: old_string must not be empty (use "content" to write a whole file)`);
    if (oldS === newS) throw new WorkspaceError(`edit ${i + 1}: old_string and new_string are identical`);
    const count = text.split(oldS).length - 1;
    if (count === 0) throw new WorkspaceError(`edit ${i + 1}: old_string was not found in the file. Re-read the file and copy the exact text, including indentation.`);
    if (count > 1 && !e.replace_all) throw new WorkspaceError(`edit ${i + 1}: old_string occurs ${count} times; add surrounding lines to make it unique or set replace_all`);
    text = e.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
  });
  return nl === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

export function computeHunks(oldText: string, newText: string, path: string): { hunks: Hunk[]; additions: number; deletions: number } {
  const patch = structuredPatch(path, path, normalize(oldText), normalize(newText), '', '', { context: 3 });
  let additions = 0;
  let deletions = 0;
  const hunks = patch.hunks.map((h, index) => {
    for (const l of h.lines) {
      if (l.startsWith('+')) additions++;
      else if (l.startsWith('-')) deletions++;
    }
    return { index, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines };
  });
  return { hunks, additions, deletions };
}

function normalize(t: string): string {
  return t.replace(/\r\n/g, '\n');
}

/**
 * Rebuild a file from its original text, applying only the accepted hunks.
 * Hunks from one structuredPatch never overlap, so rejected hunks simply keep the original lines.
 */
export function applySelectedHunks(original: string, hunks: Hunk[], accepted: Set<number>): string {
  const nl = eol(original);
  const chosen = hunks.filter(h => accepted.has(h.index));
  if (chosen.length === 0) return original;
  const result = applyPatch(normalize(original), { oldFileName: 'a', newFileName: 'b', oldHeader: '', newHeader: '', hunks: chosen.map(h => ({ ...h, lines: [...h.lines] })) });
  if (result === false) throw new WorkspaceError('could not apply the selected hunks cleanly');
  return nl === '\r\n' ? result.replace(/\n/g, '\r\n') : result;
}

/** Non-blank lines a hunk removes without re-adding them anywhere in the change (i.e. real deletions, not moves/edits in place). */
export function removedLines(p: { hunks: Hunk[] }, hunkIndex?: number): string[] {
  const added = new Set(p.hunks.flatMap(h => h.lines.filter(l => l.startsWith('+')).map(l => l.slice(1).trim())));
  const out: string[] = [];
  for (const h of p.hunks) {
    if (hunkIndex !== undefined && h.index !== hunkIndex) continue;
    for (const l of h.lines) {
      if (!l.startsWith('-')) continue;
      const t = l.slice(1).trim();
      if (t && !added.has(t) && !added.has(t.replace(/,$/, ''))) out.push(t);
    }
  }
  return out;
}

export function unifiedDiff(p: Proposal): string {
  return createTwoFilesPatch(p.isNew ? '/dev/null' : `a/${p.path}`, `b/${p.path}`, normalize(p.original), normalize(p.proposed), '', '', { context: 3 });
}

export type ProposalListener = (event: 'changed' | 'cleared') => void;

/**
 * Proposed edits are staged here in memory; nothing in this store ever writes to disk.
 * Multiple proposals for the same file are folded into one pending change for that file.
 */
export class ProposalStore {
  private byPath = new Map<string, Proposal>();
  private listeners = new Set<ProposalListener>();

  constructor(private ws: Workspace) {}

  onChange(l: ProposalListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: 'changed' | 'cleared') {
    for (const l of this.listeners) l(e);
  }

  list(): Proposal[] {
    return [...this.byPath.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Proposal | undefined {
    return this.list().find(p => p.id === id);
  }

  propose(rel: string, args: { edits?: Edit[]; content?: string; summary?: string }): Proposal {
    const path = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    if (isSensitivePath(path)) throw new WorkspaceError(`refusing to modify a likely secrets file: ${path}`);
    this.ws.resolve(path);
    const existing = this.byPath.get(path);
    const onDisk = this.ws.exists(path);
    const original = existing ? existing.original : onDisk ? this.ws.readText(path) : '';
    const current = existing ? existing.proposed : original;
    let proposed: string;
    if (typeof args.content === 'string' && (!args.edits || args.edits.length === 0)) {
      if (onDisk || existing) {
        throw new WorkspaceError(`${path} already exists: modify it with "edits" (exact old_string/new_string pairs), not "content". "content" is only for creating new files.`);
      }
      proposed = args.content;
      if (original && eol(original) === '\r\n') proposed = normalize(proposed).replace(/\n/g, '\r\n');
    } else if (args.edits && args.edits.length) {
      if (!onDisk && !existing) throw new WorkspaceError(`file does not exist: ${path}. To create it, pass "content" instead of "edits".`);
      proposed = applyEdits(current, args.edits);
    } else {
      throw new WorkspaceError('provide either "edits" (to modify an existing file) or "content" (to create or replace a file)');
    }
    const { hunks, additions, deletions } = computeHunks(original, proposed, path);
    if (hunks.length === 0) {
      this.byPath.delete(path);
      this.emit('changed');
      throw new WorkspaceError('the proposed change is identical to the current file; nothing staged');
    }
    const proposal: Proposal = {
      id: existing?.id ?? `chg_${randomUUID().slice(0, 8)}`,
      path,
      isNew: !onDisk,
      original,
      baseHash: hashText(original),
      proposed,
      summary: [existing?.summary, args.summary].filter(Boolean).join(' / ') || 'change',
      hunks,
      additions,
      deletions,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.byPath.set(path, proposal);
    this.emit('changed');
    return proposal;
  }

  discard(path: string): boolean {
    const ok = this.byPath.delete(path);
    if (ok) this.emit('changed');
    return ok;
  }

  clear(): void {
    if (this.byPath.size === 0) return;
    this.byPath.clear();
    this.emit('cleared');
  }
}
