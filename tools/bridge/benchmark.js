// The scanner's benchmark: how many kinds of real fault it finds. test/museum/ holds one small made-up project per
// fault class, each written twice: "bad" with the fault, "good" with it fixed. A class counts as caught when the scan
// flags the bad copy at the faulty place AND stays quiet on the good one at the same place.
//   node tools/benchmark.js              recall per bucket (R one-file rule, X across files, L live site) and per class
//   node tools/benchmark.js --missed     also list every class it misses
//   node tools/benchmark.js --json out.json      save the result (ids caught, noisy, missed) to compare later
//   node tools/benchmark.js --only <id>  run one class and print every finding on both copies
// The classes come from 839 faults that reviewers and the owner found in real projects; "faults" on a class is how
// many of those it stands for, so the weighted figure says how much of that real list the scanner would have caught.
// Judgement faults (money rules, wording against behaviour) are not here: no rule finds those (see the review layer).
// Nothing outside a temp folder is written; every copy is made in the temp folder and removed after.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { runAudit } = require('../../src/bridge/audit');

const MUSEUM = path.join(__dirname, '..', '..', 'test', 'bridge', 'museum');
const { TOKENS, fill } = require('../../test/bridge/museum/kit');
const DISCLOSURE = {
  details: [{ label: 'my email', value: TOKENS.EMAIL }, { label: 'my phone', value: TOKENS.PHONE }, { label: 'my name', value: 'Pat Quill', allowOn: /\bcopyright\b/i }],
  others: [TOKENS.OTHER, 'quartz-ledger'],
};

function loadCases() {
  const out = [];
  for (const f of fs.readdirSync(MUSEUM).filter(n => /^cases-.*\.js$/.test(n)).sort()) {
    for (const c of require(path.join(MUSEUM, f))) out.push({ ...c, title: fill(c.title || ''), from: f });
  }
  const ids = new Set();
  for (const c of out) {
    if (!c.id || ids.has(c.id)) throw new Error('museum: missing or repeated id ' + c.id + ' in ' + c.from);
    if (c.quiet) { if (!c.files) throw new Error('museum: quiet case ' + c.id + ' needs its files'); ids.add(c.id); continue; }
    if (!/^[RXL]$/.test(c.bucket)) throw new Error('museum: ' + c.id + ' has no bucket R, X or L');
    if (!c.bad || !c.good) throw new Error('museum: ' + c.id + ' needs a bad and a good copy');
    ids.add(c.id);
  }
  return out;
}

function writeCopy(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    if (rel === 'site') continue;
    const p = path.join(dir, fill(rel));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.isBuffer(text) ? text : fill(typeof text === 'function' ? text() : text));
  }
}

// A made-up site: { '/path': { status, headers, body } }; '*' answers every other path (a soft-404 site); else 404.
function serve(routes) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const r = routes[req.url.split('?')[0]] || routes['*'];
      if (!r) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Not found</title>'); }
      res.writeHead(r.status || 200, { 'Content-Type': 'text/html; charset=utf-8', ...(r.headers || {}) });
      res.end(fill(r.body || ''));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

// Which findings belong to the class: the rule filter (code rules by default; the disclosure rules for a disclosure
// class; c.rule to name one) and, when the case names it, the place (c.at: a file, file:line or address part).
// Caught: a finding on the bad copy that the good copy does not have (same rule, same file or address). Unrelated
// findings both copies share cancel out, so a case is judged on its one difference.
const placeOf = f => [f.where, ...(f.also || []), f.title].join(' | ');
const keyOf = f => f.rule + '|' + String(f.where).replace(/:\d+$/, '');
function judge(c, bad, good) {
  const rule = c.rule ? new RegExp(c.rule) : (c.disc ? /^DISC-/ : /^(?!DISC-)/);
  const inClass = typeof c.hit === 'function' ? c.hit : f => rule.test(f.rule) && (!c.at || placeOf(f).includes(c.at));
  const goodKeys = new Set(good.map(keyOf)), badKeys = new Set(bad.map(keyOf));
  const found = bad.filter(f => inClass(f) && !goodKeys.has(keyOf(f)));
  const noise = good.filter(f => inClass(f) && (!badKeys.has(keyOf(f)) || c.at));
  return { found, noise };
}

async function scanCopy(c, side) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'museum-' + c.id + '-' + side + '-'));
  const files = c.quiet ? c.files : c[side];
  const servers = [];
  try {
    writeCopy(dir, files);
    if (typeof c.git === 'function') {
      const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', windowsHide: true });
      git('init', '-q'); git('config', 'user.email', 'museum@example.org'); git('config', 'user.name', 'Museum'); git('config', 'commit.gpgsign', 'false');
      c.git(side, dir, git, writeCopy);
    }
    if (typeof c.prepare === 'function') c.prepare(side, dir);
    let url = null;
    const opts = { disclosure: c.disc ? { ...DISCLOSURE, own: [c.id] } : null };
    const site = files.site;
    if (site) {
      const live = await serve(site.live || {});
      servers.push(live);
      if (site.local) { const local = await serve(site.local); servers.push(local); url = 'http://127.0.0.1:' + local.address().port + '/'; }
      Object.assign(opts, { liveUrl: 'https://shop.museum-site.example/', resolve: () => ({ host: '127.0.0.1', port: live.address().port }), gapMs: 0, minGapMs: 0, maxPages: 4 });
      // DNS answers for the made-up site (mail policy, CAA): no check reads them yet (phase T5).
      if (site.dns) opts.dnsTxt = name => site.dns[name] || null;
    }
    const r = await runAudit(dir, url, opts);
    return r.findings;
  } finally {
    for (const s of servers) s.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function run(cases) {
  const results = [];
  for (const c of cases) {
    let bad = [], good = [], error = null;
    if (c.quiet) {
      // A must-stay-quiet case: ordinary text that a rule once flagged. Any finding in its class is a false flag.
      try { good = await scanCopy(c, 'files'); } catch (e) { error = e.message; }
      const noise = judge(c, [], good).noise;
      results.push({ c, quiet: true, caught: false, noisy: noise.length > 0, error, bad, good, found: [], noise });
      continue;
    }
    try { bad = await scanCopy(c, 'bad'); good = await scanCopy(c, 'good'); } catch (e) { error = e.message; }
    const { found, noise } = judge(c, bad, good);
    results.push({ c, caught: !error && found.length > 0 && noise.length === 0, flagged: found.length > 0, noisy: noise.length > 0, error, bad, good, found, noise });
  }
  return results;
}

function report(results, showMissed) {
  const pct = (a, b) => (b ? Math.round(a * 100 / b) + '%' : '-');
  const lines = [];
  const all = { n: 0, k: 0, f: 0, fk: 0 };
  lines.push('Bucket                        classes caught      real faults they stand for');
  const quiet = results.filter(r => r.quiet);
  results = results.filter(r => !r.quiet);
  for (const [b, name] of [['R', 'R  one-file rule'], ['X', 'X  across files / compare'], ['L', 'L  live site']]) {
    const rs = results.filter(r => r.c.bucket === b);
    const k = rs.filter(r => r.caught).length, f = rs.reduce((s, r) => s + (r.c.faults || 1), 0), fk = rs.filter(r => r.caught).reduce((s, r) => s + (r.c.faults || 1), 0);
    all.n += rs.length; all.k += k; all.f += f; all.fk += fk;
    lines.push(name.padEnd(30) + (k + ' of ' + rs.length).padEnd(9) + pct(k, rs.length).padStart(5) + '      ' + (fk + ' of ' + f).padEnd(11) + pct(fk, f).padStart(5));
  }
  lines.push('All'.padEnd(30) + (all.k + ' of ' + all.n).padEnd(9) + pct(all.k, all.n).padStart(5) + '      ' + (all.fk + ' of ' + all.f).padEnd(11) + pct(all.fk, all.f).padStart(5));
  const noisy = results.filter(r => r.noisy), errors = [...results, ...quiet].filter(r => r.error);
  lines.push('', 'Must stay quiet: ' + quiet.filter(r => !r.noisy && !r.error).length + ' of ' + quiet.length + ' quiet'
    + (quiet.some(r => r.noisy) ? ' (false flags: ' + quiet.filter(r => r.noisy).map(r => r.c.id + ' (' + [...new Set(r.noise.map(f => f.rule))].join(',') + ')').join(', ') + ')' : ''));
  if (noisy.length) lines.push('', 'Flagged the fixed copy too (not counted as caught): ' + noisy.map(r => r.c.id + ' (' + [...new Set(r.noise.map(f => f.rule))].join(',') + ')').join(', '));
  if (errors.length) lines.push('', 'Could not run: ' + errors.map(r => r.c.id + ': ' + r.error).join('; '));
  const byPhase = new Map();
  for (const r of results) { const p = r.c.phase || '-'; const x = byPhase.get(p) || { n: 0, k: 0 }; x.n++; if (r.caught) x.k++; byPhase.set(p, x); }
  lines.push('', 'By the phase that is to build it: ' + [...byPhase].sort().map(([p, x]) => p + ' ' + x.k + '/' + x.n).join(', '));
  lines.push('', 'Caught: ' + (results.filter(r => r.caught).map(r => r.c.id + ' (' + [...new Set(r.found.map(f => f.rule))].join(',') + ')').join(', ') || 'none'));
  if (showMissed) {
    lines.push('', 'Missed:');
    for (const r of results.filter(x => !x.caught)) lines.push('  ' + r.c.bucket + ' ' + r.c.id.padEnd(30) + (r.c.phase || '').padEnd(4) + r.c.title);
  }
  return { text: lines.join('\n'), totals: all };
}

if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  let cases = loadCases();
  if (only) cases = cases.filter(c => c.id === only);
  if (!cases.length) { console.log('No class called ' + only + '.'); process.exit(2); }
  const t0 = Date.now();
  const results = await run(cases);
  if (only) {
    const r = results[0];
    const show = fs_ => fs_.map(f => '  ' + f.rule + ' ' + f.sev + ' ' + f.where + ' | ' + f.title).join('\n') || '  (none)';
    if (r.quiet) { console.log(r.c.id + ': ' + (r.noisy ? 'FALSE FLAG' : 'quiet') + (r.error ? ' error: ' + r.error : '') + '\nfindings:\n' + show(r.good)); return; }
    console.log(r.c.id + ': ' + (r.caught ? 'CAUGHT' : r.noisy ? 'NOISY (flags the fixed copy too)' : 'MISSED') + (r.error ? ' error: ' + r.error : ''));
    console.log('bad copy:\n' + show(r.bad) + '\ngood copy:\n' + show(r.good));
    return;
  }
  const rep = report(results, args.includes('--missed'));
  console.log('Museum: ' + cases.length + ' fault classes, ' + Math.round((Date.now() - t0) / 1000) + ' s\n\n' + rep.text);
  if (args.includes('--json')) {
    const out = args[args.indexOf('--json') + 1];
    fs.writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), totals: rep.totals,
      caught: results.filter(r => r.caught).map(r => r.c.id), noisy: results.filter(r => r.noisy).map(r => r.c.id),
      missed: results.filter(r => !r.caught && !r.quiet).map(r => r.c.id) }, null, 1));
    console.log('\nSaved to ' + out);
  }
})();

module.exports = { loadCases, run, report };
