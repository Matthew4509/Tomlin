import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MODELS, GB, chatNeed, chatRows, fitOf, pictureRow, speedOf, testedSpeed, timeText, type Hardware } from '../src/calc.ts';

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
