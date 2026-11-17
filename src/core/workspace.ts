import * as fs from 'node:fs';
import * as path from 'node:path';

export const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'env', '.env', 'dist', 'build', 'out',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox',
  '.idea', '.vscode-test', 'coverage', 'htmlcov', '.cache', '.eggs', 'site-packages',
]);

const SENSITIVE_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/i,
];

const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|bmp|pdf|zip|gz|tgz|bz2|xz|7z|whl|egg|so|dll|dylib|exe|bin|pyc|pyo|class|jar|woff2?|ttf|eot|mp[34]|mov|sqlite|db)$/i;

export const MAX_READ_BYTES = 256 * 1024;
export const MAX_READ_LINES = 250;

export class WorkspaceError extends Error {}

export interface FileEntry {
  rel: string;
  size: number;
}

export function isSensitivePath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  return SENSITIVE_PATTERNS.some(re => re.test(p));
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export class Workspace {
  readonly root: string;
  private realRoot: string;
  private fileCache: { at: number; files: FileEntry[] } | undefined;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.realRoot = fs.realpathSync.native(this.root);
  }

  /** Resolve a workspace-relative path, refusing anything that escapes the root (including via symlinks). */
  resolve(rel: string, opts: { mustExist?: boolean } = {}): string {
    if (typeof rel !== 'string' || rel.trim() === '') throw new WorkspaceError('path is required');
    if (rel.includes('\0')) throw new WorkspaceError('invalid path');
    const cleaned = toPosix(rel.trim()).replace(/^\.\/+/, '');
    if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
      throw new WorkspaceError(`absolute paths are not allowed: ${rel}`);
    }
    const abs = path.resolve(this.root, cleaned);
    if (!isInside(this.root, abs)) throw new WorkspaceError(`path escapes the workspace: ${rel}`);
    const parts = path.relative(this.root, abs).split(path.sep);
    if (parts.some(p => p === '.git')) throw new WorkspaceError(`access to .git is not allowed: ${rel}`);
    if (fs.existsSync(abs)) {
      const real = fs.realpathSync.native(abs);
      if (!isInside(this.realRoot, real)) throw new WorkspaceError(`path resolves outside the workspace: ${rel}`);
    } else if (opts.mustExist) {
      throw new WorkspaceError(`file not found: ${rel}`);
    } else {
      const parent = nearestExistingParent(abs);
      const realParent = fs.realpathSync.native(parent);
      if (!isInside(this.realRoot, realParent)) throw new WorkspaceError(`path resolves outside the workspace: ${rel}`);
    }
    return abs;
  }

  relative(abs: string): string {
    return toPosix(path.relative(this.root, abs));
  }

  invalidate(): void {
    this.fileCache = undefined;
  }

  /** All indexable text files, excluding vendored/generated folders, binaries and secrets. Cached briefly. */
  listFiles(): FileEntry[] {
    if (this.fileCache && Date.now() - this.fileCache.at < 5000) return this.fileCache.files;
    const out: FileEntry[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (EXCLUDED_DIRS.has(e.name) || e.name.endsWith('.egg-info')) continue;
          walk(abs);
        } else if (e.isFile()) {
          const rel = this.relative(abs);
          if (BINARY_EXT.test(e.name) || isSensitivePath(rel)) continue;
          let size = 0;
          try {
            size = fs.statSync(abs).size;
          } catch {
            continue;
          }
          if (size > MAX_READ_BYTES) continue;
          out.push({ rel, size });
        }
      }
    };
    walk(this.root);
    out.sort((a, b) => a.rel.localeCompare(b.rel));
    this.fileCache = { at: Date.now(), files: out };
    return out;
  }

  readText(rel: string): string {
    if (isSensitivePath(rel)) throw new WorkspaceError(`refusing to read a likely secrets file: ${rel}`);
    const abs = this.resolve(rel, { mustExist: true });
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new WorkspaceError(`not a file: ${rel}`);
    if (st.size > MAX_READ_BYTES) throw new WorkspaceError(`file too large (${st.size} bytes): ${rel}`);
    return fs.readFileSync(abs, 'utf8');
  }

  exists(rel: string): boolean {
    try {
      return fs.existsSync(this.resolve(rel));
    } catch {
      return false;
    }
  }

  /** Read a file with 1-based line numbers. Large files are windowed to MAX_READ_LINES. */
  readLines(rel: string, start?: number, end?: number): LineWindow {
    return formatLines(this.readText(rel), start, end);
  }
}

export interface LineWindow {
  text: string;
  start: number;
  end: number;
  total: number;
  truncated: boolean;
}

/** 1-based, line-numbered window of a text, capped at MAX_READ_LINES. An end before start reads forward. */
export function formatLines(content: string, start?: number, end?: number): LineWindow {
  const lines = splitLines(content);
  const total = lines.length;
  let s = Math.max(1, Math.floor(start ?? 1));
  if (s > total) s = Math.max(1, total);
  let e = Math.min(total, Math.floor(end ?? total));
  if (e < s) e = Math.min(total, s + 99);
  let truncated = false;
  if (e - s + 1 > MAX_READ_LINES) {
    e = s + MAX_READ_LINES - 1;
    truncated = true;
  }
  const width = String(e).length;
  const text = lines
    .slice(s - 1, e)
    .map((l, i) => `${String(s + i).padStart(width, ' ')}| ${l}`)
    .join('\n');
  return { text, start: s, end: e, total, truncated };
}

export function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function nearestExistingParent(p: string): string {
  let cur = path.dirname(p);
  while (!fs.existsSync(cur)) {
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = toPosix(glob.trim());
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const close = g.indexOf('}', i);
      if (close > i) {
        re += '(' + g.slice(i + 1, close).split(',').map(escapeRe).join('|') + ')';
        i = close;
      } else re += '\\{';
    } else re += escapeRe(c);
  }
  return new RegExp(g.includes('/') ? `^${re}$` : `(^|/)${re}$`, 'i');
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
