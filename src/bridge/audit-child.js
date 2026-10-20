// Runs one audit in a process of its own (started by audit-run.js), so TOMLIN's server thread keeps answering.
'use strict';
const { runAudit } = require('./audit');

process.once('message', async ({ dir, url, opts }) => {
  try { process.send({ audit: await runAudit(dir, url, opts) }, () => process.exit(0)); }
  catch (e) { console.error((e && e.stack) || e); process.send({ error: String((e && e.message) || e) }, () => process.exit(0)); }
});
// TOMLIN closed or stopped the scan: nothing is waiting for the report.
process.on('disconnect', () => process.exit(0));
