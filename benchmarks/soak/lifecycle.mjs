// Chat life-cycle checks against a scratch host with a model (here or on a linked PC): Stop, closing the page, deleting a chat
// mid-answer, two chats at once, and whether a fact told early is still known after the chat has been folded.
//   BASE=http://127.0.0.1:8797 PC_ID=<id> MODEL_FILE=<file>.gguf node benchmarks/soak/lifecycle.mjs     (or no PC_ID for a model loaded here)
const base = process.env.BASE ?? 'http://127.0.0.1:8797';
const model = process.env.PC_ID ? `remote:${process.env.PC_ID}:${process.env.MODEL_FILE}` : process.env.MODEL_REF ?? '';
const problems = [];
const say = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const bad = (what, detail = '') => { problems.push({ what, detail: String(detail).slice(0, 400) }); say('PROBLEM', what, '-', String(detail).slice(0, 300)); };
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(60_000) });
const json = async (p) => (await fetch(base + p, { signal: AbortSignal.timeout(30_000) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One message as the page sends it. `until(text)` true: the connection is closed from here (a closed page) after that text. */
async function send(who, message, chatId = '', o = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), (o.timeout ?? 900) * 1000);
  const out = { chat: chatId, text: '', done: null, error: null, secs: 0, closed: false };
  const t0 = Date.now();
  try {
    const res = await fetch(base + (o.path ?? '/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId, who, message, ...(o.extra ?? {}) }), signal: ac.signal });
    if (!res.ok) { out.error = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`; return out; }
    const dec = new TextDecoder(); let buf = '';
    for await (const piece of res.body) {
      buf += dec.decode(piece, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (\w+)/m.exec(block)?.[1]; let d = {}; try { d = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}'); } catch { /* half */ }
        if (ev === 'chat' && d.chat) out.chat = d.chat;
        else if (ev === 'text') out.text = d.text ?? out.text;
        // 'done' carries the whole answer: the last few words can come only there (text events are sent at most every 150 ms).
        else if (ev === 'done') { out.done = d; if (typeof d.text === 'string') out.text = d.text; }
        else if (ev === 'error') out.error = d.text ?? 'error';
        else if (ev === 'permit') await post('/api/chat/permit', { chatId: out.chat, answer: 'no' }).catch(() => undefined);
        if (o.until?.(out)) { out.closed = true; ac.abort(); return out; }
      }
    }
  } catch (e) { if (!out.closed) out.error = out.error ?? `stream broke: ${e.message}`; }
  finally { clearTimeout(timer); out.secs = (Date.now() - t0) / 1000; }
  return out;
}
const lines = async (chat) => (await json('/api/chat?id=' + encodeURIComponent(chat))).lines ?? [];

const hired = await (await post('/api/staff', { action: 'hire', name: process.env.HIRE_NAME ?? 'Life Test', role: 'default', level: 'default', ...(model ? { model } : {}) })).json();
const hire = (hired.staff ?? hired.members ?? []).find(s => s.name === (process.env.HIRE_NAME ?? 'Life Test'));
if (!hire) { say('hire failed', JSON.stringify(hired).slice(0, 300)); process.exit(1); }
const who = `staff:${hire.id}`;
const LONG = 'Write a long, detailed essay of about 900 words on the history of the bicycle, in plain paragraphs.';
const alive = async () => (await fetch(base + '/api/status', { signal: AbortSignal.timeout(15_000) }).catch(() => ({ ok: false }))).ok;

// Warm-up (loads the model on the other PC).
const warm = await send(who, 'Say OK.', '', { timeout: 1500 });
say('warm-up', warm.error ?? `${warm.secs.toFixed(0)} s`);
if (warm.error) { bad('the model did not answer the first message', warm.error); process.exit(1); }
const checkNext = async (label) => {
  const r = await send(who, 'Reply with the single word READY.', '', { timeout: 300 });
  if (r.error || !/ready/i.test(r.text)) bad(`${label}: the next message did not get a normal answer`, r.error ?? r.text.slice(0, 120));
  else say(`${label}: next message ok in ${r.secs.toFixed(0)} s`);
};

// A. Stop pressed mid-answer.
{
  const r = await send(who, LONG, '', { until: o => o.text.length > 200 });
  say('A: stopping after', r.text.length, 'characters');
  const s = await post('/api/chat/stop', { chatId: r.chat }).catch(() => null);
  await sleep(3000);
  const l = await lines(r.chat);
  const last = l.at(-1);
  if (last?.role === 'assistant' && last.content.length < 20) bad('A: Stop left an empty answer in the chat', JSON.stringify(last).slice(0, 200));
  if (!(await alive())) bad('A: the host stopped answering after Stop');
  await checkNext('A');
}
// B. The page is closed mid-answer: the answer is still finished and kept.
{
  const r = await send(who, LONG, '', { until: o => o.text.length > 200 });
  say('B: page closed after', r.text.length, 'characters');
  let kept = null;
  for (let i = 0; i < 90; i++) { await sleep(5000); const l = await lines(r.chat); const a = l.at(-1); if (a?.role === 'assistant' && a.content.length > r.text.length + 300) { kept = a.content.length; break; } }
  if (kept === null) bad('B: after the page closed, the answer was not finished and kept', 'no longer answer in the chat after 7 minutes');
  else say('B: answer kept,', kept, 'characters');
  await checkNext('B');
}
// C. The chat is deleted while it is answering.
{
  const p = send(who, LONG, '', { until: undefined });
  await sleep(15_000);
  const list = (await json('/api/chats')).chats ?? [];
  const mine = list.find(c => c.who === who && c.live) ?? list.find(c => c.who === who);
  if (mine) { const d = await post('/api/chats/delete', { id: mine.id }); say('C: deleted the chat mid-answer:', d.status); }
  const r = await p;
  say('C: the stream ended:', r.error ?? 'done', `${r.secs.toFixed(0)} s`);
  if (!(await alive())) bad('C: the host stopped answering after a chat was deleted mid-answer');
  await checkNext('C');
}
// D. Two chats at once.
{
  const [x, y] = await Promise.all([send(who, 'Name three rivers in Europe, one line each.', '', { timeout: 900 }), send(who, 'Name three mountains in Asia, one line each.', '', { timeout: 900 })]);
  for (const [n, r] of [['first', x], ['second', y]]) {
    if (r.error && !/busy|wait|one at a time|another/i.test(r.error)) bad(`D: the ${n} of two chats at once failed`, r.error);
    else if (!r.error && r.text.trim().length < 20) bad(`D: the ${n} of two chats at once came back empty`);
    say(`D: ${n}:`, r.error ?? `${r.text.length} characters in ${r.secs.toFixed(0)} s`);
  }
  await checkNext('D');
}
// (Retry only replaces an answer that failed; it is covered by test/ in the unit suite, not here.)
// F. A fact told early is known after the chat has grown past the context and been folded.
{
  const first = await send(who, 'Please remember this: my cat is called Bartholomew and my locker code is 7342. Reply with just "Noted".', '', { timeout: 300 });
  let chat = first.chat;
  const filler = (i) => `Part ${i} of my report. ` + 'The quarterly figures for the northern region show a steady rise in the number of customers served, with the largest gains in the autumn months, when new stores opened and the delivery service was extended to the surrounding villages. '.repeat(7);
  let failedAt = 0;
  for (let i = 1; i <= 24; i++) {
    const r = await send(who, `${filler(i)}\n\nReply with just the word "Noted".`, chat, { timeout: 600 });
    if (r.error) { failedAt = i; bad(`F: filler turn ${i} failed`, r.error); break; }
    chat = r.chat || chat;
  }
  const ask = await send(who, 'What is my cat called, and what is my locker code? Answer in one short sentence.', chat, { timeout: 600 });
  say('F: asked after the fold:', ask.error ?? ask.text.slice(0, 160).replace(/\n/g, ' '));
  if (!ask.error && !(/bartholomew/i.test(ask.text) && /7342/.test(ask.text))) bad('F: a fact told at the start was lost after the chat grew', ask.text.slice(0, 200));
  if (ask.error && !failedAt) bad('F: the question after the long chat failed', ask.error);
}
say(`done: ${problems.length} problems`);
console.log(JSON.stringify(problems, null, 1));
