import { Workspace, escapeRe, globToRegExp, splitLines } from './workspace';

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  pathGlob?: string;
  maxResults?: number;
}

export function searchWorkspace(ws: Workspace, query: string, opts: SearchOptions = {}): { matches: SearchMatch[]; filesMatched: number; truncated: boolean } {
  if (!query) throw new Error('query is required');
  const flags = opts.caseSensitive ? '' : 'i';
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? query : escapeRe(query), flags);
  } catch (e) {
    throw new Error(`invalid regular expression: ${(e as Error).message}`);
  }
  const glob = opts.pathGlob ? globToRegExp(opts.pathGlob) : undefined;
  const max = Math.min(Math.max(opts.maxResults ?? 60, 1), 300);
  const matches: SearchMatch[] = [];
  const files = new Set<string>();
  let truncated = false;
  for (const f of ws.listFiles()) {
    if (glob && !glob.test(f.rel)) continue;
    let content: string;
    try {
      content = ws.readText(f.rel);
    } catch {
      continue;
    }
    const lines = splitLines(content);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        files.add(f.rel);
        if (matches.length >= max) {
          truncated = true;
          continue;
        }
        matches.push({ path: f.rel, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
      }
    }
  }
  return { matches, filesMatched: files.size, truncated };
}

export interface SymbolDef {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable';
  path: string;
  line: number;
  endLine: number;
  container?: string;
  signature: string;
}

const PY_DEF = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;
const JS_DEF = /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class|interface|type|const|let)\s+([A-Za-z_$][\w$]*)/;

/** Lightweight indentation-aware symbol extraction for Python, with a regex fallback for JS/TS. */
export function extractSymbols(rel: string, content: string): SymbolDef[] {
  const lines = splitLines(content);
  const out: SymbolDef[] = [];
  const isPy = rel.endsWith('.py');
  const isJs = /\.(m?[jt]sx?)$/.test(rel);
  if (!isPy && !isJs) return out;
  const stack: { indent: number; name: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = (isPy ? PY_DEF : JS_DEF).exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const container = stack.length ? stack[stack.length - 1]!.name : undefined;
    const kw = m[2]!;
    const kind: SymbolDef['kind'] = kw === 'class' || kw === 'interface' ? 'class' : kw === 'const' || kw === 'let' || kw === 'type' ? 'variable' : container ? 'method' : 'function';
    const endLine = isPy ? pythonBlockEnd(lines, i, indent) : i + 1;
    out.push({ name: m[3]!, kind, path: rel, line: i + 1, endLine, container, signature: line.trim().slice(0, 160) });
    if (kw === 'class' || kw === 'def') stack.push({ indent, name: m[3]! });
  }
  return out;
}

function pythonBlockEnd(lines: string[], start: number, indent: number): number {
  let last = start;
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.trim() === '') continue;
    const ind = l.length - l.trimStart().length;
    if (ind <= indent && !/^[)\]}]/.test(l.trimStart())) break;
    last = j;
  }
  return last + 1;
}

export class SymbolIndex {
  private cache = new Map<string, { size: number; symbols: SymbolDef[] }>();
  constructor(private ws: Workspace) {}

  all(): SymbolDef[] {
    const out: SymbolDef[] = [];
    for (const f of this.ws.listFiles()) {
      const cached = this.cache.get(f.rel);
      if (cached && cached.size === f.size) {
        out.push(...cached.symbols);
        continue;
      }
      let content: string;
      try {
        content = this.ws.readText(f.rel);
      } catch {
        continue;
      }
      const symbols = extractSymbols(f.rel, content);
      this.cache.set(f.rel, { size: f.size, symbols });
      out.push(...symbols);
    }
    return out;
  }

  find(name: string): { definitions: SymbolDef[]; references: SearchMatch[] } {
    const bare = name.includes('.') ? name.split('.').pop()! : name;
    const container = name.includes('.') ? name.split('.').slice(-2, -1)[0] : undefined;
    const definitions = this.all().filter(s => s.name === bare && (!container || s.container === container));
    const refs = searchWorkspace(this.ws, `\\b${escapeRe(bare)}\\b`, { regex: true, caseSensitive: true, maxResults: 40 }).matches;
    const defKeys = new Set(definitions.map(d => `${d.path}:${d.line}`));
    return { definitions, references: refs.filter(r => !defKeys.has(`${r.path}:${r.line}`)) };
  }
}
