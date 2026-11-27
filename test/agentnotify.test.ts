// N3 (27 Nov agents plan): a run's one-line summary to his phone, sent by TOMLIN's code (src/agentnotify.ts), never by
// the model: nothing new is not sent, a line that looks like a key is replaced, 30 an hour at most, the topic only in
// the body, and a recipe still cannot ask to send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanServer, cleanTopic, maskTopic, phoneLine, readSecrets, roomToSend, savePhone, saveSecrets, sendLine, setDir, tellPhone, windowsLine, type Post } from '../src/agentnotify.ts';
import { readRecipe } from '../src/recipe.ts';

const run = (line: string, state = 'done') => ({ agentName: 'Robin Smith', job: 'Price check', state, line });

test('the line: names and the summary, at most 200 characters; nothing new is not sent while "only when something changed" is on', () => {
  assert.equal(phoneLine(run('Summary: Widget A is now $12 (was $10).'), true), 'Robin\'s price check: Widget A is now $12 (was $10).');
  assert.equal(phoneLine(run('Summary: nothing new.'), true), null);
  assert.equal(phoneLine(run('Summary: nothing new.'), false), 'Robin\'s price check: nothing new.');
  assert.equal(phoneLine(run('Failed: the model gave no report.', 'failed'), true), 'Robin\'s price check: did not finish: the model gave no report.');
  assert.equal(phoneLine(run('Stopped.', 'stopped'), true), null);
  assert.ok(phoneLine(run(`Summary: ${'a'.repeat(400)}`), true)!.length <= 200);
});

test('a summary that looks like it holds a key is not sent: a plain line says to open TOMLIN', () => {
  // A made-up key, put together here so the file itself holds nothing key-shaped (the publish check refuses those).
  const fake = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
  assert.equal(phoneLine(run(`Summary: the new key is ${fake}`), true), 'Robin\'s price check finished. Open TOMLIN to read it.');
});

test('the cap: 30 an hour in all', () => {
  const now = 10 * 3600_000;
  assert.equal(roomToSend(Array.from({ length: 29 }, () => now - 1000), now), true);
  assert.equal(roomToSend(Array.from({ length: 30 }, () => now - 1000), now), false);
  assert.equal(roomToSend(Array.from({ length: 30 }, () => now - 3601_000), now), true);
});

test('the topic goes in the body, never in the address; one retry; a server is https, or http only at home', async () => {
  const calls: { url: string; body: string }[] = [];
  let n = 0;
  const post: Post = async (url, body) => { calls.push({ url, body }); return { status: n++ === 0 ? 503 : 200 }; };
  assert.deepEqual(await sendLine('https://ntfy.sh', 'robin-secret-7f3a', 'Robin\'s price check: up.', post), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://ntfy.sh/');
  assert.ok(!calls[0].url.includes('robin-secret'));
  assert.equal(JSON.parse(calls[0].body).topic, 'robin-secret-7f3a');
  assert.equal(cleanServer('ntfy.sh'), 'https://ntfy.sh');
  assert.equal(cleanServer('http://ntfy.example.com'), '');
  assert.equal(cleanServer('http://192.168.1.20:8080/'), 'http://192.168.1.20:8080');
  assert.equal(cleanServer('https://ntfy.sh/?topic=x'), '');
  assert.equal(cleanTopic('a b'), '');
  assert.equal(maskTopic('robin-secret-7f3a'), 'ro•••••••••••••3a');
});

test('kept apart: the topic in agent-secrets.json, the settings without it; off sends nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-agentnotify-'));
  setDir(dir);
  const calls: string[] = [];
  const post: Post = async (_u, body) => { calls.push(body); return { status: 200 }; };
  assert.deepEqual(await tellPhone(run('Summary: up.'), post), { sent: false, why: 'off' });
  await savePhone({ on: true, server: 'https://ntfy.sh' });
  assert.deepEqual(await tellPhone(run('Summary: up.'), post), { sent: false, why: 'no topic' });
  await saveSecrets({ topic: 'robin-secret-7f3a' });
  assert.equal(JSON.parse(readFileSync(join(dir, 'agent-phone.json'), 'utf8')).topic, undefined);
  assert.equal((await readSecrets()).topic, 'robin-secret-7f3a');
  assert.deepEqual(await tellPhone(run('Summary: nothing new.'), post), { sent: false, why: 'nothing to send' });
  assert.deepEqual(await tellPhone(run('Summary: up.'), post), { sent: true });
  assert.equal(calls.length, 1);
});

test('a recipe still cannot switch sending on: "send" in its tools is refused', () => {
  const r = readRecipe('Name: X\nAgent: Robin\nTask: Check.\nTools: working notes, send to my phone');
  assert.match(r.problems.join(' '), /Never given to an agent: send to my phone \(sending a message or an email\)/);
});

test('the Windows notification names the person and the event only', () => {
  assert.equal(windowsLine(run('Summary: Widget A is now $12.')), 'Robin\'s price check finished. Its report is on Home.');
  assert.equal(windowsLine(run('Summary: nothing new.')), null);
  assert.equal(windowsLine(run('Failed: x.', 'failed')), 'Robin\'s price check did not finish. It needs you.');
});

test('agent-secrets.json never goes in a restore point sent to another PC', () => {
  assert.match(readFileSync(new URL('../src/keep.ts', import.meta.url), 'utf8'), /const NEVER_SENT = \[[^\]]*'agent-secrets\.json'/);
});
