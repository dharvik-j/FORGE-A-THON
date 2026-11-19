import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSensitivePath } from './workspace';

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

/**
 * Programs the agent may run, inside the workspace root. This is defence in depth: every command also needs the
 * user's approval in the editor (run_command is gated in the agent spec and by a one-shot token in ForgeTools).
 * No general-purpose interpreter entry points: python only with -m <test/lint module>, no node/npx, no -c/-e.
 */
const ALLOWED_PROGRAMS = new Set(['python', 'python3', 'py', 'pytest', 'flask', 'git', 'npm', 'ruff', 'mypy']);
const PYTHON_MODULES = new Set(['pytest', 'unittest', 'flask', 'mypy', 'ruff']);
const GIT_READONLY = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'grep', 'blame', 'rev-parse']);
/** git options that write files or run external programs. */
const GIT_UNSAFE_OPT = /^(--output(=|$)|-O|--open-files-in-pager|--ext-diff$|--textconv$|--exec(=|$)|--upload-pack|--receive-pack|--config-env|-c$)/;
const NPM_ALLOWED = new Set(['test', 'run']);
const FORBIDDEN_ARG = /(^|\s)(-m\s+pip|pip\s+install|install|uninstall|--force|rm|rmdir|del)(\s|$)/i;
/** Environment variables the agent may set on a command. Anything else (NODE_OPTIONS, PYTHONSTARTUP, PATH...) is refused. */
const ALLOWED_ENV = /^(FLASK_[A-Z0-9_]+|PYTEST_ADDOPTS|CI|NO_COLOR|PYTHONHASHSEED|PYTHONWARNINGS|TZ)$/;
/** A Flask app import string without call arguments: Flask evaluates literal arguments in "module:factory(args)". */
const SAFE_FLASK_APP = /^[A-Za-z0-9_.\/\\-]+(:[A-Za-z_][A-Za-z0-9_]*(\(\))?)?$/;
/** When cmd.exe has to be used (npm.cmd on Windows), every argument must be plain: no metacharacters or spaces. */
const PLAIN_SHELL_ARG = /^[A-Za-z0-9._:@\/\\+-]+$/;

export class CommandRejected extends Error {}

/** True if an argument names a secrets file, including git revision syntax (HEAD:.env) and --opt=path forms. */
function refersToSensitiveFile(arg: string): boolean {
  const candidates = [arg, arg.replace(/^[^=]*=/, ''), arg.replace(/^[^:]*:/, '')];
  // Only path-like tokens: a bare word such as `-k secrets` is a test filter, not a file.
  return candidates.some(c => c && /[./\\]|^id_/.test(c) && isSensitivePath(c.replace(/^\.[\\/]/, '')));
}

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

export function validateCommand(argv: string[], env: Record<string, string> = {}): void {
  if (!argv.length) throw new CommandRejected('empty command');
  const prog = path.basename(argv[0]!).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (!ALLOWED_PROGRAMS.has(prog)) {
    throw new CommandRejected(`"${argv[0]}" is not an allowed program. Allowed: ${[...ALLOWED_PROGRAMS].join(', ')}`);
  }
  if (argv[0]!.includes('/') || argv[0]!.includes('\\')) throw new CommandRejected('run programs by name, not by path');
  const args = argv.slice(1);
  for (const [k, v] of Object.entries(env)) {
    if (!ALLOWED_ENV.test(k)) throw new CommandRejected(`setting ${k} is not allowed; allowed variables: FLASK_*, PYTEST_ADDOPTS, CI, NO_COLOR, PYTHONHASHSEED, PYTHONWARNINGS, TZ`);
    if (k === 'FLASK_APP' && !SAFE_FLASK_APP.test(v)) throw new CommandRejected('FLASK_APP must be a plain "module" or "module:app" / "module:create_app()" (no arguments)');
    if (refersToSensitiveFile(v)) throw new CommandRejected(`refusing to pass a likely secrets file (${k})`);
  }
  for (const a of args) if (refersToSensitiveFile(a)) throw new CommandRejected(`refusing to access a likely secrets file: ${a}`);
  if (FORBIDDEN_ARG.test(args.join(' '))) throw new CommandRejected('package installation and file deletion are not allowed');

  let flaskArgs: string[] | undefined;
  if (prog === 'python' || prog === 'python3' || prog === 'py') {
    let i = 0;
    if (prog === 'py' && /^-[23](\.\d+)?$/.test(args[0] ?? '')) i++;
    const rest = args.slice(i);
    const isVersion = rest.length === 1 && (rest[0] === '-V' || rest[0] === '--version');
    if (!isVersion && !(rest[0] === '-m' && PYTHON_MODULES.has(rest[1] ?? ''))) {
      throw new CommandRejected(`python may only run "-m <module>" for: ${[...PYTHON_MODULES].join(', ')} (no -c, scripts or other modules)`);
    }
    if (rest[1] === 'flask') flaskArgs = rest.slice(2);
  }
  if (prog === 'flask') flaskArgs = args;
  if (flaskArgs) {
    for (let i = 0; i < flaskArgs.length; i++) {
      const a = flaskArgs[i]!;
      const app = a === '--app' || a === '-A' ? flaskArgs[i + 1] : a.startsWith('--app=') ? a.slice(6) : undefined;
      if (app !== undefined && !SAFE_FLASK_APP.test(app)) throw new CommandRejected('--app must be a plain "module" or "module:app" / "module:create_app()" (no arguments)');
    }
  }
  if (prog === 'git') {
    if (!GIT_READONLY.has(args[0] ?? '')) throw new CommandRejected(`only read-only git subcommands are allowed (${[...GIT_READONLY].join(', ')})`);
    const bad = args.find(a => GIT_UNSAFE_OPT.test(a));
    if (bad) throw new CommandRejected(`git option ${bad} is not allowed (it writes files or runs other programs)`);
  }
  if (prog === 'npm' && !NPM_ALLOWED.has(args[0] ?? '')) throw new CommandRejected('only "npm test" and "npm run <script>" are allowed');
  if (prog === 'ruff' && args.some(a => a === 'format' || a === '--fix' || a.startsWith('--fix=') || a === '--unsafe-fixes')) {
    throw new CommandRejected('ruff may only check; it must not rewrite files (changes go through propose_file_change)');
  }
}

/** Arguments for a program that must go through cmd.exe (Windows .cmd shims). cmd.exe re-parses the line, so only plain tokens pass. */
export function validateShellArgs(args: string[]): void {
  const bad = args.find(a => !PLAIN_SHELL_ARG.test(a));
  if (bad !== undefined) throw new CommandRejected(`argument ${JSON.stringify(bad)} contains characters cmd.exe would interpret; use plain script names and options only`);
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
  if (win && name === 'npm') return { file: 'npm.cmd', prefix: [] };
  return { file: prog, prefix: [] };
}

export class CommandRunner {
  private running = new Set<ChildProcess>();

  constructor(private root: string) {}

  async run(commandLine: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
    const { env, argv } = parseCommandLine(commandLine);
    validateCommand(argv, env);
    const { file, prefix } = resolveProgram(this.root, argv[0]!);
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    if (useShell) validateShellArgs([...prefix, ...argv.slice(1)]);
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
        shell: useShell,
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
