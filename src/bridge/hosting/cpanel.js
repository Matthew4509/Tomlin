// cPanel: its own API (UAPI) over HTTPS on port 2083, with an API token ("Authorization: cpanel <user>:<token>").
// Connecting with a password uses it ONCE, to make that token (Tokens::create_full_access); the password is then
// dropped. Every call is a POST with its fields in the body, never in the address, so no value lands in the
// server's access log. Names and fields are cPanel's own (api.docs.cpanel.net, checked 10 Oct 2026).
// Copy, move and delete came to UAPI late (Fileman::copy_file, move_file, delete_file); an older cPanel answers
// "unknown function", and then the long-standing API 2 Fileman::fileop does the same job.
'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TIMEOUT = 60000;
const posix = path.posix;
const TEST = () => process.env.BRIDGE_TEST_HOSTING === '1';

function plainError(e, host) {
  const c = e && e.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return host + ' was not found. Check the server name: it is in your hosting welcome email, or in cPanel under General Information.';
  if (c === 'ECONNREFUSED') return host + ' refused the connection on the cPanel port. Check the server name and port (2083 is cPanel\'s own).';
  if (c === 'ETIMEDOUT' || c === 'TIMEOUT' || c === 'ECONNRESET') return host + ' did not answer in time. Your internet, or the host\'s firewall (too many tries can block your address for a while), may be the cause: try again in a few minutes.';
  if (c === 'ERR_TLS_CERT_ALTNAME_INVALID' || c === 'DEPTH_ZERO_SELF_SIGNED_CERT' || c === 'SELF_SIGNED_CERT_IN_CHAIN' || c === 'CERT_HAS_EXPIRED' || c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    return 'The secure certificate on ' + host + ' does not prove it is your host (' + c + '), so nothing was sent. Connect with the server\'s own name instead (cPanel, General Information, "Server Name" or the name in your welcome email, like server123.yourhost.com).';
  return 'Could not reach ' + host + ': ' + ((e && e.message) || e) + '.';
}

class CpanelError extends Error {}

/** c: { host, port, user, token } or { host, port, user, password } (the password only to make a token). */
function client(c) {
  const port = Number(c.port) || 2083;
  const lib = TEST() && c.scheme === 'http' ? http : https;
  const auth = c.token ? 'cpanel ' + c.user + ':' + c.token : 'Basic ' + Buffer.from(c.user + ':' + c.password).toString('base64');

  function send(pathname, body, headers) {
    return new Promise((resolve, reject) => {
      const req = lib.request({ host: c.host, port, path: pathname, method: 'POST', timeout: TIMEOUT,
        headers: { Authorization: auth, 'User-Agent': 'TOMLIN push live', Accept: 'application/json', 'Content-Length': body.length, ...headers } }, res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 401 || res.statusCode === 403) return reject(new CpanelError(c.token
            ? 'cPanel refused TOMLIN\'s token (' + res.statusCode + '): it was deleted or has expired in cPanel (Security, Manage API Tokens). Connect again.'
            : 'cPanel refused that user name and password (' + res.statusCode + '). Check them; an account with two-step sign-in needs a token made in cPanel instead (Security, Manage API Tokens) and pasted here.'));
          let j = null; try { j = JSON.parse(text); } catch {}
          if (!j) return reject(new CpanelError('cPanel gave an answer TOMLIN cannot read (status ' + res.statusCode + ')' + (/<html/i.test(text) ? ': a web page, not its API. Check the server name and port.' : '.')));
          resolve(j);
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
      req.on('error', e => reject(new CpanelError(plainError(e, c.host))));
      req.end(body);
    });
  }

  // UAPI: { status, data, errors } (the answer can also come wrapped in "result").
  async function uapi(mod, fn, params = {}) {
    const body = Buffer.from(new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString());
    const j = await send('/execute/' + mod + '/' + fn, body, { 'Content-Type': 'application/x-www-form-urlencoded' });
    const r = j.result && typeof j.result === 'object' && 'status' in j.result ? j.result : j;
    if (!r.status) {
      const errs = (Array.isArray(r.errors) ? r.errors : [r.errors || r.error]).filter(Boolean).join(' ');
      throw Object.assign(new CpanelError('cPanel said: ' + (errs || 'it could not do ' + mod + '::' + fn + '.')), { answered: true, unknownFn: /could not find (?:the )?function|unknown (?:function|module|method)|failed to load (?:the )?module|no such (?:function|module)|not a valid (?:function|module)/i.test(errs) });
    }
    return r.data;
  }
  // API 2 (older cPanel): { cpanelresult: { data: [...], error, event: { result } } }
  async function api2(mod, fn, params = {}) {
    const q = new URLSearchParams({ cpanel_jsonapi_user: c.user, cpanel_jsonapi_apiversion: '2', cpanel_jsonapi_module: mod, cpanel_jsonapi_func: fn, ...params });
    const j = await send('/json-api/cpanel', Buffer.from(q.toString()), { 'Content-Type': 'application/x-www-form-urlencoded' });
    const r = j.cpanelresult || {};
    const first = Array.isArray(r.data) ? r.data[0] : null;
    if (r.error || (r.event && !r.event.result) || (first && first.result === 0)) throw new CpanelError('cPanel said: ' + (r.error || (first && first.err) || 'it could not do ' + fn + '.'));
    return r.data;
  }
  async function fileop(uapiFn, params, op, source, dest) {
    try { return await uapi('Fileman', uapiFn, params); }
    catch (e) {
      if (!e.unknownFn) throw e;
      const p = { op, sourcefiles: source, doubledecode: '0' };
      if (dest) p.destfiles = dest;
      return api2('Fileman', 'fileop', p);
    }
  }

  // multipart/form-data with the files as parts named file-0, file-1... (cPanel names each after its filename).
  async function uploadInto(dir, files, permissions) {
    const boundary = '----tomlin' + crypto.randomBytes(12).toString('hex');
    const parts = [];
    const field = (name, value) => parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
    field('dir', dir); field('overwrite', '1'); field('get_disk_info', '1');
    if (permissions) field('permissions', permissions);
    files.forEach((f, i) => {
      const name = String(f.name).replace(/["\r\n]/g, '_');
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file-' + i + '"; filename="' + name + '"\r\nContent-Type: application/octet-stream\r\n\r\n'));
      parts.push(f.data);
      parts.push(Buffer.from('\r\n'));
    });
    parts.push(Buffer.from('--' + boundary + '--\r\n'));
    const j = await send('/execute/Fileman/upload_files', Buffer.concat(parts), { 'Content-Type': 'multipart/form-data; boundary=' + boundary });
    const r = j.result && 'status' in j.result ? j.result : j;
    const ups = r.data && Array.isArray(r.data.uploads) ? r.data.uploads : [];
    const bad = ups.filter(u => !u.status);
    if (!r.status || bad.length) throw new CpanelError('cPanel did not take ' + (bad.length ? bad.map(u => u.file + (u.reason ? ' (' + u.reason + ')' : '')).join(', ') : 'the upload') + (r.errors ? ': ' + [].concat(r.errors).join(' ') : '') + '.');
    return r.data && r.data.diskinfo || null;
  }

  return {
    uapi,
    /** Makes a full-access token from the password (used once): returns { token, name }. */
    async makeToken(name) {
      const d = await uapi('Tokens', 'create_full_access', { name });
      if (!d || !d.token) throw new CpanelError('cPanel made no token. Make one in cPanel (Security, Manage API Tokens) and paste it here.');
      return { token: d.token, name };
    },
    revokeToken: name => uapi('Tokens', 'revoke', { name }),
    /** The account's sites: [{ domain, root, home, kind }] (main, addon and sub domains). */
    async domains() {
      const d = await uapi('DomainInfo', 'domains_data', { format: 'hash', hide_temporary_domains: 1 });
      const out = [];
      const add = (x, kind) => { if (x && x.domain && x.documentroot) out.push({ domain: String(x.domain).toLowerCase(), root: String(x.documentroot), home: String(x.homedir || ''), kind }); };
      add(d && d.main_domain, 'main');
      for (const x of (d && d.addon_domains) || []) add(x, 'addon');
      for (const x of (d && d.sub_domains) || []) add(x, 'sub');
      const seen = new Set();
      return out.filter(x => !seen.has(x.domain) && seen.add(x.domain));
    },
    /** Free space in bytes, or null when the account has no limit. */
    async freeBytes() {
      const d = await uapi('Quota', 'get_quota_info');
      const limit = Number(d && d.megabyte_limit), used = Number(d && d.megabytes_used);
      if (!limit) return null;
      return Math.max(0, (limit - (Number.isFinite(used) ? used : 0)) * 1024 * 1024);
    },
    /** [{ name, type: 'file'|'dir', size }] or null when the folder is not there. */
    async listDir(dir) {
      let d;
      try { d = await uapi('Fileman', 'list_files', { dir, show_hidden: 1, include_mime: 0 }); }
      // cPanel answered and could not list it: the folder is not there (or not a folder). A connection or token
      // fault never gets here as "answered", so it still stops the push.
      catch (e) { if (e.answered) return null; throw e; }
      const rows = Array.isArray(d) ? d : [...((d && d.dirs) || []), ...((d && d.files) || [])];
      return rows.map(x => ({ name: x.file, type: x.type === 'dir' ? 'dir' : 'file', size: Number(x.size) || 0 }));
    },
    /** items: [{ local, remote }] (absolute remote paths). Files are sent a folder at a time, up to 20 MB a request. */
    async upload(items, progress) {
      const byDir = new Map();
      for (const it of items) { const d = posix.dirname(it.remote); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(it); }
      let done = 0, info = null;
      for (const [dir, list] of byDir) {
        let batch = [], size = 0;
        const flush = async () => { if (!batch.length) return; info = await uploadInto(dir, batch); done += batch.length; if (progress) progress(done); batch = []; size = 0; };
        for (const it of list) {
          const data = fs.readFileSync(it.local);
          if (batch.length && (size + data.length > 20 * 1024 * 1024 || batch.length >= 100)) await flush();
          batch.push({ name: posix.basename(it.remote), data }); size += data.length;
        }
        await flush();
      }
      return info;
    },
    /** One file written from text with the given permissions (the secrets file: 0600). */
    putText: (remote, text, mode) => uploadInto(posix.dirname(remote), [{ name: posix.basename(remote), data: Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8') }], mode || '0644'),
    copy: (from, to) => fileop('copy_file', { source: from, destination: to }, 'copy', from, to),
    move: (from, to) => fileop('move_file', { source: from, destination: to }, 'move', from, to),
    remove: p => fileop('delete_file', { path: p }, 'unlink', p),
    // Databases
    dbRestrictions: () => uapi('Mysql', 'get_restrictions'),
    dbList: () => uapi('Mysql', 'list_databases'),
    dbCreate: name => uapi('Mysql', 'create_database', { name }),
    dbUser: (name, password) => uapi('Mysql', 'create_user', { name, password }),
    dbGrant: (user, database) => uapi('Mysql', 'set_privileges_on_database', { user, database, privileges: 'ALL PRIVILEGES' }),
  };
}

module.exports = { client, plainError, CpanelError };
