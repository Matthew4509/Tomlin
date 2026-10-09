// About › Bring in from Myia Bridge (src/bridge/import.js): a made-up Myia Bridge folder is read, never changed; its
// lists replace the ones here, and what was here is moved aside, not deleted.
'use strict';
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-import-'));
const DATA = path.join(tmp, 'sm-data');
const WS = path.join(tmp, 'projects');
fs.mkdirSync(path.join(WS, 'site-one'), { recursive: true });
process.env.BRIDGE_DATA = DATA;
process.env.BRIDGE_ROOT = WS;
process.env.BRIDGE_SELF = path.join(tmp, 'home');
const cfg = require('../../src/bridge/config');
cfg.ensureDataDirs();
const { importFrom, candidates } = require('../../src/bridge/import');
const { state } = require('../../src/bridge/state');

// A made-up stand-alone Bridge beside the projects.
const SRC = path.join(WS, 'myia bridge');
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(SRC, rel)), { recursive: true }); fs.writeFileSync(path.join(SRC, rel), text); };
w('server.js', '// Myia Bridge: made-up copy for a test\n');
w('lib/config.js', "'use strict';\n");
w('data/settings.json', JSON.stringify({ workingFolders: [WS], extraProjects: [], hidden: [], known: [], hiddenView: [], order: [], lastScan: null, liveUrls: {} }));
w('data/prompts.json', JSON.stringify({ categories: [{ id: 'mine', name: 'Mine' }], prompts: [{ id: 'p1', category: 'mine', title: 'Brought', text: 'Read C:\\work\\a.md' }] }));
w('data/audits/site-one-abc123.json', JSON.stringify({ ranAt: '2026-10-01T00:00:00Z', findings: [] }));
w('projects.json', JSON.stringify({ projects: { 'site-one': { name: 'Site One' } } }));
const before = fs.readdirSync(SRC, { recursive: true }).map(f => [f, fs.statSync(path.join(SRC, f)).mtimeMs]);

test('a Myia Bridge beside the projects is found', () => {
  assert.deepStrictEqual(candidates(), [SRC]);
});

test('its lists come in; what was here is moved aside; the other Bridge is not changed', () => {
  fs.writeFileSync(path.join(DATA, 'prompts.json'), '{"categories":[],"prompts":[]}');
  const r = importFrom(SRC);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.brought, ['settings.json', 'prompts.json', 'audits (1)', 'projects.json']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'prompts.json'), 'utf8')).prompts[0].text, 'Read C:\\work\\a.md', 'the text exactly, backslashes too');
  assert.ok(fs.existsSync(path.join(DATA, 'audits', 'site-one-abc123.json')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.aside, 'prompts.json'), 'utf8')).prompts.length, 0, 'the old one kept aside');
  assert.deepStrictEqual(state.settings.workingFolders.map(f => f.toLowerCase()), [WS.toLowerCase()], 'in use at once');
  const after = fs.readdirSync(SRC, { recursive: true }).map(f => [f, fs.statSync(path.join(SRC, f)).mtimeMs]);
  assert.deepStrictEqual(after, before, 'nothing in the other Bridge changed');
});

test('a folder that is not a Myia Bridge, or one with a damaged file, is refused and nothing here changes', () => {
  const now = fs.readFileSync(path.join(DATA, 'prompts.json'), 'utf8');
  assert.match(importFrom(path.join(WS, 'site-one')).error, /not a Myia Bridge folder/);
  assert.match(importFrom('').error, /No folder was given/);
  fs.writeFileSync(path.join(SRC, 'data', 'prompts.json'), '{"categories": [');
  assert.match(importFrom(SRC).error, /could not be read/);
  assert.strictEqual(fs.readFileSync(path.join(DATA, 'prompts.json'), 'utf8'), now);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
