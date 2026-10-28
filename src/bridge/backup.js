// Backups: a zip of a project on a drive the person chose (a USB drive, say), read back and checked before it counts.
// Backups are only ever added: nothing is deleted to make room. When a drive is full, the person plugs in another
// and adds it ("swap the drives"); the full one keeps its backups and stays listed. Keep-last-N is there, off by
// default. Drives are remembered by their volume serial number, not their letter (a stick is E: one day, F: the next).
// What it writes: <backup folder>\<project folder>\<project folder>-YYYY-MM-DD-HHmm.zip, a .txt beside it saying
// what is in it, and backups-index.json in the backup folder, so the drive tells another PC what it holds.
// TOMLIN's own record is data/bridge/backups.json. Nothing here changes a project's files. The zips are written and
// checked by TOMLIN's own src/zip.ts. Tested in test/bridge/backup.test.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Settings = require('./settings');
const { writeZip, checkZip } = require('../zip.ts');

const FOLDER_NAME = 'TOMLIN Backups';
// The demo's made-up backup drive: in temp, outside TOMLIN's folders, so its zips are never shipped or scanned.
const DEMO_DRIVE = path.join(os.tmpdir(), 'tomlin-demo-backup-drive');
const INDEX_NAME = 'backups-index.json';
// The first guess at speed (bytes of project per second, writing and reading back together) until a drive has done a
// backup. Measured on a 511 MB project, SSD to SSD: about 65 MB/s, deflate being most of it; a USB stick writes slower.
const FIRST_GUESS = { removable: 20e6, fixed: 60e6, network: 10e6 }; // network: a share over ordinary home Wi-Fi or 100 Mbit
const PER_FILE_MS = 1.2; // each file opened, read, written and read back (measured: about 1.1 ms)
const SPACE_MARGIN = 256e6; // a backup is not started with less than this left over afterwards
const STALE_DAYS = 7; // changed and not backed up for this long: Needs attention
// FAT32 (how most USB sticks come): a single file cannot reach 4 GiB, so a zip that would is refused in the plan.
const FAT32_MAX = 4 * 2 ** 30;
const isFat = fsName => /^fat/i.test(fsName || ''); // FAT, FAT16, FAT32; not exFAT
// A history or faults key is a project key (keyOf: a whole lower-case path). Anything else in a drive's index, such as
// __proto__ or constructor, is skipped, and both maps have no prototype to reach.
const keyOk = k => typeof k === 'string' && k.length <= 1024 && /^([a-z]:[\\/]|\\\\[^\\/])/i.test(k);
function safeMap(o, keep) {
  const m = Object.create(null);
  if (o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) if (keyOk(k) && keep(o[k])) m[k] = o[k];
  return m;
}
const records = v => Array.isArray(v) && v.every(x => x && typeof x === 'object' && typeof x.file === 'string');

// ---- what goes in a backup ----
// Left out: folders a project rebuilds by itself. vendor only beside a composer.json (a vendor folder of shipped
// libraries is real work), bin/obj only beside a .NET project file, target only beside a Cargo.toml or pom.xml.
// dist and build stay in: baked zips live there.
const ALWAYS_OUT = new Set(['node_modules', '__pycache__', '.venv', 'venv', '.next']);
function leftOut(name, siblings, relDir) {
  if (ALWAYS_OUT.has(name)) return name;
  if (name === 'vendor' && siblings.includes('composer.json')) return 'vendor (beside composer.json)';
  if ((name === 'bin' || name === 'obj') && siblings.some(s => /\.(cs|fs|vb)proj$/i.test(s))) return name + ' (beside a .NET project)';
  if (name === 'target' && (siblings.includes('Cargo.toml') || siblings.includes('pom.xml'))) return 'target (a build folder)';
  if (name === 'worktrees' && /(^|\/)\.claude$/.test(relDir)) return '.claude/worktrees';
  return null;
}
const LEAVE_OUT_TEXT = 'node_modules, __pycache__, .venv, venv, .next, .claude/worktrees; vendor beside composer.json; bin and obj beside a .NET project; target beside Cargo.toml or pom.xml';

/** Every folder and file a backup of `dir` takes, without reading any file: { items, files, bytes, leftOut, links, unreadable }.
 * Names in the zip start with the project's folder name, so it unzips into a folder of its own. .git is kept.
 * full: the rebuildable folders go in too (Full backup on the Backups page). */
async function walk(dir, { full = false } = {}) {
  const top = path.basename(dir);
  const items = [{ name: top + '/', dir: true, mtimeMs: 0 }];
  const out = { items, files: 0, bytes: 0, leftOut: {}, links: [], unreadable: [] };
  try { items[0].mtimeMs = (await fs.promises.stat(dir)).mtimeMs; } catch (e) { throw Object.assign(new Error('The folder ' + dir + ' could not be read (' + (e.code || e.message) + ').'), { status: 400 }); }
  const look = async (abs, rel) => {
    let ents;
    try { ents = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (e) { out.unreadable.push({ name: top + '/' + rel, why: e.code || e.message }); return; }
    const names = ents.map(e => e.name);
    const subs = [];
    await Promise.all(ents.map(async e => {
      const r = rel ? rel + '/' + e.name : e.name;
      const p = path.join(abs, e.name);
      let isDir = e.isDirectory(), isFile = e.isFile();
      if (e.isSymbolicLink()) {
        // Windows calls every reparse point a link: symlinks and junctions, which are never followed (listed in the
        // .txt and counted on the page), but also cloud placeholders (OneDrive "files on demand"), which are ordinary
        // files and folders all the same. readlink tells them apart: it answers for a real link and refuses the rest.
        let real = true;
        try { await fs.promises.readlink(p); } catch (err) { real = !(err.code === 'EINVAL' || err.code === 'UNKNOWN'); }
        if (real) { out.links.push(top + '/' + r); return; }
        try { const s = await fs.promises.stat(p); isDir = s.isDirectory(); isFile = s.isFile(); }
        catch (err) { out.unreadable.push({ name: top + '/' + r, why: err.code || err.message }); return; }
      }
      if (isDir) {
        const why = full ? null : leftOut(e.name, names, rel);
        if (why) { out.leftOut[why] = (out.leftOut[why] || 0) + 1; return; }
        subs.push([p, r]);
        return;
      }
      if (!isFile) return;
      try {
        const st = await fs.promises.stat(p);
        items.push({ name: top + '/' + r, abs: p, size: st.size, mtimeMs: st.mtimeMs });
        out.files++; out.bytes += st.size;
      } catch (err) { out.unreadable.push({ name: top + '/' + r, why: err.code || err.message }); }
    }));
    for (const [p, r] of subs) {
      let m = 0; try { m = (await fs.promises.stat(p)).mtimeMs; } catch {}
      items.push({ name: top + '/' + r + '/', dir: true, mtimeMs: m });
      await look(p, r);
    }
  };
  await look(dir, '');
  return out;
}

// ---- drives ----
const isUnder = (child, parent) => { const c = Settings.norm(child), p = Settings.norm(parent); return c === p || c.startsWith(p + '\\') || c.startsWith(p + '/'); };
const CLOUD = /\\(onedrive[^\\]*|dropbox|google drive|googledrive|icloud ?drive|box)(\\|$)/i;
const stamp = ms => { const d = new Date(ms), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`; };
const gb = n => (n >= 1e12 ? (n / 1e12).toFixed(1) + ' TB' : n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.round(n / 1e6) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
const mins = s => (s < 90 ? 'about a minute' : s < 3600 ? `about ${Math.round(s / 60)} min` : `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
const fault = (f, reason, wayOut) => ({ ok: false, fault: f, reason: reason || '', wayOut: wayOut || '' });

/**
 * The backups of one TOMLIN. listDrives() answers this PC's drives as drive-info.ps1 prints them:
 * [{ letter, serial, label, type, bus, fs, size, free }]. keyOf(dir) is the project key the rest of the Bridge uses.
 * appDir: TOMLIN's own folders (the app and its home), never a backup folder (one, or a list). write, check and
 * fatMax are seams for the tests.
 */
function create({ dataDir, listDrives, keyOf, host = os.hostname(), version = '', now = () => Date.now(), statfs = p => fs.promises.statfs(p), check = checkZip, write = writeZip, appDir = null, fatMax = FAT32_MAX }) {
  const FILE = path.join(dataDir, 'backups.json');
  const st = load();
  let job = null;
  let rev = 0;
  const walks = new Map(); // dir key -> { at, w }: a plan's read of the folders, used again by the Start that follows

  function load() {
    const s = Settings.loadJson(FILE, {});
    const o = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
    return {
      drives: Array.isArray(o.drives) ? o.drives.filter(d => d && typeof d.id === 'string' && typeof d.rel === 'string') : [],
      list: Array.isArray(o.list) ? o.list.filter(k => typeof k === 'string') : [],
      keepLast: Number.isInteger(o.keepLast) && o.keepLast >= 0 && o.keepLast <= 100 ? o.keepLast : 0,
      full: o.full === true, // off by default: the rebuildable folders are left out
      history: safeMap(o.history, records),
      faults: safeMap(o.faults, v => !!v && typeof v === 'object' && !Array.isArray(v)),
    };
  }
  const save = () => { Settings.saveJson(FILE, st); rev++; };

  // Which remembered drive is plugged in now, and where its backup folder is. Found by serial when it has one (the
  // letter may have moved), else by its path (a network folder, or a drive Windows gave no serial).
  let volCache = { at: 0, list: [] };
  async function volumes(fresh) {
    if (fresh || now() - volCache.at > 5000) {
      let list = [];
      try { list = await listDrives(); } catch {}
      volCache = { at: now(), list: Array.isArray(list) ? list : [] };
    }
    return volCache.list;
  }
  async function where(d, fresh) {
    const vols = await volumes(fresh);
    const v = d.serial ? vols.find(x => x.serial && x.serial === d.serial) : null;
    const dir = v ? path.join(v.letter + ':\\', d.rel) : d.serial ? null : d.path;
    const here = !!dir && fs.existsSync(dir);
    let free = null, total = null;
    if (here) { try { const s = await statfs(dir); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch {} }
    // A network folder: a mapped drive (Windows' type 4), or a \\server\share path, which has no serial.
    const byLetter = !v && d.letter ? vols.find(x => String(x.letter).toUpperCase() === d.letter) : null;
    const network = v ? v.type === 4 : /^\\\\/.test(d.path || '') || (!!byLetter && byLetter.type === 4);
    return { here, dir: here ? dir : null, free, total, letter: v ? v.letter : null, removable: v ? v.type === 2 || /usb/i.test(v.bus || '') : false, network, label: v ? v.label : d.label,
      fs: v ? String(v.fs || '') : '' }; // NTFS, exFAT, FAT32…; '' when Windows did not say (a share path)
  }
  async function driveView(d, fresh) {
    const w = await where(d, fresh);
    const mine = Object.values(st.history).flat().filter(h => h.drive === d.id);
    const last = mine.reduce((m, h) => (h.at > m ? h.at : m), 0);
    // Found under another letter than last time: said for a day ("now F:, was E:"), so the person knows it is the same drive.
    if (w.here && d.letter && w.letter && d.letter !== w.letter) { d.movedFrom = d.letter; d.movedAt = now(); }
    if (w.here && (d.letter !== w.letter || d.path !== w.dir || !(d.lastSeen > now() - 60000))) { d.letter = w.letter; d.path = w.dir; d.lastSeen = now(); save(); }
    const moved = d.movedFrom && now() - (d.movedAt || 0) < 864e5 ? d.movedFrom : null;
    return { id: d.id, name: d.name, label: w.label || d.label || '', here: w.here, path: w.dir || d.path, letter: w.letter, movedFrom: moved, free: w.free, total: w.total,
      removable: w.removable, network: w.network, fs: w.fs, backups: mine.length, lastAt: last || null, speed: speedOf(d, w), measured: !!(d.speeds && d.speeds.length) };
  }
  const speedOf = (d, w) => {
    const s = (d.speeds || []).slice(-5).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : w.network ? FIRST_GUESS.network : w.removable ? FIRST_GUESS.removable : FIRST_GUESS.fixed;
  };

  /** Add a drive: the folder the person chose (by the folder window or typed). The backups go in "TOMLIN
   * Backups" inside it, unless it is that folder already. projects: the list, so a folder inside one is refused. */
  async function addDrive(chosen, { projects = [], workingFolders = [] } = {}) {
    if (typeof chosen !== 'string' || !chosen.trim()) return fault('No folder was given.', '', 'Choose a folder with Choose…, or type its path.');
    const raw = chosen.trim();
    if (!path.isAbsolute(raw) || !/^([a-z]:\\|\\\\)/i.test(path.resolve(raw))) return fault('Give the whole path, starting with the drive, e.g. E:\\ or E:\\Backups.');
    const picked = path.resolve(raw);
    const dir = path.basename(picked).toLowerCase() === FOLDER_NAME.toLowerCase() ? picked : path.join(picked, FOLDER_NAME);
    const root = path.parse(picked).root;
    if (!fs.existsSync(root)) return fault(`Drive ${root} is not there.`, 'It may be unplugged.', 'Plug it in, then choose the folder again.');
    const inside = projects.find(p => isUnder(dir, p.dir));
    if (inside) return fault(`That folder is inside ${inside.name}.`, 'A backup of it would then take in its own backups, again each time.', 'Choose a folder outside your projects: a USB drive is best.');
    const wf = workingFolders.find(f => isUnder(dir, f));
    if (wf) return fault('That folder is inside a working folder.', `Every folder in ${wf} is a project, so the backups would show up as a project of their own.`, 'Choose a folder outside your working folders: a USB drive is best.');
    if ([].concat(appDir || []).some(a => isUnder(dir, a))) return fault('That folder is inside TOMLIN\'s own folders.', 'Zips of your projects would then sit with TOMLIN (its program or your chats and settings) and go wherever they are copied or updated.', 'Choose a folder outside them: a USB drive is best.');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return fault(`The folder ${dir} could not be made (${e.code || e.message}).`, 'The drive may be read-only or full.', 'Choose another folder or drive.'); }
    const vols = await volumes(true);
    const letter = /^[a-z]:/i.test(dir) ? dir[0].toUpperCase() : null;
    const v = letter ? vols.find(x => String(x.letter).toUpperCase() === letter) : null;
    const serial = v && v.serial ? String(v.serial) : null;
    const rel = serial ? path.relative(root, dir) : dir;
    const same = st.drives.find(d => (serial ? d.serial === serial && Settings.norm(d.rel) === Settings.norm(rel) : !d.serial && Settings.norm(d.path) === Settings.norm(dir)));
    if (same) return { ok: true, already: true, drive: await driveView(same, true), warnings: [] };
    const n = st.drives.reduce((m, d) => Math.max(m, Number(String(d.name).replace(/\D/g, '')) || 0), 0) + 1;
    const d = { id: crypto.randomBytes(6).toString('hex'), name: 'Drive ' + n, serial, label: v ? v.label || '' : '', rel, path: dir, letter, added: now(), lastSeen: now(), speeds: [] };
    st.drives.push(d);
    const imported = importIndex(d, dir);
    save();
    const warnings = [];
    if (CLOUD.test(dir)) warnings.push('That folder is in a cloud folder (OneDrive, Dropbox, Google Drive): every backup is uploaded again too. A USB drive is safer and faster.');
    const sameDrive = projects.some(p => path.parse(p.dir).root.toLowerCase() === root.toLowerCase());
    if (sameDrive) warnings.push(`Drive ${root} also holds your projects, so a backup there is lost if that drive fails. Add a USB drive as well.`);
    return { ok: true, drive: await driveView(d, true), imported, warnings };
  }
  // A drive that was used before (on this PC or another) says what it holds: those backups count here too.
  function importIndex(d, dir) {
    const idx = Settings.loadJson(path.join(dir, INDEX_NAME), null);
    if (!idx || !Array.isArray(idx.backups)) return 0;
    let n = 0;
    for (const b of idx.backups) {
      // Only a project key (a whole path) and a file name: a damaged or crafted index (a __proto__ key, say) is skipped.
      if (!b || !keyOk(b.key) || typeof b.file !== 'string' || !Number.isFinite(b.at)) continue;
      const h = Object.hasOwn(st.history, b.key) ? st.history[b.key] : (st.history[b.key] = []);
      if (h.some(x => x.drive === d.id && x.file === b.file)) continue;
      h.push({ at: b.at, drive: d.id, file: b.file, bytes: b.bytes || 0, source: b.source || 0, files: b.files || 0, checked: !!b.checked, host: b.host || '',
        ...(b.full === true ? { full: true } : {}), ...(Number.isInteger(b.links) && b.links > 0 ? { links: b.links } : {}), ...(Number.isInteger(b.skipped) && b.skipped > 0 ? { skipped: b.skipped } : {}) });
      n++;
    }
    return n;
  }
  function forgetDrive(id) {
    const d = st.drives.find(x => x.id === id);
    if (!d) return fault('That drive is not on the list.');
    st.drives = st.drives.filter(x => x !== d);
    for (const k of Object.keys(st.history)) st.history[k] = st.history[k].filter(h => h.drive !== id);
    save();
    return { ok: true, name: d.name };
  }

  // ---- the backup list ----
  function setListed(dirs, on) {
    const keys = new Set(st.list);
    for (const dir of dirs) { const k = keyOf(dir); if (on) keys.add(k); else keys.delete(k); }
    st.list = [...keys];
    save();
    return { ok: true, count: st.list.length };
  }
  /** Full backup on or off: on, the rebuildable folders (node_modules and the rest) go in too. */
  function setFull(on) {
    st.full = on === true;
    walks.clear(); // a plan's read of the folders was made with the other setting
    save();
    return { ok: true, full: st.full };
  }
  function setKeep(n) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 0 || v > 100) return fault('Keep must be a whole number from 0 (keep every backup) to 100.');
    st.keepLast = v; save();
    return { ok: true, keepLast: v };
  }

  /** What a project row carries (lib/views.js): on the list, the last checked backup on each drive, changed since. */
  function rowOf(p) {
    const k = keyOf(p.dir);
    const h = (st.history[k] || []).filter(x => x.checked);
    const per = st.drives.map(d => { const m = h.filter(x => x.drive === d.id).reduce((a, x) => (!a || x.at > a.at ? x : a), null); return m ? { drive: d.name, at: m.at, links: m.links || 0, skipped: m.skipped || 0 } : null; }).filter(Boolean).sort((a, b) => b.at - a.at);
    const last = per[0] || null;
    const item = job && job.items.find(i => i.key === k && ['waiting', 'zipping', 'checking'].includes(i.state));
    const listed = st.list.includes(k), changed = !!last && !!p.updated && p.updated > last.at, f = st.faults[k] || null;
    // Needs attention (on the list, once a drive is set up): the last try failed, never backed up, or changed and not
    // backed up for STALE_DAYS.
    const attention = !listed || !st.drives.length ? null : f ? 'failed' : !last ? 'never' : changed && now() - last.at > STALE_DAYS * 864e5 ? 'stale' : null;
    return { listed, last, drives: per, changed, fault: f, attention, busy: item ? { state: item.state, pct: item.pct } : null };
  }

  async function view() {
    const drives = await Promise.all(st.drives.map(d => driveView(d)));
    return { drives, list: st.list, keepLast: st.keepLast, full: st.full, folderName: FOLDER_NAME, leaveOut: LEAVE_OUT_TEXT, job: jobView() };
  }

  // ---- plan: sizes, time and space, before anything is written ----
  async function walkOf(dir, fresh, full = st.full) {
    const k = keyOf(dir) + (full ? '|full' : ''), c = walks.get(k);
    if (!fresh && c && now() - c.at < 120000) return c.w;
    const w = await walk(dir, { full });
    walks.set(k, { at: now(), w });
    return w;
  }
  /** projects: [{ id, name, dir, folder }]; driveId: which drive (needed when more than one is plugged in). */
  async function plan(projects, driveId, { fresh = true } = {}) {
    const drives = await Promise.all(st.drives.map(d => driveView(d, fresh)));
    const here = drives.filter(d => d.here);
    // The drive asked for when it is plugged in; else the one remembered drive that is (it was swapped for another).
    const drive = (driveId && here.find(d => d.id === driveId)) || (here.length === 1 ? here[0] : null);
    const rows = [];
    // A few folders at a time: each walk is many small reads, and one big project should not hold up the rest.
    const queue = [...projects];
    await Promise.all([0, 1, 2].map(async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const k = keyOf(p.dir);
        const lastOk = (st.history[k] || []).filter(h => h.checked && h.source).sort((a, b) => b.at - a.at)[0];
        try {
          const w = await walkOf(p.dir, fresh);
          // The zip is about the size the last one was, for this much project; with no backup yet, the project's own
          // size is the most it can be (stored files come out the same size, the rest smaller).
          const ratio = lastOk ? Math.min(1.05, lastOk.bytes / lastOk.source) : 1;
          const zip = Math.round(w.bytes * ratio);
          // On a FAT32 drive a single file cannot reach 4 GiB: a zip that would is left out of Start, and says why.
          const tooBig = drive && isFat(drive.fs) && zip >= fatMax;
          rows.push({ id: p.id, name: p.name, files: w.files, bytes: w.bytes, zip, sure: !!lastOk,
            secs: drive ? Math.round(w.bytes / drive.speed + (w.files * PER_FILE_MS) / 1000) : null, leftOut: w.leftOut, last: rowOf(p).last,
            ...(tooBig ? { error: `Too big for ${drive.name}: it is formatted ${drive.fs}, where a single file cannot reach 4 GB, and this zip would be about ${gb(zip)}. Use an exFAT or NTFS drive${st.full ? ', or turn Full backup off (on the Backups page)' : ''}.` } : {}) });
        } catch (e) { rows.push({ id: p.id, name: p.name, error: e.message }); }
      }
    }));
    rows.sort((a, b) => projects.findIndex(p => p.id === a.id) - projects.findIndex(p => p.id === b.id));
    const ok = rows.filter(r => !r.error);
    const total = { files: ok.reduce((s, r) => s + r.files, 0), bytes: ok.reduce((s, r) => s + r.bytes, 0), zip: ok.reduce((s, r) => s + r.zip, 0), secs: drive ? ok.reduce((s, r) => s + r.secs, 0) : null };
    const fits = drive && drive.free != null ? drive.free - total.zip >= SPACE_MARGIN : null;
    return { drives, drive: drive || null, choose: !drive && here.length > 1, full: st.full, rows, total, fits, freeAfter: drive && drive.free != null ? drive.free - total.zip : null, firstGuess: drive ? !drive.measured : null };
  }

  // ---- the run: one project at a time, in the background; TOMLIN keeps answering ----
  function jobView() {
    if (!job) return null;
    return { id: job.id, drive: job.driveName, removable: job.removable, full: !!job.full, started: job.started, finished: job.finished || null, cancelled: !!job.cancel.signal.aborted,
      items: job.items.map(i => ({ id: i.id, name: i.name, state: i.state, pct: i.pct, file: i.file || null, bytes: i.bytes || 0, files: i.files || 0, secs: i.secs || null, est: i.est || null, note: i.note || '', fault: i.fault || null })), rev };
  }
  async function start(projects, driveId) {
    if (job && !job.finished) return fault('A backup is already running.', `${job.items.filter(i => ['waiting', 'zipping', 'checking'].includes(i.state)).length} still to go.`, 'Wait for it to finish, or Cancel it.');
    if (!projects.length) return fault('Nothing to back up.', 'No project was ticked.', 'Tick the projects to back up.');
    const pl = await plan(projects, driveId, { fresh: false });
    if (!st.drives.length) return fault('No backup drive yet.', '', 'Backups › Turn on backups, and choose where they go.');
    if (pl.choose) return fault('Two backup drives are plugged in.', '', 'Choose which one to use.');
    if (driveId && pl.drive && pl.drive.id !== driveId) return fault('The drive you chose is not plugged in now.', `${pl.drive.name} is, instead.`, 'Press Look again, check the drive, then Start.');
    if (!pl.drive || !pl.drive.here) return fault('No backup drive is plugged in.', `${st.drives.map(d => d.name + (d.label ? ` ("${d.label}")` : '')).join(', ')} ${st.drives.length > 1 ? 'are' : 'is'} not found on this PC now.`, 'Plug one in, or add another drive on the Backups page.');
    if (pl.fits === false) return fault(`It will not fit on ${pl.drive.name}.`, `It needs about ${gb(pl.total.zip)}, and ${pl.drive.name} has ${gb(pl.drive.free)} free. Nothing was deleted: backups are never deleted to make room.`, 'Untick some projects, or plug in another drive and add it on the Backups page.');
    const d = st.drives.find(x => x.id === pl.drive.id);
    job = { id: crypto.randomBytes(4).toString('hex'), drive: d, dir: pl.drive.path, driveName: d.name, removable: pl.drive.removable, fs: pl.drive.fs, full: st.full, started: now(), cancel: new AbortController(), partial: null,
      items: projects.map(p => { const r = pl.rows.find(x => x.id === p.id) || {}; return { id: p.id, key: keyOf(p.dir), name: p.name, dir: p.dir, folder: path.basename(p.dir), state: r.error ? 'failed' : 'waiting', pct: 0, est: r.secs || null, need: r.zip || 0, fault: r.error ? { fault: r.error } : null }; }) };
    rev++;
    const mine = job;
    runAll(mine).catch(e => { for (const i of mine.items) if (['waiting', 'zipping', 'checking'].includes(i.state)) failed(i, i.key, 'The backup stopped: ' + (e.message || e), '', 'Run it again.'); })
      .finally(() => { mine.finished = now(); rev++; });
    return { ok: true, job: jobView() };
  }
  function cancel() {
    if (!job || job.finished) return { ok: true, note: 'Nothing is running.' };
    job.cancel.abort();
    rev++;
    return { ok: true };
  }
  /** TOMLIN is stopping and cannot wait (its window was closed, or Windows is shutting down): the run is cancelled
   * at once and the zip being written is removed, so no half-written .partial is left on the drive. */
  function stopNow() {
    if (!job || job.finished) return false;
    job.stopped = true; // runOne says nothing more about a project after this
    job.cancel.abort();
    if (job.partial) { try { fs.rmSync(job.partial, { force: true }); } catch {} job.partial = null; }
    for (const i of job.items) {
      if (['zipping', 'checking'].includes(i.state)) failed(i, i.key, `The backup of ${i.name} was stopped when TOMLIN closed.`, 'The unfinished zip was removed; the earlier backups are as they were.', 'Run it again.');
      else if (i.state === 'waiting') i.state = 'cancelled';
    }
    job.finished = now(); rev++;
    return true;
  }

  async function runAll(j) {
    for (const it of j.items) {
      if (it.state !== 'waiting') continue;
      if (j.cancel.signal.aborted) { it.state = 'cancelled'; continue; }
      try { await runOne(j, it); } catch (e) {
        // Something unforeseen part way (the drive pulled out between two steps, say): this project fails with a plain
        // reason and the fault is recorded; the rest are still tried, and fail fast themselves if the drive is gone.
        if (j.stopped) return;
        if (j.partial) { try { fs.rmSync(j.partial, { force: true }); } catch {} j.partial = null; }
        failed(it, it.key, `${it.name} could not be backed up (${e.code || e.message || e}).`, 'Something went wrong part way: the drive may have been unplugged.', 'Plug it in and run the backup again.');
      }
      if (j.stopped) return;
      rev++;
      // The drive filled up or went away: the rest are not tried, and say why.
      if (it.stopAll) { for (const r of j.items) if (r.state === 'waiting') { r.state = 'skipped'; r.note = it.stopAll; } break; }
    }
  }

  async function runOne(j, it) {
    const t0 = now();
    const k = it.key;
    let w;
    try { w = await walkOf(it.dir, false, j.full); } catch (e) { return failed(it, k, e.message, '', 'Check the folder is there, then try again.'); }
    // Each project's own folder on the drive; two projects with the same folder name get a short tag on the second.
    const owner = Object.entries(st.history).find(([key, h]) => key !== k && h.some(x => x.drive === j.drive.id && x.file.split(/[\\/]/)[0] === it.folder));
    const sub = owner ? it.folder + '-' + crypto.createHash('sha1').update(k).digest('hex').slice(0, 6) : it.folder;
    const dir = path.join(j.dir, sub);
    let free = null;
    try { fs.mkdirSync(dir, { recursive: true }); const s = await statfs(j.dir); free = s.bavail * s.bsize; }
    catch (e) { it.stopAll = `${j.driveName} could not be written to.`; return failed(it, k, `${j.driveName} could not be written to (${e.code || e.message}).`, 'It may have been unplugged, or be read-only.', 'Plug it in again and run the backup again.'); }
    // Checked again before each one: something else may have filled the drive since the plan.
    const need = it.need || w.bytes;
    if (free != null && free - need < SPACE_MARGIN) {
      it.stopAll = `${j.driveName} is full.`;
      return failed(it, k, `${j.driveName} is full.`, `${gb(free)} free; ${it.name} needs about ${gb(need)}. Nothing was deleted: backups are never deleted to make room.`, 'Plug in another drive and add it on the Backups page, then run the rest.');
    }
    let base = `${it.folder}-${stamp(now())}`;
    for (let n = 2; fs.existsSync(path.join(dir, base + '.zip')); n++) base = `${it.folder}-${stamp(now())}-${n}`;
    const zip = path.join(dir, base + '.zip'), partial = zip + '.partial';
    const total = Math.max(1, w.bytes);
    it.state = 'zipping'; it.pct = 0; rev++;
    let made;
    j.partial = partial; // removed if TOMLIN has to stop before this one is finished (stopNow)
    try {
      made = await write(partial, w.items, { signal: j.cancel.signal, onBytes: n => { const p = Math.floor((n / total) * 60); if (p !== it.pct) { it.pct = p; rev++; } } });
    } catch (e) {
      if (j.stopped) return; // stopNow removed the zip and said what happened
      let written = 0; try { written = fs.statSync(partial).size; } catch {}
      try { fs.rmSync(partial, { force: true }); } catch {}
      j.partial = null;
      if (e.code === 'ABORT_ERR') { it.state = 'cancelled'; return; }
      // FAT32 answers "disk full" at its 4 GiB file limit, however much room is left: said as what it is, and the rest go on.
      if (e.code === 'ENOSPC' && isFat(j.fs) && written >= fatMax * 0.98) return failed(it, k, `The zip of ${it.name} is too big for ${j.driveName}.`, `${j.driveName} is formatted ${j.fs}, where a single file cannot reach 4 GB; this zip passed ${gb(written)}. The unfinished zip was removed; the backups already there are as they were.`, `Back it up to an exFAT or NTFS drive${j.full ? ', or turn Full backup off (on the Backups page)' : ''}.`);
      if (e.code === 'ENOSPC') { it.stopAll = `${j.driveName} filled up.`; return failed(it, k, `${j.driveName} filled up while ${it.name} was being written.`, 'The unfinished zip was removed; the backups already there are as they were.', 'Plug in another drive and add it on the Backups page, then run it again.'); }
      it.stopAll = `${j.driveName} stopped answering.`;
      return failed(it, k, `${it.name} could not be written to ${j.driveName} (${e.code || e.message}).`, 'The drive may have been unplugged.', 'Plug it in again and run the backup again.');
    }
    if (j.stopped) return;
    it.state = 'checking'; it.pct = 60; rev++;
    let chk;
    try {
      chk = await check(partial, made.entries, { signal: j.cancel.signal, onBytes: n => { const p = 60 + Math.floor((n / total) * 40); if (p !== it.pct) { it.pct = Math.min(99, p); rev++; } } });
    } catch (e) {
      if (j.stopped) return;
      try { fs.rmSync(partial, { force: true }); } catch {}
      j.partial = null;
      if (e.code === 'ABORT_ERR') { it.state = 'cancelled'; return; }
      chk = { ok: false, fault: 'The zip could not be read back (' + (e.code || e.message) + ').' };
    }
    if (j.stopped) return;
    j.partial = null; // from here the .partial is kept on purpose (a failed check) or becomes the zip
    const unreadable = [...w.unreadable, ...made.skipped];
    if (!chk.ok) {
      // Kept as .partial (never counted as a backup) so it can be looked at; the backups already there stay.
      return failed(it, k, `The backup of ${it.name} failed its check.`, chk.fault + ' It was left as ' + path.basename(partial) + ' and does not count as a backup; the earlier backups are as they were.', 'Run it again. If it fails again, try another drive: this one may be failing.');
    }
    // The drive can go away between the check and here (pulled out, or a share dropped): each step says so plainly
    // instead of throwing out of the run, and what was recorded is saved.
    try { fs.renameSync(partial, zip); }
    catch (e) { return failed(it, k, `The backup of ${it.name} could not be finished on ${j.driveName} (${e.code || e.message}).`, 'The zip passed its check, but the drive stopped answering before it could be named: it may have been unplugged. Nothing of it counts as a backup; the earlier backups are as they were.', 'Plug the drive in again and run the backup again.'); }
    const secs = Math.max(0.001, (now() - t0) / 1000);
    const rec = { at: now(), drive: j.drive.id, file: path.join(sub, base + '.zip'), bytes: made.bytes, source: made.entries.reduce((s, e) => s + e.size, 0), files: chk.files, checked: true, host, secs: Math.round(secs),
      ...(j.full ? { full: true } : {}), ...(w.links.length ? { links: w.links.length } : {}), ...(unreadable.length ? { skipped: unreadable.length } : {}) };
    try { fs.writeFileSync(path.join(dir, base + '.txt'), manifest(it, rec, w, unreadable, zip)); } catch {}
    (st.history[k] = Object.hasOwn(st.history, k) ? st.history[k] : []).push(rec);
    st.history[k] = st.history[k].slice(-200);
    delete st.faults[k];
    if (rec.source > 50e6) { j.drive.speeds = [...(j.drive.speeds || []), Math.round(rec.source / secs)].slice(-10); }
    try { tidy(j, k, dir); } catch {} // keep-last-N is tidying only: a drive gone now loses nothing
    save();
    writeIndex(j);
    const notes = [];
    if (unreadable.length) notes.push(`${unreadable.length} ${unreadable.length === 1 ? 'file' : 'files'} could not be read (in use or locked)`);
    if (w.links.length) notes.push(`${w.links.length} ${w.links.length === 1 ? 'link or junction' : 'links or junctions'} not followed`);
    Object.assign(it, { state: 'done', pct: 100, file: rec.file, bytes: rec.bytes, files: rec.files, secs: rec.secs, note: notes.length ? `${notes.join('; ')}: listed in ${base}.txt.` : '' });
  }
  function failed(it, k, f, reason, wayOut) {
    it.state = 'failed';
    it.fault = { fault: f, reason, wayOut };
    st.faults[k] = { at: now(), fault: f, reason, wayOut };
    save();
  }

  // Keep-last-N, when turned on: only zips this TOMLIN wrote (in its record, named <folder>-<date>), only on the drive
  // just written, and only after the new one passed its check. Old .partial files of that project go too.
  function tidy(j, k, dir) {
    for (const n of fs.readdirSync(dir)) if (n.endsWith('.zip.partial')) { try { fs.rmSync(path.join(dir, n), { force: true }); } catch {} }
    if (!st.keepLast) return;
    const mine = (st.history[k] || []).filter(h => h.drive === j.drive.id && h.checked).sort((a, b) => b.at - a.at);
    for (const h of mine.slice(st.keepLast)) {
      const f = path.join(j.dir, h.file);
      if (!/-\d{4}-\d\d-\d\d-\d{4}(-\d+)?\.zip$/.test(h.file) || !isUnder(f, j.dir)) continue;
      try { fs.rmSync(f, { force: true }); fs.rmSync(f.replace(/\.zip$/, '.txt'), { force: true }); } catch { continue; }
      st.history[k] = st.history[k].filter(x => x !== h);
    }
  }
  function writeIndex(j) {
    const backups = [];
    for (const [key, h] of Object.entries(st.history)) for (const x of h) if (x.drive === j.drive.id) backups.push({ key, file: x.file, at: x.at, bytes: x.bytes, source: x.source, files: x.files, checked: x.checked, host: x.host, ...(x.full ? { full: true } : {}), ...(x.links ? { links: x.links } : {}), ...(x.skipped ? { skipped: x.skipped } : {}) });
    try { Settings.saveJson(path.join(j.dir, INDEX_NAME), { madeBy: 'TOMLIN ' + version, note: 'What this folder holds. Each zip has a .txt beside it saying what is in it.', backups }); } catch {}
  }
  function manifest(it, rec, w, unreadable, zip) {
    const lines = [
      `Backup of ${it.name}`,
      `Folder: ${it.dir}`,
      `Made: ${new Date(rec.at).toString()} on ${host}, by TOMLIN ${version}`,
      `Zip: ${path.basename(zip)} (${gb(rec.bytes)})`,
      `Files: ${rec.files} (${gb(rec.source)} before zipping), with the git history (.git) when there is one`,
      rec.full ? 'Kind: full backup (the rebuildable folders, node_modules and the rest, are in it too)' : 'Kind: rebuildable folders left out',
      `Left out (rebuildable): ${Object.keys(w.leftOut).length ? Object.entries(w.leftOut).map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ''}`).join(', ') : 'nothing'}`,
      `Links and junctions not followed: ${w.links.length ? w.links.join(', ') : 'none'}`,
      `Could not be read: ${unreadable.length ? '' : 'none'}`,
      ...unreadable.map(u => `  ${u.name} (${u.why})`),
      `Check: passed. Every file was read back and matched its size and CRC-32 (${new Date().toString()}).`,
      '',
      'To restore: unzip it (right-click › Extract All). It unzips into a folder named after the project.',
    ];
    return lines.join('\r\n') + '\r\n';
  }

  /** Needs attention: [{ id, kind }] for the projects whose row says so (see rowOf). */
  const needs = projects => projects.map(p => ({ id: p.id, kind: rowOf(p).attention })).filter(x => x.kind);

  const history = p => (st.history[keyOf(p.dir)] || []).slice().sort((a, b) => b.at - a.at).slice(0, 50).map(h => ({ ...h, driveName: (st.drives.find(d => d.id === h.drive) || {}).name || 'a drive no longer listed' }));
  const revOf = () => rev + ':' + (job ? job.id : '');
  return { view, addDrive, forgetDrive, setListed, setKeep, setFull, rowOf, plan, start, cancel, stopNow, status: jobView, needs, history, revOf, folderOf: id => (st.drives.find(d => d.id === id) || null), where, mins, gb };
}

module.exports = { create, walk, leftOut, FOLDER_NAME, DEMO_DRIVE, INDEX_NAME, LEAVE_OUT_TEXT, FIRST_GUESS, FAT32_MAX };
