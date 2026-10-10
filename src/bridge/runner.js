// Local copies: starting a project's own start command, stopping it, and the programs the Bridge did NOT start that
// hold a project's port. Commands come only from the project's files (launch.json / project.json), never the page.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const os = require('./platform');
const { state, refreshProjects, ownPortUser, commandPorts, projectName } = require('./state');
const { portBusy, busyPorts, waitForPort, localUrl } = require('./ports');
const { openBrowser } = require('./desktop');

function readTail(file) {
  try { return fs.readFileSync(file, 'utf8').trim().slice(-400); } catch { return ''; }
}

// Projects being started now: a second press (another tab, a double click) while the first is still starting is
// refused, so one project never gets two copies racing for its port.
const starting = new Set();

async function startProject(p, key, open = true) {
  const { running } = state;
  if (running.has(p.id)) return { ok: true, already: true, url: running.get(p.id).url };
  if (starting.has(p.id)) return { ok: false, starting: true, error: p.name + ' is starting already. Wait a moment: it opens when it answers.' };
  starting.add(p.id);
  try { return await startNow(p, key, open); } finally { starting.delete(p.id); }
}
async function startNow(p, key, open) {
  const { running } = state;
  const entry = p.commands.find(c => c.key === String(key));
  if (!entry) return { ok: false, error: 'No start command for ' + p.name + '. Nothing in its .claude/launch.json or project.json tells the Bridge how to run it. Add a "start" to project.json (see README), then try again.' };
  if (!entry.port) return { ok: false, error: '"' + entry.name + '" has no port in ' + entry.from + ', so the Bridge cannot check it is free or open it. Add "port" there.' };
  // One entry, or the same app on several ports (merged duplicates): the first free port wins.
  let cmd = null, note = '';
  for (const alt of entry.alts || [entry]) {
    if (!(await portBusy(alt.port))) { cmd = { ...entry, ...alt }; break; }
  }
  if (!cmd) {
    const all = (entry.alts || [entry]).map(a => a.port);
    const mine = all.map(ownPortUser).find(Boolean);
    if (mine) return { ok: false, error: 'Port ' + mine.port + ' is used by ' + mine.name + ', which the Bridge is running. Both projects start on that port, so stop ' + mine.name + ' first, then run ' + p.name + '.' };
    return { ok: false, portInUse: all[0], url: localUrl(entry), error: (all.length > 1 ? 'Ports ' + all.join(', ') + ' are all in use' : 'Port ' + all[0] + ' is already in use') + ', so ' + p.name + ' was not started. If it is already running, use Open in browser; otherwise stop whatever holds the port.' };
  }
  if (cmd.port !== entry.port) note = 'Port ' + entry.port + ' was busy, so it started on ' + cmd.port + '.';
  // The project's Local secrets (Push live, Secrets) reach the local copy as environment variables, so its code reads
  // them with getenv() the same way the live site does. They are never written into the project.
  let env = process.env;
  try {
    const local = await require('./hosting/secrets').values(p.dir, 'local');
    if (Object.keys(local).length) env = { ...process.env, ...local };
  } catch (e) { note = (note ? note + ' ' : '') + 'Its Local secrets could not be opened (' + e.message + '), so it started without them.'; }
  const log = path.join(cfg.DATA, 'logs', p.id + '.log');
  const out = fs.openSync(log, 'w');
  let child;
  // npm, npx, yarn and pnpm are .cmd scripts on Windows, which cannot be started without a shell: the platform turns
  // them into node + the tool's own script, or refuses arguments a shell would read as commands.
  const run = os.runnable(cmd.exe, cmd.args, cmd.cwd || p.dir);
  if (run.error) { fs.closeSync(out); return { ok: false, error: 'Could not start "' + cmd.exe + '": ' + run.error + ' Check the entry in ' + cmd.from + '.' }; }
  try {
    child = spawn(run.exe, run.args, { cwd: cmd.cwd || p.dir, env, stdio: ['ignore', out, out], windowsHide: true, shell: false, windowsVerbatimArguments: !!run.windowsVerbatimArguments });
  } catch (e) {
    fs.closeSync(out);
    return { ok: false, error: 'Could not start "' + cmd.exe + '": ' + e.message + '. Check the path in ' + cmd.from + '.' };
  }
  const url = localUrl(cmd);
  const rec = { child, pid: child.pid, port: cmd.port, name: cmd.name, started: new Date().toISOString(), log, url };
  running.set(p.id, rec);
  let spawnError = null;
  child.on('error', e => { spawnError = e; });
  child.on('exit', () => { if (running.get(p.id) === rec) running.delete(p.id); try { fs.closeSync(out); } catch {} });
  const up = await waitForPort(cmd.port, 20000, () => !!spawnError);
  if (!up) {
    const tail = readTail(log);
    os.killTree(child.pid);
    running.delete(p.id);
    return { ok: false, error: (spawnError ? 'Could not start "' + cmd.exe + '" (' + spawnError.code + '). Check the path in ' + cmd.from + '.' : p.name + ' started but nothing answered on port ' + cmd.port + ' within 20 seconds, so it was stopped.') + (tail ? ' Last output: ' + tail : ''), log };
  }
  return { ok: true, url, note, ...(open ? openBrowser(url) : {}) };
}

// Stops a local copy the Bridge started. false when it was not running from the Bridge.
function stopProject(id) {
  const r = state.running.get(id);
  if (!r) return false;
  os.killTree(r.pid);
  state.running.delete(id);
  return true;
}
function stopAllProjects() {
  const stopped = [];
  for (const id of [...state.running.keys()]) { stopProject(id); stopped.push(projectName(id)); }
  return stopped;
}

// Where a running site can be seen: its running copy, or a start port (alternates too) another program holds. A port
// the Bridge is running ANOTHER project on is that project's site, never this one's (two projects can share a port).
async function siteUrlOf(p) {
  const r = state.running.get(p.id);
  if (r) return r.url;
  for (const c of commandPorts(p)) {
    const own = ownPortUser(c.port);
    if (own && own.id !== p.id) continue;
    if (await portBusy(c.port)) return localUrl(c);
  }
  return null;
}

// ---- programs the Bridge did NOT start that hold a project's port (the "Port N in use" state) ----
// Only ports that belong to a project's start command can be looked up or stopped, and never the system's own
// processes, the Bridge, or the window it runs in.
function protectedWhy(o) {
  if (o.pid === process.pid || o.pid === process.ppid) return 'it is TOMLIN itself';
  const sys = os.systemProcessWhy(o);
  if (sys) return sys;
  if (/myia bridge[\\/]+server\.js|\bserver\.js\b/i.test(o.cmd || '') && /myia bridge/i.test(o.cmd || '')) return 'it is another Myia Bridge';
  return null;
}
// Project start ports that something other than the Bridge is holding, with the project(s) each belongs to.
async function foreignPorts() {
  const projects = refreshProjects();
  const mine = new Set([...state.running.values()].map(r => r.port));
  const byPort = new Map();
  for (const p of projects) for (const c of p.commands) {
    if (!c.port || mine.has(c.port)) continue;
    if (!byPort.has(c.port)) byPort.set(c.port, []);
    if (!byPort.get(c.port).includes(p.name)) byPort.get(c.port).push(p.name);
  }
  const busy = [...(await busyPorts([...byPort.keys()]))];
  const owners = await os.portOwners(busy);
  return owners.map(o => ({ ...o, why: protectedWhy(o), projects: byPort.get(o.port) || [] }));
}
async function stopForeign(o) {
  if (o.why) return { port: o.port, name: o.name, ok: false, error: 'Not stopped: ' + o.why + '.' };
  if (cfg.DRY) return { port: o.port, name: o.name, ok: true, dryRun: os.killCommand(o.pid, o.name) };
  os.killTree(o.pid);
  for (let i = 0; i < 10 && await portBusy(o.port); i++) await new Promise(r => setTimeout(r, 300));
  const still = await portBusy(o.port);
  return { port: o.port, name: o.name, pid: o.pid, ok: !still, error: still ? 'Port ' + o.port + ' is still in use: the system may need a moment, or the program restarted itself.' : undefined };
}

module.exports = { startProject, stopProject, stopAllProjects, siteUrlOf, foreignPorts, stopForeign };
