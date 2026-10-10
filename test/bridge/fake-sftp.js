// Plays Windows' sftp.exe for the hosting tests (a test PC has no SSH server): the same arguments, a batch file of
// commands, run against the folder in FAKE_SFTP_ROOT. It checks what the real one would refuse: no key file, a key
// file others can read is not checked here (icacls is), an unknown key (FAKE_SFTP_KEY = the public key it accepts).
// It echoes each command as "sftp> ..." the way sftp -b does, and stops at the first failing command unless the
// command starts with "-".
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const batch = opt('-b'), key = opt('-i');
// As OpenSSH reads it: a quoted value is one path; an unquoted one is split at spaces into several files (the first
// is where a new server key is written).
const knownRaw = (args.find((a, i) => args[i - 1] === '-o' && a.startsWith('UserKnownHostsFile=')) || '').slice('UserKnownHostsFile='.length);
const known = /^".*"$/.test(knownRaw) ? knownRaw.slice(1, -1) : knownRaw.split(' ')[0];
const target = args[args.length - 1];
const root = process.env.FAKE_SFTP_ROOT;
const log = process.env.FAKE_SFTP_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args: args.map(a => (a === key ? '<key file>' : a)) }) + '\n');

if (!key || !fs.existsSync(key)) { process.stderr.write('Warning: Identity file not accessible: No such file or directory.\nuser@host: Permission denied (publickey).\r\n'); process.exit(255); }
const keyText = fs.readFileSync(key, 'utf8');
if (process.env.FAKE_SFTP_DENY === '1' || !/BEGIN OPENSSH PRIVATE KEY/.test(keyText)) { process.stderr.write(target + ': Permission denied (publickey).\r\n'); process.exit(255); }
if (known) {
  const port = opt('-P') || '22';
  const host = port === '22' ? target.split('@')[1] : '[' + target.split('@')[1] + ']:' + port;
  const lines = fs.existsSync(known) ? fs.readFileSync(known, 'utf8') : '';
  const want = process.env.FAKE_SFTP_HOSTKEY || 'AAAAC3NzaC1lZDI1NTE5AAAAIHRlc3Qta2V5LW9mLXRoZS1mYWtlLXNlcnZlcg==';
  const line = lines.split(/\r?\n/).find(l => l.split(' ')[0] === host);
  if (line && line.split(' ')[2] !== want) { process.stderr.write('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\r\n'); process.exit(255); }
  if (!line) fs.appendFileSync(known, host + ' ssh-ed25519 ' + want + '\n');
}
const abs = p => { const r = path.join(root, ...String(p).replace(/^"|"$/g, '').split('/').filter(Boolean)); if (!r.startsWith(root)) throw new Error('outside'); return r; };
const words = l => (l.match(/"(?:[^"\\]|\\.)*"|\S+/g) || []).map(w => w.startsWith('"') ? w.slice(1, -1).replace(/\\"/g, '"') : w);
let out = '';
for (const raw of fs.readFileSync(batch, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const soft = raw.startsWith('-');
  const [cmd, ...a] = words(soft ? raw.slice(1) : raw);
  out += 'sftp> ' + raw + '\n';
  try {
    if (cmd === 'pwd') out += 'Remote working directory: /home/user\n';
    else if (cmd === 'mkdir') fs.mkdirSync(abs(a[0]));
    else if (cmd === 'put') { if (!fs.existsSync(path.dirname(abs(a[1])))) throw new Error('No such file or directory'); fs.copyFileSync(a[0], abs(a[1])); }
    else if (cmd === 'get') fs.copyFileSync(abs(a[0]), a[1]);
    else if (cmd === 'rm') { if (!fs.existsSync(abs(a[0]))) throw new Error('No such file'); fs.rmSync(abs(a[0])); }
    else if (cmd === 'rename') fs.renameSync(abs(a[0]), abs(a[1]));
    else if (cmd === 'chmod') { if (log) fs.appendFileSync(log, JSON.stringify({ chmod: a[0], path: a[1] }) + '\n'); }
    else if (cmd === 'ls') {
      const d = abs(a[a.length - 1] === '-la' ? '.' : a[a.length - 1]);
      if (!fs.existsSync(d)) { process.stderr.write('Can\'t ls: "/home/user/' + a[a.length - 1] + '" not found\r\n'); if (!soft) process.exit(1); continue; }
      for (const e of fs.readdirSync(d, { withFileTypes: true })) out += (e.isDirectory() ? 'd' : '-') + 'rw-r--r--    1 user     user     ' + (e.isDirectory() ? 4096 : fs.statSync(path.join(d, e.name)).size) + ' Oct 10 01:00 ' + e.name + '\n';
    } else throw new Error('Invalid command.');
  } catch (e) {
    process.stderr.write((cmd === 'mkdir' ? 'remote mkdir "' + a[0] + '": Failure' : e.message) + '\r\n');
    if (!soft) { process.stdout.write(out); process.exit(1); }
  }
}
process.stdout.write(out);
