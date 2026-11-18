// Drives the app's own features in sequence against a scratch host and checks what comes back and what lands on disk:
// files kept inside the workspace (paths that try to leave it), chats, projects, to-do rows, notes.
//   BASE=http://127.0.0.1:8799 DATA=<the host's TOMLIN_DATA folder> node benchmarks/soak/flows.mjs
// Scratch host only: it writes and deletes.
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const base = process.env.BASE ?? 'http://127.0.0.1:8799';
const DATA = process.env.DATA;
if (!DATA) { console.log('set DATA to the scratch host\'s data folder'); process.exit(2); }
const problems = [];
const bad = (what, detail) => { problems.push({ what, detail: String(detail).slice(0, 400) }); console.log('PROBLEM', what, '-', String(detail).slice(0, 300)); };
const call = async (method, path, body) => {
  try {
    const res = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  } catch (e) { return { status: 0, json: null, text: String(e.message) }; }
};
const expect = (what, cond, detail) => { if (!cond) bad(what, detail ?? ''); };
const files = (dir) => { const out = []; const walk = (d) => { for (const n of existsSync(d) ? readdirSync(d) : []) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : out.push(p); } }; walk(dir); return out; };

// ---- 1. Files must stay inside the workspace ----
const ws = (await call('GET', '/api/files')).json?.folder;
expect('workspace folder is reported', !!ws, JSON.stringify(ws));
const outside = resolve(ws, '..', 'canary');           // a folder next to the workspace
mkdirSync(outside, { recursive: true });
const root = resolve(DATA, '..');
const before = new Set(files(root));
// Not in the workspace and not one of the host's own data files: a file that got out. The canary folder counts as out.
const isOut = f => !f.startsWith(resolve(ws)) && (!f.startsWith(resolve(DATA)) || f.startsWith(outside));
const evil = [
  '../canary/a.txt', '..\\canary\\b.txt', '..//canary//c.txt', 'x/../../canary/d.txt', 'x\\..\\..\\canary\\e.txt', '%2e%2e/canary/f.txt', '....//canary/g.txt',
  resolve(outside, 'h.txt'), outside.replace(/\\/g, '/') + '/i.txt', '\\\\?\\' + resolve(outside, 'j.txt'), '\\\\localhost\\c$\\canary\\k.txt',
  'ok.txt:stream', 'con', 'CON.txt', 'nul', 'aux.md', 'com1', 'lpt1.txt', 'prn', 'trailing.txt.', 'trailing space.txt ', 'a'.repeat(300) + '.txt', ('d/'.repeat(60)) + 'deep.txt',
  'bad<name>.txt', 'bad|name.txt', 'bad?name.txt', 'bad*name.txt', 'bad"name.txt', '', ' ', '.', '..', '/', '\\', 'C:', 'C:x.txt', '~1', 'PROGRA~1/x.txt', '\u0000x.txt', 'a\u0000b.txt', '\u202etxt.exe', 'x.txt\n', '.git/config', '.env', 'node_modules/x/y.js',
];
for (const p of evil) {
  const r = await call('POST', '/api/files/save', { path: p, text: 'canary text' });
  if (r.status >= 500 || r.status === 0) bad('files/save answered with a failure', `${JSON.stringify(p)} -> ${r.status} ${r.text.slice(0, 120)}`);
  const rd = await call('GET', '/api/files/read?path=' + encodeURIComponent(p));
  if (rd.status >= 500 || rd.status === 0) bad('files/read answered with a failure', `${JSON.stringify(p)} -> ${rd.status} ${rd.text.slice(0, 120)}`);
}
const after = files(root).filter(f => !before.has(f));
const escaped = after.filter(isOut);
expect('no file was written outside the workspace', escaped.length === 0, escaped.join(' | '));
const created = after.filter(f => f.startsWith(resolve(ws)));
console.log(`files: ${evil.length} odd paths tried, ${created.length} files created inside the workspace`);
// Whatever got in must have a name Windows could really open (no reserved names or alternate streams).
for (const f of created) if (/:|[<>|?*"]|(^|[\\/])(con|nul|aux|prn|com\d|lpt\d)(\.|$)/i.test(f.slice(resolve(ws).length + 1))) bad('a file was created with an unsafe name', f);

// ---- 2. Chats: make, rename, pin, delete, many at once ----
const made = [];
const hired = (await call('POST', '/api/staff', { action: 'hire', name: 'Flow Test', role: 'default', level: 'default' })).json;
const member = (hired?.staff ?? hired?.members ?? []).find(s => s.name === 'Flow Test');
expect('a hire can be made', !!member, JSON.stringify(hired).slice(0, 200));
const who = member ? `staff:${member.id}` : 'manager';
for (let i = 0; i < 25; i++) { const r = await call('POST', '/api/chats/new', { who }); const id = r.json?.chat?.id ?? r.json?.id; if (id) made.push(id); else if (i === 0) bad('chats/new gave no chat', r.text.slice(0, 200)); }
console.log(`chats: made ${made.length}`);
for (const [i, id] of made.entries()) {
  const t = ['Plain', 'Ünïcödé 名前', 'a'.repeat(500), '<b>html</b>', '😀'.repeat(50), '  spaces  '][i % 6];
  const r = await call('POST', '/api/chats/rename', { id, title: t });
  if (r.status >= 500 || r.status === 0) bad('chats/rename failed', `${JSON.stringify(t.slice(0, 30))} -> ${r.status} ${r.text.slice(0, 120)}`);
  const p = await call('POST', '/api/chats/pin', { id, on: i % 2 === 0 });
  if (p.status >= 500 || p.status === 0) bad('chats/pin failed', `${p.status} ${p.text.slice(0, 120)}`);
}
await Promise.all(made.slice(0, 10).map(id => call('POST', '/api/chats/delete', { id })));
const left = (await call('GET', '/api/chats')).json;
const listed = JSON.stringify(left);
expect('a deleted chat is no longer listed', made.slice(0, 10).every(id => !listed.includes(id)), 'a deleted chat still listed');
expect('a chat that was not deleted is listed', made.slice(10).every(id => listed.includes(id)), 'a kept chat is missing');
const again = await call('POST', '/api/chats/delete', { id: made[0] });
expect('deleting a chat twice is a plain 404', again.status === 404, `${again.status} ${again.text.slice(0, 100)}`);

// ---- 3. Projects: odd names ----
const names = ['Plain project', '..\\escape', '../escape', 'con', 'a'.repeat(400), 'Ünï 名前', '<script>', 'trailing.', ' lead', 'x/y', 'C:\\x', '', '😀'];
const createdProjects = [];
for (const n of names) {
  const r = await call('POST', '/api/projects/create', { fromChat: true, name: n });
  if (r.status >= 500 || r.status === 0) bad('projects/create failed', `${JSON.stringify(n.slice(0, 40))} -> ${r.status} ${r.text.slice(0, 160)}`);
  const id = r.json?.id ?? r.json?.project?.id ?? r.json?.folder; if (id) createdProjects.push(id);
}
const afterProjects = files(root).filter(f => !before.has(f) && isOut(f));
expect('no project folder was made outside the workspace', afterProjects.length === 0, afterProjects.join(' | '));
console.log(`projects: ${names.length} names tried, ${createdProjects.length} accepted`);

// ---- 4. To-do rows ----
// A row names its project by ref (job:<id> or folder:<id>), as /api/todo lists them, not by the id projects/create returns.
const proj = ((await call('GET', '/api/todo')).json?.projects ?? [])[0]?.ref;
const rowIds = [];
if (!proj) console.log('todo: no project on this host to put rows under (make one first)');
if (proj) {
  for (let i = 0; i < 20; i++) { const r = await call('POST', '/api/todo/add', { project: proj, size: ['small', 'medium', 'large', 'x', 5, null][i % 6], note: `note ${i}`, zone: ['now', 'next', 'later', 'x', null][i % 5] }); if (r.status >= 500 || r.status === 0) bad('todo/add failed', `${r.status} ${r.text.slice(0, 160)}`); }
  const v = (await call('GET', '/api/todo')).json; const flat = JSON.stringify(v);
  const found = [...flat.matchAll(/"id":"?([\w-]+)"?/g)].map(m => m[1]).slice(0, 12); rowIds.push(...found);
  for (const id of rowIds) { for (const path of ['/api/todo/done', '/api/todo/set', '/api/todo/move']) { const r = await call('POST', path, { item: id, done: true, size: 'large', note: 'n', zone: 'later' }); if (r.status >= 500 || r.status === 0) bad(`${path} failed`, `${r.status} ${r.text.slice(0, 140)}`); } }
  await Promise.all(rowIds.map(id => call('POST', '/api/todo/remove', { item: id })));
}
console.log(`todo: ${rowIds.length} rows driven`);

// ---- 5. Notes ----
for (const t of ['a note', 'x'.repeat(100000), 'line\r\nbreak', '😀 emoji', '../../x']) { const r = await call('POST', '/api/notes/save', { text: t }); if (r.status >= 500 || r.status === 0) bad('notes/save failed', `${r.status} ${r.text.slice(0, 120)}`); }

// ---- 6. The host is still well ----
const st = await call('GET', '/api/status');
expect('the host still answers', st.status === 200, `${st.status}`);
console.log(`done: ${problems.length} problems`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(problems, null, 1));
