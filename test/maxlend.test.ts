import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as carry from '../src/carry.ts';
import { alive } from '../src/hardware.ts';
import { createServer } from 'node:net';
import * as maxlend from '../src/maxlend.ts';
import { cleanLendIdle, DEFAULT_LEND_IDLE, Lender, lendWhy, loanEnds, nobodyThere, ownerBack, presenceOf, presenceWords, PresenceReader, reachRpc, rpcArgs, type RpcProgram } from '../src/maxlend.ts';
import { chatArgs, maxFault, whyItFailed } from '../src/llama.ts';

const ALL = { pull: true, backup: true, update: true, tune: true, lend: true, receive: true, give: true, off: true };
const LEND = { ...carry.NO_ALLOW, lend: true, receive: true };
const min = 60_000;
const base = { pc: 'Worker PC', on: true, allow: LEND, away: false, presence: { idleMs: 10 * min, locked: false }, idleMinutes: 5, lease: null, by: { hash: 'a' } };
const SRC = pathToFileURL(join(import.meta.dirname, '..', 'src', 'maxlend.ts')).href;
/** A stand-in for ggml-rpc-server: a plain echo server on the port it is given. */
const standIn = (port: number) => spawn(process.execPath, ['-e', `require('net').createServer(s => s.pipe(s)).listen(${port}, '127.0.0.1')`], { stdio: 'ignore', windowsHide: true });
const PROGRAM: RpcProgram = { exe: 'ggml-rpc-server.exe', device: 'cpu', threads: 0 };

test('the RPC server refusing for a moment is tried again; nothing there, or nobody waiting, gives up', async () => {
  const server = createServer(s => s.on('error', () => undefined));
  const port = await new Promise<number>(r => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
  await new Promise(r => server.close(r));
  try {
    // Refused at first (a server busy with the last connection), then it takes the next one.
    const late = setTimeout(() => server.listen(port, '127.0.0.1'), 150);
    const rpc = await reachRpc(port, () => false, 50);
    clearTimeout(late);
    assert.ok(rpc, 'reached once it listens');
    rpc.destroy();
  } finally {
    await new Promise(r => server.close(r));
  }
  // Nothing listening: every try is refused, and it says so rather than hang.
  assert.equal(await reachRpc(port, () => false, 1), null);
  // The asker has gone: not one try.
  let tries = 0;
  assert.equal(await reachRpc(port, () => (tries++, true)), null);
  assert.equal(tries, 1);
});

test('the Max mode tick is its own, and Allow all covers it', () => {
  assert.equal(carry.cleanAllow({ lend: 'yes' }).lend, false);
  assert.equal(carry.cleanAllow({ lend: true, receive: true }).lend, true);
  assert.equal(carry.allowsAll(ALL), true);
  // A node that had "Allow all" before this tick: Allow all shows unticked until it is ticked too.
  assert.equal(carry.allowsAll({ ...ALL, lend: false, receive: false }), false);
});

test('how long nobody must use the PC: 5 minutes unless its owner picked another of the choices', () => {
  assert.equal(DEFAULT_LEND_IDLE, 5);
  assert.equal(cleanLendIdle(undefined), 5);
  assert.equal(cleanLendIdle(10), 10);
  assert.equal(cleanLendIdle('30'), 30);
  assert.equal(cleanLendIdle(3), 5, 'not one of the choices');
  assert.equal(cleanLendIdle(0), 5);
});

test('it lends only while nobody uses it: Windows locked, or idle for the minutes chosen', () => {
  assert.equal(lendWhy(base), '');
  assert.equal(lendWhy({ ...base, presence: { idleMs: 4 * min, locked: false } }).includes('someone is using "Worker PC" (last used 4 min ago)'), true);
  assert.match(lendWhy({ ...base, presence: { idleMs: 4 * min, locked: false } }), /after 5 minutes with nobody using it/);
  assert.equal(lendWhy({ ...base, presence: { idleMs: 2_000, locked: true } }), '', 'locked: at once');
  assert.equal(lendWhy({ ...base, idleMinutes: 15 }) !== '', true, '10 minutes is not 15');
  assert.ok(nobodyThere({ idleMs: 5 * min, locked: false }, 5));
});

test('it refuses with the reason and where to change it', () => {
  assert.match(lendWhy({ ...base, on: false }), /not a node/);
  assert.match(lendWhy({ ...base, allow: carry.NO_ALLOW }), /ticks "Allow to be used as part of a cluster" there \(Network, Sharing and cluster permissions\)/);
  assert.match(lendWhy({ ...base, away: true }), /I need to use the pc/);
  assert.match(lendWhy({ ...base, presence: null }), /could not tell whether someone is using it/);
});

test('one PC borrows at a time: another is told who has it; the same one may open more streams', async () => {
  const lease = { hash: 'a', name: 'Office PC', since: new Date().toISOString() };
  assert.match(lendWhy({ ...base, lease, by: { hash: 'b' } }), /lending its card memory to "Office PC" now\. One PC borrows it at a time/);
  assert.equal(lendWhy({ ...base, lease, by: { hash: 'a' } }), '');
  const l = new Lender(tmpdir(), () => '');
  l.lease = lease;
  await assert.rejects(l.open({ hash: 'b', name: 'Laptop' }, null), /lending to "Office PC"/);
  await assert.rejects(l.open({ hash: 'a', name: 'Office PC' }, null), /RPC server is missing/);
});

test('The cluster tick (Max mode, once Lend card memory) is an ordinary permission on every PC (no TOMLIN_MAX needed): cleanAllow keeps the tick, lendWhy asks only the usual things', () => {
  assert.equal(carry.cleanAllow({ ...ALL }).lend, true);
  assert.equal(carry.cleanAllow({ ...ALL, lend: false }).lend, false);
  assert.equal(carry.cleanAllow({}).lend, false, 'off by default');
  assert.equal(lendWhy({ ...base }), '');
  assert.match(lendWhy({ ...base, allow: { ...LEND, lend: false } }), /ticks "Allow to be used as part of a cluster"/);
  assert.match(lendWhy({ ...base, presence: { idleMs: 1000, locked: false } }), /someone is using "Worker PC"/, 'still only while nobody uses the PC');
});

test('the page always shows the Lend tick and its Help line, and Allow all ticks it', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<input type="checkbox" id="allow-lend" data-allow="lend"/);
  // The tick serves both: Cluster (a model that will not fit one PC) and a chat's Max switch (a model that fits).
  assert.match(readFileSync(join(import.meta.dirname, '..', 'public', 'help', 'sharing-permissions.html'), 'utf8'), /<b>Allow to be used as part of a cluster<\/b> \(it serves both: Cluster, for a model that will not fit on one PC, and Max mode, a chat's <b>Max<\/b> switch, for a model that does fit/);
  assert.doesNotMatch(html, /data-max/);
  assert.doesNotMatch(html, /ticks all five/);
  const js = readFileSync(join(import.meta.dirname, '..', 'public', 'home.js'), 'utf8');
  assert.match(js, /lend: e\.target\.checked \}/, 'Allow all ticks Lend');
  assert.doesNotMatch(js, /maxShown|data-max/);
});

test('a loan ends when the link to the PC borrowing it is removed', () => {
  const lease = { hash: 'a', name: 'Office PC', since: new Date().toISOString() };
  const on = { on: true, allow: LEND, away: false, presence: { idleMs: 10 * min, locked: false }, lease, paired: [{ hash: 'b' }, { hash: 'a' }] };
  assert.equal(loanEnds(on), '');
  assert.equal(loanEnds({ ...on, paired: [{ hash: 'b' }] }), 'the link to "Office PC" was removed');
  assert.equal(loanEnds({ ...on, lease: null, paired: [] }), '', 'no loan: nothing to end');
});

test('a loan ended while its RPC server is still starting stays ended: nothing is left lending', async () => {
  let spawned = 0;
  class T extends Lender {
    protected spawnRpc(_p: RpcProgram, port: number) {
      spawned++;
      return standIn(port);
    }
  }
  const l = new T(tmpdir(), () => '');
  const opening = l.open({ hash: 'a', name: 'Office PC' }, PROGRAM);
  // Sharing turned off at once, before the server is even started.
  await l.end('sharing was turned off there');
  await assert.rejects(opening, /the loan ended as it started/);
  assert.equal(spawned, 0, 'no RPC server was started');
  assert.equal(l.lease, null);
  assert.equal(l.pid, null);
});

test('TOMLIN ending (its window closed, Quit) ends the RPC server and the presence reader with it', { skip: process.platform !== 'win32' && 'the presence reader is Windows only' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-lendexit-'));
  try {
    const script = join(dir, 'lend.mjs');
    writeFileSync(script, `import { spawn } from 'node:child_process';
import { Lender, PresenceReader } from ${JSON.stringify(SRC)};
class T extends Lender {
  spawnRpc(_p, port) { return spawn(process.execPath, ['-e', \`require('net').createServer(s => s.pipe(s)).listen(\${port}, '127.0.0.1')\`], { stdio: 'ignore', windowsHide: true }); }
}
const l = new T(${JSON.stringify(dir)}, () => '');
await l.open({ hash: 'a', name: 'Office PC' }, { exe: 'x', device: 'cpu', threads: 0 });
const r = new PresenceReader();
r.now();
console.log(JSON.stringify({ rpc: l.pid, presence: r.pid }));
process.exit(0);
`);
    const said = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 60_000 }).trim().split('\n').pop()!) as { rpc: number; presence: number };
    assert.ok(said.rpc && said.presence, JSON.stringify(said));
    for (let t = 0; t < 50 && (alive(said.rpc) || alive(said.presence)); t++) await new Promise(r => setTimeout(r, 100));
    assert.equal(alive(said.rpc), false, 'the RPC server was ended with TOMLIN');
    assert.equal(alive(said.presence), false, 'the presence reader was ended with TOMLIN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a loan ends when someone comes back, presses "I need to use the pc", or the tick or sharing goes off', () => {
  const on = { on: true, allow: LEND, away: false, presence: { idleMs: 10 * min, locked: false }, lease: null, paired: [] };
  assert.equal(loanEnds(on), '');
  assert.equal(loanEnds({ ...on, presence: { idleMs: 800, locked: false } }), 'someone started using it');
  // A mouse moved at the lock screen is not someone back at the PC.
  assert.equal(loanEnds({ ...on, presence: { idleMs: 800, locked: true } }), '');
  assert.equal(loanEnds({ ...on, presence: null }), '', 'a missed reading does not end it');
  assert.match(loanEnds({ ...on, away: true }), /I need to use the pc/);
  assert.match(loanEnds({ ...on, allow: carry.NO_ALLOW }), /took the Max mode tick off/);
  assert.match(loanEnds({ ...on, on: false }), /sharing was turned off/);
  assert.equal(ownerBack({ idleMs: 4_999, locked: false }), true);
  assert.equal(ownerBack({ idleMs: 5_000, locked: false }), false);
});

test('the presence reader\'s lines', () => {
  assert.deepEqual(presenceOf('61234 0'), { idleMs: 61234, locked: false });
  assert.deepEqual(presenceOf('12 1\r'), { idleMs: 12, locked: true });
  assert.equal(presenceOf('Add-Type: error'), null);
  assert.equal(presenceOf(''), null);
});

test('the RPC server listens on this PC only; threads only for a CPU lend; the cache only when asked', () => {
  assert.deepEqual(rpcArgs(5000, { exe: 'x', device: 'cuda', threads: 4 }, true), ['-H', '127.0.0.1', '-p', '5000', '-c']);
  assert.deepEqual(rpcArgs(5000, { exe: 'x', device: 'cpu', threads: 4 }, false), ['-H', '127.0.0.1', '-p', '5000', '-t', '4']);
  assert.ok(!rpcArgs(5000, { exe: 'x', device: 'cpu', threads: 0 }, false).includes('-t'));
});

test('a chat runner with lent PCs: --rpc, and llama.cpp\'s own fit places the layers (no -ngl), on the CPU runner too', () => {
  const a = chatArgs('m.gguf', 9000, 'cpu', 4, false, { ctx: 8192, cache: 'f16', place: 'auto', rpc: ['127.0.0.1:1', '127.0.0.1:2'] });
  assert.deepEqual(a.slice(a.indexOf('--rpc'), a.indexOf('--rpc') + 2), ['--rpc', '127.0.0.1:1,127.0.0.1:2']);
  assert.ok(!a.includes('-ngl'));
  const plain = chatArgs('m.gguf', 9000, 'cpu', 4);
  assert.ok(!plain.includes('--rpc'));
  assert.deepEqual(plain.slice(plain.indexOf('-ngl'), plain.indexOf('-ngl') + 2), ['-ngl', '0']);
});

test('a lent PC that went away is named as the reason', () => {
  const tail = 'E send failed (bytes_sent=0, size_to_send=8)\nD:/a/llama.cpp/ggml/src/ggml-rpc/ggml-rpc.cpp:569: Remote RPC server crashed or returned malformed response';
  assert.ok(maxFault(tail));
  assert.match(whyItFailed(tail), /a PC lending its card for Max mode stopped answering/);
  assert.ok(!maxFault('llama_model_load: error loading model: failed to allocate buffer'));
});

test('a loan that ends is told, with why (it goes in the lending PC\'s log); ending with no loan tells nothing', async () => {
  const told: { to: string; why: string }[] = [];
  const l = new Lender(tmpdir(), () => '', e => told.push({ to: e.to, why: e.why }));
  await l.end('nothing lent yet');
  assert.deepEqual(told, []);
  l.lease = { hash: 'a', name: 'Office PC', since: new Date().toISOString() };
  await l.end('someone started using it');
  assert.deepEqual(told, [{ to: 'Office PC', why: 'someone started using it' }]);
});

test('a screen saver that locks Windows when it ends counts as locked; one that does not, and its idle time, are said', () => {
  // "idleMs logonUI saverRunning saverLocks": the reader's line since 3 Nov.
  assert.deepEqual(presenceOf('61234 0 1 1'), { idleMs: 61234, locked: true, saver: true });
  assert.deepEqual(presenceOf('61234 0 1 0'), { idleMs: 61234, locked: false, saver: true });
  assert.deepEqual(presenceOf('61234 0 0 1'), { idleMs: 61234, locked: false, saver: false }, 'set to lock, but not running');
  assert.deepEqual(presenceOf('61234 1 0 0'), { idleMs: 61234, locked: true, saver: false });
  const base = { pc: 'Worker PC', on: true, allow: LEND, away: false, idleMinutes: 2, lease: null, by: { hash: 'a' } };
  assert.equal(lendWhy({ ...base, presence: presenceOf('30000 0 1 1') }), '', 'the locking screen saver: lends at once');
  assert.equal(presenceWords({ idleMs: 30_000, locked: true, saver: true }), 'its screen saver is on and locks Windows');
  // Exact under 10 minutes: "2 min" beside "after 2 minutes" read as if it should have lent (2 Nov).
  assert.equal(presenceWords({ idleMs: 100_000, locked: false }), 'last used 1 min 40 s ago');
  assert.equal(presenceWords({ idleMs: 45_400, locked: false }), 'last used 45 s ago');
  assert.equal(presenceWords({ idleMs: 4 * min, locked: false }), 'last used 4 min ago');
  assert.equal(presenceWords({ idleMs: 100_000, locked: false, saver: true }), 'last used 1 min 40 s ago; its screen saver is on but does not lock Windows');
  assert.equal(presenceWords({ idleMs: 25 * min + 20_000, locked: false }), 'last used 25 min ago');
});

test('a locked, disconnected or empty Windows session counts as nobody there, whatever session TOMLIN runs in; Remote Desktop use is named (14 Nov)', () => {
  // "idleMs locked saverRunning saverLocks how": the reader's line since 14 Nov.
  assert.deepEqual(presenceOf('10000 1 0 0 L'), { idleMs: 10_000, locked: true, saver: false, seen: 'locked' });
  assert.deepEqual(presenceOf('10000 1 0 0 D'), { idleMs: 10_000, locked: true, saver: false, seen: 'disconnected' });
  assert.deepEqual(presenceOf('10000 1 0 0 N'), { idleMs: 10_000, locked: true, saver: false, seen: 'nobody' });
  assert.deepEqual(presenceOf('10000 0 0 0 R'), { idleMs: 10_000, locked: false, saver: false, seen: 'remote' });
  assert.deepEqual(presenceOf('800 0 1 1 C'), { idleMs: 800, locked: true, saver: true, seen: 'console' });
  assert.equal(presenceOf('10000 0 0 0 X'), null);
  const base = { pc: 'Worker PC', on: true, allow: LEND, away: false, idleMinutes: 5, lease: null, by: { hash: 'a' } };
  // Input on the lock screen just after Windows+L (10 s ago) does not count: locked wins, at once.
  for (const l of ['10000 1 0 0 L', '0 1 0 0 L', '10000 1 0 0 D', '10000 1 0 0 N']) {
    const p = presenceOf(l)!;
    assert.equal(lendWhy({ ...base, presence: p }), '', l);
    assert.equal(ownerBack(p), false, l);
  }
  assert.equal(presenceWords(presenceOf('10000 1 0 0 L')!), 'Windows is locked');
  assert.match(presenceWords(presenceOf('10000 1 0 0 D')!), /disconnected/);
  assert.match(presenceWords(presenceOf('10000 1 0 0 N')!), /nobody is signed in/);
  // Someone at an unlocked session, at its keyboard or over Remote Desktop, still stops a loan.
  for (const l of ['900 0 0 0 C', '900 0 0 0 R']) assert.equal(ownerBack(presenceOf(l)!), true, l);
  const rdp = lendWhy({ ...base, presence: presenceOf('10000 0 0 0 R') });
  assert.match(rdp, /^someone is using "Worker PC" \(last used 10 s ago over Remote Desktop, not locked: Windows\+L in a Remote Desktop window locks the PC in front of you/);
  assert.equal(presenceWords(presenceOf('10000 0 0 0 C')!), 'last used 10 s ago');
});

test('the presence reader on Windows says whether the screen saver runs, and what Windows\' session list showed', { skip: process.platform !== 'win32' }, async () => {
  const r = new PresenceReader();
  try {
    const p = await r.first(20_000);
    assert.ok(p, 'a reading came');
    assert.equal(typeof p.saver, 'boolean', JSON.stringify(p));
    // Run by someone signed in and using this PC, at its screen or over Remote Desktop.
    assert.ok(p.seen === 'console' || p.seen === 'remote', JSON.stringify(p));
    assert.equal(p.locked, false, JSON.stringify(p));
  } finally {
    r.stop();
  }
});

test('an update waits while this PC lends its card: restarting TOMLIN would cut the loan mid-load (3 Nov, the Worker PC dropped off the network)', async () => {
  const { loanBusy } = await import('../src/maxlend.ts');
  assert.equal(loanBusy(null), null);
  assert.equal(loanBusy({ hash: 'a', name: 'Office PC', since: '' }), 'lending its card memory to "Office PC" (Max mode)');
  // The node's busy rule (what the update door asks) puts a loan first.
  const node = readFileSync(new URL('../src/jobrun/node.ts', import.meta.url), 'utf8');
  assert.match(node, /nodeBusyNow = \(\) => loanBusyNow\(\) \?\? /);
});

test('an RPC server that stops on its own: the log says its exit code, the free RAM then and its last lines', async () => {
  const { PassThrough } = await import('node:stream');
  const stderr = new PassThrough();
  const tail = maxlend.keepTail({ stderr } as never, 3);
  stderr.write('line one\r\nline two\n\nline three\nline four\npart of five');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(tail(), ['line three', 'line four', 'part of five']);
  const words = maxlend.stoppedWords(-1073741571, null, { total: 64 * 2 ** 30, free: 3.5 * 2 ** 30 }, tail());
  assert.match(words, /exit code -1073741571 \(0xC00000FD\)/);
  assert.match(words, /3\.5 GB free of 64\.0 GB/);
  assert.match(words, /line four \| part of five/);
  assert.match(maxlend.stoppedWords(null, 'SIGKILL', { total: 2 ** 30, free: 0 }, []), /ended by SIGKILL.*wrote nothing/);
  assert.deepEqual(maxlend.keepTail({ stderr: null } as never)(), []);
  // Output that never ends a line keeps only its end, in a moment, not the whole of it.
  const endless = new PassThrough();
  const last = maxlend.keepTail({ stderr: endless } as never, 3);
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    endless.write('.'.repeat(2 ** 20));
    if (i % 10 === 0) await new Promise(r => setImmediate(r));
  }
  await new Promise(r => setImmediate(r));
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms for 120 MB of dots`);
  assert.ok(last()[0].length <= 300);
});

test('an RPC server that floods its error output with no line end is kept to a short tail, not held whole', async () => {
  const { PassThrough } = await import('node:stream');
  const stderr = new PassThrough();
  const tail = maxlend.keepTail({ stderr } as never, 3);
  // 8 MB of dots with no line end (as a load bar does), then a real last line.
  for (let k = 0; k < 128; k++) stderr.write('.'.repeat(64 * 1024));
  await new Promise(r => setImmediate(r));
  stderr.write('the real last line\n');
  await new Promise(r => setImmediate(r));
  const t = tail();
  assert.equal(t.at(-1), 'the real last line', 'the dots were let go as a line of their own, not held and glued to the next');
  assert.ok(t.every(l => l.length <= 300));
});

test('the weight cache is kept under its limit and never fills the drive (689 files, 122.6 GB, 17 Nov)', async () => {
  const GB = 2 ** 30;
  const files = Array.from({ length: 689 }, (_, i) => ({ path: `f${i}`, size: Math.round((122.6 * GB) / 689), at: i }));
  // 3.2 GB free with the cache on the disk: it comes down to the 24 GB limit, oldest files first.
  const gone = maxlend.cacheToDelete(files, 3.2 * GB);
  const left = files.filter(f => !gone.includes(f.path));
  assert.ok(left.reduce((n, f) => n + f.size, 0) <= maxlend.CACHE_LIMIT);
  assert.ok(left.every(f => f.at >= 689 - left.length), 'the newest files stay');
  assert.equal(gone[0], 'f0', 'the oldest goes first');
  // Little room even without the cache: it is not kept at all (the cache is used only with 20 GB free besides it).
  assert.equal(maxlend.cacheToDelete(files.slice(0, 10), 5 * GB).length, 10);
  // Plenty of room and a small cache: nothing goes.
  assert.deepEqual(maxlend.cacheToDelete(files.slice(0, 10), 400 * GB), []);
  // A cache that fits but would leave under 20 GB free: cut back so that 20 GB stays free.
  const some = [{ path: 'a', size: 10 * GB, at: 1 }, { path: 'b', size: 10 * GB, at: 2 }];
  assert.deepEqual(maxlend.cacheToDelete(some, 12 * GB), ['a']);
  // On the real folder: only the oldest go, and the folder is read down two levels.
  const dir = mkdtempSync(join(tmpdir(), 'sm-cache-'));
  try {
    mkdirSync(join(dir, 'sub'));
    for (let i = 0; i < 5; i++) {
      const p = join(dir, i < 3 ? '' : 'sub', `w${i}`);
      writeFileSync(p, Buffer.alloc(1000));
      utimesSync(p, new Date(2026, 10, 10 + i), new Date(2026, 10, 10 + i));
    }
    const r = await maxlend.pruneCache(dir, 100 * GB, 2500, 0);
    assert.equal(r.files, 3);
    assert.deepEqual(readdirSync(dir).sort(), ['sub', 'w3'.length ? 'sub' : ''].filter(Boolean).slice(0, 1));
    assert.deepEqual(readdirSync(join(dir, 'sub')).sort(), ['w3', 'w4']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a loan ends when the disk is nearly full, and the cache is brought down as it starts and as it ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-cache-'));
  const said: string[] = [];
  let pruned = 0;
  let free = 100 * 2 ** 30;
  class D extends Lender {
    protected override async prune(): Promise<void> { pruned++; }
    protected override async diskFree(): Promise<number> { return free; }
    protected override spawnRpc(_p: RpcProgram, port: number) { return standIn(port); }
  }
  const told: string[] = [];
  const l = new D(dir, () => '', e => told.push(e.why), { read: () => ({ total: 1, free: 1 }), say: s => said.push(s) });
  try {
    await l.open({ hash: 'a', name: 'Main PC' }, PROGRAM);
    assert.equal(pruned, 1, 'brought down as the loan starts');
    free = 2 * 2 ** 30;
    for (let i = 0; i < 40 && !told.length; i++) await new Promise(r => setTimeout(r, 1000));
    assert.match(told[0] ?? '', /disk is nearly full/);
    // Brought down once the RPC server is gone (its files closed), a moment after the end is told.
    for (let i = 0; i < 100 && pruned < 2; i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(pruned >= 2, 'and again as it ends');
  } finally {
    await l.end('test');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after the disk floor ended a loan, the next one runs without the cache until 44 GB is free (20 to 36 GB free looped for ever)', async () => {
  const GB = 2 ** 30;
  const dir = mkdtempSync(join(tmpdir(), 'sm-cache-'));
  const said: string[] = [];
  const caches: boolean[] = [];
  let free = 30 * GB;
  let room = 30 * GB;
  class D extends Lender {
    protected override async prune(): Promise<void> {}
    protected override async diskFree(): Promise<number> { return free; }
    protected override async cacheRoom(): Promise<number> { return room; }
    protected override spawnRpc(_p: RpcProgram, port: number, cache: boolean) { caches.push(cache); return standIn(port); }
  }
  const told: string[] = [];
  const l = new D(dir, () => '', e => told.push(e.why), { read: () => ({ total: 1, free: 1 }), say: s => said.push(s) });
  try {
    assert.equal(maxlend.CACHE_AGAIN, maxlend.CACHE_DISK + maxlend.CACHE_LIMIT);
    await l.open({ hash: 'a', name: 'Main PC' }, PROGRAM);
    assert.deepEqual(caches, [true], '30 GB free: the cache is used');
    // The cache grows to the floor: the loan ends there.
    free = 5 * GB;
    for (let i = 0; i < 40 && !told.length; i++) await new Promise(r => setTimeout(r, 500));
    assert.match(told[0] ?? '', /disk is nearly full/);
    // Pruned back to 30 GB free: the next loan runs without the cache, and the log says why.
    free = 30 * GB;
    await l.open({ hash: 'a', name: 'Main PC' }, PROGRAM);
    assert.deepEqual(caches, [true, false]);
    assert.ok(said.some(s => /not used for this loan.*44 GB is free \(30\.0 GB now\)/.test(s)), said.join(' / '));
    await l.end('test');
    // 44 GB free: the cache is used again, and stays so.
    room = 44 * GB;
    await l.open({ hash: 'a', name: 'Main PC' }, PROGRAM);
    await l.end('test');
    room = 30 * GB;
    await l.open({ hash: 'a', name: 'Main PC' }, PROGRAM);
    assert.deepEqual(caches, [true, false, true, true]);
  } finally {
    await l.end('test');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a loan ended by force: the cache files of its last 5 minutes go, older ones stay; ended because the borrower was done, none go', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-cache-'));
  const rpc = join(dir, 'rpc');
  const said: string[] = [];
  let room = 100 * 2 ** 30;
  class D extends Lender {
    protected override async prune(): Promise<void> {}
    protected override async diskFree(): Promise<number> { return 100 * 2 ** 30; }
    protected override async cacheRoom(): Promise<number> { return room; }
    protected override spawnRpc(_p: RpcProgram, port: number) { return standIn(port); }
  }
  const put = (name: string, minutesAgo: number) => {
    const f = join(rpc, name);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, Buffer.alloc(1000));
    const t = new Date(Date.now() - minutesAgo * 60_000);
    utimesSync(f, t, t);
    return f;
  };
  const l = new D(dir, () => '', () => undefined, { read: () => ({ total: 1, free: 1 }), say: s => said.push(s) });
  try {
    assert.equal(maxlend.CUT_SHORT_MS, 5 * 60_000);
    const before = put('from-an-older-loan.bin', 60);
    await l.open({ hash: 'a', name: 'Main PC' }, PROGRAM);
    const written = put(join('ab', 'written-now.bin'), 0);
    await l.end('someone started using it');
    // The file goes first and the line saying so comes after it: on a busy PC that can be a moment later, so both are waited for.
    const told = () => said.some(s => /removed 1 file .* cut short would load as wrong weights/.test(s));
    for (let i = 0; i < 100 && (existsSync(written) || !told()); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(!existsSync(written), 'the file the stop may have cut short went');
    assert.ok(existsSync(before), 'one written before the loan stays');
    assert.ok(said.some(s => /removed 1 file .* cut short would load as wrong weights/.test(s)), said.join(' / '));
    // The borrower was done: nothing was being written, nothing goes.
    await l.open({ hash: 'a', name: 'Main PC' }, PROGRAM);
    const kept = put('done.bin', 0);
    await l.end(maxlend.IDLE_END, 'idle');
    await new Promise(r => setTimeout(r, 300));
    assert.ok(existsSync(kept));
    // A loan that did not use the cache writes none: a stop deletes nothing.
    room = 1;
    await l.open({ hash: 'a', name: 'Main PC' }, PROGRAM);
    const other = put('not-from-this-loan.bin', 0);
    await l.end('sharing was turned off there');
    await new Promise(r => setTimeout(r, 300));
    assert.ok(existsSync(other));
    // Only the files under the folder given, and never a folder.
    const beside = join(dir, 'beside.bin');
    writeFileSync(beside, 'x');
    assert.deepEqual(await maxlend.dropCutShort(rpc, 0), { files: 3, bytes: 3000 });
    assert.ok(existsSync(beside) && existsSync(join(rpc, 'ab')));
    assert.deepEqual(await maxlend.dropCutShort(join(dir, 'none'), 0), { files: 0, bytes: 0 });
  } finally {
    await l.end('test');
    rmSync(dir, { recursive: true, force: true });
  }
});
