// A linked PC that is on but slow (busy with a long chat, or a disk waking) was shown as off by every page that checks
// with 3 s (Storage, Hire staff), while an update to it still went through. Run: node --test test/slowpc.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const links = read('src/jobrun/links.ts');
const node = read('src/jobrun/node.ts');

test('a hello out of time keeps what the PC said and asks again with 30 s; only no answer then makes it off', () => {
  assert.match(links, /if \(!signal\.aborted\) seen\.delete\(r\.id\);\n\s+else if \(ms < SLOW_MS\) checkSlow\(r\);/);
  assert.match(links, /export const SLOW_MS = 30_000;/);
  const slow = links.slice(links.indexOf('function checkSlow('), links.indexOf('export const isSlow'));
  assert.match(slow, /hello\(r, SLOW_MS\)\.then\(\(\) => \{\n\s+missed\.delete\(r\.id\);\n\s+slowAt\.set\(r\.id, Date\.now\(\)\);/);
  assert.match(slow, /\(\) => \{\n\s+seen\.delete\(r\.id\);\n\s+slowAt\.delete\(r\.id\);\n\s+missed\.set\(r\.id, Date\.now\(\)\);/);
  // Out of time is not "missed" (that is what makes the quick list say off).
  assert.match(links, /if \(!timedOut\(e\)\) missed\.set\(r\.id, Date\.now\(\)\);/);
});

test('remoteStatus: out of time but answered before is on, marked slow; never answered is "asking", not off', () => {
  const rs = links.slice(links.indexOf('export async function remoteStatus('));
  assert.match(rs, /if \(!timedOut\(e\)\) throw e;\n\s+if \(!last\) throw Object\.assign\(new Error\(`"\$\{r\.name\}" is slow to answer: asked again with more time`\), \{ asking: true \}\);\n\s+h = last;/);
  assert.match(rs, /ok: true, slow, role: r\.role,/);
});

test('a PC answers a hello without waiting for its backup disk to be read', () => {
  const hello = node.slice(node.indexOf("if (p === '/worker/hello') {"), node.indexOf("if (p === '/worker/hello') {") + 4000);
  assert.doesNotMatch(hello, /await carry\.diskOf/);
  assert.match(hello, /const disk = keptDiskNow\(\);/);
  assert.match(node, /if \(!keptDiskReading && Date\.now\(\) - keptDiskAt > 30_000\) \{/);
});
