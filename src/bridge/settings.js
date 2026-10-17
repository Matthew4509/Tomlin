// Per-install settings: working folders, projects added one by one, projects removed from the list, and the last
// folder scan. Kept in <data>/settings.json. Nothing here ever touches a project's own files: "remove" only takes a
// project off the Bridge's list.
'use strict';
const fs = require('fs');
const path = require('path');

const norm = p => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

// A file that is there but cannot be used (cut short, edited by hand, not an object) is copied aside before a fresh
// one replaces it, so nothing in it is lost: <name>.damaged-<time>.json beside it.
function setAside(file) {
  try { fs.copyFileSync(file, file.replace(/\.json$/i, '') + '.damaged-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'); } catch {}
}
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const noBom = t => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);

// A file's text. A virus scanner or an editor can hold a file for a moment (EBUSY/EPERM/EACCES): it is read again a
// few times. Still held, the error is thrown: a file that could not be read is never taken as empty and written over.
function readText(file) {
  for (let i = 0; ; i++) {
    try { return fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (!/^(EBUSY|EPERM|EACCES)$/.test(e.code) || i >= 9) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
// A data file (judged list, fault list, private details): { json } (null when there is none). One that cannot be
// parsed is moved aside as <name>.damaged-<time>.json, so nothing in it is lost, and { json: null, damaged } says where.
function readData(file) {
  let text;
  try { text = readText(file); } catch (e) { if (e.code === 'ENOENT') return { json: null }; throw e; }
  try { return { json: JSON.parse(noBom(text)) }; }
  catch {
    const damaged = file.replace(/\.json$/i, '') + '.damaged-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    try { fs.renameSync(file, damaged); } catch { setAside(file); }
    return { json: null, damaged };
  }
}

function load(file, defaultRoot) {
  let s = null;
  let text = null;
  try { text = readText(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (text !== null) try { s = JSON.parse(noBom(text)); } catch { setAside(file); }
  if (s !== null && !isPlain(s)) { setAside(file); s = null; }
  if (!s) {
    s = { workingFolders: [], extraProjects: [], hidden: [], known: [], hiddenView: [], order: [], lastScan: null };
    // First run: the folder the Bridge sits in is taken as the projects folder, unless it is a general folder
    // (unzipped into Downloads, say): then the list starts empty and the first screen offers Add a working folder.
    if (defaultRoot && fs.existsSync(defaultRoot) && !isGeneralFolder(defaultRoot)) s.workingFolders.push(defaultRoot);
    save(file, s);
  }
  // hidden = removed from the list (Folders page brings it back); hiddenView = still on the list but not shown until
  // "Show hidden" is on; order = the person's own order ("My order"), as folder paths.
  // Each list holds folder paths: anything else in one (an entry edited by hand, say) is dropped, not trusted.
  for (const k of ['workingFolders', 'extraProjects', 'hidden', 'known', 'hiddenView', 'order']) s[k] = Array.isArray(s[k]) ? s[k].filter(v => typeof v === 'string' && v.trim()) : [];
  // liveUrls: where each project is hosted, keyed by its folder (lower case); "" = none, even if projects.json has one.
  if (!isPlain(s.liveUrls)) s.liveUrls = {};
  for (const k of Object.keys(s.liveUrls)) if (typeof s.liveUrls[k] !== 'string') delete s.liveUrls[k];
  return s;
}

function isGeneralFolder(dir) {
  const home = require('os').homedir();
  const abs = path.resolve(dir);
  return path.parse(abs).root === abs || norm(abs) === norm(home) || norm(abs) === norm(path.dirname(home))
    || /^(downloads|desktop|documents|onedrive.*|pictures|music|videos)$/i.test(path.basename(abs));
}

// Written whole to a .tmp file, then swapped in. On Windows the swap can be refused for a moment while a virus
// scanner or an editor holds the file (EPERM/EBUSY): it is tried again a few times before the save is reported failed.
function swapIn(tmp, file) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
function save(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  swapIn(tmp, file);
}

// A folder the person may add: must exist, be a folder, and not be a whole drive or a Windows system folder
// (listing C:\ would make Windows, Program Files and Users into "projects").
function checkFolder(p, what) {
  if (typeof p !== 'string' || !p.trim()) return 'No folder was given.';
  const abs = path.resolve(p.trim());
  if (!path.isAbsolute(p.trim())) return 'Give the whole path, starting with the drive, e.g. C:\\Users\\you\\projects.';
  let st;
  try { st = fs.statSync(abs); } catch { return 'The folder ' + abs + ' was not found. Check the path, or pick it with Browse.'; }
  if (!st.isDirectory()) return abs + ' is a file, not a folder.';
  if (/^[a-z]:\\?$/i.test(abs)) return 'A whole drive (' + abs + ') cannot be ' + what + ': pick the folder that holds your projects.';
  const win = norm(process.env.SystemRoot || 'C:\\Windows');
  const blocked = [win, norm(process.env.ProgramFiles || 'C:\\Program Files'), norm(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'), norm(process.env.ProgramData || 'C:\\ProgramData'), norm(path.dirname(process.env.USERPROFILE || 'C:\\Users\\x'))];
  if (blocked.includes(norm(abs)) || norm(abs).startsWith(win + '\\')) return abs + ' is a Windows system folder, so it cannot be ' + what + '. Pick the folder that holds your projects.';
  return null;
}

module.exports = { load, save, swapIn, checkFolder, norm, readText, readData };
