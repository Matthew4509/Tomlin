import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatStyle, plainStyle, turnsFor } from '../src/engine.ts';
import { buildChat } from '../src/memory.ts';

test('two messages in a row from one side are joined, so strict templates (Gemma) take the chat', () => {
  const t = turnsFor([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Is your family coming?' },
    { role: 'user', content: 'Is your family coming?' },
    { role: 'assistant', content: 'Yes.' },
    { role: 'user', content: 'Great.' },
  ], chatStyle('qwen'));
  assert.deepEqual(t.map(x => x.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(t[1].content, 'Is your family coming?\n\nIs your family coming?');
});

test('the system message still goes into the first message for models that want it there', () => {
  const t = turnsFor([{ role: 'system', content: 'S' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }], chatStyle('gemma'));
  assert.equal(t.length, 1);
  assert.equal(t[0].role, 'user');
  assert.ok(t[0].content.startsWith('S') && t[0].content.endsWith('a\n\nb'));
});

test('a Default hire: no system line at all, and the model asked with its own settings (Qwen thinking still off)', () => {
  const c = buildChat({ ctx: 8192, maxAnswer: 2048, card: '', team: null, own: null, name: 'Qwen', history: [{ role: 'user', content: 'Hi', at: '' }, { role: 'assistant', content: 'Hello.', at: '' }], message: 'What is 2+2?' });
  assert.deepEqual(c.turns.map(t => t.role), ['user', 'assistant', 'user']);
  assert.equal(c.parts.find(p => p.key === 'card')?.state, 'none');
  // An empty system line from anywhere else is not sent either.
  assert.deepEqual(turnsFor([{ role: 'system', content: '  ' }, { role: 'user', content: 'Hi' }], chatStyle('qwen3')).map(t => t.role), ['user']);
  assert.deepEqual(plainStyle('Qwen3.5-2B-Q4_K_M.gguf').sampling, { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(plainStyle('gemma-3-1b-it').sampling, {});
  assert.equal(plainStyle('gemma-3-1b-it').systemInFirstMessage, true);
  assert.deepEqual(plainStyle('Ministral-3B').sampling, { stop: ['[INST]', '</s>'] });
  assert.deepEqual(plainStyle('llama-3.2-1b').sampling, {});
});
