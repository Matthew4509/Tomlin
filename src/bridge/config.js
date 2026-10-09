// Everything the Bridge part decides once at start: version, port, mode (real / dry run) and where its data lives.
// TOMLIN sets BRIDGE_PORT (its own port), BRIDGE_DATA (its home's data/bridge), BRIDGE_ROOT (the first working
// folder) and BRIDGE_SELF (a folder never listed as a project) before it loads this part (src/server/bridge.ts).
// The tests start the same code on a port of their own (test/bridge/serve.js). Nothing here changes while it runs.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP = path.resolve(__dirname, '..', '..'); // TOMLIN's own folder
const VERSION = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
const argPort = (process.argv.find(a => /^--port=\d+$/.test(a)) || '').slice(7);
// The demo mode of the stand-alone Myia Bridge is not part of TOMLIN: always off here.
const DEMO = false;
// Tests and trying things out: report windows, browsers and stops instead of doing them.
const DRY = process.env.BRIDGE_DRYRUN === '1' || process.argv.includes('--dry-run');
const PORT = Number(argPort || process.env.BRIDGE_PORT || 8485); // TOMLIN always sets its own
// First run only: the working folder to start with.
const DEFAULT_ROOT = path.resolve(process.env.BRIDGE_ROOT || path.join(APP, '..'));
const DATA = path.resolve(process.env.BRIDGE_DATA || path.join(APP, 'data-bridge'));
// The folder the projects list leaves out (TOMLIN's home: chats, models, backups, never a project).
const HERE = path.resolve(process.env.BRIDGE_SELF || DATA);
// The page and its files.
const PUBLIC = path.join(APP, 'public', 'bridge');

module.exports = {
  APP, HERE, PUBLIC, VERSION, PORT, DEMO, DRY, DEFAULT_ROOT, DATA,
  SETTINGS_FILE: path.join(DATA, 'settings.json'),
  RUN_FILE: path.join(DATA, 'run.json'),
  LIVE_FILE: path.join(DATA, 'live.json'),
  PROMPTS_FILE: path.join(DATA, 'prompts.json'),
  PRIVATE_FILE: path.join(DATA, 'private-details.json'), // what the disclosure pass looks for; never shipped, never sent
  JUDGED_FILE: path.join(DATA, 'judged.json'), // findings a person judged wrong (lib/judged.js); never shipped
  SNAPS: path.join(DATA, 'snaps'),
  KEY: crypto.randomBytes(18).toString('hex'), // per run; the page is served with it and must send it back
  STARTED: Date.now(),
  // The data folder carries its own .gitignore of "*": wherever it is, private details, settings and audits are never
  // offered for a commit.
  ensureDataDirs() {
    for (const d of ['audits', 'logs', 'snaps']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
    const gi = path.join(DATA, '.gitignore');
    try { if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Made by TOMLIN: everything here stays on this PC.\n*\n'); } catch {}
  },
};
