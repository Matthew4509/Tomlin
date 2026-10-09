// The project list and the Folders page: working folders, projects added one by one, removed projects, My order.
// Paths only: nothing typed here is ever run.
'use strict';
const path = require('path');
const cfg = require('../config');
const Settings = require('../settings');
const { keyOf } = require('../projects');
const { state, saveSettings, refreshProjects } = require('../state');
const { listView, settingsView, scanFolders, laptopStats } = require('../views');
const desktop = require('../desktop');

const has = (list, p) => list.some(x => keyOf(x) === keyOf(p));
const drop = (list, p) => list.filter(x => keyOf(x) !== keyOf(p));

const get = {
  '/api/projects': async ({ url }) => ({ projects: await listView(url.searchParams.get('fresh') === '1'), stats: laptopStats() }),
  '/api/settings': () => { refreshProjects(); return settingsView(); },
};

const post = {
  '/api/folders/add': ({ body }) => {
    const bad = Settings.checkFolder(body.path, 'a working folder');
    if (bad) return { ok: false, error: bad };
    const dir = path.resolve(body.path.trim());
    if (has(state.settings.workingFolders, dir)) return { ok: false, error: dir + ' is already a working folder.' };
    state.settings.workingFolders.push(dir);
    saveSettings();
    const scan = scanFolders();
    return { ok: true, path: dir, projects: state.projects.filter(p => p.workingFolder && keyOf(p.workingFolder) === keyOf(dir)).length, scan };
  },
  '/api/folders/open': ({ body }) => {
    const f = state.settings.workingFolders.find(x => keyOf(x) === keyOf(String(body.path || '')));
    if (!f) return { ok: false, error: 'That folder is not on the list any more. Reload the page.' };
    return { ok: true, ...desktop.openFolder(f) };
  },
  '/api/folders/remove': ({ body }) => {
    if (!has(state.settings.workingFolders, String(body.path || ''))) return { ok: false, error: 'That folder is not on the list any more. Reload the page.' };
    state.settings.workingFolders = drop(state.settings.workingFolders, body.path);
    saveSettings();
    return { ok: true, scan: scanFolders() };
  },
  '/api/projects/add': ({ body }) => {
    const bad = Settings.checkFolder(body.path, 'a project');
    if (bad) return { ok: false, error: bad };
    const dir = path.resolve(body.path.trim());
    if (keyOf(dir) === keyOf(cfg.HERE)) return { ok: false, error: 'That is TOMLIN\'s own home folder (your chats, staff, models and backups), not a project.' };
    const { settings } = state;
    const wasHidden = has(settings.hidden, dir);
    settings.hidden = drop(settings.hidden, dir);
    const projects = refreshProjects();
    if (!wasHidden && projects.some(p => keyOf(p.dir) === keyOf(dir))) return { ok: false, error: path.basename(dir) + ' is already on the list.' };
    if (!projects.some(p => keyOf(p.dir) === keyOf(dir))) settings.extraProjects.push(dir);
    saveSettings();
    scanFolders();
    const p = state.projects.find(x => keyOf(x.dir) === keyOf(dir));
    return { ok: true, id: p && p.id, name: p ? p.name : path.basename(dir) };
  },
  // My order: the page sends the project ids in the order the person wants; stored as folder paths.
  '/api/projects/order': ({ body }) => {
    if (!Array.isArray(body.ids)) return { ok: false, error: 'No order was sent.' };
    const byId = new Map(refreshProjects().map(p => [p.id, p.dir]));
    const dirs = body.ids.map(id => byId.get(id)).filter(Boolean);
    // projects not in the list sent (e.g. added a moment ago) keep their place after the ones sent
    const sent = new Set(dirs.map(keyOf));
    state.settings.order = [...dirs, ...state.settings.order.filter(d => !sent.has(keyOf(d)))];
    saveSettings();
    return { ok: true };
  },
  // An added project whose folder is gone (it is not on the list, so it has no id): taken off by its path.
  '/api/projects/forget': ({ body }) => {
    if (!has(state.settings.extraProjects, String(body.path || ''))) return { ok: false, error: 'That project is not on the list any more. Reload the page.' };
    state.settings.extraProjects = drop(state.settings.extraProjects, body.path);
    saveSettings();
    return { ok: true };
  },
  '/api/projects/show': ({ body }) => {
    if (!has(state.settings.hidden, String(body.path || ''))) return { ok: false, error: 'That project is not in the removed list any more. Reload the page.' };
    state.settings.hidden = drop(state.settings.hidden, body.path);
    saveSettings();
    scanFolders();
    return { ok: true };
  },
};

module.exports = { get, post };
