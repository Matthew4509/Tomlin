// Throws wrong, odd and huge input at every route of a scratch TOMLIN host and reports what answered 5xx, hung, or took the host down.
//   BASE=http://127.0.0.1:8799 OUT=<file.json> node benchmarks/soak/apifuzz.mjs
// Run it only against a scratch host (TOMLIN_DATA, TOMLIN_MODELS_FILE pointing at an empty folder, no linked PCs): some routes write.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.BASE ?? 'http://127.0.0.1:8799';
const out = process.env.OUT ?? 'apifuzz-result.json';
const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '..', '..', 'src', 'server');

// Routes that start a download, move or delete files outside the scratch data, change the PC or reach other machines.
const SKIP = /^\/api\/(downloads\/start|share\/firewall|network\/(fetch|pull|update)|install|runtimes\/(get|remove)|chatmodels\/(get|search|sizes|look)|hflist\/scan|models\/(move|delete|hide|folder|to-ssd|where)|cleanup|pc\/power|sitecheck|nodes\/switch|speed|runner-|place\/try|images\/generate|images\/from|report|notify|blog\/picture|office\/buy|staff\/backup|files\/folder)/;

const routes = { get: [], post: [] };
for (const f of readdirSync(server).filter(x => x.endsWith('.ts'))) {
  let kind = null;
  for (const l of readFileSync(join(server, f), 'utf8').split(/\r?\n/)) {
    const m = /^(?:export )?const \w*(Get|Post)\w*\s*[:=]/.exec(l);
    if (m) kind = m[1].toLowerCase();
    const r = /^  '(\/api\/[^']+)':/.exec(l);
    if (r && kind) routes[kind].push(r[1]);
  }
}

// Routes answered outside the route tables (src/jobrun.ts, images, network, share): the same weird input.
const EXTRA = ['/api/applock', '/api/chat/doc', '/api/downloads', '/api/downloads/stop', '/api/home/pcs', '/api/images/again', '/api/images/alt', '/api/images/delete', '/api/images/enhance', '/api/images/finalise', '/api/images/from-chat', '/api/images/gallery', '/api/images/job', '/api/images/keep', '/api/images/plan', '/api/jobs', '/api/jobs/change', '/api/jobs/final', '/api/jobs/get', '/api/jobs/plan', '/api/jobs/review', '/api/jobs/run', '/api/jobs/setup', '/api/jobs/step', '/api/jobs/test', '/api/network', '/api/network/backup', '/api/network/backups', '/api/network/bring', '/api/network/claim', '/api/network/copies', '/api/network/copy', '/api/network/free', '/api/network/model-remove', '/api/network/move', '/api/network/owner', '/api/network/projects', '/api/network/projects-back', '/api/network/run-set', '/api/network/runner', '/api/network/runner-remove', '/api/network/send', '/api/network/stop', '/api/network/transfers', '/api/network/tune', '/api/network/web-context', '/api/projects/check', '/api/remotes', '/api/share', '/api/share/projects-out', '/api/share/reach'];
for (const p of EXTRA) { if (!routes.get.includes(p)) routes.get.push(p); if (!routes.post.includes(p)) routes.post.push(p); }
const deep = (n) => '['.repeat(n) + ']'.repeat(n);
const BODIES = [
  ['empty', ''], ['{}', '{}'], ['[]', '[]'], ['null', 'null'], ['string', '"text"'], ['number', '12345'], ['broken', '{"a":'],
  ['wrong types', JSON.stringify({ id: 5, name: [], text: {}, message: 7, model: null, chat: false, who: [], path: 3, pane: {}, kind: 1 })],
  ['operators', JSON.stringify({ id: { $ne: 1 }, chat: { $gt: '' }, name: { toString: 1 } })],
  ['paths', JSON.stringify({ id: '../../x', path: '..\\..\\Windows\\win.ini', name: 'con', file: 'C:\\x', project: '../..', chat: '../../x' })],
  ['proto', '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}'],
  ['lone surrogate', JSON.stringify({ text: 'a\ud800b', name: '\udc00', message: '\ud83d' })],
  ['huge string', JSON.stringify({ text: 'x'.repeat(3_000_000), message: 'y'.repeat(3_000_000) })],
  ['deep', deep(5000)],
  ['many keys', JSON.stringify(Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`k${i}`, i])))],
];
// INFORMED=1: also bodies that carry real ids from the host (chats, hires, projects), so the routes get past "not found" (run flows.mjs first).
if (process.env.INFORMED) {
  const ids = new Set();
  for (const p of ['/api/chats', '/api/staff', '/api/home', '/api/todo', '/api/projects/setup', '/api/files']) {
    const text = await fetch(base + p).then(r => r.text()).catch(() => '');
    for (const m of text.matchAll(/"(?:id|chat|who|project|ref|folder|item)":"([^"]{1,60})"/g)) ids.add(m[1]);
  }
  for (const id of [...ids].slice(0, 12)) BODIES.push([`ids ${id.slice(0, 14)}`, JSON.stringify({ id, chat: id, project: id, who: id, item: id, ref: id, title: 'x', text: 'x', name: 'x', on: true, done: true, zone: 'now', size: 'small', kind: 'chat', pane: 'chat', message: 'hi', model: '', pictures: 'keep' })]);
  console.log('informed: ' + ids.size + ' ids, ' + BODIES.length + ' bodies');
}
const QUERIES = ['', '?id=../..', '?chat=%00', '?id=' + 'a'.repeat(5000), '?q=%ff%fe', '?limit=-1&offset=1e9', '?path=C:%5CWindows&file=..%2F..%2Fx'];

const results = { base, startedAt: new Date().toISOString(), calls: 0, bad: [], hung: [], died: [] };
const alive = async () => { try { return (await fetch(base + '/api/status', { signal: AbortSignal.timeout(15000) })).ok; } catch { return false; } };

async function one(method, path, body, ctype) {
  results.calls++;
  const t0 = Date.now();
  try {
    const res = await fetch(base + path, { method, headers: ctype ? { 'content-type': ctype } : {}, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(20000) });
    // An event stream (a chat) is read to its end or for a few seconds; anything else is read whole.
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('event-stream')) { const r = res.body.getReader(); const stop = Date.now() + 5000; while (Date.now() < stop) { const x = await Promise.race([r.read(), new Promise(ok => setTimeout(() => ok({ done: true }), 5000))]); if (x.done) break; } await r.cancel().catch(() => undefined); }
    else await res.arrayBuffer();
    return { status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { error: String(e.name === 'TimeoutError' ? 'timeout' : e.message), ms: Date.now() - t0 };
  }
}

const note = (kind, path, what, r) => { results[kind].push({ path, what, ...r }); console.log(kind.toUpperCase(), path, what, JSON.stringify(r)); };
if (!(await alive())) { console.log('the host is not answering at', base); process.exit(2); }

for (const path of routes.get) {
  if (SKIP.test(path)) continue;
  for (const q of QUERIES) {
    const r = await one('GET', path + q);
    if (r.error === 'timeout') note('hung', path, `GET ${q.slice(0, 40)}`, r);
    else if (r.error || r.status >= 500) note('bad', path, `GET ${q.slice(0, 40)}`, r);
    if (r.error && !(await alive())) { note('died', path, `GET ${q.slice(0, 40)}`, r); process.exit(3); }
  }
}
for (const path of routes.post) {
  if (SKIP.test(path)) continue;
  for (const [name, body] of BODIES) {
    for (const ctype of name === 'empty' ? [undefined] : ['application/json', 'text/plain']) {
      const r = await one('POST', path, body, ctype);
      if (r.error === 'timeout') note('hung', path, `POST ${name} ${ctype ?? ''}`, r);
      else if (r.error || r.status >= 500) note('bad', path, `POST ${name} ${ctype ?? ''}`, r);
      if (r.error && !(await alive())) { note('died', path, `POST ${name}`, r); writeFileSync(out, JSON.stringify(results, null, 1)); process.exit(3); }
    }
  }
  if (!(await alive())) { note('died', path, 'after all bodies', {}); break; }
}

// Many at once.
const burst = await Promise.all(Array.from({ length: 300 }, (_, i) => one('GET', i % 2 ? '/api/status' : '/api/chats')));
const slow = burst.filter(r => r.error || r.status >= 500);
if (slow.length) note('bad', '/api/status+/api/chats', '300 at once', { count: slow.length, first: slow[0] });
// The bodies above save whatever they carry as the standing rules (4,000 x's from "huge string"), which every chat on this
// host then reads first: a soak run after this one would test a model told "xxxx…". They go back to the defaults here.
const reset = await one('POST', '/api/rules', JSON.stringify({ reset: true }), 'application/json');
if (reset.status !== 200) console.log('the standing rules could not be set back to the defaults:', JSON.stringify(reset));
results.finishedAt = new Date().toISOString();
results.alive = await alive();
writeFileSync(out, JSON.stringify(results, null, 1));
console.log(`done: ${results.calls} calls, ${results.bad.length} bad, ${results.hung.length} hung, ${results.died.length} died, host alive: ${results.alive}`);
