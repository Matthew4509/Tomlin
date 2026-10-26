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

/** The longest the event loop was held while `fn` ran (a 5 ms timer measures the gaps). */
async function longestGap(fn) {
  let last = Date.now();
  let worst = 0;
  const t = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  try { await fn(); } finally { clearInterval(t); }
  return Math.max(worst, Date.now() - last);
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

test('the AI review prompt walks a folder of 40,000 pictures quickly, and still finds the code', () => {
  const { fileGroups } = require('../../src/bridge/review');
  const dir = tmp();
  try {
    for (let i = 0; i < 40000; i++) {
      const sub = path.join(dir, 'uploads', String(2020 + (i % 5)), String(i % 12));
      if (i < 60) fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, `photo${i}.jpg`), '');
    }
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'payment.js'), 'export const pay = () => 1;');
    const t0 = Date.now();
    const groups = fileGroups(dir);
    const ms = Date.now() - t0;
    assert.ok(JSON.stringify(groups).includes('payment.js'), JSON.stringify(groups).slice(0, 300));
    assert.ok(ms < 400, `${ms} ms`);
  } finally { rm(dir); }
});

test('the git name and email are asked of git once, not on every audit and page', () => {
  const { autoDetails } = require('../../src/bridge/disclosure');
  autoDetails();
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) autoDetails();
  const ms = Date.now() - t0;
  assert.ok(ms < 100, `10 more lookups took ${ms} ms`);
});
