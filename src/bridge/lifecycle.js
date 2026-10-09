// Stopping the Bridge part: every local copy it started goes with it, and run.json is removed (only if it is this run's).
// Inside TOMLIN this runs when TOMLIN closes (src/server/bridge.ts); the tests' stand-alone copy exits too.
'use strict';
const fs = require('fs');
const cfg = require('./config');
const Sensors = require('./sensors');
const { stopAllProjects } = require('./runner');

let stopped = false;
function stopEverything() {
  if (stopped) return;
  stopped = true;
  stopAllProjects();
  Sensors.stopGpu();
  try { if (JSON.parse(fs.readFileSync(cfg.RUN_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(cfg.RUN_FILE); } catch {}
}
function shutdown() {
  stopEverything();
  process.exit(0);
}

module.exports = { shutdown, stopEverything };
