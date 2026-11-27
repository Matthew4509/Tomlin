// The video models a Videographer can be given (src/videomodels.ts): the list, the fits guide, and their downloads
// through a Registry of their own (files in models/video).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { VIDEO_MODELS, SPARE_GB, cardGBOf, fitFor, fitLine, modelFit, shortVideoName, videoBytes, videoModel, videoRegistryModels, videoState } from '../src/videomodels.ts';
import { Registry } from '../src/registry.ts';

const GB = 2 ** 30;

test('the list starts with small Wan 2.1 / 2.2 models, smallest first, each with what a download needs', () => {
  assert.ok(VIDEO_MODELS.length >= 2);
  assert.equal(VIDEO_MODELS[0].id, 'wan21-t2v-1.3b');
  assert.ok(VIDEO_MODELS.every(m => /^Wan 2\.[12] /.test(m.name)));
  for (let i = 1; i < VIDEO_MODELS.length; i++) assert.ok(videoBytes(VIDEO_MODELS[i - 1]) <= videoBytes(VIDEO_MODELS[i]), 'smallest first');
  const ids = new Set(VIDEO_MODELS.map(m => m.id));
  assert.equal(ids.size, VIDEO_MODELS.length, 'ids are unique');
  for (const m of VIDEO_MODELS) {
    assert.match(m.licence, /\S/);
    assert.match(m.source, /^https:\/\/huggingface\.co\//);
    assert.ok(m.vramGB > 0 && m.minRamGB > 0);
    // One video model is three files: the model, its VAE and the text encoder.
    assert.deepEqual(m.files.map(f => f.role).sort(), ['diffusion', 'textenc', 'vae']);
    for (const f of m.files) {
      assert.match(f.rev, /^[0-9a-f]{40}$/, `${f.path}: pinned to one revision`);
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.path}: checked by SHA-256`);
      assert.ok(f.bytes > 0 && Number.isInteger(f.bytes));
      assert.match(f.repo, /^[\w.-]+\/[\w.-]+$/);
    }
  }
});

test('the file sizes are the ones phase 1 read (1.3B 2.84 GB, 5B Q8 5.40 GB, text encoder 6.04 GB)', () => {
  const file = (id: string, role: string) => videoModel(id)!.files.find(f => f.role === role)!;
  assert.equal(file('wan21-t2v-1.3b', 'diffusion').path.split('/').pop(), 'wan2.1_t2v_1.3B_fp16.safetensors');
  assert.equal((file('wan21-t2v-1.3b', 'diffusion').bytes / 1e9).toFixed(2), '2.84');
  assert.equal((file('wan22-ti2v-5b-q8', 'diffusion').bytes / 1e9).toFixed(2), '5.40');
  assert.equal((file('wan21-t2v-1.3b', 'textenc').bytes / 1e9).toFixed(2), '6.04');
  assert.equal((file('wan22-ti2v-5b-q8', 'vae').bytes / 1e9).toFixed(2), '1.41');
  // The 1.3B set on disk: phase 1 adds the rounded sizes to 9.13 GB; the exact bytes come to 9.14 GB.
  assert.equal(videoBytes(videoModel('wan21-t2v-1.3b')!), 2838303560 + 253815318 + 6043068256);
  assert.equal((videoBytes(videoModel('wan21-t2v-1.3b')!) / 1e9).toFixed(2), '9.14');
});

test('the graphics memory each needs is marked as an estimate until it is measured, and says so', () => {
  for (const m of VIDEO_MODELS) {
    if (m.vramMeasured) continue;
    assert.match(fitLine(m, 12), /\(estimate\)/);
  }
});

test('fitFor: Fits with 2 GB to spare, Tight fit when it only just fits, Not enough memory below, null when not known', () => {
  assert.equal(SPARE_GB, 2);
  assert.equal(fitFor(12, 8), 'Fits');
  assert.equal(fitFor(10, 8), 'Fits');
  assert.equal(fitFor(9.9, 8), 'Tight fit');
  assert.equal(fitFor(8, 8), 'Tight fit');
  // A "12 GB" card that reports a little under 12 still counts.
  assert.equal(fitFor(11.95, 12), 'Tight fit');
  assert.equal(fitFor(7.5, 8), 'Not enough memory');
  assert.equal(fitFor(0, 8), 'Not enough memory', 'no card at all');
  assert.equal(fitFor(null, 8), null);
  assert.equal(fitFor(undefined, 8), null);
  assert.equal(fitFor(Number.NaN, 8), null);
});

test('on the Z820\'s 12 GB card the small ones fit and the full 5B is tight; on the HP 800\'s 4 GB K1200 none does', () => {
  const at = (gb: number) => Object.fromEntries(VIDEO_MODELS.map(m => [m.id, modelFit(m, gb)]));
  assert.deepEqual(at(12), { 'wan21-t2v-1.3b': 'Fits', 'wan22-ti2v-5b-q8': 'Fits', 'wan22-ti2v-5b': 'Tight fit' });
  assert.ok(Object.values(at(4)).every(f => f === 'Not enough memory'));
});

test('the line under a fit names what it needs and what the card has, or that it has none, or that it is not known', () => {
  const m = videoModel('wan22-ti2v-5b-q8')!;
  assert.equal(fitLine(m, 12), 'Needs about 9 GB of graphics memory (estimate); the card of this PC has 12 GB.');
  assert.equal(fitLine(m, 11.9, '"Z820"'), 'Needs about 9 GB of graphics memory (estimate); the card of "Z820" has 11.9 GB.');
  assert.equal(fitLine(m, 0), 'Needs about 9 GB of graphics memory (estimate); this PC has no graphics card.');
  assert.equal(fitLine(m, null, '"Z820"'), 'Needs about 9 GB of graphics memory (estimate); the graphics card of "Z820" is not known.');
  // A measured figure says no (estimate).
  assert.equal(fitLine(videoModel('wan21-t2v-1.3b')!, 5), 'Needs about 4.7 GB of graphics memory; the card of this PC has 5 GB.');
});

test('cardGBOf: the biggest card that is not a built-in chip, in GB; 0 with none', () => {
  assert.equal(cardGBOf([{ total: 12 * GB }, { total: 4 * GB }]), 12);
  assert.equal(cardGBOf([{ integrated: true, total: 16 * GB }, { total: 4 * GB }]), 4);
  assert.equal(cardGBOf([{ integrated: true, total: 2 * GB }]), 0);
  assert.equal(cardGBOf([]), 0);
  assert.equal(cardGBOf(null), 0);
});

test('short names drop the bracket; an unknown id is no model', () => {
  assert.equal(shortVideoName(videoModel('wan21-t2v-1.3b')!), 'Wan 2.1 1.3B');
  assert.equal(videoModel('nope'), undefined);
  assert.equal(videoModel(undefined), undefined);
});

test('as Registry models: kind video, every file kept, and their files go in models/video (shared files once)', () => {
  const reg = videoRegistryModels();
  assert.equal(reg.length, VIDEO_MODELS.length);
  assert.ok(reg.every(m => m.kind === 'video'));
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-video-'));
  try {
    const r = new Registry(reg, dir);
    const small = r.get('wan21-t2v-1.3b')!;
    assert.equal(r.bytes(small), videoBytes(videoModel('wan21-t2v-1.3b')!));
    assert.equal(r.installed(small), false);
    assert.equal(r.missing(small), r.bytes(small));
    for (const f of small.files) assert.ok(r.ownPath(small, f).startsWith(join(dir, 'video') + sep), `${f.path} goes in models/video`);
    // The text encoder is one file for every model: the same place on disk.
    const enc = (id: string) => r.ownPath(r.get(id)!, r.get(id)!.files.find(f => f.role === 'textenc')!);
    assert.equal(enc('wan21-t2v-1.3b'), enc('wan22-ti2v-5b'));
    assert.equal(r.get('nope'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a download of an unknown video model is refused, and nothing starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-video-'));
  try {
    const r = new Registry(videoRegistryModels(), dir);
    await assert.rejects(r.start('nope'), /There is no model nope\./);
    assert.deepEqual(r.allDownloads(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Videographer on Home: no model given, a model not downloaded yet, or ready', () => {
  assert.deepEqual(videoState(null, undefined), { state: 'none', text: 'No video model given' });
  assert.deepEqual(videoState('wan21-t2v-1.3b', { installed: false }), { state: 'none', text: 'Video model not downloaded on this PC yet' });
  assert.deepEqual(videoState('wan21-t2v-1.3b', { installed: true }), { state: 'asleep', text: 'Ready: the video model loads when a clip is made' });
});
