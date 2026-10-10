// One push, and Go back. The same steps for every kind of host:
//  1 check the upload folder (check.js): any finding stops here, before anything is sent
//  2 compare with the last push: only new and changed files are sent; files TOMLIN sent before and that are gone
//    from the folder now are removed. A file TOMLIN never sent is never removed, so another site's folder inside
//    this one (cPanel's addon domains live inside public_html) is never touched.
//  3 keep a copy of every file on the server that is about to be replaced or removed (cPanel: copied on the server,
//    in a folder outside the web root; FTPS/SFTP: downloaded to this PC), so Go back can put them back
//  4 send the files; write the Live secrets to one file OUTSIDE the web folder (owner-only), and the small
//    tomlin-secrets.php loader (no values in it) into the site
//  5 ask the live site for /.env, /tomlin-secrets.php and /.git/config: no secret value may come back
//  6 the Bridge takes the site's address as the project's live address and checks it (the light)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');
const store = require('./store');
const check = require('./check');
const secrets = require('./secrets');
const connections = require('./connections');
const disclosure = require('../disclosure');

const posix = path.posix;
const KEEP_BACKUPS = 3;
const jobs = new Map(); // job id -> progress
const busy = new Set(); // project keys with a push or a Go back running
const busyAt = new Map(); // project key -> the server folder its push or Go back is writing to ({ host, root })

// The server folder a push writes to, as one host + folder. Two projects that write to the same folder (or one
// inside the other) on the same host never run at once.
// By host name only (cPanel, FTPS and SFTP to one account use different ports), and the folder as seen from the
// account's own folder (cPanel names it from /home/<user>, FTPS and SFTP from the login folder). Two accounts on one
// host only wait for each other.
function placeOf(conn, root) {
  let r = posix.normalize('/' + String(root || '')).replace(/\/+$/, '');
  const home = conn.kind === 'cpanel' && conn.home ? posix.normalize('/' + conn.home).replace(/\/+$/, '') : '';
  if (home && (r === home || r.startsWith(home + '/'))) r = r.slice(home.length);
  return { host: String(conn.host || '').toLowerCase(), root: r.toLowerCase() };
}
function placeBusy(place) {
  for (const [key, b] of busyAt) {
    if (b.host !== place.host) continue;
    const a = place.root + '/', c = b.root + '/';
    if (a.startsWith(c) || c.startsWith(a)) return key;
  }
  return null;
}
function claim(key, place) {
  if (busy.has(key)) return 'A push or Go back for this project is already running.';
  const other = placeBusy(place);
  if (other) return 'Another project is pushing to the same folder on this host right now (' + (place.root || '/') + '). Wait for it to finish, then try again.';
  busy.add(key); busyAt.set(key, place);
  return null;
}
function release(key) { busy.delete(key); busyAt.delete(key); }

const joinR = (...p) => posix.join(...p.filter(x => x != null && x !== ''));
const phpStr = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const siteId = s => (s.domain || 'site').replace(/[^a-z0-9.-]+/gi, '-').toLowerCase() + (s.sub ? '-' + s.sub.replace(/[^a-z0-9]+/gi, '-').toLowerCase() : '');

function newJob(kind, p) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, kind, project: p.id, name: p.name, steps: [], done: false, ok: false, error: null, result: null, started: Date.now() };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (j.done && Date.now() - j.started > 3600000) jobs.delete(k);
  return job;
}
function step(job, text) {
  for (const s of job.steps) if (s.state === 'run') s.state = 'done';
  const s = { text, state: 'run' };
  job.steps.push(s);
  return s;
}
function finish(job, ok, error, result) {
  for (const s of job.steps) if (s.state === 'run') s.state = ok ? 'done' : 'fail';
  job.done = true; job.ok = ok; job.error = error || null; job.result = result || null;
}

// The values the check looks for, and the private details.
async function checkInputs(p, s) {
  const [live, local] = await Promise.all([secrets.values(p.dir, 'live'), secrets.values(p.dir, 'local')]);
  const { state } = require('../state');
  // Each value under its own label: a Local password that differs from the Live one is looked for too.
  const label = (scope, vals) => Object.fromEntries(Object.entries(vals).map(([k, v]) => [scope + ' ' + k, v]));
  return {
    projectDir: p.dir,
    sendAnyway: s.sendAnyway || [], ignore: s.ignore || [],
    secrets: { ...label('local', local), ...label('live', live) },
    details: disclosure.readPrivateList(cfg.PRIVATE_FILE),
    otherDetails: disclosure.autoDetails(state.settings.workingFolders || []),
    live,
  };
}

/** Check only (the Check button, and step 1 of a push). */
async function runCheck(p) {
  const s = store.site(p.dir);
  if (!s) return { ok: false, error: 'Set up where ' + p.name + ' goes first.' };
  const folder = check.folderOf(p.dir, s.folder);
  if (!folder) return { ok: false, error: 'The upload folder "' + (s.folder || p.folder) + '" is not in ' + p.name + ' any more. Pick it again in Set up.' };
  const inp = await checkInputs(p, s);
  const r = await check.checkFolder({ ...inp, folder });
  return { ok: true, folder, ...r, liveNames: Object.keys(inp.live), live: inp.live };
}

// The PHP file with the Live values, and the loader the site includes. Values never go anywhere else.
function secretsFileText(s, live) {
  return '<?php\n// Written by TOMLIN on each push: the Live settings for ' + (s.domain || 'this site') + '.\n// It lives outside the web folder and only this hosting account can read it. Change values in TOMLIN, not here.\nreturn array(\n'
    + Object.entries(live).map(([k, v]) => '  ' + phpStr(k) + ' => ' + phpStr(v) + ',\n').join('') + ');\n';
}
function loaderText(s, fileName) {
  const where = s.kind === 'cpanel' ? phpStr(joinR(s.secretsDir, fileName)) : 'dirname(__DIR__) . ' + phpStr('/tomlin-secrets/' + fileName);
  return '<?php\n// Made by TOMLIN on each push. It holds no values: it reads this site\'s Live settings from a file outside the\n'
    + '// web folder and makes them readable with getenv(). In your code: @include __DIR__ . \'/tomlin-secrets.php\';\n'
    + "if (!defined('TOMLIN_SECRETS')) {\n  define('TOMLIN_SECRETS', 1);\n  $tomlin_s = @include " + where + ";\n"
    + "  if (is_array($tomlin_s)) foreach ($tomlin_s as $tomlin_k => $tomlin_v) { putenv($tomlin_k . '=' . $tomlin_v); $_ENV[$tomlin_k] = $tomlin_v; $_SERVER[$tomlin_k] = $tomlin_v; }\n"
    + "  unset($tomlin_s, $tomlin_k, $tomlin_v);\n}\n";
}
const DENY = '# Made by TOMLIN: nothing in this folder is ever served to a browser.\n<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n';

/** Writes the Live values to the server (and the loader into the site, unless loader === false). */
async function writeSecrets(t, s, live, loader = true) {
  if (!s.secretsDir) throw new Error('This site\'s web folder is the top folder of the account, so there is no folder above it to keep secrets in. Pick a web folder inside the account (like public_html).');
  const fileName = siteId(s) + '.php';
  await t.putText(joinR(s.secretsDir, '.htaccess'), DENY, '0644');
  const r = await t.putText(joinR(s.secretsDir, fileName), secretsFileText(s, live), '0600');
  if (loader) await t.putText(joinR(s.root, 'tomlin-secrets.php'), loaderText(s, fileName), '0644');
  return { file: joinR(s.secretsDir, fileName), chmod: !(r && r.chmod === false) };
}

// Ask the live site for the files that must never show a secret. Nothing found = good.
async function leakCheck(url, live) {
  const { get, looksBlocked } = require('../live');
  const values = Object.values(live).filter(v => v && v.length >= 6);
  const out = [];
  for (const rel of ['tomlin-secrets.php', '.env', '.git/config']) {
    const u = new URL(rel, url).href;
    const r = await get(u, { timeout: 15000, maxBytes: 200000, allowLocal: process.env.BRIDGE_TEST_HOSTING === '1' });
    if (r.error) { out.push({ path: '/' + rel, ok: null, said: 'could not ask (' + (r.error.message || r.error.code) + ')' }); continue; }
    // A firewall or security-check page, too many asks, or a server fault: the file itself was not seen, so it is not a pass.
    if (looksBlocked(r) || r.status === 429 || r.status >= 500) { out.push({ path: '/' + rel, status: r.status, ok: null, said: 'could not see it (the site answered ' + r.status + (looksBlocked(r) ? ' with a security check page' : '') + ')' }); continue; }
    const body = String(r.body || '');
    const leaked = values.some(v => body.includes(v));
    const isEnv = rel === '.env' && r.status === 200 && /^[A-Z_][A-Z0-9_]*=/m.test(body);
    const isGit = rel === '.git/config' && r.status === 200 && /\[core\]/.test(body);
    out.push({ path: '/' + rel, status: r.status, ok: !leaked && !isEnv && !isGit,
      said: leaked ? 'SHOWS A SECRET VALUE' : isEnv ? 'a .env file is readable on the site (from before TOMLIN?): delete it on the server' : isGit ? 'git\'s own folder is readable on the site: delete .git on the server' : 'nothing secret (' + r.status + ')' });
    await new Promise(res => setTimeout(res, process.env.BRIDGE_TEST_HOSTING === '1' ? 10 : 2000));
  }
  return out;
}

async function setLiveAddress(p, url) {
  const { keyOf } = require('../projects');
  const { state, saveSettings, refreshProjects, findProject } = require('../state');
  const { forget, checkLive } = require('../live-state');
  state.settings.liveUrls[keyOf(p.dir)] = url;
  saveSettings();
  refreshProjects();
  forget(p.dir);
  try { return await checkLive(findProject(p.id)); } catch { return null; }
}

function pruneLocal(p, s) {
  const keep = (s.pushes || []).slice(-KEEP_BACKUPS).map(x => x.id);
  const dir = path.dirname(store.pushDir(p.dir, 'x'));
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) if (!keep.includes(n)) { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch {} }
}

/**
 * The push. opts: { all: true } sends every file, not only the changed ones.
 * Returns the job at once; the page reads its progress with progress(id).
 */
function push(p, opts = {}) {
  const key = p.dir.toLowerCase();
  if (busy.has(key)) return { ok: false, error: 'A push or Go back for ' + p.name + ' is already running.' };
  const s0 = store.site(p.dir);
  if (!s0 || !s0.connection) return { ok: false, error: 'Set up where ' + p.name + ' goes first (Push live, Set up).' };
  const conn = store.connection(s0.connection);
  if (!conn) return { ok: false, error: 'The connection ' + p.name + ' used is gone. Pick another in Set up.' };
  const no = claim(key, placeOf(conn, s0.root));
  if (no) return { ok: false, error: no };
  const job = newJob('push', p);
  (async () => {
    let s = s0, pushId = null, stage = null;
    try {
      step(job, 'Checking the files');
      const c = await runCheck(p);
      if (!c.ok) throw new Error(c.error);
      if (c.findings.length) { job.findings = c.findings; throw new Error(c.findings.length + ' thing' + (c.findings.length === 1 ? '' : 's') + ' must not go live. Nothing was sent.'); }
      if (!c.files.length) throw new Error('There are no files to send in the upload folder.');
      const live = c.live;
      if (Object.keys(live).length && !s.secretsDir) throw new Error('This site has Live secrets but no folder above its web folder to keep them in. Pick a web folder inside the account (like public_html) in Set up.');

      // What changed since the last push.
      const last = opts.all ? {} : (s.lastSent || {});
      const now = Object.fromEntries(c.files.map(f => [f.rel, f.sha]));
      const send = c.files.filter(f => last[f.rel] !== f.sha);
      const gone = Object.keys(last).filter(rel => !(rel in now));
      job.plan = { send: send.length, same: c.files.length - send.length, remove: gone.length, bytes: send.reduce((a, f) => a + f.size, 0) };
      // sftp reads [ and ] in a name as a pattern: "team[1].jpg" could copy or remove team1.jpg instead.
      const patterned = conn.kind === 'sftp' ? [...send.map(f => f.rel), ...gone].filter(rel => /[[\]*?]/.test(rel)) : [];
      if (patterned.length) throw new Error('SFTP cannot send or remove a file whose name has [ or ] in it (it reads them as a pattern): rename ' + patterned.slice(0, 3).join(', ') + (patterned.length > 3 ? ' and ' + (patterned.length - 3) + ' more' : '') + '. Nothing was sent.');

      // The files to send are copied aside now, and each copy must be the file that was checked: an editor, a build or
      // a job that changes a file after the check cannot change what goes live.
      pushId = store.newId();
      const local = store.pushDir(p.dir, pushId);
      stage = path.join(local, 'stage');
      fs.mkdirSync(stage, { recursive: true });
      for (const f of send) {
        const to = path.join(stage, ...f.rel.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(c.folder, f.rel), to);
        if (check.hashFile(to) !== f.sha) throw new Error(f.rel + ' changed after it was checked, so nothing was sent. Push again when nothing is writing to the folder.');
      }

      step(job, 'Connecting to ' + conn.host);
      const t = await connections.transport(conn);

      step(job, 'Looking at what is on the server');
      const listings = new Map();
      const there = async rel => {
        const dir = posix.dirname(joinR(s.root, rel));
        if (!listings.has(dir)) listings.set(dir, await t.listDir(dir));
        const list = listings.get(dir);
        return list ? list.find(x => x.name === posix.basename(rel)) || null : null;
      };
      const replaced = [], added = [];
      for (const f of send) {
        const x = await there(f.rel);
        if (x && x.type === 'dir') throw new Error('On the server, ' + f.rel + ' is a folder, so the file of that name cannot be sent. Rename one of them.');
        if (x) replaced.push({ rel: f.rel, size: x.size }); else added.push(f.rel);
      }
      const removing = [];
      for (const rel of gone) { const x = await there(rel); if (x && x.type === 'file') removing.push({ rel, size: x.size }); }

      const need = job.plan.bytes + (conn.kind === 'cpanel' ? replaced.reduce((a, x) => a + x.size, 0) : 0) + 10 * 1024 * 1024;
      const free = await t.freeBytes().catch(() => null);
      if (free != null && free < need) throw new Error('The hosting account has ' + (free / 1048576).toFixed(0) + ' MB free and this push needs about ' + (need / 1048576).toFixed(0) + ' MB (the files and the copies of what they replace). Free some space in cPanel (File Manager, or old backups), then push again.');

      const backupRoot = conn.kind === 'cpanel' ? joinR(conn.home || posix.dirname(s.secretsDir || '/'), 'tomlin-push-backups', siteId(s), pushId) : null;
      const backedUp = [];
      if (replaced.length || removing.length) {
        step(job, 'Keeping a copy of ' + (replaced.length + removing.length) + ' file' + (replaced.length + removing.length === 1 ? '' : 's') + ' it replaces or removes');
        if (backupRoot) await t.putText(joinR(backupRoot, 'README.txt'), 'Copies TOMLIN kept before push ' + pushId + ' of ' + (s.domain || '') + '. Go back in TOMLIN puts them back. Safe to delete.\n', '0600');
        let n = 0;
        for (const x of [...replaced, ...removing]) {
          const ref = backupRoot ? joinR(backupRoot, 'f' + String(++n).padStart(5, '0')) : path.join(local, 'backup', 'f' + String(++n).padStart(5, '0'));
          if (backupRoot) await t.copy(joinR(s.root, x.rel), ref); else await t.download(joinR(s.root, x.rel), ref);
          backedUp.push({ rel: x.rel, ref });
        }
      }
      const manifest = { id: pushId, at: new Date().toISOString(), connection: conn.id, root: s.root, backupRoot, sent: send.map(f => f.rel), added, backedUp, removed: removing.map(x => x.rel), lastSent: s.lastSent || null };
      fs.writeFileSync(path.join(local, 'manifest.json'), JSON.stringify(manifest, null, 2));
      // On the list before anything on the server changes: a push that stops part way (a dropped connection, TOMLIN
      // closed) can still be undone with Go back, which puts back what it kept and removes what it added.
      const record = { id: pushId, at: manifest.at, sent: send.length, added: added.length, replaced: replaced.length, removed: removing.length, bytes: job.plan.bytes, secrets: Object.keys(live).length, ok: false, pending: true };
      s = store.updateSite(p.dir, x => { x.pushes = [...(x.pushes || []), record].slice(-10); return x; });

      if (send.length) {
        const st = step(job, 'Sending ' + send.length + ' file' + (send.length === 1 ? '' : 's') + ' (' + (job.plan.bytes / 1048576).toFixed(1) + ' MB)');
        const base = st.text;
        await t.upload(send.map(f => ({ local: path.join(stage, ...f.rel.split('/')), remote: joinR(s.root, f.rel) })), n => { st.text = base + ': ' + n + ' sent'; });
      }
      let sec = null;
      // Secrets written before and none now: the file is emptied, so no old value stays on the server.
      if (Object.keys(live).length || s.secretsWritten) { step(job, Object.keys(live).length ? 'Writing the Live secrets outside the web folder' : 'Emptying the Live secrets file (no Live secrets now)'); sec = await writeSecrets(t, s, live); }
      if (removing.length) {
        step(job, 'Removing ' + removing.length + ' file' + (removing.length === 1 ? '' : 's') + ' TOMLIN sent before that are gone from the folder or left out now');
        for (const x of removing) { try { await t.remove(joinR(s.root, x.rel)); } catch (e) { if (!/not (?:found|there)|No such|does not exist/i.test(e.message)) throw e; } }
      }
      s = store.updateSite(p.dir, x => {
        x.lastSent = now;
        if (sec) x.secretsWritten = true;
        for (const o of x.pushes || []) if (o.id === pushId) { o.ok = true; delete o.pending; }
        return x;
      });
      pruneLocal(p, s);
      // Old server-side copies: only the last few pushes keep theirs.
      if (conn.kind === 'cpanel') {
        const old = (s.pushes || []).slice(0, -KEEP_BACKUPS).filter(x => !x.pruned);
        for (const o of old) { try { await t.remove(joinR(conn.home || posix.dirname(s.secretsDir || '/'), 'tomlin-push-backups', siteId(s), o.id)); } catch {} }
        if (old.length) s = store.updateSite(p.dir, x => { for (const o of x.pushes) if (old.some(y => y.id === o.id)) o.pruned = true; return x; });
      }

      step(job, 'Checking the live site shows no secret');
      const leaks = await leakCheck(s.url, live);
      step(job, 'Setting ' + s.url + ' as the live address');
      const lightState = await setLiveAddress(p, s.url);
      const bad = leaks.filter(l => l.ok === false);
      // A check that could not ask the site (no answer, a certificate fault) is not a pass: the push says so.
      const unasked = leaks.filter(l => l.ok == null);
      const verified = bad.length ? 'leak' : unasked.length ? 'not-checked' : 'ok';
      s = store.updateSite(p.dir, x => { for (const o of x.pushes || []) if (o.id === pushId) o.verified = verified; return x; });
      const problems = [...bad.map(l => l.path + ' ' + l.said), ...(unasked.length ? ['TOMLIN could not ask the site for ' + unasked.map(l => l.path).join(', ') + ' (' + unasked[0].said + '), so it is not known whether they show a secret: open them in a browser to be sure they show nothing'] : [])];
      finish(job, !problems.length, problems.length ? 'The files went live, but: ' + problems.join('; ') + '.' : null,
        { url: s.url, pushId, sent: send.length, same: job.plan.same, removed: removing.length, kept: backedUp.length, secrets: sec, leaks, verified, live: lightState });
    } catch (e) {
      finish(job, false, e.message);
      try {
        store.updateSite(p.dir, x => {
          if (!x) return x;
          x.lastError = { at: new Date().toISOString(), error: e.message };
          // Stopped part way: kept on the list (not ok), so Go back can undo what was done.
          for (const o of x.pushes || []) if (o.id === pushId && o.pending) { delete o.pending; o.failed = true; o.error = e.message; }
          return x;
        });
      } catch {}
      // Nothing on the server changed yet (no record made): this try leaves nothing behind on this PC either.
      try { const s1 = store.site(p.dir); if (pushId && !(s1 && (s1.pushes || []).some(o => o.id === pushId))) fs.rmSync(store.pushDir(p.dir, pushId), { recursive: true, force: true }); } catch {}
    } finally {
      if (stage) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} }
      release(key);
    }
  })();
  return { ok: true, job: job.id };
}

/** Go back: undoes the newest push that is not undone yet (puts back what it replaced, removes what it added), also one
 * that stopped part way. Files only: the Live secrets and a database are not put back. */
function goBack(p) {
  const key = p.dir.toLowerCase();
  if (busy.has(key)) return { ok: false, error: 'A push or Go back for ' + p.name + ' is already running.' };
  const s = store.site(p.dir);
  const last = s && (s.pushes || []).filter(x => !x.undone).pop();
  if (!last) return { ok: false, error: 'There is no push of ' + p.name + ' to go back from.' };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(store.pushDir(p.dir, last.id), 'manifest.json'), 'utf8')); }
  catch { return { ok: false, error: 'The record of the last push is not on this PC any more, so it cannot be undone.' }; }
  const conn = store.connection(manifest.connection);
  if (!conn) return { ok: false, error: 'The connection that push used is gone, so it cannot be undone. Connect it again first.' };
  const no = claim(key, placeOf(conn, manifest.root));
  if (no) return { ok: false, error: no };
  const job = newJob('back', p);
  (async () => {
    try {
      step(job, 'Connecting to ' + conn.host);
      const t = await connections.transport(conn);
      if (manifest.added.length) {
        step(job, 'Removing ' + manifest.added.length + ' file' + (manifest.added.length === 1 ? '' : 's') + ' that push added');
        // A file already taken off by hand is skipped: only what is still there is removed.
        const lists = new Map();
        for (const rel of manifest.added) {
          const dir = posix.dirname(joinR(manifest.root, rel));
          if (!lists.has(dir)) lists.set(dir, await t.listDir(dir));
          const list = lists.get(dir);
          if (!list || !list.some(x => x.name === posix.basename(rel) && x.type === 'file')) continue;
          await t.remove(joinR(manifest.root, rel));
        }
      }
      if (manifest.backedUp.length) {
        step(job, 'Putting back ' + manifest.backedUp.length + ' file' + (manifest.backedUp.length === 1 ? '' : 's') + ' as they were before');
        for (const b of manifest.backedUp) {
          const dest = joinR(manifest.root, b.rel);
          if (manifest.backupRoot) { try { await t.remove(dest); } catch {} await t.copy(b.ref, dest); }
          else await t.upload([{ local: b.ref, remote: dest }]);
        }
      }
      store.updateSite(p.dir, x => {
        for (const o of x.pushes || []) if (o.id === last.id) { o.undone = true; o.undoneAt = new Date().toISOString(); }
        // The server now holds the files from before that push: the next push sends everything again, to be sure.
        x.lastSent = null;
        return x;
      });
      // Go back puts back FILES only: the Live secrets file and a database stay as the newest push left them.
      finish(job, true, null, { pushId: last.id, removed: manifest.added.length, restored: manifest.backedUp.length, filesOnly: true });
    } catch (e) { finish(job, false, e.message); }
    finally { release(key); }
  })();
  return { ok: true, job: job.id };
}

const progress = id => { const j = jobs.get(String(id)); return j ? { ok: true, job: j } : { ok: false, error: 'That push is not known (TOMLIN was restarted?).' }; };
const running = dir => busy.has(dir.toLowerCase());

module.exports = { push, goBack, progress, runCheck, writeSecrets, leakCheck, running, siteId, secretsFileText, loaderText, joinR, newJob, step, finish };
