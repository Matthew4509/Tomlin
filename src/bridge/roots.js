// Which folders inside a project are old copies of it, so a fault is counted where the app lives, not once per copy.
// A project folder often holds more than the app: the original files it was built from, a "-fixes" copy, an unpacked
// release beside its zip, or two or three versions side by side (my-app/, my-app-php/). The code rules leave those
// out; the disclosure pass still reads a left-out folder when git would publish it. Every folder left out is named
// in the report with the reason, never hidden, and auditInclude in the project's project.json brings one back.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NOT_WALKED = new Set(['node_modules', '.git', 'vendor', 'bower_components', '__pycache__', '.venv', 'venv', '.claude', 'coverage']);
const CODE_FILE = /\.(php|m?js|cjs|tsx?|jsx|py|html?|vue|svelte|rb|go|java|cs)$/i;
// Folder names that say "copy". Matched against the folder's own name, case ignored.
const ORIGINAL = /^original(?=$|[\s_.-])/i;                                      // original project files, original-2026-01-31
const FIXES = /[\s_.-]fix(es)?$/i;                                                // my-app-fixes
const OLD = /^(_?old|old[\s_.-].*|.*[\s_.-]old|_?backups?|bak|_?archive|_attic|previous)$/i; // old/, my-app-old, backups/
// A version at the end of the name: v1.2, 1.2.3, my-app-v1.9.4-full. On its own a version is not enough (a library
// folder is named that way too): it also needs a zip of the same name beside it, a releases-type parent, or a copy
// of the same name next to it.
const VERSIONED = /(^|[\s_.-])v?\d+\.\d+(\.\d+)*([\s_.-](full|lite|min|build|release|dist|src|source))?$/i;
const RELEASE_PARENT = /^_?(releases?|builds?|dist|deploy|archives?|versions)$/i;
// Folders that are parts of one app, never copies of each other (frontend/ and backend/ both hold code).
const PART = /^(frontend|backend|api|server|client|web|www|admin|app|apps|docs|src|public|lib|libs|tests?|scripts|tools|assets|static|site)$/i;

const versionOf = name => { const m = /v?(\d+(?:\.\d+)+)(?:[\s_.-][a-z]+)?$/i.exec(name); return m ? m[1].split('.').map(Number) : null; };
const newerVersion = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d > 0; } return false; };
const stem = name => (String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || '');
const relOf = (dir, p) => path.relative(dir, p).replace(/\\/g, '/');
function dirs(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !NOT_WALKED.has(e.name)).map(e => e.name); } catch { return []; }
}

// Code anywhere within two levels, and the newest change time of any file within three (a bounded look, not a walk).
function look(d) {
  let code = false, newest = 0, seen = 0;
  const walk = (p, depth) => {
    let ents = []; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > 4000) return;
      const q = path.join(p, e.name);
      if (e.isDirectory()) { if (!NOT_WALKED.has(e.name) && depth < 3) walk(q, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (depth <= 2 && CODE_FILE.test(e.name)) code = true;
      try { const t = fs.statSync(q).mtimeMs; if (t > newest) newest = t; } catch {}
    }
  };
  walk(d, 0);
  return { code, newest };
}

// The folder a launch.json start entry runs in, when that is a folder of this project (cwd, or an argument naming one).
function launchFolders(dir) {
  let j = null; try { j = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'launch.json'), 'utf8')); } catch { return []; }
  const out = new Set();
  for (const c of (j && Array.isArray(j.configurations) ? j.configurations : [])) {
    if (!c || typeof c !== 'object') continue;
    for (const v of [c.cwd, ...(Array.isArray(c.runtimeArgs) ? c.runtimeArgs : [])]) {
      if (typeof v !== 'string' || !v || /^-/.test(v)) continue;
      const abs = path.resolve(dir, v);
      const rel = relOf(dir, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      out.add(rel.split('/')[0].toLowerCase());
    }
  }
  return [...out];
}

// Would git publish this folder? Tracked in HEAD, or not ignored (so the next commit takes it). No repo: no.
function gitPublishes(dir, rel) {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  const run = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
  try { if (run(['ls-tree', '-d', '--name-only', 'HEAD', '--', rel]).trim()) return true; } catch {}
  try { run(['check-ignore', '-q', '--', rel + '/']); return false; } catch (e) { return e.status === 1; } // 1 = not ignored
}

// opts.include: folders (relative to dir) never left out. Returns { left: [{ rel, why, publishes }], app, notes }.
function findRoots(dir, opts = {}) {
  const include = new Set((opts.include || []).map(s => String(s).replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '').toLowerCase()));
  const left = [];
  const leave = (rel, why) => { if (!include.has(rel.toLowerCase()) && !left.some(l => l.rel === rel)) left.push({ rel, why }); };
  const top = dirs(dir);
  const looks = new Map(top.map(n => [n, look(path.join(dir, n))]));

  // 1. By name, at the top and one level down (a releases/ folder's unpacked copies).
  const byName = (parent, name) => {
    if (ORIGINAL.test(name)) return 'the original files it was built from';
    if (FIXES.test(name)) return 'a "fixes" copy';
    if (OLD.test(name)) return 'an old copy or backup';
    if (VERSIONED.test(name)) {
      const pd = path.join(dir, parent);
      const zipBeside = fs.existsSync(path.join(pd, name + '.zip'));
      if (zipBeside) return 'an unpacked release (' + name + '.zip is beside it)';
      if (RELEASE_PARENT.test(path.basename(pd))) return 'an unpacked release';
      const s = stem(name);
      // versions side by side with no zip: the highest stays (it is the one being worked on), the others are copies
      const newer = s && dirs(pd).filter(o => o !== name && stem(o) === s && (versionOf(o) ? newerVersion(versionOf(o), versionOf(name)) : !OLD.test(o)))
        .sort((a, b) => (versionOf(a) && versionOf(b) ? (newerVersion(versionOf(a), versionOf(b)) ? -1 : 1) : versionOf(a) ? 1 : -1))[0];
      if (newer) return 'an older version beside ' + newer + '/';
    }
    return null;
  };
  for (const n of top) {
    const why = byName('', n);
    if (why) { leave(n, why); continue; }
    for (const m of dirs(path.join(dir, n))) {
      const w = byName(n, m);
      if (w && (RELEASE_PARENT.test(n) || /release/.test(w) || ORIGINAL.test(m) || FIXES.test(m))) leave(n + '/' + m, w);
    }
  }

  // 2. Copies side by side with no app at the top: my-app/, my-app-php/, my-app-fixes/ in a folder holding nothing
  // else of its own. The app is the one launch.json runs, else the one changed most recently.
  let app = null;
  const topHasCode = (() => { try { return fs.readdirSync(dir).some(n => CODE_FILE.test(n) || /^(package|composer)\.json$/i.test(n)); } catch { return false; } })();
  if (!topHasCode) {
    const groups = new Map();
    for (const n of top) {
      if (PART.test(n) || !looks.get(n).code || left.some(l => l.rel === n)) continue; // a copy by name is no candidate
      const s = stem(n);
      if (s.length >= 3) groups.set(s, [...(groups.get(s) || []), n]);
    }
    const launched = launchFolders(dir);
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const pick = g.find(n => launched.includes(n.toLowerCase())) || [...g].sort((a, b) => looks.get(b).newest - looks.get(a).newest)[0];
      app = { rel: pick, why: launched.includes(pick.toLowerCase()) ? 'the folder launch.json starts' : 'the newest of ' + g.length + ' copies side by side' };
      for (const n of g) if (n !== pick) leave(n, 'an older copy beside ' + pick + '/');
    }
  }

  // 3. Never leave nothing: when every folder that holds code was left out and the top holds none of its own, the
  // newest of them is the app after all (a folder that only keeps an original copy is still scanned).
  const kept = top.filter(n => looks.get(n).code && !left.some(l => l.rel === n));
  if (!topHasCode && !kept.length && left.length) {
    const back = left.filter(l => !l.rel.includes('/') && looks.get(l.rel) && looks.get(l.rel).code).sort((a, b) => looks.get(b.rel).newest - looks.get(a.rel).newest)[0];
    if (back) { left.splice(left.indexOf(back), 1); app = { rel: back.rel, why: 'the only copy there is (' + back.why + ')' }; }
  }

  for (const l of left) l.publishes = gitPublishes(dir, l.rel);
  const notes = [];
  if (app) notes.push('Scanned as the app: ' + app.rel + '/ (' + app.why + ').');
  if (left.length) {
    notes.push('Left out as copies of the app, so their faults are not counted twice (to scan one, add it to "auditInclude" in the project\'s project.json): '
      + left.map(l => l.rel + '/ (' + l.why + ')').join(', ') + '.');
    const pub = left.filter(l => l.publishes);
    if (pub.length) notes.push('Still read for private details, because git would publish ' + (pub.length === 1 ? 'it' : 'them') + ': ' + pub.map(l => l.rel + '/').join(', ') + '.');
  }
  return { left, app, notes };
}

module.exports = { findRoots };
