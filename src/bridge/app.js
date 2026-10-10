// Starting the Bridge part: read the project list, start the counters and live checks. Inside TOMLIN, embed()
// starts it in TOMLIN's own process and TOMLIN's server hands it every /bridge/ request
// (src/server/bridge.ts). start() is the same part on a server of its own, for the tests (test/bridge/serve.js).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cfg = require('./config');
const Sensors = require('./sensors');
const { state, refreshProjectsAsync, refreshTokens } = require('./state');
const { scanFolders } = require('./views');
const { scheduleLive } = require('./live-state');
const { shutdown, stopEverything } = require('./lifecycle');
const { handle } = require('./routes');

// A fault in one background job (a project file nobody expected, a live check, a token count) is written down and
// the rest keeps running: it must never take every local copy (or TOMLIN) down with it.
function logFault(kind, e) {
  const line = new Date().toISOString() + ' ' + kind + ': ' + ((e && e.stack) || e) + '\n';
  console.error('The Bridge part hit an error and kept running (' + kind + '): ' + ((e && e.message) || e));
  try { fs.mkdirSync(path.join(cfg.DATA, 'logs'), { recursive: true }); fs.appendFileSync(path.join(cfg.DATA, 'logs', 'bridge-errors.log'), line); } catch {}
}

// The folders are read after the page can already answer, so nothing waits on them.
async function warmUp() {
  if (!require('./hooks').pc) Sensors.gpuStats(); // first readings ready by the time the page asks (TOMLIN lends its own)
  if (Sensors.CPU_TEMP) Sensors.tempStats();
  try {
    await refreshProjectsAsync();
    if (!state.settings.lastScan) scanFolders(false); // first run: today's folders are the baseline, so nothing shows as "New"
    refreshTokens();
  } catch (e) { logFault('reading the projects', e); }
  // Live addresses: checked a few seconds after start, then every 5, 10 or 15 minutes (Live sites panel).
  scheduleLive(3000);
}

let embedded = false;
// Inside TOMLIN: no server and no window of its own. TOMLIN's exit ends every local copy started here.
function embed() {
  if (embedded) return { handle };
  embedded = true;
  cfg.ensureDataDirs();
  try { require('./hosting/connections').sweepTemps(); } catch {}
  process.on('exit', stopEverything);
  warmUp().catch(e => logFault('starting', e));
  return { handle };
}

// The tests' stand-alone copy: listens on 127.0.0.1 only, on its own port.
function start() {
  cfg.ensureDataDirs();
  const server = http.createServer(handle);
  process.on('unhandledRejection', e => logFault('unhandled rejection', e));
  process.on('uncaughtException', e => logFault('uncaught exception', e));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  server.on('error', e => {
    console.error(e.code === 'EADDRINUSE' ? 'Port ' + cfg.PORT + ' is in use, so the test copy of the Bridge part cannot start.' : e);
    process.exit(1);
  });
  server.listen(cfg.PORT, '127.0.0.1', async () => {
    try { fs.writeFileSync(cfg.RUN_FILE, JSON.stringify({ pid: process.pid, port: cfg.PORT, started: new Date().toISOString() })); } catch {}
    console.log('Bridge part (test copy) ' + cfg.VERSION + ' on http://127.0.0.1:' + cfg.PORT + '/  - working folders: ' + state.settings.workingFolders.join('; ') + (cfg.DRY ? '  [dry run]' : ''));
    await warmUp();
  });
  return server;
}

module.exports = { start, embed, logFault };
