import { SymbolDef, SymbolIndex } from './search';
import { Workspace, estimateTokens, splitLines } from './workspace';

const STOPWORDS = new Set(
  ('a an and are as at be been but by can could did do does each for from had has have how i if in into is it its ' +
    'just make may more must not now of on one only or other our out over same should so some such than that the their them then there these ' +
    'they this those through to too under up use used using very was we were what when where which while who will with would you your ' +
    'add adds added new also well every any all value values need needs want please ensure appear appears like ' +
    'alongside other others built change changes update updates file files code function functions treated treat ' +
    // intent words: they decide which categories to include, they are not search terms
    'test tests tested testing covered coverage pytest doc docs document documented documentation readme')
    .split(/\s+/),
);

const TEST_WORDS = /\b(test|tests|tested|testing|covered|coverage|pytest)\b/i;
const DOC_WORDS = /\b(doc|docs|document|documented|documentation|readme)\b/i;

export type FileCategory = 'source' | 'test' | 'docs' | 'other';

export interface ContextRange {
  start: number;
  end: number;
  reason: string;
}

export interface SelectedFile {
  path: string;
  category: FileCategory;
  score: number;
  reason: string;
  ranges: ContextRange[];
  tokens: number;
  pinned: boolean;
}

export interface ContextResult {
  task: string;
  terms: string[];
  candidates: number;
  scanned: number;
  budgetTokens: number;
  usedTokens: number;
  selected: SelectedFile[];
  skipped: { path: string; score: number }[];
  rendered: string;
}

export interface RetrieveOptions {
  budgetTokens?: number;
  maxFiles?: number;
  pinnedFiles?: string[];
  pinnedSymbols?: string[];
}

/** Normalise a word the same way for queries and documents: lower case, light plural/past stemming. */
export function stem(w: string): string {
  let t = w.toLowerCase();
  if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 5 && t.endsWith('ed')) t = t.slice(0, -2);
  if (t.length > 6 && t.endsWith('ing')) t = t.slice(0, -3);
  return t;
}

/** Split text into identifier words: snake_case, camelCase and kebab-case are broken into parts. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])/)) if (part.length >= 2) out.push(stem(part));
  }
  return out;
}

export function extractTerms(task: string): string[] {
  const terms = new Set<string>();
  for (const raw of task.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    for (const part of raw.split(/_|(?<=[a-z])(?=[A-Z])/)) {
      const w = part.toLowerCase();
      if (w.length >= 3 && !STOPWORDS.has(w)) terms.add(stem(w));
    }
    if (raw.includes('_') && raw.length >= 4) terms.add(raw.toLowerCase());
  }
  return [...terms];
}

function categorize(rel: string): FileCategory {
  const p = rel.toLowerCase();
  const base = p.split('/').pop() ?? p;
  if (/^(changes|changelog|history|news|authors|contributors)(\.|$)/.test(base)) return 'other';
  if (/(^|\/)(tests?|testing)\//.test(p) || /^test_.*\.py$/.test(base) || /_test\.py$|\.test\.[jt]sx?$|\.spec\.[jt]sx?$/.test(base)) return 'test';
  if (/\.(rst|md|txt|adoc)$/.test(p) || /(^|\/)docs?\//.test(p)) return 'docs';
  if (/\.(py|[cm]?[jt]sx?|go|rs|java|kt|rb|php|cs|cpp|c|h|swift)$/.test(p)) return 'source';
  return 'other';
}

interface Scored {
  path: string;
  category: FileCategory;
  score: number;
  counts: Map<string, number>;
  pathHits: string[];
  symbolHits: string[];
  content: string;
}

function countTerms(content: string, terms: Set<string>, snakeTerms: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tok of tokenize(content)) if (terms.has(tok)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  if (snakeTerms.length) {
    const lower = content.toLowerCase();
    for (const t of snakeTerms) {
      const n = lower.split(t).length - 1;
      if (n) counts.set(t, n);
    }
  }
  return counts;
}

export function retrieveContext(ws: Workspace, index: SymbolIndex, task: string, opts: RetrieveOptions = {}): ContextResult {
  const budget = Math.min(Math.max(opts.budgetTokens ?? 6000, 500), 24000);
  const maxFiles = Math.min(Math.max(opts.maxFiles ?? 6, 1), 15);
  const terms = extractTerms(task);
  const termSet = new Set(terms.filter(t => !t.includes('_')));
  const snakeTerms = terms.filter(t => t.includes('_'));
  const files = ws.listFiles();
  const symbolsByFile = new Map<string, SymbolDef[]>();
  for (const s of index.all()) {
    const arr = symbolsByFile.get(s.path) ?? [];
    arr.push(s);
    symbolsByFile.set(s.path, arr);
  }

  const df = new Map<string, number>();
  const raw: Omit<Scored, 'score'>[] = [];
  for (const f of files) {
    const category = categorize(f.rel);
    if (category === 'other' && !/\.(toml|cfg|ini|ya?ml|json)$/i.test(f.rel)) continue;
    let content: string;
    try {
      content = ws.readText(f.rel);
    } catch {
      continue;
    }
    const counts = countTerms(content, termSet, snakeTerms);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const pathTokens = new Set(tokenize(f.rel.replace(/\.[a-z0-9]+$/i, '')));
    const pathHits = terms.filter(t => pathTokens.has(t));
    const symbolHits = (symbolsByFile.get(f.rel) ?? [])
      .filter(s => {
        const n = s.name.toLowerCase();
        return terms.includes(n) || (termSet.has(stem(n)) && n.length >= 4);
      })
      .map(s => s.name);
    if (counts.size === 0 && pathHits.length === 0) continue;
    raw.push({ path: f.rel, category, counts, pathHits, symbolHits: [...new Set(symbolHits)], content });
  }

  const N = Math.max(files.length, 1);
  const idf = (t: string) => Math.log(1 + N / (1 + (df.get(t) ?? 0)));
  const scored: Scored[] = raw.map(s => {
    let score = 0;
    for (const [t, c] of s.counts) score += idf(t) * Math.log2(1 + c);
    for (const t of s.pathHits) score += 4 * idf(t);
    score += 3 * s.symbolHits.length;
    const coverage = s.counts.size / Math.max(terms.length, 1);
    score *= 0.4 + coverage;
    if (s.category === 'other') score *= 0.3;
    return { ...s, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const pinned = new Set((opts.pinnedFiles ?? []).map(p => p.replace(/\\/g, '/').replace(/^\.\//, '')).filter(p => ws.exists(p)));
  for (const sym of opts.pinnedSymbols ?? []) for (const d of index.find(sym).definitions) pinned.add(d.path);

  const chosen: Scored[] = [];
  const take = (s: Scored | undefined) => {
    if (s && !chosen.includes(s) && chosen.length < maxFiles) chosen.push(s);
  };
  for (const p of pinned) {
    const existing = scored.find(s => s.path === p);
    if (existing) take(existing);
    else {
      try {
        take({ path: p, category: categorize(p), score: 0, counts: new Map(), pathHits: [], symbolHits: [], content: ws.readText(p) });
      } catch {
        /* unreadable pinned file is ignored */
      }
    }
  }
  // Tests and docs that share a module name with the best source file (cli.py -> test_cli.py, cli.rst) are the
  // ones a change to that module must keep in step, so they get a co-location boost.
  const anchor = scored.find(s => s.category === 'source');
  if (anchor) {
    const anchorTokens = new Set(tokenize(baseName(anchor.path)).filter(t => !['init', 'main', 'index', 'util', 'utils', 'helper', 'helpers'].includes(t)));
    for (const s of scored) {
      if (s === anchor || (s.category !== 'test' && s.category !== 'docs')) continue;
      if (tokenize(baseName(s.path)).some(t => anchorTokens.has(t))) {
        s.score *= 1.75;
        s.pathHits.push(`same module as ${anchor.path}`);
      }
    }
    scored.sort((a, b) => b.score - a.score);
  }
  const top = scored[0]?.score ?? 0;
  const bestOf = (cat: FileCategory) => scored.find(s => s.category === cat && s.score >= top * 0.1);
  take(anchor);
  if (TEST_WORDS.test(task)) take(bestOf('test'));
  if (DOC_WORDS.test(task)) take(bestOf('docs'));
  for (const s of scored) {
    if (chosen.length >= maxFiles || s.score < top * 0.35) break;
    take(s);
  }

  const termIdf = new Map(terms.map(t => [t, idf(t)]));
  const totalScore = chosen.reduce((a, s) => a + Math.max(s.score, 1), 0) || 1;
  const selected: SelectedFile[] = [];
  let used = 0;
  const parts: string[] = [];
  for (const s of chosen) {
    const isPinned = pinned.has(s.path);
    const share = Math.max(Math.floor((budget * Math.max(s.score, 1)) / totalScore), Math.min(500, budget));
    const allowance = Math.min(share, budget - used);
    if (allowance < 120) break;
    const { ranges, text, tokens } = pickRanges(s, termIdf, symbolsByFile.get(s.path) ?? [], allowance, isPinned);
    used += tokens;
    const reason = describe(s, isPinned);
    selected.push({ path: s.path, category: s.category, score: Math.round(s.score * 100) / 100, reason, ranges, tokens, pinned: isPinned });
    parts.push(`### ${s.path}  (${s.category}; ${reason})\n${text}`);
  }

  const skipped = scored.filter(s => !chosen.includes(s)).slice(0, 8).map(s => ({ path: s.path, score: Math.round(s.score * 100) / 100 }));
  const header = [
    `CONTEXT RETRIEVAL — ${selected.length} of ${scored.length} candidate files selected (scanned ${files.length}).`,
    `Budget: ~${used} / ${budget} tokens (estimated as characters/4).`,
    `Search terms: ${terms.join(', ') || '(none)'}`,
    '',
    ...selected.map(f => `- ${f.path} — ${f.reason}; lines ${f.ranges.map(r => `${r.start}-${r.end}`).join(', ')}`),
    skipped.length ? `\nNext best (not included): ${skipped.map(s => s.path).join(', ')}` : '',
    '\nThese are excerpts only. Next: read_file the exact ranges you will change (a few calls), then stage your edits with propose_file_change.',
  ].join('\n');

  return { task, terms, candidates: scored.length, scanned: files.length, budgetTokens: budget, usedTokens: used, selected, skipped, rendered: `${header}\n\n${parts.join('\n\n')}` };
}

function baseName(p: string): string {
  return (p.split('/').pop() ?? p).replace(/\.[a-z0-9]+$/i, '');
}

function describe(s: Scored, pinned: boolean): string {
  const bits: string[] = [];
  if (pinned) bits.push('pinned by user (@mention)');
  const plain = s.pathHits.filter(h => !h.startsWith('same module'));
  if (plain.length) bits.push(`path matches "${plain.join('", "')}"`);
  const coloc = s.pathHits.find(h => h.startsWith('same module'));
  if (coloc) bits.push(coloc);
  if (s.symbolHits.length) bits.push(`defines ${s.symbolHits.slice(0, 3).join(', ')}`);
  const top = [...s.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (top.length) bits.push(`mentions ${top.map(([t, c]) => `${t}×${c}`).join(', ')}`);
  if (s.category === 'test') bits.push('existing tests to follow');
  if (s.category === 'docs') bits.push('documentation for this area');
  return bits.join('; ') || 'matched search terms';
}

function pickRanges(s: Scored, termIdf: Map<string, number>, syms: SymbolDef[], allowance: number, pinned: boolean) {
  const lines = splitLines(s.content);
  const lineScores: { i: number; score: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const toks = new Set(tokenize(lines[i]!));
    const lower = lines[i]!.toLowerCase();
    let sc = 0;
    for (const [t, w] of termIdf) if (t.includes('_') ? lower.includes(t) : toks.has(t)) sc += w;
    if (sc > 0) lineScores.push({ i, score: sc });
  }
  lineScores.sort((a, b) => b.score - a.score || a.i - b.i);
  const windows: { start: number; end: number; reason: string }[] = [];
  const addWindow = (start: number, end: number, reason: string) => windows.push({ start: Math.max(0, start), end: Math.min(lines.length - 1, end), reason });
  if (pinned && lines.length <= 120) addWindow(0, lines.length - 1, 'pinned file');
  for (const { i } of lineScores.slice(0, 40)) {
    const sym = syms
      .filter(d => d.line - 1 <= i && d.endLine - 1 >= i && d.endLine - d.line <= 45)
      .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
    if (sym) addWindow(sym.line - 1, sym.endLine - 1, `${sym.kind} ${sym.name}`);
    else addWindow(i - 4, i + 4, 'keyword match');
  }
  if (!windows.length) addWindow(0, Math.min(lines.length - 1, 30), 'file head');

  const accepted: { start: number; end: number; reason: string }[] = [];
  let tokens = 0;
  for (const w of windows) {
    if (accepted.some(a => w.start >= a.start && w.end <= a.end)) continue;
    const cost = estimateTokens(lines.slice(w.start, w.end + 1).join('\n')) + 10;
    if (tokens + cost > allowance) continue;
    tokens += cost;
    accepted.push(w);
  }
  accepted.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number; reason: string }[] = [];
  for (const w of accepted) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end + 2) {
      last.end = Math.max(last.end, w.end);
      if (!last.reason.includes(w.reason)) last.reason += `, ${w.reason}`;
    } else merged.push({ ...w });
  }
  const width = String(lines.length).length;
  const render = () =>
    merged
      .map(w => {
        const body = lines
          .slice(w.start, w.end + 1)
          .map((l, k) => `${String(w.start + k + 1).padStart(width, ' ')}| ${l}`)
          .join('\n');
        return `[lines ${w.start + 1}-${w.end + 1}: ${w.reason}]\n${body}`;
      })
      .join('\n...\n');
  let text = render();
  while (estimateTokens(text) > allowance && merged.length > 1) {
    merged.pop();
    text = render();
  }
  return { ranges: merged.map(w => ({ start: w.start + 1, end: w.end + 1, reason: w.reason })), text, tokens: estimateTokens(text) };
}
