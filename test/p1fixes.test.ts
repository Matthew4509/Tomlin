// The P1 faults found by the code review and the screen walk of master (13 Nov 2026), each held to its fix: the parts
// that run on their own run here; the rest is checked in the source (read as git keeps it, LF).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunHistory } from '../src/faults.ts';
import { replayOf } from '../src/outbox.ts';
import { driveReportNow } from '../src/modelhome.ts';
import { startSeconds } from '../src/loadlimit.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('a picture model moved to a linked PC keeps its name (the pattern lost its backslashes)', () => {
  const copies = read('src/jobrun/copies.ts');
  assert.doesNotMatch(copies, /replace\(\/s\*\(\.\*\)\$\//);
  assert.equal(copies.split(".name.replace(/\\s*\\(.*\\)$/, '')").length - 1, 3, 'each place strips only the "(...)" tail');
  assert.equal('Flux schnell (fast)'.replace(/\s*\(.*\)$/, ''), 'Flux schnell');
});

test('a linked PC\'s heartbeat is not a word from it: the silence warning can speak again', () => {
  const links = read('src/jobrun/links.ts');
  assert.match(links, /\(ev, data\) => \{\n\s*\/\/ A heartbeat[^\n]*\n\s*if \(ev !== 'quiet'\) lastWord = Date\.now\(\);/);
});

test('a picture whose connection drops twice gets the full time to reconnect each time', () => {
  const pb = read('src/jobrun/pictureback.ts');
  assert.match(pb, /res = again;\n[^\n]*\n\s*lostAt = 0;\n\s*break;/);
});

test('Test now waits as long as a start of that model may take, not a flat 15 minutes', () => {
  const rc = read('src/server/runnercheck.ts');
  assert.match(rc, /const tries = Math\.ceil\(\(startSeconds\(model\.bytes, false\) \+ 60\) \* 2\);/);
  assert.match(rc, /for \(let t = 0; t < tries && c\.runner\.view\.state === 'loading'/);
  // An 80 GB file is given well over 15 minutes.
  assert.ok(startSeconds(80 * 2 ** 30, false) > 15 * 60);
});

test('successes still waiting are written when TOMLIN closes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-p1-'));
  try {
    const file = join(dir, 'run-history.json');
    const h = new RunHistory(file);
    h.wait = 60_000;
    h.success('This PC', 'm', 'llama-cuda', 30);
    h.saveNow();
    const kept = JSON.parse(readFileSync(file, 'utf8')) as { entries: Record<string, { ok: string[] }> };
    assert.equal(Object.values(kept.entries)[0].ok.length, 1);
    // Nothing waiting: nothing is written again.
    rmSync(file);
    h.saveNow();
    assert.throws(() => readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(read('src/server/faults.ts'), /process\.on\('exit', \(\) => history\.saveNow\(\)\);/);
});

test('an answer collected after the link dropped keeps its crash notice', () => {
  const fault = { id: 'abcdef12', fault: 'the CUDA runner crashed' };
  assert.deepEqual(replayOf({ state: 'error', text: 'part', error: 'it crashed', fault, at: new Date().toISOString() }), [['text', { text: 'part' }], ['error', { text: 'it crashed', fault }]]);
  assert.deepEqual(replayOf({ state: 'error', text: '', error: 'x', at: new Date().toISOString() }), [['error', { text: 'x' }]]);
  assert.match(read('src/outbox.ts'), /\.\.\.\(d\.fault && typeof d\.fault === 'object' \? \{ fault: d\.fault \} : \{\}\)/);
});

test('two Move to SSD clicks: the second is told to wait while the first is still starting', () => {
  const mh = read('src/server/modelhome.ts');
  assert.match(mh, /const moving = \(\) => move\?\.state\.state === 'moving' \|\| ssdStarting;/);
  const route = mh.slice(mh.indexOf("'/api/models/to-ssd'"), mh.indexOf("'/api/models/move/stop'"));
  assert.ok(route.indexOf('if (moving())') < route.indexOf('ssdStarting = true'), 'checked, then held');
  assert.match(route, /finally \{\n\s*ssdStarting = false;/);
});

test('a linked PC\'s hello never waits on a drive reading', () => {
  const t0 = Date.now();
  const now = driveReportNow();
  assert.ok(Array.isArray(now));
  assert.ok(Date.now() - t0 < 200, 'answered at once');
  const node = read('src/jobrun/node.ts');
  assert.match(node, /const drives = driveReportNow\(\);/);
  assert.doesNotMatch(node, /await driveReport\(\)/);
  assert.match(read('src/modelhome.ts'), /return \(drivesReading \?\?= readDrives\(\)/);
});

test('the old-runner note compares with the runner picked for the model now, not the one it loaded with', () => {
  assert.match(read('src/server/panes.ts'), /const run = s \? runOf\(s, v\.model\) : runOn\(p\);/);
});

test('the tray ends TOMLIN when the Windows session ends, not when Windows only asks whether it may', () => {
  const tray = read('tools/tray.cs');
  assert.match(tray, /SystemEvents\.SessionEnded \+= delegate \(object s, Microsoft\.Win32\.SessionEndedEventArgs e\)/);
  assert.doesNotMatch(tray, /SessionEnding \+=/);
});

test('uninstall from the setup window runs from outside the install folder and waits for files to be let go', () => {
  const setup = read('tools/setup.cs');
  assert.match(setup, /if \(args\.StartsWith\("uninstall"\)\)/);
  assert.match(setup, /psi\.WorkingDirectory = dir;/);
  assert.match(read('tools/install.ts'), /await rm\(P\.root, \{ recursive: true, force: true, maxRetries: 30, retryDelay: 500 \}\);/);
});

test('Start chat now after a hire shows the chat, not Home', () => {
  const team = read('public/team.js');
  const at = team.indexOf('showChat(turned ?? await app.chatAgain());');
  assert.ok(at > 0);
  assert.match(team.slice(at, at + 300), /if \(turned\) setView\('chat'\);/);
});
