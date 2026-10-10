// SFTP through Windows' own OpenSSH (C:\Windows\System32\OpenSSH\sftp.exe and ssh-keygen.exe; nothing downloaded).
// It signs in with a key TOMLIN makes for the connection, never a password: the public half is added once in the
// host's panel (cPanel: SSH Access, Manage SSH Keys, Import, then Authorize). The private half is kept sealed by
// Windows (vault.js) and written to a file only for the length of one sftp run, readable by this Windows account
// alone, then deleted.
// The server's own key is remembered on the first connection (TOMLIN's own known_hosts file, never the person's);
// if it ever changes, nothing is sent and the screen says so.
// Remote paths are relative to the folder the account opens in (its home), like public_html/index.php.
'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');

const posix = path.posix;
const TEST = () => process.env.BRIDGE_TEST_HOSTING === '1';
const SSH_DIR = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH');
const exe = name => (TEST() && process.env['BRIDGE_TEST_' + name.toUpperCase().replace('-', '_')]) || path.join(SSH_DIR(), name + '.exe');
const KNOWN = () => path.join(cfg.DATA, 'hosting', 'known_hosts');
const bq = s => '"' + String(s).replace(/\\/g, '/').replace(/"/g, '\\"') + '"';

class SftpError extends Error {}

function privateTemp(text) {
  const dir = path.join(os.tmpdir(), 'tomlin-k-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, 'id');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { dir, file };
}
// OpenSSH on Windows refuses a key file other accounts could read: this account only.
function lockDown(file) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve();
    const user = (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + os.userInfo().username;
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [file, '/inheritance:r', '/grant:r', user + ':F'], { windowsHide: true }, () => resolve());
  });
}

/** A new key pair: { privateKey, publicKey } (ed25519, comment "TOMLIN"). */
function makeKey() {
  return new Promise((resolve, reject) => {
    const dir = path.join(os.tmpdir(), 'tomlin-kg-' + crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { mode: 0o700 });
    const f = path.join(dir, 'id');
    execFile(exe('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-C', 'TOMLIN', '-f', f], { windowsHide: true, timeout: 30000 }, err => {
      try {
        if (err) return reject(new SftpError('Windows\' ssh-keygen could not make a key (' + (err.code || err.message) + '). OpenSSH Client comes with Windows 10 and 11 (Settings, Apps, Optional features).'));
        resolve({ privateKey: fs.readFileSync(f, 'utf8'), publicKey: fs.readFileSync(f + '.pub', 'utf8').trim() });
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    });
  });
}

function why(text) {
  if (/Permission denied \(publickey/i.test(text)) return 'the server did not accept TOMLIN\'s key. Add the public key in your host\'s panel (cPanel: SSH Access, Manage SSH Keys, Import Key, then Authorize), and check SSH or SFTP is switched on for the account.';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) return 'the server\'s own key is not the one TOMLIN saw before, so nothing was sent. If your host moved the site to a new server, Forget server key and connect again; if not, ask your host before going on.';
  if (/Could not resolve hostname/i.test(text)) return 'the server name was not found. Check it (your hosting welcome email has it).';
  if (/Connection refused/i.test(text)) return 'the server refused the connection. Check the port (22 is usual; some hosts use another, like 2222).';
  if (/timed out/i.test(text)) return 'the server did not answer in time. Try again in a few minutes.';
  if (/No such file|not found/i.test(text)) return 'a file or folder was not there.';
  if (/Permission denied/i.test(text)) return 'the server refused: the account cannot write there.';
  const last = text.split(/\r?\n/).filter(l => l.trim() && !/^sftp>/.test(l)).pop();
  return last ? last.trim() : 'sftp stopped without saying why.';
}

/** c: { host, port, user, privateKey } */
function client(c) {
  const port = Number(c.port) || 22;
  // One sftp run with a list of commands; a command starting with "-" may fail without stopping the rest.
  async function run(cmds, { allowFail = false } = {}) {
    const k = privateTemp(c.privateKey);
    const batch = path.join(k.dir, 'cmds');
    fs.writeFileSync(batch, cmds.join('\n') + '\n');
    await lockDown(k.file);
    fs.mkdirSync(path.dirname(KNOWN()), { recursive: true });
    try {
      return await new Promise((resolve, reject) => {
        const args = ['-b', batch, '-i', k.file, '-P', String(port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=20',
          '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile="' + KNOWN().replace(/\\/g, '/') + '"', '-o', 'GlobalKnownHostsFile=NUL', c.user + '@' + c.host];
        // The tests stand in a script for sftp.exe (there is no SSH server on a test PC): run it with this Node.
        const prog = exe('sftp');
        const p = TEST() && prog.endsWith('.js') ? spawn(process.execPath, [prog, ...args], { windowsHide: true }) : spawn(prog, args, { windowsHide: true });
        const out = [], err = [];
        p.stdout.on('data', d => out.push(d));
        p.stderr.on('data', d => err.push(d));
        const timer = setTimeout(() => { try { p.kill(); } catch {} }, 15 * 60 * 1000);
        p.on('error', e => { clearTimeout(timer); reject(new SftpError('Windows\' sftp.exe could not be started (' + e.code + '). OpenSSH Client comes with Windows 10 and 11 (Settings, Apps, Optional features).')); });
        p.on('close', code => {
          clearTimeout(timer);
          const o = Buffer.concat(out).toString('utf8'), e = Buffer.concat(err).toString('utf8');
          if (code === 0 || allowFail) return resolve({ out: o, err: e, code });
          reject(new SftpError('SFTP: ' + why(e + '\n' + o)));
        });
      });
    } finally { try { fs.rmSync(k.dir, { recursive: true, force: true }); } catch {} }
  }
  const mkdirs = dirs => {
    const all = new Set();
    for (const d of dirs) { const parts = d.split('/').filter(Boolean); for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join('/')); }
    return [...all].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).map(d => '-mkdir ' + bq(d));
  };
  const api = {
    kind: 'sftp',
    describe: () => 'SFTP ' + c.user + '@' + c.host,
    async test() { await run(['pwd']); return true; },
    async listDir(dir) {
      const r = await run(['-ls -la ' + bq(dir || '.')], { allowFail: true });
      if (/not found|No such file|Can't ls/i.test(r.err)) return null;
      if (r.code !== 0 && !r.out.trim()) throw new SftpError('SFTP: ' + why(r.err));
      return r.out.split(/\r?\n/).filter(l => l && !/^sftp>/.test(l)).map(l => {
        const m = l.match(/^([dl-])\S*\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
        if (!m) return null;
        const name = posix.basename(m[3].replace(/ -> .*$/, ''));
        return { name, type: m[1] === 'd' ? 'dir' : 'file', size: Number(m[2]) };
      }).filter(x => x && x.name !== '.' && x.name !== '..');
    },
    async upload(items, progress) {
      let done = 0;
      for (let i = 0; i < items.length; i += 300) {
        const part = items.slice(i, i + 300);
        await run([...mkdirs([...new Set(part.map(it => posix.dirname(it.remote)).filter(d => d && d !== '.'))]), ...part.map(it => 'put ' + bq(it.local) + ' ' + bq(it.remote))]);
        done += part.length; if (progress) progress(done);
      }
    },
    async download(remote, local) {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      await run(['get ' + bq(remote) + ' ' + bq(local)]);
    },
    async putText(remote, text, mode) {
      const dir = path.join(os.tmpdir(), 'tomlin-put-' + crypto.randomBytes(8).toString('hex'));
      fs.mkdirSync(dir, { mode: 0o700 });
      const tmp = path.join(dir, 'f');
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      try {
        await run([...mkdirs([posix.dirname(remote)].filter(d => d && d !== '.')), 'put ' + bq(tmp) + ' ' + bq(remote), ...(mode ? ['chmod ' + mode.replace(/^0(?=\d{3})/, '') + ' ' + bq(remote)] : [])]);
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
      return { chmod: !!mode };
    },
    remove: p => run(['rm ' + bq(p)]),
    move: (from, to) => run(['rename ' + bq(from) + ' ' + bq(to)]),
    freeBytes: async () => null,
  };
  return api;
}

/** Forget the remembered key of one server (after the host moved the site). */
function forgetServer(host, port) {
  try {
    const lines = fs.readFileSync(KNOWN(), 'utf8').split(/\r?\n/);
    const tag = Number(port) && Number(port) !== 22 ? '[' + host + ']:' + port : host;
    fs.writeFileSync(KNOWN(), lines.filter(l => !l.split(' ')[0].split(',').includes(tag)).join('\n'));
  } catch {}
}

module.exports = { client, makeKey, forgetServer, SftpError };
