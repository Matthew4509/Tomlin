import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { otherModelDirs } from '../src/oldcopies.ts';
import { Models } from '../src/models.ts';
import { Registry } from '../src/registry.ts';

function copy(parent: string, name: string, pkg = 'shelby') {
  const dir = join(parent, name);
  mkdirSync(join(dir, 'models', 'chat'), { recursive: true });
  mkdirSync(join(dir, 'models', 'image'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg }));
  return dir;
}

test('older copies: their models are used in place, same ids; another app beside it is ignored', () => {
  const parent = mkdtempSync(join(tmpdir(), 'sm-copies-'));
  try {
    const old = copy(parent, 'shelby-2.0.21');
    const now = copy(parent, 'shelby-2.0.22');
    copy(parent, 'other-app', 'other-app');
    writeFileSync(join(old, 'models', 'chat', 'qwen-2b.gguf'), 'x'.repeat(10));
    writeFileSync(join(now, 'models', 'chat', 'gemma-1b.gguf'), 'x'.repeat(5));
    assert.deepEqual(otherModelDirs(now), [join(old, 'models')]);

    const m = new Models(join(now, 'models', 'chat'), join(now, 'models-folder.txt'), undefined, null);
    m.copies = () => otherModelDirs(now).map(d => join(d, 'chat'));
    assert.deepEqual(m.list().map(x => [x.id, x.where]), [['gemma-1b.gguf', 'own'], ['qwen-2b.gguf', 'own']]);
    assert.equal(m.path('qwen-2b.gguf'), join(old, 'models', 'chat', 'qwen-2b.gguf'));
    assert.ok(m.has('qwen-2b.gguf'));

    // A picture-model file: only a whole one (the exact size) in the old copy is used; otherwise it downloads here.
    const regDir = join(parent, 'registry');
    mkdirSync(regDir);
    writeFileSync(join(regDir, 'pic.json'), JSON.stringify({ id: 'pic', kind: 'image', name: 'Pic', about: '', licence: 'x', quant: 'x', minRamGB: 1, minVramGB: 0, files: [{ role: 'model', path: 'pic.safetensors', bytes: 8, sha256: 'a' }] }));
    const r = new Registry(regDir, join(now, 'models'));
    r.copies = () => otherModelDirs(now);
    const pic = r.get('pic')!;
    assert.equal(r.installed(pic), false);
    writeFileSync(join(old, 'models', 'image', 'pic.safetensors'), 'x'.repeat(5));
    assert.equal(r.filePath(pic, pic.files[0]), join(now, 'models', 'image', 'pic.safetensors'));
    writeFileSync(join(old, 'models', 'image', 'pic.safetensors'), 'x'.repeat(8));
    assert.equal(r.installed(pic), true);
    assert.equal(r.filePath(pic, pic.files[0]), join(old, 'models', 'image', 'pic.safetensors'));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('older copies named before TOMLIN (package shelby) and after (package tomlin) are both found', () => {
  const parent = mkdtempSync(join(tmpdir(), 'sm-copies-'));
  try {
    const before = copy(parent, 'shelby-2.0.44');
    const after = copy(parent, 'tomlin-2.0.45', 'tomlin');
    const now = copy(parent, 'tomlin-2.0.46', 'tomlin');
    copy(parent, 'other-app', 'other-app');
    assert.deepEqual(otherModelDirs(now).sort(), [join(before, 'models'), join(after, 'models')].sort());
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a picture model lent by another folder is loaded with the LoRA from that folder, not from this copy', async () => {
  const { Images } = await import('../src/images.ts');
  const parent = mkdtempSync(join(tmpdir(), 'sm-lora-'));
  try {
    const old = copy(parent, 'shelby-2.0.21');
    const now = copy(parent, 'shelby-2.0.22');
    mkdirSync(join(now, 'registry'));
    writeFileSync(join(now, 'registry', 'pic.json'), JSON.stringify({ id: 'pic', kind: 'image', name: 'Pic', about: '', licence: 'x', quant: 'x', minRamGB: 1, minVramGB: 0, files: [{ role: 'model', path: 'pic.safetensors', bytes: 8, sha256: 'a' }, { role: 'lora', path: 'lcm.safetensors', bytes: 4, sha256: 'b' }] }));
    mkdirSync(join(old, 'models', 'image', 'loras'));
    writeFileSync(join(old, 'models', 'image', 'pic.safetensors'), 'x'.repeat(8));
    writeFileSync(join(old, 'models', 'image', 'loras', 'lcm.safetensors'), 'x'.repeat(4));
    const images = new Images({ root: now, models: join(now, 'models'), data: join(now, 'data') } as never);
    images.registry.copies = () => otherModelDirs(now);
    const pic = images.registry.get('pic')!;
    const args: string[] = (images as unknown as { args: (m: unknown, port: number, threads: number, decoder: string) => string[] }).args(pic, 1, 0, 'full');
    assert.equal(args[args.indexOf('-m') + 1], join(old, 'models', 'image', 'pic.safetensors'));
    assert.equal(args[args.indexOf('--lora-model-dir') + 1], join(old, 'models', 'image', 'loras'));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
