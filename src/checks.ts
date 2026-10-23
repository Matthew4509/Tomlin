// Checks on a job's files. Two kinds, kept apart on purpose:
// - Syntax checks (automatic): read the PROPOSED text, in a temporary folder, before anything is saved. Nothing the
//   model wrote is run: node --check and python -m py_compile only parse, php -l only lints.
//   Note: `node --check file.ts` and `node --check file.js` that uses import check NOTHING (they exit 0 on broken
//   code, measured on Node 24). So TypeScript is stripped with Node's own stripper first, and module code is checked
//   as .mjs, plain scripts as .cjs.
// - Tests (only when the person presses Run tests): a command from a short fixed list, run in the workspace, with a
//   time limit. These DO run code, which is why they never start by themselves.
// The plain functions are tested in test/checks.test.ts.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

export interface CheckResult {
  path: string;
  tool: string;
  ok: boolean;
  /** The first useful lines of the error, with the temporary folder taken out. Empty when it passed. */
  message: string;
}

interface Ran { code: number | null; out: string; timedOut: boolean }

/**
 * The environment a test run gets (Run tests runs code a model wrote): what the four test commands need to find
 * themselves and their files (the PC's own folders, temp folders, the user's folders, language settings, Python's, npm's
 * and Node's own folders), and nothing else. Anything named like a key, a token or a password is left out even then,
 * and so are TOMLIN's own settings.
 */
const TEST_ENV = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|PUBLIC|ALLUSERSPROFILE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|OS|USERNAME|USERDOMAIN|COMPUTERNAME|LANG|LANGUAGE|TZ|LC_\w+|PYTHON\w*|VIRTUAL_ENV|CONDA_\w+|PIP_\w+|NODE_PATH|NPM_CONFIG_\w+|NVM_\w+)$/i;
const SECRET_NAME = /(TOKEN|SECRET|PASSW|_PWD|PWD$|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION|^TOMLIN_|^SHELBY_)/i;
export function testEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && TEST_ENV.test(k) && !SECRET_NAME.test(k)));
}

/** Runs a program without a shell, with a time limit; output capped. `env`: its environment (this one's by default). */
export function run(exe: string, args: string[], opts: { cwd?: string; timeoutMs?: number; shell?: boolean; maxChars?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Ran> {
  return new Promise(resolve => {
    let out = '';
    let timedOut = false;
    const max = opts.maxChars ?? 8000;
    let child: import('node:child_process').ChildProcess;
    try {
      // Node's own markers are left out: a parent's NODE_TEST_CONTEXT makes a child `node --test` skip every file.
      const env = Object.fromEntries(Object.entries(opts.env ?? process.env).filter(([k]) => !/^NODE_(OPTIONS|TEST_CONTEXT|CHANNEL_FD|UNIQUE_ID)$/.test(k)));
      child = spawn(exe, args, { cwd: opts.cwd, shell: opts.shell ?? false, windowsHide: true, env: { ...env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    } catch (e) {
      return resolve({ code: -1, out: (e as Error).message, timedOut: false });
    }
    const add = (d: Buffer) => { if (out.length < max) out += d.toString('utf8'); };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      // On Windows a shell child has its own children: end the whole tree.
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, opts.timeoutMs ?? 20_000);
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: out + e.message, timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.slice(0, max), timedOut }); });
  });
}

const tools: Record<string, Promise<boolean>> = {};
/** Whether a program answers its --version (once per run of TOMLIN). The Windows Store "python" stub fails this. */
export function hasTool(exe: string): Promise<boolean> {
  tools[exe] ??= run(exe, ['--version'], { timeoutMs: 8000 }).then(r => r.code === 0 && /\d+\.\d+/.test(r.out));
  return tools[exe];
}

/** True when the text is module code (import/export at the start of a line). */
export const isModule = (text: string) => /^\s*(import\s*[\w{*'"]|export\s)/m.test(text);

/** Braces, brackets and parentheses balance in CSS (outside comments and strings). A cheap check with no false alarms on valid CSS. */
export function cssBalance(text: string): string {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  const stack: { ch: string; line: number }[] = [];
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  let line = 1;
  for (const ch of src) {
    if (ch === '\n') line++;
    else if (ch === '{' || ch === '(' || ch === '[') stack.push({ ch, line });
    else if (pairs[ch]) {
      const top = stack.pop();
      if (!top || top.ch !== pairs[ch]) return `Line ${line}: "${ch}" has no matching "${pairs[ch]}".`;
    }
  }
  return stack.length ? `Line ${stack[stack.length - 1].line}: "${stack[stack.length - 1].ch}" is never closed.` : '';
}

/** The first lines of a tool's error that help, with temporary paths replaced by the file's own name. */
export function tidyError(out: string, tempDir: string, path: string): string {
  const lines = out.replace(/\r/g, '').split('\n')
    .map(l => l.split(tempDir).join('').replace(/^[\\/]+/, '').replace(/[\w.-]+\.(?:mjs|cjs)\b/g, path))
    .filter(l => l.trim() && !/^\s+at |^Node\.js v|ExperimentalWarning|--trace-warnings|^\s*\^+\s*$/.test(l));
  return lines.slice(0, 6).join('\n').slice(0, 600);
}

const SCRIPT = /\.(m?js|cjs|ts|mts)$/i;

/** Syntax checks on proposed files (path + text). Files with no checker are left out of the results. */
export async function syntaxCheck(files: { path: string; text: string }[]): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'sm-check-'));
  try {
    for (const [i, f] of files.entries()) {
      const ext = extname(f.path).toLowerCase();
      if (ext === '.json') {
        try {
          JSON.parse(f.text);
          out.push({ path: f.path, tool: 'JSON', ok: true, message: '' });
        } catch (e) {
          out.push({ path: f.path, tool: 'JSON', ok: false, message: (e as Error).message });
        }
      } else if (ext === '.css') {
        const m = cssBalance(f.text);
        out.push({ path: f.path, tool: 'CSS brackets', ok: !m, message: m });
      } else if (SCRIPT.test(ext)) {
        let js = f.text;
        let tool = 'node --check';
        if (/\.m?ts$/.test(ext)) {
          tool = 'TypeScript strip + node --check';
          try {
            js = stripTypeScriptTypes(f.text);
          } catch (e) {
            out.push({ path: f.path, tool, ok: false, message: (e as Error).message.split('\n').slice(0, 4).join('\n') });
            continue;
          }
        }
        const module = ext === '.mjs' || ext === '.mts' || isModule(js);
        const name = `f${i}.${module ? 'mjs' : 'cjs'}`;
        await writeFile(join(dir, name), js);
        let r = await run(process.execPath, ['--check', name], { cwd: dir });
        // As Node runs a file with no "type" of its own: one that fails as a plain script only for module syntax
        // (top-level await, with no import) runs as a module. The plain script's error is the one told.
        if (r.code !== 0 && !module) {
          const asModule = `f${i}.mjs`;
          await writeFile(join(dir, asModule), js);
          if ((await run(process.execPath, ['--check', asModule], { cwd: dir })).code === 0) r = { ...r, code: 0 };
        }
        out.push({ path: f.path, tool, ok: r.code === 0, message: r.code === 0 ? '' : tidyError(r.out, dir, f.path) });
      } else if (ext === '.py' && (await hasTool('python'))) {
        const name = `f${i}.py`;
        await writeFile(join(dir, name), f.text);
        const r = await run('python', ['-B', '-m', 'py_compile', name], { cwd: dir });
        out.push({ path: f.path, tool: 'python -m py_compile', ok: r.code === 0, message: r.code === 0 ? '' : tidyError(r.out.replace(new RegExp(name, 'g'), f.path), dir, f.path) });
      } else if (ext === '.php' && (await hasTool('php'))) {
        const name = `f${i}.php`;
        await writeFile(join(dir, name), f.text);
        const r = await run('php', ['-l', name], { cwd: dir });
        out.push({ path: f.path, tool: 'php -l', ok: r.code === 0, message: r.code === 0 ? '' : tidyError(r.out.replace(new RegExp(name, 'g'), f.path), dir, f.path) });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return out;
}

/** The tests the person can run, by id. Each runs code from the workspace, so only on a button press. */
export const TESTS: Record<string, { label: string; exe: string; args: string[]; shell?: boolean; needs?: string }> = {
  'node-test': { label: 'node --test', exe: process.execPath, args: ['--test'] },
  'npm-test': { label: 'npm test', exe: 'npm', args: ['test'], shell: true },
  pytest: { label: 'python -m pytest', exe: 'python', args: ['-m', 'pytest', '-q'], needs: 'python' },
  unittest: { label: 'python -m unittest', exe: 'python', args: ['-m', 'unittest'], needs: 'python' },
};

/**
 * Test output a person (and a model) can use: stack lines and Node's own frames dropped, the workspace's folder path
 * taken out (as a path and as a file:/// address), blank runs closed up. The start is kept: it names what failed.
 */
export function tidyTestOutput(out: string, cwd: string): string {
  const roots = [cwd, cwd.replace(/\\/g, '/'), `file:///${cwd.replace(/\\/g, '/')}`, `file://${cwd.replace(/\\/g, '/')}`].sort((a, b) => b.length - a.length);
  let text = out.replace(/\r/g, '');
  for (const r of roots) text = text.split(`${r}/`).join('').split(`${r}\\`).join('').split(r).join('.');
  return text.split('\n')
    .filter(l => !/^\s+at\s/.test(l) && !/node:internal|node:async_hooks/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 3000);
}

export async function runTests(id: string, cwd: string): Promise<{ ok: boolean; label: string; output: string; seconds: number } | { error: string }> {
  const t = TESTS[id];
  if (!t) return { error: 'That is not one of the test commands TOMLIN can run.' };
  if (t.needs && !(await hasTool(t.needs))) return { error: `${t.label} needs ${t.needs}, which is not installed on this PC (or only the Windows Store shortcut is).` };
  const t0 = Date.now();
  const r = await run(t.exe, t.args, { cwd, timeoutMs: 60_000, shell: t.shell, maxChars: 12_000, env: testEnv(process.env) });
  const output = `${r.timedOut ? 'Stopped after 60 seconds (the tests took too long or waited for input).\n' : ''}${tidyTestOutput(r.out, cwd)}`;
  return { ok: r.code === 0 && !r.timedOut, label: t.label, output, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}
