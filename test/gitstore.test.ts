// Project backups kept on a node as a git repository (src/gitstore.ts and the node's /worker/git-* doors in
// src/carry.ts): ids as git makes them, only missing files cross, one commit a backup, nothing new when nothing
// changed, a file changed on the way refused, and the repository valid for git itself.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '../src/gitstore.ts';
import * as carry from '../src/carry.ts';

// Every folder made here is taken away when this file's tests end (left behind, the copy tests' fake models filled
// 47 GB of the temp folder in three days).
const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-git-'));
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

test('a blob id is git\'s own (the same as git hash-object)', async () => {
  // The well-known id of an empty file, and of "hello\n".
  assert.equal(git.blobId(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(git.blobId(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  const dir = tmp();
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  assert.deepEqual(await git.blobIdOfFile(join(dir, 'a.txt')), { id: 'ce013625030ba8dba906f756967f9e9ca394464a', bytes: 6 });
});

test('paths that may cross: forward slashes inside the workspace only', () => {
  assert.equal(git.safePath('Harbor Bakery/notes/a b.md'), 'Harbor Bakery/notes/a b.md');
  for (const bad of ['../x', 'a/../b', '/a', 'a//b', 'a\\b', '.git/config', 'a/.GIT/x', 'c:/x', 'a/b.', 'a/b ', '', 7]) assert.equal(git.safePath(bad), null, String(bad));
});

test('a workspace walk leaves out .git and node_modules, and its signature changes with a file', async () => {
  const root = tmp();
  mkdirSync(join(root, 'p', '.git'), { recursive: true });
  mkdirSync(join(root, 'p', 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'p', 'a.md'), 'one');
  writeFileSync(join(root, 'p', '.git', 'HEAD'), 'x');
  writeFileSync(join(root, 'p', 'node_modules', 'x', 'i.js'), 'x');
  const one = await git.workFiles(root);
  assert.deepEqual(one.files.map(f => f.path), ['p/a.md']);
  writeFileSync(join(root, 'p', 'b.md'), 'two');
  assert.notEqual(git.signature((await git.workFiles(root)).files), git.signature(one.files));
});

/** A node's doors for one host, as the host reaches them. */
function aNode(allow = { pull: false, backup: true, push: false, update: false }) {
  const root = tmp();
  let now = allow;
  const handle = carry.nodeSide({
    allow: () => now,
    ticked: () => [],
    pcName: () => 'Worker PC',
    chatFiles: () => null,
    pictureFiles: () => null,
    chatDir: join(root, 'models'),
    chatHas: () => false,
    pictureDest: () => null,
    keptRoot: join(root, 'kept'),
    freeBytes: async () => Infinity,
  });
  const who = { key: 'b1b2b3b4', name: 'Laptop' };
  const ask = async (p: string, b: Record<string, unknown>) => {
    const a = await handle(p, b, who);
    if (!('json' in a)) throw new Error('a piece came where words were expected');
    if (a.status !== 200) throw new Error(String(a.json.error));
    return a.json;
  };
  const put = async (id: string, data: Buffer, piece = 6) => {
    for (let at = 0; ;) {
      const a = await handle('/worker/git-put', { id, bytes: data.length, from: at }, who, data.subarray(at, at + piece));
      if (!('json' in a) || a.status !== 200) throw new Error('json' in a ? String(a.json.error) : 'piece');
      if (a.json.done === true) return;
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
  return { root, repo: carry.projectsRepo(join(root, 'kept'), who.key), ask, put, get, handle, who, setAllow: (a: typeof allow) => void (now = a) };
}

test('a backup: only missing files cross (in pieces), one commit, nothing new when nothing changed, and they come back the same', async () => {
  const node = aNode();
  const files = { 'Harbor Bakery/post.md': Buffer.from('# Bread\nWhy people bake.\n'), 'Harbor Bakery/photo.bin': randomBytes(50), 'Garden/notes.txt': Buffer.alloc(0), 'Garden/copy.md': Buffer.from('# Bread\nWhy people bake.\n') };
  const list = Object.entries(files).map(([path, data]) => ({ path, id: git.blobId(data), data }));
  const ids = [...new Set(list.map(f => f.id))];
  assert.deepEqual((await node.ask('/worker/git-have', { ids })).missing, ids);
  for (const id of ids) await node.put(id, list.find(f => f.id === id)!.data);
  assert.deepEqual((await node.ask('/worker/git-have', { ids })).missing, []);
  const first = await node.ask('/worker/git-commit', { files: list.map(({ path, id }) => ({ path, id })), message: 'Projects backed up' });
  assert.equal(first.same, false);
  const again = await node.ask('/worker/git-commit', { files: list.map(({ path, id }) => ({ path, id })), message: 'Projects backed up' });
  assert.deepEqual(again, { id: first.id, same: true });
  // A changed file: one new file crosses, a second commit, the first one kept.
  const changed = Buffer.from('# Bread\nAnd cake.\n');
  assert.deepEqual((await node.ask('/worker/git-have', { ids: [git.blobId(changed), ...ids] })).missing, [git.blobId(changed)]);
  await node.put(git.blobId(changed), changed);
  list[0] = { ...list[0], id: git.blobId(changed), data: changed };
  const second = await node.ask('/worker/git-commit', { files: list.map(({ path, id }) => ({ path, id })), message: 'Projects backed up' });
  assert.equal(second.same, false);
  const log = await node.ask('/worker/git-log', {});
  assert.deepEqual((log.commits as { id: string }[]).map(c => c.id), [second.id, first.id]);
  // Brought back: the newest backup's files, each the same bytes.
  const back = await node.ask('/worker/git-files', {});
  const got = back.files as { path: string; id: string; bytes: number }[];
  assert.deepEqual(got.map(f => f.path).sort(), Object.keys(files).sort());
  for (const f of got) {
    const want = list.find(x => x.path === f.path)!.data;
    assert.equal(f.bytes, want.length, f.path);
    assert.ok((await node.get(f.id)).equals(want), f.path);
  }
  // The older backup is still there.
  const old = await node.ask('/worker/git-files', { commit: first.id });
  assert.equal((old.files as { id: string }[]).find(f => f.id === git.blobId(files['Harbor Bakery/post.md'])) !== undefined, true);
  // The node's own page lists it, and its owner can take the projects out without the host.
  const here = await carry.projectsHere(join(node.root, 'kept'));
  assert.deepEqual(here.map(h => ({ name: h.name, files: h.files, backups: h.backups })), [{ name: 'Laptop', files: 4, backups: 2 }]);
  const out = join(node.root, 'out');
  assert.equal(await carry.projectsOut(join(node.root, 'kept'), here[0].key, out), 4);
  assert.ok(readFileSync(join(out, 'Harbor Bakery', 'post.md')).equals(changed));
  assert.equal(readFileSync(join(out, 'Garden', 'notes.txt')).length, 0);
  if (hasGit) {
    // git itself finds the repository whole, and reads the same history.
    execFileSync('git', ['--git-dir', node.repo, 'fsck', '--full', '--strict'], { stdio: 'pipe' });
    const logged = execFileSync('git', ['--git-dir', node.repo, 'log', '--format=%H %an'], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(logged, [`${second.id} TOMLIN`, `${first.id} TOMLIN`]);
    assert.equal(execFileSync('git', ['--git-dir', node.repo, 'show', `${first.id}:Harbor Bakery/post.md`], { encoding: 'utf8' }), files['Harbor Bakery/post.md'].toString());
  }
});

test('a file changed on the way is not kept; a commit naming a file not sent is refused; backups off refuses new ones but lists old', async () => {
  const node = aNode();
  const data = Buffer.from('the real contents');
  await assert.rejects(node.put(git.blobId(data), Buffer.from('other contents!!!')), /changed on the way/);
  assert.deepEqual((await node.ask('/worker/git-have', { ids: [git.blobId(data)] })).missing, [git.blobId(data)]);
  await assert.rejects(node.ask('/worker/git-commit', { files: [{ path: 'a.md', id: git.blobId(data) }] }), /missing here/);
  await assert.rejects(node.ask('/worker/git-commit', { files: [{ path: '../a.md', id: git.blobId(data) }] }), /not named as one/);
  await node.put(git.blobId(data), data);
  await node.ask('/worker/git-commit', { files: [{ path: 'a.md', id: git.blobId(data) }] });
  node.setAllow({ pull: false, backup: false, push: false, update: false });
  await assert.rejects(node.ask('/worker/git-have', { ids: [git.blobId(data)] }), /Enable backups/);
  assert.equal(((await node.ask('/worker/git-log', {})).commits as unknown[]).length, 1);
});

test('the reason a host cannot back its projects up names the tick, or an update for an older node', () => {
  const pc = (o: Partial<carry.NetPc> = {}): carry.NetPc => ({ id: 'aaaa1111', name: 'Worker PC', ok: true, away: null, can: ['carry', 'git'], allow: { pull: false, backup: true, push: false, update: false }, models: [], ...o });
  assert.equal(carry.projectsWhy(pc()), '');
  assert.match(carry.projectsWhy(pc({ can: ['carry'] })), /older TOMLIN/);
  assert.match(carry.projectsWhy(pc({ allow: { pull: false, backup: false, push: false, update: false } })), /Enable backups/);
  assert.match(carry.projectsWhy(pc({ ok: false })), /off/);
});
