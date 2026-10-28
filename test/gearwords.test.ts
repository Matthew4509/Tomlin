// The chat's gear (Model settings), in fewer words (2.0.65): live stats is one line that says what it shows, the
// cores hint is the count alone, and the fault when GPU cannot be used says where to change it (the gear wheel, Run on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('live stats: one line, "Enable live stats (Shows tk/s under each answer)", with no hint line under it', () => {
  const html = read('public/index.html');
  assert.match(html, /<input type="checkbox" id="live-stats"> Enable live stats \(Shows tk\/s under each answer\)<\/label>/);
  assert.doesNotMatch(html, /live-stats-hint/);
  assert.doesNotMatch(html, /Timings, PC, model and tokens a second under each answer/);
});

test('the cores hint is the count alone', () => {
  const app = read('public/app.js');
  assert.match(app, /p\.threadsHint\.textContent = `0 = all \$\{h\.cores\} cores \(\$\{h\.threads\} threads\)\.`;/);
  assert.doesNotMatch(app, /Fewer keeps the PC responsive/);
});

test('GPU that cannot be used: the fault names the gear wheel and Run on, and does not blame a missing build alone', () => {
  const pane = read('src/pane.ts');
  const line = /req\.asked === 'gpu' \? '([^']+)'/.exec(pane)?.[1] ?? '';
  assert.match(line, /gear wheel/);
  assert.match(line, /select Run on/);
  assert.match(line, /Auto/);
  assert.match(line, /no graphics chip TOMLIN can use/);
  assert.doesNotMatch(line, /^No graphics build is installed/);
});

test('TOMLIN not answering: it may be restarting after an update; if it does not come back, close this window and open TOMLIN again (Start menu or desktop)', () => {
  const app = read('public/app.js');
  assert.ok(app.includes("throw new Error('TOMLIN is not answering: it may be restarting after an update (about half a minute), or it was closed or stopped. If it does not come back, close this window, then open TOMLIN again (Start menu or desktop shortcut; or Start TOMLIN.cmd in its folder if you run it from there), and try again.');"));
  assert.ok(app.includes("text: 'TOMLIN is not answering (it may be restarting after an update). If it does not come back, close this window and open TOMLIN again.'"));
  assert.doesNotMatch(app, /is its window still open\?/);
  // The Projects page reconnects by itself: open TOMLIN again is enough there.
  const bridge = read('public/bridge/js/core.js');
  assert.match(bridge, /TOMLIN is not answering\. Open TOMLIN again \(Start menu or desktop shortcut\); this page reconnects by itself\./);
  assert.match(bridge, /TOMLIN stopped answering, so what you see may be out of date\. Open TOMLIN again \(Start menu or desktop shortcut\); this page reconnects by itself\./);
});
