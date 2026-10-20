// Tests for lib/audit-run.js: the audit runs in a child process at below-normal priority, gives the same report as a
// run in this process, leaves this process's thread free while it scans, and says so when the child dies.
// Run: node test/bridge/audit-run.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { runAudit } = require('../../src/bridge/audit');
const { auditOffThread } = require('../../src/bridge/audit-run');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-auditrun-'));
// Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const same = a => { const { ranAt: _r, seconds: _s, ...rest } = a; return rest; };

async function main() {
  w('app/index.html', '<form method="post" action="/x"><input name="a"></form>');
  w('app/hash.php', '<?php $h = md5($password);');
  const dir = path.join(tmp, 'app');
  const opts = { notes: ['a note from the caller'], judged: [] };

  await check('the child gives the same report as a run in this process', async () => {
    const here = await runAudit(dir, null, opts);
    const there = await auditOffThread(dir, null, opts);
    assert(there.findings.length >= 2, JSON.stringify(there.findings));
    assert.deepStrictEqual(same(there), same(here));
  });

  await check('the child runs at below-normal priority', async () => {
    let pri = null;
    await auditOffThread(dir, null, opts, { onStart: pid => { pri = os.getPriority(pid); } });
    assert.strictEqual(pri, os.constants.priority.PRIORITY_BELOW_NORMAL);
  });

  await check('this thread keeps answering while a slow scan runs', async () => {
    process.env.BRIDGE_TEST_AUDIT_SPIN_MS = '1500';
    let ticks = 0;
    const t = setInterval(() => ticks++, 50);
    try { await auditOffThread(dir, null, opts); } finally { clearInterval(t); delete process.env.BRIDGE_TEST_AUDIT_SPIN_MS; }
    assert(ticks >= 15, 'only ' + ticks + ' ticks in 1.5 s');
  });

  await check('a child that dies before answering is reported, not waited on', async () => {
    process.env.BRIDGE_TEST_AUDIT_SPIN_MS = '5000';
    let err = null;
    try { await auditOffThread(dir, null, opts, { onStart: pid => setTimeout(() => process.kill(pid), 300) }); }
    catch (e) { err = e; }
    finally { delete process.env.BRIDGE_TEST_AUDIT_SPIN_MS; }
    assert(err && /stopped before it finished/.test(err.message), err ? err.message : 'no error');
  });
}

main().then(() => {
  console.log(failures ? failures + ' failed' : 'all passed');
  process.exit(failures ? 1 : 0);
}, e => { console.log('FAIL crashed: ' + (e.stack || e)); process.exit(1); });
