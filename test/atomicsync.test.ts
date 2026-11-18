// Small files written from code that cannot wait go through a temp copy and a swap (src/atomic.ts writeAtomicSync):
// models-folder.txt, models-home.txt, the runner list and the running mark. A write that fails leaves the old file
// whole and no copy behind. On real temp folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomicSync } from '../src/atomic.ts';
import { Models } from '../src/models.ts';
import { ModelsHome } from '../src/modelhome.ts';

test('a small file is swapped in whole; one that cannot be swapped in leaves the old one and no copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-atomicsync-'));
  try {
    const file = join(dir, 'deeper', 'note.json');
    writeAtomicSync(file, '{"a":1}');
    writeAtomicSync(file, '{"a":2}');
    assert.equal(readFileSync(file, 'utf8'), '{"a":2}');
    assert.deepEqual(readdirSync(join(dir, 'deeper')), ['note.json']);
    // A folder where the file should be: the swap fails, the copy goes, and the error is thrown.
    mkdirSync(join(dir, 'taken'));
    writeFileSync(join(dir, 'taken', 'x'), 'x');
    assert.throws(() => writeAtomicSync(join(dir, 'taken'), 'new'));
    assert.deepEqual(readdirSync(dir).sort(), ['deeper', 'taken']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the models folder settings are written whole and read back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-atomicsync-'));
  try {
    const other = join(dir, 'LM');
    mkdirSync(other);
    const m = new Models(join(dir, 'own'), join(dir, 'models-folder.txt'), undefined, null);
    m.setOther(other);
    assert.equal(readFileSync(join(dir, 'models-folder.txt'), 'utf8'), `${other}\r\n`);
    assert.equal(m.other(), other);
    const h = new ModelsHome(join(dir, 'models-home.txt'), join(dir, 'models'));
    h.set(join(dir, 'D-models'));
    assert.equal(h.dir(), join(dir, 'D-models'));
    assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.tmp')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
