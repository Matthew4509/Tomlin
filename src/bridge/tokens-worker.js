// Runs tokenTotals off the main thread (see refreshTokens in server.js).
'use strict';
const { parentPort } = require('worker_threads');
const { tokenTotals } = require('./tokens');
parentPort.on('message', ({ projects }) => {
  try { parentPort.postMessage(tokenTotals(projects)); }
  catch (e) { parentPort.postMessage({ error: String(e.message || e) }); }
});
