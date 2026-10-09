// Copies between linked PCs (src/carry.ts): what a node's owner allows, the network list, and whole copies both ways
// through the node's doors (a model, a split model, a restore point), cut short and carried on.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as carry from '../src/carry.ts';
import { openBytes, sealBytes } from '../src/link.ts';
import type { SharedModel } from '../src/nodestaff.ts';

// Every folder made here is taken away when this file's tests end (left behind, the copy tests' fake models filled
// 47 GB of the temp folder in three days).
const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-carry-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const MB = 2 ** 20;

const shared = (id: string, kind: 'chat' | 'image' = 'chat', name = id.replace(/\.gguf$/, '')): SharedModel => ({ id, name, kind, bytes: 5 * MB, ctx: 8192, loaded: false, busy: false });
const pc = (o: Partial<carry.NetPc> = {}): carry.NetPc => ({ id: 'aaaa1111', name: 'Worker PC', ok: true, away: null, can: ['models', 'carry'], allow: { pull: true, backup: true, push: true, update: false }, models: [], ...o });

test('what linked PCs may do: off until ticked, only true counts, Allow all is all four', () => {
  assert.deepEqual(carry.cleanAllow(undefined), carry.NO_ALLOW);
  assert.deepEqual(carry.cleanAllow({ pull: 'yes', backup: 1, push: true }), { pull: false, backup: false, push: true, update: false });
  assert.equal(carry.allowsAll({ pull: true, backup: true, push: true, update: true }), true);
  assert.equal(carry.allowsAll({ pull: true, backup: true, push: true, update: false }), false);
  assert.equal(carry.allowsAll({ pull: true, backup: false, push: true, update: false }), false);
});

test('names that may cross: a model file name or a backup name only, never a way out of the folder', () => {
  assert.equal(carry.safeModelFile('Qwen3.5-2B-Q4_K_M.gguf'), 'Qwen3.5-2B-Q4_K_M.gguf');
  for (const bad of ['../x.gguf', 'a/b.gguf', 'a\\b.gguf', 'x.exe', '.hidden.gguf', 'x..gguf', 7, '']) assert.equal(carry.safeModelFile(bad), null, String(bad));
  assert.equal(carry.safeBackupName('2026-10-06 101500 kept on Worker PC.zip'), '2026-10-06 101500 kept on Worker PC.zip');
  for (const bad of ['../a.zip', 'a/b.zip', 'a.zip.exe', 'x..zip']) assert.equal(carry.safeBackupName(bad), null, bad);
});

test('a split model is all its parts, in order; a part missing leaves just the first', () => {
  const names = ['big-00002-of-00003.gguf', 'big-00001-of-00003.gguf', 'big-00003-of-00003.gguf', 'other.gguf'];
  assert.deepEqual(carry.modelParts('big-00001-of-00003.gguf', names), ['big-00001-of-00003.gguf', 'big-00002-of-00003.gguf', 'big-00003-of-00003.gguf']);
  assert.deepEqual(carry.modelParts('big-00001-of-00003.gguf', names.slice(1)), ['big-00001-of-00003.gguf']);
  assert.deepEqual(carry.modelParts('other.gguf', names), ['other.gguf']);
});

test('the node network list: only shared models, once each, where each can be copied from, and why not', () => {
  const a = pc({ id: 'a', name: 'Worker PC', models: [shared('Qwen-2B.gguf'), shared('dreamshaper', 'image', 'DreamShaper 8')] });
  const b = pc({ id: 'b', name: 'Office', allow: { pull: false, backup: true, push: true, update: false }, models: [shared('lmstudio/x/qwen-2b.gguf', 'chat', 'Qwen-2B'), shared('ollama:qwen3:4b', 'chat', 'qwen3:4b')] });
  const c = pc({ id: 'c', name: 'Old one', can: ['models'], allow: null, models: [shared('Gemma.gguf')] });
  const d = pc({ id: 'd', name: 'Busy', away: '2026-10-06T10:00:00Z', models: [shared('Gemma.gguf')] });
  const rows = carry.networkList([a, b, c, d], { chatFiles: ['gemma.gguf'], pictures: [] });
  assert.deepEqual(rows.map(r => [r.kind, r.name, r.here]), [['chat', 'Gemma', true], ['chat', 'Qwen-2B', false], ['chat', 'qwen3:4b', false], ['image', 'DreamShaper 8', false]]);
  // The same file on two PCs is one row; the PC it can be copied from comes first.
  const qwen = rows.find(r => r.name === 'Qwen-2B')!;
  assert.deepEqual(qwen.on.map(o => [o.pcName, o.copy]), [['Worker PC', true], ['Office', false]]);
  assert.match(qwen.on[1].why, /use it, not copy it.*Sharing of models/);
  assert.match(rows.find(r => r.name === 'qwen3:4b')!.on[0].why, /Ollama/);
  const gemma = rows.find(r => r.name === 'Gemma')!;
  assert.match(gemma.on.find(o => o.pcName === 'Old one')!.why, /older TOMLIN/);
  assert.match(gemma.on.find(o => o.pcName === 'Busy')!.why, /being used by its owner/);
  assert.match(carry.copyWhy(pc({ ok: false }), 'x'), /off or not answering/);
});

test('send and keep-a-restore-point say why not, naming the tick on that PC', () => {
  assert.equal(carry.sendWhy(pc()), '');
  assert.match(carry.sendWhy(pc({ allow: { pull: true, backup: true, push: false, update: false } })), /Allow host to push models/);
  assert.equal(carry.backupWhy(pc()), '');
  assert.match(carry.backupWhy(pc({ allow: { pull: true, backup: false, push: true, update: false } })), /Enable backups/);
  assert.match(carry.backupWhy(pc({ allow: null })), /older/);
});

test('a piece sealed for the link opens only with its key and its place', () => {
  const key = randomBytes(32);
  const box = sealBytes(key, Buffer.from('piece'), 'piece|abc');
  assert.equal(openBytes(key, box, 'piece|abc')!.toString(), 'piece');
  assert.equal(openBytes(key, box, 'piece|abd'), null);
  assert.equal(openBytes(randomBytes(32), box, 'piece|abc'), null);
  const changed = Buffer.from(box);
  changed[20] ^= 1;
  assert.equal(openBytes(key, changed, 'piece|abc'), null);
});

/** A node with a models folder and a restore-point folder, and a wire to it as a linked PC sees it. */
function aNode(o: { allow?: carry.Allow; ticked?: string[]; free?: number } = {}) {
  const root = tmp();
  const chatDir = join(root, 'models', 'chat');
  mkdirSync(chatDir, { recursive: true });
  let allow = o.allow ?? { pull: true, backup: true, push: true, update: false };
  const installed: string[] = [];
  const handle = carry.nodeSide({
    allow: () => allow,
    ticked: () => o.ticked ?? readdirSync(chatDir).filter(n => n.endsWith('.gguf')),
    pcName: () => 'Worker PC',
    chatFiles: id => {
      const parts = carry.modelParts(id, readdirSync(chatDir));
      return existsSync(join(chatDir, id)) ? parts.map(name => ({ name, path: join(chatDir, name), bytes: readFileSync(join(chatDir, name)).length })) : null;
    },
    pictureFiles: () => null,
    chatDir,
    chatHas: name => existsSync(join(chatDir, name)),
    pictureDest: () => null,
    keptRoot: join(root, 'kept'),
    freeBytes: async () => o.free ?? Infinity,
    onInstalled: name => installed.push(name),
  });
  const wireAs = (who: { key: string; name: string }, hooks: { beforePut?: (n: number) => void } = {}): carry.Wire => {
    let puts = 0;
    const json = (a: carry.NodeAnswer) => {
      if (!('json' in a)) throw new Error('a piece came where words were expected');
      if (a.status !== 200 && !(a.status === 409 && typeof a.json.at === 'number')) throw new Error(String(a.json.error));
      return a.json;
    };
    return {
      ask: async (p, b) => json(await handle(p, b, who)),
      getPiece: async (p, b) => {
        const a = await handle(p, b, who);
        if (!('piece' in a)) throw new Error(String(a.json.error));
        return a.piece;
      },
      putPiece: async (p, b, piece) => {
        hooks.beforePut?.(++puts);
        return json(await handle(p, b, who, piece));
      },
    };
  };
  return { root, chatDir, handle, wireAs, installed, setAllow: (a: carry.Allow) => void (allow = a) };
}

const laptop = { key: 'b1b2b3b4', name: 'Laptop' };
const fileOf = (dir: string, name: string, bytes: number) => {
  const data = randomBytes(bytes);
  writeFileSync(join(dir, name), data);
  return data;
};

test('copying a shared model: 40 MB comes over in 16 MB pieces, whole; cut short, it carries on from where it stopped', async () => {
  const node = aNode();
  const data = fileOf(node.chatDir, 'Qwen-2B.gguf', 40 * MB + 123);
  const here = tmp();
  const dest = async (files: { name: string; bytes: number }[]) => files.map(f => join(here, f.name));
  const seen: number[] = [];
  await carry.pull(node.wireAs(laptop), { kind: 'chat', model: 'Qwen-2B.gguf', dest, progress: p => seen.push(p.done), signal: new AbortController().signal });
  assert.ok(readFileSync(join(here, 'Qwen-2B.gguf')).equals(data));
  assert.deepEqual(seen, [0, 16 * MB, 32 * MB, 40 * MB + 123]);
  assert.equal(existsSync(join(here, 'Qwen-2B.gguf.part')), false);

  // A copy that stopped after 16 MB: only the rest is asked for.
  const again = tmp();
  writeFileSync(join(again, 'Qwen-2B.gguf.part'), data.subarray(0, 16 * MB));
  const asked: number[] = [];
  const w = node.wireAs(laptop);
  const counting: carry.Wire = { ...w, getPiece: (p, b) => (asked.push(Number(b.from)), w.getPiece(p, b)) };
  await carry.pull(counting, { kind: 'chat', model: 'Qwen-2B.gguf', dest: async files => files.map(f => join(again, f.name)), progress: () => undefined, signal: new AbortController().signal });
  assert.deepEqual(asked, [16 * MB, 32 * MB]);
  assert.ok(readFileSync(join(again, 'Qwen-2B.gguf')).equals(data));
});

test('copying is refused when the node does not allow it, or the model is not shared', async () => {
  const node = aNode({ allow: { pull: false, backup: true, push: true, update: false } });
  fileOf(node.chatDir, 'A.gguf', 1000);
  const dest = async () => [join(tmp(), 'A.gguf')];
  const go = (model: string, n = node) => carry.pull(n.wireAs(laptop), { kind: 'chat', model, dest, progress: () => undefined, signal: new AbortController().signal });
  await assert.rejects(go('A.gguf'), /does not let other PCs copy its models.*Sharing of models/);
  const n2 = aNode({ ticked: [] });
  fileOf(n2.chatDir, 'A.gguf', 1000);
  await assert.rejects(go('A.gguf', n2), /does not share that model/);
  // A piece of a model asked for directly is refused the same way.
  const a = await node.handle('/worker/carry-get', { kind: 'chat', model: 'A.gguf', file: 0, from: 0 }, laptop);
  assert.equal(a.status, 403);
});

test('sending a model: installed in the node\'s chat folder; there already, nothing is sent; a split model goes in all its parts', async () => {
  const node = aNode();
  const mine = tmp();
  const data = fileOf(mine, 'Gemma.gguf', 20 * MB);
  const files = [{ name: 'Gemma.gguf', path: join(mine, 'Gemma.gguf'), bytes: data.length }];
  const go = (f = files, model = 'Gemma.gguf') => carry.push(node.wireAs(laptop), { kind: 'chat', model, name: 'Gemma', files: f, progress: () => undefined, signal: new AbortController().signal });
  assert.equal(await go(), true);
  assert.ok(readFileSync(join(node.chatDir, 'Gemma.gguf')).equals(data));
  assert.deepEqual(node.installed, ['Gemma']);
  assert.equal(await go(), false);

  const parts = ['big-00001-of-00002.gguf', 'big-00002-of-00002.gguf'].map(name => ({ name, data: fileOf(mine, name, 3 * MB + 7) }));
  assert.equal(await go(parts.map(p => ({ name: p.name, path: join(mine, p.name), bytes: p.data.length })), 'big-00001-of-00002.gguf'), true);
  for (const p of parts) assert.ok(readFileSync(join(node.chatDir, p.name)).equals(p.data));
});

test('sending: refused without the tick, a bad file name, or no room; a piece crossing twice is carried on from, not doubled', async () => {
  const mine = tmp();
  const data = fileOf(mine, 'Gemma.gguf', 33 * MB);
  const files = [{ name: 'Gemma.gguf', path: join(mine, 'Gemma.gguf'), bytes: data.length }];
  const go = (n: ReturnType<typeof aNode>, f = files, w = n.wireAs(laptop)) => carry.push(w, { kind: 'chat', model: 'Gemma.gguf', name: 'Gemma', files: f, progress: () => undefined, signal: new AbortController().signal });
  await assert.rejects(go(aNode({ allow: { pull: true, backup: true, push: false, update: false } })), /Allow host to push models/);
  await assert.rejects(go(aNode(), [{ ...files[0], name: '../evil.gguf' }]), /not named as a model file/);
  await assert.rejects(go(aNode({ free: 10 * MB })), /not enough room on "Worker PC"/);

  // The answer to the second piece is lost and the piece is sent again: the node says where it is, and the copy goes on.
  const node = aNode();
  const w = node.wireAs(laptop);
  let resent = false;
  const twice: carry.Wire = {
    ...w,
    putPiece: async (p, b, piece) => {
      const r = await w.putPiece(p, b, piece);
      if (Number(b.from) === 16 * MB && !resent) {
        resent = true;
        const again = await w.putPiece(p, b, piece);
        assert.equal(again.at, 32 * MB);
        assert.match(String(again.error), /out of place/);
      }
      return r;
    },
  };
  assert.equal(await go(node, files, twice), true);
  assert.ok(readFileSync(join(node.chatDir, 'Gemma.gguf')).equals(data));
});

test('a send that is stopped leaves no half file on the node; another PC cannot write the same file meanwhile', async () => {
  const node = aNode();
  const mine = tmp();
  const data = fileOf(mine, 'Gemma.gguf', 40 * MB);
  const files = [{ name: 'Gemma.gguf', path: join(mine, 'Gemma.gguf'), bytes: data.length }];
  const ac = new AbortController();
  const p = carry.push(node.wireAs(laptop, { beforePut: n => { if (n === 2) ac.abort(); } }), { kind: 'chat', model: 'Gemma.gguf', name: 'Gemma', files, progress: () => undefined, signal: ac.signal });
  // The second piece was already on its way when Stop was pressed: it lands, then the loop stops and the part goes.
  await assert.rejects(p, /Stopped/);
  assert.equal(existsSync(join(node.chatDir, 'Gemma.gguf.part')), false);
  assert.equal(existsSync(join(node.chatDir, 'Gemma.gguf')), false);

  const piece = data.subarray(0, 16 * MB);
  const ask = { kind: 'chat', model: 'Gemma.gguf', name: 'Gemma', files: [{ name: 'Gemma.gguf', bytes: data.length }], file: 0 };
  assert.equal((await node.handle('/worker/carry-put', { ...ask, from: 0 }, laptop, piece)).status, 200);
  const other = await node.handle('/worker/carry-put', { ...ask, from: 16 * MB }, { key: 'c1c2c3c4', name: 'Office' }, piece);
  assert.equal(other.status, 409);
  assert.match(String((other as { json: Record<string, unknown> }).json.error), /another PC is sending/);
});

test('restore points: kept per linked PC (newest 3), listed and brought back even after the tick is taken off, never another PC\'s', async () => {
  const node = aNode();
  const mine = tmp();
  const w = node.wireAs(laptop);
  const made: Buffer[] = [];
  for (const k of [1, 2, 3, 4]) {
    const name = `2026-10-0${k} 101500 kept on Worker PC.zip`;
    made.push(fileOf(mine, name, 17 * MB + k));
    await carry.pushBackup(w, { file: join(mine, name), name, progress: () => undefined, signal: new AbortController().signal });
  }
  const list = (await w.ask('/worker/backup-list', {})).backups as carry.Kept[];
  assert.deepEqual(list.map(x => x.name.slice(0, 10)), ['2026-10-04', '2026-10-03', '2026-10-02']);
  assert.deepEqual(await carry.keptHere(join(node.root, 'kept')), [{ name: 'Laptop', count: 3, bytes: list.reduce((n, x) => n + x.bytes, 0), newest: Math.max(...list.map(x => x.at)) }]);

  node.setAllow({ pull: false, backup: false, push: false, update: false });
  const back = tmp();
  await carry.pullBackup(w, { name: list[0].name, bytes: list[0].bytes, dest: join(back, list[0].name), progress: () => undefined, signal: new AbortController().signal });
  assert.ok(readFileSync(join(back, list[0].name)).equals(made[3]));
  await assert.rejects(carry.pushBackup(w, { file: join(mine, list[0].name), name: list[0].name, progress: () => undefined, signal: new AbortController().signal }), /does not keep restore points.*Enable backups/);

  // Another linked PC sees none of them, and cannot fetch one by name.
  const office = node.wireAs({ key: 'c1c2c3c4', name: 'Office' });
  assert.deepEqual((await office.ask('/worker/backup-list', {})).backups, []);
  await assert.rejects(office.getPiece('/worker/backup-get', { name: list[0].name, from: 0 }), /not kept on "Worker PC"/);
});

test('a restore point cut short on its way to the node is thrown away when the next one starts', async () => {
  const node = aNode();
  const mine = tmp();
  const w = node.wireAs(laptop);
  const first = '2026-10-05 101500 kept on Worker PC.zip';
  fileOf(mine, first, 20 * MB);
  const ac = new AbortController();
  const cut: carry.Wire = { ...w, putPiece: async (p, b, piece) => { const r = await w.putPiece(p, b, piece); ac.abort(); return r; } };
  await assert.rejects(carry.pushBackup(cut, { file: join(mine, first), name: first, progress: () => undefined, signal: ac.signal }), /Stopped/);
  const dir = carry.keptFolder(join(node.root, 'kept'), laptop.key);
  assert.ok(existsSync(join(dir, `${first}.part`)));
  const next = '2026-10-06 101500 kept on Worker PC.zip';
  fileOf(mine, next, 3 * MB);
  await carry.pushBackup(w, { file: join(mine, next), name: next, progress: () => undefined, signal: new AbortController().signal });
  assert.deepEqual(readdirSync(dir).sort(), [next, 'pc.json']);
});

test('a restore point brought back after a cut carries on; a part too long for it is thrown away', async () => {
  const node = aNode();
  const mine = tmp();
  const name = '2026-10-06 101500 kept on Worker PC.zip';
  const data = fileOf(mine, name, 20 * MB);
  const w = node.wireAs(laptop);
  await carry.pushBackup(w, { file: join(mine, name), name, progress: () => undefined, signal: new AbortController().signal });
  const back = tmp();
  writeFileSync(join(back, `${name}.part`), data.subarray(0, 16 * MB));
  await carry.pullBackup(w, { name, bytes: data.length, dest: join(back, name), progress: () => undefined, signal: new AbortController().signal });
  assert.ok(readFileSync(join(back, name)).equals(data));
  // A part longer than the file (left from something else) is thrown away and the copy starts again.
  const odd = tmp();
  writeFileSync(join(odd, `${name}.part`), randomBytes(data.length + 5));
  await carry.pullBackup(w, { name, bytes: data.length, dest: join(odd, name), progress: () => undefined, signal: new AbortController().signal });
  assert.ok(readFileSync(join(odd, name)).equals(data));
});

test('copies on this PC: one at a time per linked PC; Stop ends it as stopped, with the way on', async () => {
  const t = new carry.Transfers();
  let release!: () => void;
  const first = t.start({ kind: 'copy', what: 'Qwen', pc: 'a', pcName: 'Worker PC' }, (progress, signal) => new Promise((resolve, reject) => {
    progress({ done: 5, bytes: 10 });
    signal.addEventListener('abort', () => reject(new Error('Stopped.')));
    release = () => resolve('done');
  }));
  assert.ok(!('error' in first));
  const second = t.start({ kind: 'send', what: 'Gemma', pc: 'a', pcName: 'Worker PC' }, async () => 'x');
  assert.match((second as { error: string }).error, /busy with "Qwen"/);
  const other = t.start({ kind: 'send', what: 'Gemma', pc: 'b', pcName: 'Office' }, async () => 'sent');
  assert.ok(!('error' in other));
  assert.equal(t.view().find(x => x.what === 'Qwen')!.done, 5);
  assert.equal(t.stop((first as carry.Transfer).id), true);
  await new Promise(r => setTimeout(r, 10));
  const v = t.view();
  assert.equal(v.find(x => x.what === 'Qwen')!.state, 'stopped');
  assert.match(v.find(x => x.what === 'Qwen')!.said, /carry on/);
  // A send that is stopped is cleared on that PC: it says so, and does not promise to carry on.
  assert.match(carry.Transfers.stopped('send', 'Worker PC'), /Nothing half-sent is left on "Worker PC"/);
  assert.doesNotMatch(carry.Transfers.stopped('send', 'Worker PC'), /carry on/);
  assert.equal(v.find(x => x.pc === 'b')!.state, 'done');
  release();
});

test('room: a copy that would leave less than 2 GB free is refused, in plain words', () => {
  assert.equal(carry.roomWhy(1 * 2 ** 30, 10 * 2 ** 30, 'this PC'), null);
  assert.match(carry.roomWhy(9 * 2 ** 30, 10 * 2 ** 30, 'this PC')!, /not enough room on this PC: it needs 9.0 GB and 10 GB is free/);
});

test('backup order: Backups only PCs first, then by name and address (two PCs with one name keep their places)', () => {
  const pcs = [
    { name: 'Worker PC', where: '192.168.0.40' },
    { name: 'Worker PC', where: '192.168.0.33' },
    { name: 'Storage box', where: '192.168.0.50', backupsOnly: true },
    { name: 'Alpha', where: '192.168.0.9' },
  ];
  assert.deepEqual(carry.backupOrder(pcs).map(p => p.where), ['192.168.0.50', '192.168.0.9', '192.168.0.33', '192.168.0.40']);
  assert.equal(pcs[0].where, '192.168.0.40', 'the list given is not changed');
});

test('a backup disk: read from this PC, and cleaned when a hello says it', async () => {
  const here = await carry.diskOf(join(tmpdir(), 'no-such-folder-' + randomBytes(4).toString('hex'), 'deeper'));
  assert.ok(here && here.total > 0 && here.free >= 0 && here.free <= here.total, 'a folder not made yet reads its nearest parent');
  assert.deepEqual(carry.cleanDisk({ total: 1000.4, free: 250 }), { total: 1000, free: 250 });
  for (const bad of [null, {}, { total: 0, free: 0 }, { total: 10, free: 20 }, { total: 'x', free: 1 }, { total: 10, free: -1 }]) assert.equal(carry.cleanDisk(bad), null);
});
