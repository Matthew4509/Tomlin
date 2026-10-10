// An update pushed from this TOMLIN to a real older one, end to end: the node runs 2.0.44 as it was committed (the
// last version before the TOMLIN name, still on some PCs), taken from git history into a scratch folder; the host runs
// this copy's files. On 9 Oct the workers refused such an update ("not named as an app file (Start TOMLIN.cmd)"), which
// only a real old copy shows. Both copies are small (no models, no runners) and share one node_modules in the folder
// above them, so nothing large is sent or copied. Skipped where there is no git history (a release zip ships tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, nodeHome, startPc, transferEnd, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 2.0.44, the commit before the TOMLIN name (76b26fa): Start Shelby.cmd, SHELBY_* settings, "Smart Manager" names. */
const OLD = '1005386';
const OLD_PARTS = ['src', 'public', 'tools', 'registry', 'package.json', 'package-lock.json', 'runtimes.json', 'Start Shelby.cmd'];
/** What this copy sends (src/update.ts PARTS, without the models, runners and packages a scratch copy does not hold). */
const NEW_PARTS = ['src', 'public', 'tools', 'test', 'registry', 'package.json', 'package-lock.json', 'runtimes.json', 'README.md', 'LICENSE', 'THIRD-PARTY.md', 'Start TOMLIN.cmd', 'Start Shelby.cmd', 'Install TOMLIN.cmd'];

const git = (...args: string[]) => execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
const hasOld = (() => {
  try {
    git('cat-file', '-e', `${OLD}^{commit}`);
    return existsSync(join(ROOT, 'node_modules', 'sharp'));
  } catch {
    return false;
  }
})();
const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

test('Update it from this TOMLIN to a real 2.0.44 node: sent under the names it takes, it starts the new copy, and says the same version and files', { timeout: 300_000, skip: hasOld ? false : `no git history with ${OLD} here (or no node_modules)` }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-oldnode-'));
  const modules = join(top, 'node_modules');
  const pcs: Pc[] = [];
  try {
    // One node_modules for both copies, found by Node in the folder above them (a junction: nothing is copied).
    symlinkSync(join(ROOT, 'node_modules'), modules, 'junction');
    const old = join(top, 'old');
    mkdirSync(old);
    execFileSync(TAR, ['-x', '-f', '-', '-C', old], { input: git('archive', '--format=tar', OLD, ...OLD_PARTS) });
    assert.equal(JSON.parse(readFileSync(join(old, 'package.json'), 'utf8')).version, '2.0.44');
    assert.equal(existsSync(join(old, 'Start TOMLIN.cmd')), false, 'the old copy knows only Start Shelby.cmd');
    const now = join(top, 'host');
    for (const p of NEW_PARTS) if (existsSync(join(ROOT, p))) cpSync(join(ROOT, p), join(now, p), { recursive: true });
    const version = JSON.parse(readFileSync(join(now, 'package.json'), 'utf8')).version as string;

    // The old node: shares, every tick on, and started by its launcher (it can start a new copy: SHELBY_LOOP).
    const workerPort = await freePort();
    const nodeDir = join(top, 'node-home');
    nodeHome(nodeDir, workerPort, 'Old node');
    const node = await startPc({ root: old, home: nodeDir, env: { LOOP: '1' } });
    pcs.push(node);
    const host = await startPc({ root: now, home: join(top, 'host-home') });
    pcs.push(host);
    const pc = await link(host, workerPort);
    const before = (await host.get('/api/remotes')).body.remotes.find((r: { id: string }) => r.id === pc);
    assert.equal(before.version, '2.0.44', JSON.stringify(before));

    // Update it: refused under the new launcher name, sent again under the old one, finished there.
    const up = await host.post('/api/network/update', { pc });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    // The old node ends with 76 ("start the copy named in next-copy.txt"), as its Start Shelby.cmd expects.
    // A transfer that ends first failed (the node ends only once the copy is in): its words say why.
    const first = await Promise.race([node.exited.then(code => ({ code })), transferEnd(host, up.body.transfer.id, 120_000).then(t => ({ t }))]);
    assert.ok('code' in first, `the update ended before the node restarted: ${JSON.stringify(first)}`);
    assert.equal(first.code, 76, `the old node ended with ${first.code}:\n${node.said().slice(-3000)}`);
    const next = readFileSync(join(old, 'next-copy.txt'), 'utf8').trim();
    const copy = isAbsolute(next) ? next : join(top, next);
    assert.ok(existsSync(join(copy, 'src', 'server.ts')), `the new copy is at ${copy}`);
    assert.equal(JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).version, version);
    assert.equal(readFileSync(join(copy, 'src', 'server.ts'), 'utf8'), readFileSync(join(now, 'src', 'server.ts'), 'utf8'));
    // The launcher went under the name that PC's own launcher and shortcuts use, holding the whole new launcher.
    assert.equal(readFileSync(join(copy, 'Start Shelby.cmd'), 'utf8'), readFileSync(join(now, 'Start TOMLIN.cmd'), 'utf8'));
    assert.equal(existsSync(join(copy, 'Start TOMLIN.cmd')), false);

    // Its launcher starts the new copy on the same home: the host sees this version and the same files (build).
    const started = await startPc({ root: copy, home: nodeDir, env: { LOOP: '1' } });
    pcs.push(started);
    const end = await transferEnd(host, up.body.transfer.id, 200_000);
    assert.equal(end.state, 'done', end.said);
    const after = await until('the host to see the new version', async () => {
      const r = (await host.get('/api/remotes')).body.remotes.find((x: { id: string }) => x.id === pc);
      return r?.ok && r.version === version ? r : null;
    });
    const hostBuild = (await host.get('/api/status')).body.build;
    if (hostBuild) assert.equal(after.build, String(hostBuild).slice(0, 7), 'the same files as the host');
    // Still linked with the same keys, and the shared ticks kept.
    assert.ok(after.can.includes('git'), JSON.stringify(after.can));
    assert.equal(after.allow?.update ?? true, true);
    for (const p of [host, started]) assert.doesNotMatch(p.said(), /Uncaught|TypeError|ReferenceError/, p.said());
  } finally {
    for (const p of pcs) await p.stop();
    // The junction goes first, on its own, so removing the scratch folder can never reach the real node_modules.
    let linkGone = !existsSync(modules);
    if (!linkGone && lstatSync(modules).isSymbolicLink()) {
      unlinkSync(modules);
      linkGone = true;
    }
    if (linkGone) rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert.ok(existsSync(join(ROOT, 'node_modules', 'sharp')), 'the real node_modules is untouched');
  }
});
