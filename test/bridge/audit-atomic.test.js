// F18 (N34): the saved audit is written to a temp file and swapped in, so a save that fails part way leaves the
// last good report as it was. The swap is made to fail here (no disk is filled). Run: node test/audit-atomic.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-atomic-'));
process.env.BRIDGE_DATA = path.join(tmp, 'data'); // before lib/config is loaded
const store = require('../../src/bridge/audit-store');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };

(async () => {
  const dir = path.join(tmp, 'shop');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Shop</title>\n');
  const p = { id: 'shop', dir, folder: 'shop', name: 'Shop', auditSkip: [], auditSkipOwn: [], auditInclude: [] };
  const first = await store.auditProject(p, null);
  const saved = path.join(process.env.BRIDGE_DATA, 'audits', 'shop.json');
  const before = fs.readFileSync(saved, 'utf8');
  await check('a first audit is saved', () => assert(first && before.includes('"findings"')));

  fs.writeFileSync(path.join(dir, 'app.js'), 'eval(location.hash);\n'); // so the next report differs
  const real = fs.renameSync;
  fs.renameSync = (a, b) => { if (/\.tmp$/.test(String(a))) { const e = new Error('no space left'); e.code = 'ENOSPC'; throw e; } return real(a, b); };
  let threw = false;
  try { await store.auditProject(p, null); } catch { threw = true; }
  fs.renameSync = real;
  await check('a save that fails to swap in throws', () => assert(threw));
  await check('the old report is still there, whole', () => assert.strictEqual(fs.readFileSync(saved, 'utf8'), before));
  await check('no half-written temp file is left behind', () => assert(!fs.readdirSync(path.dirname(saved)).some(f => /\.tmp$/.test(f)), fs.readdirSync(path.dirname(saved)).join()));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
