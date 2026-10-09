// What the Bridge holds while it runs: its settings, the project list, the local copies it started, token counts.
// One copy for the whole server (a Node module is loaded once), so every route sees the same state.
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const cfg = require('./config');
const Settings = require('./settings');
const { listProjects, listProjectsAsync, projectFolders } = require('./projects');

// Names, live addresses and extra start commands set without writing into any project (README: projects.json).
const OVERRIDES = path.join(cfg.DATA, 'projects.json');

const state = {
  settings: Settings.load(cfg.SETTINGS_FILE, cfg.DEFAULT_ROOT),
  projects: [],
  running: new Map(), // id -> { child, pid, port, name, started, log, url }
  tokens: { per: {}, month: {}, at: null, busy: false, error: null },
};

function saveSettings() { Settings.save(cfg.SETTINGS_FILE, state.settings); }
function refreshProjects(fresh) { state.projects = listProjects(state.settings, { bridgeDir: cfg.HERE, overridesFile: OVERRIDES, fresh }); return state.projects; }
async function refreshProjectsAsync(fresh) { state.projects = await listProjectsAsync(state.settings, { bridgeDir: cfg.HERE, overridesFile: OVERRIDES, fresh }); return state.projects; }
// The folders the list will hold, without reading them (cheap): lets slow reads start before the list is built.
function projectDirs() { return projectFolders(state.settings, { bridgeDir: cfg.HERE }).map(f => f.dir); }
function findProject(id) { return state.projects.find(p => p.id === id) || refreshProjects().find(p => p.id === id); }
const projectName = id => { const p = state.projects.find(x => x.id === id); return p ? p.name : id; };

// The project the Bridge itself is running on a port, if any: { id, name, port }.
function ownPortUser(port) {
  for (const [id, r] of state.running) if (r.port === port) return { id, name: projectName(id), port };
  return null;
}
// Every port a project's start commands use, merged alternates included (the same app on the next port).
const commandPorts = p => p.commands.flatMap(c => (c.alts || [c]).map(a => ({ ...c, ...a }))).filter(c => c.port);

// Counting reads 2+ GB of transcripts (~30 s), so it runs in a worker thread and never holds up a request.
// The worker keeps its per-file cache between counts, so a recount only rereads transcripts that grew.
let tokenWorker = null;
// A demo's projects have no transcripts: steady made-up numbers from each project's id (80M to 2.5B, 5-25% this month).
function demoTokens() {
  const per = {}, month = {};
  for (const p of state.projects) {
    let h = 0; for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    per[p.id] = 80e6 + (h % 2400) * 1e6 + (h % 997) * 1e3;
    month[p.id] = Math.round(per[p.id] * (0.05 + (h % 21) / 100));
  }
  state.tokens = { per, month, at: new Date().toISOString(), busy: false, error: null };
}
function refreshTokens() {
  if (cfg.DEMO) return demoTokens();
  if (state.tokens.busy) return;
  // No projects (a new home, a test copy): nothing to count, so the transcripts are not read at all.
  if (!state.projects.length) { state.tokens = { per: {}, month: {}, at: new Date().toISOString(), busy: false, error: null }; return; }
  state.tokens.busy = true;
  if (!tokenWorker) {
    tokenWorker = new Worker(path.join(__dirname, 'tokens-worker.js'));
    tokenWorker.on('message', m => {
      state.tokens = m.error ? { ...state.tokens, busy: false, error: m.error } : { per: m.total, month: m.month, at: new Date().toISOString(), busy: false, error: null };
    });
    tokenWorker.on('error', e => { state.tokens = { ...state.tokens, busy: false, error: String(e.message || e) }; tokenWorker = null; });
    tokenWorker.unref();
  }
  tokenWorker.postMessage({ projects: state.projects.map(p => ({ id: p.id, dir: p.dir })) });
}

module.exports = { state, saveSettings, refreshProjects, refreshProjectsAsync, projectDirs, findProject, projectName, ownPortUser, commandPorts, refreshTokens, demoTokens };
