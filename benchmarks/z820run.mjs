// A sustained speed run on a LINKED PC (a node), driven from this PC's TOMLIN over the link (9-10 Nov 2026).
// It makes a temporary hire "Speed Test" whose model is remote:<PC_ID>:<MODEL_FILE>, warms it up (loads the model on the
// node, not counted), then sends a fresh chat of about 150 words after another for SECONDS (default 300), and prints the
// node's own tokens a second for each answer. The hire and its chats are deleted at the end (my own only).
//   $env:PC_ID = '<id>'; $env:MODEL_FILE = '<file>.gguf'; $env:THINK = '1'   (THINK=1 for a model that thinks, such as GPT-OSS)
//   node benchmarks/z820run.mjs      (SECONDS=300 by default; this PC's TOMLIN must be on http://127.0.0.1:8740)
// Do model copies (POST /api/network/send) first: a copy running at the same time skews the speed.
// A 5-minute sustained speed run on the Z820, driven from this PC's TOMLIN (a temporary hire on that PC, fresh chat per answer).
const base = process.env.BASE ?? 'http://127.0.0.1:8740';
const PC = process.env.PC_ID;
// No PC_ID: the hire answers on this PC’s own loaded model (the Z240 alone, or its Max mode / cluster load).
const MODEL = PC ? `remote:${PC}:${process.env.MODEL_FILE}` : '';
const SECONDS = Number(process.env.SECONDS ?? 300);
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

const hired = await (await post('/api/staff', { action: 'hire', name: 'Speed Test', role: 'default', level: 'default', ...(MODEL ? { model: MODEL } : {}) })).json();
const me = (hired.staff ?? []).find(s => s.name === 'Speed Test');
if (!me) { console.log('hire failed', JSON.stringify(hired).slice(0, 400)); process.exit(1); }
const who = `staff:${me.id}`;
log('hired', me.id, 'model', me.model);

const chats = [];
// A permission card (the model asked to use a tool: the files, the web) waits 10 minutes for an answer in the page, and
// this script has no page: most likely the 600 to 690 s answer in every run of 12 Nov 2026 (600 s, then the answer itself).
// Each card is answered "no" at once and counted, so it is seen and the run is not held up.
const permits = [];
async function ask(n, text) {
  const t0 = performance.now();
  const r = await post('/api/chat', { chatId: '', who, message: text, think: process.env.THINK === '1' });
  let body = '';
  let seen = 0;
  const dec = new TextDecoder();
  for await (const piece of r.body) {
    body += dec.decode(piece, { stream: true });
    const cards = body.split('event: permit\n').length - 1;
    for (; seen < cards; seen++) {
      const id = /"chat":"([^"]+)"/.exec(body)?.[1] ?? '';
      permits.push({ n, at: +((performance.now() - t0) / 1000).toFixed(1) });
      log(`#${n}: the model asked a permission (a tool); answered no at once`);
      await post('/api/chat/permit', { chatId: id, answer: 'no' }).catch(() => undefined);
    }
  }
  const secs = (performance.now() - t0) / 1000;
  const chat = /"chat":"([^"]+)"/.exec(body)?.[1];
  if (chat) chats.push(chat);
  const done = /event: done\ndata: (.*)/.exec(body);
  const err = /event: error\ndata: (.*)/.exec(body);
  const d = done ? JSON.parse(done[1]) : null;
  return { n, secs, d, err: err?.[1], chat };
}

const rows = [];
try {
  const warm = await ask(0, 'Run 0. Write about 150 words on why people bake their own bread. Plain sentences.');
  if (!warm.d) { log('warm-up failed:', (warm.err ?? 'no done event').slice(0, 400)); throw new Error('warm-up failed'); }
  log('warm-up (loads the model on the Z820), not counted:', warm.d.perSecond, 'tok/s,', warm.secs.toFixed(1), 's; done keys:', Object.keys(warm.d).join(', '));
  const t1 = performance.now();
  for (let n = 1; (performance.now() - t1) / 1000 < SECONDS; n++) {
    const r = await ask(n, `Run ${n}. Write about 150 words on why people bake their own bread. Plain sentences.`);
    if (!r.d) { log(`#${n} failed:`, (r.err ?? 'no done event').slice(0, 300)); continue; }
    const row = { n, atS: +((performance.now() - t1) / 1000).toFixed(0), secs: +r.secs.toFixed(1), perSecond: r.d.perSecond, tokens: r.d.tokens ?? r.d.outTokens ?? null, chars: (r.d.text ?? '').length };
    rows.push(row);
    log(`#${n} at ${row.atS}s: ${row.perSecond} tok/s, ${row.secs}s total, tokens ${row.tokens}, ${row.chars} chars`);
  }
} finally {
  for (const c of chats) await post('/api/chats/delete', { id: c }).catch(() => undefined);
  await post('/api/staff', { action: 'fire', id: me.id }).catch(() => undefined);
  log('cleaned up: my chats and the Speed Test hire removed');
}
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const ps = rows.map(r => r.perSecond).filter(x => x > 0);
log(`\nCounted answers: ${rows.length}; median ${med(ps)?.toFixed?.(2)} tok/s; range ${Math.min(...ps).toFixed?.(2)}-${Math.max(...ps).toFixed?.(2)}`);
const half = Math.floor(ps.length / 2) || 1;
log(`first half median ${med(ps.slice(0, half))?.toFixed?.(2)}, second half median ${med(ps.slice(half))?.toFixed?.(2)}`);
log('rows', JSON.stringify(rows));
if (permits.length) log(`permission cards answered no: ${permits.length}`, JSON.stringify(permits));



