import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

const MAX_OUTPUT = 12_000;

/** Programs the agent may run. Everything is spawned without a shell, inside the workspace root. */
const ALLOWED_PROGRAMS = new Set(['python', 'python3', 'py', 'pytest', 'flask', 'git', 'node', 'npm', 'npx', 'tox', 'ruff', 'mypy']);
const GIT_READONLY = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'grep', 'blame', 'rev-parse']);
const NPM_ALLOWED = new Set(['test', 'run']);
const FORBIDDEN_ARG = /(^|\s)(-m\s+pip|pip\s+install|install|uninstall|--force|rm|rmdir|del)(\s|$)/i;

export class CommandRejected extends Error {}

/** Split a command line into env assignments and argv, honouring simple single/double quotes. */
export function parseCommandLine(line: string): { env: Record<string, string>; argv: string[] } {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) tokens.push(cur);
      cur = '';
      has = false;
    } else {
      if ('|&;<>`'.includes(ch)) throw new CommandRejected(`shell operator "${ch}" is not allowed; run one program per call`);
      cur += ch;
    }
  }
  if (quote) throw new CommandRejected('unterminated quote');
  if (has || cur) tokens.push(cur);
  const env: Record<string, string> = {};
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
    const t = tokens.shift()!;
    const i = t.indexOf('=');
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  if (tokens[0] === 'env') {
    tokens.shift();
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
      const t = tokens.shift()!;
      const i = t.indexOf('=');
      env[t.slice(0, i)] = t.slice(i + 1);
    }
  }
  return { env, argv: tokens };
}

export function validateCommand(argv: string[]): void {
  if (!argv.length) throw new CommandRejected('empty command');
  const prog = path.basename(argv[0]!).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (!ALLOWED_PROGRAMS.has(prog)) {
    throw new CommandRejected(`"${argv[0]}" is not an allowed program. Allowed: ${[...ALLOWED_PROGRAMS].join(', ')}`);
  }
  if (argv[0]!.includes('/') || argv[0]!.includes('\\')) throw new CommandRejected('run programs by name, not by path');
  if (prog === 'git' && !GIT_READONLY.has(argv[1] ?? '')) throw new CommandRejected(`only read-only git subcommands are allowed (${[...GIT_READONLY].join(', ')})`);
  if (prog === 'npm' && !NPM_ALLOWED.has(argv[1] ?? '')) throw new CommandRejected('only "npm test" and "npm run <script>" are allowed');
  if (FORBIDDEN_ARG.test(argv.slice(1).join(' '))) throw new CommandRejected('package installation and file deletion are not allowed');
}

/** Prefer the project's virtualenv so `python`, `pytest` and `flask` resolve to the workspace interpreter. */
export function resolveProgram(root: string, prog: string): { file: string; prefix: string[] } {
  const venvs = ['.venv', 'venv', 'env'];
  const win = process.platform === 'win32';
  const name = prog.toLowerCase();
  for (const v of venvs) {
    const bin = path.join(root, v, win ? 'Scripts' : 'bin');
    if (!fs.existsSync(bin)) continue;
    if (name === 'python' || name === 'python3' || name === 'py') {
      const exe = path.join(bin, win ? 'python.exe' : 'python');
      if (fs.existsSync(exe)) return { file: exe, prefix: [] };
    }
    const exe = path.join(bin, win ? `${name}.exe` : name);
    if (fs.existsSync(exe)) return { file: exe, prefix: [] };
  }
  if (win && (name === 'python' || name === 'python3')) return { file: 'py', prefix: ['-3'] };
  if (win && (name === 'npm' || name === 'npx')) return { file: `${name}.cmd`, prefix: [] };
  return { file: prog, prefix: [] };
}

export class CommandRunner {
  private running = new Set<ChildProcess>();

  constructor(private root: string) {}

  async run(commandLine: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
    const { env, argv } = parseCommandLine(commandLine);
    validateCommand(argv);
    const { file, prefix } = resolveProgram(this.root, argv[0]!);
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120_000, 1000), 600_000);
    const started = Date.now();
    return new Promise<CommandResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let cancelled = false;
      const child = spawn(file, [...prefix, ...argv.slice(1)], {
        cwd: this.root,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1', ...env },
        shell: process.platform === 'win32' && file.endsWith('.cmd'),
        windowsHide: true,
      });
      this.running.add(child);
      const append = (buf: Buffer, which: 'out' | 'err') => {
        const s = buf.toString('utf8');
        if (which === 'out') {
          if (stdout.length < MAX_OUTPUT) stdout += s;
          else truncated = true;
        } else if (stderr.length < MAX_OUTPUT) stderr += s;
        else truncated = true;
      };
      child.stdout?.on('data', b => append(b, 'out'));
      child.stderr?.on('data', b => append(b, 'err'));
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
      const onAbort = () => {
        cancelled = true;
        killTree(child);
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
      child.on('error', err => {
        clearTimeout(timer);
        this.running.delete(child);
        reject(new Error(`failed to start ${argv[0]}: ${err.message}`));
      });
      child.on('close', code => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        this.running.delete(child);
        resolve({
          command: commandLine,
          exitCode: code,
          stdout: clip(stdout),
          stderr: clip(stderr),
          durationMs: Date.now() - started,
          timedOut,
          cancelled,
          truncated,
        });
      });
    });
  }

  killAll(): void {
    for (const c of this.running) killTree(c);
  }
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT / 2)}\n…[output truncated]…\n${s.slice(-MAX_OUTPUT / 2)}` : s;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}
