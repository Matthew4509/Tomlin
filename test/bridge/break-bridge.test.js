// Odd requests the page could send (an old page, a hand-made request, a field left empty) get a plain answer, never
// "The Bridge hit an error" (a 500): setting a push finding aside before the project has anywhere to push, Stop all
// with a damaged list, and the Folders page's remove, forget and show buttons with no path.
// Everything runs over a made-up working folder in a temp folder and a test copy on a free port (dry run).
// Run: node test/bridge/break-bridge.test.js   (Windows; no packages)
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const NODE = process.execPath;
const SERVER = path.join(__dirname, 'serve.js');
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const portOpen = port => new Promise(r => { const s = net.connect(port, '127.0.0.1'); s.setTimeout(1000, () => { s.destroy(); r(false); }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-break-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const WS = path.join(TMP, 'ws'), DATA = path.join(TMP, 'data'), SRV_TMP = path.join(TMP, 'tmp');
for (const d of [WS, DATA, SRV_TMP]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(WS, 'plain-site'));
fs.writeFileSync(path.join(WS, 'plain-site', 'index.html'), '<p>A made-up site.</p>');

async function main() {
  const PORT = await freePort();
  // The test copy runs IN the working folder, so an empty path (which resolves to where the Bridge runs) names a folder
  // that is on the list.
  const env = { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_DATA: DATA, BRIDGE_ROOT: WS, TEMP: SRV_TMP, TMP: SRV_TMP };
  const srv = spawn(NODE, [SERVER, '--dry-run'], { cwd: WS, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
  try {
    for (let i = 0; i < 50 && !(await portOpen(PORT)); i++) await sleep(200);
    const BASE = 'http://127.0.0.1:' + PORT;
    const key = ((await (await fetch(BASE + '/')).text()).match(/name="bridge-key" content="([0-9a-f]+)"/) || [])[1];
    const api = async (p, body) => {
      const res = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'X-Bridge-Key': key, 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    const id = (await api('/api/projects?fresh=1')).json.projects.find(p => p.folder === 'plain-site').id;

    await check('B1: setting a push finding aside on a project with no push set up is refused plainly, not a 500', async () => {
      assert((await api('/api/hosting/on', { on: true })).json.on);
      const r = await api('/api/hosting/ignore', { id, key: 'KEY|index.html|abc' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.ok, false, JSON.stringify(r.json));
      assert(!(await api('/api/hosting/site?id=' + id)).json.site, 'no site record is made');
    });

    await check('B2: Stop all with a damaged list of other programs (null, a number) answers, not a 500', async () => {
      for (const listed of [[null], [7, 'x'], [{ port: 1, pid: 2 }, null]]) {
        const r = await api('/api/stop-all', { others: true, listed });
        assert.strictEqual(r.status, 200, JSON.stringify(listed) + ': ' + JSON.stringify(r.json));
        assert(r.json.ok && Array.isArray(r.json.others) && !r.json.others.length, JSON.stringify(r.json));
      }
    });

    await check('B3: remove, forget and show with no path are refused, and the working folder stays on the list', async () => {
      for (const route of ['/api/folders/remove', '/api/projects/forget', '/api/projects/show']) {
        for (const p of [null, '', 0]) {
          const r = await api(route, { path: p });
          assert.strictEqual(r.status, 200, route + ' ' + JSON.stringify(p) + ': ' + JSON.stringify(r.json));
          assert.strictEqual(r.json.ok, false, route + ' ' + JSON.stringify(p) + ': ' + JSON.stringify(r.json));
        }
      }
      const s = (await api('/api/settings')).json;
      assert((s.workingFolders || s.settings && s.settings.workingFolders || []).some(f => (typeof f === 'string' ? f : f.path || f.dir || '').toLowerCase() === WS.toLowerCase()), JSON.stringify(s).slice(0, 300));
    });
  } finally {
    srv.kill();
    await sleep(300);
  }
  if (failures) console.log(out.slice(-1500));
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
