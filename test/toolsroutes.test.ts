import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPc } from './pcs.ts';
import { Helper, newHelperState } from '../src/camhelper.ts';

// A real copy of TOMLIN on a port of its own with an empty home in %TEMP%, and a made-up helper on 127.0.0.1.
// No model answers here, so no tool runs: nothing on the real screen is listed, read or touched.
test('a fresh copy: the newer permissions at their safe defaults, saved only as known values, and the helper routes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tomlin-tools-'));
  const pc = await startPc({ root: process.cwd(), home });
  const state = newHelperState('Test laptop');
  const helper = new Helper(state, { read: async tool => `read ${tool}`, save: async () => undefined });
  const laptop = createServer((req, res) => {
    let raw = '';
    req.on('data', d => (raw += d));
    req.on('end', async () => {
      const a = await helper.handle({ method: req.method ?? 'GET', path: req.url ?? '/', body: raw ? JSON.parse(raw) : {}, address: req.socket.remoteAddress });
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>(r => laptop.listen(0, '127.0.0.1', r));
  const laptopPort = (laptop.address() as { port: number }).port;
  try {
    const first = (await pc.get('/api/models')).body?.settings?.permissions ?? (await pc.get('/api/settings')).body?.permissions;
    assert.ok(first, 'the settings carry the permissions');
    assert.deepEqual([first.files, first.web, first.webDelay], ['ask', 'ask', true], 'files and web as they were');
    assert.deepEqual(first.tiers, { screen: 'look', machine: 'look', git: 'look', notes: 'look', subagent: 'look', focus: 'never', input: 'never', run: 'never', edit: 'never', download: 'never' });
    assert.deepEqual([first.windows, first.folders, first.research, first.coding], [[], [], false, false]);

    const saved = (await pc.post('/api/settings', { permissions: { ...first, windows: ['mstsc.exe|192.168.1.20 - *', 7], tiers: { ...first.tiers, input: 'allowed', focus: 'each', run: 'sudo' }, coding: 'yes' } })).body.permissions;
    assert.deepEqual(saved.windows, ['mstsc.exe|192.168.1.20 - *']);
    assert.equal(saved.tiers.input, 'never', 'Allowed cannot be saved for clicks');
    assert.equal(saved.tiers.focus, 'each');
    assert.equal(saved.tiers.run, 'never', 'an unknown tier falls to Never');
    assert.equal(saved.coding, false);
    const old = (await pc.post('/api/settings', { permissions: { files: 'auto' } })).body.permissions;
    assert.deepEqual([old.files, old.windows, old.tiers.focus], ['auto', ['mstsc.exe|192.168.1.20 - *'], 'each'], 'an older page that sends only the first kinds changes nothing else');

    assert.deepEqual((await pc.get('/api/helpers')).body, { helpers: [] });
    const outside = await pc.post('/api/helpers', { action: 'link', address: '8.8.8.8', code: state.code });
    assert.equal(outside.status, 400);
    assert.match(outside.body.error, /not an address on your home network/);
    const wrong = await pc.post('/api/helpers', { action: 'link', address: `127.0.0.1:${laptopPort}`, code: 'WRONGCODE999' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /setup code is not the one shown/);
    const linked = await pc.post('/api/helpers', { action: 'link', address: `127.0.0.1:${laptopPort}`, code: state.code });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.deepEqual(linked.body.helpers, [{ id: state.id, name: 'Test laptop', url: `http://127.0.0.1:${laptopPort}`, tools: ['cam_menus', 'cam_window_state'], models: [], role: 'Laptop helper' }]);
    assert.equal(JSON.stringify(linked.body).includes('key'), false, 'the link\'s key never goes to the page');
    assert.match(await readFile(join(home, 'data', 'helpers.json'), 'utf8'), /"key"/, 'it is kept in the data folder');
    // A helper with no models beside the usual lists: the pages that list PCs and models still answer.
    for (const path of ['/api/remotes', '/api/models']) assert.equal((await pc.get(path)).status, 200, path);
    assert.deepEqual((await pc.get('/api/remotes')).body.remotes, [], 'a helper is not a node: it is not in the list of PCs that lend models');
    assert.deepEqual((await pc.post('/api/helpers', { action: 'remove', id: state.id })).body, { helpers: [] });
    assert.equal((await pc.post('/api/helpers', { action: 'dance' })).status, 400);

    assert.equal((await pc.post('/api/chat/finding', { chatId: 'nope', id: 'f1' })).status, 404, 'only a finding that was suggested can be saved');
    assert.equal(existsSync(join(home, 'data', 'action-log')), false, 'nothing acted, so there is no action log yet');

    // The page's scripts name the newer kinds and their card.
    const app = await (await fetch(`${pc.base}/app.js`)).text();
    const view = await (await fetch(`${pc.base}/chatview.js`)).text();
    assert.match(app, /app\.tierRows = /);
    assert.match(app, /Let the model click and type/);
    assert.match(view, /function tierCard\(/);
    for (const tier of ['Never', 'Look only', 'Ask each time', 'Allowed']) assert.ok(app.includes(`'${tier}'`), `the tier is shown as words: ${tier}`);
    const css = await (await fetch(`${pc.base}/style.css`)).text();
    // That section only, up to the next one (sections added after it are not its own).
    const from = css.indexOf('/* Permissions, the newer kinds');
    const next = css.indexOf('\n/* ', from + 1);
    const mine = css.slice(from, next < 0 ? undefined : next);
    assert.ok(mine.length > 200 && mine.length < 4000);
    assert.doesNotMatch(mine, /#[0-9a-f]{3,8}\b/i, 'colours by name (the page\'s own variables), not by number');
    for (const m of mine.matchAll(/font-size:\s*([^;]+);/g)) assert.match(m[1], /var\(--fs-(sm|md|chat|lg|xl|xs)\)/, 'text sizes are the page\'s own, 13px or more');
  } finally {
    await pc.stop();
    await new Promise(r => laptop.close(r));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
});
