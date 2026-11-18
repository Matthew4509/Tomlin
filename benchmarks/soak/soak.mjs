// A stability soak for TOMLIN's chat: many different messages, one fresh chat each, graded as far as a program can.
// It finds crashes, empty answers, errors, runaway reasoning and real stalls (wall time far above what the generated
// tokens at the model's own speed explain), and builds small projects (a game in one page, a Node program with tests)
// and checks that what comes back parses and runs.
//
//   node benchmarks/soak/soak.mjs                      (TOMLIN on http://127.0.0.1:8740, the model it has loaded)
//   BASE=http://127.0.0.1:8795 PC_ID=<id> MODEL_FILE=<file>.gguf node benchmarks/soak/soak.mjs   (a linked PC's model)
// Settings (environment): MODE=prompts|projects|both (default both), ONLY=<comma list of categories or project ids>,
// LIMIT=<n prompts per category>, ROUNDS=<n times through> (default 1), THINK=1 for Think, TIMEOUT_S=<per message>
// (default 600), OUT=<folder for the log and the built projects> (default benchmarks/soak/out/<time>), PROMPTS=<json>,
// PROJECTS=<json>. Everything it makes in TOMLIN (a temporary hire and its chats) is removed at the end.
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const base = env.BASE ?? 'http://127.0.0.1:8740';
const MODE = env.MODE ?? 'both';
const ROUNDS = Number(env.ROUNDS ?? 1);
const LIMIT = Number(env.LIMIT ?? 0);
const MAX_CONTINUES = Number(env.CONTINUES ?? 4);
const TIMEOUT_S = Number(env.TIMEOUT_S ?? 600);
const THINK = env.THINK === '1';
const only = (env.ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = env.OUT ?? join(here, 'out', stamp);
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, 'results.jsonl');
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

const loadJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const prompts = loadJson(env.PROMPTS ?? join(here, 'prompts.json'), []);
const projects = loadJson(env.PROJECTS ?? join(here, 'projects.json'), []);

// ---- one message, as the page sends it ----
async function send(who, message, chatId = '', path = '/api/chat') {
  const t0 = performance.now();
  const body = path === '/api/chat' ? { chatId, who, message, ...(THINK ? { think: true } : {}) } : { chatId, who };
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_S * 1000) }).catch(e => ({ ok: false, status: 0, text: async () => String(e.message) + (e.cause ? ` (${e.cause.code ?? e.cause.message ?? e.cause})` : '') }));
  if (!res.ok) return { secs: 0, chat: chatId, http: res.status, error: (await res.text()).slice(0, 300) };
  const dec = new TextDecoder();
  let partial = ''; const permitted = []; let buf = '', chat = chatId, done = null, error = null, weboff = null, room = null, permits = 0, thinkSecs = 0, thinkChars = 0, note = '';
  // The longest wait between two pieces of the answer (a stall with the answer half written), in seconds.
  let lastText = 0, maxGap = 0;
  try {
    for await (const piece of res.body) {
      buf += dec.decode(piece, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (\w+)/m.exec(block)?.[1]; const raw = /^data: (.*)$/m.exec(block)?.[1];
        let data = {}; try { data = JSON.parse(raw ?? '{}'); } catch { /* a half line */ }
        if (ev === 'text') { partial = data.text ?? partial; const now = performance.now(); if (lastText) maxGap = Math.max(maxGap, (now - lastText) / 1000); lastText = now; }
        if (ev === 'chat' && data.chat) chat = data.chat;
        else if (ev === 'done') done = data;
        else if (ev === 'error') error = data;
        else if (ev === 'weboff') weboff = data;
        else if (ev === 'thinking') { thinkSecs = data.seconds ?? thinkSecs; thinkChars = (data.text ?? '').length; }
        else if (ev === 'permit') { permits++; permitted.push(`${data.kind}: ${String(data.what ?? '').slice(0, 90)}`); await post('/api/chat/permit', { chatId: chat, answer: 'no' }).catch(() => undefined); }
        if (ev === 'error' && data.room) room = data.room;
      }
    }
  } catch (e) { error = { text: `stream broke after ${partial.length} characters had been written: ${e.message}` }; }
  const secs = (performance.now() - t0) / 1000;
  const text = done?.text ?? partial ?? '';
  return { secs, maxGap, chat, done, text, error: error?.text ?? null, weboff: !!weboff, roomCard: !!room, permits, permitted, thinkSecs, thinkChars, note: done?.note ?? note, perSecond: done?.perSecond ?? 0, tokens: done?.tokens ?? 0, cut: !!done?.cut, promptChars: message.length };
}

// ---- grading a plain-words expectation ----
function grade(expect, text) {
  for (const one of String(expect ?? 'none').split(';')) { const g = gradeOne(one, text); if (g) return g; }
  return null;
}
function gradeOne(expect, text) {
  const e = String(expect ?? 'none').trim(); const t = String(text ?? '');
  if (!e || e === 'none') return null;
  let m;
  if (/not empty/i.test(e) && t.trim().length === 0) return 'empty answer';
  if ((m = /^contains (.+)$/i.exec(e))) {
    const clean = x => x.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase();
    const low = t.toLowerCase();
    const ok = m[1].split(/ and /i).every(group => group.split(/ or /i).some(w => low.includes(clean(w))));
    return ok ? null : `missing: ${m[1]}`;
  }
  if (/valid json/i.test(e)) { const s = t.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''); try { JSON.parse(s); return null; } catch { return 'not valid JSON'; } }
  if ((m = /exactly (\d+) bullets?/i.exec(e))) { const n = (t.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length; return n === Number(m[1]) ? null : `${n} bullets, wanted ${m[1]}`; }
  if ((m = /(?:no more than|at most|under) (\d+) words?/i.exec(e))) { const n = t.trim().split(/\s+/).filter(Boolean).length; return n <= Number(m[1]) ? null : `${n} words, limit ${m[1]}`; }
  if ((m = /number equals (-?\d+(?:\.\d+)?)/i.exec(e))) {
    const WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    const nums = [...(t.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []).map(x => Number(x.replace(/,/g, ''))), ...(t.toLowerCase().match(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g) ?? []).map(w => WORDS[w])]; return nums.includes(Number(m[1])) ? null : `no ${m[1]} in the answer`; }
  if (/does not start with/i.test(e)) { const w = /does not start with ['"`]?([^'"`]+)['"`]?/i.exec(e)?.[1]?.trim(); return w && t.trim().toLowerCase().startsWith(w.toLowerCase()) ? `starts with "${w}"` : null; }
  return null;
}

// ---- finding what went wrong in a run ----
function judge(r, expect) {
  const faults = [];
  if (r.http) faults.push(`http ${r.http}`);
  if (r.error) faults.push(`error: ${r.error.slice(0, 120)}`);
  if (!r.error && !r.http && !r.text.trim()) faults.push('empty answer');
  if (r.maxGap > 60) faults.push(`no new words for ${r.maxGap.toFixed(0)} s mid-answer`);
  if (r.cut) faults.push(`still cut at the answer limit after ${r.continues ?? 0} Continue presses`);
  const g = r.text ? grade(expect, r.text) : null; if (g) faults.push(g);
  // A stall: the model's own count of generated tokens at its own speed explains the wall time, plus a load or read allowance.
  if (r.tokens > 0 && r.perSecond > 0) {
    const explained = r.tokens / r.perSecond; const slack = 25 + (r.promptChars ?? 0) / 3.5 / 20;
    if (r.secs > explained * 1.5 + slack) faults.push(`stall: ${r.secs.toFixed(0)} s for ${r.tokens} tokens at ${r.perSecond.toFixed(1)} tok/s (${explained.toFixed(0)} s explained)`);
  }
  // Reasoning that was not asked for: many more tokens than the visible answer needs.
  if (r.tokens > 0 && !THINK) { const visible = Math.ceil(r.text.length / 3.6); if (r.tokens > visible * 3 + 400) faults.push(`hidden reasoning: ${r.tokens} tokens for ${visible} visible`); }
  return faults;
}

const record = (row) => { appendFileSync(LOG, JSON.stringify(row) + '\n'); };

// ---- projects: take the fenced files out of the answer, check they parse and run ----
function filesFrom(text, wanted) {
  const files = {}; let cur = null, name = null; const lines = text.split(/\r?\n/);
  for (const l of lines) {
    if (cur === null) { if (/^```/.test(l)) { cur = []; name = /title=([^\s`]+)/.exec(l)?.[1] ?? null; } continue; }
    if (l === '```') { if (name) files[name] = cur.join('\n') + '\n'; cur = null; continue; }
    if (name === null && cur.length === 0) { const m = /^\s*(?:\/\/|#|<!--|\/\*)\s*(?:file(?:name)?:\s*)?([\w./-]+\.\w+)/i.exec(l); if (m) name = m[1]; }
    cur.push(l);
  }
  if (cur && name) files[name] = cur.join('\n') + '\n';
  for (const w of wanted ?? []) if (!files[w]) { const alt = Object.keys(files).find(k => k.endsWith('/' + w)); if (alt) files[w] = files[alt]; }
  return files;
}
const node = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60_000 });
function checkProject(p, text, dir) {
  const faults = []; mkdirSync(dir, { recursive: true });
  const files = filesFrom(text, p.deliverable);
  for (const w of p.deliverable ?? []) if (!files[w]) faults.push(`missing file ${w}`);
  for (const [n, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, n)), { recursive: true }); writeFileSync(join(dir, n), c); }
  if (Object.keys(files).length && !files['package.json'] && Object.keys(files).some(n => n.endsWith('.js'))) writeFileSync(join(dir, 'package.json'), Object.values(files).some(c => /\brequire\(|module\.exports/.test(c)) ? '{"type":"commonjs"}\n' : '{"type":"module"}\n');
  for (const [n, c] of Object.entries(files)) {
    if (/\.m?js$/.test(n)) { const r = node(['--check', n], dir); if (r.status !== 0) faults.push(`${n} does not parse: ${(r.stderr || '').split('\n').find(x => /Error/.test(x)) ?? 'syntax error'}`.slice(0, 160)); }
    if (/\.html?$/.test(n)) {
      const scripts = [...c.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
      if (!scripts.length) faults.push(`${n} has no script`);
      scripts.forEach((s, i) => { const f = join(dir, `.script-${i}.mjs`); writeFileSync(f, s); const r = node(['--check', f], dir); if (r.status !== 0) faults.push(`${n} script ${i + 1} does not parse`); });
      if (!/<(canvas|button|input|table|div|form)\b/i.test(c)) faults.push(`${n} has no visible element`);
    }
  }
  const test = Object.keys(files).find(n => /\.test\.m?js$/.test(n));
  if (test) { const r = node(['--test', test], dir); const out = (r.stdout || '') + (r.stderr || ''); const pass = /(?:# |ℹ )pass (\d+)/.exec(out)?.[1], fail = /(?:# |ℹ )fail (\d+)/.exec(out)?.[1]; if (r.status !== 0) faults.push(`its own tests fail (${pass ?? 0} pass, ${fail ?? '?'} fail)`); }
  // Hidden tests (hidden/<name>), written by the harness's owner and not shown to the model: run against what it delivered.
  let hidden = null;
  if (p.hidden && Object.keys(files).length) {
    copyFileSync(join(here, 'hidden', p.hidden), join(dir, p.hidden));
    copyFileSync(join(here, 'hidden', '_load.mjs'), join(dir, '_load.mjs'));
    const r = node(['--test', p.hidden], dir); const out = (r.stdout || '') + (r.stderr || '');
    const pass = Number(/(?:# |ℹ )pass (\d+)/.exec(out)?.[1] ?? 0), fail = Number(/(?:# |ℹ )fail (\d+)/.exec(out)?.[1] ?? 0);
    hidden = { pass, fail };
    if (r.status !== 0 || fail > 0 || pass === 0) faults.push(`hidden tests: ${pass} pass, ${fail} fail${pass + fail === 0 ? ' (they did not run: ' + (out.split(/\r?\n/).find(x => /Error/.test(x)) ?? 'no output').slice(0, 100) + ')' : ''}`);
  }
  // Acceptance statements that a program can check by looking at the text of the files.
  const all = Object.values(files).join('\n');
  for (const a of p.acceptance ?? []) {
    const s = a.toLowerCase();
    if (/canvas/.test(s) && /\b(has|contains|uses)\b/.test(s) && !/<canvas/i.test(all)) faults.push(`acceptance: ${a.slice(0, 80)}`);
    if (/local ?storage/.test(s) && !/localStorage/.test(all)) faults.push(`acceptance: ${a.slice(0, 80)}`);
    if (/requestanimationframe|animation loop|game loop/.test(s) && !/requestAnimationFrame|setInterval/.test(all)) faults.push(`acceptance: ${a.slice(0, 80)}`);
    if (/keyboard|keydown|space|arrow/.test(s) && /game|press|key/.test(s) && !/keydown|keyup|keypress|addEventListener/.test(all)) faults.push(`acceptance: ${a.slice(0, 80)}`);
  }
  return { faults, files: Object.keys(files), hidden };
}

// ---- the run ----
let hire = null; const chats = []; let crashes = 0; let aborted = false;
/** LOAD_URL (the model's load address) and STATUS_URL: load it again and wait until the chat pane says connected (up to 20 minutes). */
async function reconnect() {
  log('the model stopped: connecting it again');
  await post(new URL(env.LOAD_URL).pathname, { pane: 'chat' }).catch(() => undefined);
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await fetch(base + '/api/status').then(r => r.json()).catch(() => null);
    const state = st?.panes?.chat?.state;
    if (state === 'connected') return true;
    if (state === 'failed' && i % 12 === 11) await post(new URL(env.LOAD_URL).pathname, { pane: 'chat' }).catch(() => undefined);
  }
  return false;
}
async function main() {
  const model = env.PC_ID ? `remote:${env.PC_ID}:${env.MODEL_FILE}` : env.MODEL_REF ?? '';
  const HIRE = env.HIRE_NAME ?? 'Soak Test';
  const hired = await (await post('/api/staff', { action: 'hire', name: HIRE, role: 'default', level: 'default', ...(model ? { model } : {}) })).json();
  hire = (hired.staff ?? hired.members ?? []).find(s => s.name === HIRE);
  if (!hire) { log('hire failed', JSON.stringify(hired).slice(0, 300)); process.exit(1); }
  const who = `staff:${hire.id}`;
  const rows = [];
  const run = async (kind, id, category, turns, expect, project) => {
    if (aborted) { log(`skipped ${id}: the run was stopped (the model could not be reconnected)`); return; }
    const t0 = performance.now(); let r = null; let chat = '';
    const all = [];
    for (const turn of turns) {
      r = await send(who, turn, chat); chat = r.chat || chat; all.push(r);
      // The runner died (or was never loaded): press Connect as a person would, and ask once more.
      if (r.error && /No chat model is loaded|stopped on its own|stopped part-way|terminated/i.test(r.error) && env.LOAD_URL) { crashes++; const back = await reconnect(); if (back) { r = await send(who, turn, chat); chat = r.chat || chat; all.push(r); } else aborted = true; }
      if (r.error || r.http) break;
    }
    // An answer cut at the answer limit shows a Continue button: press it as a person would (up to 4 times).
    let continues = 0; let tokensAll = r.tokens;
    while (r.cut && !r.error && continues < MAX_CONTINUES) { const more = await send(who, '', chat, '/api/chat/continue'); continues++; tokensAll += more.tokens; r = { ...more, maxGap: Math.max(r.maxGap ?? 0, more.maxGap ?? 0), secs: r.secs + more.secs, tokens: more.tokens, promptChars: 0, text: more.text || r.text, cut: more.cut }; }
    r = { ...r, tokens: tokensAll, continues };
    if (chat) chats.push(chat);
    const faults = judge(r, expect);
    const row = { kind, id, category, secs: +((performance.now() - t0) / 1000).toFixed(1), turns: turns.length, continues: r.continues ?? 0, cut: !!r.cut, maxGap: +(r.maxGap ?? 0).toFixed(1), tokens: r.tokens, perSecond: +(r.perSecond || 0).toFixed(1), chars: r.text?.length ?? 0, thinkSecs: r.thinkSecs, weboff: r.weboff, roomCard: r.roomCard, permits: r.permits, permitted: r.permitted ?? [], note: (r.note ?? '').slice(0, 160), faults };
    if (project && r.text) { const d = join(OUT, 'built', id.replace(/[^\w.-]/g, '_') + '-' + rows.length); const c = checkProject(project, r.text, d); row.faults.push(...c.faults); row.files = c.files; if (c.hidden) row.hidden = c.hidden; row.dir = d; }
    rows.push(row); record(row);
    log(`${kind} ${id} [${category}] ${row.secs}s ${row.tokens ?? 0} tok ${row.faults.length ? 'FAULT: ' + row.faults.join(' | ').slice(0, 220) : 'ok'}`);
  };
  for (let round = 1; round <= ROUNDS; round++) {
    if (MODE !== 'projects') {
      const seen = {};
      for (const p of prompts) {
        if (only.length && !only.includes(p.category) && !only.includes(p.id)) continue;
        seen[p.category] = (seen[p.category] ?? 0) + 1; if (LIMIT && seen[p.category] > LIMIT) continue;
        const turns = Array.isArray(p.prompt) ? p.prompt : [typeof p.prompt === 'string' ? p.prompt : expand(p.prompt)];
        await run('prompt', p.id, p.category, turns.map(t => typeof t === 'string' ? t : expand(t)), p.expect);
      }
    }
    if (MODE !== 'prompts') {
      for (const p of projects) { if (only.length && !only.includes(p.id) && !only.includes(p.size)) continue; await run('project', p.id, p.size ?? 'project', [p.prompt], 'none', p); }
    }
  }
  return rows;
}
/** A long input given as a rule in the corpus: {"repeat": "text", "times": 200}, or {"parts": [text or such a rule, ...]}. */
function expand(x) {
  if (x && typeof x === 'object' && Array.isArray(x.parts)) return x.parts.map(expand).join('');
  return x && typeof x === 'object' && x.repeat ? String(x.repeat).repeat(Number(x.times ?? 1)) : String(x);
}

let rows = [];
try { rows = await main(); } finally {
  for (const c of chats) await post('/api/chats/delete', { id: c }).catch(() => undefined);
  if (hire) await post('/api/staff', { action: 'fire', id: hire.id }).catch(() => undefined);
  log('cleaned up: the Soak Test hire and its chats removed');
}
// ---- the summary ----
const bad = rows.filter(r => r.faults.length);
const by = {};
for (const r of rows) { const k = r.category; by[k] ??= { n: 0, bad: 0, stall: 0, hidden: 0, empty: 0, err: 0 }; const b = by[k]; b.n++; if (r.faults.length) b.bad++; for (const f of r.faults) { if (f.startsWith('stall')) b.stall++; else if (f.startsWith('hidden reasoning')) b.hidden++; else if (f.startsWith('empty')) b.empty++; else if (f.startsWith('error') || f.startsWith('http')) b.err++; } }
const lines = ['# Soak summary', '', `${rows.length} messages, ${bad.length} with a fault (${rows.length ? ((bad.length / rows.length) * 100).toFixed(1) : 0} %). THINK=${THINK ? 'on' : 'off'}, base ${base}${env.PC_ID ? `, PC ${env.PC_ID}` : ''}.`, '', '| category | n | faulty | stalls | hidden reasoning | empty | errors |', '|---|---|---|---|---|---|---|'];
for (const [k, b] of Object.entries(by)) lines.push(`| ${k} | ${b.n} | ${b.bad} | ${b.stall} | ${b.hidden} | ${b.empty} | ${b.err} |`);
lines.push('', `Runner crashes recovered by connecting again: ${crashes}${aborted ? ' (the run was stopped: the model could not be reconnected)' : ''}.`);
lines.push('', '## Faults', ...bad.map(r => `- ${r.kind} ${r.id} (${r.category}, ${r.secs} s): ${r.faults.join('; ')}`));
writeFileSync(join(OUT, 'summary.md'), lines.join('\n') + '\n');
console.log('\n' + lines.slice(0, 4 + Object.keys(by).length + 2).join('\n'));
console.log(`\nFull log: ${LOG}\nSummary: ${join(OUT, 'summary.md')}`);
