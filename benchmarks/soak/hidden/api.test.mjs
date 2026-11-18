import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const mod = await load('server.js');
const createApp = mod.createApp ?? mod.default;
let server, base;
before(async () => {
  server = createApp();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const call = async (method, path, body, raw) => {
  const res = await fetch(base + path, { method, headers: body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, type: res.headers.get('content-type') ?? '', text };
};

test('creating an item gives 201, the item and the next id', async () => {
  const a = await call('POST', '/items', { name: 'bolt', qty: 10 });
  assert.equal(a.status, 201);
  assert.match(a.type, /application\/json/);
  assert.deepEqual(a.json, { id: 1, name: 'bolt', qty: 10 });
  const b = await call('POST', '/items', { name: 'nut', qty: 0 });
  assert.equal(b.json.id, 2);
});
test('reading one item, and a missing one is 404', async () => {
  const r = await call('GET', '/items/1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { id: 1, name: 'bolt', qty: 10 });
  const gone = await call('GET', '/items/99');
  assert.equal(gone.status, 404);
  assert.ok(gone.json && typeof gone.json.error === 'string');
});
test('a list has a total and pages with limit and offset', async () => {
  for (let i = 3; i <= 7; i++) await call('POST', '/items', { name: `item${i}`, qty: i });
  const all = await call('GET', '/items');
  assert.equal(all.status, 200);
  assert.equal(all.json.total, 7);
  assert.equal(all.json.items.length, 7);
  const page = await call('GET', '/items?limit=2&offset=3');
  assert.equal(page.json.total, 7);
  assert.deepEqual(page.json.items.map(x => x.id), [4, 5]);
  const bad = await call('GET', '/items?limit=abc');
  assert.equal(bad.status, 400);
});
test('a list can be filtered by name', async () => {
  const r = await call('GET', '/items?name=item5');
  assert.deepEqual(r.json.items.map(x => x.id), [5]);
  assert.equal(r.json.total, 1);
});
test('PUT replaces an item, and needs every field', async () => {
  const ok = await call('PUT', '/items/2', { name: 'nut M8', qty: 50 });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { id: 2, name: 'nut M8', qty: 50 });
  assert.equal((await call('GET', '/items/2')).json.name, 'nut M8');
  assert.equal((await call('PUT', '/items/2', { name: 'x' })).status, 422);
  assert.equal((await call('PUT', '/items/99', { name: 'x', qty: 1 })).status, 404);
});
test('PATCH changes only the fields sent', async () => {
  const r = await call('PATCH', '/items/1', { qty: 11 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { id: 1, name: 'bolt', qty: 11 });
});
test('bad values are 422 with an error message', async () => {
  for (const body of [{ name: '', qty: 1 }, { name: 'x', qty: -1 }, { name: 'x', qty: 1.5 }, { name: 'x', qty: '3' }, { qty: 1 }, { name: 5, qty: 1 }]) {
    const r = await call('POST', '/items', body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.ok(typeof r.json?.error === 'string' && r.json.error.length > 0);
  }
});
test('a body that is not JSON is 400', async () => {
  const r = await call('POST', '/items', undefined, '{not json');
  assert.equal(r.status, 400);
  assert.ok(typeof r.json?.error === 'string');
});
test('extra fields are ignored, not stored', async () => {
  const r = await call('POST', '/items', { name: 'washer', qty: 2, evil: 'x' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.json).sort(), ['id', 'name', 'qty']);
});
test('deleting gives 204, then 404, and ids are not reused', async () => {
  const d = await call('DELETE', '/items/3');
  assert.equal(d.status, 204);
  assert.equal(d.text, '');
  assert.equal((await call('GET', '/items/3')).status, 404);
  assert.equal((await call('DELETE', '/items/3')).status, 404);
  const n = await call('POST', '/items', { name: 'after', qty: 1 });
  assert.ok(n.json.id > 8, `new id ${n.json.id}`);
});
test('unknown paths are 404 JSON, and a wrong method is 405', async () => {
  const r = await call('GET', '/nothing');
  assert.equal(r.status, 404);
  assert.ok(typeof r.json?.error === 'string');
  const m = await call('DELETE', '/items');
  assert.equal(m.status, 405);
});
test('twenty requests at once all get answers', async () => {
  const all = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', '/items', { name: `p${i}`, qty: i })));
  assert.ok(all.every(r => r.status === 201));
  assert.equal(new Set(all.map(r => r.json.id)).size, 20);
});
