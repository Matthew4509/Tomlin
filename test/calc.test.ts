import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MODELS, GB, cardFit, chatNeed, fitsRoom, chatRows, fitOf, moveWontFit, pictureRow, ramFit, ramNearlyFull, speedOf, testedSpeed, timeText, type Hardware } from '../src/calc.ts';

const laptop: Hardware = { ram: 16 * GB, vram: 0, card: 'builtin', cores: 2 };
const desktop: Hardware = { ram: 32 * GB, vram: 0, card: 'none', cores: 4 };
const p2000: Hardware = { ram: 16 * GB, vram: 5 * GB, card: 'nvidia', cores: 4, cardSpeed: 140 };
const row = (rows: ReturnType<typeof chatRows>, name: string) => rows.find(r => r.name.startsWith(name))!;

test('the estimates land on the measured figures in Help (each inside its range)', () => {
  for (const [hw, name, measured] of [[laptop, 'Qwen 3.5 0.8B', 17.7], [laptop, 'Gemma 2 2B', 6.4], [desktop, 'Mistral Nemo 12B', 2.1], [desktop, 'Qwen 3.5 35B-A3B', 5.2]] as const) {
    const r = row(chatRows(CHAT_MODELS, hw), name);
    assert.ok(r.perSecond, name);
    assert.ok(r.perSecond.low <= measured && measured <= r.perSecond.high, `${name}: ${measured} in ${r.perSecond.low}-${r.perSecond.high}`);
  }
});

test('a 7B-class model on a CPU-only PC takes minutes for a post, not hours', () => {
  const r = row(chatRows([{ name: 'Qwen 7B', bytes: 4.7 * GB }], desktop), 'Qwen 7B');
  assert.equal(r.level, 'ok');
  assert.ok(r.post!.mid > 120 && r.post!.mid < 20 * 60, `${r.post!.mid} s`);
});

test('fit: on the card when it holds it all, split when RAM helps, tight within 2 GB, else no', () => {
  assert.deepEqual(fitOf(chatNeed(2.7 * GB), p2000), { level: 'ok', where: 'card' });
  assert.deepEqual(fitOf(chatNeed(7.3 * GB), p2000), { level: 'ok', where: 'split' });
  assert.equal(fitOf(chatNeed(22 * GB), laptop).level, 'no');
  assert.equal(fitOf(chatNeed(22 * GB), { ...desktop, ram: 28 * GB }).level, 'tight');
  assert.equal(row(chatRows(CHAT_MODELS, laptop), 'Qwen 3.5 35B').perSecond, null, 'no speed for a model that does not fit');
});

test('a card is much faster than the CPU; a split model sits between them', () => {
  const need = chatNeed(7.3 * GB);
  const card = speedOf(2.7 * GB, chatNeed(2.7 * GB), p2000, 'card').mid;
  const cpu = speedOf(2.7 * GB, chatNeed(2.7 * GB), p2000, 'cpu').mid;
  assert.ok(card > cpu * 5);
  const split = speedOf(7.3 * GB, need, p2000, 'split').mid;
  assert.ok(split > speedOf(7.3 * GB, need, p2000, 'cpu').mid && split < speedOf(7.3 * GB, need, p2000, 'card').mid);
});

test('a test on this PC replaces the CPU guess', () => {
  const tested = testedSpeed(20, 0.5 * GB);
  assert.equal(tested, 11.1);
  const r = row(chatRows(CHAT_MODELS, laptop, tested), 'Qwen 3.5 0.8B');
  assert.equal(r.basis, 'tested');
  assert.equal(r.perSecond!.mid, 20);
});

test('pictures: about 3 min on 2 laptop cores, about 50 s on the built-in chip, seconds on a card, measured wins', () => {
  assert.equal(pictureRow({ ...laptop, card: 'none' }).seconds!.mid, 170);
  assert.equal(pictureRow(laptop).where, 'builtin');
  assert.equal(pictureRow(p2000).where, 'card');
  assert.equal(pictureRow({ ram: 2 * GB, vram: 0, card: 'none', cores: 2 }).level, 'no');
  assert.equal(pictureRow(laptop, { seconds: 52, on: 'this PC' }).basis, 'measured');
});

test('times read as people say them', () => {
  assert.equal(timeText(40), '40 s');
  assert.equal(timeText(380), '6 min');
  assert.equal(timeText(5000), '83 min');
  assert.equal(timeText(6000), '1 h 40 min');
});

test('moving someone: a model fits a PC on its card or in its RAM less 3 GB, tight up to the whole RAM, else it is refused', () => {
  const laptop = { ram: 8 * GB, vram: 0 };
  assert.equal(ramFit(4 * GB, laptop), 'ok');
  assert.equal(ramFit(6 * GB, laptop), 'tight');
  assert.equal(ramFit(24 * GB, laptop), 'no');
  // A graphics card that holds it all: fits whatever the RAM.
  assert.equal(ramFit(10 * GB, { ram: 8 * GB, vram: 12 * GB }), 'ok');
  // Spread over the card and the RAM (llama.cpp does): 12 GB card + 16 GB RAM holds a 20 GB need, though neither alone does.
  assert.equal(ramFit(20 * GB, { ram: 16 * GB, vram: 12 * GB }), 'ok');
  // Two 12 GB cards count together.
  assert.equal(ramFit(30 * GB, { ram: 16 * GB, vram: 24 * GB }), 'ok');
  assert.equal(ramFit(30 * GB, { ram: 16 * GB, vram: 12 * GB }), 'no');
  // 5% leeway over all the memory before it is refused (FIT_LEEWAY): the 35B-A3B (about 26.7 GB) on a 26 GB PC is tight.
  assert.equal(ramFit(26.7 * GB, { ram: 26 * GB, vram: 0 }), 'tight');
  assert.equal(ramFit(26.7 * GB, { ram: 25 * GB, vram: 0 }), 'no');
  // His examples: 32 GB + a 4 GB card, and 30 GB alone, both take it.
  assert.equal(ramFit(26.7 * GB, { ram: 32 * GB, vram: 4 * GB }), 'ok');
  assert.equal(ramFit(26.7 * GB, { ram: 30 * GB, vram: 0 }), 'ok');
  // Not known (a PC that is off, a model with no size): not refused.
  assert.equal(ramFit(4 * GB, { ram: 0, vram: 0 }), null);
  assert.equal(ramFit(0, laptop), null);
  assert.equal(ramNearlyFull(15.2 * GB, 16 * GB), true);
  assert.equal(ramNearlyFull(15 * GB, 16 * GB), false);
  assert.equal(ramNearlyFull(1, 0), false);
  const why = moveWontFit('Qwen3.5-35B-A3B', 24 * GB, '"Worker PC"', laptop);
  assert.match(why, /^Not moved: Qwen3\.5-35B-A3B needs about 24 GB of memory, and "Worker PC" has 8\.0 GB of RAM \(3 GB of it is kept for Windows\)\./);
  assert.match(why, /Pick a smaller model for them there, or move them to a PC with more memory\.$/);
});

test('card fit: the file and room for an 8K chat against the cards memory less 0.5 GB each (the 1060 6 GB: about 5.5)', () => {
  const gtx1060 = { n: 1, total: 6 * GB };
  assert.equal(cardFit(2.6 * GB, gtx1060), 'ok'); // Qwen3.5 4B Q4_K_M: all on the card
  assert.equal(cardFit(4.4 * GB, gtx1060), 'ok'); // a 9B at Q3: 4.4 + 0.8
  assert.equal(cardFit(5.3 * GB, gtx1060), 'no'); // Qwen3.5 9B Q4_K_M: just over (runs, part on the processor)
  assert.equal(cardFit(6.8 * GB, gtx1060), 'no'); // Gemma 3 12B Q4_K_M
  assert.equal(cardFit(6.8 * GB, { n: 2, total: 12 * GB }), 'ok'); // two 6 GB cards
  assert.equal(cardFit(2.6 * GB, { n: 0, total: 0 }), null); // no card of its own: no mark
  assert.equal(cardFit(0, gtx1060), null);
});

test('a PC memory report: RAM and every card (2.0.50), or one card from an older PC, none when shared', async () => {
  const { memOfReport } = await import('../src/calc.ts');
  assert.deepEqual(memOfReport({ ram: { total: 16 * GB }, cards: { total: 12 * GB }, gpu: { total: 6 * GB } }), { ram: 16 * GB, vram: 12 * GB });
  assert.deepEqual(memOfReport({ ram: { total: 16 * GB }, gpu: { total: 6 * GB } }), { ram: 16 * GB, vram: 6 * GB });
  assert.deepEqual(memOfReport({ ram: { total: 8 * GB }, gpu: { total: 2 * GB, shared: true } }), { ram: 8 * GB, vram: 0 });
  assert.deepEqual(memOfReport(null), { ram: 0, vram: 0 });
});

test('fitsRoom: the Fits drop-down on the Models page judges a model file against any PC, this one or a linked one', () => {
  // The Worker PC: 32 GB of RAM and a 6 GB card. Room = (32 - 2) + (6 - 1) = 35 GB; need = file x 1.1 + 0.8 GB.
  assert.equal(fitsRoom(9.2 * GB, 32 * GB, [6 * GB]), 'ok'); // Qwen-Image 2.1's size: plenty of room
  assert.equal(fitsRoom(20 * GB, 32 * GB, [6 * GB]), 'ok'); // 22.8 needed, under 85% of 35
  assert.equal(fitsRoom(30 * GB, 32 * GB, [6 * GB]), 'tight'); // 33.8 needed: over 85%, under all of it
  assert.equal(fitsRoom(32 * GB, 32 * GB, [6 * GB]), 'no'); // 36 needed
  // This laptop: 16 GB, no card of its own (an empty list). Room 14 GB.
  assert.equal(fitsRoom(9.2 * GB, 16 * GB, []), 'ok');
  assert.equal(fitsRoom(11.5 * GB, 16 * GB, []), 'tight'); // 13.45 needed, over 85% of 14
  assert.equal(fitsRoom(14 * GB, 16 * GB, []), 'no');
  // A card under 1 GB adds nothing; memory not known (0) fits nothing.
  assert.equal(fitsRoom(1 * GB, 0, []), 'no');
});
