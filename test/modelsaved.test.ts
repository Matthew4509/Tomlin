// The run_command gap (27 Nov): a file a model saved in one answer could be run by "test" in the next with no card when
// Run was Allowed. Every save TOMLIN makes for a model is remembered per folder (src/modelsaved.ts) until the person
// allows a command there; until then a run asks every time, naming the files. Behaviour, with a made-up runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSaved, pendingWhy } from '../src/modelsaved.ts';
import { CodeTurn, type Exec } from '../src/codetools.ts';
import * as ws from '../src/workspace.ts';

test('a model\'s saves are remembered per folder, kept across a restart, and cleared for one folder only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ms-'));
  try {
    const file = join(dir, 'model-saved.json');
    const m = ModelSaved.load(file);
    const a = join(dir, 'Game');
    const b = join(dir, 'Gamekeeper');
    m.mark(join(a, 'test', 'evil.test.js'));
    m.mark(join(a, 'package.json'));
    m.mark(join(b, 'x.js'));
    // "Game" does not take in "Gamekeeper": a folder is matched whole.
    assert.equal(m.pending(a).length, 2);
    assert.equal(m.pending(b).length, 1);
    await m.settled();
    assert.equal(ModelSaved.load(file).pending(a).length, 2, 'kept across a restart');
    m.clear(a);
    assert.equal(m.pending(a).length, 0);
    assert.equal(m.pending(b).length, 1, 'only that folder');
    await m.settled();
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).files.length, 1);
    assert.match(pendingWhy([join(a, 'test', 'evil.test.js')], a), /a model saved 1 file in this folder since you last allowed a command here \(test\/evil\.test\.js\), and the command may run it/);
    assert.equal(ModelSaved.load(join(dir, 'none.json')).pending(a).length, 0, 'no file: nothing pending');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every workspace save marks the file, except what the person typed in Files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ms-ws-'));
  const seen: string[] = [];
  ws.setOnSaved(f => seen.push(f));
  try {
    await ws.save(root, 'a.js', 'x');
    await ws.save(root, 'b.js', 'y', true, false, true);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /a\.js$/);
  } finally {
    ws.setOnSaved(null);
    await rm(root, { recursive: true, force: true });
  }
});

test('with Run Allowed, a run asks while a model\'s files are pending there, and the person\'s yes clears them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ms-run-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const since = new ModelSaved(null);
    const ran: string[][] = [];
    const exec: Exec = async (_exe, args) => (ran.push(args), { code: 0, out: 'ok', timedOut: false });
    const cards: Array<[string, { detail?: string } | undefined]> = [];
    const turn = (yes: boolean) => new CodeTurn({ root, perCall: 2000, run: 'allowed', exec, since, confirm: async (what, extra) => (cards.push([what, extra]), yes) });

    // Nothing pending: Allowed runs with no card, as before.
    assert.match(await turn(true).run('run_command', '{"name":"test"}'), /finished/);
    assert.equal(cards.length, 0);

    // A model saved a test file in an earlier answer: asked although Allowed, naming it; a no runs nothing.
    since.mark(join(root, 'test', 'wipe.test.js'));
    assert.match(await turn(false).run('run_command', '{"name":"test"}'), /NOT allowed/);
    assert.equal(cards.length, 1);
    assert.match(String(cards[0][1]?.detail), /Asked although Run is Allowed: a model saved 1 file in this folder since you last allowed a command here \(test\/wipe\.test\.js\)/);
    assert.equal(ran.length, 1, 'not run');
    assert.equal(since.pending(root).length, 1, 'still pending after a no');

    // A yes runs it and clears the list: the next run needs no card.
    assert.match(await turn(true).run('run_command', '{"name":"test"}'), /finished/);
    assert.equal(ran.length, 2);
    assert.equal(since.pending(root).length, 0);
    assert.match(await turn(true).run('run_command', '{"name":"test"}'), /finished/);
    assert.equal(cards.length, 2, 'no card once cleared');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the server marks every save and hands the list to the coding tools', async () => {
  const core = (await readFile(new URL('../src/server/core.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(core, /export const modelSaved = ModelSaved\.load\(join\(HOME\.data, 'model-saved\.json'\)\);\nsetOnSaved\(full => modelSaved\.mark\(full\)\);/);
  assert.match(await readFile(new URL('../src/server/tools.ts', import.meta.url), 'utf8'), /since: modelSaved,/);
  assert.match(await readFile(new URL('../src/toolkit.ts', import.meta.url), 'utf8'), /since: o\.since,/);
  // The Files editor is the person's own typing; Save under a code block in an answer (fromAnswer) is a model's.
  const work = await readFile(new URL('../src/server/work.ts', import.meta.url), 'utf8');
  assert.match(work, /const fromAnswer = b\.fromAnswer === true;/);
  assert.match(work, /ws\.save\(await workspaceDir\(\), b\.path, b\.text, b\.create !== false, fromAnswer, !fromAnswer\)/);
});
