// A shots.json that is not as this version writes it (hand-edited, or from another version) never stops TOMLIN
// starting: src/server/shots.ts awaits Shots.load at the top, so a throw there keeps the server from starting (audit PIC-16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Shots } from '../src/shots.ts';

const home = mkdtempSync(join(tmpdir(), 'tomlin-shotsload-'));
test.after(() => rmSync(home, { recursive: true, force: true }));

test('PIC-16: a shots.json whose list has no shots (hand-edited, or from another version) does not stop TOMLIN starting', async () => {
  const file = join(home, 'shots-bad.json');
  writeFileSync(file, JSON.stringify({ version: 1, lists: { abcdefabcdef: { chat: 'abcdefabcdef' } } }));
  let error = '';
  await Shots.load({ file, clips: {} as any, starts: {} as any, dropPictures: async () => undefined } as any).catch(e => (error = (e as Error).message));
  assert.equal(error, '', `Shots.load threw (src/server/shots.ts awaits it at the top, so the server never starts): ${error}`);
});

test('a damaged list is passed over or mended; a whole one beside it is kept and its shots still read', async () => {
  const file = join(home, 'shots-mixed.json');
  const good = { chat: 'c1', who: 'staff:v1', name: 'Vic', pc: 'here', pcName: 'Worker PC', model: 'wan-1.3b', run: 'running', startAt: null, heldUntil: null, draft: false, said: '',
    shots: [{ id: 's1', prompt: 'a fox', seconds: 2, size: 'wide', quality: 'normal', start: { kind: 'none' }, state: 'making', job: 'j1', takes: [], kept: null, tries: 0, error: '' }] };
  writeFileSync(file, JSON.stringify({ version: 1, lists: { c1: good, c2: { chat: 'c2', shots: 'none', run: 'running' }, c3: null, c4: 'x', c5: { chat: 'c5', shots: [null, 3] } } }));
  const s = await Shots.load({ file, clips: {} as any, starts: {} as any, dropPictures: async () => undefined } as any);
  assert.equal(s.get('c1')?.shots[0].state, 'waiting', 'a shot being made when TOMLIN closed is made again');
  assert.deepEqual(s.get('c2')?.shots, []);
  assert.equal(s.get('c3'), null);
  assert.equal(s.get('c4'), null);
  assert.deepEqual(s.get('c5')?.shots, []);
  assert.doesNotThrow(() => s.anyRunning());
  assert.doesNotThrow(() => s.needFrames());
});
