// Damaged data files: the Bridge reads what it can, keeps a copy of what it cannot, and never loses the person's
// settings or prompts by writing a fresh file over a damaged one.
// Run: node test/damaged.test.js   (no packages; a second)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-damaged-'));
// Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
process.env.BRIDGE_DATA = tmp;
const settings = require('../../src/bridge/settings');
const Prompts = require('../../src/bridge/prompts');
const { lastAudit } = require('../../src/bridge/audit-store');
const { readBody } = require('../../src/bridge/http');
const { Readable } = require('stream');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const asides = (dir, base) => fs.readdirSync(dir).filter(n => n.startsWith(base + '.damaged-'));

(async () => {
  for (const [name, text] of [['not JSON', '{ "workingFolders": ['], ['a number', '42'], ['a list', '[1]'], ['a string', '"x"']]) {
    await check('settings.json that is ' + name + ': a fresh one, and the damaged one kept beside it', () => {
      const d = fs.mkdtempSync(path.join(tmp, 's-')), f = path.join(d, 'settings.json');
      fs.writeFileSync(f, text);
      const s = settings.load(f, null);
      assert(Array.isArray(s.workingFolders) && typeof s.liveUrls === 'object');
      const kept = asides(d, 'settings');
      assert.strictEqual(kept.length, 1);
      assert.strictEqual(fs.readFileSync(path.join(d, kept[0]), 'utf8'), text);
    });
  }
  await check('settings.json lists holding junk keep only the folder paths; a live address that is not text is dropped', () => {
    const d = fs.mkdtempSync(path.join(tmp, 's-')), f = path.join(d, 'settings.json');
    fs.writeFileSync(f, JSON.stringify({ workingFolders: [null, 5, {}, 'C:\\work', ' '], order: 'x', extraProjects: [{ a: 1 }, 'D:\\p'], liveUrls: { a: 'https://x.example', b: 5, c: {} } }));
    const s = settings.load(f, null);
    assert.deepStrictEqual([s.workingFolders, s.order, s.extraProjects, s.liveUrls], [['C:\\work'], [], ['D:\\p'], { a: 'https://x.example' }]);
    assert.strictEqual(asides(d, 'settings').length, 0);
  });
  await check('settings.json with a byte-order mark is read, not replaced', () => {
    const d = fs.mkdtempSync(path.join(tmp, 's-')), f = path.join(d, 'settings.json');
    fs.writeFileSync(f, '\ufeff' + JSON.stringify({ workingFolders: ['C:\\w'] }));
    assert.deepStrictEqual(settings.load(f, null).workingFolders, ['C:\\w']);
  });

  await check('prompts.json not JSON: the starters, and the damaged file kept (the prompts can be got back)', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'p-')), f = path.join(d, 'prompts.json');
    fs.writeFileSync(f, '{"prompts": [{"id": "a", "title": "Mine", "text": "keep me"');
    const st = Prompts.load(f);
    assert.strictEqual(st.categories.length, 9);
    const kept = asides(d, 'prompts');
    assert(kept.length === 1 && /keep me/.test(fs.readFileSync(path.join(d, kept[0]), 'utf8')));
  });
  await check('prompts.json: a prompt whose category is gone moves to My prompts; duplicate and blank categories are mended', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'p-')), f = path.join(d, 'prompts.json');
    fs.writeFileSync(f, JSON.stringify({ categories: [{ id: 'c', name: 'C' }, { id: 'c', name: 'again' }, { id: 'b', name: ' ' }, null, 5], prompts: [{ id: 'p', title: 'T', text: 'x', category: 'gone' }, { id: 'q', title: 'U', text: 'y', category: 'c' }, null] }));
    const st = Prompts.load(f);
    assert.deepStrictEqual(st.categories.map(c => [c.id, c.name]), [['mine', 'My prompts'], ['c', 'C'], ['b', 'Untitled']]);
    assert.deepStrictEqual(st.prompts.map(p => [p.id, p.category]), [['p', 'mine'], ['q', 'c']]);
  });

  await check('a saved audit with junk findings is read as far as it makes sense', () => {
    fs.mkdirSync(path.join(tmp, 'audits'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'audits', 'x.json'), JSON.stringify({ ranAt: 5, findings: [null, 5, { sev: {} }, { rule: 'SEC-001', sev: 'High', where: 'a.js:1', title: 't' }] }));
    assert.deepStrictEqual(lastAudit('x').findings.map(f => f.rule), ['SEC-001']);
    fs.writeFileSync(path.join(tmp, 'audits', 'y.json'), '[1]');
    assert.strictEqual(lastAudit('y'), null);
  });

  await check('a request body that is JSON but not an object (null, a number, a list) reads as an empty request', async () => {
    for (const b of ['null', '5', '[1,2]', '"x"']) assert.deepStrictEqual(await readBody(Readable.from([b])), {});
    assert.deepStrictEqual(await readBody(Readable.from(['{"a":1}'])), { a: 1 });
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
