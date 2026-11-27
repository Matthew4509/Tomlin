// The hot desk: while a hire is dragged, each PC card says whether a model of theirs fits there, from what the page
// already has (no server call on the drag). home.js deskFit is run here on its own with a made-up staff list.
// Run: node --test test/deskfit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const home = readFileSync(new URL('../public/home.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const office = readFileSync(new URL('../public/office.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const grab = (re: RegExp) => re.exec(home)![0];
const GB = 2 ** 30;

const src = [
  grab(/const workOf = .*\n/),
  grab(/function deskModels\(s, pc\) \{[\s\S]*?\n\}\n/),
  grab(/function deskFit\(s, pc\) \{[\s\S]*?\n\}\n/),
  grab(/const moveFit = .*\n/),
].join('\n');

type Data = { here?: unknown; pcs?: unknown[]; hireChoices?: { chat?: unknown[]; image?: unknown[] } } | null;
function fitOn(data: Data, s: Record<string, unknown>, pc: string) {
  const sandbox: Record<string, unknown> = { team: { data }, GB, visibleModels: (l: unknown[]) => l, s, pc, out: null };
  runInNewContext(`${src}\nout = deskFit(s, pc);`, sandbox);
  return sandbox.out as { fit: string; drop: boolean; hint: string } | null;
}

const big = { id: 'big', ok: true, ram: 64 * GB, vram: 0 };
const small = { id: 'small', ok: true, ram: 8 * GB, vram: 0 };
const data = (chat: unknown[]): Data => ({ here: { ram: 32 * GB, vram: 0 }, pcs: [big, small, { id: 'old', ok: true, ram: 0, vram: 0 }], hireChoices: { chat } });
const hire = { id: 'a', name: 'Ann', kind: 'chat', model: 'q8', modelName: 'Qwen 8B', pcId: '' };
const local = { id: 'q8', name: 'Qwen 8B', need: 6 * GB, ramFit: 'ok' };

test('their own model on that PC, fitting: a strong mark that says so', () => {
  const r = fitOn(data([local, { id: 'remote:big:q8', name: 'Qwen 8B on "Big"', need: 6 * GB, ramFit: 'ok' }]), hire, 'big');
  assert.deepEqual({ ...r }, { fit: 'ok', drop: true, hint: 'Fits: their model is here' });
});

test('a tight fit is still droppable, marked lighter, with words', () => {
  const r = fitOn(data([local, { id: 'remote:small:m', name: 'Mid on "Small"', need: 8 * GB, ramFit: 'tight' }]), hire, 'small');
  assert.equal(r!.fit, 'tight');
  assert.equal(r!.drop, true);
  assert.match(r!.hint, /^Tight fit/);
});

test('nothing fits and the window has nothing else to offer: refused, and says why', () => {
  // Their model is too big for that PC as well, so copying it there is not offered.
  const huge = { ...local, need: 20 * GB };
  const r = fitOn(data([huge, { id: 'remote:small:x', name: 'X on "Small"', need: 30 * GB, ramFit: 'no' }]), { ...hire }, 'small');
  assert.deepEqual({ ...r }, { fit: 'no', drop: false, hint: 'Not enough memory' });
  const none = fitOn(data([huge]), hire, 'small');
  assert.deepEqual({ ...none }, { fit: 'no', drop: false, hint: 'No model for them here' });
});

test('nothing there fits, but their model can be copied there: droppable, dimmed, told', () => {
  const r = fitOn(data([local]), hire, 'small');
  assert.equal(r!.fit, 'maybe');
  assert.equal(r!.drop, true);
  assert.match(r!.hint, /^No model for them here: drop to see other ways$/);
  // A model deleted here may be downloaded there: the window is let decide.
  assert.equal(fitOn(data([]), { ...hire, model: '', modelGone: true }, 'big')!.drop, true);
});

test('memory or list not known: no mark (lit as before)', () => {
  assert.equal(fitOn(null, hire, 'big'), null);
  assert.equal(fitOn(data([local]), hire, 'old'), null, 'an older PC that does not tell its memory');
  assert.equal(fitOn(data([local]), hire, 'new'), null, 'a PC just linked, not in the list yet');
  assert.equal(fitOn(data([local, { id: 'remote:big:z', name: 'Z on "Big"', need: 0, ramFit: null }]), hire, 'big'), null);
});

test('the drag marks every card and takes every mark and hint off on dragend and drop', () => {
  const drag = grab(/function deskDrag\(node, s\) \{[\s\S]*?\n\}\n/);
  assert.match(drag, /deskFit\(s, pc\)/);
  assert.match(drag, /class: 'drop-hint', text: f\.hint/);
  assert.match(drag, /addEventListener\('dragend', \(\) => \{\n\s+homeUi\.dragging = null;\n\s+deskClear\(\);/);
  assert.match(grab(/function deskDrop\(li, x\) \{[\s\S]*?\n\}\n/), /deskClear\(\);\n\s+deskMove\(/);
  for (const c of ['drop-fit', 'drop-tight', 'drop-maybe', 'drop-nofit']) {
    assert.match(home, new RegExp(`'${c}'`));
    assert.match(css, new RegExp(`\\.${c}`));
  }
  assert.match(css, /\.pc-card \.drop-hint \{[^}]*font-size: 12px/);
  const block = css.slice(css.indexOf('(home.js deskFit)'), css.indexOf('/* A chat\'s project'));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b/i, 'colours come from the tokens');
});

test('the office refuses the same desks and says why', () => {
  assert.match(office, /const noFit = \(s, d\) => \(d \? app\.deskFit\?\.\(s, d\.key\) : null\)\?\.drop === false;/);
  assert.match(office, /&& !noFit\(s, d\);/);
});
