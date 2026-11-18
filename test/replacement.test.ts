// A hire whose model is gone: the words, and the replacements suggested from what TOMLIN already knows (src/replacement.ts).
// Suggestions only: no line here does anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackupChoice } from '../src/brains.ts';
import type { NetRow } from '../src/carry.ts';
import { backupAnsweredWords, goneMessage, goneWords, replacementLines, type ReplaceInput } from '../src/replacement.ts';

const GB = 2 ** 30;
const choice = (pc: string, pcId: string, model: string, o: Partial<BackupChoice> = {}): BackupChoice => ({ ref: `r:${pcId}:${model}`, pc, pcId, model, ready: false, same: false, intern: false, fit: 'ok', level: 'match', ...o });
const row = (name: string, on: string[], o: Partial<NetRow> = {}): NetRow => ({ key: `chat:${name}`, name, kind: 'chat', bytes: 20 * GB, here: false, on: on.map(pcName => ({ pc: pcName.toLowerCase(), pcName, model: `${name}.gguf`, copy: true, why: '' })), ...o });
const base: ReplaceInput = { first: 'Ann', goneName: 'Qwen3.5-35B-A3B-Q4_K_M', wasOn: null, choices: [], rows: [], mine: [], pcs: [], freeHere: 100 * GB };

test('gone words: where it was, in one clause', () => {
  assert.equal(goneWords('Qwen3.5-35B', null), 'Qwen3.5-35B is no longer on this PC (it was deleted or moved)');
  assert.equal(goneWords('Qwen3.5-35B', 'Z820'), 'Qwen3.5-35B is no longer on "Z820" (it was deleted or moved there)');
  assert.equal(backupAnsweredWords('Ann', goneWords('Qwen3.5-35B', null), 'Gemma 4B', 'this PC'), "Ann's model is gone: Qwen3.5-35B is no longer on this PC (it was deleted or moved). Ann's backup, Gemma 4B on this PC, answered instead. Pick a new first choice in Team.");
});

test('the same model is on a linked PC: use it there, or copy it here (with the room it needs and has)', () => {
  const i: ReplaceInput = { ...base, choices: [choice('Z820', 'z8', 'Qwen3.5-35B-A3B-Q4_K_M', { same: true })], rows: [row('Qwen3.5-35B-A3B-Q4_K_M', ['Z820'])] };
  const [line] = replacementLines(i);
  assert.match(line, /^The same model, Qwen3\.5-35B-A3B-Q4_K_M, is on "Z820": pick it as Ann's backup in this chat to use it there, or copy it to this PC \(Network, Models on my other PCs, Get a copy from "Z820"; 20 GB needed, 100 GB free here\)\.$/);
  const tight = replacementLines({ ...i, freeHere: 10 * GB })[0];
  assert.match(tight, /10 GB free here: Free up space on this PC first\)/);
  // Not copyable from there (its owner shares it to use, not to copy): only "use it there" is suggested.
  const noCopy = replacementLines({ ...i, rows: [row('Qwen3.5-35B-A3B-Q4_K_M', ['Z820'])].map(r => ({ ...r, on: r.on.map(o => ({ ...o, copy: false, why: 'x' })) })) })[0];
  assert.doesNotMatch(noCopy, /copy it to this PC/);
});

test('the model was on a linked PC and this PC has the same one: use it here, or send a copy back; that PC checks its room', () => {
  const i: ReplaceInput = { ...base, wasOn: 'Z820', choices: [choice('This PC', 'here', 'Qwen3.5-35B-A3B-Q4_K_M', { same: true })], mine: [{ name: 'Qwen3.5-35B-A3B-Q4_K_M', bytes: 20 * GB }], pcs: [{ name: 'Z820', send: '' }] };
  assert.equal(replacementLines(i)[0], `The same model, Qwen3.5-35B-A3B-Q4_K_M, is on this PC: pick it as Ann's first choice in Team, or send a copy back to "Z820" so Ann uses it there again (Hire staff, All models, Copy to Z820; 20 GB, and "Z820" checks it has room before anything is sent).`);
  // That PC cannot take it now: not offered.
  assert.doesNotMatch(replacementLines({ ...i, pcs: [{ name: 'Z820', send: '"Z820" is off or not answering now' }] })[0], /send a copy back/);
});

test('nothing the same: the nearest in size that is not an intern and fits; nothing close says so', () => {
  const near = choice('Z820', 'z8', 'Qwen3-32B-Q4_K_M');
  const small = choice('This PC', 'here', 'Qwen3-1.7B', { intern: true, level: 'below' });
  const big = choice('HP 800', 'hp', 'Llama-70B', { fit: 'no', level: 'above' });
  assert.deepEqual(replacementLines({ ...base, choices: [small, big, near] }), [`Nearest in size: Qwen3-32B-Q4_K_M on "Z820": pick it as Ann's backup in this chat.`]);
  assert.deepEqual(replacementLines({ ...base, choices: [small, big] }), []);
});

test('the message: gone, why, what to do, and that nothing happens until a button is pressed; with no suggestion it points to Team', () => {
  const i: ReplaceInput = { ...base, choices: [choice('Z820', 'z8', 'Qwen3.5-35B-A3B-Q4_K_M', { same: true })] };
  const m = goneMessage(i, ['"Z820" is being used by its owner']);
  assert.match(m, /^Ann's model is gone: Qwen3\.5-35B-A3B-Q4_K_M is no longer on this PC \(it was deleted or moved\)\. "Z820" is being used by its owner\. The same model/);
  assert.match(m, /Nothing is copied, sent or changed until you press it\.$/);
  assert.equal(goneMessage(base, []), "Ann's model is gone: Qwen3.5-35B-A3B-Q4_K_M is no longer on this PC (it was deleted or moved). TOMLIN knows of no close match: pick another model for Ann in Team.");
});
