// The project backups a node keeps for linked PCs, kept from growing for ever (src/gitstore.ts trimRepo,
// src/projectstore.ts): the newest backups stay and can still be brought back, older history goes, the sweep never
// takes what a kept backup needs (a file still coming in, a commit at the same moment, a tree it cannot read), the
// leftovers of stopped sends go, and the cap takes the oldest backups across every PC first. On real temp folders.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '../src/gitstore.ts';
import * as carry from '../src/carry.ts';
import { capFor, capPlan, clearLeftovers, needOf, STORE_CAP, trimProjectStores } from '../src/projectstore.ts';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-pstore-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const ALLOW = { pull: false, backup: true, update: false, tune: false, lend: false, receive: false, give: false, off: true };
const old = (file: string, hours: number) => {
  const t = new Date(Date.now() - hours * 3600_000);
  utimesSync(file, t, t);
};
/** Every object file in a repository, by id. */
const objectsIn = (repo: string) => readdirSync(join(repo, 'objects')).filter(d => /^[0-9a-f]{2}$/.test(d)).flatMap(d => readdirSync(join(repo, 'objects', d)).map(n => d + n));

/** A node's doors for one linked PC, and that PC backing up. */
function aNode(root = tmp(), key = 'b1b2b3b4', name = 'Laptop') {
  const handle = carry.nodeSide({
    allow: () => ALLOW,
    shared: () => [],
    pcName: () => 'Worker PC',
    chatFiles: () => null,
    pictureFiles: () => null,
    chatDir: join(root, 'models'),
    chatHas: () => false,
    pictureDest: () => null,
    keptRoot: join(root, 'kept'),
    freeBytes: async () => Infinity,
  });
  const who = { key, name };
  const ask = async (p: string, b: Record<string, unknown>) => {
    const a = await handle(p, b, who);
    if (!('json' in a)) throw new Error('a piece came where words were expected');
    if (a.status !== 200) throw new Error(String(a.json.error));
    return a.json;
  };
  const put = async (data: Buffer) => {
    const id = git.blobId(data);
    for (let at = 0; ;) {
      const a = await handle('/worker/git-put', { id, bytes: data.length, from: at }, who, data.subarray(at, at + 4096));
      if (!('json' in a) || a.status !== 200) throw new Error('json' in a ? String(a.json.error) : 'piece');
      if (a.json.done === true) return id;
      at = Number(a.json.at);
    }
  };
  const get = async (id: string) => {
    const out: Buffer[] = [];
    for (let at = 0; ;) {
      const a = await handle('/worker/git-get', { id, from: at }, who);
      if (!('piece' in a)) throw new Error(String(a.json.error));
      if (!a.piece.length) break;
      out.push(a.piece);
      at += a.piece.length;
      if (a.piece.length < carry.PIECE) break;
    }
    return Buffer.concat(out);
  };
  /** One backup: a file that changes every time, and one that never does. */
  const backup = async (n: number) => {
    const files = { 'site/big.bin': Buffer.from(`version ${n} `.repeat(400)), 'site/readme.md': Buffer.from('# Same every time\n') };
    const list = [];
    for (const [path, data] of Object.entries(files)) list.push({ path, id: await put(data) });
    return (await ask('/worker/git-commit', { files: list, message: `Backup ${n}` })).id as string;
  };
  return { root, keptRoot: join(root, 'kept'), repo: carry.projectsRepo(join(root, 'kept'), key), ask, get, backup, put };
}

test('a repository keeps its newest backups: older history goes, the kept ones come back whole, git still reads it, and backing up goes on', async () => {
  const node = aNode();
  const ids: string[] = [];
  for (let n = 1; n <= 6; n++) ids.push(await node.backup(n));
  const before = objectsIn(node.repo).length;
  // Read (and kept) before the trim: the cut is seen afterwards all the same.
  assert.equal((await carry.projectsHere(node.keptRoot))[0].backups, 6);
  const t = await git.trimRepo(node.repo, { keep: 3, graceMs: 0 });
  assert.equal(t.commits, 3, 'three older backups let go');
  assert.ok(t.objects >= 9 && t.bytes > 0, 'their commits, trees and changed files swept');
  assert.equal(objectsIn(node.repo).length, before - t.objects);
  const log = (await node.ask('/worker/git-log', {})).commits as { id: string }[];
  assert.deepEqual(log.map(c => c.id), [ids[5], ids[4], ids[3]]);
  // The oldest kept backup is brought back byte for byte; one let go says so in plain words.
  const back = (await node.ask('/worker/git-files', { commit: ids[3] })).files as { path: string; id: string }[];
  const big = back.find(f => f.path === 'site/big.bin')!;
  assert.equal((await node.get(big.id)).toString(), `version 4 `.repeat(400));
  await assert.rejects(node.ask('/worker/git-files', { commit: ids[0] }), /not kept on "Worker PC" any more/);
  // The node's own page counts what is kept.
  assert.equal((await carry.projectsHere(node.keptRoot))[0].backups, 3);
  if (hasGit) {
    execFileSync('git', ['--git-dir', node.repo, 'fsck', '--full', '--strict'], { stdio: 'pipe' });
    assert.equal(execFileSync('git', ['--git-dir', node.repo, 'log', '--format=%H'], { encoding: 'utf8' }).trim().split('\n').length, 3);
  }
  // The next backup sits on the kept ones; a second trim with nothing new to let go deletes nothing.
  const next = await node.backup(7);
  assert.equal((await carry.projectsHere(node.keptRoot))[0].backups, 4);
  assert.equal(((await node.ask('/worker/git-log', {})).commits as unknown[]).length, 4);
  assert.deepEqual(await git.trimRepo(node.repo, { keep: 4, graceMs: 0 }), { commits: 0, objects: 0, bytes: 0 });
  assert.equal(((await node.ask('/worker/git-log', {})).commits as { id: string }[])[0].id, next);
});

test('the sweep never takes a file still coming in, and a commit made while a trim runs is whole', async () => {
  const node = aNode();
  for (let n = 1; n <= 4; n++) await node.backup(n);
  // A file the PC sent for a backup it has not committed yet: written just now, so it stays (the grace of a day).
  const waiting = await node.put(Buffer.from('sent, commit still to come'));
  const t = await git.trimRepo(node.repo, { keep: 1 });
  assert.equal(t.commits, 3);
  assert.equal(t.objects, 0, 'everything was written in the last day: nothing swept yet');
  assert.ok(await git.hasObject(node.repo, waiting));
  // Swept with no grace, while a backup commits at the same moment: the two take turns, and the result is whole.
  const fresh = await node.put(Buffer.from('a file of the next backup'));
  const [committed, trimmed] = await Promise.all([
    node.ask('/worker/git-commit', { files: [{ path: 'new.md', id: fresh }, { path: 'held.md', id: waiting }], message: 'Backup 5' }),
    git.trimRepo(node.repo, { keep: 1, graceMs: 0 }),
  ]);
  assert.ok(trimmed.objects > 0);
  assert.ok(await git.hasObject(node.repo, waiting) && await git.hasObject(node.repo, fresh), 'the commit came first, so its files are kept');
  // The other way round: the sweep first takes a file no kept backup names, and the commit naming it is refused
  // (the PC sends it again next time), never made with a file missing.
  const lost = await node.put(Buffer.from('sent long ago, never committed'));
  old(join(node.repo, 'objects', lost.slice(0, 2), lost.slice(2)), 48);
  const [, refused] = await Promise.all([
    git.trimRepo(node.repo, { keep: 1, graceMs: 0 }),
    node.ask('/worker/git-commit', { files: [{ path: 'lost.md', id: lost }], message: 'Backup 6' }).then(() => null, (e: Error) => e.message),
  ]);
  assert.match(refused ?? '', /missing here/);
  const head = await git.headOf(node.repo);
  assert.equal(head, committed.id);
  for (const c of await git.logOf(node.repo, 10)) await git.reachOf(node.repo, c, new Set()).then(found => Promise.all(found.map(async id => assert.ok(await git.hasObject(node.repo, id), id))));
  if (hasGit) execFileSync('git', ['--git-dir', node.repo, 'fsck', '--full', '--strict'], { stdio: 'pipe' });
});

test('a tree that cannot be read stops the sweep before anything is deleted; a repository with no branch is left alone', async () => {
  const node = aNode();
  for (let n = 1; n <= 3; n++) await node.backup(n);
  const tree = (await git.readCommit(node.repo, (await git.headOf(node.repo))!)).tree;
  const file = join(node.repo, 'objects', tree.slice(0, 2), tree.slice(2));
  writeFileSync(file, 'not a git object');
  const before = objectsIn(node.repo).length;
  assert.deepEqual(await git.trimRepo(node.repo, { keep: 1, graceMs: 0 }), { commits: 0, objects: 0, bytes: 0 });
  assert.equal(objectsIn(node.repo).length, before);
  // No branch: nothing is known to be kept, so nothing goes.
  const bare = join(tmp(), 'projects.git');
  await git.initRepo(bare);
  mkdirSync(join(bare, 'objects', 'ab'), { recursive: true });
  writeFileSync(join(bare, 'objects', 'ab', 'c'.repeat(38)), 'x');
  old(join(bare, 'objects', 'ab', 'c'.repeat(38)), 100);
  assert.deepEqual(await git.trimRepo(bare, { keep: 1, graceMs: 0 }), { commits: 0, objects: 0, bytes: 0 });
  assert.ok(existsSync(join(bare, 'objects', 'ab', 'c'.repeat(38))));
});

test('what a stopped send or a bring-back left goes after its time; anything else in those folders stays', async () => {
  const repo = join(tmp(), 'projects.git');
  const id = 'a'.repeat(40);
  const files = {
    stale: join(repo, 'incoming', `${id}.part`),
    live: join(repo, 'incoming', `${'b'.repeat(40)}.part`),
    other: join(repo, 'incoming', 'notes.txt'),
    outOld: join(repo, 'out', id),
    outPart: join(repo, 'out', `${'c'.repeat(40)}.part`),
    outNew: join(repo, 'out', 'd'.repeat(40)),
  };
  for (const f of Object.values(files)) {
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, 'x'.repeat(100));
  }
  old(files.stale, 25);
  old(files.other, 1000);
  old(files.outOld, 7);
  old(files.outPart, 7);
  old(files.outNew, 1);
  const r = await clearLeftovers(repo);
  assert.deepEqual(r, { files: 3, bytes: 300 });
  assert.ok(!existsSync(files.stale) && !existsSync(files.outOld) && !existsSync(files.outPart));
  assert.ok(existsSync(files.live) && existsSync(files.other) && existsSync(files.outNew));
  assert.deepEqual(await clearLeftovers(join(tmp(), 'nothing here')), { files: 0, bytes: 0 });
});

test('a junction in the store (an object folder, incoming, out, a PC folder or the objects folder) is never followed by a sweep', async t => {
  if (process.platform !== 'win32') return t.skip('junctions are a Windows thing');
  const root = tmp();
  // Outside the store: files named exactly as every sweep here removes, all old.
  const outside = join(root, 'not the store');
  mkdirSync(outside);
  const names = ['a'.repeat(38), `${'a'.repeat(38)}.1.tmp`, `${'b'.repeat(40)}.part`, 'c'.repeat(40)];
  for (const n of names) {
    writeFileSync(join(outside, n), 'must stay');
    old(join(outside, n), 24 * 60);
  }
  const junction = (link: string, target: string) => execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
  const node = aNode(root);
  for (let n = 1; n <= 3; n++) await node.backup(n);
  for (const sub of [join('objects', 'ab'), 'incoming', 'out']) {
    rmSync(join(node.repo, sub), { recursive: true, force: true });
    junction(join(node.repo, sub), outside);
  }
  // A second PC's folder that is a junction to a folder holding a whole repository of its own.
  const elsewhere = aNode(tmp(), 'cccc3333', 'Elsewhere');
  for (let n = 1; n <= 3; n++) await elsewhere.backup(n);
  for (const f of objectsIn(elsewhere.repo)) old(join(elsewhere.repo, 'objects', f.slice(0, 2), f.slice(2)), 24 * 60);
  const theirs = objectsIn(elsewhere.repo).length;
  junction(join(node.keptRoot, 'linked-elsewhere'), join(elsewhere.repo, '..'));
  await trimProjectStores(node.keptRoot, { keep: 1, graceMs: 0, cap: 1 });
  await clearLeftovers(node.repo, { incomingMs: 0, outMs: 0 });
  await git.trimRepo(node.repo, { keep: 1, graceMs: 0 });
  for (const n of names) assert.ok(existsSync(join(outside, n)), `${n} outside the store was removed`);
  assert.equal(objectsIn(elsewhere.repo).length, theirs, 'a repository reached through a junction was trimmed');
  // The objects folder itself a junction: nothing behind it goes either.
  const two = aNode(tmp(), 'dddd4444', 'Two');
  for (let n = 1; n <= 3; n++) await two.backup(n);
  const moved = join(tmp(), 'objects');
  execFileSync('cmd', ['/c', 'move', join(two.repo, 'objects'), moved], { stdio: 'ignore' });
  junction(join(two.repo, 'objects'), moved);
  const count = () => readdirSync(moved).filter(d => /^[0-9a-f]{2}$/.test(d)).flatMap(d => readdirSync(join(moved, d))).length;
  for (const d of readdirSync(moved)) for (const f of readdirSync(join(moved, d))) old(join(moved, d, f), 24 * 60);
  const had = count();
  await git.trimRepo(two.repo, { keep: 1, graceMs: 0 });
  assert.equal(count(), had);
});

test('the cap: the oldest backups across every PC go first, and each PC keeps its newest one even alone over the cap', () => {
  const store = (repo: string, ats: number[], need: number[]) => ({ repo, commits: ats.map((at, i) => ({ id: `${repo}${i}`, at })), need });
  const a = store('a', [100, 50, 10], [10, 15, 20]);
  const b = store('b', [90, 40], [10, 30]);
  assert.deepEqual([...capPlan([a, b], 100)], [], 'under the cap: nothing goes');
  // 50 in all; at 45 the oldest of all (a's at 10) goes; at 30 the next oldest (b's at 40) as well; at 20 a's at 50 too.
  assert.deepEqual([...capPlan([a, b], 45)], [['a', 'a1']]);
  assert.deepEqual([...capPlan([a, b], 30)], [['a', 'a1'], ['b', 'b0']]);
  assert.deepEqual([...capPlan([a, b], 20)], [['a', 'a0'], ['b', 'b0']]);
  assert.deepEqual([...capPlan([a, b], 0)], [['a', 'a0'], ['b', 'b0']], 'the newest of each stays');
  // Made in the same second: the one keeping more gives first.
  assert.deepEqual([...capPlan([store('c', [5, 5, 5], [10, 20, 30]), store('d', [5, 5], [10, 20])], 40)], [['c', 'c1']]);
  assert.equal(capFor(null), STORE_CAP);
  assert.equal(capFor(128 * 2 ** 30), Math.floor(12.8 * 2 ** 30));
  assert.equal(capFor(4000 * 2 ** 30), STORE_CAP);
});

test('the whole store: each PC cut to its newest backups, then the cap takes the oldest across them', async () => {
  const root = tmp();
  const laptop = aNode(root, 'aaaa1111', 'Laptop');
  const office = aNode(root, 'bbbb2222', 'Office PC');
  for (let n = 1; n <= 4; n++) {
    await laptop.backup(n);
    await office.backup(100 + n);
  }
  const need = async (repo: string) => (await needOf(repo, await git.logOf(repo, 10)))[1];
  // Room for about two backups of each PC: with three kept per PC, the cap takes one more of each.
  const cap = (await need(laptop.repo)) + (await need(office.repo));
  const r = await trimProjectStores(laptop.keptRoot, { keep: 3, cap, graceMs: 0 });
  assert.equal(r.repos, 2);
  assert.equal(r.commits, 4);
  for (const n of [laptop, office]) assert.equal(((await n.ask('/worker/git-log', {})).commits as unknown[]).length, 2);
  const total = (await needOf(laptop.repo, await git.logOf(laptop.repo, 10))).at(-1)! + (await needOf(office.repo, await git.logOf(office.repo, 10))).at(-1)!;
  assert.ok(total <= cap);
  // Nothing under the root but the repositories was touched; an empty root is no fault.
  assert.deepEqual(readdirSync(root).sort(), ['kept']);
  assert.deepEqual(await trimProjectStores(join(root, 'none')), { repos: 0, commits: 0, objects: 0, bytes: 0, leftovers: 0 });
});
