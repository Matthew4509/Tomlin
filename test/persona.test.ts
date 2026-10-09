import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WHO, TONES, systemFor, whoOf, toneOf, cleanName } from '../src/persona.ts';

test('an unknown or missing character falls back to Standard, and every character has a prompt and examples', () => {
  assert.equal(whoOf(undefined).id, 'standard');
  assert.equal(whoOf('nobody').id, 'standard');
  assert.equal(new Set(WHO.map(w => w.id)).size, WHO.length);
  for (const w of WHO) assert.ok(w.prompt.startsWith('You are TOMLIN'), w.id);
  for (const w of WHO.filter(x => x.id !== 'standard')) assert.match(w.prompt, /Examples of how you sound/, w.id);
});

test('Friend stays in character; Professional answers plainly', () => {
  assert.match(whoOf('friend').prompt, /instead of saying you are an AI/);
  assert.match(whoOf('professional').prompt, /No greetings/);
});

test('the tone is added only for writing, only when one is chosen, and independent of who TOMLIN is', () => {
  assert.equal(systemFor('professional', 'natural'), whoOf('professional').prompt);
  assert.equal(systemFor('professional', 'nope'), whoOf('professional').prompt);
  const letter = systemFor('professional', 'warm');
  assert.ok(letter.startsWith(whoOf('professional').prompt));
  assert.match(letter, /letter, article, post or message, write the piece warmly/);
  // Flirty was dropped: a profile or setting still on it writes in the first tone (Natural).
  assert.equal(toneOf('flirty').id, TONES[0].id);
  assert.equal(new Set(TONES.map(t => t.id)).size, TONES.length);
});

test('the manager answers to the name he gives it; names are letters, spaces, hyphens and apostrophes', () => {
  assert.match(systemFor('standard', 'natural', 'Max'), /^You are Max, the person's assistant in TOMLIN,/);
  assert.match(systemFor('professional', 'natural'), /^You are TOMLIN,/);
  assert.equal(cleanName('  Mary   Jane '), 'Mary Jane');
  assert.equal(cleanName("O'Neil-Ross"), "O'Neil-Ross");
  assert.equal(cleanName('Zoë'), 'Zoë');
  assert.equal(cleanName(''), '');
  assert.equal(cleanName('<b>x</b>'), null);
  assert.equal(cleanName('9lives'), null);
  assert.equal(cleanName('a'.repeat(31)), null);
});
