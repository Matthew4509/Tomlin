// Connect Claude: the prompt makes Claude the project manager, reaching the network through this copy's own API, and never holds anything secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudePrompt, copyKind, newestHandoff, type ClaudeInfo } from '../src/claude.ts';

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
  // (Made-up names.)
  assert.equal(newestHandoff(['HANDOFF-2026-10-07-ALPHA-2.0.39.md', 'HANDOFF-2026-10-07-BRAVO-2.0.42.md', 'HANDOFF-2026-10-07-CHARLIE-2.0.41.md', 'HANDOFF-2026-10-07-DELTA.md', 'HANDOFF-2026-10-06-Z-2.0.50.md']), 'HANDOFF-2026-10-07-BRAVO-2.0.42.md');
  assert.equal(newestHandoff(['HANDOFF-2026-10-07-PAPA-2.0.35-NEXT.md', 'HANDOFF-2026-10-07-OSCAR-2.0.35.md']), 'HANDOFF-2026-10-07-PAPA-2.0.35-NEXT.md');
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

test('what the app folder is: installed, a dev checkout, or a folder copy', () => {
  assert.equal(copyKind({ inInstall: true, git: false }), 'installed');
  assert.equal(copyKind({ inInstall: false, git: true }), 'dev');
  assert.equal(copyKind({ inInstall: false, git: false }), 'folder');
});

test('an installed copy: the prompt names the install folder and current.txt, since the version folder changes on update', () => {
  const install = { folder: 'D:\\Apps\\TOMLIN', current: { dir: 'D:\\Apps\\TOMLIN\\tomlin-2.0.31', version: '2.0.31' } };
  const p = claudePrompt({ ...info, appFolder: 'D:\\Apps\\TOMLIN\\tomlin-2.0.31', kind: 'installed', install });
  assert.ok(p.includes('App folder: D:\\Apps\\TOMLIN\\tomlin-2.0.31 (the installed copy, version 2.0.31).'));
  assert.ok(p.includes('Install folder: D:\\Apps\\TOMLIN.'));
  assert.ok(p.includes('the copy in use is the one D:\\Apps\\TOMLIN\\current.txt names'));
  assert.ok(p.includes('ask GET http://127.0.0.1:8740/api/claude'));
  assert.ok(p.includes('- GET /api/claude: where this copy is now'));
  assert.doesNotMatch(p, /^Note: /m);
  // current.txt already names another copy: said.
  const moved = claudePrompt({ ...info, appFolder: 'D:\\Apps\\TOMLIN\\tomlin-2.0.31', kind: 'installed', install: { ...install, current: { dir: 'D:\\Apps\\TOMLIN\\tomlin-2.0.32', version: '2.0.32' } } });
  assert.ok(moved.split('\n').includes('Note: D:\\Apps\\TOMLIN\\current.txt names D:\\Apps\\TOMLIN\\tomlin-2.0.32 (version 2.0.32), not this copy.'));
});

test('a folder copy (unzipped on the Desktop) or a dev checkout: said, with the install when this PC has one', () => {
  const p = claudePrompt({ ...info, appFolder: 'C:\\Users\\sam\\Desktop\\tomlin-2.0.31', kind: 'folder', install: null });
  assert.ok(p.includes('App folder: C:\\Users\\sam\\Desktop\\tomlin-2.0.31 (a copy started from this folder, not installed). If it is moved or gone, ask GET'));
  assert.doesNotMatch(p, /also installed/);
  const d = claudePrompt({ ...info, kind: 'dev', install: { folder: 'C:\\Programs\\TOMLIN', current: { dir: 'C:\\Programs\\TOMLIN\\tomlin-2.0.30', version: '2.0.30' } } });
  assert.ok(d.includes('(a development checkout)'));
  assert.ok(d.includes('TOMLIN is also installed on this PC, in C:\\Programs\\TOMLIN: the installed program starts the copy C:\\Programs\\TOMLIN\\current.txt names (now C:\\Programs\\TOMLIN\\tomlin-2.0.30, version 2.0.30). Starting this copy does not change that file.'));
});
