// G4 (27 Nov agents plan): the Memory page says when "Always send" lines will not fit the smallest model a hire uses,
// with the room an agent's brief gives (src/memory.ts agentBookRoom, as src/server/agents.ts memoryFor uses it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentBookRoom, alwaysFit, ALWAYS_GROUP, type NoteLine } from '../src/memory.ts';

const line = (i: number, chars: number, group = ALWAYS_GROUP): NoteLine => ({ id: `e${i}`, text: `${i} ${'x'.repeat(chars)}`, at: '', from: 'owner', group });

test('the room an agent run gives one notebook: a fifth of the context, at least 1,500 characters, shared by two', () => {
  assert.equal(agentBookRoom(2048), 819);
  assert.equal(agentBookRoom(512), 750);
  assert.equal(agentBookRoom(32768), 13107);
  assert.match(readFileSync(new URL('../src/server/agents.ts', import.meta.url), 'utf8'), /pickLines\(lines, task, agentBookRoom\(ctx\)\)/);
});

test('how many Always send lines fit: whole, in part, left out; other groups do not count', () => {
  const lines = [...Array.from({ length: 9 }, (_, i) => line(i, 300)), line(99, 300, 'Prices')];
  const fit = alwaysFit(lines, agentBookRoom(2048));
  assert.equal(fit.total, 9);
  assert.equal(fit.whole + fit.part + fit.left, 9);
  assert.ok(fit.left >= 5, JSON.stringify(fit));
  assert.deepEqual(alwaysFit(lines, 100_000), { total: 9, whole: 9, part: 0, left: 0 });
  assert.deepEqual(alwaysFit([line(1, 10, 'Prices')], 10), { total: 0, whole: 0, part: 0, left: 0 });
});

test('the Memory page says it, naming the model', () => {
  const page = readFileSync(new URL('../public/memorypage.js', import.meta.url), 'utf8');
  assert.match(page, /\$\{r\.always\.left\} of \$\{r\.always\.total\} \$\{ALWAYS\} lines will not be sent to \$\{r\.always\.model\}/);
});
