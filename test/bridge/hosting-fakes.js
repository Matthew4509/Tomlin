// Stand-ins for the hosting tests, all on 127.0.0.1 and inside one temp folder (nothing leaves this PC):
//   fakeCpanel  cPanel's API (UAPI /execute and API 2 /json-api) as TOMLIN uses it, over a folder that plays
//               /home/user; it also serves that account's sites, running the two PHP files TOMLIN writes the way
//               PHP would (tomlin-secrets.php prints nothing; the database loader checks its key and answers JSON)
//   ftpServer   a small plain FTP server (Windows' curl.exe talks to it; FTPS itself needs a real host)
//   fake-sftp.js  (beside this file) plays sftp.exe over a folder
// Written from cPanel's own API description (api.docs.cpanel.net, 10 Oct 2026): it proves TOMLIN's side, not a
// real cPanel's.
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- cPanel ----------
function fakeCpanel(home, opts = {}) {
  const user = opts.user || 'user', password = opts.password || 'right-password';
  const tokens = new Map(); // name -> token
  const modes = new Map(); // abs path -> mode
  const dbs = { list: [], users: new Map(), grants: [] };
  const calls = [];
  const abs = p => {
    let s = String(p || '');
    if (!s.startsWith('/')) s = '/home/' + user + '/' + s;
    if (!s.startsWith('/home/' + user)) throw new Error('outside the account');
    const rel = s.slice(('/home/' + user).length).replace(/^\/+/, '');
    const out = path.join(home, ...rel.split('/').filter(Boolean));
    if (out !== home && !out.startsWith(home + path.sep)) throw new Error('outside the account');
    return out;
  };
  fs.mkdirSync(path.join(home, 'public_html', 'other.test'), { recursive: true });
  const domains = { main_domain: { domain: 'shop.test', documentroot: '/home/' + user + '/public_html', homedir: '/home/' + user },
    addon_domains: [{ domain: 'other.test', documentroot: '/home/' + user + '/public_html/other.test', homedir: '/home/' + user }], sub_domains: [], parked_domains: [] };

  function parseMultipart(buf, boundary) {
    const parts = [];
    const sep = Buffer.from('--' + boundary);
    let i = buf.indexOf(sep);
    while (i >= 0) {
      const next = buf.indexOf(sep, i + sep.length);
      if (next < 0) break;
      const part = buf.subarray(i + sep.length + 2, next - 2);
      const he = part.indexOf('\r\n\r\n');
      const head = part.subarray(0, he).toString();
      const body = part.subarray(he + 4);
      const name = (head.match(/name="([^"]*)"/) || [])[1];
      const filename = (head.match(/filename="([^"]*)"/) || [])[1];
      parts.push({ name, filename, body });
      i = next;
    }
    return parts;
  }
  const ok = data => ({ status: 1, data, errors: null, messages: null });
  const bad = msg => ({ status: 0, data: null, errors: [msg] });

  function uapi(mod, fn, q, files) {
    calls.push(mod + '::' + fn);
    if (opts.old && mod === 'Fileman' && /^(copy_file|move_file|delete_file)$/.test(fn)) return bad('Could not find function “' + fn + '” in module “Fileman”');
    switch (mod + '::' + fn) {
      case 'Tokens::create_full_access': { const t = crypto.randomBytes(16).toString('hex').toUpperCase(); tokens.set(q.name, t); return ok({ token: t, create_time: 1 }); }
      case 'Tokens::revoke': tokens.delete(q.name); return ok(null);
      case 'DomainInfo::domains_data': return ok(domains);
      case 'Quota::get_quota_info': return ok({ megabyte_limit: opts.quotaMb || 1000, megabytes_used: 10 });
      case 'Fileman::list_files': {
        let d; try { d = abs(q.dir); } catch (e) { return bad(e.message); }
        if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return bad('Directory “' + q.dir + '” does not exist.');
        return ok(fs.readdirSync(d, { withFileTypes: true }).map(e => ({ file: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isDirectory() ? 4096 : fs.statSync(path.join(d, e.name)).size })));
      }
      case 'Fileman::upload_files': {
        const d = abs(q.dir || '');
        fs.mkdirSync(d, { recursive: true });
        const uploads = files.map(f => { const p = path.join(d, f.filename); fs.writeFileSync(p, f.body); modes.set(p, q.permissions || '0644'); return { file: f.filename, status: 1, size: f.body.length }; });
        return ok({ uploads, succeeded: uploads.length, failed: 0, diskinfo: { spaceremain: '1000000000.00' } });
      }
      case 'Fileman::copy_file': {
        const from = abs(q.source), to = abs(q.destination);
        if (fs.existsSync(to)) return bad('The destination “' + q.destination + '” already exists.');
        if (!fs.existsSync(from)) return bad('The source “' + q.source + '” does not exist.');
        fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); return ok(null);
      }
      case 'Fileman::move_file': { const from = abs(q.source), to = abs(q.destination); if (fs.existsSync(to)) return bad('exists'); fs.renameSync(from, to); return ok(null); }
      case 'Fileman::delete_file': { const p = abs(q.path); if (!fs.existsSync(p)) return bad('The path “' + q.path + '” does not exist.'); fs.rmSync(p, { recursive: true, force: true }); return ok(null); }
      case 'Mysql::get_restrictions': return ok({ prefix: user + '_', max_database_name_length: 64, max_username_length: 16 });
      case 'Mysql::list_databases': return ok(dbs.list.map(n => ({ database: n, users: [] })));
      case 'Mysql::create_database': if (!q.name.startsWith(user + '_')) return bad('The name must start with ' + user + '_'); dbs.list.push(q.name); return ok(null);
      case 'Mysql::create_user': if (dbs.users.has(q.name)) return bad('The user “' + q.name + '” already exists.'); dbs.users.set(q.name, q.password); return ok(null);
      case 'Mysql::set_password': dbs.users.set(q.user, q.password); return ok(null);
      case 'Mysql::set_privileges_on_database': dbs.grants.push(q.user + '@' + q.database); return ok(null);
      default: return bad('Could not find function “' + fn + '” in module “' + mod + '”');
    }
  }
  function api2(q) {
    calls.push('API2 ' + q.cpanel_jsonapi_module + '::' + q.cpanel_jsonapi_func + ' ' + q.op);
    try {
      if (q.op === 'copy') { const to = abs(q.destfiles); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(abs(q.sourcefiles), to, { recursive: true }); }
      else if (q.op === 'move') fs.renameSync(abs(q.sourcefiles), abs(q.destfiles));
      else if (q.op === 'unlink') { if (!fs.existsSync(abs(q.sourcefiles))) throw new Error('No such file'); fs.rmSync(abs(q.sourcefiles), { recursive: true, force: true }); }
      else throw new Error('unknown op');
      return { cpanelresult: { data: [{ result: 1 }], event: { result: 1 } } };
    } catch (e) { return { cpanelresult: { data: [{ result: 0, err: e.message }], event: { result: 1 } } }; }
  }

  const api = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      const a = String(req.headers.authorization || '');
      let authed = false;
      if (a.startsWith('Basic ')) authed = Buffer.from(a.slice(6), 'base64').toString() === user + ':' + password;
      else if (a.startsWith('cpanel ')) { const [u, t] = a.slice(7).split(':'); authed = u === user && [...tokens.values()].includes(t); }
      if (!authed) return send(401, { error: 'Access denied' });
      if (req.method !== 'POST') return send(405, {});
      const buf = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      calls.push({ path: u.pathname, query: u.search });
      const ct = String(req.headers['content-type'] || '');
      let q = {}, files = [];
      if (ct.startsWith('multipart/form-data')) {
        for (const p of parseMultipart(buf, ct.split('boundary=')[1])) { if (p.filename != null) files.push(p); else q[p.name] = p.body.toString(); }
      } else q = Object.fromEntries(new URLSearchParams(buf.toString()));
      const m = u.pathname.match(/^\/execute\/(\w+)\/(\w+)$/);
      if (m) return send(200, uapi(m[1], m[2], q, files));
      if (u.pathname === '/json-api/cpanel') return send(200, api2(q));
      send(404, {});
    });
  });

  // The account's sites as a web server with PHP would show them.
  const site = http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const host = String(req.headers['x-test-domain'] || 'shop.test');
      const root = host === 'other.test' ? path.join(home, 'public_html', 'other.test') : path.join(home, 'public_html');
      const file = path.join(root, ...decodeURIComponent(u.pathname).split('/').filter(Boolean));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      if (/\.php$/.test(file)) {
        const src = fs.readFileSync(file, 'utf8');
        if (/tomlin-import-/.test(file)) {
          if (Date.now() - fs.statSync(file).mtimeMs > 900000) { res.writeHead(404); return res.end(); }
          const hash = (src.match(/hash_equals\('([0-9a-f]{64})'/) || [])[1];
          const key = new URLSearchParams(Buffer.concat(chunks).toString()).get('key') || '';
          if (req.method !== 'POST' || crypto.createHash('sha256').update(key).digest('hex') !== hash) { res.writeHead(404); return res.end(); }
          const sqlAbs = (src.match(/\$tomlin_sql = '([^']+)'/) || [])[1];
          const sqlFile = abs(sqlAbs);
          const text = fs.existsSync(sqlFile) ? fs.readFileSync(sqlFile, 'utf8') : null;
          site.loaded = text;
          try { fs.rmSync(sqlFile, { force: true }); fs.rmSync(file, { force: true }); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(text == null ? { ok: false, error: 'the .sql file was not found on the server' } : { ok: true, statements: text.split(';').filter(s => s.trim()).length, error: null }));
        }
        res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(''); // PHP runs it; a file that only sets things prints nothing
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(file));
    });
  });
  return new Promise(r => api.listen(0, '127.0.0.1', () => site.listen(0, '127.0.0.1', () => r({
    port: api.address().port, sitePort: site.address().port, site, tokens, modes, dbs, calls, abs,
    close: () => Promise.all([new Promise(c => api.close(c)), new Promise(c => site.close(c))]),
  }))));
}

// ---------- a small plain FTP server ----------
function ftpServer(root, opts = {}) {
  const user = opts.user || 'ftpuser', password = opts.password || 'ftp-pass';
  const log = [];
  const srv = net.createServer(sock => {
    let cwd = '/', authed = false, who = '', pasv = null, rnfr = null;
    const reply = (code, text) => sock.write(code + ' ' + text + '\r\n');
    const resolve = p => {
      const s = String(p || '').startsWith('/') ? p : path.posix.join(cwd, p || '');
      const norm = path.posix.normalize('/' + s);
      return { v: norm, abs: path.join(root, ...norm.split('/').filter(Boolean)) };
    };
    const withData = fn => {
      if (!pasv) return reply(425, 'Use PASV first');
      const p = pasv; pasv = null;
      p.ready.then(d => fn(d));
    };
    reply(220, 'Test FTP');
    let buf = '';
    sock.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const sp = line.indexOf(' ');
        const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase(), arg = sp < 0 ? '' : line.slice(sp + 1);
        log.push(cmd === 'PASS' ? 'PASS ***' : line);
        if (cmd === 'USER') { who = arg; reply(331, 'Password please'); continue; }
        if (cmd === 'PASS') { authed = who === user && arg === password; reply(authed ? 230 : 530, authed ? 'Logged in' : 'Login incorrect'); continue; }
        if (cmd === 'QUIT') { reply(221, 'Bye'); sock.end(); continue; }
        if (cmd === 'AUTH') { reply(502, 'No TLS here'); continue; }
        if (!authed) { reply(530, 'Not logged in'); continue; }
        if (cmd === 'PWD') reply(257, '"' + cwd + '"');
        else if (cmd === 'CWD') { const r = resolve(arg); if (fs.existsSync(r.abs) && fs.statSync(r.abs).isDirectory()) { cwd = r.v; reply(250, 'OK'); } else reply(550, 'No such directory'); }
        else if (cmd === 'CDUP') { cwd = path.posix.dirname(cwd); reply(250, 'OK'); }
        else if (cmd === 'TYPE' || cmd === 'NOOP' || cmd === 'OPTS') reply(200, 'OK');
        else if (cmd === 'SYST') reply(215, 'UNIX Type: L8');
        else if (cmd === 'FEAT') { sock.write('211-Features\r\n MLSD\r\n SIZE\r\n EPSV\r\n211 End\r\n'); }
        else if (cmd === 'EPSV' || cmd === 'PASV') {
          const ds = net.createServer();
          let resolveSock; const ready = new Promise(r => { resolveSock = r; });
          ds.on('connection', c => { resolveSock(c); ds.close(); });
          ds.listen(0, '127.0.0.1', () => {
            const port = ds.address().port;
            pasv = { ready };
            if (cmd === 'EPSV') reply(229, 'Entering Extended Passive Mode (|||' + port + '|)');
            else reply(227, 'Entering Passive Mode (127,0,0,1,' + (port >> 8) + ',' + (port & 255) + ')');
          });
        }
        else if (cmd === 'SIZE') { const r = resolve(arg); if (fs.existsSync(r.abs) && fs.statSync(r.abs).isFile()) reply(213, String(fs.statSync(r.abs).size)); else reply(550, 'No such file'); }
        else if (cmd === 'MDTM') reply(550, 'Not here');
        else if (cmd === 'MKD') { const r = resolve(arg); try { fs.mkdirSync(r.abs); reply(257, '"' + r.v + '" made'); } catch { reply(550, 'Cannot make it'); } }
        else if (cmd === 'DELE') { const r = resolve(arg); if (fs.existsSync(r.abs) && fs.statSync(r.abs).isFile()) { fs.rmSync(r.abs); reply(250, 'Deleted'); } else reply(550, 'No such file'); }
        else if (cmd === 'RNFR') { rnfr = resolve(arg); reply(fs.existsSync(rnfr.abs) ? 350 : 550, 'Ready'); }
        else if (cmd === 'RNTO') { const r = resolve(arg); try { fs.renameSync(rnfr.abs, r.abs); reply(250, 'Renamed'); } catch { reply(550, 'Cannot rename'); } }
        else if (cmd === 'SITE') { const m = arg.match(/^CHMOD\s+(\d+)\s+(.+)$/i); if (m && fs.existsSync(resolve(m[2]).abs)) { (srv.modes = srv.modes || new Map()).set(resolve(m[2]).v, m[1]); reply(200, 'Mode set'); } else reply(550, 'No'); }
        else if (cmd === 'MLSD' || cmd === 'LIST' || cmd === 'NLST') {
          const r = resolve(arg && !arg.startsWith('-') ? arg : '');
          if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isDirectory()) { reply(550, 'No such directory'); continue; }
          withData(d => {
            reply(150, 'Here it comes');
            const ents = fs.readdirSync(r.abs, { withFileTypes: true });
            const lines = ents.map(e => {
              const size = e.isDirectory() ? 0 : fs.statSync(path.join(r.abs, e.name)).size;
              if (cmd === 'MLSD') return 'type=' + (e.isDirectory() ? 'dir' : 'file') + ';size=' + size + '; ' + e.name;
              if (cmd === 'NLST') return e.name;
              return (e.isDirectory() ? 'd' : '-') + 'rw-r--r-- 1 u g ' + size + ' Oct 10 01:00 ' + e.name;
            });
            if (cmd === 'MLSD') lines.unshift('type=cdir;size=0; .');
            d.end(lines.map(l => l + '\r\n').join(''), () => reply(226, 'Done'));
          });
        }
        else if (cmd === 'STOR') {
          const r = resolve(arg);
          if (!fs.existsSync(path.dirname(r.abs))) { reply(553, 'No such directory'); continue; }
          withData(d => { reply(150, 'Send it'); const w = fs.createWriteStream(r.abs); d.pipe(w); w.on('finish', () => reply(226, 'Stored')); });
        }
        else if (cmd === 'RETR') {
          const r = resolve(arg);
          if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isFile()) { reply(550, 'No such file'); continue; }
          withData(d => { reply(150, 'Here it comes'); fs.createReadStream(r.abs).pipe(d).on('finish', () => reply(226, 'Sent')); });
        }
        else reply(502, 'Not here');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ port: srv.address().port, log, srv, close: () => new Promise(c => srv.close(c)) })));
}

module.exports = { fakeCpanel, ftpServer };
