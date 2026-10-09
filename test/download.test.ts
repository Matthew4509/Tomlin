import { test } from 'node:test';
import assert from 'node:assert/strict';
test('Hugging Face search: keeps public owner/name repos, most downloaded first, marks gated ones', async () => {
  const { hfFound } = await import('../src/download.ts');
  const got = hfFound([
    { id: 'a/small-GGUF', downloads: 10, likes: 1 },
    { id: 'b/big-GGUF', downloads: 900, likes: 5, gated: 'auto' },
    { id: 'c/secret', private: true, downloads: 5000 },
    { id: 'no-owner', downloads: 1 },
    { modelId: 'd/old-style', downloads: 50 },
  ]);
  assert.deepEqual(got.map(x => x.repo), ['b/big-GGUF', 'd/old-style', 'a/small-GGUF']);
  assert.equal(got[0].gated, true);
  assert.equal(got[1].gated, false);
  assert.deepEqual(hfFound({ error: 'x' }), []);
});
test('Hugging Face search: the next page is the cursor in the Link header, none on the last page', async () => {
  const { nextCursor } = await import('../src/download.ts');
  assert.equal(nextCursor('<https://huggingface.co/api/models?filter=gguf&limit=40&cursor=eyJhIjoxfQ%3D%3D>; rel="next"'), 'eyJhIjoxfQ==');
  assert.equal(nextCursor('<https://huggingface.co/api/models?cursor=abc&limit=40>; rel="next"'), 'abc');
  assert.equal(nextCursor(null), null);
  assert.equal(nextCursor(''), null);
});
test('Hugging Face search: a page cursor is kept only when it has one good place per search', async () => {
  const { cursorPlaces } = await import('../src/download.ts');
  const real = 'eyIkb3IiOlt7ImRvd25sb2FkcyI6NjM4MTl9XX0+/=';
  assert.deepEqual(cursorPlaces([real, false], 2), [real, false]);
  assert.deepEqual(cursorPlaces([real], 1), [real]);
  assert.deepEqual(cursorPlaces(null, 2), [null, null]);
  assert.deepEqual(cursorPlaces([real], 2), [null, null]);
  assert.deepEqual(cursorPlaces(['a&search=x'], 1), [null]);
  assert.deepEqual(cursorPlaces(real, 1), [null]);
});
