// Where push live keeps what it knows, all inside TOMLIN's data folder (data/bridge/hosting), never in a project:
//   connections.json  the hosts it can reach: kind, address, user name, and the sealed token / password / key
//   sites.json        per project (keyed by its folder): the connection, the site's folder on the host, its address,
//                     the folder that is uploaded, the database, the findings judged "not a secret", the pushes
//   secrets/<id>.json per project: secret names with a sealed Local and a sealed Live value
//   pushes/<id>/<push>/  what one push sent and replaced (and, for FTPS/SFTP, the replaced files themselves)
// The folder carries a .gitignore of "*" (cfg.ensureDataDirs), and TOMLIN's own update backups leave it out
// (src/keep.ts), so sealed values do not travel in a backup zip either.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');
const { keyOf } = require('../projects');

const ROOT = () => path.join(cfg.DATA, 'hosting');
const idOfKey = key => crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
const projectFileId = dir => idOfKey(keyOf(dir));

// A file another program holds for a moment (an antivirus scan, a backup) is tried again a few times.
const HELD = new Set(['EBUSY', 'EPERM', 'EACCES']);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retry(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) { if (!HELD.has(e.code) || i >= 8) throw e; pause(60 * (i + 1)); }
  }
}
// Missing = empty. Damaged (not JSON) = a copy is kept aside, then empty. Unreadable (held, no rights) is an error,
// never "empty": the next save would otherwise write over every connection, site or secret in it.
function readJson(file, empty) {
  let text;
  try { text = retry(() => fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return empty();
    throw new Error('TOMLIN could not read ' + path.basename(file) + ' (' + e.code + '), so it changed nothing. If another program holds it (a virus scan, a backup), close it or wait, then try again.');
  }
  try {
    const v = JSON.parse(text.replace(/^﻿/, ''));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  try { fs.copyFileSync(file, file + '.damaged-' + Date.now()); } catch {}
  return empty();
}
function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '-' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  try { retry(() => fs.renameSync(tmp, file)); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// ---- connections ----
const CONN_FILE = () => path.join(ROOT(), 'connections.json');
function connections() {
  const j = readJson(CONN_FILE(), () => ({ connections: [] }));
  return Array.isArray(j.connections) ? j.connections.filter(c => c && typeof c.id === 'string' && /^(cpanel|ftps|sftp)$/.test(c.kind)) : [];
}
function saveConnections(list) { writeJson(CONN_FILE(), { note: 'Hosting connections. Tokens, passwords and keys are sealed by Windows for this account (DPAPI).', connections: list }); }
const connection = id => connections().find(c => c.id === id) || null;
function putConnection(c) {
  const list = connections().filter(x => x.id !== c.id);
  list.push(c);
  saveConnections(list);
  return c;
}
function dropConnection(id) { saveConnections(connections().filter(x => x.id !== id)); }
// What the page may see: never the sealed fields.
const connectionForPage = c => c && ({ id: c.id, kind: c.kind, label: c.label, host: c.host, port: c.port, user: c.user,
  created: c.created, lastOk: c.lastOk || null, tokenName: c.tokenName || null, publicKey: c.publicKey || null,
  hostKey: c.hostKey || null, home: c.home || null });

// ---- sites ----
const SITES_FILE = () => path.join(ROOT(), 'sites.json');
function allSites() { const j = readJson(SITES_FILE(), () => ({ sites: {} })); return j.sites && typeof j.sites === 'object' ? j.sites : {}; }
function site(dir) { return allSites()[keyOf(dir)] || null; }
function putSite(dir, s) {
  const all = allSites();
  if (s) all[keyOf(dir)] = s; else delete all[keyOf(dir)];
  writeJson(SITES_FILE(), { note: 'Where each project is pushed live. No secret values are kept here.', sites: all });
  return s;
}
function updateSite(dir, fn) { const s = site(dir); const next = fn(s ? JSON.parse(JSON.stringify(s)) : null); return putSite(dir, next); }

// ---- secrets ----
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const secretsFile = dir => path.join(ROOT(), 'secrets', projectFileId(dir) + '.json');
function secretRows(dir) {
  const j = readJson(secretsFile(dir), () => ({ rows: [] }));
  return (Array.isArray(j.rows) ? j.rows : []).filter(r => r && NAME_RE.test(r.name)).map(r => ({ name: r.name, local: typeof r.local === 'string' ? r.local : '', live: typeof r.live === 'string' ? r.live : '', made: r.made || null }));
}
function saveSecretRows(dir, rows) {
  writeJson(secretsFile(dir), { note: 'Secrets for one project. Values are sealed by Windows for this account (DPAPI); TOMLIN never puts them in the project folder, a chat, a prompt or a backup.', project: dir, rows });
}

// ---- pushes ----
const pushDir = (dir, pushId) => path.join(ROOT(), 'pushes', projectFileId(dir), pushId);
const newId = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-') + '-' + crypto.randomBytes(2).toString('hex');

module.exports = { ROOT, readJson, writeJson, connections, connection, putConnection, dropConnection, connectionForPage,
  site, putSite, updateSite, allSites, secretRows, saveSecretRows, NAME_RE, pushDir, newId, projectFileId };
