// See all staff and "Pick a model" looked dead for 3 seconds: both waited for the staff list, and the server asks each
// linked PC for it (one that is off takes 3 s to give up on). Both now show at once from the list already read and
// catch up. And New chat's card for a hire on a linked PC named the PC twice (in Model and in Runs on).
// Run: node --test test/staffatonce.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, to);
  return src.slice(a, b);
};

/** team.js's seeAllStaff and openProfile, with the page around them stood in; `calls` is what happened, in order. */
function staffPage(data: unknown) {
  const team = read('public/team.js');
  const calls: string[] = [];
  let answer: (v: unknown) => void = () => undefined;
  let turn = 0;
  const ctx = {
    team: { data },
    dlg: { open: false },
    teamMode: 'menu',
    fromMenu: false,
    editId: '',
    shownId: '',
    app: {
      pageTicket: () => {
        const mine = ++turn;
        return () => mine !== turn;
      },
      showAsPage: () => {
        calls.push('shown');
        ctx.dlg.open = true;
      },
    } as Record<string, unknown>,
    api: (path: string) => {
      calls.push(`asked ${path}`);
      return new Promise(done => { answer = done; });
    },
    teamFault: () => undefined,
    teamDraw: () => calls.push(`list drawn (${(ctx.team.data as { staff: unknown[] } | null)?.staff.length ?? 'none'})`),
    drawEdit: () => calls.push('edit drawn'),
    showMode: (m: string) => { ctx.teamMode = m; },
    staffMode: () => { ctx.teamMode = 'one'; },
    matchMedia: () => ({ matches: false }),
    setTimeout: (f: () => void) => f(),
    $: () => ({ scrollTop: 0, scrollIntoView: () => undefined, focus: () => calls.push('first choice focused') }),
  };
  runInNewContext(`${between(team, 'async function openProfile(', 'app.openProfile = openProfile;')}\nthis.openProfile = openProfile;\n${between(team, 'app.seeAllStaff = async', '\n// ---- The host')}`, ctx);
  return { ctx: ctx as typeof ctx & { openProfile: (id: string, o?: { pick?: boolean }) => Promise<void> }, calls, answer: (v: unknown) => answer(v), asked: () => answer };
}
const tick = () => new Promise(done => setImmediate(done));

test('See all staff shows at once from the list already read, then catches up when the server answers', async () => {
  const { ctx, calls, answer } = staffPage({ staff: [{ id: 'a' }] });
  const done = (ctx.app.seeAllStaff as (o?: object) => Promise<void>)({ fromMenu: true });
  // Nothing has answered yet: the page is on screen all the same.
  assert.deepEqual(calls, ['list drawn (1)', 'shown', 'asked /api/staff']);
  assert.equal(ctx.teamMode, 'all');
  answer({ staff: [{ id: 'a' }, { id: 'b' }] });
  await done;
  assert.deepEqual(calls.slice(3), ['list drawn (2)']);
});

test('See all staff pressed before any list was read asks for the list as last known, which waits on no linked PC', async () => {
  const { ctx, calls, answer } = staffPage(null);
  const done = (ctx.app.seeAllStaff as () => Promise<void>)();
  assert.deepEqual(calls, ['asked /api/staff?known=1']);
  answer({ staff: [] });
  await tick();
  assert.deepEqual(calls.slice(1), ['list drawn (0)', 'shown', 'asked /api/staff']);
  answer({ staff: [] });
  await done;
});

test('See all staff: an answer that comes after the person moved on draws nothing', async () => {
  const { ctx, calls, answer } = staffPage({ staff: [] });
  const done = (ctx.app.seeAllStaff as () => Promise<void>)();
  ctx.teamMode = 'menu';
  const before = calls.length;
  answer({ staff: [{ id: 'a' }] });
  await done;
  assert.equal(calls.length, before);
});

test('"Pick a model" opens Edit staff at once, and draws their settings again only when the answer changed them', async () => {
  const rosa = { id: 'rosa', model: 'gone.gguf' };
  const { ctx, calls, answer } = staffPage({ staff: [rosa] });
  const done = ctx.openProfile('rosa', { pick: true });
  assert.deepEqual(calls, ['edit drawn', 'list drawn (1)', 'shown', 'first choice focused', 'asked /api/staff']);
  // The same answer: the settings on screen are left alone (a list being picked from does not snap shut).
  answer({ staff: [{ ...rosa }] });
  await done;
  assert.deepEqual(calls.slice(5), ['list drawn (1)']);
  // A changed answer draws them again, and "Pick a model" is back on their First choice.
  const again = ctx.openProfile('rosa', { pick: true });
  const at = calls.length;
  answer({ staff: [{ ...rosa, model: 'new.gguf' }] });
  await again;
  assert.deepEqual(calls.slice(at), ['list drawn (1)', 'edit drawn', 'first choice focused']);
});

test('Edit staff for someone not in the list yet waits for the server, and someone opened since is not drawn over', async () => {
  const { ctx, calls, answer, asked } = staffPage({ staff: [{ id: 'a' }] });
  const done = ctx.openProfile('new');
  assert.deepEqual(calls, ['asked /api/staff']);
  answer({ staff: [{ id: 'a' }, { id: 'new' }] });
  await done;
  assert.deepEqual(calls.slice(1), ['edit drawn', 'list drawn (2)', 'shown']);
  const first = ctx.openProfile('a');
  const firstAnswer = asked();
  const second = ctx.openProfile('new');
  const at = calls.length;
  firstAnswer({ staff: [{ id: 'a', model: 'changed' }, { id: 'new' }] });
  await first;
  assert.deepEqual(calls.slice(at), [], 'the first answer draws nothing: the second person is on screen');
  answer({ staff: [{ id: 'a' }, { id: 'new' }] });
  await second;
});

test('All staff draws each hire as a tile under their PC, with a linked PC named once (in the heading)', () => {
  const team = read('public/team.js');
  const card = between(team, 'function staffCard(m) {', '\n/** "Pick a model"');
  assert.match(card, /class: 'team-card staff-card'/);
  assert.doesNotMatch(card, /team-row/, 'no longer one row across the page');
  assert.match(card, /const model = m\.use\?\.state === 'pc' && m\.use\.name \? m\.use\.name : brainName\(m, m\.model\);/);
  assert.match(card, /el\('div', \{ class: 'staff-card-go' \}, pickButton\(m\), use, edit\)/);
  assert.match(between(team, 'function teamDraw() {', '\nfunction staffCard'), /el\('div', \{ class: 'staff-cards' \}, \.\.\.people\.map\(staffCard\)\)/);
  assert.match(read('public/style.css'), /\.staff-cards \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(190px, 1fr\)\);/);
});

test("New chat's card for a hire on a linked PC names the PC once: Model is the model's name alone", () => {
  const chats = read('public/chats.js');
  const ctx: { modelWords?: (p: unknown) => string } = {};
  runInNewContext(`${between(chats, 'function modelWords(p) {', '\n/**')}\nthis.modelWords = modelWords;`, ctx);
  const words = ctx.modelWords!;
  assert.equal(words({ use: { state: 'pc', name: 'Qwen3.5-0.8B', pc: 'Worker PC', text: 'Qwen3.5-0.8B on "Worker PC"' } }), 'Qwen3.5-0.8B');
  // No model named (the PC answers on what it has loaded), or one gone: the words stay as they were.
  assert.equal(words({ use: { state: 'pc', name: '', text: 'what "Worker PC" has loaded' } }), 'what "Worker PC" has loaded');
  assert.equal(words({ use: { state: 'missing', name: 'Qwen3.6-35B', text: 'Qwen3.6-35B, no longer on this PC' } }), 'Qwen3.6-35B, no longer on this PC');
  assert.equal(words({ use: { state: 'none', name: '', text: 'no model given, and none is loaded here' } }), 'No model is loaded here');
  assert.equal(words({ use: { state: 'here', name: 'Qwen3.5-2B', text: 'Qwen3.5-2B' } }), 'Qwen3.5-2B');
  // The card's own line names the PC.
  assert.match(chats, /text: 'Runs on' \}\), el\('span', \{ text: p\.pc \}\)/);
});
