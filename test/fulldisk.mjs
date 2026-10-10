// For test/diskfull.test.ts: loaded into the server before it starts (node --import). While the file
// <TOMLIN_HOME>/.disk-full is there, every write to a file inside TOMLIN_HOME fails the way a full disk fails it
// (ENOSPC), through each way Node writes a file (whole files, appends, copies, and streams such as the log). Taking
// the file away gives the space back. Reads, and anything outside TOMLIN_HOME, are untouched.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';

const HOME = resolve(process.env.TOMLIN_HOME || '.').toLowerCase();
const FLAG = join(process.env.TOMLIN_HOME || '.', '.disk-full');
const real = { existsSync: fs.existsSync };
const full = () => real.existsSync(FLAG);
const inHome = p => { try { return typeof p === 'string' || p instanceof URL ? resolve(String(p instanceof URL ? p.pathname.replace(/^\/([A-Za-z]:)/, '$1') : p)).toLowerCase().startsWith(HOME) : false; } catch { return false; } };
const fds = new Map(); // fd -> path, for writes by file descriptor (streams)
const noSpace = (call, p) => Object.assign(new Error(`ENOSPC: no space left on device, ${call} '${p}'`), { code: 'ENOSPC', errno: -28, syscall: call, path: String(p) });
const stop = (call, p) => inHome(p) && full();

// Whole-file and copy writes, by path.
for (const [name, at] of [['writeFileSync', 0], ['appendFileSync', 0], ['copyFileSync', 1]]) {
  const f = fs[name];
  fs[name] = function (...a) { if (stop(name, a[at])) throw noSpace(name, a[at]); return f.apply(this, a); };
}
for (const [name, at] of [['writeFile', 0], ['appendFile', 0], ['copyFile', 1]]) {
  const f = fs[name];
  fs[name] = function (...a) {
    if (stop(name, a[at])) { const cb = a.findLast(x => typeof x === 'function'); return void process.nextTick(cb, noSpace(name, a[at])); }
    return f.apply(this, a);
  };
  const pf = fs.promises[name];
  fs.promises[name] = function (...a) { return stop(name, a[at]) ? Promise.reject(noSpace(name, a[at])) : pf.apply(this, a); };
}
// Writes by file descriptor: the fd's path is noted when it is opened.
const open = fs.open, openSync = fs.openSync, close = fs.close, closeSync = fs.closeSync;
fs.open = function (p, ...a) {
  const cb = a.pop();
  return open.call(this, p, ...a, (e, fd) => { if (!e) fds.set(fd, p); cb(e, fd); });
};
fs.openSync = function (p, ...a) { const fd = openSync.call(this, p, ...a); fds.set(fd, p); return fd; };
fs.close = function (fd, ...a) { fds.delete(fd); return close.call(this, fd, ...a); };
fs.closeSync = function (fd) { fds.delete(fd); return closeSync.call(this, fd); };
for (const name of ['write', 'writev']) {
  const f = fs[name];
  fs[name] = function (fd, ...a) {
    if (stop(name, fds.get(fd))) { const cb = a.findLast(x => typeof x === 'function'); return void process.nextTick(cb, noSpace(name, fds.get(fd))); }
    return f.call(this, fd, ...a);
  };
}
for (const name of ['writeSync', 'writevSync']) {
  const f = fs[name];
  fs[name] = function (fd, ...a) { if (stop(name, fds.get(fd))) throw noSpace(name, fds.get(fd)); return f.call(this, fd, ...a); };
}
// A FileHandle (fs.promises.open): its writes fail too.
const popen = fs.promises.open;
fs.promises.open = async function (p, ...a) {
  const h = await popen.call(this, p, ...a);
  for (const name of ['write', 'writev', 'writeFile', 'appendFile']) {
    const f = h[name].bind(h);
    h[name] = (...b) => (stop(name, p) ? Promise.reject(noSpace(name, p)) : f(...b));
  }
  return h;
};
// `import { writeFile } from 'node:fs/promises'` and the like read these from now on.
syncBuiltinESMExports();
