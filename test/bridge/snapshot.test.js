// Site pictures: three in a row all come out, and no hidden Edge is left running afterwards (Edge's msedge.exe is a
// launcher that hands over and exits, so stopping it alone left the real browser holding the profile, and every
// picture after the first failed). Uses a made-up page on a free port and a throwaway profile in a temp folder.
// Run: node test/snapshot.test.js   (Windows with Microsoft Edge; skipped elsewhere)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const platform = require('../../src/bridge/platform');
const { takeSnapshot } = require('../../src/bridge/snapshot');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };

// Is a browser still answering on the DevTools port the picture's Edge wrote? (Windows hides Edge's command lines,
// so the port is the way to see it.) Also: is any process still holding that port?
async function stillThere(port) {
  try { await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(800) }); return true; } catch {}
  return (await platform.portOwners([Number(port)])).length > 0;
}
const portIn = profile => { try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0].trim(); } catch { return null; } };

(async () => {
  const edge = platform.findBrowser();
  if (process.platform !== 'win32' || !edge) { console.log('skipped: needs Windows and Microsoft Edge'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-snap-test-'));
  // Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
  process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
  const profile = path.join(tmp, 'profile');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>t</title><h1 style="color:teal">Made-up page</h1>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  try {
    for (let i = 1; i <= 3; i++) {
      await check('picture ' + i + ' of 3 comes out (the last one\'s browser no longer holds the profile)', async () => {
        const out = path.join(tmp, 'shot' + i + '.png');
        const t = Date.now();
        await takeSnapshot({ edge, url, out, profile, settleMs: 300, timeoutMs: 20000 });
        assert(fs.statSync(out).size > 1000, 'no picture written');
        assert(Date.now() - t < 15000, 'took ' + (Date.now() - t) + ' ms');
      });
      await check('after picture ' + i + ', no hidden Edge is left running (nothing on its DevTools port)', async () => {
        const port = portIn(profile);
        assert(port, 'Edge wrote no DevTools port');
        assert(!(await stillThere(port)), 'a browser still holds port ' + port);
      });
    }
    await check('a browser left over from an earlier run is stopped before the next picture', async () => {
      const { spawn } = require('child_process');
      fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
      spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' }).unref();
      let old = null;
      for (let k = 0; k < 50 && !(old && await stillThere(old)); k++) { await new Promise(r => setTimeout(r, 200)); old = portIn(profile); }
      assert(old && await stillThere(old), 'the leftover browser did not start');
      await takeSnapshot({ edge, url, out: path.join(tmp, 'after-leftover.png'), profile, settleMs: 300, timeoutMs: 20000 });
      assert(!(await stillThere(old)), 'the leftover browser on port ' + old + ' is still running');
      assert(!(await stillThere(portIn(profile))), 'the new picture\'s browser is still running');
    });
  } finally {
    server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exitCode = failures ? 1 : 0;
})();
