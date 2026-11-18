import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_TOOLS, CodeTurn, codeEnv, codingFolder, gitArgs, namedCommands, parseExtra, realExec, secretPath, type CodeLog, type Exec } from '../src/codetools.ts';

test('git_read takes its seven reading verbs and nothing that writes', () => {
  for (const verb of ['status', 'diff', 'log', 'show', 'branch', 'ls-files', 'blame']) assert.ok('argv' in gitArgs(verb, []), verb);
  for (const verb of ['push', 'commit', 'tag', 'reset', 'clean', 'checkout', 'remote', 'config', 'fetch', 'pull', 'stash', 'rm', 'gc', 'worktree', '-c', '', 'status; rm -rf', undefined, 5]) {
    const g = gitArgs(verb, []);
    assert.ok('error' in g && /reads only/.test(g.error), String(verb));
  }
  assert.deepEqual(gitArgs('status', undefined), { argv: ['--no-pager', '--no-optional-locks', 'status'] });
  assert.deepEqual(gitArgs('log', ['--oneline', '-n', '10']), { argv: ['--no-pager', '--no-optional-locks', 'log', '--no-ext-diff', '--no-textconv', '--oneline', '-n10'] });
  assert.deepEqual(gitArgs('diff', ['--stat', 'HEAD~2..HEAD', '--', 'src/app.js']), { argv: ['--no-pager', '--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD~2..HEAD', '--', 'src/app.js'] });
  assert.deepEqual(gitArgs('show', ['HEAD:src/app.js']), { argv: ['--no-pager', '--no-optional-locks', 'show', '--no-ext-diff', '--no-textconv', 'HEAD:src/app.js'] });
  assert.deepEqual(gitArgs('branch', ['-a']), { argv: ['--no-pager', '--no-optional-locks', 'branch', '--list', '-a'] });
  assert.deepEqual(gitArgs('blame', ['-L', '5,9', 'src/app.js']), { argv: ['--no-pager', '--no-optional-locks', 'blame', '-L5,9', 'src/app.js'] });
});

test('git_read refuses every option that could write, run or reach elsewhere', () => {
  const bad: Array<[string, string[]]> = [
    ['log', ['-c', 'core.pager=calc']], ['diff', ['--output=x.txt']], ['diff', ['--output', 'x.txt']], ['log', ['--exec=calc']], ['diff', ['--ext-diff']], ['show', ['--textconv']],
    ['diff', ['--no-index', 'a', 'b']], ['log', ['--format=%(trailers)']], ['log', ['--pretty=format:%H']], ['status', ['--git-dir=../other/.git']], ['status', ['-C', '..']],
    ['branch', ['-D', 'main']], ['branch', ['-d', 'x']], ['branch', ['-m', 'a', 'b']], ['branch', ['newbranch']], ['log', ['--upload-pack=x']], ['ls-files', ['--with-tree=x']],
    ['diff', ['-O', 'file']], ['log', ['-p', '--open-files-in-pager']], ['show', ['HEAD', '&&', 'calc']], ['log', ['$(calc)']], ['log', ['a|b']], ['log', ['a\nb']],
    ['show', ['../other/secret.txt']], ['show', ['HEAD:../x']], ['diff', ['C:\\Windows\\win.ini']], ['diff', ['/etc/passwd']], ['diff', ['--', '..\\x']], ['show', ['~/x']], ['diff', ['--', '-x']],
  ];
  for (const [verb, args] of bad) assert.ok('error' in gitArgs(verb, args), `${verb} ${args.join(' ')}`);
  assert.ok('error' in gitArgs('log', 'a string'), 'args must be a list');
  assert.ok('error' in gitArgs('log', [5]));
  assert.ok('error' in gitArgs('log', Array(17).fill('--stat')));
});

test('key files, .env and TOMLIN\'s own data are never read, by any spelling', () => {
  for (const p of ['.env', '.env.local', 'config/.ENV', 'server.pem', 'keys/site.key', 'id_rsa', 'id_ed25519.pub', '.ssh/config', 'data/settings.json', 'data\\app-lock.json', 'secrets.json', 'credentials', '.npmrc', 'x/.git-credentials', 'cert.pfx']) assert.equal(secretPath(p), true, p);
  for (const p of ['src/app.js', 'README.md', 'environment.ts', 'src/data/list.json', 'keyboard.js', 'idea.md']) assert.equal(secretPath(p), false, p);
  for (const args of [['HEAD:.env'], ['--', '.env'], ['HEAD~1:config/server.pem'], ['data/settings.json'], ['main..dev', '--', 'id_rsa']]) assert.ok('error' in gitArgs('show', args), args.join(' '));
});

test('the environment holds no key, token or password and cannot sign in to push', () => {
  const env = codeEnv({ PATH: 'p', SYSTEMROOT: 'w', GITHUB_TOKEN: 'ghp_x', GH_TOKEN: 'x', OPENAI_API_KEY: 'sk-x', NPM_TOKEN: 'x', TOMLIN_DATA: 'd', MY_PASSWORD: 'x', SSH_AUTH_SOCK: 's', GIT_ASKPASS: 'evil.exe', GIT_SSH_COMMAND: 'x', AWS_SECRET_ACCESS_KEY: 'x', NPM_CONFIG__AUTHTOKEN: 'x' });
  assert.deepEqual(Object.keys(env).sort(), ['GCM_INTERACTIVE', 'GIT_ASKPASS', 'GIT_CONFIG_NOSYSTEM', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'PATH', 'SSH_ASKPASS', 'SYSTEMROOT']);
  assert.deepEqual([env.GIT_ASKPASS, env.GIT_TERMINAL_PROMPT], ['', '0']);
});

test('a named command the person wrote: a known first word, no shell signs, none of the banned words', () => {
  assert.deepEqual(parseExtra('docs=npm run docs'), { name: 'docs', exe: 'npm', args: ['run', 'docs'], shown: 'npm run docs' });
  assert.deepEqual(parseExtra('Check = node tools/check.js --all'), { name: 'check', exe: 'node', args: ['tools/check.js', '--all'], shown: 'node tools/check.js --all' });
  for (const bad of ['x=git push', 'x=npm run a && calc', 'x=node a.js | more', 'x=node a.js > out.txt', 'x=cmd /c dir', 'x=powershell -c x', 'x=curl http://x', 'x=rm -rf .', 'x=del x', 'x=npm install', 'x=npm i left-pad', 'x=npx cowsay; calc', 'x=node -e "x"', 'x=node $(x)', 'x=git status', 'x=python -m pip install x', 'x=npm publish', 'x=node tools/release.js push', 'x=php artisan tag', 'no equals', '=node a.js', 'x=node %PATH%', 'x=cd ..']) {
    assert.ok('error' in parseExtra(bad), bad);
  }
});

test('the folder list: only a listed folder or one inside it, by its real path; never TOMLIN\'s own data', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ct-'));
  try {
    for (const d of ['proj/src', 'other', 'data/workspace/job']) await mkdir(join(base, d), { recursive: true });
    const list = [join(base, 'proj')];
    assert.equal(codingFolder(join(base, 'proj'), list), true);
    assert.equal(codingFolder(join(base, 'proj', 'src'), list), true);
    assert.equal(codingFolder(join(base, 'other'), list), false, 'a sibling');
    assert.equal(codingFolder(base, list), false, 'the parent');
    assert.equal(codingFolder(join(base, 'proj-2'), list), false, 'a folder that is not there');
    assert.equal(codingFolder(join(base, 'proj'), []), false, 'no list, no coding tools');
    assert.equal(codingFolder(join(base, 'proj'), [join(base, 'pro')]), false, 'not by the start of a name');
    assert.equal(codingFolder(join(base, 'data'), [base], join(base, 'data')), false, 'TOMLIN\'s data itself');
    assert.equal(codingFolder(base, [base], join(base, 'data')), false, 'a folder that holds TOMLIN\'s data');
    assert.equal(codingFolder(join(base, 'data', 'workspace', 'job'), [join(base, 'data', 'workspace')], join(base, 'data')), true, 'the workspace inside it may be listed');
    let linked = true;
    try {
      await symlink(join(base, 'other'), join(base, 'proj', 'out'), 'junction');
    } catch {
      linked = false;
    }
    if (linked) assert.equal(codingFolder(join(base, 'proj', 'out'), list), false, 'a link out of the folder is followed to where it really is');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

async function project(scripts: Record<string, string> | null) {
  const root = await mkdtemp(join(tmpdir(), 'ct-'));
  if (scripts) await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }));
  return root;
}

test('the named commands come from the project and the person, never from the model', async () => {
  const root = await project({ test: 'node --test', build: 'tsc', deploy: 'git push', lint: '' });
  try {
    const list = await namedCommands(root, ['docs=npm run docs', 'bad=git push', 'test=node other.js']);
    assert.deepEqual(list.map(c => c.name), ['test', 'build', 'docs'], 'deploy is not one of the four names; a bad line and a name already taken are left out');
    assert.equal(list[0].shown, 'npm run test  (node --test)', 'the card shows the script\'s real text');
    assert.deepEqual([list[0].exe, list[0].args], ['npm', ['run', 'test']]);
    assert.deepEqual(await namedCommands(await project(null)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run_command: off by default, a card with the real command each time, in the folder, no shell words from the model', async () => {
  const root = await project({ test: 'node --test', build: 'tsc' });
  try {
    const ran: Array<{ exe: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxChars: number }> = [];
    const exec: Exec = async (exe, args, o) => (ran.push({ exe, args, ...o }), { code: 0, out: 'ok 12 tests', timedOut: false });
    const log: CodeLog[] = [];
    const cards: Array<[string, unknown]> = [];
    const turn = (run: 'never' | 'each' | 'allowed', yes = true) => new CodeTurn({ root, perCall: 2000, run, exec, log: e => log.push(e), confirm: async (what, extra) => (cards.push([what, extra]), yes) });

    const off = turn('never');
    assert.deepEqual(off.defs.map(d => d.function.name), ['git_read'], 'not offered while it is Never');
    assert.match(await off.run('run_command', '{"name":"test"}'), /turned off/);
    assert.equal(ran.length, 0);

    const no = turn('each', false);
    assert.deepEqual(no.defs.map(d => d.function.name), CODE_TOOLS.map(d => d.function.name));
    assert.match(await no.run('run_command', '{"name":"test"}'), /did not allow running a command.*NOT allowed/s);
    assert.equal(ran.length, 0, 'refused without a yes');
    assert.deepEqual(cards[0], [`run "test" in ${root.split(/[\\/]/).at(-1)}`, { detail: 'npm run test  (node --test)' }]);

    const yes = turn('each');
    assert.match(await yes.run('run_command', '{"name":"TEST"}'), /"test" finished without a fault:\nok 12 tests/);
    assert.match(await yes.run('run_command', '{"name":"build"}'), /finished without a fault/);
    assert.equal(cards.length, 3, 'a card for each run');
    assert.deepEqual(ran.map(r => [r.exe, r.args, r.cwd]), [['npm', ['run', 'test'], root], ['npm', ['run', 'build'], root]]);
    assert.equal(ran[0].env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(Object.keys(ran[0].env).some(k => /TOKEN|SECRET|PASSW|API_?KEY/i.test(k)), false, 'no secret is passed on');
    for (const name of ['deploy', 'npm run test && calc', 'test; calc', '../x', '', 'node -e 1']) assert.match(await yes.run('run_command', JSON.stringify({ name })), /no command named|The names are/, name);
    assert.equal(ran.length, 2, 'nothing the model wrote became a command');
    assert.equal(cards.length, 3, 'and none of those reached a card');

    const auto = turn('allowed');
    assert.match(await auto.run('run_command', '{"name":"test"}'), /finished/);
    assert.equal(cards.length, 3, 'Allowed runs without a card');
    assert.ok(log.some(e => e.kind === 'run' && e.action === 'test' && e.outcome === 'passed'));
    assert.ok(log.some(e => e.kind === 'run' && /^refused: not allowed/.test(e.outcome)));
    assert.equal(JSON.stringify(log).includes('ok 12 tests'), false, 'the log holds no output');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a run that fails or overruns is said plainly; output is capped and a secret in it withheld; one at a time', async () => {
  const root = await project({ test: 'node --test' });
  try {
    const mk = (exec: Exec, perCall = 600) => new CodeTurn({ root, perCall, run: 'allowed', exec, timeoutMs: 50 });
    assert.match(await mk(async () => ({ code: 1, out: 'not ok 3', timedOut: false })).run('run_command', '{"name":"test"}'), /ended with a fault \(exit 1\):\nnot ok 3/);
    assert.match(await mk(async (_e, _a, o) => (assert.equal(o.timeoutMs, 50), { code: null, out: 'half', timedOut: true })).run('run_command', '{"name":"test"}'), /ran past its time limit and was stopped, with everything it started/);
    const long = await mk(async () => ({ code: 0, out: 'x'.repeat(5000), timedOut: false })).run('run_command', '{"name":"test"}');
    assert.ok(long.length < 800);
    assert.match(long, /\[cut here: no more room/);
    const secret = await mk(async () => ({ code: 0, out: 'api_key = abcdefghijklmnop1234', timedOut: false })).run('run_command', '{"name":"test"}');
    assert.match(secret, /withheld/);
    assert.doesNotMatch(secret, /abcdefghijklmnop/);
    let release!: () => void;
    const slow = mk(() => new Promise(r => { release = () => r({ code: 0, out: 'done', timedOut: false }); }));
    const first = slow.run('run_command', '{"name":"test"}');
    await new Promise(r => setTimeout(r, 20));
    assert.match(await slow.run('run_command', '{"name":"test"}'), /One at a time/);
    release();
    assert.match(await first, /finished/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('git_read: the fixed command runs in the folder; a refusal runs nothing; a secret in the output is withheld', async () => {
  const root = await project(null);
  try {
    const ran: Array<[string, string[], string]> = [];
    let out = 'M src/app.js';
    const t = new CodeTurn({ root, perCall: 600, run: 'never', exec: async (exe, args, o) => (ran.push([exe, args, o.cwd]), { code: 0, out, timedOut: false }) });
    assert.equal(await t.run('git_read', '{"verb":"status","args":["--short"]}'), 'M src/app.js');
    assert.deepEqual(ran, [['git', ['--no-pager', '--no-optional-locks', 'status', '--short'], root]]);
    assert.match(await t.run('git_read', '{"verb":"push"}'), /Not read: git_read reads only/);
    assert.match(await t.run('git_read', '{"verb":"log","args":["-c","x=y"]}'), /Not read: The option "-c"/);
    assert.match(await t.run('git_read', '{"verb":"show","args":["HEAD:.env"]}'), /never read/);
    assert.equal(ran.length, 1, 'nothing ran for a refusal');
    out = 'password: hunter2hunter2hunter2';
    const withheld = await t.run('git_read', '{"verb":"diff"}');
    assert.match(withheld, /withheld/);
    assert.doesNotMatch(withheld, /hunter2/);
    out = 'y'.repeat(3000);
    assert.match(await t.run('git_read', '{"verb":"diff"}'), /\[cut here: no more room/);
    assert.match(await t.run('git_read', 'not json'), /not JSON/);
    assert.match(await t.run('run_shell', '{}'), /no tool called/);
    assert.deepEqual(t.uses.map(u => u.ok), [true, false, false, false, false, true]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the real runner: no shell, the time limit ends the process, the output is capped', async () => {
  const root = await project(null);
  try {
    await writeFile(join(root, 'slow.js'), 'setInterval(() => {}, 1000);');
    await writeFile(join(root, 'loud.js'), 'process.stdout.write("z".repeat(50000)); console.log(process.cwd());');
    const env = codeEnv();
    const t0 = Date.now();
    const slow = await realExec('node', ['slow.js'], { cwd: root, env, timeoutMs: 400, maxChars: 1000 });
    assert.equal(slow.timedOut, true);
    assert.ok(Date.now() - t0 < 15_000);
    const loud = await realExec('node', ['loud.js'], { cwd: root, env, timeoutMs: 20_000, maxChars: 1000 });
    assert.equal(loud.out.length, 1000);
    // No shell: a sign a shell would act on is just a word to the program.
    const plain = await realExec('node', ['-p', 'process.argv.slice(1).join("|")', 'a&&b', '>x'], { cwd: root, env, timeoutMs: 20_000, maxChars: 1000 });
    assert.equal(plain.out.trim(), 'a&&b|>x');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
