// About › Bring in from Myia Bridge: copies a stand-alone Myia Bridge's lists into this one. The other Bridge is only
// read. What was here before is moved aside (data/bridge/before-import-<time>/), never deleted, so it can be put back.
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const Settings = require('./settings');
const { state, refreshProjects, refreshTokens } = require('./state');
const { live } = require('./live-state');

// Its data folder's files and folders that hold the person's lists (logs, run.json and site pictures are not brought).
const FILES = ['settings.json', 'prompts.json', 'private-details.json', 'judged.json', 'live.json'];
const DIRS = ['audits', 'faults'];

// A Myia Bridge folder: its server.js naming Myia Bridge, its lib folder and a data folder beside them.
function isBridge(dir) {
  try {
    if (!fs.statSync(path.join(dir, 'data')).isDirectory() || !fs.existsSync(path.join(dir, 'lib', 'config.js'))) return false;
    return /Myia Bridge/.test(fs.readFileSync(path.join(dir, 'server.js'), 'utf8'));
  } catch { return false; }
}

// Bridges next to the working folders' projects (the usual place: a folder beside the others), at most 5.
function candidates() {
  const roots = [...new Set([cfg.DEFAULT_ROOT, ...(state.settings.workingFolders || [])].map(r => path.resolve(r)))];
  const found = [];
  for (const root of roots) {
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const dir = path.join(root, e.name);
      if (e.isDirectory() && !found.includes(dir) && isBridge(dir)) found.push(dir);
      if (found.length >= 5) return found;
    }
  }
  return found;
}

// This PC's own time, as a folder name: 2026-10-08 121923.
const stamp = () => { const d = new Date(), two = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds()); };

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.json')) { fs.copyFileSync(path.join(from, e.name), path.join(to, e.name)); n++; }
  }
  return n;
}

function importFrom(folder) {
  if (typeof folder !== 'string' || !folder.trim()) return { ok: false, error: 'No folder was given. Choose the Myia Bridge folder (the one with start-bridge.cmd in it).' };
  const dir = path.resolve(folder.trim());
  if (!isBridge(dir)) return { ok: false, error: dir + ' is not a Myia Bridge folder: it does not have the server.js, lib folder and data folder a Myia Bridge has. Choose the folder with start-bridge.cmd in it.' };
  const from = path.join(dir, 'data');
  const wanted = FILES.filter(f => fs.existsSync(path.join(from, f)));
  const dirs = DIRS.filter(d => fs.existsSync(path.join(from, d)));
  const overrides = fs.existsSync(path.join(dir, 'projects.json'));
  if (!wanted.length && !dirs.length && !overrides) return { ok: false, error: 'That Myia Bridge has nothing to bring in yet (no settings, prompts or lists in its data folder).' };
  // A settings or prompts file that cannot be read would be set aside on first use and lost: refuse it now instead.
  for (const f of wanted) {
    try { JSON.parse(fs.readFileSync(path.join(from, f), 'utf8').replace(/^﻿/, '')); }
    catch { return { ok: false, error: 'Its ' + f + ' could not be read (damaged or half-written), so nothing was brought in. Start that Myia Bridge once (it repairs or sets the file aside), then try again.' }; }
  }

  // What is here now goes aside first.
  const aside = path.join(cfg.DATA, 'before-import-' + stamp());
  fs.mkdirSync(aside, { recursive: true });
  for (const f of [...FILES, 'projects.json']) if (fs.existsSync(path.join(cfg.DATA, f))) fs.renameSync(path.join(cfg.DATA, f), path.join(aside, f));
  for (const d of DIRS) if (fs.existsSync(path.join(cfg.DATA, d))) fs.renameSync(path.join(cfg.DATA, d), path.join(aside, d));

  for (const f of wanted) fs.copyFileSync(path.join(from, f), path.join(cfg.DATA, f));
  const counts = {};
  for (const d of dirs) counts[d] = copyDir(path.join(from, d), path.join(cfg.DATA, d));
  fs.mkdirSync(path.join(cfg.DATA, 'audits'), { recursive: true });
  if (overrides) fs.copyFileSync(path.join(dir, 'projects.json'), path.join(cfg.DATA, 'projects.json'));

  // In use from now on: settings and live lights read again, the list and the token counts rebuilt.
  state.settings = Settings.load(cfg.SETTINGS_FILE, cfg.DEFAULT_ROOT);
  try { live.state = JSON.parse(fs.readFileSync(cfg.LIVE_FILE, 'utf8')) || {}; } catch { live.state = {}; }
  live.rev++;
  refreshProjects(true);
  refreshTokens();
  return {
    ok: true, from: dir, aside,
    brought: [...wanted, ...dirs.map(d => d + ' (' + counts[d] + ')'), ...(overrides ? ['projects.json'] : [])],
    folders: state.settings.workingFolders.length, projects: state.projects.length,
  };
}

module.exports = { candidates, importFrom, isBridge };
