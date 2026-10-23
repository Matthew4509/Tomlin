// The first screens a new copy shows: the Import question leads with the safe choice, the chat's Connect before anyone
// is hired, and button words in sentence case.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PUB = fileURLToPath(new URL('../public/', import.meta.url));
const read = (f: string) => readFileSync(join(PUB, f), 'utf8');

test('Import your chats?: Decide later is the highlighted button and takes focus; Import says it moves the model files', () => {
  const keep = read('keep.js');
  const ask = keep.slice(keep.indexOf('function askBringIn'), keep.indexOf('async function keepStart'));
  assert.match(ask, /const wait = el\('button', \{ class: 'btn primary', type: 'button', text: 'Decide later'/);
  assert.match(ask, /wait\.focus\(\)/);
  // Import is a plain button, with what it does right beside it (and read out with it).
  assert.match(ask, /const go = el\('button', \{ class: 'btn', type: 'button', text: 'Import', 'aria-describedby': 'keep-moves'/);
  assert.match(ask, /el\('span', \{ class: 'keep-go' \}, go, el\('span', \{ id: 'keep-moves', class: 'hint', text: 'moves the model files' \}\)\)/);
  // The buttons: Decide later first, then Import, then Start empty.
  assert.ok(ask.indexOf('keep-actions\' }, wait') > 0);
  assert.ok(ask.indexOf("text: 'Import'") < ask.indexOf("text: 'Start empty'"));
  assert.equal((ask.match(/btn primary/g) ?? []).length, 1);
});

test('Import your chats?: with several older copies none is ticked, and Import without a tick says what to do', () => {
  const keep = read('keep.js');
  const ask = keep.slice(keep.indexOf('function askBringIn'), keep.indexOf('async function keepStart'));
  assert.match(ask, /let pick = k\.offer\.length === 1 \? k\.offer\[0\]\.dir : ''/);
  assert.match(ask, /radio\.checked = s\.dir === pick/);
  assert.doesNotMatch(ask, /radio\.checked = i === 0/);
  assert.match(ask, /if \(!pick\) \{\s+fault\.textContent = 'Tick the copy to import from first/);
});

test("before anyone is hired, the chat's Connect looks greyed, stays pressable and says why", () => {
  const app = read('app.js');
  assert.match(app, /const HIRE_FIRST = 'Hire someone first: [^']*Press Hire staff on the left\.'/);
  const draw = app.slice(app.indexOf('function drawPane'), app.indexOf('function threadsHint'));
  assert.match(draw, /const nobody = name === 'chat' && !on && !!app\.nobodyToTalkTo;/);
  assert.match(draw, /p\.connect\.classList\.toggle\('primary', !on && !nobody\)/);
  assert.match(draw, /p\.connect\.classList\.toggle\('looks-off', nobody\)/);
  assert.match(draw, /p\.connect\.title = nobody \? HIRE_FIRST : ''/);
  // Never disabled for it: only while unloading.
  assert.match(draw, /p\.connect\.disabled = v\.state === 'unloading';/);
  // The press says it and loads nothing.
  const press = app.slice(app.indexOf("p.connect.addEventListener('click'"), app.indexOf("p.model.addEventListener('change'"));
  assert.match(press, /if \(name === 'chat' && app\.nobodyToTalkTo\) \{\s+showFault\(p\.said, HIRE_FIRST\);\s+return;/);
  assert.ok(press.indexOf('HIRE_FIRST') < press.indexOf('loadModel('));
  assert.match(read('style.css'), /\.btn\.looks-off \{ opacity: \.55; \}/);
});

test('button words are in sentence case (the office machine screens are not buttons)', () => {
  const caps: string[] = [];
  for (const f of readdirSync(PUB).filter(x => x.endsWith('.js'))) {
    for (const m of read(f).matchAll(/el\('button', \{[^}]*?text: '([^']+)'/g)) {
      if (/^[A-Z][A-Z .!?-]{3,}$/.test(m[1])) caps.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(caps, []);
  assert.doesNotMatch(read('home.js'), /HIRE STAFF/);
});
