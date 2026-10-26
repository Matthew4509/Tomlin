// Updates pushed to nodes (src/update.ts): which paths may cross, the app's file list, a whole update from one copy to
// another (only the changed files cross), its refusals, a busy node, a file changed
// on the way, Stop, and Start TOMLIN.cmd starting the new copy.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as update from '../src/update.ts';
import type { Wire } from '../src/carry.ts';

// Every folder made here is taken away when this file's tests end (left behind, the copy tests' fake models filled
// 47 GB of the temp folder in three days).
const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-update-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** A small copy of the app: what a release holds, plus what it never ships. */
function aCopy(parent: string, version: string, extra: Record<string, string> = {}) {
  const root = join(parent, `shelby-${version}`);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'shelby', version }),
    'Start TOMLIN.cmd': '@echo off\r\n',
    'src/server.ts': `// server ${version}\n`,
    'src/carry.ts': '// the same in both\n',
    'public/app.js': '// page\n',
    'node_modules/sharp/index.js': 'x'.repeat(5000),
    'test/empty.txt': '',
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  return root;
}

test('only app paths cross: inside the parts, plain names, never out of the folder or the private files', () => {
  assert.equal(update.safeAppPath('src/server.ts'), 'src/server.ts');
  assert.equal(update.safeAppPath('node_modules/@img/sharp-win32-x64/lib/libvips-42.dll'), 'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll');
  for (const bad of ['../evil.ts', 'src/../../x', '/src/a.ts', 'src\\a.ts', 'C:/x/src/a.ts', 'data/settings.json', 'src/partner.ts', 'src/scene.ts', 'build/x.zip', 'src/a.ts.', 'src//a.ts', 7]) assert.equal(update.safeAppPath(bad), null, String(bad));
});

test('the release list leaves out what never ships: PDF.js beyond its text reader, other systems, the private files', () => {
  // When the list moved here from tools/pack.ts (2.0.33) the PDF.js viewer line was lost and ~90 viewer files shipped.
  for (const p of ['node_modules/pdfjs-dist/legacy/web/pdf_viewer.mjs', 'node_modules/pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs', 'node_modules/pdfjs-dist/web/pdf_viewer.mjs', 'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs', 'node_modules/pdfjs-dist/legacy/build/pdf.mjs.map', 'node_modules/@napi-rs/canvas/index.js', 'node_modules/@img/sharp-linux-x64/lib/x.so', 'src/partner.ts', 'build/old.zip', 'x.gguf.part']) {
    assert.ok(update.SKIP.test(p) && update.SKIP.test(p.replace(/\//g, '\\')), p);
  }
  for (const p of ['node_modules/pdfjs-dist/legacy/build/pdf.mjs', 'node_modules/pdfjs-dist/standard_fonts/FoxitSans.pfb', 'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll', 'src/server.ts', 'runtime/node/node.exe']) {
    assert.equal(update.SKIP.test(p), false, p);
  }
});

test('the type check\'s tools never ship: every dev-only package in package-lock.json is left out, and no package the app runs', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { dev?: boolean }> };
  const pkgs = Object.entries(lock.packages).filter(([p]) => p.startsWith('node_modules/'));
  assert.ok(pkgs.some(([, v]) => v.dev), 'package-lock.json lists the dev tools');
  for (const [p, v] of pkgs) {
    const file = `${p}/package.json`;
    assert.equal(update.SKIP.test(file) && update.SKIP.test(file.replace(/\//g, '\\')), !!v.dev || /@napi-rs\/|@img\/sharp-(?!win32-x64|libvips-win32-x64)/.test(p), p);
  }
  for (const p of ['node_modules/.bin/tsc', 'node_modules/.bin/tsc.cmd', 'node_modules/.bin/tsc.ps1', 'node_modules\\typescript']) assert.ok(update.SKIP.test(p), p);
  assert.equal(update.SKIP.test('node_modules/.bin/semver.cmd'), false);
});

test('a list from a host is checked whole: form, repeats, size, and the files a copy cannot do without', () => {
  const ok = [{ path: 'package.json', bytes: 2, sha: 'a'.repeat(64) }, { path: 'src/server.ts', bytes: 1, sha: 'b'.repeat(64) }, { path: 'Start TOMLIN.cmd', bytes: 1, sha: 'c'.repeat(64) }];
  assert.equal((update.cleanManifest(ok) as update.AppFile[]).length, 3);
  assert.match(update.cleanManifest([...ok, { path: '../x', bytes: 1, sha: 'd'.repeat(64) }]) as string, /not named as an app file/);
  assert.match(update.cleanManifest([...ok, { ...ok[0] }]) as string, /named twice/);
  assert.match(update.cleanManifest(ok.slice(1)) as string, /no package.json/);
  assert.match(update.cleanManifest([...ok, { path: 'src/a.ts', bytes: 1, sha: 'nope' }]) as string, /not named/);
  assert.match(update.cleanManifest([{ ...ok[0], bytes: 3 * 2 ** 30 }, ...ok.slice(1)]) as string, /larger than an update/);
});

test('the app file list is what the release zip holds (the same parts), and hashes are kept between asks', async () => {
  const root = aCopy(tmp(), '2.0.33', { 'src/partner.ts': 'private', 'data/settings.json': '{}', 'build/old.zip': 'zip' });
  const cache = new Map<string, { key: string; sha: string }>();
  const files = await update.appFiles(root, cache);
  const paths = files.map(f => f.path);
  assert.ok(paths.includes('src/server.ts') && paths.includes('Start TOMLIN.cmd') && paths.includes('test/empty.txt'));
  for (const never of ['src/partner.ts', 'data/settings.json', 'build/old.zip']) assert.ok(!paths.includes(never), never);
  assert.equal(cache.size, files.length);
  const pack = readFileSync(new URL('../tools/pack.ts', import.meta.url), 'utf8');
  assert.match(pack, /import \{ PARTS, SKIP \} from '\.\.\/src\/update\.ts'/);
});

test('a version is newer number by number', () => {
  assert.equal(update.newer('2.0.33', '2.0.32'), true);
  assert.equal(update.newer('2.0.100', '2.0.99'), true);
  assert.equal(update.newer('2.0.32', '2.0.32'), false);
  assert.equal(update.newer('2.0.31', '2.0.32'), false);
});

/** A node running `oldVersion` in its own folder, its update doors, and a wire to them. */
function aNode(o: { allowed?: boolean; restarts?: boolean; busy?: () => string | null; extraOld?: Record<string, string>; build?: () => string; pin?: string } = {}) {
  const parent = tmp();
  const root = aCopy(parent, '2.0.32', { 'src/partner.ts': 'her own words', 'src/old-only.ts': 'gone in the new one', ...o.extraOld });
  const done: { dir: string; version: string; by: string; pulled?: boolean }[] = [];
  const handle = update.updateSide({
    root,
    version: '2.0.32',
    // Left out: a node from before build ids, which goes by the version alone.
    ...(o.build ? { build: o.build } : {}),
    allowed: () => o.allowed ?? true,
    pcName: () => 'Worker PC',
    restarts: o.restarts ?? true,
    busy: o.busy ?? (() => null),
    freeBytes: async () => Infinity,
    done: async (dir, version, by, pulled) => void done.push({ dir, version, by, ...(pulled ? { pulled } : {}) }),
    // Audit X2: a node that asks its own app lock PIN for an update pushed to it.
    ...(o.pin ? { pinCheck: async (v: unknown) => (v === o.pin ? { ok: true as const } : { status: 403, error: v ? 'says that PIN is wrong' : 'asks for its app lock PIN' }) } : {}),
  });
  const puts: string[] = [];
  const wire = (tamper = false): Wire => ({
    ask: async (p, b) => {
      const a = await handle(p, b, { key: 'b1b2b3b4', name: 'Laptop' });
      if (a.status !== 200) throw new Error(String(a.json.error));
      return a.json;
    },
    getPiece: async () => Buffer.alloc(0),
    putPiece: async (p, b, piece) => {
      puts.push(String(b.file));
      const a = await handle(p, b, { key: 'b1b2b3b4', name: 'Laptop' }, tamper ? Buffer.from(piece.toString().toUpperCase()) : piece);
      if (a.status !== 200) throw new Error(String(a.json.error));
      return a.json;
    },
  });
  return { parent, root, handle, wire, done, puts };
}

/** The host's copy: a newer version with one file changed and one added. */
function hostCopy() {
  return aCopy(tmp(), '2.0.33', { 'src/new-part.ts': '// new in 2.0.33\n' });
}

test('an update: only the changed files cross, the new copy is whole beside the old one, her files stay on that PC', async () => {
  const node = aNode();
  const host = hostCopy();
  const files = await update.appFiles(host);
  const seen: number[] = [];
  const stages: string[] = [];
  const folder = await update.pushUpdate(node.wire(), { version: '2.0.33', root: host, files, progress: p => {
    if (p.done !== undefined) seen.push(p.done);
    if (p.stage && stages.at(-1) !== p.stage) stages.push(p.stage);
  }, signal: new AbortController().signal });
  assert.equal(folder, 'tomlin-2.0.33');
  // The update screen's steps, in order: comparing the files, sending them, starting the new version there.
  assert.deepEqual(stages, ['compare', 'send', 'start']);
  // package.json, server.ts and the new file differ; carry.ts, the page, sharp and the empty file were already there.
  const crossed = node.puts.map(k => files[Number(k)].path).sort();
  assert.deepEqual(crossed, ['package.json', 'src/new-part.ts', 'src/server.ts']);
  const dir = join(node.parent, 'tomlin-2.0.33');
  assert.deepEqual(node.done, [{ dir, version: '2.0.33', by: 'Laptop' }]);
  for (const f of files) assert.equal(readFileSync(join(dir, ...f.path.split('/'))).length, f.bytes, f.path);
  assert.equal(readFileSync(join(dir, 'src', 'server.ts'), 'utf8'), '// server 2.0.33\n');
  // A file the removed private chat left in the old copy stays there: it is not carried into the new one.
  assert.equal(existsSync(join(dir, 'src', 'partner.ts')), false);
  assert.equal(existsSync(join(dir, 'src', 'old-only.ts')), false);
  assert.ok(existsSync(join(dir, 'models', 'chat')));
  // The old copy is as it was, for going back; the incoming folder is gone.
  assert.equal(readFileSync(join(node.root, 'src', 'server.ts'), 'utf8'), '// server 2.0.32\n');
  assert.deepEqual(readdirSync(node.parent).sort(), ['shelby-2.0.32', 'tomlin-2.0.33']);
});

test('an update is refused without the tick, when not newer, or when the node cannot start it by itself', async () => {
  const host = hostCopy();
  const files = await update.appFiles(host);
  const go = (n: ReturnType<typeof aNode>, version = '2.0.33') => update.pushUpdate(n.wire(), { version, root: host, files, progress: () => undefined, signal: new AbortController().signal });
  await assert.rejects(go(aNode({ allowed: false })), /Allow host to update TOMLIN/);
  await assert.rejects(go(aNode(), '2.0.32'), /only a newer version is taken/);
  await assert.rejects(go(aNode({ restarts: false })), /not started by its installed program or Start TOMLIN.cmd/);
});

// Audit X2 (26 Oct): an update pushed over the link carried no check beyond the tick, so any program on a linked PC (or
// someone holding its link keys) could run code on every node. Now the node's own app lock PIN is typed on the sending
// PC for each update: an admin knows it, a guest or a program does not. Pulling an update, started at the PC itself,
// will need none.
test('a node that asks its PIN takes no update without it or with a wrong one, and nothing crosses before it is right', async () => {
  const host = hostCopy();
  const files = await update.appFiles(host);
  const node = aNode({ pin: '4711' });
  const go = (pin?: string) => update.pushUpdate(node.wire(), { version: '2.0.33', root: host, files, ...(pin !== undefined ? { pin } : {}), progress: () => undefined, signal: new AbortController().signal });
  await assert.rejects(go(), /"Worker PC" asks for its app lock PIN\./);
  await assert.rejects(go('1234'), /"Worker PC" says that PIN is wrong/);
  assert.deepEqual(node.puts, [], 'not one file crossed');
  // The quick check before the update starts (the sending page asks again at once after a wrong one).
  assert.equal((await node.handle('/worker/update-pin', { appPin: '1234' }, { key: 'b1b2b3b4', name: 'Laptop' })).status, 403);
  assert.equal((await node.handle('/worker/update-pin', { appPin: '4711' }, { key: 'b1b2b3b4', name: 'Laptop' })).status, 200);
  assert.equal(await go('4711'), 'tomlin-2.0.33');
  assert.equal(node.done.length, 1);
});

test('a busy node is asked again until it is free; nothing restarts while it works for someone', async () => {
  let busyFor = 2;
  const node = aNode({ busy: () => (busyFor-- > 0 ? 'answering for a linked PC' : null) });
  const host = hostCopy();
  const waited: string[] = [];
  await update.pushUpdate(node.wire(), { version: '2.0.33', root: host, files: await update.appFiles(host), progress: () => undefined, signal: new AbortController().signal, waiting: b => waited.push(b), wait: async () => undefined });
  assert.deepEqual(waited, ['answering for a linked PC', 'answering for a linked PC']);
  assert.equal(node.done.length, 1);
});

test('a file changed on the way is thrown away, and nothing is started', async () => {
  const node = aNode();
  const host = hostCopy();
  await assert.rejects(update.pushUpdate(node.wire(true), { version: '2.0.33', root: host, files: await update.appFiles(host), progress: () => undefined, signal: new AbortController().signal }), /did not arrive as it was sent/);
  assert.equal(node.done.length, 0);
  assert.equal(existsSync(join(node.parent, 'tomlin-2.0.33')), false);
});

test('Stop clears what came in: the node keeps its old version and no new folder', async () => {
  const node = aNode();
  const host = hostCopy();
  const ac = new AbortController();
  const w = node.wire();
  const stopping: Wire = { ...w, putPiece: async (p, b, piece) => { const r = await w.putPiece(p, b, piece); ac.abort(); return r; } };
  await assert.rejects(update.pushUpdate(stopping, { version: '2.0.33', root: host, files: await update.appFiles(host), progress: () => undefined, signal: ac.signal }), /Stopped/);
  assert.deepEqual(readdirSync(node.parent), ['shelby-2.0.32']);
  assert.equal(node.done.length, 0);
});

test('the host says why a linked PC cannot be updated, and nothing when it is not behind', () => {
  const pc = { name: 'Worker PC', ok: true, version: '2.0.32', away: null, can: ['carry', 'update'], restarts: true, allowUpdate: true };
  assert.equal(update.updateWhy(pc, '2.0.33'), '');
  assert.equal(update.updateWhy({ ...pc, version: '2.0.33' }, '2.0.33'), null);
  assert.match(update.updateWhy({ ...pc, can: ['carry'], version: '2.0.31' }, '2.0.33')!, /runs 2.0.31.*install 2.0.33 there by hand this once \(Install TOMLIN\.cmd/);
  assert.match(update.updateWhy({ ...pc, allowUpdate: false }, '2.0.33')!, /Allow host to update TOMLIN/);
  assert.match(update.updateWhy({ ...pc, restarts: false }, '2.0.33')!, /Start TOMLIN.cmd/);
  assert.match(update.updateWhy({ ...pc, away: '2026-10-06T10:00:00Z' }, '2.0.33')!, /being used by its owner/);
});

test('Start TOMLIN.cmd starts the copy named in next-copy.txt when TOMLIN ends with code 76', () => {
  const cmd = readFileSync(new URL('../Start TOMLIN.cmd', import.meta.url), 'utf8');
  assert.equal(update.RESTART_INTO, 76);
  assert.match(cmd, /set "TOMLIN_CODE=%errorlevel%"/);
  assert.match(cmd, /if %TOMLIN_CODE%==76 goto next/);
  // A new copy that never answered: the one before it starts again (it answered once: .started-ok, no going back).
  assert.match(cmd, /set "TOMLIN_PREV=%CD%"\r\ncd \/d "%TOMLIN_NEXT%"/);
  assert.match(cmd, /if exist "\.started-ok" \(del "\.started-ok" & set TOMLIN_PREV=& set TOMLIN_FAILED=\)/);
  assert.match(cmd, /if defined TOMLIN_PREV goto back/);
  assert.match(cmd, /:back\r\n[\s\S]*set "TOMLIN_FAILED=%CD%"\r\ncd \/d "%TOMLIN_PREV%"/);
  assert.match(cmd, /set \/p TOMLIN_NEXT=<next-copy\.txt/);
  assert.match(cmd, /cd \/d "%TOMLIN_NEXT%"/);
  assert.equal(update.NEXT_COPY_FILE, 'next-copy.txt');
  assert.ok(cmd.includes('\r\n'), 'the script keeps Windows line ends');
});

test('the node says an update is coming in ("Keep this window open"), then that it is starting; a PC gone quiet is not updating it', async () => {
  const node = aNode();
  const host = hostCopy();
  assert.equal(node.handle.incoming(), null);
  const files = await update.appFiles(host);
  await node.wire().ask('/worker/update-offer', { version: '2.0.33', files });
  assert.deepEqual(node.handle.incoming(), { version: '2.0.33', from: 'Laptop', starting: false });
  assert.equal(node.handle.incoming(Date.now() + 3 * 60_000), null);
  await update.pushUpdate(node.wire(), { version: '2.0.33', root: host, files, progress: () => undefined, signal: new AbortController().signal });
  assert.deepEqual(node.handle.incoming(), { version: '2.0.33', from: 'Laptop', starting: true });
});

test('files that say another version than the one sent are refused, with the way out', async () => {
  const node = aNode();
  // The host started as 2.0.33, then its folder was changed to 2.0.34 under it.
  const host = aCopy(tmp(), '2.0.34', {});
  await assert.rejects(update.pushUpdate(node.wire(), { version: '2.0.33', root: host, files: await update.appFiles(host), progress: () => undefined, signal: new AbortController().signal }),
    /say TOMLIN 2\.0\.34, not 2\.0\.33 as sent.*close TOMLIN there, start it again, then update again/);
  assert.deepEqual(node.done, []);
});

test('a copy carries Start TOMLIN.cmd and no longer the Start Shelby.cmd forwarder (every PC runs 2.0.45 or newer)', () => {
  assert.ok(update.PARTS.includes('Start TOMLIN.cmd') && !update.PARTS.includes('Start Shelby.cmd'));
  assert.equal(existsSync(new URL('../Start Shelby.cmd', import.meta.url)), false);
});

test('a PC from before the TOMLIN name gets the launcher under the name it takes; its folder finds it either way', () => {
  const f = (path: string, sha = 'a'.repeat(64)) => ({ path, bytes: 10, sha });
  const files = [f('package.json'), f('src/server.ts'), f('Start TOMLIN.cmd', 'b'.repeat(64)), f('Start Shelby.cmd', 'c'.repeat(64)), f('Install TOMLIN.cmd')];
  // The list a 2.0.44 node (before the TOMLIN name) takes: no "Start TOMLIN.cmd" or "Install TOMLIN.cmd" in it.
  const before = ['src', 'public', 'tools', 'test', 'registry', 'runtime/node', 'runtime/llama-cpu', 'runtime/sd-cpu', 'runtime/llama-vulkan', 'runtime/sd-vulkan', 'node_modules', 'package.json', 'package-lock.json', 'runtimes.json', 'README.md', 'LICENSE', 'THIRD-PARTY.md', 'Start Shelby.cmd', 'Install Smart Manager.cmd', 'models/helpers/u2netp.onnx'];
  const older = update.forOlderNode(files);
  assert.ok(older.every(x => before.some(p => x.path === p || x.path.startsWith(`${p}/`))), JSON.stringify(older.map(x => x.path)));
  const launcher = older.find(x => x.path === 'Start Shelby.cmd');
  assert.deepEqual([launcher?.sha, launcher?.from], ['b'.repeat(64), 'Start TOMLIN.cmd'], 'the whole launcher, read from Start TOMLIN.cmd');
  assert.equal(older.filter(x => x.path === 'Start Shelby.cmd').length, 1);
  assert.ok(update.refusedNewNames(new Error('a file in the update was not named as an app file (Start TOMLIN.cmd), so the update was refused.')));
  assert.ok(!update.refusedNewNames(new Error('a file in the update was not named as an app file (src/x.ts), so the update was refused.')));
  // Start with Windows and the desktop shortcut use the launcher the folder has.
  const dir = mkdtempSync(join(tmpdir(), 'sm-launcher-'));
  try {
    writeFileSync(join(dir, 'Start Shelby.cmd'), '@echo off');
    assert.equal(update.launcherIn(dir), join(dir, 'Start Shelby.cmd'));
    writeFileSync(join(dir, 'Start TOMLIN.cmd'), '@echo off');
    assert.equal(update.launcherIn(dir), join(dir, 'Start TOMLIN.cmd'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The build id: what code a copy is, so one version number holding two apps shows as "different files" ----

test('a build id is a short hash of the files that run: any order, tests, packages, runners and launchers left out', () => {
  const f = (path: string, sha = 'a'.repeat(64)) => ({ path, sha });
  const code = [f('package.json'), f('src/server.ts', 'b'.repeat(64)), f('public/app.js', 'c'.repeat(64)), f('tools/pack.ts'), f('registry/x.json'), f('package-lock.json'), f('runtimes.json')];
  const id = update.buildIdOf(code);
  assert.ok(update.isBuild(id), id);
  assert.equal(update.shortBuild(id), id.slice(0, 7));
  assert.equal(update.buildIdOf([...code].reverse()), id, 'the order of the list does not count');
  // What changes nothing that runs, or is pinned elsewhere, or is named differently on an older PC, does not count.
  const extra = [f('node_modules/sharp/index.js'), f('runtime/node/node.exe'), f('runtime/llama-cpu/llama-server.exe'), f('test/update.test.ts'), f('README.md'), f('LICENSE'), f('THIRD-PARTY.md'), f('Start TOMLIN.cmd'), f('Start Shelby.cmd'), f('Install TOMLIN.cmd'), f('models/helpers/u2netp.onnx'), f('src/partner.ts')];
  assert.equal(update.buildIdOf([...code, ...extra]), id);
  // One changed file of the code is another build.
  assert.notEqual(update.buildIdOf(code.map(x => (x.path === 'src/server.ts' ? { ...x, sha: 'd'.repeat(64) } : x))), id);
  assert.notEqual(update.buildIdOf([...code, f('src/new-part.ts')]), id);
  assert.equal(update.buildIdOf(extra), '', 'no code: no build id');
  for (const bad of ['', 'abc', 'A'.repeat(16), 'g'.repeat(16), 7, null, undefined]) assert.equal(update.isBuild(bad), false, String(bad));
  assert.equal(update.shortBuild('nope'), '');
  // Every part counted is one the update sends (so the PC updated has the same build as the one that sent it).
  assert.ok(update.BUILD_PARTS.every(p => update.PARTS.includes(p)));
});

test('a copy\'s build id is read from its folder: the same as its file list says, and another after a code change', async () => {
  const root = aCopy(tmp(), '2.0.48', { 'src/partner.ts': 'private', 'data/settings.json': '{}' });
  const id = await update.buildId(root);
  assert.ok(update.isBuild(id));
  assert.equal(id, update.buildIdOf(await update.appFiles(root)), 'read alone, or from the list the update sends');
  put(root, 'test/empty.txt', 'a test changed');
  put(root, 'node_modules/sharp/index.js', 'y');
  assert.equal(await update.buildId(root), id, 'tests and packages do not count');
  put(root, 'src/carry.ts', '// changed under the same version\n');
  assert.notEqual(await update.buildId(root), id);
  assert.equal(await update.buildId(join(root, 'nothing-here')), '');
});

test('a linked PC stands older (lower version), other (same version, different files) or level; one with no build id goes by its version', () => {
  const a = 'a'.repeat(16);
  const b = 'b'.repeat(16);
  assert.equal(update.standing({ version: '2.0.47', build: a }, '2.0.48', a), 'older');
  assert.equal(update.standing({ version: '2.0.48', build: b }, '2.0.48', a), 'other');
  assert.equal(update.standing({ version: '2.0.48', build: a }, '2.0.48', a), null);
  assert.equal(update.standing({ version: '2.0.49', build: b }, '2.0.48', a), null, 'a newer PC is not behind');
  // An older TOMLIN sends no build id: same version = level, as before build ids.
  assert.equal(update.standing({ version: '2.0.48' }, '2.0.48', a), null);
  assert.equal(update.standing({ version: '2.0.48', build: '' }, '2.0.48', a), null);
  assert.equal(update.standing({ version: '2.0.47' }, '2.0.48', a), 'older');
  // This PC's own build not read yet: nothing is claimed.
  assert.equal(update.standing({ version: '2.0.48', build: b }, '2.0.48', ''), null);
  assert.equal(update.standing({ version: '' }, '2.0.48', a), null);
});

test('the host offers Update it for the same version with different files, and says nothing for the same files or an old PC', () => {
  const a = 'a'.repeat(16);
  const b = 'b'.repeat(16);
  const pc = { name: 'Worker PC', ok: true, version: '2.0.48', build: b, away: null, can: ['carry', 'update'], restarts: true, allowUpdate: true };
  assert.equal(update.updateWhy(pc, '2.0.48', a), '');
  assert.equal(update.updateWhy({ ...pc, build: a }, '2.0.48', a), null);
  assert.equal(update.updateWhy({ ...pc, build: undefined }, '2.0.48', a), null, 'an old PC with no build id: up to date by its version');
  assert.equal(update.updateWhy({ ...pc, build: undefined, version: '2.0.47' }, '2.0.48', a), '');
  assert.equal(update.updateWhy(pc, '2.0.48'), null, 'called without this PC\'s build: by version, as before');
  assert.match(update.updateWhy({ ...pc, ok: false }, '2.0.48', a)!, /"Worker PC" is off or not answering now/);
  assert.match(update.updateWhy({ ...pc, allowUpdate: false }, '2.0.48', a)!, /Allow host to update TOMLIN/);
});

test('a node takes the same version with different files, refuses the same files, and an old host at the same version as before', async () => {
  // The host: the same version as the node (2.0.32), but one file of code changed and one added.
  const host = aCopy(tmp(), '2.0.32', { 'src/new-part.ts': '// added under the same number\n' });
  const files = await update.appFiles(host);
  const go = (n: ReturnType<typeof aNode>) => update.pushUpdate(n.wire(), { version: '2.0.32', root: host, files, progress: () => undefined, signal: new AbortController().signal });
  let own = '';
  const node = aNode({ build: () => own });
  own = await update.buildId(node.root);
  assert.notEqual(own, update.buildIdOf(files));
  assert.equal(await go(node), 'tomlin-2.0.32');
  const dir = join(node.parent, 'tomlin-2.0.32');
  assert.deepEqual(node.done, [{ dir, version: '2.0.32', by: 'Laptop' }]);
  // The new copy is the build that was sent: it says so once it starts there.
  assert.equal(await update.buildId(dir), update.buildIdOf(files));
  // The same files: nothing to update.
  let same = '';
  const level = aNode({ build: () => same });
  same = update.buildIdOf(files);
  await assert.rejects(go(level), /already runs TOMLIN 2\.0\.32 with the same files \(build [0-9a-f]{7}\): there is nothing to update/);
  // Its own build not read yet (just started): try again in a minute.
  await assert.rejects(go(aNode({ build: () => '' })), /still reading its own files.*Press Update it again in a minute/);
  // A node from before build ids takes only a newer version, as before.
  await assert.rejects(go(aNode()), /only a newer version/);
  // A host from before build ids sends none: the same version is refused, as before.
  const quiet = aNode({ build: () => 'c'.repeat(16) });
  await assert.rejects(quiet.wire().ask('/worker/update-offer', { version: '2.0.32', files }), /only a newer version is taken \(or the same one with different files\)/);
  assert.equal(quiet.done.length, 0);
});

test('a build id that is not the files listed is refused before anything crosses', async () => {
  const node = aNode({ build: () => 'c'.repeat(16) });
  const host = hostCopy();
  const files = await update.appFiles(host);
  await assert.rejects(node.wire().ask('/worker/update-offer', { version: '2.0.33', build: 'd'.repeat(16), files }), /not build ddddddd as sent.*Close TOMLIN on the sending PC, start it again, then update again/);
  assert.equal(node.handle.incoming(), null);
});

test('half-come updates are not kept for ever: old ones go at start, another version\'s on an offer, nothing else', async () => {
  const parent = tmp();
  const root = aCopy(parent, '2.0.32');
  const old = Date.now() / 1000 - (update.INCOMING_DAYS + 1) * 24 * 3600;
  const plant = (name: string, age?: number) => {
    put(join(parent, name), 'src/a.ts.part', 'half');
    if (age) utimesSync(join(parent, name), age, age);
  };
  plant('.tomlin-2.0.30-incoming', old);
  plant('.shelby-2.0.29-incoming', old);
  plant('.tomlin-2.0.31-incoming');
  plant('tomlin-2.0.28', old);
  writeFileSync(join(parent, '.tomlin-notes-incoming'), 'not a folder of ours');
  utimesSync(join(parent, '.tomlin-notes-incoming'), old, old);
  const handle = update.updateSide({ root, version: '2.0.32', allowed: () => true, pcName: () => 'Worker PC', restarts: true, busy: () => null, freeBytes: async () => Infinity, done: async () => undefined });
  assert.deepEqual((await handle.swept).sort(), ['.shelby-2.0.29-incoming', '.tomlin-2.0.30-incoming']);
  const left = () => readdirSync(parent).sort();
  assert.deepEqual(left(), ['.tomlin-2.0.31-incoming', '.tomlin-notes-incoming', 'shelby-2.0.32', 'tomlin-2.0.28'], 'a recent one stays, to be carried on');
  const files = await update.appFiles(aCopy(tmp(), '2.0.33'));
  const r = await handle('/worker/update-offer', { version: '2.0.33', files }, { key: 'b1b2b3b4', name: 'Laptop' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(left(), ['.tomlin-notes-incoming', 'shelby-2.0.32', 'tomlin-2.0.28'], 'another version coming in clears the 2.0.31 one');
});

// A TOMLIN zip uploaded under This PC: models and updates (src/server/selfupdate.ts): only a whole, newer TOMLIN is taken.
test('zipWhy takes a whole newer TOMLIN, or the same version with other files, and nothing else', () => {
  const b1 = 'a'.repeat(16);
  const b2 = 'b'.repeat(16);
  assert.equal(update.zipWhy({ name: 'tomlin', version: '2.0.51' }, [], b2, '2.0.50', b1), '');
  assert.equal(update.zipWhy({ name: 'tomlin', version: '2.0.50' }, [], b2, '2.0.50', b1), '');
  assert.match(update.zipWhy({ name: 'tomlin', version: '2.0.50' }, [], b1, '2.0.50', b1), /already runs TOMLIN 2\.0\.50 with the same files/);
  assert.match(update.zipWhy({ name: 'tomlin', version: '2.0.50' }, [], '', '2.0.50', b1), /nothing to update/);
  assert.match(update.zipWhy({ name: 'tomlin', version: '2.0.47' }, [], b2, '2.0.50', b1), /older than the 2\.0\.50/);
  assert.match(update.zipWhy({ name: 'shelby', version: '2.0.51' }, [], b2, '2.0.50', b1), /not a TOMLIN release/);
  assert.match(update.zipWhy({ name: 'tomlin', version: 'x' }, [], b2, '2.0.50', b1), /not a TOMLIN release/);
  assert.match(update.zipWhy({ name: 'tomlin', version: '2.0.51' }, ['src/server.ts'], b2, '2.0.50', b1), /src\/server\.ts is missing/);
});

test('an older PC that refuses a file it does not know gets the same copy without it: the welcome page, then the old launcher name', () => {
  const f = (path: string) => ({ path, bytes: 1, sha: 'a'.repeat(64) });
  const files = [f('src/server.ts'), f('Start TOMLIN.cmd'), f('Install TOMLIN.cmd'), f('Welcome to TOMLIN.html')];
  const refused = (name: string) => new Error(`"Old node": a file in the update was not named as an app file (${name}), so the update was refused.`);
  // A TOMLIN-named PC before 2.0.50: only the welcome page goes.
  const one = update.retryFor(files, files, refused('Welcome to TOMLIN.html'))!;
  assert.deepEqual(one.map(x => x.path), ['src/server.ts', 'Start TOMLIN.cmd', 'Install TOMLIN.cmd']);
  // A PC from before the TOMLIN name then refuses the launcher: the old name, and still no welcome page.
  const two = update.retryFor(files, one, refused('Start TOMLIN.cmd'))!;
  assert.deepEqual(two.map(x => x.path), ['src/server.ts', 'Start Shelby.cmd']);
  // Refused again for the same names, or for anything else: no more tries.
  assert.equal(update.retryFor(files, two, refused('Start TOMLIN.cmd')), null);
  assert.equal(update.retryFor(files, one, refused('Welcome to TOMLIN.html')), null);
  assert.equal(update.retryFor(files, files, new Error('no room on that PC')), null);
  // The welcome page is not part of the build id, so leaving it out does not make the PC look different afterwards.
  assert.ok(update.NEWER_FILES.every(p => !update.BUILD_PARTS.some(b => p === b || p.startsWith(`${b}/`))));
});

// ---- Pulling an update (26 Oct): the person at a PC takes a newer TOMLIN from a linked PC that lets it ----
// A guest can never push an update to another PC (a push asks that PC's own app lock PIN, audit X2), but may pull one
// from the network. The PC giving it serves only its own app files, read-only, behind a tick of its own; the
// PC pulling it runs the very same checks a push gets (updateSide), called from itself, so it needs no PIN there.

/** The PC that gives an update: a newer copy with its doors, as its owner ticked (or not) "Let linked PCs pull…". */
async function aGiver(o: { allowed?: boolean; version?: string; build?: () => string; copyVersion?: string } = {}) {
  const root = aCopy(tmp(), o.copyVersion ?? o.version ?? '2.0.33', { 'src/new-part.ts': '// new in 2.0.33\n', 'src/partner.ts': 'private', 'data/settings.json': '{"secret":1}' });
  const own = await update.buildId(root);
  let allowed = o.allowed ?? true;
  const give = update.giveSide({ root, version: o.version ?? '2.0.33', build: o.build ?? (() => own), allowed: () => allowed, pcName: () => 'Big PC' });
  const gets: string[] = [];
  const wire = (w: { tamper?: boolean; list?: (v: Record<string, unknown>) => Record<string, unknown>; onPiece?: () => void } = {}): Wire => ({
    ask: async (p, b) => {
      const a = await give(p, b);
      if (a.status !== 200 || !('json' in a)) throw new Error(`"Big PC": ${String('json' in a ? a.json.error : 'a piece')}`);
      return w.list ? w.list(a.json) : a.json;
    },
    getPiece: async (p, b) => {
      const a = await give(p, b);
      if (!('piece' in a)) throw new Error(`"Big PC": ${String(a.json.error)}`);
      gets.push(String(b.path));
      w.onPiece?.();
      return w.tamper ? Buffer.from(a.piece.toString().toUpperCase()) : a.piece;
    },
    putPiece: async () => {
      throw new Error('a pull never sends a piece to the PC it pulls from');
    },
  });
  return { root, give, wire, gets, own, allow: (v: boolean) => void (allowed = v) };
}
const pullInto = (node: ReturnType<typeof aNode>) => (p: string, b: Record<string, unknown>, piece?: Buffer) => node.handle.here(p, b, 'Big PC', piece);
const errorOf = (a: { json: Record<string, unknown> } | { piece: Buffer }) => ('json' in a ? String(a.json.error ?? '') : '');

test('a PC gives only its own app files, read-only and behind its own tick; nothing else can be named', async () => {
  const g = await aGiver({ allowed: false });
  const refused = await g.give('/worker/update-list', {});
  assert.equal(refused.status, 403);
  assert.match(errorOf(refused), /"Big PC" does not let linked PCs pull TOMLIN updates from it \(its owner ticks "Let linked PCs pull TOMLIN updates from here" under Network\)/);
  assert.equal((await g.give('/worker/update-get', { version: '2.0.33', build: g.own, path: 'src/server.ts', from: 0 })).status, 403);
  g.allow(true);
  const list = await g.give('/worker/update-list', {});
  assert.equal(list.status, 200);
  const said = (list as { json: Record<string, unknown> }).json;
  assert.equal(said.version, '2.0.33');
  assert.equal(said.build, g.own);
  const files = said.files as update.AppFile[];
  assert.deepEqual(files, (await update.appFiles(g.root)).map(({ path, bytes, sha }) => ({ path, bytes, sha })));
  for (const never of ['src/partner.ts', 'data/settings.json']) assert.ok(!files.some(f => f.path === never), never);
  const get = (b: Record<string, unknown>) => g.give('/worker/update-get', { version: '2.0.33', build: g.own, from: 0, ...b });
  const piece = await get({ path: 'src/server.ts' });
  assert.ok('piece' in piece);
  assert.equal(piece.piece.toString(), '// server 2.0.33\n');
  assert.equal(((await get({ path: 'node_modules/sharp/index.js', from: 4000 })) as { piece: Buffer }).piece.length, 1000);
  // Only a file of the list it gave: no data, no private files, no way out of the folder, no other folder.
  for (const path of ['data/settings.json', 'src/partner.ts', '../shelby-2.0.32/src/server.ts', 'src/../data/settings.json', 'src/nothere.ts', 'C:/Windows/win.ini', 'SRC/SERVER.TS', 7]) {
    const a = await get({ path });
    assert.ok(!('piece' in a) && a.status === 404, `${String(path)}: ${a.status}`);
  }
  for (const from of [-1, 9999, 'x']) assert.equal((await get({ path: 'src/server.ts', from })).status, 400, String(from));
  // Another version or build than the list it gave: that list is not what it holds now.
  assert.equal((await get({ path: 'src/server.ts', version: '2.0.32' })).status, 409);
  assert.equal((await get({ path: 'src/server.ts', build: 'c'.repeat(16) })).status, 409);
  // Read-only: what it does not give is as it was.
  assert.equal(readFileSync(join(g.root, 'data', 'settings.json'), 'utf8'), '{"secret":1}');
});

test('a PC gives nothing when its folder is not the copy that runs, or before it has read its own files', async () => {
  // Started as 2.0.32, then 2.0.33 was unzipped over it.
  const moved = await aGiver({ version: '2.0.32', copyVersion: '2.0.33' });
  assert.match(errorOf(await moved.give('/worker/update-list', {})), /"Big PC" runs TOMLIN 2\.0\.32, but its folder now holds 2\.0\.33.*close TOMLIN there and start it again/);
  const other = await aGiver({ build: () => 'c'.repeat(16) });
  assert.match(errorOf(await other.give('/worker/update-list', {})), /its folder changed after TOMLIN started there.*close TOMLIN there and start it again/);
  const early = await aGiver({ build: () => '' });
  const a = await early.give('/worker/update-list', {});
  assert.equal(a.status, 409);
  assert.match(errorOf(a), /still reading its own files after starting.*in a minute/);
});

test('a pull: only the changed files come, the new copy is whole beside the old one, no PIN and no tick asked here', async () => {
  // The PC pulling asks its own PIN for a push and has its push tick off: neither is asked for a pull started on it.
  const node = aNode({ pin: '4711', allowed: false });
  const g = await aGiver();
  const stages: string[] = [];
  const got = await update.pullUpdate(g.wire(), pullInto(node), { progress: p => void (p.stage && stages.at(-1) !== p.stage && stages.push(p.stage)), signal: new AbortController().signal });
  assert.deepEqual(got, { version: '2.0.33', build: g.own, folder: 'tomlin-2.0.33' });
  assert.deepEqual(stages, ['compare', 'send', 'start']);
  assert.deepEqual(g.gets.sort(), ['package.json', 'src/new-part.ts', 'src/server.ts']);
  const dir = join(node.parent, 'tomlin-2.0.33');
  assert.deepEqual(node.done, [{ dir, version: '2.0.33', by: 'Big PC', pulled: true }]);
  assert.equal(await update.buildId(dir), g.own, 'the new copy is the build the other PC runs');
  assert.equal(readFileSync(join(dir, 'src', 'server.ts'), 'utf8'), '// server 2.0.33\n');
  for (const never of ['src/partner.ts', 'data/settings.json', 'src/old-only.ts']) assert.equal(existsSync(join(dir, ...never.split('/'))), false, never);
  assert.equal(readFileSync(join(node.root, 'src', 'server.ts'), 'utf8'), '// server 2.0.32\n', 'the old copy stays for going back');
  assert.deepEqual(readdirSync(node.parent).sort(), ['shelby-2.0.32', 'tomlin-2.0.33']);
  // Over the link the same PC still takes no push without its tick.
  const newer = aCopy(tmp(), '2.0.34');
  await assert.rejects(update.pushUpdate(node.wire(), { version: '2.0.34', root: newer, files: await update.appFiles(newer), pin: '4711', progress: () => undefined, signal: new AbortController().signal }), /Allow host to update TOMLIN/);
});

test('a pull checks what a push checks: not newer, a list that lies, a path out of the folder, a piece changed on the way', async () => {
  const go = (w: Wire, node = aNode()) => update.pullUpdate(w, pullInto(node), { progress: () => undefined, signal: new AbortController().signal });
  await assert.rejects(go((await aGiver({ version: '2.0.31' })).wire()), /already runs TOMLIN 2\.0\.32: only a newer version is taken/);
  const g = await aGiver();
  // The build it names is not its files.
  await assert.rejects(go(g.wire({ list: v => ({ ...v, build: 'd'.repeat(16) }) })), /not build ddddddd/);
  // No build named: a pull takes only a list that says what build it is.
  await assert.rejects(go(g.wire({ list: v => ({ ...v, build: undefined }) })), /did not say what build/);
  // A path out of the folder, or a private file: refused before anything comes.
  const node = aNode();
  for (const path of ['../evil.ts', 'data/settings.json', 'src/partner.ts']) {
    await assert.rejects(go(g.wire({ list: v => ({ ...v, files: [...(v.files as update.AppFile[]), { path, bytes: 1, sha: 'a'.repeat(64) }] }) }), node), /not named as an app file/, path);
  }
  assert.equal(node.handle.incoming(), null, 'nothing was offered');
  // A piece changed on the way: thrown away, nothing started, no new folder.
  const bad = aNode();
  await assert.rejects(go(g.wire({ tamper: true }), bad), /did not arrive as it was sent/);
  assert.equal(bad.done.length, 0);
  assert.equal(existsSync(join(bad.parent, 'tomlin-2.0.33')), false);
  // This PC cannot start a new copy by itself.
  await assert.rejects(go(g.wire(), aNode({ restarts: false })), /not started by its installed program or Start TOMLIN.cmd/);
});

test('Stop on a pull leaves this PC as it was; a pull and a push never come in at once', async () => {
  const node = aNode();
  const g = await aGiver();
  const ac = new AbortController();
  await assert.rejects(update.pullUpdate(g.wire({ onPiece: () => ac.abort() }), pullInto(node), { progress: () => undefined, signal: ac.signal }), /Stopped/);
  assert.deepEqual(readdirSync(node.parent), ['shelby-2.0.32']);
  assert.equal(node.done.length, 0);
  // A push coming in from a linked PC: a pull waits for it (and the other way round).
  const files = await update.appFiles(g.root);
  await node.wire().ask('/worker/update-offer', { version: '2.0.33', files });
  await assert.rejects(update.pullUpdate(g.wire(), pullInto(node), { progress: () => undefined, signal: new AbortController().signal }), /another PC is updating "Worker PC" now/);
  await node.wire().ask('/worker/update-drop', { version: '2.0.33' });
  const pulling = aNode();
  const offered = await pulling.handle.here('/worker/update-offer', { version: '2.0.33', build: g.own, files }, 'Big PC');
  assert.equal(offered.status, 200);
  await assert.rejects(pulling.wire().ask('/worker/update-offer', { version: '2.0.33', files }), /"Worker PC" is taking an update from "Big PC" now/);
});

test('this PC says when a linked PC has a newer TOMLIN it can pull, or why not, and nothing when it is not ahead', () => {
  const a = 'a'.repeat(16);
  const b = 'b'.repeat(16);
  const pc = { name: 'Big PC', ok: true, version: '2.0.62', build: b, away: null, can: ['carry', 'update', 'give'], allowGive: true };
  assert.equal(update.pullWhy(pc, '2.0.61', a, true), '');
  assert.equal(update.pullWhy({ ...pc, version: '2.0.61' }, '2.0.61', a, true), '', 'the same version with other files');
  assert.equal(update.pullWhy({ ...pc, version: '2.0.61', build: a }, '2.0.61', a, true), null, 'the same files');
  assert.equal(update.pullWhy({ ...pc, version: '2.0.60' }, '2.0.61', a, true), null, 'older: Update it is for that one');
  assert.match(update.pullWhy({ ...pc, ok: false }, '2.0.61', a, true)!, /"Big PC" is off or not answering now/);
  assert.match(update.pullWhy({ ...pc, can: ['carry', 'update'] }, '2.0.61', a, true)!, /"Big PC" runs TOMLIN 2\.0\.62 without the way to give updates.*Update it there/);
  assert.match(update.pullWhy({ ...pc, allowGive: false }, '2.0.61', a, true)!, /its owner can tick "Let linked PCs pull TOMLIN updates from here" there/);
  assert.match(update.pullWhy({ ...pc, away: '2026-10-26T10:00:00Z' }, '2.0.61', a, true)!, /being used by its owner/);
  assert.match(update.pullWhy(pc, '2.0.61', a, false)!, /TOMLIN on this PC was not started by its installed program or Start TOMLIN\.cmd/);
});
