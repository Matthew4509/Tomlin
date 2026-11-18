// Is something answering on a local port? Used before starting a local copy and to show "Port N in use".
'use strict';
const net = require('net');

function portAnswers(port, host, ms = 400) {
  return new Promise(resolve => {
    const s = net.connect({ port, host });
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
async function portBusy(port) {
  if (!port) return false;
  return (await portAnswers(port, '127.0.0.1')) || (await portAnswers(port, '::1'));
}
// Every port at once: one by one, 60+ ports took several seconds (Windows is slow to refuse).
// ms (the list's "Port N in use" marks): both addresses asked at once and a shorter wait. Windows takes about a
// second to refuse a port nobody listens on, which was most of the time the Projects list took to open; a program
// that listens answers on this PC within a few milliseconds.
async function busyPorts(ports, ms) {
  const busy = ms ? async n => (await Promise.all([portAnswers(n, '127.0.0.1', ms), portAnswers(n, '::1', ms)])).some(Boolean) : portBusy;
  return new Set((await Promise.all(ports.map(async n => (await busy(n)) ? n : null))).filter(Boolean));
}
// stop(): give up early (the program could not start at all, so nothing will ever answer).
async function waitForPort(port, ms, stop = () => false) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stop()) {
    if (await portBusy(port)) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

// Which address the dev server answers on: php -S localhost:N may bind ::1 only.
function localUrl(cmd) {
  const hostArg = (cmd.args || []).find(a => /^(localhost|127\.0\.0\.1):\d+$/.test(a));
  return 'http://' + (hostArg ? hostArg.split(':')[0] : 'localhost') + ':' + cmd.port + '/';
}

module.exports = { portBusy, busyPorts, waitForPort, localUrl };
