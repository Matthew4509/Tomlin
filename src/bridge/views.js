// What the page is sent: the project rows, the Folders page, and the This PC numbers.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
const Sensors = require('./sensors');
const { keyOf } = require('./projects');
const { gitState } = require('./gitstate');
const { state, saveSettings, refreshProjects, refreshProjectsAsync, projectDirs, refreshTokens, demoTokens, ownPortUser, commandPorts } = require('./state');
const { busyPorts } = require('./ports');
const { live, liveOf, everyMin } = require('./live-state');
const { lastAudit, auditSummary } = require('./audit-store');
const hooks = require('./hooks');

async function listView(fresh) {
  // Git state per folder, read only (a folder with no .git costs one file check; a repository a few git commands),
  // kept a minute (Refresh reads again). Started first, so it runs while the folders are walked.
  const dirs = projectDirs();
  const gitJob = Promise.all(dirs.map(d => gitState(d, fresh)));
  const projects = await refreshProjectsAsync(fresh);
  if (cfg.DEMO) demoTokens();
  const { settings, running, tokens } = state;
  const known = new Set(settings.known.map(keyOf));
  const hiddenView = new Set(settings.hiddenView.map(keyOf));
  const order = new Map(settings.order.map((d, i) => [keyOf(d), i]));
  const portsOf = c => c.alts ? c.alts.map(a => a.port) : [c.port];
  const ports = [...new Set(projects.flatMap(p => running.has(p.id) ? [] : p.commands.flatMap(portsOf)).filter(Boolean))];
  const [busy, gitList] = await Promise.all([busyPorts(ports), gitJob]);
  const gitOf = new Map(dirs.map((d, i) => [keyOf(d), gitList[i]]));
  const gits = await Promise.all(projects.map(p => gitOf.get(keyOf(p.dir)) || gitState(p.dir)));
  // Copies on linked PCs (inside TOMLIN only): ticked projects carry their newest copy; the rest say "off".
  const nodes = hooks.nodeBackup ? hooks.nodeBackup.rows() : null;
  return projects.map((p, i) => {
    const r = running.get(p.id);
    // A port held by a site the Bridge started for ANOTHER project is not "another program": two projects can share
    // a port number in their start files, and the Bridge must not offer to stop its own site from this row.
    let busyElsewhere = null, portSharedWith = null;
    if (!r) {
      portSharedWith = p.commands.flatMap(portsOf).map(n => ownPortUser(n)).find(Boolean) || null;
      busyElsewhere = p.commands.flatMap(portsOf).find(n => busy.has(n) && !ownPortUser(n)) || null;
    }
    const k = keyOf(p.dir);
    return {
      id: p.id, folder: p.folder, name: p.name, description: p.description, liveUrl: p.liveUrl,
      dir: p.dir, updated: p.updated, workingFolder: p.workingFolder, added: p.added,
      isNew: !!settings.lastScan && !known.has(k),
      hiddenView: hiddenView.has(k),
      order: order.has(k) ? order.get(k) : null,
      tokens: tokens.per[p.id] || 0, tokensMonth: tokens.month[p.id] || 0,
      commands: p.commands.map(c => ({ key: c.key, name: c.name, port: c.port, from: c.from, ports: c.alts ? c.alts.map(a => a.port) : undefined })),
      running: r ? { port: r.port, name: r.name, started: r.started, url: r.url } : null,
      portInUse: busyElsewhere, portSharedWith,
      audit: auditSummary(lastAudit(p.id)),
      live: liveOf(p),
      git: gits[i],
      node: nodes ? nodes.projects[keyOf(p.dir)] || { on: false } : null,
    };
  });
}

// The Folders page: working folders (with how many projects each holds), projects added one by one, and projects
// removed from the list.
function settingsView() {
  const { settings, projects } = state;
  const count = root => projects.filter(p => p.workingFolder && keyOf(p.workingFolder) === keyOf(root)).length;
  return {
    workingFolders: settings.workingFolders.map(f => ({ path: f, exists: fs.existsSync(f), projects: count(f) })),
    extraProjects: settings.extraProjects.map(f => ({ path: f, exists: fs.existsSync(f), name: path.basename(f) })),
    hidden: settings.hidden.map(f => ({ path: f, name: path.basename(f), exists: fs.existsSync(f) })),
    lastScan: settings.lastScan,
  };
}

// Scan folders: reread every working folder and say what is new or gone since the last scan.
// fresh=false: the folders were read a moment ago (start-up), so the cached read is used.
function scanFolders(fresh = true) {
  const { settings } = state;
  const before = new Set(settings.known.map(keyOf));
  const projects = refreshProjects(fresh);
  const nowKeys = new Set(projects.map(p => keyOf(p.dir)));
  const added = projects.filter(p => !before.has(keyOf(p.dir))).map(p => p.name);
  const gone = settings.known.filter(d => !nowKeys.has(keyOf(d))).map(d => path.basename(d));
  const first = !settings.lastScan;
  settings.known = projects.map(p => p.dir);
  settings.lastScan = new Date().toISOString();
  saveSettings();
  refreshTokens();
  return { first, added: first ? [] : added, gone: first ? [] : gone, total: projects.length, folders: settings.workingFolders.length };
}

let lastCpu = os.cpus();
function cpuPct() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const a = lastCpu[i] ? lastCpu[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const t = c.times;
    idle += t.idle - a.idle;
    total += (t.user - a.user) + (t.nice - a.nice) + (t.sys - a.sys) + (t.idle - a.idle) + (t.irq - a.irq);
  });
  lastCpu = now;
  return total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
}

// Changes whenever what the rows show about running copies changes: a copy the Bridge started stops or crashes, or
// another program starts or stops on a project's port (looked at every 30 s). The page reloads the list when it moves.
const portWatch = { sig: '', busy: false, at: 0 };
async function watchPorts() {
  if (portWatch.busy) return;
  portWatch.busy = true;
  try {
    const ports = [...new Set(state.projects.flatMap(p => commandPorts(p).map(c => c.port)))];
    portWatch.sig = [...(await busyPorts(ports))].sort((a, b) => a - b).join(',');
    portWatch.at = Date.now();
  } catch {} finally { portWatch.busy = false; }
}
function rowsRev() {
  if (Date.now() - portWatch.at > 30000) watchPorts();
  return [...state.running.keys()].sort().join(',') + '|' + portWatch.sig;
}

function nodeSummary() {
  const v = hooks.nodeBackup ? hooks.nodeBackup.rows() : null;
  return v ? { pcs: v.pcs, ready: v.ready } : null;
}

function laptopStats() {
  const { settings, tokens } = state;
  const mem = { total: os.totalmem(), free: os.freemem() };
  let disk = null;
  try {
    const s = fs.statfsSync(settings.workingFolders.find(f => fs.existsSync(f)) || cfg.DATA);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {}
  const cpus = os.cpus();
  // Inside TOMLIN, its own readings (one reader for both pages); the stand-alone test copy reads its own.
  const pc = hooks.pc ? hooks.pc() : null;
  return {
    host: cfg.DEMO ? 'DEMO-PC' : os.hostname(), release: os.release(), demo: cfg.DEMO, uptime: os.uptime(),
    cpuModel: cpus[0] && cpus[0].model, cores: cpus.length, cpuPct: pc ? pc.cpuPct : cpuPct(),
    gpu: pc ? pc.gpu : Sensors.gpuStats(), temp: Sensors.CPU_TEMP ? Sensors.tempStats() : undefined,
    mem, disk, workingFolders: settings.workingFolders, version: cfg.VERSION, dryRun: cfg.DRY, welcomed: !!settings.welcomed,
    home: cfg.HERE, bridgeUp: Math.round((Date.now() - cfg.STARTED) / 1000),
    tokensAt: tokens.at, tokensBusy: tokens.busy, tokensError: tokens.error,
    liveRev: live.rev, liveBusy: live.busy, liveEvery: everyMin(), rowsRev: rowsRev(),
    // Linked PCs that take project backups now (inside TOMLIN; null in the tests' stand-alone copy).
    nodes: nodeSummary(),
    // Inside TOMLIN (its Send to card takes Start with a hire), not the tests' stand-alone copy.
    inTomlin: !!hooks.nodeBackup,
  };
}

module.exports = { listView, settingsView, scanFolders, laptopStats };
