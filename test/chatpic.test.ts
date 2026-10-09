import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pictureAsk, cleanPrompt } from '../src/chatpic.ts';

test('a clear request for a picture is recognised, with what was asked for', () => {
  assert.deepEqual(pictureAsk('Can you draw a picture of a lighthouse at dusk?'), { kind: 'thing', subject: 'a lighthouse at dusk' });
  assert.deepEqual(pictureAsk('make me an image of a red bicycle'), { kind: 'thing', subject: 'a red bicycle' });
  assert.deepEqual(pictureAsk('show me a photo of your kitchen'), { kind: 'thing', subject: 'your kitchen' });
});

test('"send me a selfie" and "a pic of you" are the character\'s own picture', () => {
  assert.equal(pictureAsk('send me a selfie')?.kind, 'self');
  assert.equal(pictureAsk('can you send me a pic of you at the beach')?.kind, 'self');
  assert.equal(pictureAsk('show me a picture of yourself cooking')?.kind, 'self');
});

test('plain talk about pictures is not a request', () => {
  assert.equal(pictureAsk('I took a picture of my dog yesterday'), null);
  assert.equal(pictureAsk('what is a good photo editor?'), null);
  assert.equal(pictureAsk('draw'), null);
  assert.equal(pictureAsk('make me a picture'), null);
  assert.equal(pictureAsk(''), null);
});

test('a prompt line is cleaned of labels, quotes and markup', () => {
  assert.equal(cleanPrompt('Prompt: "a red bicycle against a brick wall, soft light"\nextra'), 'a red bicycle against a brick wall, soft light');
  assert.equal(cleanPrompt('   '), '');
  assert.equal(cleanPrompt('Image prompt: a loaf on a board, warm light'), 'a loaf on a board, warm light');
});

test('a cartoon, an avatar or a profile picture asked for in chat is a picture request', () => {
  assert.deepEqual(pictureAsk('make a cartoon profile picture of a friendly piano tuner'), { kind: 'thing', subject: 'a friendly piano tuner' });
  assert.deepEqual(pictureAsk('draw me a cartoon of a dog'), { kind: 'thing', subject: 'a dog' });
  assert.equal(pictureAsk('can you make an avatar for my shop')?.kind, 'thing');
  assert.equal(pictureAsk('i like cartoons'), null);
  assert.equal(pictureAsk('show me a profile picture of you')?.kind, 'self');
});
