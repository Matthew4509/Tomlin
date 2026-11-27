// The program by the clock (tools/tray.cs) starts TOMLIN again when it ends by itself with a fault after running a while
// (L2: TOMLIN ended silently while copying): at most 3 times in a row (an hour's clean run starts the count again), never
// after Task Manager or a command ended it, nor while Windows signs out or shuts down, and says so in TOMLIN's log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cs = readFileSync(new URL('../tools/tray.cs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ended = cs.slice(cs.indexOf('static void Ended(Process proc)'), cs.indexOf('static bool AutoRestart()'));

test('a fault after a minute or more starts TOMLIN again, logged; 0, a quick fail, a kill from outside do not', () => {
  assert.match(ended, /if \(code != 0 && DateTime\.Now - childStarted > TimeSpan\.FromMinutes\(1\) && !EndedFromOutside\(proc\.Id, code\) && AutoRestart\(\)\)\s*\{\s*LogLine\("TOMLIN \(process " \+ proc\.Id \+ "\) ended by itself/);
  // After its own codes (75, 76, 77) and a new copy that never started, which go back as before.
  assert.ok(ended.indexOf('AutoRestart()') > ended.indexOf('if (previousDir != null && Directory.Exists(previousDir))'));
  assert.ok(ended.indexOf('AutoRestart()') < ended.indexOf('icon.Text = "TOMLIN: stopped";'));
  // Quit never restarts: it returns before any of this.
  assert.ok(ended.indexOf('if (quitting) { Application.Exit(); return; }') < ended.indexOf('AutoRestart()'));
  assert.match(cs, /child = proc;\n\s*childStarted = DateTime\.Now;/);
});

test('at most 3 in a row: an hour of clean running starts the count again, and the fourth is refused and logged', () => {
  assert.match(cs, /const int MostRestarts = 3;/);
  assert.match(ended, /if \(DateTime\.Now - childStarted > TimeSpan\.FromHours\(1\)\) faultRestarts = 0;/);
  assert.ok(ended.indexOf('faultRestarts = 0;') < ended.indexOf('AutoRestart()'), 'the count is reset before it is checked');
  const rule = cs.slice(cs.indexOf('static bool AutoRestart()'), cs.indexOf('static bool EndedFromOutside('));
  assert.match(rule, /if \(faultRestarts >= MostRestarts\)\s*\{\s*LogLine\("TOMLIN ended with a fault again after being started again "/);
  assert.match(rule, /faultRestarts\+\+;\s*return true;/);
  assert.doesNotMatch(cs, /FromMinutes\(15\)/, 'no 15-minute window, which let a fault loop forever');
});

test('Task Manager, taskkill and Windows ending the session are not faults to start again from', () => {
  const out = cs.slice(cs.indexOf('static bool EndedFromOutside('), cs.indexOf('static bool EndedFromOutside(') + 900);
  assert.match(out, /if \(DateTime\.Now - sessionEndingAt < TimeSpan\.FromMinutes\(5\)\) return true;/);
  assert.match(out, /if \(code != 1\) return false;/);
  assert.match(out, /Path\.Combine\(data, "logs", "running-now\.json"\)/);
  assert.match(out, /mark\.Contains\("\\"pid\\":" \+ pid \+ ","\)/);
  assert.match(cs, /SystemEvents\.SessionEnding \+= delegate \{ sessionEndingAt = DateTime\.Now; \};/);
  // The mark is the one src/lastwords.ts keeps, and it is removed as the server ends with a fault it saw.
  const lw = readFileSync(new URL('../src/lastwords.ts', import.meta.url), 'utf8');
  assert.match(lw, /export const MARK = 'running-now\.json';/);
  assert.match(lw, /onExit\(code => \{[\s\S]*rmSync\(file, \{ force: true \}\);/);
  // What the mark holds: its pid first, as JSON.stringify writes it.
  assert.match(lw, /const mark: Mark = \{ pid: process\.pid, version,/);
});
