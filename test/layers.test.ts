import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIG_READ_TOKENS, buildLayered, ChatLogs, cleanEditedSum, cleanFoldWait, cleanSum, findInChat, isBigRead, keepBig, layeredFor, layerReadSpeed, leaving, LOG_CHARS, logFull, logText, recallLine, shortTokens, startIn, SUM_BLOCK_CHARS, SUM_CHARS, sumAsk, sumsText, type LayerInput, type LogLine, type SumBlock } from '../src/layers.ts';
import { buildChat, type NoteLine } from '../src/memory.ts';
import { Store, type ChatLine } from '../src/store.ts';

const note = (text: string, i = 0): NoteLine => ({ id: `n${i}`, text, at: '2026-10-04T10:00:00Z', from: 'owner' });
const log = (kind: LogLine['kind'], text: string, i = 0, done?: string): LogLine => ({ id: `l${i}`, kind, text, at: `2026-10-21T10:00:${String(i).padStart(2, '0')}Z`, ...(done ? { done } : {}) });
/** A chat of `n` message pairs, each message `size` characters, a second apart. */
function chat(n: number, size = 600, from = 0): ChatLine[] {
  const out: ChatLine[] = [];
  for (let i = from; i < from + n; i++) {
    const at = (k: number) => new Date(Date.UTC(2026, 9, 21, 9, 0, 0) + (2 * i + k) * 1000).toISOString();
    out.push({ role: 'user', content: `Q${i} ${'q'.repeat(size)}`, at: at(0) });
    out.push({ role: 'assistant', content: `A${i} ${'a'.repeat(size)}`, at: at(1) });
  }
  return out;
}
const base = (o: Partial<LayerInput> = {}): LayerInput => ({ ctx: 32768, maxAnswer: 4096, card: 'You are Sam, the shop assistant.', rules: 'RULES', team: [note('Prices include VAT')], own: null, name: 'Sam', history: [], message: 'Hello', log: [], sent: null, readPerSecond: 19, foldMinutes: 4, ...o });

test('the recent messages kept word for word come from the read speed and the fold wait (measured speeds from the plan)', () => {
  // A3B on the 1060: 19 tokens a second read, 4 minutes, a 2k log above: 19 x 240 - 2,000 = 2,560.
  assert.equal(shortTokens(19, 4, 2000, 20000), 2560);
  // 8 minutes gives about 7k.
  assert.equal(shortTokens(19, 8, 2000, 20000), 7120);
  // 4B on CUDA, 54 tokens a second: 54 x 240 - 2,000 = 10,960.
  assert.equal(shortTokens(54, 4, 2000, 20000), 10960);
  // Never below 2,000 (a slow PC still sees the last few messages), never more than the room.
  assert.equal(shortTokens(5, 1, 3000, 20000), 2000);
  assert.equal(shortTokens(54, 15, 0, 9000), 9000);
  // No speed measured yet: the smallest, so a fold that follows the first real figure is not the next turn.
  assert.equal(shortTokens(0, 4, 2000, 20000), 2000);
  // And never more than the room, even when the room is under 2,000.
  assert.equal(shortTokens(19, 4, 0, 1200), 1200);
});

test('the read speed the layers size from comes from big reads only (small ones carry start-up time)', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 22, 9, m)).toISOString();
  // Measured 21-22 Oct on the laptop: small reads (about 275 tokens) slid the figure from 7.5 to 2.9 tokens a second.
  let big = keepBig(undefined, 275, 2.9, at(0));
  assert.equal(big, undefined, 'a small read sets nothing');
  big = keepBig(big, 900, 4.5, at(1));
  assert.equal(big, undefined, 'under 1,000 tokens is still small');
  big = keepBig(big, BIG_READ_TOKENS, 7.5, at(2));
  assert.deepEqual(big, { perSecond: 7.5, tokens: 1000, at: at(2) });
  assert.equal(keepBig(big, 300, 2.9, at(3)), big, 'a later small read does not lower it');
  assert.deepEqual(keepBig(big, 4000, 19, at(4)), { perSecond: 19, tokens: 4000, at: at(4) }, 'a later big read replaces it (another driver, another runner)');
  assert.equal(keepBig(big, 5000, 0, at(5)), big, 'no speed: kept');
  // The layers: the big figure, else the speed finder's measured read, else none (the window's minimum).
  assert.equal(layerReadSpeed({ big: { perSecond: 19, tokens: 4000, at: at(0) } }, 54), 19);
  assert.equal(layerReadSpeed({}, 54), 54);
  assert.equal(layerReadSpeed(null, null), 0);
  assert.equal(layerReadSpeed(undefined, undefined), 0);
  // A linked PC's answer counts only when it says it read 1,000 tokens or more.
  assert.equal(isBigRead(999), false);
  assert.equal(isBigRead(1000), true);
  assert.equal(isBigRead(undefined), false);
});

test('the fold wait is a whole number of minutes from 1 to 15, else the default 4', () => {
  assert.equal(cleanFoldWait(undefined), 4);
  assert.equal(cleanFoldWait(1), 1);
  assert.equal(cleanFoldWait(15), 15);
  assert.equal(cleanFoldWait(0), 4);
  assert.equal(cleanFoldWait(16), 4);
  assert.equal(cleanFoldWait(2.5), 4);
  assert.equal(cleanFoldWait('6'), 4);
});

test('layers are for a context of 16k or more, not a Default hire, and not a chat with its tick off', () => {
  assert.equal(layeredFor(16384, false, undefined), true);
  assert.equal(layeredFor(262144, false, false), true);
  assert.equal(layeredFor(8192, false, undefined), false);
  assert.equal(layeredFor(32768, true, undefined), false);
  assert.equal(layeredFor(32768, false, true), false);
});

test('the chat log: grouped by kind, open to-dos before done ones, done and learned lines drop first when it is over its size', () => {
  const lines = [log('fact', 'The van is 3.5 t', 1), log('decision', 'Sell the upright', 2), log('todo', 'Ring the buyer', 3), log('todo', 'Book the van', 4, '2026-10-21'), log('learned', 'Mondays are slow', 5)];
  const t = logText(lines);
  assert.ok(t.text.indexOf('Decisions:') < t.text.indexOf('To do:'));
  assert.ok(t.text.indexOf('To do:') < t.text.indexOf('Done:'));
  assert.ok(t.text.indexOf('Done:') < t.text.indexOf('Learned:'));
  assert.ok(t.text.indexOf('Learned:') < t.text.indexOf('Names and numbers:'));
  assert.match(t.text, /- Book the van/);
  assert.equal(t.dropped, 0);
  assert.deepEqual(new Set(t.ids), new Set(['l1', 'l2', 'l3', 'l4', 'l5']));
  assert.equal(logText([]).text, '');
  // Over the size: the oldest done to-do goes first, then the oldest learned line; decisions never.
  const long = (c: string) => c.repeat(290);
  const many = [...Array.from({ length: 16 }, (_, i) => log('decision', `${i} ${long('d')}`, i)), log('todo', long('t'), 20, '2026-10-20'), log('todo', long('u'), 21, '2026-10-21'), log('learned', long('l'), 22), log('learned', long('m'), 23), log('fact', long('f'), 24)];
  const cut = logText(many);
  assert.ok(cut.text.length <= LOG_CHARS, `${cut.text.length}`);
  assert.ok(cut.dropped >= 1);
  assert.ok(!cut.ids.includes('l20'), 'the oldest done to-do went first');
  for (let i = 0; i < 16; i++) assert.ok(cut.ids.includes(`l${i}`), `decision ${i} kept`);
  assert.ok(cut.ids.includes('l24'), 'names and numbers kept');
});

test('a line that would push decisions, open to-dos and names and numbers over the size is refused, with the way out', () => {
  const full = Array.from({ length: 19 }, (_, i) => log('decision', `${i} ${'d'.repeat(295)}`, i));
  assert.equal(logFull(full.slice(0, 5), 'decision', 'one more'), '');
  const why = logFull(full, 'decision', 'x'.repeat(290));
  assert.match(why, /full/);
  assert.match(why, /Done|delete/i);
  // A learned line can always be added: it is dropped first when the log is over its size.
  assert.equal(logFull(full, 'learned', 'x'.repeat(290)), '');
});

test('first turn: the log, notebooks and card at the top, in that order, and a record of what was sent', () => {
  const r = buildLayered(base({ log: [log('decision', 'Sell the upright', 1)], history: chat(2), opening: 'We were pricing the upright.' }));
  assert.equal(r.layered, true);
  const sys = r.turns[0];
  assert.equal(sys.role, 'system');
  const at = (s: string) => sys.content.indexOf(s);
  assert.ok(at('You are Sam') === 0);
  assert.ok(at('RULES') > 0 && at('RULES') < at('Prices include VAT'), 'the rules sit with the card, above everything that changes');
  assert.ok(at('Prices include VAT') < at('We were pricing the upright.'));
  assert.ok(at('We were pricing the upright.') < at('Sell the upright'));
  assert.equal(r.turns.at(-1)?.content, 'Hello');
  assert.equal(r.turns.length, 1 + 4 + 1);
  assert.ok(r.sent.upper.includes('Sell the upright'));
  assert.equal(r.sent.ctx, 32768);
  assert.equal(r.folded, true);
  assert.equal(r.logWaiting, false);
});

test('between folds the start of the prompt is byte-identical: new log lines and notebook lines wait for the fold', () => {
  const first = buildLayered(base({ history: chat(2), log: [log('decision', 'Sell the upright', 1)] }));
  const later = buildLayered(base({
    history: [...chat(2), ...chat(1, 600, 2)],
    message: 'And the van?',
    sent: first.sent,
    log: [log('decision', 'Sell the upright', 1), log('todo', 'Book the van', 2)],
    team: [note('Prices include VAT'), note('Closed on Mondays', 1)],
  }));
  assert.equal(later.folded, false);
  assert.equal(later.turns[0].content, first.turns[0].content, 'the system message did not change');
  // Every turn the first one sent is still there, unchanged, in the same place (only the new message moved on).
  for (let i = 0; i < first.turns.length - 1; i++) assert.deepEqual(later.turns[i], first.turns[i]);
  assert.ok(!later.turns[0].content.includes('Book the van'));
  assert.ok(!later.turns[0].content.includes('Closed on Mondays'));
  assert.equal(later.logWaiting, true);
  assert.equal(later.sent, first.sent);
});

test('a fold: the recent messages pass their size, the oldest third leaves, and the waiting lines go in at the same moment', () => {
  // 19 tokens a second x 4 min - the top = about 2.5k tokens = about 7.5k characters of recent messages.
  const one = buildLayered(base({ history: chat(4), log: [log('decision', 'Sell the upright', 1)] }));
  assert.equal(one.older, 0);
  const grown = chat(12);
  const two = buildLayered(base({ history: grown, sent: one.sent, log: [log('decision', 'Sell the upright', 1), log('todo', 'Book the van', 2)] }));
  assert.equal(two.folded, true);
  assert.ok(two.older > 0, 'older messages left the prompt');
  assert.ok(two.turns[0].content.includes('Book the van'), 'the waiting line went in with the fold');
  assert.equal(two.logWaiting, false);
  const recentChars = two.turns.slice(1, -1).reduce((n, t) => n + t.content.length + 8, 0) + 'Hello'.length;
  assert.ok(recentChars <= two.shortTokens * 3 * (2 / 3) + 700, `after a fold the recent messages fill about two thirds (${recentChars} of ${two.shortTokens * 3})`);
  assert.equal(two.sent.from, grown[two.older].at);
  // The next turn, one message pair more: no fold, the same start.
  const three = buildLayered(base({ history: [...grown, ...chat(1, 600, 12)], sent: two.sent, log: [log('decision', 'Sell the upright', 1), log('todo', 'Book the van', 2)] }));
  assert.equal(three.folded, false);
  assert.equal(three.older, two.older);
  assert.equal(three.turns[0].content, two.turns[0].content);
});

test('a fold always starts the word-for-word part on one of his messages (a chat template refuses an answer first)', () => {
  // Measured 21 Oct: Ministral's template raised "roles must alternate" when a fold started on an answer.
  const sizes = [300, 2500, 300, 2500, 300, 2500, 300, 2500, 300, 2500];
  for (let k = 0; k < 40; k++) {
    const h = chat(8 + k, 0).map((l, i) => ({ ...l, content: `${l.content} ${'x'.repeat(sizes[(i + k) % sizes.length])}` }));
    const r = buildLayered(base({ history: h }));
    assert.equal(r.turns[1]?.role ?? 'user', 'user', `chat of ${h.length}: starts on ${r.turns[1]?.role}`);
    if (r.older < h.length) assert.equal(h[r.older].role, 'user');
  }
});

test('after a fold whose cut fell on an answer, the next turn does not fold again (the record starts where sending starts)', () => {
  const sizes = [300, 2500, 300, 2500, 300, 2500, 300, 2500, 300, 2500];
  let cutOnAnswer = 0;
  for (let k = 0; k < 40; k++) {
    const h = chat(8 + k, 0).map((l, i) => ({ ...l, content: `${l.content} ${'x'.repeat(sizes[(i + k) % sizes.length])}` }));
    const one = buildLayered(base({ history: h }));
    if (!one.folded) continue;
    if (one.older > 0 && h[one.older - 1].role === 'assistant' && h[one.older].role === 'user') cutOnAnswer++;
    assert.equal(startIn(h, one.sent), one.older, `chat of ${h.length}: the record starts at the first message sent`);
    const two = buildLayered(base({ history: [...h, ...chat(1, 0)], sent: one.sent }));
    assert.equal(two.folded, false, `chat of ${h.length}: folded again on the next turn`);
    assert.equal(two.older, one.older);
  }
  assert.ok(cutOnAnswer > 0, 'some cuts fell on an answer');
});

test('a saved fold record that starts on an answer (saved before this fix) is not trusted: it folds onto one of his', () => {
  const h = chat(6);
  const bad = buildLayered(base({ history: h })).sent;
  const r = buildLayered(base({ history: h, sent: { ...bad, from: h[3].at, n: 3 } }));
  assert.equal(r.folded, true);
  assert.equal(r.turns[1].role, 'user');
});

test('a smaller chat (today\'s builder) also starts its recent messages on one of his', () => {
  for (let k = 0; k < 40; k++) {
    // His messages long, the answers short: the cut lands on an answer when nothing moves it.
    const h = chat(6 + k, 0).map((l, i) => ({ ...l, content: `${l.content} ${'x'.repeat(i % 2 ? 300 : 2500 + 97 * (k % 7))}` }));
    const r = buildChat({ ctx: 8192, maxAnswer: 4096, card: 'card', team: null, own: null, name: 'Sam', history: h, message: 'Hello' });
    assert.equal(r.turns[1]?.role ?? 'user', 'user', `chat of ${h.length}`);
  }
});

test('a faster PC keeps more recent messages word for word; a slower one folds sooner', () => {
  const h = chat(20);
  const slow = buildLayered(base({ history: h, readPerSecond: 19 }));
  const fast = buildLayered(base({ history: h, readPerSecond: 54 }));
  assert.ok(fast.older < slow.older, `${fast.older} < ${slow.older}`);
  assert.ok(fast.shortTokens > slow.shortTokens);
  assert.ok(fast.foldSeconds > 0 && slow.foldSeconds > 0);
  // A longer fold wait keeps more too.
  const patient = buildLayered(base({ history: h, readPerSecond: 19, foldMinutes: 10 }));
  assert.ok(patient.older < slow.older);
});

test('a different context, a record marked stale, or a lost start line makes a fresh top; stale keeps the same start when it fits', () => {
  const one = buildLayered(base({ history: chat(12), log: [log('decision', 'A', 1)] }));
  assert.equal(buildLayered(base({ ctx: 65536, history: chat(12), sent: one.sent })).folded, true);
  const stale = buildLayered(base({ history: chat(12), sent: { ...one.sent, stale: true }, log: [log('decision', 'A', 1), log('decision', 'B', 2)] }));
  assert.equal(stale.folded, true);
  assert.equal(stale.older, one.older, '"Send them now" brings the new lines in without dropping more messages');
  assert.ok(stale.turns[0].content.includes('- B'));
  // The line the recent messages started from was deleted: a fold.
  const gone = chat(12).filter(l => l.at !== one.sent.from);
  assert.equal(buildLayered(base({ history: gone, sent: one.sent })).folded, true);
});

test('a message brought back with Find, then his message: one turn of his, not two in a row', () => {
  const h = [...chat(1), recallLine({ role: 'assistant', content: 'The upright is 1,200.', at: '2026-10-20T08:00:00Z' }, 'Sam', '2026-10-21T10:00:00Z')];
  const r = buildLayered(base({ history: h, message: 'Is that still right?' }));
  const last = r.turns.at(-1)!;
  assert.equal(last.role, 'user');
  assert.match(last.content, /^From earlier in this chat \(2026-10-20\), Sam wrote:\nThe upright is 1,200\.\n\nIs that still right\?$/);
  assert.equal(r.turns.filter(t => t.role === 'user').length, 2);
});

test('the parts "What X reads" shows: the log, the older messages kept out, and the recent ones with their limit', () => {
  const r = buildLayered(base({ history: chat(12), log: [log('decision', 'A', 1)] }));
  const keys = r.parts.map(p => p.key);
  assert.deepEqual(keys, ['card', 'team', 'log', 'older', 'recent', 'message']);
  const older = r.parts.find(p => p.key === 'older')!;
  assert.equal(older.state, 'left out');
  assert.match(older.note ?? '', /Find in this chat/);
  assert.match(r.parts.find(p => p.key === 'recent')!.note ?? '', /about [\d,]+ tokens/);
  const empty = buildLayered(base({ history: chat(1) }));
  assert.equal(empty.parts.find(p => p.key === 'log')!.state, 'none');
  assert.equal(empty.parts.find(p => p.key === 'older')!.state, 'none');
});

test('Find in this chat: only the older messages, best match first, and nothing when all of it is still read', () => {
  const h = chat(6);
  h[2] = { ...h[2], content: 'The upright Bechstein is 1,200 pounds' };
  h[4] = { ...h[4], content: 'We talked about the upright stool' };
  const found = findInChat(h, 'bechstein upright price', 8);
  assert.equal(found[0].at, h[2].at);
  assert.ok(found.some(f => f.at === h[4].at));
  assert.ok(found.every(f => h.findIndex(l => l.at === f.at) < 8));
  assert.deepEqual(findInChat(h, 'bechstein', 0), []);
  assert.deepEqual(findInChat(h, '   ', 8), []);
});

test('the chat log on disk: add, edit, Done, delete, copy into a carried-on chat, and the record of what was sent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-layers-'));
  try {
    const store = new Store(dir);
    const logs = new ChatLogs(store);
    const id = 'a1b2c3d4e5f6';
    const a = await logs.add(id, 'todo', '  Ring   the buyer ');
    assert.ok(!('error' in a));
    assert.equal(a.text, 'Ring the buyer');
    assert.ok('error' in (await logs.add(id, 'decision', '   ')));
    assert.ok('error' in (await logs.add(id, 'bogus' as LogLine['kind'], 'x')));
    const done = await logs.edit(id, a.id, { done: true });
    assert.ok(!('error' in done) && !!done.done);
    const back = await logs.edit(id, a.id, { done: false, text: 'Ring the buyer at 5' });
    assert.ok(!('error' in back) && !back.done && back.text === 'Ring the buyer at 5');
    await logs.setSent(id, { from: '', n: 0, upper: 'U', logText: '', ctx: 32768, at: '2026-10-21T10:00:00Z', parts: [] });
    await logs.stale(id);
    assert.equal((await logs.read(id)).sent?.stale, true);
    const other = 'f6e5d4c3b2a1';
    await logs.copy(id, other);
    assert.equal((await logs.read(other)).lines.length, 1);
    assert.equal((await logs.read(other)).sent, null, 'a carried-on chat starts its own record');
    assert.equal(await logs.remove(id, a.id), true);
    assert.equal(await logs.remove(id, a.id), false);
    await logs.drop(other);
    assert.deepEqual((await logs.read(other)).lines, []);
    await assert.rejects(() => logs.read('../x'));
    assert.ok(!(await readdir(join(dir, 'chats'))).includes(`${other}-log.json`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Fold summaries (the chat's "Sum up what a fold lets go", off unless ticked) ----

const sum = (i: number, text = `- Point ${i}`, n = 4): SumBlock => ({ id: `s${i}`, at: `2026-11-24T10:00:${String(i).padStart(2, '0')}Z`, from: '2026-11-20T09:00:00Z', to: '2026-11-21T09:00:00Z', n, text, by: 'Qwen3 on this PC' });

test('fold summaries as sent: oldest first under their own title, the oldest left out when over the size', () => {
  assert.deepEqual(sumsText([]), { text: '', ids: [], dropped: 0 });
  const two = sumsText([sum(1), sum(2)]);
  assert.match(two.text, /^Earlier in this chat \(summed up by the model/);
  assert.ok(two.text.indexOf('- Point 1') < two.text.indexOf('- Point 2'));
  assert.match(two.text, /\(4 messages, 2026-11-20 to 2026-11-21\)/);
  const many = sumsText(Array.from({ length: 12 }, (_, i) => sum(i, `- ${'x'.repeat(1400)}`)));
  assert.ok(many.text.length <= SUM_CHARS, `${many.text.length}`);
  assert.ok(many.dropped > 0);
  assert.equal(many.ids.at(-1), 's11', 'the newest is always kept');
  assert.ok(!many.ids.includes('s0'), 'the oldest went first');
});

test('the messages a fold lets go: from where the last fold started to where this one starts', () => {
  const h = chat(6);
  assert.deepEqual(leaving(h, null, 4), h.slice(0, 4), 'no fold before: from the start');
  const was = { from: h[4].at, n: 4, upper: '', logText: '', ctx: 32768, at: '', parts: [] };
  assert.deepEqual(leaving(h, was, 8), h.slice(4, 8));
  assert.deepEqual(leaving(h, was, 4), [], 'the same start ("Send them now"): nothing leaves');
  assert.deepEqual(leaving(h, was, 2), [], 'a start that moved back: nothing leaves');
  // Refused and empty lines are never sent, so they are not counted or summed up.
  const withFault: ChatLine[] = [h[0], { role: 'assistant', content: 'No model', at: 'x', failed: true }, ...h.slice(1)];
  assert.deepEqual(leaving(withFault, null, 2), h.slice(0, 2));
});

test('the summary ask: the leaving messages as a transcript, the newest that fit, and what was left out', () => {
  const h = chat(3, 100);
  const a = sumAsk(h, 'Sam', 100_000)!;
  assert.equal(a.turns[0].role, 'system');
  assert.match(a.turns[0].content, /invent nothing/);
  assert.match(a.turns[1].content, /^They: Q0 /);
  assert.match(a.turns[1].content, /Sam: A2 /);
  assert.equal(a.n, 6);
  assert.equal(a.skipped, 0);
  assert.equal(a.from, h[0].at);
  assert.equal(a.to, h[5].at);
  const small = sumAsk(h, 'Sam', 250)!;
  assert.equal(small.n, 2, 'only the newest that fit');
  assert.equal(small.skipped, 4);
  assert.equal(small.from, h[4].at);
  const huge = sumAsk([{ role: 'user', content: 'p'.repeat(10_000), at: 't' }], 'Sam', 500)!;
  assert.equal(huge.n, 1, 'one message bigger than the room: its start');
  assert.ok(huge.turns[1].content.length < 700);
  assert.equal(sumAsk([], 'Sam', 1000), null);
});

test('a summary is tidied before it is kept: no thinking, no heading, one "- " line each, cut to its size', () => {
  assert.equal(cleanSum('<think>hmm</think>\n## Summary\nHere is the summary:\n* Sold the upright\n2. Van booked for Friday\nPrice   £400'), '- Sold the upright\n- Van booked for Friday\n- Price £400');
  assert.equal(cleanSum('   \n'), '');
  assert.ok(cleanSum(Array.from({ length: 80 }, (_, i) => `- line ${i} ${'w'.repeat(40)}`).join('\n')).length <= SUM_BLOCK_CHARS);
});

test('fold summaries sit under the log, change only at a fold, and are not sent at all when the tick is off', () => {
  const lg = [log('decision', 'Sell the upright', 1)];
  const off = buildLayered(base({ history: chat(2), log: lg }));
  assert.ok(!off.parts.some(p => p.key === 'sums'), 'off: no summary layer, not even an empty one');
  const empty = buildLayered(base({ history: chat(2), log: lg, sums: [] }));
  assert.equal(empty.parts.find(p => p.key === 'sums')?.state, 'none');
  const first = buildLayered(base({ history: chat(2), log: lg, sums: [sum(1, '- The buyer wants it Friday')] }));
  const sys = first.turns[0].content;
  assert.ok(sys.indexOf('Sell the upright') < sys.indexOf('The buyer wants it Friday'), 'under his log');
  assert.equal(first.parts.find(p => p.key === 'sums')?.state, 'whole');
  // A new summary (or one he changed) waits for the next fold, as his log lines do: the start stays byte-identical.
  const later = buildLayered(base({ history: [...chat(2), ...chat(1, 600, 2)], sent: first.sent, log: lg, sums: [sum(1, '- The buyer wants it Friday'), sum(2, '- New')] }));
  assert.equal(later.folded, false);
  assert.equal(later.turns[0].content, sys);
  assert.equal(later.logWaiting, true);
  // "Send them now" (stale): the new one goes in, the same messages stay.
  const now = buildLayered(base({ history: [...chat(2), ...chat(1, 600, 2)], sent: { ...first.sent, stale: true }, log: lg, sums: [sum(1, '- The buyer wants it Friday'), sum(2, '- New')] }));
  assert.equal(now.folded, true);
  assert.equal(now.older, first.older);
  assert.ok(now.turns[0].content.includes('- New'));
  assert.equal(now.logWaiting, false);
});

test('fold summaries on disk: added by the fold, changed or deleted by him, never copied into a carried-on chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-sums-'));
  try {
    const logs = new ChatLogs(new Store(dir));
    const id = 'a1b2c3d4e5f6';
    assert.equal(await logs.addSum(id, { from: 'a', to: 'b', n: 2, text: '  \n', by: 'm' }), null, 'an empty summary is not kept');
    const s = (await logs.addSum(id, { from: 'a', to: 'b', n: 2, text: '* Sold it', by: 'm' }, '2026-11-24T10:00:00Z'))!;
    assert.equal(s.text, '- Sold it');
    await logs.add(id, 'fact', 'Van is 3.5 t');
    assert.deepEqual((await logs.read(id)).sums.map(x => x.text), ['- Sold it'], 'his log and the summaries live side by side');
    const changed = await logs.editSum(id, s.id, 'Sold it for £400');
    assert.ok(!('error' in changed) && changed.text === 'Sold it for £400', 'kept as he typed it');
    assert.ok('error' in (await logs.editSum(id, s.id, '   ')));
    assert.ok('error' in (await logs.editSum(id, 'nope', 'x')));
    const other = 'f6e5d4c3b2a1';
    await logs.copy(id, other);
    assert.deepEqual((await logs.read(other)).sums, []);
    assert.equal(await logs.removeSum(id, s.id), true);
    assert.equal(await logs.removeSum(id, s.id), false);
    assert.deepEqual((await logs.read(id)).sums, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fold never sums up again what an earlier summary covers', () => {
  const h = chat(6);
  const gone = { from: 'not there any more', n: 4, upper: '', logText: '', ctx: 32768, at: '', parts: [] };
  assert.deepEqual(leaving(h, gone, 8, h[3].at), h.slice(4, 8), 'the last start was deleted: from after the newest summary, not the chat start');
  const back = { from: h[2].at, n: 2, upper: '', logText: '', ctx: 32768, at: '', parts: [] };
  assert.deepEqual(leaving(h, back, 8, h[5].at), h.slice(6, 8), 'the start moved back after a summary: only what it did not cover');
  assert.deepEqual(leaving(h, back, 6, h[5].at), [], 'all of it summed up already: nothing to ask for');
});

test('one summary line longer than the cap is cut, not lost; his edits keep his own words', () => {
  const long = 'x'.repeat(SUM_BLOCK_CHARS + 200);
  const cut = cleanSum(long);
  assert.ok(cut.length > 0 && cut.length <= SUM_BLOCK_CHARS, 'a single long paragraph from the model is kept, cut to size');
  const edit = 'y'.repeat(SUM_BLOCK_CHARS - 1);
  assert.equal(cleanEditedSum(edit), edit, 'an edit as long as the box allows is kept whole');
  assert.equal(cleanEditedSum('# My heading\nSummary of the boat:\n  two  spaces kept\n\n'), '# My heading\nSummary of the boat:\ntwo  spaces kept', 'nothing of his is dropped or rewritten, only blank lines and end spaces');
  assert.equal(cleanEditedSum('  \n '), '', 'nothing but spaces is empty');
});
