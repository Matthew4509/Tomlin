// What the models have done (W2-23): src/modelsdone.ts sums what TOMLIN keeps already, for This PC's Models on this PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelWords, modelsDone } from '../src/modelsdone.ts';

const now = new Date('2026-11-26T05:00:00.000Z');
const pic = (at: string, modelName: string, seconds: number, width: number) => ({ at, modelName, seconds, generated: { width, height: width } });

test('pictures by model and size, clips by model, PC and quality (minutes for 5 s), chat by answers; today said apart; older work left out', () => {
  const d = modelsDone({
    now,
    pictures: [
      pic('2026-11-26T01:00:00.000Z', 'Z-Image Turbo on Worker PC', 200, 1536),
      pic('2026-11-26T02:00:00.000Z', 'Z-Image Turbo on Worker PC', 210, 1536),
      pic('2026-11-26T03:00:00.000Z', 'Z-Image Turbo on Worker PC', 60, 1024),
      pic('2026-11-25T03:00:00.000Z', 'RealVisXL V5 Lightning', 18, 1024),
      pic('2026-11-01T03:00:00.000Z', 'Old model', 5, 512),
      { ...pic('2026-11-26T03:30:00.000Z', 'Deleted', 5, 512), removed: true },
    ],
    clips: [
      { at: '2026-11-26T00:30:00.000Z', model: 'wan22-ti2v-5b-q8', seconds: 5, quality: 'normal', tookMs: 762_000, pc: 'Worker PC' },
      { at: '2026-11-26T00:43:00.000Z', model: 'wan22-ti2v-5b-q8', seconds: 5, quality: 'normal', tookMs: 762_000, pc: 'Worker PC' },
      { at: '2026-11-26T00:10:00.000Z', model: 'wan22-ti2v-5b-q8', seconds: 2, quality: 'draft', tookMs: 203_000, pc: 'Worker PC' },
    ],
    chat: [{ pc: 'This PC', model: '*/Qwen3.8-Flash-Next-UD-Q3_K_XL-00001-of-00004.gguf', ms: 120_000, answers: 4 }, { pc: 'Worker PC', model: 'GLM-4.7-Flash-UD-Q4_K_XL', ms: 0, answers: 0 }],
    videoNames: { 'wan22-ti2v-5b-q8': 'Wan 2.2 5B Q8' },
  });
  assert.deepEqual(d.pictures, [
    { name: 'Z-Image Turbo on Worker PC', count: 3, sizes: [{ px: 1024, count: 1, seconds: 60 }, { px: 1536, count: 2, seconds: 205 }] },
    { name: 'RealVisXL V5 Lightning', count: 1, sizes: [{ px: 1024, count: 1, seconds: 18 }] },
  ]);
  assert.deepEqual(d.clips, [
    { name: 'Wan 2.2 5B Q8', pc: 'Worker PC', count: 2, quality: 'normal', minutesFor5s: 12.7 },
    // A 2 s clip in 203 s is about 8.5 min for 5 s.
    { name: 'Wan 2.2 5B Q8', pc: 'Worker PC', count: 1, quality: 'draft', minutesFor5s: 8.5 },
  ]);
  assert.deepEqual(d.chat, [{ name: 'Qwen3.8-Flash-Next-UD-Q3_K_XL', pc: 'This PC', answers: 4, secondsEach: 30 }]);
  assert.deepEqual(d.today, { pictures: 3, clips: 3, drawMs: 470_000 + 762_000 * 2 + 203_000 });
  assert.equal(modelWords('D:/models/GLM-5.3-UD-IQ2_M-00001-of-00006.gguf'), 'GLM-5.3-UD-IQ2_M');
});

test('This PC reads it when the block comes on screen; the route reads only what is kept', () => {
  const js = readFileSync(new URL('../public/modelsdone.js', import.meta.url), 'utf8');
  assert.match(js, /draw\(await api\('\/api\/models\/done'\)\)/);
  assert.match(js, /new IntersectionObserver\(/);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="set-block models-done" id="models-done" aria-live="polite"><\/div>/);
  assert.match(html, /<script src="modelsdone\.js"><\/script>/);
  const route = readFileSync(new URL('../src/server/thispc.ts', import.meta.url), 'utf8');
  assert.match(route, /'\/api\/models\/done': async/);
  assert.match(route, /byModel\.top\(p\.key, 7\)/);
});
