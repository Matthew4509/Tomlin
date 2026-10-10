// FTPS (FTP with TLS) through Windows' own curl.exe (C:\Windows\System32, in Windows 10 and 11; nothing downloaded).
// The user name and password reach curl through its standard input, never on the command line, where other programs
// on this PC could read them. Explicit FTPS ("AUTH TLS" on port 21) is the default; implicit FTPS (port 990) too.
// Plain FTP is not offered: it sends the password and every file unprotected. (The tests use a plain FTP server on
// 127.0.0.1, allowed only when BRIDGE_TEST_HOSTING=1.)
// Remote paths are relative to the folder the FTP account opens in (its "login folder"), like public_html/index.php.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const posix = path.posix;
const TEST = () => process.env.BRIDGE_TEST_HOSTING === '1';

function curlExe() {
  if (TEST() && process.env.BRIDGE_TEST_CURL) return process.env.BRIDGE_TEST_CURL;
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
}
const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const enc = p => String(p).split('/').map(encodeURIComponent).join('/');

const CURL_WHY = {
  6: 'the server name was not found. Check it (your hosting welcome email has it).',
  7: 'the server refused the connection. Check the server name and port (21 for FTPS, 990 for implicit FTPS).',
  9: 'the server would not open that folder (it is not there, or this account cannot reach it).',
  28: 'the server did not answer in time. Try again in a few minutes (a host\'s firewall can block an address for a while after many tries).',
  35: 'the secure connection could not be set up. The server may not offer FTPS on that port.',
  60: 'the server\'s certificate does not prove it is your host, so nothing was sent. Use the server\'s own name (in your hosting welcome email, like server123.yourhost.com) instead of your domain.',
  64: 'the server does not offer a secure connection (FTPS). Ask your host to turn it on, or use SFTP.',
  67: 'the server refused that user name and password. Check them in your hosting panel (FTP Accounts).',
  25: 'the server refused the upload (the folder is read-only, or the account is out of space).',
  78: 'the file is not on the server.',
};
class FtpError extends Error {}

/** c: { host, port, user, password, implicit, plain (tests only) } */
function client(c) {
  if (c.plain && !TEST()) throw new FtpError('Plain FTP sends your password unprotected, so TOMLIN does not use it. Use FTPS or SFTP.');
  const scheme = c.implicit ? 'ftps' : 'ftp';
  const port = Number(c.port) || (c.implicit ? 990 : 21);
  const base = scheme + '://' + c.host + ':' + port + '/';

  // One curl run. lines: curl config lines (after the login lines). Returns { out (Buffer), err }.
  function run(lines, { allow = [] } = {}) {
    return new Promise((resolve, reject) => {
      const conf = ['user = ' + q(c.user + ':' + c.password), 'silent', 'show-error', 'connect-timeout = 20', 'max-time = 600',
        'ftp-pasv', ...(c.plain ? [] : c.implicit ? [] : ['ssl-reqd']), ...lines].join('\n') + '\n';
      const p = spawn(curlExe(), ['-K', '-'], { windowsHide: true });
      const out = [], err = [];
      p.stdout.on('data', d => out.push(d));
      p.stderr.on('data', d => err.push(d));
      p.on('error', e => reject(new FtpError('Windows\' curl.exe could not be started (' + e.code + '). It comes with Windows 10 and 11.')));
      p.on('close', code => {
        const text = Buffer.concat(err).toString('utf8').trim();
        if (code === 0 || allow.includes(code)) return resolve({ out: Buffer.concat(out), code, err: text });
        reject(Object.assign(new FtpError('FTPS: ' + (CURL_WHY[code] || 'curl stopped with code ' + code + (text ? ' (' + text.replace(/^curl: \(\d+\)\s*/, '') + ')' : '') + '.')), { code }));
      });
      p.stdin.end(conf);
    });
  }
  const quote = cmds => run(['url = ' + q(base), 'list-only', ...cmds.map(x => 'quote = ' + q(x)), 'output = "NUL"']);

  const api = {
    kind: 'ftps',
    describe: () => (c.implicit ? 'FTPS (implicit) ' : 'FTPS ') + c.user + '@' + c.host,
    async test() { await run(['url = ' + q(base), 'list-only', 'output = "NUL"']); return true; },
    /** [{ name, type, size }] or null when the folder is not there. */
    async listDir(dir) {
      const url = base + (dir ? enc(dir.replace(/^\/+|\/+$/g, '')) + '/' : '');
      let r;
      try { r = await run(['url = ' + q(url), 'request = "MLSD"']); }
      catch (e) {
        if (e.code === 9 || e.code === 78) return null;
        // No MLSD on this server: the plain LIST, read the way ls -l writes it.
        try { r = await run(['url = ' + q(url)]); } catch (e2) { if (e2.code === 9 || e2.code === 78) return null; throw e2; }
        return r.out.toString('utf8').split(/\r?\n/).filter(Boolean).map(l => {
          const m = l.match(/^([dl-])\S*\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
          return m ? { name: m[3].replace(/ -> .*$/, ''), type: m[1] === 'd' ? 'dir' : 'file', size: Number(m[2]) } : null;
        }).filter(x => x && x.name !== '.' && x.name !== '..');
      }
      return r.out.toString('utf8').split(/\r?\n/).filter(Boolean).map(l => {
        const sp = l.indexOf(' ');
        const facts = Object.fromEntries(l.slice(0, sp).split(';').filter(Boolean).map(f => { const i = f.indexOf('='); return [f.slice(0, i).toLowerCase(), f.slice(i + 1)]; }));
        return { name: l.slice(sp + 1), type: /dir/i.test(facts.type) ? 'dir' : 'file', size: Number(facts.size) || 0, kind: facts.type };
      }).filter(x => x.kind && !/^(cdir|pdir)$/i.test(x.kind)).map(({ kind, ...x }) => x);
    },
    /** items: [{ local, remote }], up to 200 files per curl run (one connection each run). */
    async upload(items, progress) {
      let done = 0;
      for (let i = 0; i < items.length; i += 200) {
        const part = items.slice(i, i + 200);
        await run(['ftp-create-dirs', ...part.flatMap(it => ['upload-file = ' + q(it.local.replace(/\\/g, '/')), 'url = ' + q(base + enc(it.remote))])]);
        done += part.length; if (progress) progress(done);
      }
    },
    async download(remote, local) {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      await run(['url = ' + q(base + enc(remote)), 'output = ' + q(local.replace(/\\/g, '/'))]);
    },
    /** A file from text (the secrets file): written to a private temp file, sent, removed; then made owner-only. */
    async putText(remote, text, mode) {
      const tmp = path.join(os.tmpdir(), 'tomlin-put-' + crypto.randomBytes(8).toString('hex'));
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      try { await api.upload([{ local: tmp, remote }]); }
      finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
      if (mode) {
        try { await quote(['SITE CHMOD ' + mode.replace(/^0(?=\d{3})/, '') + ' ' + remote]); }
        catch { return { chmod: false }; }
      }
      return { chmod: true };
    },
    remove: p => quote(['DELE ' + p]),
    move: (from, to) => quote(['RNFR ' + from, 'RNTO ' + to]),
    freeBytes: async () => null,
  };
  return api;
}

module.exports = { client, FtpError, CURL_WHY };
