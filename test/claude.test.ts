// Connect Claude: the prompt makes Claude the project manager, reaching the network through this copy's own API, and never holds anything secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudePrompt, newestHandoff, type ClaudeInfo } from '../src/claude.ts';

const info: ClaudeInfo = {
  version: '2.0.31',
  appFolder: 'D:\\Apps\\smart-manager\\',
  homeFolder: 'D:\\Users\\sam\\TOMLIN',
  handoff: 'HANDOFF-2026-10-06-EXAMPLE.md',
  port: 8740,
  pcName: 'Desk',
  node: { on: false, port: 8741 },
};

test('the newest handover is found by the date in its name', () => {
  assert.equal(newestHandoff(['README.md', 'HANDOFF-2026-10-05-B.md', 'HANDOFF-2026-10-06-A.md', 'HANDOFF-2026-09-30-Z.md']), 'HANDOFF-2026-10-06-A.md');
  assert.equal(newestHandoff(['README.md']), null);
  // Several on one day: the highest version in the name, not the last name.
  assert.equal(newestHandoff(['HANDOFF-2026-10-07-UPTIME-COSTS-2.0.39.md', 'HANDOFF-2026-10-07-TONE-TOKENS-2.0.42.md', 'HANDOFF-2026-10-07-QUEUE-2.0.41.md', 'HANDOFF-2026-10-07-WINDOW.md', 'HANDOFF-2026-10-06-Z-2.0.50.md']), 'HANDOFF-2026-10-07-TONE-TOKENS-2.0.42.md');
  assert.equal(newestHandoff(['HANDOFF-2026-10-07-BAKED-2.0.35-NEXT.md', 'HANDOFF-2026-10-07-AUDIT-FIXES-2.0.35.md']), 'HANDOFF-2026-10-07-BAKED-2.0.35-NEXT.md');
});

test('the prompt: the project manager, where things are, START HERE, the API and how to work', () => {
  const p = claudePrompt(info);
  assert.ok(p.startsWith('I have a local network of LLMs, that do a variety of tasks such as coding, graphic design, writing and more.\nYour role is to act as the project manager. Assign and queue work to each node, ensure that work is delivered to the correct folders.'));
  assert.ok(p.includes('App folder: D:\\Apps\\smart-manager\\'));
  assert.ok(p.includes('START HERE: D:\\Apps\\smart-manager\\HANDOFF-2026-10-06-EXAMPLE.md'));
  assert.ok(p.includes('My data (never change it): D:\\Users\\sam\\TOMLIN'));
  assert.ok(p.includes('my own copy running at http://127.0.0.1:8740. Never restart it.'));
  // The linked PCs are reached through this copy's API: no PIN or code, ever.
  assert.match(p, /API at http:\/\/127\.0\.0\.1:8740[^\n]*you never need a PIN or a setup code/);
  for (const door of ['GET /api/home/pcs', 'GET /api/staff', 'GET /api/jobs', 'POST /api/projects/create', 'POST /api/chats/new', 'POST /api/queue/add', 'GET /api/queue']) assert.ok(p.includes(door), door);
  assert.doesNotMatch(p, /type its setup code|link PIN/);
  assert.ok(p.endsWith('6. Ask me before committing, baking a zip or uploading anything.'));
  assert.ok(claudePrompt({ ...info, handoff: null }).includes('read README.md there first'));
  assert.ok(claudePrompt({ ...info, node: { on: true, port: 8741 } }).includes('on, other PCs link to it on port 8741'));
});

test('nothing secret can reach the prompt: it is built only from these fields', () => {
  // The info has no field for a PIN, a setup code or a link key; extra fields are not read.
  const p = claudePrompt({ ...info, code: 'ABCD-EFGH', pin: '123456', key: 'secret' } as never);
  assert.doesNotMatch(p, /ABCD-EFGH|123456|secret/);
});
