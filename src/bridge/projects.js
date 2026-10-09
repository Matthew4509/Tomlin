// Project list: one row per folder inside each working folder, plus projects added one by one (SCOPE §21, §24).
// Name/description come from project.json if present, else the folder name and the first prose line of README/HANDOFF.
// Start commands come ONLY from files on disk: the folder's .claude/launch.json, its project.json "start", or a
// configuration in the working folder's .claude/launch.json whose arguments point inside the folder. Never from the page.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseLiveUrl } = require('./live');

const SKIP = new Set(['node_modules', '.git', '__pycache__', '_backups', '.claude']);

// A project.json / launch.json comes from a folder the person may have downloaded, so treat its values as untrusted:
// text stays text, a port must be a real port number, and a live address must be a public http(s) URL (parseLiveUrl
// rejects localhost, the private network and non-web schemes). A bad value is dropped, never trusted.
const asText = v => typeof v === 'string' ? v : '';
const asPort = v => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null; };
const cleanLive = v => (typeof v === 'string' && v ? parseLiveUrl(v).url || '' : '');
// A stored address (set through Hosted live, which checks it) is used as it is, but only ever as a web address: a
// settings file edited by hand cannot turn the Open live site button into a javascript: link.
const webOnly = v => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : '');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

function idOf(folder) { return folder.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
// A project's id: its folder name plus a short hash of its full path, so it never changes when another folder is
// added beside it (ids that followed folder order moved a project's audits, logs and running copy to its neighbour),
// and a name with no plain letters (a Greek or Chinese folder name) still gets an id of its own.
function projectId(dir) {
  return (idOf(path.basename(dir)).slice(0, 40) || 'project') + '-' + crypto.createHash('sha1').update(keyOf(dir)).digest('hex').slice(0, 6);
}

// First real sentence of README.md, else of the newest HANDOFF*.md; skips headings, tables, dates and thread notes.
const META = /^(written|date|thread|session|updated|status|version|owner|start here|read first|this (file|handoff|note)|handoff|last )/i;
function firstProseLine(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return ''; }
  const readme = names.find(n => /^readme\.md$/i.test(n));
  const handoffs = names.filter(n => /^HANDOFF.*\.md$/i.test(n)).sort().reverse();
  for (const n of [readme, ...handoffs].filter(Boolean)) {
    try {
      const lines = fs.readFileSync(path.join(dir, n), 'utf8').split(/\r?\n/);
      for (const l of lines) {
        let t = l.trim().replace(/\*\*|`|\[([^\]]*)\]\([^)]*\)/g, '$1');
        if (!t || /^[#>|\-*=<!0-9]/.test(t) || t.length < 30 || META.test(t) || /[A-Z]:\\|HANDOFF/i.test(t)) continue;
        const m = t.match(/^.{20,200}?[.!?](\s|$)/);
        t = m ? m[0].trim() : t.slice(0, 160).replace(/\s+\S*$/, '') + '…';
        return t;
      }
    } catch {}
  }
  return '';
}

// Newest change: top two levels only, so a big node_modules never gets walked.
function lastUpdated(dir) {
  let newest = 0;
  const look = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      // Only files are stat-ed: a folder's own date is not a change to the project.
      if (e.isDirectory()) { if (depth < 2) look(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { const t = fs.statSync(p).mtimeMs; if (t > newest) newest = t; } catch {}
    }
  };
  look(dir, 0);
  return newest || null;
}
// The same walk without holding up the Bridge: every folder's files are looked at in parallel (the list of 38
// projects took about 1 s one file at a time, all of it with the server unable to answer).
async function lastUpdatedAsync(dir) {
  let newest = 0;
  const look = async (d, depth) => {
    let ents = [];
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    await Promise.all(ents.map(async e => {
      if (SKIP.has(e.name) || e.name.startsWith('.')) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 2) await look(p, depth + 1); return; }
      if (!e.isFile()) return;
      try { const t = (await fs.promises.stat(p)).mtimeMs; if (t > newest) newest = t; } catch {}
    }));
  };
  await look(dir, 0);
  return newest || null;
}

function norm(p) { return String(p).replace(/\\/g, '/').toLowerCase(); }

// One start entry from a file, checked: an object, a program name as text, arguments as a list of text. Anything
// else ({"configurations":{}}, [null], "args":"server.js") is skipped and counted, never trusted or crashed on.
const asList = v => Array.isArray(v) ? v : [];
function startEntry(c, exeKey, argsKey, cwd, from, skipped) {
  if (!c || typeof c !== 'object') { skipped.push(from); return null; }
  const exe = c[exeKey], args = c[argsKey] === undefined ? [] : c[argsKey];
  if (typeof exe !== 'string' || !exe.trim() || !Array.isArray(args) || !args.every(a => typeof a === 'string')) { skipped.push(from); return null; }
  return { name: asText(c.name) || 'start', exe, args, port: asPort(c.port), cwd, from };
}
// Words that name a script or a sub-command, not a folder ("npm run dev", "vite preview"): a project folder that
// happens to be called dev or public is not the one a root entry runs.
const SUBCOMMAND = new Set(['dev', 'start', 'serve', 'build', 'preview', 'test', 'watch', 'run', 'exec']);
// A root entry's argument belongs to the folder only when it names a path that is there, inside the folder.
function pointsInside(a, i, args, root, dir) {
  if (/^-/.test(a)) return false;
  const bare = !/[\\/.]/.test(a);
  if (bare && (SUBCOMMAND.has(a.toLowerCase()) || /^(run|run-script|exec)$/i.test(args[i - 1] || ''))) return false;
  const abs = path.resolve(root, a), k = keyOf(abs), d = keyOf(dir);
  return (k === d || k.startsWith(d + path.sep)) && fs.existsSync(abs);
}

function startCommands(root, dir, rootLaunch, override, skipped = []) {
  const out = [];
  const add = e => { if (e) out.push(e); };
  const own = readJson(path.join(dir, '.claude', 'launch.json'));
  for (const c of asList(own && own.configurations)) add(startEntry(c, 'runtimeExecutable', 'runtimeArgs', dir, '.claude/launch.json', skipped));
  const pj = readJson(path.join(dir, 'project.json'));
  if (pj && pj.start) add(startEntry(pj.start, 'exe', 'args', dir, 'project.json', skipped));
  if (override && override.start) add(startEntry(override.start, 'exe', 'args', dir, "the Bridge's projects.json", skipped));
  // Root entries run from the projects root (as preview_start runs them), so a relative "shop" or "shop/x"
  // argument belongs to the shop folder as much as an absolute path does.
  for (const c of asList(rootLaunch && rootLaunch.configurations)) {
    const e = startEntry(c, 'runtimeExecutable', 'runtimeArgs', root, 'root .claude/launch.json', []); // other folders' entries are not this one's to count
    if (e && e.args.some((a, i) => pointsInside(a, i, e.args, root, dir))) add(e);
  }
  const seen = new Set();
  return mergeSameApp(out.filter(c => { const k = c.name + '|' + c.port; if (seen.has(k)) return false; seen.add(k); return true; }))
    .map((c, i) => ({ ...c, key: String(i) }));
}

// Claude Code's preview needs a named entry with a fixed port, so when a port is busy (two sessions at once) a new
// entry is added for the same app on the next port; a busy folder collects several. Entries that run exactly the same
// thing once the port is taken out, with paths resolved from where each runs, become ONE entry that starts on the
// first free port (alts, in file order). Anything that differs by one argument (--dev, another build folder) stays
// separate: merging two different programs would be worse than showing a duplicate.
function sameAppKey(c) {
  if (!c.port) return null;
  const port = String(c.port);
  const blank = s => String(s).replace(new RegExp('(^|\\D)' + port + '(?!\\d)', 'g'), '$1{port}');
  const resolve = a => {
    const s = blank(a);
    if (s.startsWith('-') || s.includes('{port}')) return s;
    const abs = path.resolve(c.cwd, s);
    return fs.existsSync(abs) ? 'path:' + keyOf(abs) : s;
  };
  return [norm(c.exe), ...c.args.map(resolve)].join('\n');
}
function mergeSameApp(list) {
  const groups = new Map(), out = [];
  for (const c of list) {
    const k = sameAppKey(c);
    const g = k != null && groups.get(k);
    if (g) {
      if (!g.alts) g.alts = [{ name: g.name, port: g.port, args: g.args, cwd: g.cwd, from: g.from }];
      g.alts.push({ name: c.name, port: c.port, args: c.args, cwd: c.cwd, from: c.from });
      continue;
    }
    const first = { ...c };
    if (k != null) groups.set(k, first);
    out.push(first);
  }
  return out;
}

const keyOf = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

// "Last updated" walks two folder levels and the description reads README/HANDOFF files: about 2 s for 32 projects,
// on every list request. Kept for 60 s per folder; Refresh and Scan folders pass fresh=true.
const META_TTL = 60000;
const metaCache = new Map();
function meta(dir, fresh) {
  const k = keyOf(dir);
  const hit = metaCache.get(k);
  if (!fresh && hit && Date.now() - hit.at < META_TTL) return hit;
  const m = { at: Date.now(), updated: lastUpdated(dir), description: firstProseLine(dir) };
  metaCache.set(k, m);
  return m;
}
// Fills the cache for every folder that needs it, all at once, so listProjects then only reads the cache.
// A walk already under way for a folder is shared, not started again (start-up and the page's first request
// would otherwise walk every folder twice at once).
const walking = new Map();
async function warmMeta(dirs, fresh) {
  await Promise.all(dirs.map(async dir => {
    const k = keyOf(dir);
    const hit = metaCache.get(k);
    if (!fresh && hit && Date.now() - hit.at < META_TTL) return;
    if (walking.has(k)) return walking.get(k);
    const job = lastUpdatedAsync(dir)
      .then(updated => { metaCache.set(k, { at: Date.now(), updated, description: firstProseLine(dir) }); })
      .finally(() => walking.delete(k));
    walking.set(k, job);
    return job;
  }));
}

// The project folders, before anything is read from them: { dir, working, added }.
function projectFolders(settings, opts = {}) {
  const hidden = new Set((settings.hidden || []).map(keyOf));
  const self = opts.bridgeDir ? keyOf(opts.bridgeDir) : null;
  const found = []; // { dir, working, added }
  const seen = new Set();
  const take = (dir, working, added) => {
    const k = keyOf(dir);
    if (seen.has(k) || hidden.has(k) || k === self) return;
    seen.add(k);
    found.push({ dir: path.resolve(dir), working, added });
  };
  for (const root of settings.workingFolders || []) {
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.') || e.name.startsWith('--')) continue;
      take(path.join(root, e.name), root, false);
    }
  }
  for (const dir of settings.extraProjects || []) if (fs.existsSync(dir)) take(dir, null, true);

  return found;
}

// Every sub-folder of every working folder is a project, plus projects added one by one; minus the ones removed
// from the list (settings.hidden) and the Bridge's own folder. The Bridge's projects.json (in its data folder) sets
// names, descriptions, live addresses and extra start commands WITHOUT writing into any project's folder; it is
// keyed by folder name or by full path, and wins over the project's own project.json.
function listProjects(settings, opts = {}) {
  const overrides = ((opts.overridesFile ? readJson(opts.overridesFile) : null) || {}).projects || {};
  const found = projectFolders(settings, opts);
  const launchCache = new Map();
  const launchOf = root => { if (!launchCache.has(root)) launchCache.set(root, readJson(path.join(root, '.claude', 'launch.json'))); return launchCache.get(root); };
  const rows = [];
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  for (const f of found) {
    const folder = path.basename(f.dir);
    const id = projectId(f.dir);
    // One folder's odd files must never take the list (or the Bridge) down with them: a row that cannot be read is
    // still listed, by its folder name, with no start command and a note saying why.
    try {
    const ov = obj(overrides[f.dir] || overrides[folder]);
    if (ov.hide) continue;
    const pj = { ...obj(readJson(path.join(f.dir, 'project.json'))), ...ov };
    const root = f.working || path.dirname(f.dir);
    const m = meta(f.dir, opts.fresh);
    const skipped = [];
    rows.push({
      id,
      folder,
      dir: f.dir,
      workingFolder: f.working,
      added: f.added,
      name: asText(pj.name) || folder,
      description: asText(pj.description) || m.description,
      // set on the page (settings, already validated by parseLiveUrl at set time), else the Bridge's projects.json /
      // the project's own project.json — those are re-checked here, so an untrusted folder cannot point the Bridge
      // (or an "Open live site" link) at a private address or a non-web scheme.
      liveUrl: settings.liveUrls && Object.prototype.hasOwnProperty.call(settings.liveUrls, keyOf(f.dir)) ? webOnly(settings.liveUrls[keyOf(f.dir)]) : cleanLive(pj.liveUrl),
      updated: m.updated,
      commands: startCommands(root, f.dir, f.working ? launchOf(f.working) : null, ov, skipped),
      startSkipped: skipped,
      auditSkip: Array.isArray(pj.auditSkip) ? pj.auditSkip : [],
      // Folders the scan would take for old copies of the app (lib/roots.js) but should scan after all.
      auditInclude: Array.isArray(pj.auditInclude) ? pj.auditInclude.filter(x => typeof x === 'string') : [],
      // Which folders the project's OWN project.json asked to leave out (the audit says so; a download can ask too).
      auditSkipOwn: !Array.isArray(ov.auditSkip) && Array.isArray(pj.auditSkip) ? pj.auditSkip : [],
      // Set-asides come from the Bridge's projects.json only: a project cannot vouch for its own findings.
      auditAccept: Array.isArray(ov.auditAccept) ? ov.auditAccept : [],
      auditAcceptOwn: Array.isArray(pj.auditAccept) && !Array.isArray(ov.auditAccept) ? pj.auditAccept.length : 0,
    });
    } catch (e) {
      rows.push({ id, folder, dir: f.dir, workingFolder: f.working, added: f.added, name: folder, description: '', liveUrl: '', updated: null,
        commands: [], startSkipped: ['its project files (' + String(e.message || e).slice(0, 80) + ')'], auditSkip: [], auditInclude: [], auditSkipOwn: [], auditAccept: [], auditAcceptOwn: 0 });
    }
  }
  return rows;
}

// The list, with the folder walks done in parallel first (the server keeps answering meanwhile).
async function listProjectsAsync(settings, opts = {}) {
  await warmMeta(projectFolders(settings, opts).map(f => f.dir), opts.fresh);
  return listProjects(settings, { ...opts, fresh: false });
}

module.exports = { listProjects, listProjectsAsync, projectFolders, idOf, projectId, keyOf, startCommands };
