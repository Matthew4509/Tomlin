// Backups (backup.js): the Backups page (drives, keep-last-N, the backup list), and
// Run backups now (plan, start, status, cancel). Projects are named by id only: a folder path in a request is never
// backed up. The one path the page may send is a backup folder typed into Settings, checked before it is used.
'use strict';
const cfg = require('../config');
const { state, findProject } = require('../state');
const desktop = require('../desktop');

const B = () => state.backups;
const bad = (fault, reason = '', wayOut = '') => ({ ok: false, fault, reason, wayOut });
// [id] -> projects on the list, in that order; an id that is not on the list is an error, not skipped silently.
function projectsOf(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) return { error: bad('No project was named.', '', 'Tick the projects to back up.') };
  const out = [];
  for (const id of ids) {
    const p = typeof id === 'string' && findProject(id);
    if (!p) return { error: bad('A project is not on the list any more.', '', 'Reload the page.') };
    if (!out.includes(p)) out.push(p);
  }
  return { list: out };
}
const driveIdOf = v => (typeof v === 'string' && /^[0-9a-f]{12}$/.test(v) ? v : null);
// The demo backs up to a made-up drive in temp: no folder window, no real drive needed.
const DEMO_FOLDER = require('../backup').DEMO_DRIVE;

const get = {
  '/api/backup': async () => ({ ...(await B().view()), demo: cfg.DEMO, dryRun: cfg.DRY }),
  '/api/backup/status': () => ({ job: B().status() }),
};

const post = {
  // Turn on backups / Add a drive: the folder window, or a typed path (when the window is not there, or a test copy).
  '/api/backup/drive/add': async ({ body }) => {
    let chosen = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : null;
    if (!chosen && cfg.DEMO) chosen = DEMO_FOLDER;
    if (!chosen) {
      const r = await desktop.pickFolder('backup');
      if (r.cancelled) return { ok: true, cancelled: true };
      if (r.dryRun) return { ok: true, dryRun: r.dryRun };
      if (r.error) return bad(r.error, '', 'Type the folder path instead.');
      chosen = r.path;
    }
    return B().addDrive(chosen, { projects: state.projects, workingFolders: state.settings.workingFolders });
  },
  '/api/backup/drive/forget': ({ body }) => B().forgetDrive(driveIdOf(body.drive)),
  '/api/backup/drive/open': async ({ body }) => {
    const d = B().folderOf(driveIdOf(body.drive));
    if (!d) return bad('That drive is not on the list.');
    const w = await B().where(d, true);
    if (!w.here) return bad(`${d.name} is not plugged in.`, '', 'Plug it in, then try again.');
    return { ok: true, ...desktop.openFolder(w.dir) };
  },
  // On or off the backup list: { ids, on }.
  '/api/backup/list': ({ body }) => {
    const r = projectsOf(body.ids);
    return r.error || B().setListed(r.list.map(p => p.dir), body.on !== false);
  },
  '/api/backup/keep': ({ body }) => B().setKeep(body.keep),
  // Full backup: { on } true takes the rebuildable folders (node_modules and the rest) too. Off by default.
  '/api/backup/full': ({ body }) => B().setFull(body.on === true),
  // Before Start: each project's size, the time it should take, and whether it fits on the drive.
  '/api/backup/plan': async ({ body }) => {
    const r = projectsOf(body.ids);
    return r.error || { ok: true, ...(await B().plan(r.list, driveIdOf(body.drive))) };
  },
  '/api/backup/start': async ({ body }) => {
    const r = projectsOf(body.ids);
    return r.error || B().start(r.list, driveIdOf(body.drive));
  },
  '/api/backup/cancel': () => B().cancel(),
};

module.exports = { get, post };
