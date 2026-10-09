// "Send to…": the instruction picked by role, the written prompt cleaned, and the two lines the app writes in the chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFrom, cleanWritten, markSent, promptFor, PROMPT_FOR } from '../src/sendto.ts';
import type { ChatLine } from '../src/store.ts';

test('send to: the instruction comes from the role, and any other role gets a plain request', () => {
  assert.equal(promptFor('artist'), PROMPT_FOR.artist);
  assert.equal(promptFor('designer'), PROMPT_FOR.designer);
  assert.equal(promptFor('coder').label, 'a brief for the coder');
  assert.equal(promptFor('host'), PROMPT_FOR.ask);
  assert.equal(promptFor('receptionist'), PROMPT_FOR.ask);
  assert.equal(promptFor(undefined), PROMPT_FOR.ask);
  // A picture model gets one line; a person gets the whole brief.
  assert.equal(PROMPT_FOR.artist.oneLine, true);
  assert.equal(PROMPT_FOR.writer.oneLine, false);
});

test('send to: a written picture prompt is one clean line; a brief keeps its lines but loses a preface', () => {
  assert.equal(cleanWritten('Prompt: "a lighthouse at dusk, 35mm photo"\n\nThis shows…', true), 'a lighthouse at dusk, 35mm photo');
  assert.equal(cleanWritten("Here's the prompt: **a red bicycle** against a white wall", true), 'a red bicycle against a white wall');
  assert.equal(cleanWritten('Here is the brief:\n- Build a form\n- Two fields', false), '- Build a form\n- Two fields');
  assert.equal(cleanWritten('   ', true), '');
  assert.equal(cleanWritten('Picture prompt: a loaf on a board', true), 'a loaf on a board');
});

test('send to: "Sent from" is short and on one line', () => {
  assert.equal(cleanFrom("Sam's chat\n\"blog photos\""), 'Sam\'s chat "blog photos"');
  assert.equal(cleanFrom(42), '');
  assert.equal(cleanFrom('x'.repeat(200)).length, 80);
});

test('send to: the answer it came from is marked, the newest that holds the words, once per person', () => {
  const at = '2026-10-05T10:00:00.000Z';
  const lines: ChatLine[] = [
    { role: 'user', content: 'Write about bread', at },
    { role: 'assistant', content: 'Bread needs time to rise. A picture: a loaf on a board.', at },
    { role: 'user', content: 'Again', at },
    { role: 'assistant', content: 'Bread needs time to rise. Second version.', at },
  ];
  // The whole newest answer.
  const a = markSent(lines, 'Bread needs time to rise. Second version.', 'Dana · blog photos');
  assert.equal(a.marked, true);
  assert.deepEqual(a.lines[3].sent, ['Dana · blog photos']);
  assert.equal(a.lines[1].sent, undefined);
  assert.equal(lines[3].sent, undefined, 'the lines given are not changed');
  // A part picked from the older answer marks that one; sending to the same person again is not listed twice.
  const b = markSent(markSent(a.lines, 'A picture: a loaf on a board.', 'Dana').lines, 'A picture: a loaf on a board.', 'Dana');
  assert.deepEqual(b.lines[1].sent, ['Dana']);
  // A message (not an answer) is never marked, and words found nowhere change nothing.
  assert.equal(markSent(lines, 'Write about bread', 'Dana').marked, false);
  assert.equal(markSent(lines, 'nothing like this', 'Dana').lines, lines);
  assert.equal(markSent(lines, 'Bread', '').marked, false);
});
