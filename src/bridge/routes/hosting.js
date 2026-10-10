// Push live: hosting connections, each project's site, secrets, the check, the push, Go back and the database.
// Off until the person turns it on (it is the one part of the Bridge that sends a project's files out). The page
// never receives a secret value, a token, a password or a key: names, lengths and "set" only.
'use strict';
const path = require('path');
const { state, saveSettings } = require('../state');
const { parseLiveUrl } = require('../live');
const store = require('../hosting/store');
const connections = require('../hosting/connections');
const secrets = require('../hosting/secrets');
const check = require('../hosting/check');
const deploy = require('../hosting/deploy');
const db = require('../hosting/db');

const OFF = { ok: false, off: true, error: 'Push live is off. Turn it on first: it is the part of TOMLIN that sends a project\'s files to your web host.' };
const on = () => state.settings.pushLive === true;
const gated = fn => ctx => (on() ? fn(ctx) : OFF);
// What changes where a project goes, or what it sends, waits while its push, Go back or database job runs: that job
// keeps going with what it began with, and a change in the middle would not be what went live.
const BUSY = p => ({ ok: false, busy: true, error: 'A push, Go back or database job for ' + p.name + ' is running. Wait for it to finish, then try again.' });
const idle = fn => ctx => (ctx.p && deploy.running(ctx.p.dir) ? BUSY(ctx.p) : fn(ctx));
const CONN_BUSY = { ok: false, busy: true, error: 'A push, Go back or database job is using this connection right now. Wait for it to finish, then try again.' };
const posix = path.posix;

function sitePage(p) {
  const s = store.site(p.dir);
  if (!s) return null;
  const conn = s.connection ? store.connection(s.connection) : null;
  return { connection: s.connection || null, connectionLabel: conn ? conn.label : null, kind: s.kind, domain: s.domain || null, sub: s.sub || '', url: s.url, root: s.root,
    secretsDir: s.secretsDir || null, folder: s.folder || '', sendAnyway: s.sendAnyway || [], ignored: (s.ignore || []).length,
    pushes: (s.pushes || []).slice().reverse(), db: s.db || null, lastError: s.lastError || null, secretsWritten: !!s.secretsWritten, sentBefore: !!s.lastSent };
}

// A remote folder typed for FTPS/SFTP: relative to the account's own folder, no "..".
function cleanRemote(v) {
  const r = String(v == null ? '' : v).trim().replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (r.split('/').some(x => x === '..' || x === '.')) return { error: 'Type the folder without ".." (like public_html).' };
  if (r.length > 300) return { error: 'That folder path is too long.' };
  return { path: r };
}
// Tests: a made-up domain is served by a little server on this PC (BRIDGE_TEST_SITE_MAP = { domain: 'http://127.0.0.1:port/' }).
function testUrl(domain) {
  if (process.env.BRIDGE_TEST_HOSTING !== '1' || !process.env.BRIDGE_TEST_SITE_MAP) return null;
  try { return JSON.parse(process.env.BRIDGE_TEST_SITE_MAP)[domain] || null; } catch { return null; }
}
const cleanSub = v => String(v || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();

const get = {
  '/api/hosting': () => ({ on: on(), connections: store.connections().map(store.connectionForPage), kinds: connections.KINDS }),
};
const post = {
  '/api/hosting/on': ({ body }) => { state.settings.pushLive = body.on === true; saveSettings(); return { ok: true, on: on() }; },
  '/api/hosting/connect': gated(({ body }) => {
    if (body.kind === 'cpanel') return connections.connectCpanel(body);
    if (body.kind === 'ftps') return connections.connectFtps(body);
    if (body.kind === 'sftp') return connections.startSftp(body);
    return { ok: false, error: 'Pick cPanel, FTPS or SFTP.' };
  }),
  '/api/hosting/test': gated(({ body }) => connections.test(String(body.connection || ''))),
  '/api/hosting/disconnect': gated(({ body }) => (deploy.connectionBusy(String(body.connection || '')) ? CONN_BUSY : connections.disconnect(String(body.connection || '')))),
  '/api/hosting/forget-key': gated(({ body }) => {
    const c = store.connection(String(body.connection || ''));
    if (!c || c.kind !== 'sftp') return { ok: false, error: 'That is not an SFTP connection.' };
    if (deploy.connectionBusy(c.id)) return CONN_BUSY;
    require('../hosting/sftp').forgetServer(c.host, c.port);
    store.putConnection({ ...c, hostKey: null });
    return { ok: true };
  }),
  // The places a connection can push to: cPanel's sites, or the folders in one FTPS/SFTP folder.
  '/api/hosting/places': gated(async ({ body }) => {
    const c = store.connection(String(body.connection || ''));
    if (!c) return { ok: false, error: 'That connection is not there any more.' };
    try {
      const t = await connections.transport(c);
      if (c.kind === 'cpanel') return { ok: true, kind: c.kind, domains: await t.domains() };
      const d = cleanRemote(body.dir);
      if (d.error) return { ok: false, error: d.error };
      const list = await t.listDir(d.path);
      if (!list) return { ok: false, error: 'There is no folder "' + d.path + '" on the server.' };
      return { ok: true, kind: c.kind, dir: d.path, folders: list.filter(x => x.type === 'dir').map(x => x.name).sort(), files: list.filter(x => x.type === 'file').length };
    } catch (e) { return { ok: false, error: e.message }; }
  }),
  '/api/hosting/progress': ({ body }) => deploy.progress(body.job),
};

const pget = {
  '/api/hosting/site': ({ p }) => ({ ok: true, on: on(), site: sitePage(p), guess: check.guessFolder(p.dir), folders: check.folderChoices(p.dir),
    secrets: secrets.forPage(p.dir), sqlFiles: db.sqlFiles(p.dir), running: deploy.running(p.dir), soft: check.SOFT.map(([k, , why, label]) => ({ key: k, why, label })) }),
};
const ppost = {
  // Where this project goes. cPanel: one of the account's sites (and an optional folder inside it). FTPS/SFTP: a
  // folder on the server and the address it shows at.
  '/api/hosting/site/set': gated(idle(async ({ p, body }) => {
    const c = store.connection(String(body.connection || ''));
    if (!c) return { ok: false, error: 'Pick a connection.' };
    const folder = String(body.folder == null ? '' : body.folder).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!check.folderOf(p.dir, folder)) return { ok: false, error: 'The upload folder must be ' + p.name + ' itself or a folder inside it.' };
    const sub = cleanSub(body.sub);
    if (sub && (!/^[a-z0-9._/-]+$/.test(sub) || sub.split('/').includes('..'))) return { ok: false, error: 'The folder inside the site can hold letters, digits, - _ . and / only.' };
    let next;
    if (c.kind === 'cpanel') {
      let domains;
      try { domains = await (await connections.transport(c)).domains(); } catch (e) { return { ok: false, error: e.message }; }
      const d = domains.find(x => x.domain === String(body.domain || '').toLowerCase());
      if (!d) return { ok: false, error: 'Pick one of the account\'s sites.' };
      const home = d.home || c.home;
      if (!home) return { ok: false, error: 'cPanel did not say where the account\'s home folder is, so there is nowhere safe for secrets. Try Test on the connection, then again.' };
      // The main domain's folder (public_html) holds the addon domains' folders: never one of those as this site's.
      next = { kind: 'cpanel', domain: d.domain, sub, root: posix.join(d.root, sub || '.').replace(/\/\.$/, ''), url: (testUrl(d.domain) || 'https://' + d.domain + '/') + (sub ? sub + '/' : ''), secretsDir: posix.join(home, 'tomlin-secrets') };
    } else {
      const r = cleanRemote(body.root);
      if (r.error) return { ok: false, error: r.error };
      const u = parseLiveUrl(body.url, { allowLocal: process.env.BRIDGE_TEST_HOSTING === '1' });
      if (u.error || !u.url) return { ok: false, error: u.error || 'Type the address the site shows at, like example.com.' };
      const parent = posix.dirname(r.path || '.');
      next = { kind: c.kind, domain: new URL(u.url).hostname, sub: '', root: r.path, url: u.url, secretsDir: r.path ? posix.join(parent === '.' ? '' : parent, 'tomlin-secrets') : null };
    }
    const sendAnyway = Array.isArray(body.sendAnyway) ? body.sendAnyway.filter(k => check.SOFT.some(([x]) => x === k)) : [];
    // Looked at again after the wait for the host's list of sites: a push may have begun meanwhile.
    if (deploy.running(p.dir)) return BUSY(p);
    store.updateSite(p.dir, old => {
      const same = old && old.connection === c.id && old.root === next.root;
      return { ...(old || {}), ...next, connection: c.id, folder, sendAnyway, ignore: (old && old.ignore) || [],
        lastSent: same ? old.lastSent || null : null, pushes: (old && old.pushes) || [], db: same ? (old && old.db) || null : null, secretsWritten: same ? !!(old && old.secretsWritten) : false,
        // Another folder: the old one's secrets file is left as it is (a copy of the site may still read it there).
        secretsFile: same ? old.secretsFile : undefined };
    });
    return { ok: true, site: sitePage(p) };
  })),
  '/api/hosting/site/remove': gated(idle(({ p }) => { store.putSite(p.dir, null); return { ok: true, note: 'TOMLIN forgot where ' + p.name + ' goes. Nothing on the server was touched, and its live address stays in the Bridge.' }; })),
  '/api/hosting/check': gated(async ({ p }) => {
    const r = await deploy.runCheck(p);
    if (!r.ok) return r;
    const groups = new Map();
    for (const l of r.left) { const g = groups.get(l.why) || { why: l.why, soft: l.soft || null, count: 0, some: [] }; g.count++; if (g.some.length < 4) g.some.push(l.rel); groups.set(l.why, g); }
    return { ok: true, files: r.files.length, bytes: r.bytes, findings: r.findings, left: [...groups.values()], liveNames: r.liveNames };
  }),
  '/api/hosting/ignore': gated(idle(({ p, body }) => {
    const key = String(body.key || '');
    if (!/^(KEY|ASSIGN|PRIVATE|PATH|NAME|BIG)\|/.test(key)) return { ok: false, error: 'That finding cannot be set aside.' };
    store.updateSite(p.dir, x => { const set = new Set(x.ignore || []); if (body.on === false) set.delete(key); else set.add(key); return { ...x, ignore: [...set] }; });
    return { ok: true };
  })),
  '/api/hosting/push': gated(({ p, body }) => deploy.push(p, { all: body.all === true })),
  '/api/hosting/back': gated(({ p }) => deploy.goBack(p)),
  '/api/hosting/secrets': gated(idle(async ({ p, body }) => {
    try { return await secrets.save(p.dir, body.rows); } catch (e) { return { ok: false, error: e.message }; }
  })),
  '/api/hosting/db/setup': gated(async ({ p, body }) => { try { return await db.setup(p, body); } catch (e) { return { ok: false, error: e.message }; } }),
  '/api/hosting/db/load': gated(async ({ p, body }) => { try { return await db.load(p, body); } catch (e) { return { ok: false, error: e.message }; } }),
  '/api/hosting/db/forget': gated(idle(({ p }) => { store.updateSite(p.dir, x => ({ ...x, db: null })); return { ok: true, note: 'TOMLIN forgot the database record. The database itself and the DB_ secrets are still there.' }; })),
};

module.exports = { get, post, pget, ppost };
