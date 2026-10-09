// The disclosure pass on one folder, from the command line:
//   node tools/bridge/disclose.js [folder]   (default: TOMLIN's own folder)
// Uses the private details you listed in the Bridge (Audits, Private details), this PC's own details, and the names
// of the other folders beside it and in your working folders. Prints labels and places only, never the values.
// Exit code 1 when anything is found.
'use strict';
const fs = require('fs');
const path = require('path');
const { disclosurePass, autoDetails, readPrivateList } = require('../../src/bridge/disclosure');

// TOMLIN's own folder, and where the Bridge part keeps its data (BRIDGE_DATA, else the home's data/bridge).
const HERE = path.resolve(__dirname, '..', '..');
// The home as src/keep.ts defaultHome: "TOMLIN", or "Smart Manager" when only that one holds data.
function homeFolder() {
  const user = require('os').homedir();
  const old = path.join(user, 'Smart Manager');
  return !fs.existsSync(path.join(user, 'TOMLIN', 'data')) && fs.existsSync(path.join(old, 'data')) ? old : path.join(user, 'TOMLIN');
}
const DATA = process.env.BRIDGE_DATA || path.join(process.env.TOMLIN_DATA || path.join(process.env.TOMLIN_HOME || homeFolder(), 'data'), 'bridge');
const dir = path.resolve(process.argv[2] || HERE);
let settings = {};
try { settings = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')); } catch {}
const working = [...new Set([path.dirname(dir), ...(settings.workingFolders || [])].map(w => path.resolve(w)))];
const others = [];
for (const w of working) {
  try { for (const e of fs.readdirSync(w, { withFileTypes: true })) if (e.isDirectory() && !/^[._-]/.test(e.name) && path.join(w, e.name) !== dir) others.push(e.name); } catch {}
}
if (dir !== HERE) others.push(path.basename(HERE));

(async () => {
  const details = [...readPrivateList(path.join(DATA, 'private-details.json')), ...autoDetails(working)];
  const r = await disclosurePass(dir, { details, others, own: [path.basename(dir)] });
  console.log('Disclosure pass on ' + path.basename(dir) + ': ' + r.read.files + ' files, ' + r.read.zips + ' zips, ' + r.read.commits + ' commits, '
    + r.read.versions + ' past file versions; ' + new Set(details.map(d => d.label)).size + ' kinds of private detail, ' + others.length + ' other project names.');
  for (const f of r.findings) console.log('  [' + f.sev + '] ' + f.rule + '  ' + f.title + '\n         ' + f.where);
  for (const n of r.notes) console.log('  note: ' + n);
  console.log(r.findings.length ? r.findings.length + ' found.' : 'Nothing found.');
  process.exit(r.findings.length ? 1 : 0);
})();
