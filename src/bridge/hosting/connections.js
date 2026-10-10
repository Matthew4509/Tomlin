// Hosting connections: connect (cPanel, FTPS, SFTP), test, disconnect, and the transport each push uses.
// cPanel: the password is used once to make TOMLIN's token, then dropped; nothing on disk ever holds it.
// Disconnect deletes that token on the server too, so a copy of TOMLIN's data could not use it.
'use strict';
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const vault = require('./vault');
const store = require('./store');
const cpanel = require('./cpanel');
const ftps = require('./ftps');
const sftp = require('./sftp');

const TEST = () => process.env.BRIDGE_TEST_HOSTING === '1';
const KINDS = { cpanel: 'cPanel', ftps: 'FTPS', sftp: 'SFTP' };

// "https://server.host.com:2083/cpsess123/..." -> "server.host.com"
function cleanHost(text) {
  let t = String(text || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '');
  const portIn = (t.match(/:(\d{1,5})$/) || [])[1];
  t = t.replace(/:\d{1,5}$/, '').toLowerCase();
  if (!t) return { error: 'Type the server name, like server123.yourhost.com.' };
  if (!/^[a-z0-9.-]+$/.test(t) || t.length > 253) return { error: '"' + text + '" is not a server name. Type it like server123.yourhost.com (no https:// needed).' };
  if (!t.includes('.') && !(TEST() && t === 'localhost')) return { error: '"' + t + '" is not a full server name. Type it like server123.yourhost.com.' };
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(t) && !TEST()) return { error: t + ' is this PC or your home network, not a web host.' };
  return { host: t, port: portIn ? Number(portIn) : null };
}
const cleanPort = (v, dflt) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : dflt; };
// A user name is never read as an option by ssh or curl (one starting with "-" would be), and has no space, quote or @.
const cleanUser = v => { const u = String(v || '').trim().slice(0, 128); return /^-|[\s"@]/.test(u) ? '' : u; };
const newConnId = () => crypto.randomBytes(6).toString('hex');
const pcTag = () => os.hostname().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'PC';

// ---------- connect ----------
async function connectCpanel(body) {
  const h = cleanHost(body.host);
  if (h.error) return { ok: false, error: h.error };
  const user = cleanUser(body.user);
  if (!user) return { ok: false, error: 'Type your cPanel user name (it is in your hosting welcome email).' };
  const password = typeof body.password === 'string' ? body.password : '';
  const pasted = typeof body.token === 'string' ? body.token.trim() : '';
  if (!password && !pasted) return { ok: false, error: 'Type your cPanel password (used once to make TOMLIN\'s own token, then dropped), or paste a token made in cPanel.' };
  if (pasted && !/^[A-Z0-9]{20,64}$/i.test(pasted)) return { ok: false, error: 'That token does not look like a cPanel token (letters and digits, about 32 long). Copy it again from cPanel, Security, Manage API Tokens.' };
  const port = cleanPort(body.port, h.port || 2083);
  const base = { host: h.host, port, user, scheme: TEST() ? body.scheme : undefined };
  let token = pasted, tokenName = null;
  try {
    if (!token) {
      tokenName = 'TOMLIN_' + pcTag() + '_' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
      // A token of that name already there (connected twice today): a fresh name.
      tokenName += '_' + crypto.randomBytes(2).toString('hex');
      token = (await cpanel.client({ ...base, password }).makeToken(tokenName)).token;
    }
    const c = cpanel.client({ ...base, token });
    const domains = await c.domains();
    const free = await c.freeBytes().catch(() => null);
    const conn = { id: newConnId(), kind: 'cpanel', label: String(body.label || '').trim().slice(0, 60) || user + ' on ' + h.host, host: h.host, port, user,
      scheme: base.scheme, secret: await vault.seal(token), tokenName, created: new Date().toISOString(), lastOk: new Date().toISOString(),
      home: (domains[0] && domains[0].home) || null };
    store.putConnection(conn);
    return { ok: true, connection: store.connectionForPage(conn), domains, free, passwordDropped: !!password };
  } catch (e) {
    // The token was made but something after it failed: take it off again, so none is left behind unseen.
    if (tokenName && token && !pasted) { try { await cpanel.client({ ...base, token }).revokeToken(tokenName); } catch {} }
    return { ok: false, error: e.message };
  }
}

async function connectFtps(body) {
  const h = cleanHost(body.host);
  if (h.error) return { ok: false, error: h.error };
  const user = cleanUser(body.user);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!user || !password) return { ok: false, error: 'Type the FTP account\'s user name and password (your hosting panel, FTP Accounts).' };
  const implicit = body.implicit === true;
  const plain = TEST() && body.plain === true;
  const port = cleanPort(body.port, h.port || (implicit ? 990 : 21));
  const c = ftps.client({ host: h.host, port, user, password, implicit, plain });
  try {
    const top = await c.listDir('');
    const conn = { id: newConnId(), kind: 'ftps', label: String(body.label || '').trim().slice(0, 60) || user + ' on ' + h.host, host: h.host, port, user, implicit, plain: plain || undefined,
      secret: await vault.seal(password), created: new Date().toISOString(), lastOk: new Date().toISOString() };
    store.putConnection(conn);
    return { ok: true, connection: store.connectionForPage(conn), folders: (top || []).filter(x => x.type === 'dir').map(x => x.name) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// SFTP in two steps: make the key now (shown to add in the host's panel), test once it is added.
async function startSftp(body) {
  const h = cleanHost(body.host);
  if (h.error) return { ok: false, error: h.error };
  const user = cleanUser(body.user);
  if (!user) return { ok: false, error: 'Type the account\'s user name (for cPanel hosts, your cPanel user name).' };
  try {
    const key = await sftp.makeKey();
    const conn = { id: newConnId(), kind: 'sftp', label: String(body.label || '').trim().slice(0, 60) || user + ' on ' + h.host, host: h.host, port: cleanPort(body.port, h.port || 22), user,
      secret: await vault.seal(key.privateKey), publicKey: key.publicKey, created: new Date().toISOString(), lastOk: null };
    store.putConnection(conn);
    return { ok: true, connection: store.connectionForPage(conn) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// The fingerprint OpenSSH prints for a server key (SHA256:...), from TOMLIN's known_hosts.
function hostKeyOf(host, port) {
  try {
    const tag = Number(port) && Number(port) !== 22 ? '[' + host + ']:' + port : host;
    const line = fs.readFileSync(require('path').join(store.ROOT(), 'known_hosts'), 'utf8').split(/\r?\n/).find(l => l.split(' ')[0].split(',').includes(tag));
    if (!line) return null;
    const [, type, b64] = line.split(' ');
    return type + ' SHA256:' + crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '');
  } catch { return null; }
}

// ---------- use ----------
/** The transport for a connection: { kind, listDir, upload, putText, remove, move, download|copy, freeBytes, ... } */
async function transport(conn) {
  const secret = await vault.open(conn.secret);
  if (conn.kind === 'cpanel') {
    const c = cpanel.client({ host: conn.host, port: conn.port, user: conn.user, token: secret, scheme: conn.scheme });
    return { kind: 'cpanel', describe: () => 'cPanel ' + conn.user + '@' + conn.host, ...c, test: () => c.domains() };
  }
  if (conn.kind === 'ftps') return ftps.client({ host: conn.host, port: conn.port, user: conn.user, password: secret, implicit: conn.implicit, plain: conn.plain });
  return sftp.client({ host: conn.host, port: conn.port, user: conn.user, privateKey: secret });
}

async function test(id) {
  const conn = store.connection(id);
  if (!conn) return { ok: false, error: 'That connection is not there any more.' };
  try {
    const t = await transport(conn);
    const extra = {};
    if (conn.kind === 'cpanel') { extra.domains = await t.domains(); extra.free = await t.freeBytes().catch(() => null); }
    else extra.folders = ((await t.listDir('')) || []).filter(x => x.type === 'dir').map(x => x.name);
    conn.lastOk = new Date().toISOString();
    if (conn.kind === 'sftp') conn.hostKey = hostKeyOf(conn.host, conn.port);
    store.putConnection(conn);
    return { ok: true, connection: store.connectionForPage(conn), ...extra };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Disconnect: TOMLIN's cPanel token is deleted on the server first; the connection leaves every site that used it. */
async function disconnect(id) {
  const conn = store.connection(id);
  if (!conn) return { ok: true };
  let note = '';
  if (conn.kind === 'cpanel' && conn.tokenName) {
    try { await (await transport(conn)).revokeToken(conn.tokenName); note = 'TOMLIN\'s token ' + conn.tokenName + ' was deleted in cPanel.'; }
    catch (e) { note = 'TOMLIN could not delete its token in cPanel (' + e.message + '). Delete it yourself: cPanel, Security, Manage API Tokens, ' + conn.tokenName + '.'; }
  } else if (conn.kind === 'cpanel') note = 'The token you pasted is still in cPanel: delete it there if nothing else uses it (Security, Manage API Tokens).';
  else if (conn.kind === 'sftp') note = 'Take TOMLIN\'s key off the server too: your host\'s panel, SSH Access, Manage SSH Keys (its comment is TOMLIN).';
  else note = 'The FTP account itself is still on the server: change its password or delete it in your hosting panel if it was made only for TOMLIN.';
  if (conn.kind === 'sftp') sftp.forgetServer(conn.host, conn.port);
  const sites = store.allSites();
  for (const [key, s] of Object.entries(sites)) if (s && s.connection === id) store.updateSite(key, x => ({ ...x, connection: null }));
  store.dropConnection(id);
  return { ok: true, note };
}

// A push cut off hard (TOMLIN ended mid-run) leaves its temp files: the Live secrets file on its way up, the SFTP key.
// Swept when the Bridge starts; only ones older than 20 minutes, so a push running in another copy keeps its own.
function sweepTemps(maxAgeMs = 20 * 60 * 1000) {
  const dir = os.tmpdir();
  let names = []; try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!/^tomlin-(put|k|kg)-[0-9a-f]+$/.test(name)) continue;
    const p = require('path').join(dir, name);
    try { if (Date.now() - fs.statSync(p).mtimeMs < maxAgeMs) continue; fs.rmSync(p, { recursive: true, force: true }); n++; } catch {}
  }
  return n;
}

module.exports = { connectCpanel, connectFtps, startSftp, test, disconnect, transport, cleanHost, KINDS, hostKeyOf, sweepTemps };
