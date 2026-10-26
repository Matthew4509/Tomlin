// An update pulled from a linked PC, end to end with two real copies (26 Oct): the PC behind (a scratch copy of this
// TOMLIN that says an older version) links to a PC running this copy's files and presses Update this PC from it. Refused
// until that PC's owner ticks "Let linked PCs pull TOMLIN updates from here"; then no PIN of that PC is asked, and the
// PC behind ends with 76 and next-copy.txt naming a whole copy of the other PC's files beside its own. Both copies are
// small (no models, no runners) and share one node_modules in the folder above them, as test/oldnode.test.ts does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as update from '../src/update.ts';
import { freePort, link, nodeHome, startPc, transferEnd, unlock, until, NODE_PIN, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** What a copy sends and holds here (src/update.ts PARTS, without the models, runners and packages a scratch copy does not hold). */
const PARTS = ['src', 'public', 'tools', 'test', 'registry', 'package.json', 'package-lock.json', 'runtimes.json', 'README.md', 'LICENSE', 'THIRD-PARTY.md', 'Start TOMLIN.cmd', 'Install TOMLIN.cmd', 'Welcome to TOMLIN.html'];
/** The node_modules this copy runs with: its own, or (a git worktree inside the project) the nearest one above it. */
const MODULES = (() => {
  for (let dir = ROOT; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', 'sharp'))) return join(dir, 'node_modules');
    if (dirname(dir) === dir) return '';
  }
})();
const hasModules = !!MODULES;

test('Update this PC from it: refused until the other PC ticks it, then no PIN, and this PC starts a whole copy of its files', { timeout: 300_000, skip: hasModules ? false : 'no node_modules here' }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-pull-'));
  const modules = join(top, 'node_modules');
  const pcs: Pc[] = [];
  try {
    symlinkSync(MODULES, modules, 'junction');
    const giverRoot = join(top, 'big');
    for (const p of PARTS) if (existsSync(join(ROOT, p))) cpSync(join(ROOT, p), join(giverRoot, p), { recursive: true });
    const version = JSON.parse(readFileSync(join(giverRoot, 'package.json'), 'utf8')).version as string;
    // The PC behind: the same files, but its package.json says a version before this one.
    const oldRoot = join(top, 'old');
    cpSync(giverRoot, oldRoot, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(oldRoot, 'package.json'), 'utf8'));
    const [a, b, c] = version.split('.').map(Number);
    pkg.version = c > 0 ? `${a}.${b}.${c - 1}` : `${a}.${b - 1}.99`;
    writeFileSync(join(oldRoot, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    assert.ok(update.newer(version, pkg.version));

    // The PC ahead shares (a node), every tick on but the new one; the PC behind links to it and runs from its launcher.
    const workerPort = await freePort();
    const bigHome = join(top, 'big-home');
    nodeHome(bigHome, workerPort, 'Big PC');
    const big = await startPc({ root: giverRoot, home: bigHome });
    pcs.push(big);
    const old = await startPc({ root: oldRoot, home: join(top, 'old-home'), env: { LOOP: '1' } });
    pcs.push(old);
    const pc = await link(old, workerPort);

    // Not ticked there: its window says why, and the pull is refused with its words.
    const seen = await until('the PC behind to see the newer one', async () => {
      const r = (await old.get('/api/remotes')).body.remotes.find((x: { id: string }) => x.id === pc);
      return r?.ok && r.version === version && r.pull ? r : null;
    });
    assert.match(seen.pull.why, /"Big PC" does not let linked PCs pull TOMLIN updates from it \(its owner can tick "Let linked PCs pull TOMLIN updates from here" there\)/);
    const refused = await old.post('/api/network/pull', { pc });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Let linked PCs pull TOMLIN updates from here/);
    // A push the other way round is not what this is: the PC behind cannot update the one ahead.
    assert.notEqual((await old.post('/api/network/update', { pc })).status, 200);

    // Its owner ticks it (with its app lock PIN, as every tick there).
    await unlock(big);
    const tick = await big.post('/api/share', { allow: { pull: true, backup: true, update: true, tune: false, lend: false, receive: false, give: true }, appPin: NODE_PIN });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    await until('the tick to show on the PC behind', async () => {
      const r = (await old.get('/api/remotes')).body.remotes.find((x: { id: string }) => x.id === pc);
      return r?.pull && r.pull.why === '' ? r : null;
    });

    // Update this PC from it: no PIN asked; only what differs crosses; this PC ends with 76 and names the new copy.
    const go = await until('the pull to start (the other PC reads its own files after it starts)', async () => {
      const r = await old.post('/api/network/pull', { pc });
      return r.status === 200 ? r : null;
    }, 60_000, 1000);
    const first = await Promise.race([old.exited.then(code => ({ code })), transferEnd(old, go.body.transfer.id, 120_000).then(t => ({ t }))]);
    // The transfer may finish just before the PC ends: then it must have finished well, and the PC ends next.
    if ('t' in first) assert.equal(first.t.state, 'done', first.t.said);
    const code = 'code' in first ? first.code : await old.exited;
    assert.equal(code, update.RESTART_INTO, `the PC behind ended with ${code}:\n${old.said().slice(-3000)}`);
    const next = readFileSync(join(oldRoot, update.NEXT_COPY_FILE), 'utf8').trim();
    const copy = isAbsolute(next) ? next : join(top, next);
    assert.equal(copy, join(top, `tomlin-${version}`), 'beside its own copy, named by the version');
    assert.equal(JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).version, version);
    assert.equal(await update.buildId(copy), await update.buildId(giverRoot), 'the very files the other PC runs');
    assert.equal(JSON.parse(readFileSync(join(oldRoot, 'package.json'), 'utf8')).version, pkg.version, 'the old copy stays for going back');
    assert.match(old.said(), new RegExp(`TOMLIN ${version.replace(/\./g, '\\.')} was pulled here from "Big PC"`));
    // What it notes for its page, and that the other PC changed nothing of its own.
    const share = JSON.parse(readFileSync(join(top, 'old-home', 'data', 'share.json'), 'utf8'));
    assert.deepEqual([share.updated?.version, share.updated?.by, share.updated?.pulled], [version, 'Big PC', true]);
    assert.equal(existsSync(join(giverRoot, update.NEXT_COPY_FILE)), false);
    for (const p of pcs) assert.doesNotMatch(p.said(), /Uncaught|TypeError|ReferenceError/, p.said());
  } finally {
    for (const p of pcs) await p.stop();
    // The junction goes first, on its own, so removing the scratch folder can never reach the real node_modules.
    let linkGone = !existsSync(modules);
    if (!linkGone && lstatSync(modules).isSymbolicLink()) {
      unlinkSync(modules);
      linkGone = true;
    }
    if (linkGone) rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert.ok(existsSync(join(MODULES, 'sharp')), 'the real node_modules is untouched');
  }
});
