// One name per thing on screen (audit U4, his picks 22 Oct): a chat model, a picture model, Models on my other PCs, the
// Network page and its Connect a PC, the Models page ("Models: add or remove"), Start TOMLIN when this PC starts, and the
// Models page's size filters and Mixture-of-experts tick. The old names are kept out of every screen (public/) and out of
// what the server says (src/), so a new screen cannot bring one back. Staff names are his to keep as they are for now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap(n => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? files(f, ext) : ext.test(n) ? [f] : [];
  });
}
/** Each place a pattern is found, as "file:line: text". */
function found(list: string[], re: RegExp): string[] {
  return list.flatMap(f => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (re.test(line) ? [`${f.slice(ROOT.length)}:${i + 1}: ${line.trim().slice(0, 120)}`] : [])));
}

const OLD = [
  /Network: connect PCs/,
  /My local LLMs/,
  /Link another PC/i,
  /Nodes and memory/,
  /Standard models/,
  /Image creation models/,
  /Chat models \(LLMs\)/,
  /Add a model/,
  /Start with Windows/,
  /\bMin B\b|\bMax B\b|\bMin GB\b|\bMax GB\b/,
  /MoE's/,
];

test('the old names are on no screen and in nothing the server says', () => {
  const list = [...files(join(ROOT, 'public'), /\.(js|html|css)$/), ...files(join(ROOT, 'src'), /\.(ts|js)$/)];
  for (const re of OLD) assert.deepEqual(found(list, re), [], `old name ${re} is back`);
});

test('a model that chats is a chat model on screen, never an LLM', () => {
  const list = files(join(ROOT, 'public'), /\.(js|html|css)$/);
  assert.deepEqual(found(list, /\bLLM('?s)?\b/), []);
});

test('the new names are there: the page, its button, the shared models, the Models button, the filters', () => {
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /<h2 id="nodes-title">Network<\/h2>/);
  assert.match(html, /<h2 id="net-title">Models on my other PCs<\/h2>/);
  assert.match(html, />Models: add or remove</);
  assert.match(html, /Smallest size \(billions\)/);
  const homeview = readFileSync(join(ROOT, 'public', 'homeview.js'), 'utf8');
  assert.match(homeview, /'Connect a PC \(optional\)'/);
  const models = readFileSync(join(ROOT, 'public', 'models.js'), 'utf8');
  assert.match(models, /['"]Mixture-of-experts['"]/);
});
