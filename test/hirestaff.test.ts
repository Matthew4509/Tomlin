// Hire staff as a walk found it: slow to open (it waited on every linked PC, 3 s for one that is off), two linked PCs
// both called "Worker PC", Push to node putting the off PC's reason on the other PCs' rows, buttons squeezing the words
// in a narrow window, no name on opening, and a look drawn at random whatever the name.
// Run: node --test test/hirestaff.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { codeIn, freePort, link, nodeHome, startPc, until, type Pc } from './pcs.ts';
import { driveReportNow } from '../src/modelhome.ts';
import { LOOK_OPTIONS } from '../src/look.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const hire = read('public/hire.js');
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, to);
  return src.slice(a, b);
};

// ---- Two PCs that are on, one that is off, and one name for both ----

test('two PCs both named "Worker PC": the staff list tells them apart, answers at once from what each said last, and an off PC is off, not the others', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-hirestaff-'));
  const pcs: Pc[] = [];
  try {
    const portA = await freePort();
    const portB = await freePort();
    nodeHome(join(top, 'a'), portA, 'Worker PC', 'aaaa1111');
    nodeHome(join(top, 'b'), portB, 'Worker PC', 'bbbb2222');
    mkdirSync(join(top, 'a', 'models', 'chat'), { recursive: true });
    writeFileSync(join(top, 'a', 'models', 'chat', 'Shared-2B-Q4_K_M.gguf'), 'G'.repeat(700));
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama);
    const a = await startPc({ root: ROOT, home: join(top, 'a'), env: { OLLAMA: noOllama } });
    pcs.push(a);
    const b = await startPc({ root: ROOT, home: join(top, 'b'), env: { OLLAMA: noOllama } });
    pcs.push(b);
    const host = await startPc({ root: ROOT, home: join(top, 'host'), env: { OLLAMA: noOllama } });
    pcs.push(host);
    const idA = await link(host, portA, codeIn(join(top, 'a')));
    const idB = await link(host, portB, codeIn(join(top, 'b')));
    const others = async () => (await host.get('/api/nodes/others')).body.pcs as { id: string; ok: boolean }[];
    await until('both hellos', async () => (await others()).every(p => p.ok), 30_000);

    // Both on: each with a name of its own (the same name, then its address), and on.
    const known = async () => {
      const t0 = Date.now();
      const r = await host.get('/api/staff?known=1');
      return { ms: Date.now() - t0, body: r.body as { known: boolean; pcs: { id: string; label: string; ok: boolean; asking: boolean }[] } };
    };
    let k = await known();
    assert.equal(k.body.known, true);
    const labels = k.body.pcs.map(p => p.label);
    assert.equal(new Set(labels).size, 2, `told apart: ${labels.join(' / ')}`);
    assert.ok(labels.every(l => /^Worker PC \(127\.0\.0\.1:\d+\)$/.test(l)), labels.join(' / '));
    assert.ok(k.body.pcs.every(p => p.ok), 'both are on');

    // B is turned off. The quick list is drawn at once from what each said last; the full one asks, and B is off.
    await b.stop();
    k = await known();
    assert.ok(k.ms < 1500, `the quick list waits on no PC (${k.ms} ms)`);
    const full = (await host.get('/api/staff')).body as { known: boolean; pcs: { id: string; ok: boolean; asking: boolean }[] };
    assert.equal(full.known, false);
    assert.equal(full.pcs.find(p => p.id === idA)!.ok, true, 'A, which is on, reads as on');
    assert.equal(full.pcs.find(p => p.id === idB)!.ok, false, 'B, which is off, reads as off');
    k = await known();
    assert.ok(k.ms < 1500, `${k.ms} ms`);
    assert.deepEqual(k.body.pcs.map(p => [p.id, p.ok, p.asking]).sort(), [[idA, true, false], [idB, false, false]].sort(), 'B did not answer: off at once, not "asking"');

    // The models across the network: the quick list as well; A can send its model, B is off on its own row.
    const t0 = Date.now();
    const net = (await host.get('/api/network?known=1')).body as { rows: { name: string; on: { pc: string; copy: boolean; why: string }[] }[]; pcs: { id: string; ok: boolean }[] };
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
    assert.deepEqual(net.pcs.map(p => [p.id, p.ok]).sort(), [[idA, true], [idB, false]].sort());
    const row = net.rows.find(r => r.name.startsWith('Shared-2B'))!;
    assert.deepEqual(row.on.map(o => [o.pc, o.copy]), [[idA, true]]);
  } finally {
    for (const pc of pcs.reverse()) await pc.stop();
    rmSync(top, { recursive: true, force: true });
  }
});

test('a node answers its hello without waiting on Windows for its drives (a cold PowerShell took longer than the 3 s given)', () => {
  const node = read('src/jobrun/node.ts');
  const hello = between(node, "if (p === '/worker/hello') {", "if (p === '/worker/stats')");
  assert.match(hello, /const drives = driveReportNow\(\);/);
  assert.doesNotMatch(hello, /await driveReport\(\)/);
  const now = driveReportNow();
  assert.ok(Array.isArray(now), 'given at once, not a promise');
  // Two lists asked at once share one hello per PC (Hire staff asks for its PCs and its models together).
  const links = read('src/jobrun/links.ts');
  assert.match(links, /const now = asking\.get\(r\.id\);\n {2}if \(now\) return now;/);
});

// ---- The page: drawn at once, then filled ----

test('Hire staff shows at once and fills in: no wait on the server before the page, a quick list then the full one', () => {
  const open = between(hire, 'app.openHire = async', 'app.hireRedraw');
  assert.ok(open.indexOf("if (page) app.showAsPage(dlg, 'staff')") < open.indexOf('await api('), 'the page is shown before anything is asked');
  assert.match(open, /for \(const known of \[true, false\]\)/);
  assert.match(open, /api\(`\/api\/staff\$\{known \? '\?known=1' : ''\}`\)/);
  assert.match(open, /if \(turn !== hs\.turn \|\| !dlg\.open\) return;/, 'a slow answer never draws over a later opening');
  assert.match(open, /\} else drawWaiting\(\);/, 'blurred stand-ins before the first list');
  assert.match(hire, /api\(`\/api\/network\$\{known \? '\?known=1' : ''\}`\)/);
  const css = read('public/style.css');
  assert.match(css, /\.hs-wait-card \{ filter: blur\(3px\);/);
});

// ---- Push to node ----

test('Push to node: the PC it is on at the far left, a divider, tiles for the PCs it can go to; a reason stays on its own PC', () => {
  const html = read('public/index.html');
  const dlg = between(html, '<dialog id="hs-push-dlg"', '</dialog>');
  assert.ok(dlg.indexOf('id="hs-push-from"') < dlg.indexOf('class="hs-push-arrow"') && dlg.indexOf('class="hs-push-arrow"') < dlg.indexOf('id="hs-push-list"'), 'from, the divider, to');
  const css = read('public/style.css');
  assert.match(css, /\.hs-push-flow \{ display: grid; grid-template-columns: minmax\(180px, 230px\) auto minmax\(0, 1fr\);/);
  assert.match(css, /\.hs-push-arrow \{[^}]*border-left: 2px solid var\(--line\); border-right: 2px solid var\(--line\);/);
  assert.match(css, /\.hs-tiles \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(190px, 1fr\)\);/);
  const draw = between(hire, 'function drawPush() {', '/** Buttons drawn again');
  // A source that cannot send says so on its own tile (the off PC), never on a target's: the target shows its own state.
  assert.match(draw, /const why = pc && o && !o\.copy \? `\$\{cap\(o\.why/);
  assert.doesNotMatch(draw, /route\.why \? `\$\{cap\(route\.why\)\}/, 'the old rows printed the source\'s reason on every target');
  assert.match(draw, /const own = pc \? hs\.net\?\.pcs\.find\(p => p\.id === pc\)\?\.send : '';/);
  // Each tile as Home's PC cards: its picture (its photo, else PC), name, RAM / VRAM and make, on or off.
  const tile = between(hire, 'function pcTile(pc, ...below) {', 'function drawPush()');
  assert.match(tile, /app\.avatar\(pc \? `pc:\$\{pc\}` : 'pc:mine', 'PC'\)/);
  assert.match(tile, /memWords\(mem\.ram, mem\.vram\)/);
  // Every PC by the name that tells it apart, in the rows' "On …" too.
  assert.match(hire, /const whereOf = e => e\.on\.map\(o => pcName\(o\.pc\)\)/);
  assert.match(hire, /d\(\)\?\.pcs\.find\(p => p\.id === id\)\?\.label/);
});

// ---- A narrow window, the top bar ----

test('a narrow window: the buttons go under a model\'s words; "No models loaded" keeps its words and the mute words are gone', () => {
  const css = read('public/style.css');
  assert.match(css, /#hs-all \{ container-type: inline-size; \}\n@container \(max-width: 760px\) \{\n {2}#hs-all \.hs-net \{ grid-template-columns: minmax\(0, 1fr\); \}\n {2}#hs-all \.hs-net-acts \{ flex-direction: row; flex-wrap: wrap; \}/);
  assert.match(css, /\.loaded:has\(> \.hint\) \{ flex: none; min-width: max-content; \}/);
  assert.doesNotMatch(css, /mute-all-text/);
  assert.doesNotMatch(read('public/index.html'), /mute-all-text/);
  assert.doesNotMatch(read('public/mute.js'), /All muted \$\{all\.text\}` : ''/);
});

// ---- Names ----

test('a name is made up on opening; a woman\'s name draws a woman, a man\'s name a man', async () => {
  const open = between(hire, 'app.openHire = async', 'app.hireRedraw');
  assert.match(open, /\$\('#hs-name'\)\.value = name\.trim\(\) \|\| freeName\(\);/);
  assert.match(read('public/team.js'), /if \(!\$\('#sm-name'\)\.value\.trim\(\)\) app\.randomName\?\.\(\$\('#sm-name'\)\);/);
  // The lists and genderOf, run as the page runs them.
  const names = between(hire, '  const WOMEN = [', '  app.genderOfName = genderOf;');
  const ctx: Record<string, unknown> = {};
  runInNewContext(`  const WOMEN = [${names.slice('  const WOMEN = ['.length)}\nthis.genderOf = genderOf; this.WOMEN = WOMEN; this.MEN = MEN;`, ctx);
  const genderOf = ctx.genderOf as (n: string) => string | null;
  for (const n of ctx.WOMEN as string[]) assert.equal(genderOf(n), 'woman', n);
  for (const n of ctx.MEN as string[]) assert.equal(genderOf(n), 'man', n);
  assert.equal(genderOf('  emma smith '), 'woman');
  assert.equal(genderOf('Rowan'), null, 'a name not on the lists leaves the look as it is');
  // The look drawn for a gender is that gender, every time.
  const look: Record<string, unknown> = { app: {}, el: () => null };
  runInNewContext(read('public/look.js'), look);
  const app = look.app as { look: { setOptions: (o: unknown) => void; random: (role: string, rnd?: () => number, extra?: () => number, gender?: string | null) => { gender: string; facial: string } } };
  app.look.setOptions(LOOK_OPTIONS);
  for (let i = 0; i < 40; i++) {
    assert.equal(app.look.random('', undefined, undefined, 'man').gender, 'man');
    const w = app.look.random('', undefined, undefined, 'woman');
    assert.equal(w.gender, 'woman');
    assert.equal(w.facial, 'none');
  }
  // The hire's look follows the name until a look is chosen by hand.
  assert.match(hire, /hs\.look = app\.look\.random\(hs\.role, undefined, undefined, genderOf\(\$\('#hs-name'\)\.value\)\)/);
  assert.match(hire, /\$\('#hs-name'\)\.addEventListener\('input', nameChanged\);/);
});

test('a window shown as a page is brought into sight: on a narrow window the menu sits above it', () => {
  const home = readFileSync(new URL('../public/home.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const fn = home.slice(home.indexOf('function showAsPage('), home.indexOf('app.showAsPage = showAsPage;'));
  assert.match(fn, /const top = dlg\.getBoundingClientRect\(\)\.top;\n\s*if \(top < 0 \|\| top > innerHeight \/ 3\) dlg\.scrollIntoView\(\{ block: 'start' \}\);/);
  assert.ok(fn.indexOf('setView(view);') < fn.indexOf('dlg.scrollIntoView'), 'after the page is on screen');
});

test('a chat whose hire\'s model was deleted says so in its head, with Fix opening Edit staff at their model', () => {
  const chats = readFileSync(new URL('../public/chats.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const head = chats.slice(chats.indexOf('function drawHead()'), chats.indexOf('drawChatProject(chat);', chats.indexOf('function drawHead()')));
  assert.match(head, /person\?\.use\?\.state === 'missing'/);
  assert.match(head, /' · model was deleted '/);
  assert.match(head, /id: 'chat-fix', text: 'Fix'/);
  assert.match(head, /app\.editStaff\?\.\(person\.who\.slice\('staff:'\.length\), \{ pick: true \}\)/);
  assert.match(head, /\$\('#chat-fix'\)\?\.remove\(\);/, 'redrawn without a second button');
});
