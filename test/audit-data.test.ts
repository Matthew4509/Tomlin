// Audit of the app lock, saved data, backups, storage and model files (report only). Each test is named after its finding.
// A test marked { todo: 'P1' } shows a lesser fault that fails now; the others are P0 faults that fail now, or guards that
// pass and keep a rule that held. Everything is written under %TEMP%\tomlin-audit-data and removed at the end. No real
// model, runner, drive or internet is touched: downloads go to a stand-in server on 127.0.0.1.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOP = join(tmpdir(), 'tomlin-audit-data', `run-${process.pid}`);
mkdirSync(TOP, { recursive: true });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const user = process.env.USERNAME ?? '';

after(() => {
  rmSync(TOP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

// ---------------------------------------------------------------- in-process: pure modules

/** Makes reads of files whose path ends with `tail` fail as a scanner holding them would (EBUSY), until undone. */
function busyReads(tail: string): () => void {
  const sync = fs.readFileSync;
  const prom = fs.promises.readFile;
  const hit = (p: unknown) => String(p).toLowerCase().endsWith(tail.toLowerCase());
  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  fs.readFileSync = ((p: never, ...a: never[]) => { if (hit(p)) throw busy(); return (sync as (...x: unknown[]) => unknown)(p, ...a); }) as typeof fs.readFileSync;
  fs.promises.readFile = (async (p: never, ...a: never[]) => { if (hit(p)) throw busy(); return (prom as (...x: unknown[]) => unknown)(p, ...a); }) as typeof fs.promises.readFile;
  syncBuiltinESMExports();
  return () => {
    fs.readFileSync = sync;
    fs.promises.readFile = prom;
    syncBuiltinESMExports();
  };
}

test('D-01: a drive-jobs file that cannot be read for a moment is never saved over as empty (other drives keep their jobs)', async () => {
  const dj = await import('../src/drivejobs.ts');
  const dir = join(TOP, 'drivejobs');
  mkdirSync(dir, { recursive: true });
  const jobs = join(dir, 'drive-jobs.json');
  const pools = join(dir, 'drive-pools.json');
  dj.useFiles(jobs, pools);
  dj.setJobsHere('E:', ['store']);
  dj.setJobsHere('F:', ['backups']);
  const undo = busyReads('drive-jobs.json');
  try {
    // The Network page sets one more drive while a virus scanner holds the file.
    try { dj.setJobsHere('G:', ['store']); } catch { /* refusing is fine */ }
  } finally {
    undo();
  }
  const kept = JSON.parse(readFileSync(jobs, 'utf8'));
  assert.deepEqual(kept['E:'], ['store'], 'E: lost its Model store job');
  assert.deepEqual(kept['F:'], ['backups'], 'F: lost its Backups job');
});

test('A-01 (guard): a settings read that fails for a moment is a fault, never an empty file read as "no settings"', async () => {
  const { readData } = await import('../src/atomic.ts');
  const f = join(TOP, 'busy-settings.json');
  writeFileSync(f, JSON.stringify({ tone: 'kept' }));
  const undo = busyReads('busy-settings.json');
  try {
    await assert.rejects(readData(f, {}), /EBUSY/);
  } finally {
    undo();
  }
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).tone, 'kept');
});

test('A-02 (guard): a refused settings write leaves the file whole and the settings in memory as the file holds them', async () => {
  const { Store } = await import('../src/store.ts');
  const dir = join(TOP, 'store-ro');
  mkdirSync(dir, { recursive: true });
  const st = new Store(dir);
  await st.saveSettings({ tone: 'warm' });
  const file = join(dir, 'settings.json');
  const before = readFileSync(file, 'utf8');
  chmodSync(file, 0o444);
  try {
    await assert.rejects(st.saveSettings({ tone: 'formal' }));
  } finally {
    chmodSync(file, 0o666);
  }
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal((await st.settings()).tone, 'warm');
});

test('A-03 (guard): a damaged settings file is set aside, never written over', async () => {
  const { Store } = await import('../src/store.ts');
  const dir = join(TOP, 'store-damaged');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), '{"tone": "warm", "remo');
  const st = new Store(dir);
  await st.saveSettings({ tone: 'formal' });
  const aside = readdirSync(dir).find(n => n.startsWith('settings.json.damaged-'));
  assert.ok(aside, 'the damaged file was not kept');
  assert.equal(readFileSync(join(dir, aside!), 'utf8'), '{"tone": "warm", "remo');
});

test('R-01 (guard): a recovery code whose use cannot be saved opens nothing and is not spent', async () => {
  const { RecoveryCodes, hashCodes, makeCodes } = await import('../src/recovery.ts');
  const plain = makeCodes();
  let fail = true;
  const rc = new RecoveryCodes(await hashCodes(plain.slice(0, 2)), async () => { if (fail) throw new Error('disk full'); });
  await assert.rejects(rc.use(plain[0]));
  assert.equal(rc.left(), 2);
  fail = false;
  assert.equal(await rc.use(plain[0]), true);
  assert.equal(await rc.use(plain[0]), false, 'a code worked twice');
  // Two tries at once with the same code: only one wins.
  const both = await Promise.all([rc.use(plain[1]), rc.use(plain[1])]);
  assert.deepEqual(both.sort(), [false, true]);
});

test('M-01: a move never deletes a model because a different file of the same name and size is in the new folder', async () => {
  const { moveFiles } = await import('../src/modelhome.ts');
  const a = join(TOP, 'move-a', 'chat');
  const b = join(TOP, 'move-b', 'chat');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, 'm.gguf'), 'GGUF-old-revision-AAAA');
  writeFileSync(join(b, 'm.gguf'), 'GGUF-new-revision-BBBB');
  const s = await moveFiles([{ rel: 'chat/m.gguf', path: join(a, 'm.gguf'), bytes: 22 }], join(TOP, 'move-b'));
  assert.ok(existsSync(join(a, 'm.gguf')), `the only copy of that revision was deleted: ${s.said}`);
});

test('K-01: putting an old backup back keeps this PC\'s PIN and its spent recovery codes spent', async () => {
  const keep = await import('../src/keep.ts');
  const home = join(TOP, 'keep-home');
  const h = { home, data: join(home, 'data'), models: join(home, 'models'), runtime: join(home, 'runtime'), backups: join(home, 'backups'), modelsFile: join(home, 'models-folder.txt') };
  mkdirSync(h.data, { recursive: true });
  writeFileSync(join(h.data, 'settings.json'), '{}');
  writeFileSync(join(h.data, 'app-lock.json'), JSON.stringify({ salt: 'old', hash: 'old-pin', idleMinutes: 0 }));
  writeFileSync(join(h.data, 'recovery-codes.json'), JSON.stringify({ made: 'x', codes: [{ salt: 's', hash: 'h', cost: 16384, used: null }] }));
  const name = await keep.backup(h, 'by hand');
  // Since: a new PIN, and the code was used.
  writeFileSync(join(h.data, 'app-lock.json'), JSON.stringify({ salt: 'new', hash: 'new-pin', idleMinutes: 0 }));
  writeFileSync(join(h.data, 'recovery-codes.json'), JSON.stringify({ made: 'x', codes: [{ salt: 's', hash: 'h', cost: 16384, used: '2026-11-27T00:00:00Z' }] }));
  const said = await keep.restore(h, name, '9.9.9');
  assert.match(said, /^Restored/);
  assert.equal(JSON.parse(readFileSync(join(h.data, 'app-lock.json'), 'utf8')).hash, 'new-pin', 'the old PIN came back, and nothing said so');
  assert.ok(JSON.parse(readFileSync(join(h.data, 'recovery-codes.json'), 'utf8')).codes[0].used, 'a spent recovery code works again');
});

// ---------------------------------------------------------------- downloads against a stand-in server on 127.0.0.1

let stand: Server;
let standBase = '';
const FILE = randomBytes(256 * 1024);
/** How the stand-in answers /f: 'ok' (with Range), 'html' (200 with a web page), 'endless' (far more than listed), 'stall'. */
let mode: 'ok' | 'html' | 'endless' | 'stall' = 'ok';
const held: import('node:http').ServerResponse[] = [];

before(async () => {
  stand = createServer((req, res) => {
    if (mode === 'html') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Sign in</html>');
    if (mode === 'stall') {
      res.writeHead(200, { 'content-length': String(FILE.length) });
      res.write(FILE.subarray(0, 10));
      held.push(res);
      return;
    }
    if (mode === 'endless') {
      res.writeHead(200);
      let sent = 0;
      const more = () => {
        while (sent < 8 * FILE.length) {
          sent += FILE.length;
          if (!res.write(FILE)) return void res.once('drain', more);
        }
        res.end();
      };
      return more();
    }
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const from = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { 'content-length': String(FILE.length - from) });
    res.end(FILE.subarray(from));
  }).listen(0, '127.0.0.1');
  await new Promise(r => stand.once('listening', r));
  standBase = `http://127.0.0.1:${(stand.address() as { port: number }).port}`;
});
after(() => {
  for (const r of held) r.destroy();
  stand?.close();
});

test('DL-01 (guard): a download cut off part way carries on from its .part, is checked, and only then kept', async () => {
  const { fetchChecked } = await import('../src/download.ts');
  mode = 'ok';
  const dest = join(TOP, 'dl1', 'model.gguf');
  const ac = new AbortController();
  await assert.rejects(fetchChecked(`${standBase}/f`, dest, FILE.length, sha(FILE), p => { if (p.got > 1000 && !p.checking) ac.abort(); }, ac.signal));
  assert.ok(!existsSync(dest), 'an unchecked file was kept');
  assert.ok(existsSync(`${dest}.part`));
  assert.equal(await fetchChecked(`${standBase}/f`, dest, FILE.length, sha(FILE)), 'kept');
  assert.ok(readFileSync(dest).equals(FILE));
  assert.ok(!existsSync(`${dest}.part`));
});

test('DL-02 (guard): a 200 answer with a web page instead of the file is never kept', async () => {
  const { fetchChecked } = await import('../src/download.ts');
  mode = 'html';
  const dest = join(TOP, 'dl2', 'model.gguf');
  await assert.rejects(fetchChecked(`${standBase}/f`, dest, FILE.length, sha(FILE)), /SHA-256/);
  assert.ok(!existsSync(dest) && !existsSync(`${dest}.part`));
});

test('DL-03: a download stops writing once it has more bytes than the file is listed with (a server that never ends cannot fill the drive)', async () => {
  const { fetchChecked } = await import('../src/download.ts');
  mode = 'endless';
  const dest = join(TOP, 'dl3', 'model.gguf');
  let most = 0;
  await assert.rejects(fetchChecked(`${standBase}/f`, dest, FILE.length, sha(FILE), p => { most = Math.max(most, p.got); }));
  assert.ok(most <= FILE.length, `wrote ${most} bytes for a file of ${FILE.length}`);
});

test('DL-04: a download whose server stops sending ends with a fault instead of holding the downloads list for ever', { timeout: 120_000 }, async () => {
  const { fetchChecked } = await import('../src/download.ts');
  mode = 'stall';
  const dest = join(TOP, 'dl4', 'model.gguf');
  const outcome = await Promise.race([
    fetchChecked(`${standBase}/f`, dest, FILE.length, sha(FILE)).then(() => 'kept', () => 'fault'),
    new Promise(r => setTimeout(() => r('still waiting'), 90_000)),
  ]);
  assert.equal(outcome, 'fault', 'a stalled download waited 90 s with no end in sight');
});

test('DL-05 (guard): a saved downloads list cannot name a file outside its model folder', async () => {
  const DQ = await import('../src/dlqueue.ts');
  const ok = { id: 'd1', repo: 'a/b', name: 'm', files: [{ path: 'x.gguf', bytes: 1, sha256: 'a'.repeat(64) }], to: 'models' };
  for (const path of ['../x.gguf', '..\\x.gguf', 'a/../../x.gguf', '/x.gguf', '\\x.gguf', 'C:\\x.gguf', 'c:x.gguf']) {
    assert.equal(DQ.cleanItem({ ...ok, files: [{ ...ok.files[0], path }] }), null, path);
  }
  assert.equal(DQ.cleanItem({ ...ok, to: 'store', drive: 'C:\\Windows' }), null);
});

// ---------------------------------------------------------------- one real TOMLIN copy

let pc: Pc;
let home = '';
let chat = '';
const SPLIT = (n: number) => `Split-7B-Q4_K_M-0000${n}-of-00003.gguf`;
const QUEUED = { id: 'dqaudit1', repo: 'owner/Model-GGUF', rev: 'main', name: 'Model-Q4_K_M', bytes: 10, files: [{ path: 'Model-Q4_K_M.gguf', bytes: 10, sha256: 'b'.repeat(64) }], to: 'models', drive: '', state: 'stopped', got: 3, error: '', added: '2026-11-01T00:00:00.000Z', ended: '2026-11-01T00:01:00.000Z', by: 'This PC' };

const denyRead = (file: string) => execFileSync('icacls', [file, '/deny', `${user}:(RD)`], { windowsHide: true });
const allowRead = (file: string) => execFileSync('icacls', [file, '/remove:d', user], { windowsHide: true });

before(async () => {
  home = join(TOP, 'pc');
  const data = join(home, 'data');
  chat = join(home, 'models', 'chat');
  mkdirSync(data, { recursive: true });
  mkdirSync(chat, { recursive: true });
  const noOllama = join(TOP, 'no-ollama');
  mkdirSync(noOllama, { recursive: true });
  // Models: a split model with its middle part missing; another whole split model; a plain one to hide.
  writeFileSync(join(chat, SPLIT(1)), 'G'.repeat(300));
  writeFileSync(join(chat, SPLIT(3)), 'G'.repeat(300));
  for (let i = 1; i <= 3; i++) writeFileSync(join(chat, `Held-3B-Q4_K_M-0000${i}-of-00003.gguf`), 'H'.repeat(200));
  writeFileSync(join(chat, 'Hide-1B-Q4_K_M.gguf'), 'K'.repeat(100));
  // Saved data the copy reads at start: the downloads list (one stopped download), the hidden list (read-only below).
  writeFileSync(join(data, 'download-queue.json'), JSON.stringify([QUEUED], null, 2));
  writeFileSync(join(data, 'hidden-models.json'), '[]');
  chmodSync(join(data, 'hidden-models.json'), 0o444);
  // The downloads list cannot be read while the copy starts (a scanner, or a permission set wrong for a moment).
  denyRead(join(data, 'download-queue.json'));
  try {
    pc = await startPc({ root: ROOT, home, env: { OLLAMA: noOllama } });
  } finally {
    allowRead(join(data, 'download-queue.json'));
  }
});
after(async () => {
  try { chmodSync(join(home, 'data', 'hidden-models.json'), 0o666); } catch { /* gone */ }
  try { chmodSync(join(home, 'data', 'app-lock.json'), 0o666); } catch { /* gone */ }
  await pc?.stop();
});

test('Q-01: a downloads list that could not be read at start is never shown empty and then saved over', async () => {
  const file = join(home, 'data', 'download-queue.json');
  const shown = (await pc.get('/api/download-queue')).body?.lines ?? [];
  // Download again on any line (here one no longer listed) saves the list.
  await pc.post('/api/download-queue/again', { id: 'not-there' });
  // The list is saved behind the answer: give it a moment to land.
  await until('the list to be saved', async () => !readFileSync(file, 'utf8').includes(QUEUED.id), 5_000, 200).catch(() => null);
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(kept.some((x: { id: string }) => x.id === QUEUED.id), 'the stopped download was wiped from the saved list');
  assert.ok(shown.some((x: { id: string }) => x.id === QUEUED.id), 'the list was shown empty although a download was saved in it');
});

test('Q-02: a damaged downloads list is set aside, not written over', async () => {
  const data = join(home, 'data');
  // The copy reads the list once; this checks the read in src/server/hf.ts by its own rule, with a fresh read.
  const src = readFileSync(join(ROOT, 'src', 'server', 'hf.ts'), 'utf8');
  const reader = /function dlNow\(\)[\s\S]*?\n}/.exec(src)?.[0] ?? '';
  assert.match(reader, /readData|readJson|DamagedFile|setAside/, `the list is read with a bare catch that reads any fault as an empty list: ${reader.split('\n').slice(2, 7).join(' ').trim()}`);
  assert.ok(existsSync(data));
});

test('E-01: Delete removes every part of a split model that is not complete, or says what it left', async () => {
  const rows = (await pc.post('/api/cleanup', {})).body.rows as { id: string; name: string; bytes: number }[];
  const row = rows.find(r => r.id === SPLIT(1));
  assert.ok(row, JSON.stringify(rows.map(r => r.id)));
  const r = await pc.post('/api/models/delete', { id: row!.id, kind: 'chat' });
  const left = readdirSync(chat).filter(n => n.startsWith('Split-7B'));
  if (r.status === 200) assert.deepEqual(left, [], `"${r.body.said}" but ${left.join(', ')} is still on the disk, and the model is listed again`);
  else assert.match(r.body.error, /part/, 'refused without naming the parts');
});

test('E-02: Delete of a split model with one part held by another program says what was deleted and what was not', { timeout: 60_000 }, async () => {
  const part2 = join(chat, 'Held-3B-Q4_K_M-00002-of-00003.gguf');
  // Another program (LM Studio, say) has part 2 open with no sharing.
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f=[IO.File]::Open('${part2.replace(/'/g, "''")}','Open','Read','None'); 'held'; Start-Sleep 50; $f.Close()`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise<void>((res, rej) => { ps.stdout!.once('data', () => res()); ps.once('exit', () => rej(new Error('the holder did not start'))); });
    const r = await pc.post('/api/models/delete', { id: 'Held-3B-Q4_K_M-00001-of-00003.gguf', kind: 'chat' });
    const left = readdirSync(chat).filter(n => n.startsWith('Held-3B'));
    assert.notEqual(r.status, 200, 'it said deleted');
    // Either nothing went (the model still loads), or the words say which parts went.
    assert.ok(left.length === 3 || /part/.test(r.body.error), `"${r.body.error}" while ${3 - left.length} of 3 parts were already deleted: the model is broken and the words say nothing went`);
  } finally {
    if (ps.pid) try { process.kill(ps.pid); } catch { /* ended */ }
  }
});

test('H-01: Hide says saved only when it is saved on disk', { timeout: 60_000 }, async () => {
  const r = await pc.post('/api/models/hide', { id: 'Hide-1B-Q4_K_M.gguf', hidden: true });
  const onDisk = JSON.parse(readFileSync(join(home, 'data', 'hidden-models.json'), 'utf8'));
  assert.ok(r.status !== 200 || onDisk.includes('Hide-1B-Q4_K_M.gguf'), 'answered ok, but the file was read-only and nothing was saved: after a restart the model is shown and can be deleted');
});

test('S-01: two windows changing permissions never silently undo each other\'s change (the page\'s own save code)', async () => {
  const js = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  const start = js.indexOf('app.permissionRows = (onChange) => {');
  assert.ok(start > 0);
  let depth = 0;
  let end = js.indexOf('{', start);
  for (let i = end; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const fnText = js.slice(js.indexOf('(onChange)', start), end);
  type Node = { tag: string; kids: Node[]; listeners: Record<string, () => void>; checked?: boolean; textContent?: string; [k: string]: unknown };
  const el = (tag: string, attrs: Record<string, unknown> = {}, ...kids: Node[]): Node => ({ tag, ...attrs, kids, listeners: {}, addEventListener(t: string, f: () => void) { (this as Node).listeners[t] = f; } }) as Node;
  const api = async (path: string, body: unknown) => {
    const r = await pc.post(path, body);
    if (r.status !== 200) throw new Error(r.body?.error);
    return r.body;
  };
  const snapshot = (await api('/api/settings', {})).permissions;
  assert.equal(snapshot.files, 'ask');
  assert.equal(snapshot.web, 'ask');
  const windowOf = () => {
    const app = { models: { settings: { permissions: structuredClone(snapshot) } }, PERMISSION_KINDS: [{ kind: 'files', name: 'Files', what: '' }, { kind: 'web', name: 'Web', what: '' }] };
    const rows = new Function('app', 'el', 'api', `return ${fnText}`)(app, el, api)() as Node;
    const boxes: Node[] = [];
    const walk = (n: Node) => { if (n?.tag === 'input' && n['aria-label']) boxes.push(n); for (const k of n?.kids ?? []) walk(k); };
    walk(rows);
    return (name: string) => boxes.find(b => String(b['aria-label']).startsWith(name))!;
  };
  const a = windowOf();
  const b = windowOf();
  // Window A: Files to Auto. Window B, opened before, then Web to Auto.
  const fa = a('Files');
  fa.checked = true;
  fa.listeners.change();
  await until('window A\'s save', async () => (await api('/api/settings', {})).permissions.files === 'auto', 10_000, 100);
  const wb = b('Web');
  wb.checked = true;
  wb.listeners.change();
  await until('window B\'s save', async () => (await api('/api/settings', {})).permissions.web === 'auto', 10_000, 100);
  const now = (await api('/api/settings', {})).permissions;
  assert.equal(now.files, 'auto', 'window B silently put Files back to Manual');
  assert.equal(now.web, 'auto');
});

// ---- The app lock: last on this copy (it locks it, and wrong tries pause it) ----

let codes: string[] = [];
const PIN = '8642';

test('L-01 (guard): set, the lock shuts every door of this area, and the PIN never comes back in an answer or a log', async () => {
  const set = await pc.post('/api/applock', { action: 'set', kind: 'pin', pin: PIN, pin2: PIN, agree: true });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  codes = set.body.recoveryCodes;
  assert.equal(codes.length, 10);
  pc.cookie = '';
  for (const p of ['/api/keep', '/api/models/where', '/api/backups/where', '/api/download-queue', '/api/hflist', '/api/nodes', '/api/rules']) {
    assert.equal((await pc.get(p)).status, 423, p);
  }
  for (const p of ['/api/settings', '/api/keep', '/api/models/delete', '/api/models/hide', '/api/models/where', '/api/models/move', '/api/cleanup', '/api/storage/drives', '/api/backups/where', '/api/download-queue/clear', '/api/chatmodels/get']) {
    assert.equal((await pc.post(p, {})).status, 423, p);
  }
  // Odd spellings of an /api address.
  for (const p of ['/api//keep', '/api/./keep', '/API/keep', '/api/keep/', '/%61pi/keep']) {
    const r = await fetch(pc.base + p);
    assert.ok(r.status === 423 || r.status === 404, `${p}: ${r.status}`);
  }
  const view = await pc.get('/api/applock');
  assert.equal(view.body.open, false);
  assert.ok(!JSON.stringify(view.body).includes(PIN));
  const ok = await pc.post('/api/applock', { action: 'unlock', pin: PIN });
  assert.equal(ok.status, 200);
  assert.ok(!JSON.stringify(ok.body).includes(PIN) && !JSON.stringify(set.body).includes(PIN));
  const logs = join(home, 'data', 'logs');
  for (const f of existsSync(logs) ? readdirSync(logs) : []) assert.ok(!readFileSync(join(logs, f), 'utf8').includes(PIN), f);
  assert.ok(!pc.said().includes(PIN), 'the PIN is in the console output');
  assert.ok(!readFileSync(join(home, 'data', 'app-lock.json'), 'utf8').includes(PIN));
});

test('L-02: a recovery code is not spent when the new PIN it was for cannot be saved', { timeout: 60_000 }, async () => {
  const file = join(home, 'data', 'app-lock.json');
  const left = (await pc.get('/api/applock')).body.codes.left;
  chmodSync(file, 0o444);
  let r;
  try {
    r = await pc.post('/api/applock', { action: 'recover', code: codes[0], kind: 'pin', pin: '1357', pin2: '1357' });
  } finally {
    chmodSync(file, 0o666);
  }
  const after = (await pc.get('/api/applock')).body.codes.left;
  assert.ok(r.status === 200 || after === left, `refused (${r.status}: ${r.body?.error}) and the code was spent anyway: ${left} codes before, ${after} after`);
});

test('L-03 (guard): wrong PINs are limited, sent one after another or all at once', async () => {
  pc.cookie = '';
  await pc.post('/api/applock', { action: 'lock' });
  const tries = await Promise.all(Array.from({ length: 12 }, () => pc.post('/api/applock', { action: 'unlock', pin: '0000' })));
  const checked = tries.filter(t => t.status === 403).length;
  assert.ok(checked <= 5, `${checked} wrong PINs were checked`);
  assert.ok(tries.some(t => t.status === 429));
  // The right one waits too.
  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: PIN })).status, 429);
  assert.equal((await pc.get('/api/keep')).status, 423);
});

// ---------------------------------------------------------------- two real TOMLIN copies

test('C-01: Free up space on a linked PC gives the free space of the drive its models are on, not its backups drive', { timeout: 600_000 }, async () => {
  const top = join(TOP, 'two');
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    const nchat = join(nodeDir, 'models', 'chat');
    mkdirSync(nchat, { recursive: true });
    writeFileSync(join(nchat, 'Gemma-3-4B-Q4_K_M.gguf'), 'G'.repeat(900));
    // That PC keeps other PCs' backups on another drive than its models (here one not plugged in now).
    const letter = [...'QRSTUVWXYZ'].find(l => !existsSync(`${l}:\\`));
    assert.ok(letter, 'no free drive letter for the test');
    writeFileSync(join(nodeDir, 'backups-home.txt'), `${letter}:\\TOMLIN backups\r\n`);
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama, { recursive: true });
    const node = await startPc({ root: ROOT, home: nodeDir, env: { OLLAMA: noOllama } });
    pcs.push(node);
    const host = await startPc({ root: ROOT, home: join(top, 'host'), env: { OLLAMA: noOllama } });
    pcs.push(host);
    const id = await link(host, workerPort);
    await unlock(node);
    const seen = async () => ((await host.get('/api/nodes/others')).body.pcs as any[]).find(x => x.id === id);
    const told = await until('the node to tell its drives', async () => {
      const s = await seen();
      return s?.ok && s.modelsDrive && (s.drives ?? []).some((d: { drive: string }) => d.drive === s.modelsDrive) ? s : null;
    }, 240_000, 1000);
    const models = told.drives.find((d: { drive: string }) => d.drive === told.modelsDrive);
    // A few hellos later (the backups drive is read behind, every 30 s).
    await until('a cleanup answer with a free space', async () => (await host.post('/api/cleanup', { pc: id })).body?.disk, 75_000, 5000).catch(() => null);
    const view = (await host.post('/api/cleanup', { pc: id })).body;
    assert.ok(view.disk, `"${view.name}: the free space is not known" although it told its models drive ${told.modelsDrive} (${models.free} bytes free)`);
    assert.equal(view.disk.total, models.total, 'the size is of another drive than the models');
  } finally {
    for (const p of pcs) await p.stop();
  }
});

void statSync;
