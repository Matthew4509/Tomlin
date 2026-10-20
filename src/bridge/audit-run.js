// The audit off TOMLIN's server thread: lib/audit.js runAudit in a child process at below-normal priority, so chat,
// nodes and the office keep answering while it reads a project, and a busy PC serves them first. Node can lower a
// process's priority, not one thread's, so this is a process and not a worker thread; it still takes one core at most.
'use strict';
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const CHILD = path.join(__dirname, 'audit-child.js');
const LIMIT_MS = 15 * 60000; // a live comparison paces its requests 5 s apart: minutes, never this long
const children = new Set();
process.on('exit', () => { for (const c of children) try { c.kill(); } catch {} });

// opts must survive JSON (what is passed is what lib/audit-store.js builds: lists, strings, numbers).
// hooks.onStart(pid): for the tests.
function auditOffThread(dir, url, opts = {}, hooks = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD, [], { stdio: ['ignore', 'inherit', 'pipe', 'ipc'], windowsHide: true });
    children.add(child);
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    let answer = null, said = '';
    // What the child printed as an error goes to TOMLIN's log (console.error lands there) when the scan fails.
    child.stderr.on('data', d => { said = (said + d).slice(-4000); });
    const limit = setTimeout(() => { answer = { error: 'The scan ran for more than 15 minutes and was stopped, so no report was saved. Scan again when the PC is less busy.' }; child.kill(); }, LIMIT_MS);
    limit.unref();
    child.on('message', m => { if (!answer) answer = m; });
    child.on('error', e => { if (!answer) answer = { error: 'The scan could not start: ' + e.message + '. Try again.' }; });
    child.on('exit', code => {
      clearTimeout(limit);
      children.delete(child);
      if (answer && answer.audit) return resolve(answer.audit);
      if (said.trim()) console.error('Bridge scan of ' + dir + ' stopped: ' + said.trim());
      reject(new Error((answer && answer.error) || 'The scan stopped before it finished (exit ' + code + '), so no report was saved. Scan again; if it stops again, the details are in the log (Settings, Your data, Open log).'));
    });
    child.send({ dir, url, opts });
    if (hooks.onStart) hooks.onStart(child.pid);
  });
}

module.exports = { auditOffThread };
