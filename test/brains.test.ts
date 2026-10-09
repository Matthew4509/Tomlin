import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTurns, flatten, isIntern, modelForStyle, modelStem, orderChoices, parseRef, pickBrain, ranOn, refsOf, remoteRef, sameModel, styleCoverage, styleOfMode, withCover, type BackupChoice, type PictureModel } from '../src/brains.ts';

test('a brain is a model here or a paired PC; anything else is no brain', () => {
  assert.deepEqual(parseRef('qwen3-8b-q4_k_m'), { kind: 'here', id: 'qwen3-8b-q4_k_m' });
  assert.deepEqual(parseRef('remote:0a1b2c3d'), { kind: 'remote', pc: '0a1b2c3d' });
  for (const none of ['', null, undefined, 'remote:', 'remote:../x', 'remote:0A1B2C3D', 7]) assert.equal(parseRef(none).kind, 'none', String(none));
  assert.deepEqual(refsOf({ model: 'remote:0a1b2c3d', fallback: 'gemma' }), ['remote:0a1b2c3d', 'gemma']);
  assert.deepEqual(refsOf({ model: 'gemma', fallback: 'gemma' }), ['gemma']);
  assert.deepEqual(refsOf({ model: null, fallback: 'remote:bad' }), []);
});

test('a brain can be one of the models a linked PC lets others use, named by its id there', () => {
  assert.deepEqual(parseRef('remote:0a1b2c3d:Qwen3.5-9B-Q4_K_M.gguf'), { kind: 'remote', pc: '0a1b2c3d', model: 'Qwen3.5-9B-Q4_K_M.gguf' });
  // A model in a folder, or an Ollama name with its own colon, is kept whole.
  assert.deepEqual(parseRef('remote:0a1b2c3d:sub/x.gguf'), { kind: 'remote', pc: '0a1b2c3d', model: 'sub/x.gguf' });
  assert.deepEqual(parseRef('remote:0a1b2c3d:ollama:llama3:8b'), { kind: 'remote', pc: '0a1b2c3d', model: 'ollama:llama3:8b' });
  assert.equal(remoteRef('0a1b2c3d', 'x.gguf'), 'remote:0a1b2c3d:x.gguf');
  assert.equal(remoteRef('0a1b2c3d'), 'remote:0a1b2c3d');
  assert.deepEqual(parseRef(remoteRef('0a1b2c3d', 'x.gguf')), { kind: 'remote', pc: '0a1b2c3d', model: 'x.gguf' });
  for (const none of ['remote:0a1b2c3d:', 'remote:0a1b2c3:x.gguf', 'remote:0a1b2c3d:a\u0007b', `remote:0a1b2c3d:${'x'.repeat(301)}`]) assert.equal(parseRef(none).kind, 'none', JSON.stringify(none));
  assert.deepEqual(refsOf({ model: 'remote:0a1b2c3d:x.gguf', fallback: 'remote:0a1b2c3d' }), ['remote:0a1b2c3d:x.gguf', 'remote:0a1b2c3d']);
});

test('the preferred brain answers when it can; else the fallback that is ready; else one this PC can load; else every reason', () => {
  const c = (ref: string, ready: boolean, loadable = false, why = '') => ({ ref, ready, loadable, why });
  assert.deepEqual(pickBrain([c('a', true), c('b', true)]), { use: c('a', true), load: false });
  // The laptop is off: the model here that is loaded now answers.
  assert.deepEqual(pickBrain([c('remote:1', false, false, 'off'), c('b', true)]), { use: c('b', true), load: false });
  // A fallback that is already answering beats loading the preferred one.
  assert.deepEqual(pickBrain([c('a', false, true, 'not loaded'), c('remote:1', true)]), { use: c('remote:1', true), load: false });
  assert.deepEqual(pickBrain([c('remote:1', false, false, 'off'), c('b', false, true, 'not loaded')]), { use: c('b', false, true, 'not loaded'), load: true });
  assert.deepEqual(pickBrain([c('remote:1', false, false, '"laptop" is off'), c('remote:2', false, false, '"desk" has no chat model loaded')]), { error: ['"laptop" is off', '"desk" has no chat model loaded'] });
});

test('the chat head says where it ran, with the size from the name', () => {
  assert.equal(ranOn('laptop', 'Qwen3-8B-Q4_K_M'), 'on laptop 8B');
  assert.equal(ranOn('this PC', 'gemma-3-1b-it-Q4_K_M'), 'on this PC 1B');
  assert.equal(ranOn('desk', 'DreamShaper 8 LCM'), 'on desk DreamShaper 8 LCM');
});

test('an older worker gets the conversation written into one message; a newer one gets the turns, checked', () => {
  const turns = [{ role: 'system', content: 'You are Rowan.' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello!' }, { role: 'user', content: 'Fix my login page.' }];
  const f = flatten(turns);
  assert.equal(f.system, 'You are Rowan.');
  assert.match(f.user, /Them: Hi\n\nYou: Hello!\n\nTheir new message:\nFix my login page\./);
  assert.deepEqual(flatten(turns.slice(0, 2)), { system: 'You are Rowan.', user: 'Hi' });
  assert.deepEqual(cleanTurns(turns), turns);
  assert.equal(cleanTurns([{ role: 'user', content: 'a' }, { role: 'system', content: 'sneaky' }, { role: 'user', content: 'b' }]), null, 'a system line only first');
  assert.equal(cleanTurns([{ role: 'tool', content: 'x' }]), null);
  assert.equal(cleanTurns([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), null, 'must end with their message');
  assert.equal(cleanTurns([{ role: 'user', content: 'x'.repeat(240_000) }]), null);
  assert.equal(cleanTurns('nope'), null);
});

const GB = 2 ** 30;
const dream: PictureModel = { id: 'dreamshaper8-lcm', name: 'DreamShaper 8 LCM (SD 1.5, fast, illustration)', modes: ['icon', 'cartoon', 'custom'], installed: true, bytes: 2.1 * GB };
const real: PictureModel = { id: 'sd15-realistic-lcm', name: 'Realistic Vision 6 + LCM (SD 1.5, fast)', modes: ['blog', 'icon', 'custom'], installed: true, bytes: 2.0 * GB };
const qwen: PictureModel = { id: 'qwen-image-2.1', name: 'Qwen-Image 2.1 (7B, Q4, best quality, slow)', modes: ['blog', 'icon', 'custom'], installed: false, bytes: 9.2 * GB };

test('a node draws a style on its loaded model when it is made for it, else switches to its own model that is, if it allows it', () => {
  assert.deepEqual(modelForStyle('cartoon', dream, [dream, real], true), { use: dream, swap: false, note: '' });
  assert.deepEqual(modelForStyle(null, real, [dream, real], true), { use: real, swap: false, note: '' });
  const swap = modelForStyle('cartoon', real, [dream, real], true);
  assert.equal(swap.use.id, 'dreamshaper8-lcm');
  assert.equal(swap.swap, true);
  assert.match(swap.note, /switched to DreamShaper 8 LCM for cartoon/);
  const kept = modelForStyle('cartoon', real, [dream, real], false);
  assert.equal(kept.use.id, 'sd15-realistic-lcm');
  assert.equal(kept.swap, false);
  assert.match(kept.note, /does not let other PCs switch/);
  // A model that is not downloaded on the node is never swapped to.
  const none = modelForStyle('photo', dream, [dream, { ...real, installed: false }], true);
  assert.equal(none.swap, false);
  assert.match(none.note, /no model on that PC is made for photo/);
  assert.equal(styleOfMode('blog'), 'photo');
  assert.equal(styleOfMode('custom'), null);
});

test('an artist node is told which style it can draw and which model to download for the rest', () => {
  const cov = styleCoverage([dream, { ...real, installed: false }, qwen]);
  assert.deepEqual(cov.map(c => [c.name, c.have, c.get?.name ?? null]), [['Cartoon', 'DreamShaper 8 LCM', null], ['Photo', null, 'Realistic Vision 6 + LCM'], ['Icon', 'DreamShaper 8 LCM', null]]);
  assert.equal(cov[1].get?.gb, 2);
});

test('a backup picked while the first choice is away is tried after it and before the fallback', () => {
  assert.deepEqual(withCover(['remote:0a1b2c3d', 'gemma'], { ref: 'remote:99999999' }), ['remote:0a1b2c3d', 'remote:99999999', 'gemma']);
  assert.deepEqual(withCover(['remote:0a1b2c3d', 'gemma'], { ref: 'gemma' }), ['remote:0a1b2c3d', 'gemma']);
  assert.deepEqual(withCover(['a'], null), ['a']);
  assert.deepEqual(withCover(['a'], { ref: 'remote:bad' }), ['a']);
});

test('the same model whatever its file is called; a smaller one answers as an intern', () => {
  assert.equal(modelStem('models/chat/Qwen3.5-9B-Q4_K_M.gguf'), 'qwen3.5-9b');
  assert.ok(sameModel('Qwen3.5-9B-Q4_K_M', 'qwen3.5-9b-q8_0.gguf'));
  assert.ok(sameModel('gemma-2-2b-it-Q4_K_M.gguf', 'gemma-2-2b-it-UD-Q4_K_XL'));
  assert.ok(!sameModel('Qwen3.5-9B-Q4_K_M', 'Qwen3.5-2B-Q4_K_M'));
  assert.ok(!sameModel('', ''));
  assert.ok(isIntern('Qwen3.5-9B-Q4_K_M', 'Qwen3.5-2B-Q4_K_M'));
  assert.ok(!isIntern('Qwen3.5-2B-Q4_K_M', 'Qwen3.5-9B-Q4_K_M'));
  assert.ok(!isIntern('my-model', 'Qwen3.5-2B'), 'an unknown size is not called smaller');
});

test('backups: the same model first, then not an intern, then ready, then bigger', () => {
  const c = (ref: string, model: string, ready: boolean, same: boolean, intern: boolean): BackupChoice => ({ ref, pc: ref, model, ready, same, intern });
  const list = [c('a', 'Qwen-2B', true, false, true), c('b', 'Qwen-9B', false, true, false), c('c', 'Gemma-4B', true, false, true), c('d', 'Qwen-14B', true, false, false)];
  assert.deepEqual(orderChoices(list).map(x => x.ref), ['b', 'd', 'c', 'a']);
});
