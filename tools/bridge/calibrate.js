// Before/after for scanner changes: runs the audit (code rules + disclosure pass, no localhost, no live site) over every
// project in your working folders, read-only, and saves what it found to a file you name. Then compare two saves.
//   node tools/bridge/calibrate.js save <out.json> [working folder ...]   (default: the working folders in the Bridge's settings.json)
//   node tools/bridge/calibrate.js compare <before.json> <after.json>
// Nothing is written into any project. The save holds rule ids, labels and places (file:line), never a private value.
// Keep the saves outside every project folder (a temp folder): they name your projects.
'use strict';
const fs = require('fs');
const path = require('path');
const { runAudit } = require('../../src/bridge/audit');
const { autoDetails, readPrivateList } = require('../../src/bridge/disclosure');

// TOMLIN's own folder, and where the Bridge part keeps its data (BRIDGE_DATA, else the home's data/bridge).
const HERE = path.resolve(__dirname, '..', '..');
// The home as src/keep.ts defaultHome: "TOMLIN", or "Smart Manager" when only that one holds data.
function homeFolder() {
  const user = require('os').homedir();
  const old = path.join(user, 'Smart Manager');
  return !fs.existsSync(path.join(user, 'TOMLIN', 'data')) && fs.existsSync(path.join(old, 'data')) ? old : path.join(user, 'TOMLIN');
}
const DATA = process.env.BRIDGE_DATA || path.join(process.env.TOMLIN_DATA || path.join(process.env.TOMLIN_HOME || homeFolder(), 'data'), 'bridge');
const [cmd, a, b, ...rest] = process.argv.slice(2);

async function save(out, roots) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')); } catch {}
  const working = (roots.length ? roots : settings.workingFolders || [path.dirname(HERE)]).map(w => path.resolve(w));
  const dirs = [];
  for (const w of working) {
    try { for (const e of fs.readdirSync(w, { withFileTypes: true })) if (e.isDirectory() && !/^[._-]/.test(e.name)) dirs.push(path.join(w, e.name)); } catch {}
  }
  const details = [...readPrivateList(path.join(DATA, 'private-details.json')), ...autoDetails(working)];
  const result = { ranAt: new Date().toISOString(), projects: {} };
  for (const dir of dirs) {
    const own = path.basename(dir);
    const others = dirs.filter(d => d !== dir).map(d => path.basename(d));
    if (dir !== HERE) others.push(path.basename(HERE));
    const t0 = Date.now();
    let r;
    try { r = await runAudit(dir, null, { disclosure: { details, others, own: [own] } }); }
    catch (e) { console.log(own + ': failed (' + e.message + ')'); continue; }
    result.projects[own] = { seconds: Math.round((Date.now() - t0) / 100) / 10, findings: r.findings.map(f => ({ rule: f.rule, sev: f.sev, where: f.where, title: f.title, fp: f.fp || null, ...(f.also ? { also: f.also } : {}) })) };
    console.log(own + ': ' + r.findings.length + ' findings, ' + result.projects[own].seconds + ' s');
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  console.log('Saved ' + Object.keys(result.projects).length + ' projects to ' + out);
}

function compare(beforeFile, afterFile) {
  const A = JSON.parse(fs.readFileSync(beforeFile, 'utf8')).projects, B = JSON.parse(fs.readFileSync(afterFile, 'utf8')).projects;
  const key = f => f.rule + ' ' + f.where;
  const byRule = new Map(); // rule -> [before, after]
  const lines = [];
  let tb = 0, ta = 0;
  for (const name of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
    const fa = (A[name] || {}).findings || [], fb = (B[name] || {}).findings || [];
    tb += fa.length; ta += fb.length;
    for (const f of fa) (byRule.get(f.rule) || byRule.set(f.rule, [0, 0]).get(f.rule))[0]++;
    for (const f of fb) (byRule.get(f.rule) || byRule.set(f.rule, [0, 0]).get(f.rule))[1]++;
    const kb = new Set(fb.map(key)), ka = new Set(fa.map(key));
    const gone = fa.filter(f => !kb.has(key(f))), added = fb.filter(f => !ka.has(key(f)));
    lines.push(name + ': ' + fa.length + ' -> ' + fb.length + (gone.length || added.length ? '  (' + gone.length + ' gone, ' + added.length + ' new)' : ''));
    for (const f of gone) lines.push('   - ' + f.rule + '  ' + f.where + '  | ' + f.title);
    for (const f of added) lines.push('   + ' + f.rule + '  ' + f.where + '  | ' + f.title);
  }
  console.log('All projects: ' + tb + ' -> ' + ta + ' findings\n\nPer rule:');
  for (const [r, [x, y]] of [...byRule].sort()) console.log('  ' + r.padEnd(10) + String(x).padStart(5) + ' -> ' + String(y).padStart(5));
  console.log('\nPer project:\n' + lines.join('\n'));
}

(async () => {
  if (cmd === 'save' && a) await save(path.resolve(a), [b, ...rest].filter(Boolean));
  else if (cmd === 'compare' && a && b) compare(a, b);
  else { console.log('Use: node tools/bridge/calibrate.js save <out.json> [working folder ...]  |  compare <before.json> <after.json>'); process.exit(2); }
})();
