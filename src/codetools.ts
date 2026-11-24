// Coding tools for a chat whose folder is on the person's coding list (Settings, Permissions): git_read reads a
// repository with a fixed set of verbs, and run_command runs one of a few NAMED commands (test, build, lint,
// typecheck from the project's package.json, plus lines the person wrote). There is no free shell here: nothing a
// model writes becomes a command line. All in code, tested in test/codetools.test.ts with a made-up runner:
// - git: status, diff, log, show, branch (list), ls-files, blame only; each option is on a short list, so -c,
//   --output, --exec, --ext-diff and the like cannot pass; no path leaves the folder; .env, key files and TOMLIN's own
//   data are never read; what comes back is withheld when it looks like a key or a password.
// - run: without a shell, in the folder, with a time limit that ends the whole process tree, output capped, one at a
//   time, with an environment that holds no key, token or password and that cannot sign in to push.
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { ToolDef } from './webtools.ts';
import type { CardExtra, Tier } from './permits.ts';
import { deniedWords } from './permits.ts';
import { looksSecret } from './rules.ts';
import { run as runProgram, testEnv } from './checks.ts';

export const CODE_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'git_read',
      description: 'Read the git repository of the folder you work in. verb is one of: status, diff, log, show, branch, ls-files, blame. args are that verb\'s options and paths, for example verb "log", args ["--oneline", "-n", "10"], or verb "diff", args ["--stat"]. Reading only: nothing is committed, pushed or changed.',
      parameters: { type: 'object', properties: { verb: { type: 'string', enum: ['status', 'diff', 'log', 'show', 'branch', 'ls-files', 'blame'] }, args: { type: 'array', items: { type: 'string' } } }, required: ['verb'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run one of the folder\'s named commands and get its output: test, build, lint or typecheck (when the project has them), or a name the person added. Only the name is given; you cannot write a command line. The person is asked first.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'The command\'s name, for example test.' } }, required: ['name'] },
    },
  },
];

export const isCodeTool = (name: string) => name === 'git_read' || name === 'run_command';
export const CODE_LINE = 'You can read this folder\'s git repository with git_read (status, diff, log, show, branch, ls-files, blame). You cannot commit, push or change anything with git. Say only what a call showed you.';
export const RUN_LINE = 'run_command runs one of the folder\'s named commands (test, build, lint, typecheck) when the person allows it. Never install anything.';

export function codeCallWords(name: string, args: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(args) as Record<string, unknown>;
  } catch {
    // the words below do without it
  }
  if (name === 'git_read') return `Reading git ${typeof a.verb === 'string' ? a.verb.slice(0, 20) : ''}…`.replace(' …', '…');
  return `Running ${typeof a.name === 'string' ? a.name.slice(0, 40) : 'a command'}…`;
}

// ---- The folder list ----

const real = (p: string): string | null => {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    return null;
  }
};
const within = (inner: string, outer: string) => {
  const rel = relative(outer, inner);
  return rel === '' || (!!rel && !rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith(sep + sep));
};

/**
 * Whether the chat's folder is one the coding tools may work in: it, by its real path (a link out of a listed folder
 * does not count), is a listed folder or inside one, and is not TOMLIN's own data.
 */
export function codingFolder(root: string, folders: string[], dataDir?: string): boolean {
  const at = real(root);
  if (!at) return false;
  const data = dataDir ? real(dataDir) : null;
  // The workspace sits inside the data folder by default; only the data folder's own files are off limits.
  if (data && (at.toLowerCase() === data.toLowerCase() || within(data, at))) return false;
  return folders.some(f => {
    const listed = real(f);
    return !!listed && dirname(listed) !== listed && within(at.toLowerCase(), listed.toLowerCase());
  });
}

// ---- git_read ----

export const GIT_VERBS = ['status', 'diff', 'log', 'show', 'branch', 'ls-files', 'blame'] as const;
export type GitVerb = (typeof GIT_VERBS)[number];

/** Options that only shape what is shown. Anything else that starts with a dash is refused. */
const PLAIN = new Set(['--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--oneline', '--cached', '--staged', '--short', '--branch', '-s', '-sb', '--all', '--graph', '--decorate', '--no-decorate', '-p', '--patch', '--no-patch', '--follow', '--no-color', '--merges', '--no-merges', '--first-parent', '--reverse', '--summary', '--porcelain', '--others', '--modified', '--deleted', '--stage', '--exclude-standard', '--show-current', '-a', '-r', '-v', '-vv', '-w', '--ignore-all-space', '--word-diff', '--date=short', '--date=iso', '--date=relative', '--abbrev-commit', '--']);
const VALUED = /^(?:-n\d{1,4}|-\d{1,4}|--max-count=\d{1,4}|--skip=\d{1,5}|-U\d{1,3}|--unified=\d{1,3}|-L\d{1,6},\+?\d{1,6}|--since=[\w .:,-]{1,40}|--until=[\w .:,-]{1,40}|--after=[\w .:,-]{1,40}|--before=[\w .:,-]{1,40}|--author=[\w .@<>-]{1,60}|--grep=[\w .,:#-]{1,80}|--format=(?:oneline|short|medium|full|fuller)|--pretty=(?:oneline|short|medium|full|fuller)|--diff-filter=[ACDMRTUXB]{1,9}|--abbrev=\d{1,2})$/;

/** Files whose text is never read by a tool, whatever asks: keys, passwords and TOMLIN's own data. */
export function secretPath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const name = parts.at(-1) ?? '';
  if (/^\.env(\..*)?$/.test(name) || /\.(pem|key|pfx|p12|kdbx|jks|keystore)$/.test(name) || /^id_[a-z0-9_]+(\.pub)?$/.test(name) || /^(credentials|secrets?)(\.[a-z]+)?$/.test(name) || name === '.npmrc' || name === '.netrc' || name === '.git-credentials') return true;
  return parts.includes('.ssh') || parts.includes('.gnupg') || parts[0] === 'data';
}

/** The whole git command for a verb and the model's arguments, or why not. Fixed words go first; nothing of the model's is an option git would act on. */
export function gitArgs(verb: unknown, raw: unknown): { argv: string[] } | { error: string } {
  if (!(GIT_VERBS as readonly unknown[]).includes(verb)) return { error: `git_read reads only: ${GIT_VERBS.join(', ')}. Nothing that writes (commit, push, tag, reset, checkout, clean, remote, config) can be run.` };
  const v = verb as GitVerb;
  const args = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string') || args.length > 16) return { error: 'args must be a short list of words.' };
  const out: string[] = [];
  let paths = false;
  for (let i = 0; i < args.length; i++) {
    const a = (args[i] as string).trim();
    if (!a || a.length > 200 || /[\0\r\n"'`$;&|<>]/.test(a)) return { error: `"${a.slice(0, 40)}" cannot be used here.` };
    if (a.startsWith('-') && !paths) {
      // "-n 10" and "-L 5,9" as two words.
      if ((a === '-n' || a === '-L' || a === '-U') && typeof args[i + 1] === 'string' && VALUED.test(`${a}${(args[i + 1] as string).trim()}`)) {
        out.push(`${a}${(args[++i] as string).trim()}`);
        continue;
      }
      if (!PLAIN.has(a) && !VALUED.test(a)) return { error: `The option "${a.slice(0, 40)}" is not one git_read takes. It takes options that shape what is shown (--stat, --oneline, -n 10, --name-only, --since=...), never -c, --output, --exec or the like.` };
      if (a === '--') paths = true;
      out.push(a);
      continue;
    }
    // A revision or a path: inside the folder, never a key file. "HEAD:path" and "a..b" are both looked at as paths too.
    if (a.startsWith('-') || /^[a-zA-Z]:[\\/]/.test(a) || a.startsWith('/') || a.startsWith('\\') || /(^|[\\/:])\.\.([\\/]|$)/.test(a) || a.startsWith('~')) return { error: `"${a.slice(0, 60)}" is outside the folder you work in.` };
    for (const piece of a.split(/:|\.\.\.?/)) if (piece && secretPath(piece)) return { error: `"${piece.slice(0, 60)}" is a key, password or data file: it is never read.` };
    out.push(a);
  }
  if (v === 'branch') {
    if (out.some(a => !a.startsWith('-'))) return { error: 'git_read lists branches only; it does not make, rename or delete one.' };
    return { argv: ['--no-pager', '--no-optional-locks', 'branch', '--list', ...out.filter(a => a !== '--')] };
  }
  const safe = v === 'diff' || v === 'show' || v === 'log' ? ['--no-ext-diff', '--no-textconv'] : [];
  return { argv: ['--no-pager', '--no-optional-locks', v, ...safe, ...out] };
}

/** The environment git and a named command get: no key, token or password, and no way to sign in (a push cannot authenticate). */
export function codeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = testEnv(env);
  for (const k of Object.keys(out)) if (/^(GIT_|SSH_|GH_|GITHUB_|NPM_CONFIG_.*(TOKEN|AUTH|PASSWORD))/i.test(k)) delete out[k];
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat' };
}

// ---- run_command ----

export interface Named { name: string; exe: string; args: string[]; shown: string }

const BUILT_IN = ['test', 'build', 'lint', 'typecheck'];
/** The first word a line the person wrote may start with. */
const FIRST_WORDS = new Set(['node', 'npm', 'npx', 'python', 'php']);
const BANNED = /(^|[\s"'=:/\\])(push|remote|tag|commit|reset|clean|checkout|rebase|merge|rm|del|rmdir|rd|curl|wget|powershell|pwsh|cmd|bash|sh|format|install|i|add|publish|login|adduser|token)(\.exe|\.cmd)?($|[\s"'])/i;

/** A line the person wrote, "name=node tools/x.js --flag": a known first word, no shell signs, none of the banned words. */
export function parseExtra(line: string): Named | { error: string } {
  const m = /^([\w-]{1,30})\s*=\s*(.+)$/.exec(String(line ?? '').trim());
  if (!m) return { error: 'Write it as name=command, for example docs=npm run docs.' };
  const words = m[2].trim().split(/\s+/);
  if (/[|&;<>`$%^()\r\n"']/.test(m[2])) return { error: 'A named command cannot hold pipes, &&, redirects, quotes or variables.' };
  if (!FIRST_WORDS.has(words[0].toLowerCase())) return { error: `A named command starts with one of: ${[...FIRST_WORDS].join(', ')}.` };
  if (BANNED.test(` ${m[2]} `) && !/^npm run [\w:-]+$/.test(m[2].trim()) && !/^npm test$/.test(m[2].trim())) return { error: 'A named command cannot push, tag, commit, reset, clean, delete, install, download or start another shell.' };
  if (words.length > 12 || m[2].length > 200) return { error: 'That command is too long.' };
  return { name: m[1].toLowerCase(), exe: words[0].toLowerCase(), args: words.slice(1), shown: m[2].trim() };
}

/** npm's own program, run by Node, so `npm run` needs no shell. Null when this Node came without npm. */
export function npmCli(): string | null {
  const at = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(at) ? at : null;
}

/** The named commands of a folder: the four built-in names its package.json has, and the person's lines. `shown` is the real text, for the card. */
export async function namedCommands(root: string, extra: string[] = []): Promise<Named[]> {
  const out: Named[] = [];
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    for (const name of BUILT_IN) {
      const script = pkg.scripts?.[name];
      if (typeof script === 'string' && script.trim()) out.push({ name, exe: 'npm', args: ['run', name], shown: `npm run ${name}  (${script.trim().slice(0, 300)})` });
    }
  } catch {
    // no package.json, or not JSON: only the person's lines
  }
  for (const line of extra) {
    const n = parseExtra(line);
    if (!('error' in n) && !out.some(o => o.name === n.name)) out.push(n);
  }
  return out;
}

export interface Ran { code: number | null; out: string; timedOut: boolean }
export type Exec = (exe: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxChars: number }) => Promise<Ran>;

/**
 * npm's arguments as run: --ignore-scripts first, so `npm run test` runs the test script the card shows and not the
 * pretest and posttest scripts beside it, which the card does not show (a saved package.json could hide anything there).
 */
export const npmArgs = (args: string[]): string[] => ['--ignore-scripts', ...args];

/** The scripts of a folder's package.json as text ('' when there is none), to tell whether they changed during an answer. */
export async function scriptsOf(root: string): Promise<string> {
  try {
    return JSON.stringify((JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: unknown }).scripts ?? null);
  } catch {
    return '';
  }
}

/** Runs a program without a shell (src/checks.ts run: the time limit ends the whole tree with taskkill /T). npm goes through Node. */
export const realExec: Exec = (exe, args, o) => {
  if (exe === 'npm' || exe === 'npx') {
    const cli = npmCli();
    if (!cli) return Promise.resolve({ code: -1, out: 'npm was not found beside Node on this PC.', timedOut: false });
    return runProgram(process.execPath, [exe === 'npx' ? cli.replace(/npm-cli\.js$/, 'npx-cli.js') : cli, ...(exe === 'npm' ? npmArgs(args) : args)], { ...o, shell: false });
  }
  return runProgram(exe === 'node' ? process.execPath : exe, args, { ...o, shell: false });
};

export interface CodeUse { name: 'git_read' | 'run_command'; input: string; ok: boolean; said: string; ms: number }
export interface CodeLog { kind: 'git' | 'run'; window: string; action: string; outcome: string }

export interface CodeTurnOpts {
  /** The chat's folder; it has passed codingFolder. */
  root: string;
  perCall: number;
  run: Tier;
  /** The person's own named commands (Settings). */
  extra?: string[];
  /** Puts the Ask each time card for a run: true only for Once. */
  confirm?: (what: string, extra?: CardExtra) => Promise<boolean>;
  /**
   * Why a run must be asked on a card even at Allowed ('' when it need not): this answer read text that looked like
   * orders, or saved files in the folder that the command may run.
   */
  mustAsk?: () => string;
  exec?: Exec;
  log?: (e: CodeLog) => void;
  timeoutMs?: number;
  now?: () => number;
}

export const RUN_TIMEOUT_MS = 5 * 60_000;

/** One answer's coding tools. */
export class CodeTurn {
  readonly uses: CodeUse[] = [];
  private running = false;
  private readonly o: CodeTurnOpts;
  /** The package.json scripts as they were when this answer began. */
  private readonly before: Promise<string>;

  constructor(o: CodeTurnOpts) {
    this.o = { ...o, perCall: Math.max(500, o.perCall) };
    this.before = scriptsOf(o.root);
  }

  get defs(): ToolDef[] {
    return this.o.run === 'never' ? CODE_TOOLS.slice(0, 1) : CODE_TOOLS;
  }

  private give(text: string): string {
    return text.length > this.o.perCall ? `${text.slice(0, this.o.perCall)}\n[cut here: no more room; ask for less (a path, -n 10, --stat)]` : text;
  }

  async run(name: string, rawArgs: string): Promise<string> {
    const now = this.o.now ?? Date.now;
    const start = now();
    let waited = 0;
    const exec = this.o.exec ?? realExec;
    const done = (tool: CodeUse['name'], ok: boolean, input: string, said: string, result: string) => {
      this.uses.push({ name: tool, input: input.slice(0, 300), ok, said: said.slice(0, 200), ms: Math.max(0, now() - start - waited) });
      if (tool === 'run_command' || !ok) {
        try {
          this.o.log?.({ kind: tool === 'run_command' ? 'run' : 'git', window: basename(this.o.root), action: input.slice(0, 120), outcome: ok ? said.slice(0, 160) : `refused: ${said.slice(0, 150)}` });
        } catch {
          // a log that cannot be written never stops the answer
        }
      }
      return result;
    };
    let a: Record<string, unknown>;
    try {
      a = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
      if (!a || typeof a !== 'object') throw new Error('not an object');
    } catch {
      return 'The call could not be read: its arguments are not JSON.';
    }
    if (name === 'git_read') {
      const g = gitArgs(a.verb, a.args);
      const shown = `git ${String(a.verb ?? '').slice(0, 20)} ${(Array.isArray(a.args) ? a.args : []).join(' ')}`.trim();
      if ('error' in g) return done('git_read', false, shown, g.error.split('.')[0], `Not read: ${g.error}`);
      const r = await exec('git', g.argv, { cwd: this.o.root, env: codeEnv(), timeoutMs: 30_000, maxChars: Math.max(this.o.perCall * 2, 8000) });
      if (r.timedOut) return done('git_read', false, shown, 'took too long', 'Not read: git took over 30 seconds, so it was stopped.');
      if (r.code !== 0) return done('git_read', false, shown, 'git said no', `git could not do that: ${r.out.trim().split('\n').slice(0, 3).join(' ').slice(0, 300) || 'no reason given'}`);
      if (looksSecret(r.out)) return done('git_read', false, shown, 'withheld', 'Not read: what git showed looks like it holds a password, key or token, so it was withheld. Tell the person; do not guess what it showed.');
      return done('git_read', true, shown, `${r.out.split('\n').length} lines`, this.give(r.out.trimEnd() || '(nothing to show)'));
    }
    if (name === 'run_command') {
      const asked = String(a.name ?? '').trim().toLowerCase();
      if (this.o.run === 'never') return done('run_command', false, asked, 'turned off', 'Not run: running commands is turned off (Settings, Permissions).');
      const list = await namedCommands(this.o.root, this.o.extra);
      const cmd = list.find(c => c.name === asked);
      if (!cmd) return done('run_command', false, asked.slice(0, 60), 'no such name', `Not run: there is no command named "${asked.slice(0, 40)}" here. ${list.length ? `The names are: ${list.map(c => c.name).join(', ')}.` : 'This folder has no named commands.'} You cannot write a command line.`);
      // Allowed runs with no card only while nothing in this answer could have changed what it runs.
      const why = [this.o.mustAsk?.() ?? '', (await scriptsOf(this.o.root)) !== (await this.before) ? 'the scripts in package.json changed during this answer' : ''].filter(Boolean).join('; ');
      if (this.o.run === 'each' || why) {
        const t = now();
        const detail = why ? `${cmd.shown}\n\nAsked${this.o.run === 'allowed' ? ' although Run is Allowed' : ''}: ${why}.` : cmd.shown;
        const yes = this.o.confirm ? await this.o.confirm(`run "${cmd.name}" in ${basename(this.o.root)}`, { detail }).catch(() => false) : false;
        waited = now() - t;
        if (!yes) return done('run_command', false, cmd.name, 'not allowed', deniedWords('run'));
      }
      if (this.running) return done('run_command', false, cmd.name, 'one at a time', 'Not run: another command is still running. One at a time.');
      this.running = true;
      try {
        const r = await exec(cmd.exe, cmd.args, { cwd: this.o.root, env: codeEnv(), timeoutMs: this.o.timeoutMs ?? RUN_TIMEOUT_MS, maxChars: Math.max(this.o.perCall, 4000) });
        const body = looksSecret(r.out) ? '(the output looks like it holds a password, key or token, so it was withheld)' : this.give(r.out.trimEnd() || '(no output)');
        if (r.timedOut) return done('run_command', false, cmd.name, 'stopped at the time limit', `"${cmd.name}" ran past its time limit and was stopped, with everything it started.\n${body}`);
        return done('run_command', r.code === 0, cmd.name, r.code === 0 ? 'passed' : `ended with ${r.code}`, `"${cmd.name}" ${r.code === 0 ? 'finished without a fault' : `ended with a fault (exit ${r.code})`}:\n${body}`);
      } finally {
        this.running = false;
      }
    }
    return `There is no tool called "${name}".`;
  }
}
