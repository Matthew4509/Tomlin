// Audit of the linked PCs area (report only): a real node copy on an empty home in %TEMP%\tomlin-audit-links, its link
// door held to 127.0.0.1, and made-up links written into its share.json before it starts. Each test is named after its
// finding id. A test marked todo is a lesser fault (P1): it fails until fixed, without failing the run.
// Never calls the turn-off door on a live copy (its tick is off here too): turning off is tested on its plain parts only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as link from '../src/link.ts';
import { hashToken } from '../src/share.ts';
import { cleanAllow } from '../src/carry.ts';
import { cleanManifest } from '../src/update.ts';
import { powerOffSide } from '../src/poweroff.ts';
import { HostPins, TryGuard, pinGate } from '../src/hostpin.ts';
import { hashSecret } from '../src/lock.ts';
import { freePort, NODE_CODE, NODE_PIN, sleep, until } from './pcs.ts';

const HOLD_TO_THIS_PC = `data:text/javascript,import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return l.apply(this,a);};`;
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT_TMP = join(tmpdir(), 'tomlin-audit-links');
mkdirSync(ROOT_TMP, { recursive: true });
const home = mkdtempSync(join(ROOT_TMP, 'node-'));
const NODE_ID = 'a1b2c3d4';
let server: ChildProcess | null = null;
let said = '';
let port = 0;
let door = 0;

interface Made { token: string; keys: Buffer; record: Record<string, unknown> }
const madeLink = (extra: Record<string, unknown>): Made => {
  const token = randomBytes(32).toString('hex');
  const keys = randomBytes(64);
  return { token, keys, record: { hash: hashToken(token), key: link.keysText(keys), at: new Date(Date.now() - 86_400_000).toISOString(), ...extra } };
};
const ADMIN = madeLink({ name: 'Audit host', keep: 'aaaaaaaaaaaaaaaa', from: 'f00dbeef' });
const ADMIN2 = madeLink({ name: 'Second host', keep: 'bbbbbbbbbbbbbbbb', from: 'b00bb00b' });
const RELINK = madeLink({ name: 'Relink host', keep: 'cccccccccccccccc', from: 'c0ffee01' });

interface Answer { status: number; text: string; json: any }
function ask(method: string, path: string, o: { raw?: string | Buffer; headers?: Record<string, string>; toPort?: number } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = o.raw ?? '';
    const req = request({ host: '127.0.0.1', port: o.toPort ?? door, path, method, agent: false, headers: { connection: 'close', 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...o.headers } }, res => {
      const got: Buffer[] = [];
      res.on('data', d => got.push(d));
      res.on('end', () => {
        const s = Buffer.concat(got).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(s); } catch { /* a stream, or nothing */ }
        resolve({ status: res.statusCode ?? 0, text: s, json });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

/** A sealed request on a link (`box` given: sent as it is). Its status, and the answer opened when it was sealed. */
async function knock(m: { token: string; keys: Buffer }, path: string, body: Record<string, unknown> = {}, o: { now?: number; box?: string } = {}): Promise<{ status: number; answer: any; box: string; text: string }> {
  const box = o.box ?? link.sealRequest(m.keys, path, body, o.now ?? Date.now()).box;
  // As the host sends it (src/jobrun/links.ts linkFetch): with the proof of the link's keys that lets its body be read.
  const r = await ask('POST', path, { headers: { authorization: `Link ${hashToken(m.token)}`, [link.BODY_PROOF]: link.bodyProof(m.keys, path) }, raw: JSON.stringify({ v: link.LINK_VERSION, box }) });
  let answer: any = r.json;
  if (r.json?.box) answer = link.openAnswer(m.keys, link.requestId(box), 0, r.json.box);
  return { status: r.status, answer, box, text: r.text };
}

/** Links as a PC would with `code`: the link's token and keys, or the refusal. `proof`: take over the link these keys made. */
async function pair(code: string, o: { from?: string; old?: Buffer; raw?: Record<string, unknown> } = {}): Promise<{ made: { token: string; keys: Buffer }; sent: Record<string, unknown> } | { status: number; json: any; sent: Record<string, unknown> }> {
  const key = await link.pairKey(code, '');
  const asked = link.hostAsk(key, o.from ?? randomBytes(4).toString('hex'), 'Made-up laptop', false);
  const sent: Record<string, unknown> = o.raw ?? { ...asked.ask, ...(o.old ? { proof: link.takeOverProof(o.old, asked.ask.pub) } : {}) };
  const r = await ask('POST', '/worker/pair', { raw: JSON.stringify(sent) });
  if (r.status !== 200) return { status: r.status, json: r.json, sent };
  const f = link.hostFinish(key, asked.ask, asked.priv, r.json);
  return { made: { token: f.token, keys: f.keys }, sent };
}

const shareFile = () => JSON.parse(readFileSync(join(home, 'data', 'share.json'), 'utf8'));

/** A finished answer kept in the node's outbox for `owner`, sealed with `keys` as the node seals one (src/outbox.ts). */
function plantKept(owner: string, rid: string, keys: Buffer, text: string): void {
  const dir = join(home, 'data', 'outbox');
  mkdirSync(dir, { recursive: true });
  const kept = { state: 'done', text, done: { model: 'made-up' }, at: new Date().toISOString() };
  writeFileSync(join(dir, `${owner}-${rid}.box`), link.sealBytes(link.toHost(keys), Buffer.from(JSON.stringify(kept)), `outbox|${rid}`));
}

async function startNode(): Promise<void> {
  said = '';
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  Object.assign(env, { TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_START_MENU_DIR: join(home, 'start-menu'), TOMLIN_INSTALL_ROOT: join(home, 'install'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_OPEN: '' });
  server = spawn(process.execPath, ['--import', HOLD_TO_THIS_PC, join(SRC, 'server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', d => (said += d));
  server.stderr!.on('data', d => (said += d));
  await until('the node copy to start', async () => said.includes('is running at') || (server!.exitCode !== null ? Promise.reject(new Error(said)) : false), 420_000, 300);
  await until('the link door to open', async () => (await ask('GET', '/worker/whoami').catch(() => ({ status: 0 }))).status === 200, 60_000, 300);
}
async function stopNode(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  if (s.exitCode === null && s.signalCode === null) {
    const gone = new Promise(r => s.once('exit', r));
    s.kill();
    await gone;
  }
}

before(async () => {
  for (;;) {
    door = await freePort();
    port = await freePort();
    // Never the owner's own ports.
    if (![8740, 8741, 8485, 8752].includes(door) && ![8740, 8741, 8485, 8752].includes(port) && door !== port) break;
  }
  const data = join(home, 'data');
  mkdirSync(join(home, 'startup'), { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(join(home, 'models'), { recursive: true });
  writeFileSync(join(home, 'models-folder.txt'), '');
  writeFileSync(join(data, 'app-lock.json'), JSON.stringify({ salt: 'feed', hash: scryptSync(NODE_PIN, 'feed', 32).toString('hex'), idleMinutes: 0 }));
  writeFileSync(join(data, 'share.json'), JSON.stringify({
    on: true, port: door, name: 'Audit node', id: NODE_ID, code: NODE_CODE, pinOn: false, pin: '', models: [],
    // The turn-off tick is off on this copy: no test here can reach a real shutdown.
    allow: { pull: false, backup: true, update: false, tune: false, lend: false, receive: false, give: false, off: false },
    paired: [ADMIN.record, ADMIN2.record, RELINK.record],
  }));
  await startNode();
});

after(async () => {
  await stopNode();
  await sleep(300);
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

// ---- Rule 1: the sealed request ----

test('C-01: a replayed request is refused, and the first one was taken', async () => {
  const first = await knock(ADMIN, '/worker/stats');
  assert.equal(first.status, 200, first.text);
  const again = await knock(ADMIN, '/worker/stats', {}, { box: first.box });
  assert.equal(again.status, 400, again.text);
});

test('C-02: an altered request (one letter of its box changed) is refused', async () => {
  const box = link.sealRequest(ADMIN.keys, '/worker/stats', {}).box;
  const i = 30;
  const altered = box.slice(0, i) + (box[i] === 'A' ? 'B' : 'A') + box.slice(i + 1);
  const r = await knock(ADMIN, '/worker/stats', {}, { box: altered });
  assert.equal(r.status, 400, r.text);
  // Cut short (truncated) and empty: refused the same way.
  assert.equal((await knock(ADMIN, '/worker/stats', {}, { box: box.slice(0, 40) })).status, 400);
  assert.equal((await knock(ADMIN, '/worker/stats', {}, { box: '' })).status, 400);
});

test('C-03: a request sealed for one door and sent to another is refused (reordered or redirected)', async () => {
  const box = link.sealRequest(ADMIN.keys, '/worker/stats', {}).box;
  const r = await knock(ADMIN, '/worker/hello', {}, { box });
  assert.equal(r.status, 400, r.text);
  // Another link's keys: the box does not open on this link.
  const other = link.sealRequest(ADMIN2.keys, '/worker/stats', {}).box;
  assert.equal((await knock(ADMIN, '/worker/stats', {}, { box: other })).status, 400);
});

test('C-04: a request stamped 16 minutes ago is refused; one 14 minutes ahead (a clock that differs) is taken', async () => {
  assert.equal((await knock(ADMIN, '/worker/stats', {}, { now: Date.now() - 16 * 60_000 })).status, 400);
  assert.equal((await knock(ADMIN, '/worker/stats', {}, { now: Date.now() + 14 * 60_000 })).status, 200);
});

test('C-05: hostile bodies and headers at the door are refused and the node keeps answering', async () => {
  const auth = { authorization: `Link ${hashToken(ADMIN.token)}` };
  // Says it is larger than the door takes: refused before it is read.
  const big = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: door, path: '/worker/hello', method: 'POST', agent: false, headers: { ...auth, 'content-length': String(10 ** 12) } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.write('x');
    setTimeout(() => req.destroy(), 3000);
  });
  assert.equal(big, 400);
  // Sent in chunks with no length, past the door's 16 KB.
  const chunked = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: door, path: '/worker/hello', method: 'POST', agent: false, headers: { ...auth, 'transfer-encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    for (let k = 0; k < 20; k++) req.write(Buffer.alloc(1 << 20, 0x61));
    req.end();
  });
  assert.equal(chunked, 400);
  for (const raw of ['not json', 'null', '[]', '{"box":12}', '{"box":"!!!!"}', JSON.stringify({ box: 'A'.repeat(15_000) })]) {
    const r = await ask('POST', '/worker/hello', { headers: auth, raw });
    assert.equal(r.status, 400, `${raw.slice(0, 20)}: ${r.text}`);
  }
  // An unknown link, a malformed one, a huge header.
  assert.equal((await ask('POST', '/worker/hello', { headers: { authorization: `Link ${'0'.repeat(64)}` }, raw: '{}' })).status, 401);
  assert.equal((await ask('POST', '/worker/hello', { headers: { authorization: 'Link ../../x' }, raw: '{}' })).status, 401);
  const huge = await ask('POST', '/worker/hello', { headers: { authorization: `Link ${'a'.repeat(40_000)}` }, raw: '{}' }).catch(() => ({ status: 0 }));
  assert.ok([400, 401, 431, 0].includes(huge.status), String(huge.status));
  assert.equal((await ask('GET', '/worker/whoami')).status, 200, 'the node still answers');
  assert.equal((await knock(ADMIN, '/worker/stats')).status, 200, 'and its link still works');
});

test('B-01: a link\'s name alone (no keys) holds that link\'s body budget, so its real requests are refused', async () => {
  // The fingerprint crosses the network in the clear (and Find it on my network sends it to other TOMLIN PCs).
  const held: Socket[] = [];
  const hold = (path: string, bytes: number) => new Promise<void>((resolve, reject) => {
    const s = connect(door, '127.0.0.1', () => {
      s.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Link ${hashToken(ADMIN.token)}\r\nContent-Type: application/json\r\nContent-Length: ${bytes}\r\n\r\n{`);
      resolve();
    });
    s.on('error', () => undefined);
    s.once('error', reject);
    held.push(s);
  });
  try {
    await hold('/worker/git-commit', 32 << 20);
    await hold('/worker/update-offer', 4 << 20);
    await hold('/worker/update-offer', 4 << 20);
    let refused = false;
    for (let k = 0; k < 10 && !refused; k++) {
      await sleep(500);
      refused = (await knock(ADMIN, '/worker/run', { user: 'hello' })).status === 429;
    }
    assert.equal(refused, false, 'the real host\'s request was refused while someone with only its fingerprint held the budget');
  } finally {
    for (const s of held) s.destroy();
  }
  await until('the budget to come back', async () => (await knock(ADMIN, '/worker/run', { user: 'hello' })).status !== 429, 30_000, 500);
});

// ---- Rule 2: guests ----

const GUEST_CODE = 'WXYZ-2345';
const SHORT_CODE = 'HJKM-6789';
let guest: { token: string; keys: Buffer };
let shortGuest: { token: string; keys: Buffer };
let shortEnds = 0;

test('G-00: the host sends the node two passes (one ends in 40 s); guests link with them; a link request sent twice is refused', async () => {
  shortEnds = Date.now() + 40_000;
  const pass = async (id: string, code: string, expires: string) => ({ id, label: `Pass ${id}`, key: (await link.pairKey(code, '')).toString('base64url'), length: 'day', created: new Date().toISOString(), expires, nodes: [NODE_ID], models: ['on-pass-model'], uses: 0, lastSeen: null, rev: 1 });
  const put = await knock(ADMIN, '/worker/passes-put', { gen: Date.now(), passes: [await pass('g1g1g1g1', GUEST_CODE, new Date(Date.now() + 86_400_000).toISOString()), await pass('s1s1s1s1', SHORT_CODE, new Date(shortEnds).toISOString())] });
  assert.equal(put.status, 200, put.text);
  const a = await pair(GUEST_CODE);
  assert.ok('made' in a, JSON.stringify(a));
  guest = a.made;
  // P-01: the same link request again.
  const replay = await pair(GUEST_CODE, { raw: a.sent });
  assert.ok(!('made' in replay));
  assert.equal((replay as { status: number }).status, 409);
  const b = await pair(SHORT_CODE);
  assert.ok('made' in b, JSON.stringify(b));
  shortGuest = b.made;
  assert.equal((await knock(shortGuest, '/worker/hello')).status, 200);
});

test('G-01: a guest is not told this PC\'s memory or graphics card in its meters (hello leaves them out)', async () => {
  const hello = await knock(guest, '/worker/hello');
  assert.equal(hello.status, 200, hello.text);
  assert.equal(hello.answer.memory, null, 'hello hides it');
  const stats = await knock(guest, '/worker/stats');
  assert.equal(stats.status, 200, stats.text);
  assert.ok(stats.answer.ram == null && stats.answer.gpu == null, `stats tells a guest: ${JSON.stringify({ ram: stats.answer.ram, gpu: stats.answer.gpu })}`);
});

test('G-02: a guest never gets another link\'s kept answer, and the host that asked does', async () => {
  const rid = 'ab'.repeat(16);
  plantKept(String(ADMIN.record.keep), rid, ADMIN.keys, 'the host\'s own answer');
  const g = await knock(guest, '/worker/result', { rid });
  assert.equal(g.status, 404, g.text);
  assert.ok(!g.text.includes('own answer'));
  const h = await knock(ADMIN, '/worker/result', { rid });
  assert.equal(h.status, 200, h.text);
  assert.equal(h.answer.text, 'the host\'s own answer');
  // A guest's run on a model not on its pass, and a door that is not its: refused.
  assert.equal((await knock(guest, '/worker/run', { model: 'not-on-pass', user: 'x' })).status, 403);
  assert.equal((await knock(guest, '/worker/log', {})).status, 403);
  assert.equal((await knock(guest, '/worker/agents', { action: 'list' })).status, 403);
});

test('G-03: a guest pass ends when it says: the guest is refused once its end has passed', async () => {
  await until('the short pass to end', async () => Date.now() > shortEnds + 500, 90_000, 500);
  const r = await knock(shortGuest, '/worker/hello');
  assert.equal(r.status, 403, r.text);
  assert.equal(r.answer?.guest, 'expired');
  assert.equal((await knock(shortGuest, '/worker/run', { model: 'on-pass-model', user: 'x' })).status, 403);
});

// ---- Rule 7 + 8: work kept for a link, and the link made again ----

test('O-01: linking again from the same PC (proving the old keys) keeps the answers kept for it', async () => {
  const rid = 'cd'.repeat(16);
  plantKept(String(RELINK.record.keep), rid, RELINK.keys, 'finished while the host was away');
  // Before: the kept answer is there for the old link.
  assert.equal((await knock(RELINK, '/worker/result', { rid })).status, 200);
  const r = await pair(NODE_CODE, { from: String(RELINK.record.from), old: RELINK.keys });
  assert.ok('made' in r, JSON.stringify(r));
  const rec = shareFile().paired.find((x: { hash: string }) => x.hash === hashToken(r.made.token));
  assert.equal(rec.keep, RELINK.record.keep, 'took over the old link (same keep)');
  const after = await knock(r.made, '/worker/result', { rid });
  assert.equal(after.status, 200, `the answer finished for this PC is gone after it linked again: ${after.text}`);
  assert.equal(after.answer.text, 'finished while the host was away');
});

test('C-06: a request taken before a restart is refused after it', async () => {
  const first = await knock(ADMIN2, '/worker/stats');
  assert.equal(first.status, 200, first.text);
  await stopNode();
  await startNode();
  const again = await knock(ADMIN2, '/worker/stats', {}, { box: first.box });
  assert.equal(again.status, 400, again.text);
  assert.equal((await knock(ADMIN2, '/worker/stats')).status, 200);
});

// ---- Plain parts: the stream reader, the update list, turning off ----

test('L-01: the host\'s reader of a sealed stream refuses one that never ends a block, before it holds much of it', async () => {
  // Anything at the node's address (a PC that took it over, or something in the middle) can answer: nothing is checked
  // until a whole block has come.
  const keys = randomBytes(64);
  const MB = 1 << 20;
  let sentBytes = 0;
  let atError = -1;
  const src = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sentBytes >= 96 * MB) return c.close();
      sentBytes += MB;
      c.enqueue(new Uint8Array(MB).fill(0x61));
    },
  });
  const reader = link.openStream(keys, 'x'.repeat(16), src).getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (atError < 0 && dec.decode(value).includes('event: error')) atError = sentBytes;
  }
  // The largest real block is a sealed 20 MB picture (about 36 MB of letters): refused within a megabyte or two past that.
  assert.ok(atError >= 0 && atError <= link.LINK_BLOCK_MOST + 2 * MB, `no refusal after ${sentBytes / MB} MB with no block end (error at ${atError})`);
});

test('U1: a linked PC\'s plain answer that runs on for ever, or goes quiet, is given up before it fills this PC', async () => {
  const { createServer } = await import('node:http');
  const MB = 1 << 20;
  let sent = 0;
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"box":"');
    if (req.url !== '/forever') return; // headers, a little, then nothing
    const chunk = Buffer.alloc(MB, 0x61);
    const more = () => {
      while (sent < 2048 * MB && !res.destroyed) {
        sent += MB;
        if (!res.write(chunk)) return void res.once('drain', more);
      }
      res.end();
    };
    more();
  });
  await new Promise<void>(ok => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as { port: number }).port;
  try {
    await assert.rejects(link.readCapped(await fetch(`http://127.0.0.1:${port}/forever`)), (e: unknown) => e instanceof link.AnswerCut && e.why === 'big');
    assert.ok(sent < link.LINK_BLOCK_MOST + 64 * MB, `${sent / MB} MB sent before it was given up`);
    const began = Date.now();
    await assert.rejects(link.readCapped(await fetch(`http://127.0.0.1:${port}/quiet`), link.LINK_BLOCK_MOST, 300), (e: unknown) => e instanceof link.AnswerCut && e.why === 'quiet');
    assert.ok(Date.now() - began < 5000);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
  // Both readers of a linked PC's answer use it (the work doors and the video link), never an uncapped res.json().
  for (const f of ['jobrun/links.ts', 'videolink.ts']) assert.match(readFileSync(join(SRC, f), 'utf8'), /link\.readCapped\(res\)/, f);
  const fetchSrc = readFileSync(join(SRC, 'jobrun/links.ts'), 'utf8').replace(/\r\n/g, '\n').split('async function linkFetch')[1].split('\n}\n')[0];
  assert.doesNotMatch(fetchSrc, /res\.(clone\(\)\.)?json\(\)/, 'linkFetch reads no answer uncapped');
});

test('U-01: an update\'s list naming a way out of the app folder, a stream or a data file is refused', () => {
  const base = [{ path: 'package.json', bytes: 1, sha: 'a'.repeat(64) }, { path: 'src/server.ts', bytes: 1, sha: 'b'.repeat(64) }, { path: 'Start TOMLIN.cmd', bytes: 1, sha: 'c'.repeat(64) }];
  assert.ok(Array.isArray(cleanManifest(base)));
  for (const path of ['../x.ts', 'src/../../x.ts', 'src\\x.ts', '/src/x.ts', 'src/x.ts:evil', 'data/share.json', 'src/x.ts.', 'src//x.ts', 'C:/x.ts', 'src/x.part', 'models/chat/a.gguf']) {
    assert.equal(typeof cleanManifest([...base, { path, bytes: 1, sha: 'd'.repeat(64) }]), 'string', path);
  }
  assert.equal(typeof cleanManifest([...base, { path: 'SRC/server.ts', bytes: 1, sha: 'e'.repeat(64) }]), 'string', 'a case-only twin');
});

test('U-03: a new copy that never starts is never the one set to start with Windows; one that answered is', async () => {
  const { moveStartup, startupScript } = await import('../src/autostart.ts');
  const t = mkdtempSync(join(ROOT_TMP, 'startup-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TOMLIN_STARTUP_DIR: join(t, 'startup'), TOMLIN_INSTALL_ROOT: join(t, 'install') };
  const dir = join(t, 'startup');
  mkdirSync(dir, { recursive: true });
  const older = join(t, 'TOMLIN-1.0.0');
  const newer = join(t, 'TOMLIN-1.0.1');
  for (const [at, version] of [[older, '1.0.0'], [newer, '1.0.1']]) {
    mkdirSync(at);
    writeFileSync(join(at, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(at, 'Start TOMLIN.cmd'), '');
  }
  const startsNow = () => readFileSync(join(dir, 'TOMLIN.cmd'), 'utf8');
  try {
    writeFileSync(join(dir, 'TOMLIN.cmd'), startupScript(older, env));
    // The copy before hands over (restartInto): the Startup file is left on it until the new copy answers.
    const handOver = readFileSync(join(SRC, 'server/core.ts'), 'utf8').replace(/\r\n/g, '\n').split('export async function restartInto')[1].split('\n}\n')[0];
    assert.doesNotMatch(handOver, /autostart\(|startupOf\.set|moveStartup/, 'restartInto moves the Startup file before the new copy has answered');
    // Once it has answered (src/server.ts, started with TOMLIN_PREV), the new copy moves it to itself.
    const server = readFileSync(join(SRC, 'server.ts'), 'utf8');
    assert.match(server, /moveStartup\(prev, ROOT\)/);
    assert.equal(await moveStartup(older, newer, env), true);
    assert.equal(startsNow(), startupScript(newer, env));
    // A new copy that failed after an older version had already moved it: the copy started again takes it back.
    assert.match(server, /moveStartup\(failed, ROOT\)/);
    assert.equal(await moveStartup(newer, older, env), true);
    assert.equal(startsNow(), startupScript(older, env));
    // Pointed at neither (unticked): nothing is written.
    rmSync(join(dir, 'TOMLIN.cmd'));
    assert.equal(await moveStartup(newer, older, env), false);
    assert.throws(() => startsNow());
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('W-01: turning off needs the tick and the right PIN; a wrong PIN never turns it off and is limited', async () => {
  const lock = { kind: 'pin' as const, ...(await hashSecret('1357')) };
  const ran: string[] = [];
  let tick = true;
  let busy: string | null = null;
  const guard = new TryGuard({}, async () => undefined);
  const gate = { lock: () => lock, damaged: () => null, guard, pins: new HostPins({}, async () => undefined) };
  const side = powerOffSide({ allowed: () => tick, pcName: () => 'Made-up node', away: () => false, busy: () => busy, inUse: async () => null, pinCheck: (pin, who, host) => pinGate(gate, pin, who, 'power', host), supported: true, run: (_s, by) => void ran.push(by) });
  const who = { key: 'aaaaaaaaaaaaaaaa', name: 'Audit host', link: 'f'.repeat(64) };
  tick = false;
  assert.equal((await side({ appPin: '1357' }, who)).status, 403);
  tick = true;
  busy = 'answering';
  assert.equal((await side({ appPin: '1357' }, who)).status, 409);
  busy = null;
  for (let k = 0; k < 5; k++) assert.equal((await side({ appPin: '0000' }, who)).status, 403);
  assert.equal((await side({ appPin: '1357' }, who)).status, 429, 'locked after 5 wrong, even the right one');
  // A host PIN this link never got: refused, and nothing ran.
  assert.notEqual((await side({ hostPin: '123456' }, { ...who, key: 'dddddddddddddddd' })).status, 200);
  assert.deepEqual(ran, []);
  assert.equal((await side({ appPin: '1357' }, { ...who, key: 'eeeeeeeeeeeeeeee' })).status, 200);
  assert.deepEqual(ran, ['Audit host']);
});

test('W-02: "Allow host to turn this PC off" starts on, by choice; turning off still needs the right PIN (W-01)', () => {
  assert.equal(cleanAllow({}).off, true, 'the tick starts on');
  assert.equal(cleanAllow({ off: false }).off, false, 'an owner who unticks it keeps it off');
});
