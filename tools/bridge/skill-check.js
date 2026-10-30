// Check a skill, plugin or agent folder before it is installed (src/bridge/agents.js): the same check as the Bridge page's Audits › Check a skill.
//   node tools/bridge/skill-check.js <folder | .zip | .skill | SKILL.md>   one skill
//   node tools/bridge/skill-check.js                                       every skill already installed: ~/.claude/skills,
//                                                                          ~/.claude/plugins, and .claude/skills here
// Read only: nothing in a skill is run or sent anywhere. Exit code 1 when any skill gets "Do not install".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkSkill } = require('../../src/bridge/agents');

function installed() {
  const out = [];
  const each = d => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) out.push(path.join(d, e.name)); } catch {} };
  each(path.join(os.homedir(), '.claude', 'skills'));
  each(path.join(process.cwd(), '.claude', 'skills'));
  // plugins: each installed plugin's own folder, wherever the marketplace cache keeps it
  const plugins = path.join(os.homedir(), '.claude', 'plugins');
  const walk = (d, depth) => {
    if (depth > 5) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.isDirectory() && e.name === '.claude-plugin')) return out.push(d);
    for (const e of ents) if (e.isDirectory() && !['node_modules', '.git'].includes(e.name)) walk(path.join(d, e.name), depth + 1);
  };
  walk(plugins, 0);
  return out;
}

const targets = process.argv.slice(2).filter(a => !a.startsWith('--'));
const list = targets.length ? targets : installed();
if (!list.length) { console.log('No skills found in ~/.claude/skills, ~/.claude/plugins or .claude/skills. Name a folder or zip to check.'); process.exit(0); }
let blocked = 0;
for (const t of list) {
  const r = checkSkill({ path: t });
  console.log('');
  if (r.error) { console.log(t + '\n  ' + r.error); continue; }
  if (r.verdict === 'do-not-install') blocked++;
  console.log(t + '\n  ' + r.headline.toUpperCase() + ' (' + r.counts.Critical + ' critical, ' + r.counts.High + ' high, ' + r.counts.Medium + ' to read first; ' + r.filesRead.length + ' files)');
  for (const f of r.findings) console.log('  ' + f.sev.padEnd(9) + f.rule + '  ' + f.where + '\n             ' + f.title);
  const d = r.does;
  if (d.runs.length) console.log('  Runs:     ' + d.runs.join(', '));
  if (d.hooks.length) console.log('  Hooks:    ' + d.hooks.join(' | '));
  if (d.hosts.length) console.log('  Talks to: ' + d.hosts.join(', '));
  if (d.keys.length) console.log('  Keys:     ' + d.keys.join(', '));
  for (const n of r.notes) console.log('  Note: ' + n);
}
console.log('\n' + list.length + ' checked' + (blocked ? ', ' + blocked + ' should not be installed.' : ', none with a known attack.') + ' A pass means no known attack was found, not that a skill is safe.');
process.exitCode = blocked ? 1 : 0;
