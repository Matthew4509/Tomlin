import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RULES, checkSave, loadRules, parseFile, resetRules, rulesBlock, saveRules, serialize, withRules } from '../src/rules.ts';
import { claudePrompt } from '../src/claude.ts';

const on = { on: true, text: DEFAULT_RULES };

test('defaults are the 12 rules', () => {
  assert.equal(DEFAULT_RULES.split('\n').length, 12);
});

test('withRules adds the block to the system turn, once, or puts one first', () => {
  const a = withRules([{ role: 'system', content: 'You are X.' }, { role: 'user', content: 'hi' }], on);
  assert.match(a[0].content, /^You are X\.\n\nStanding rules/);
  assert.deepEqual(withRules(a, on), a);
  const b = withRules([{ role: 'user', content: 'hi' }], on);
  assert.equal(b[0].role, 'system');
  assert.equal(b.length, 2);
});

test('withRules does nothing when off or empty', () => {
  const t = [{ role: 'user', content: 'hi' }];
  assert.equal(withRules(t, { on: false, text: DEFAULT_RULES }), t);
  assert.equal(withRules(t, { on: true, text: '' }), t);
  assert.equal(rulesBlock({ on: false, text: 'x' }), '');
});

test('file round trip keeps text and the off mark', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rules-'));
  assert.deepEqual(await loadRules(dir), on);
  assert.match(await readFile(join(dir, 'rules.md'), 'utf8'), /Never delete/);
  await saveRules(dir, { text: '- Be brief.', on: false });
  assert.deepEqual(parseFile(await readFile(join(dir, 'rules.md'), 'utf8')), { on: false, text: '- Be brief.' });
  assert.equal(serialize({ on: false, text: 'a' }).startsWith('<!-- rules off -->'), true);
  assert.deepEqual(await resetRules(dir), on);
});

test('checkSave refuses empty, gutted and secret saves', () => {
  const big = 'line of text\n'.repeat(60);
  assert.match(checkSave(big, '  ', on) ?? '', /empty/);
  assert.match(checkSave(big, 'tiny', on) ?? '', /third/);
  assert.equal(checkSave(big, big + 'more', on), null);
  assert.equal(checkSave(null, '', on), null);
  assert.match(checkSave(null, 'password = hunter2hunter2hunter2', on) ?? '', /password/);
  assert.match(checkSave(null, ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' '), on) ?? '', /key/);
});

test('Connect Claude prompt carries the rules', () => {
  const info = { version: '1', appFolder: 'C:\a', homeFolder: 'C:\h', handoff: null, port: 1, pcName: 'p', node: { on: false, port: 2 } };
  assert.doesNotMatch(claudePrompt(info), /Standing rules/);
  assert.match(claudePrompt({ ...info, rules: rulesBlock(on) }), /Standing rules[\s\S]*Never delete/);
});

test('the tool lists stay closed: nothing that deletes, runs, sends or buys', async () => {
  const { FILE_TOOLS } = await import('../src/filetools.ts');
  const { WEB_TOOLS } = await import('../src/webtools.ts');
  const names = [...FILE_TOOLS, ...WEB_TOOLS].map(t => t.function.name).sort();
  assert.deepEqual(names, ['list_files', 'open_page', 'read_file', 'save_file', 'web_search']);
});

test('save_file refuses a gutted save and keeps the older backup', async () => {
  const { FileTurn } = await import('../src/filetools.ts');
  const { loadRules } = await import('../src/rules.ts');
  const { readdir, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'rules-ws-'));
  await loadRules(await mkdtemp(join(tmpdir(), 'rules-data-')));
  const big = 'a line of notes\n'.repeat(60);
  await writeFile(join(dir, 'n.md'), big);
  const t = new FileTurn(dir, { perCall: 5000, allowed: true });
  assert.match(await t.run('save_file', JSON.stringify({ path: 'n.md', text: '' })), /Not saved/);
  assert.match(await t.run('save_file', JSON.stringify({ path: 'n.md', text: big + 'x' })), /Saved n\.md/);
  assert.match(await t.run('save_file', JSON.stringify({ path: 'n.md', text: big + 'xy' })), /Saved n\.md/);
  assert.ok((await readdir(dir)).some(f => /^n\.md\.\d{14}\.bak$/.test(f)));
});

test('project rules: saved beside the project, read back, added after the standing rules', async () => {
  const { readProjectRules, saveProjectRules, withProjectRules } = await import('../src/rules.ts');
  const root = await mkdtemp(join(tmpdir(), 'rules-pj-'));
  const id = '20261108-1200-ab12';
  assert.equal(await readProjectRules(root, id), '');
  assert.equal(await saveProjectRules(root, id, '- Read only.\n- No new files.'), '- Read only.\n- No new files.');
  assert.equal(await readProjectRules(root, id), '- Read only.\n- No new files.');
  assert.equal(await saveProjectRules(root, '../x', 'a'), null);
  assert.equal(await readProjectRules(root, '../x'), '');
  const t = withProjectRules(withRules([{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }], on), '- Read only.');
  assert.match(t[0].content, /Standing rules[\s\S]*Rules for this project[\s\S]*Read only/);
  assert.equal(withProjectRules([{ role: 'user', content: 'u' }], '  ').length, 1);
});
