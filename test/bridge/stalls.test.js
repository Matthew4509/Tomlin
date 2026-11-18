// The Bridge never holds the server's one thread for long: the push check on a big site lets chats and linked PCs go
// on between files, the AI review prompt walks a folder of 40,000 pictures quickly, and the git name and email (looked
// up for the private-details check) are not asked of git again on every audit, review and page (240 ms each, measured).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-stall-'));
const rm = d => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10 });

/**
 * The longest the event loop was held while `fn` ran (a 5 ms timer measures the gaps). Counted in the CPU time this
 * process used, not on the clock: while the whole suite runs, other programs can keep it waiting, and that is no hold
 * of its own making.
 */
async function longestGap(fn) {
  const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  let last = cpu();
  let worst = 0;
  const t = setInterval(() => { const now = cpu(); worst = Math.max(worst, now - last); last = now; }, 5);
  try { await fn(); } finally { clearInterval(t); }
  return Math.max(worst, cpu() - last);
}

test('the push check on a site of 4,000 PHP files never holds the server for more than a moment', async () => {
  const { checkFolder } = require('../../src/bridge/hosting/check');
  const dir = tmp();
  try {
    const site = path.join(dir, 'public_html');
    for (let i = 0; i < 4000; i++) {
      const sub = path.join(site, 'wp-content', 'plugins', `p${i % 40}`);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, `f${i}.php`), `<?php\n// plugin file ${i}\nfunction f${i}($a) { return $a + ${i}; }\n`.repeat(20));
    }
    let out;
    const gap = await longestGap(async () => { out = await checkFolder({ projectDir: dir, folder: site, secrets: {}, details: [] }); });
    assert.equal(out.files.length, 4000);
    assert.ok(gap < 300, `the server was held for ${gap} ms in one go`);
  } finally { rm(dir); }
});

// 40,000 files take a while to make and remove on a busy PC with a virus scanner (one run hung about 17 minutes): they
// are made and removed without blocking, so the hard time limit below can always end the test. The walk itself is
// judged by the work it does (no path is worked out for a picture) and by the CPU time it used, not the clock.
test('the AI review prompt walks a folder of 40,000 pictures quickly, and still finds the code', { timeout: 600_000 }, async () => {
  const { fileGroups } = require('../../src/bridge/review');
  const dir = tmp();
  try {
    const subs = Array.from({ length: 60 }, (_, i) => path.join(dir, 'uploads', String(2020 + (i % 5)), String(i % 12)));
    for (const sub of subs) await fs.promises.mkdir(sub, { recursive: true });
    for (let i = 0; i < 40000; i += 500) {
      await Promise.all(Array.from({ length: 500 }, (_, k) => fs.promises.writeFile(path.join(subs[(i + k) % 60], `photo${i + k}.jpg`), '')));
    }
    await fs.promises.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'src', 'payment.js'), 'export const pay = () => 1;');
    // Every path worked out during the walk is counted (the walk joins a path only for a folder or a code file).
    let joins = 0;
    const join = path.join;
    path.join = (...a) => { joins++; return join(...a); };
    const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
    let groups, ms;
    try {
      const c0 = cpu();
      groups = fileGroups(dir);
      ms = cpu() - c0;
    } finally { path.join = join; }
    assert.ok(JSON.stringify(groups).includes('payment.js'), JSON.stringify(groups).slice(0, 300));
    assert.ok(joins < 200, `${joins} paths worked out for a folder of 40,000 pictures`);
    assert.ok(ms < 400, `${ms} ms of CPU`);
  } finally { await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10 }); }
});

// Counted, not timed: git is asked through child_process, so a fresh copy of the disclosure module is loaded with
// execFileSync counting the git calls (a busy PC can make a cached lookup slow on the clock, never make it ask git).
test('the git name and email are asked of git once, not on every audit and page', () => {
  const cp = require('child_process');
  const real = cp.execFileSync;
  const file = require.resolve('../../src/bridge/disclosure');
  const cached = require.cache[file];
  let asked = 0;
  cp.execFileSync = (cmd, ...rest) => { if (/^git(\.exe)?$/i.test(path.basename(String(cmd)))) asked++; return real.call(cp, cmd, ...rest); };
  try {
    delete require.cache[file];
    const { autoDetails } = require(file);
    autoDetails();
    const first = asked;
    assert.ok(first > 0, 'the first lookup asks git');
    for (let i = 0; i < 10; i++) autoDetails();
    assert.equal(asked - first, 0, `10 more lookups asked git ${asked - first} more times`);
  } finally {
    cp.execFileSync = real;
    if (cached) require.cache[file] = cached; else delete require.cache[file];
  }
});
