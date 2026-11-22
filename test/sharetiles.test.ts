// Network, Setup on a node: its models in two columns (text LLMs | image LLMs), a model found twice listed once, the
// new words for the Sharing permissions, each a tile (icon, name, switch, a (!) whose words show on hover or focus),
// and the lock screen that says why it is there straight after "Save pin and lock".
// Run: node --test test/sharetiles.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { oncePerFile } from '../src/models.ts';

const read = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8');

test('a model found twice (the same name and size) is listed once; Ollama\'s and a different size are not matched', () => {
  const list = [
    { id: 'Qwen3.5-0.8B-Q4_K_M.gguf', name: 'Qwen3.5-0.8B-Q4_K_M', bytes: 533_000_000 },
    { id: 'Qwen3.5-2B-Q4_K_M.gguf', name: 'Qwen3.5-2B-Q4_K_M', bytes: 1_280_000_000 },
    { id: '*/Qwen3.5-2B-Q4_K_M.gguf', name: 'Qwen3.5-2B-Q4_K_M', bytes: 1_280_000_000 },
    { id: '*/gemma-2-2b-it-Q4_K_M.gguf', name: 'gemma-2-2b-it-Q4_K_M', bytes: 1_710_000_000 },
    { id: '*/sub/gemma-2-2b-it-Q4_K_M.gguf', name: 'gemma-2-2b-it-Q4_K_M', bytes: 1_710_000_001 },
    { id: 'ollama:qwen3:4b', name: 'qwen3:4b', bytes: 2_500_000_000 },
    { id: 'ollama:qwen3:4b-copy', name: 'qwen3:4b', bytes: 2_500_000_000 },
  ];
  assert.deepEqual(oncePerFile(list).map(m => m.id), [
    'Qwen3.5-0.8B-Q4_K_M.gguf', 'Qwen3.5-2B-Q4_K_M.gguf', '*/gemma-2-2b-it-Q4_K_M.gguf', '*/sub/gemma-2-2b-it-Q4_K_M.gguf', 'ollama:qwen3:4b', 'ollama:qwen3:4b-copy',
  ]);
  // The node's page reads its chat models through it.
  assert.match(read('src/jobrun/node.ts'), /shareable: \[\.\.\.oncePerFile\(d\.chatList\(\)\)/);
});

test('Setup lists the models in two columns, Text LLMs | Image LLMs, with its help line above them', () => {
  const js = read('public/home.js');
  assert.match(js, /\[col\('Text LLMs', chat\), col\('Image LLMs', pics\)\]/);
  assert.doesNotMatch(js, /'Chat models:'|'Picture models:'/);
  assert.match(read('public/index.html'), /<p class="hint" id="node-share-about">A list of current models on this pc\. If permissions are enabled, anyone with the pin can push, pull, access, or delete these models\.<\/p>/);
  assert.match(read('public/style.css'), /\.node-share \.node-share-list \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('each Sharing permission is a tile: an icon, its name, a switch, and a (!) whose words are its help', () => {
  const html = read('public/index.html');
  const from = html.indexOf('<fieldset class="pick-set node-allow" id="node-allow">');
  const part = html.slice(from, html.indexOf('</fieldset>', from));
  const words: Record<string, [string, string]> = {
    pull: ['Sharing of models', 'Visible only to computers connected on your network'],
    backup: ['Enable backups', "This is a local git, that backs up host's projects to this node."],
    update: ['Allow host to update TOMLIN remotely', 'This makes it easy to update headless nodes. Requires a pin'],
    tune: ['Allow host to test and change model run settings', "This allows changing the model, and setting a guessing model to improve speeds. It also lets the host change the other switches here from its own Network page, with this PC's PIN or the host PIN typed each time. This switch itself can only be changed at this PC."],
    receive: ['Accept models from linked PCs', "Allows a linked pc to push LLM's to this computer."],
    give: ['Let linked PCs pull TOMLIN updates from here', "A linked PC with an older TOMLIN can copy this PC's TOMLIN (its app files only, never your data or models) to update itself. Nothing changes on this PC."],
    lend: ['Allow to be used as part of a cluster', 'This lets another pc use part of the ram, cpu, or vram to run a model.'],
    off: ['Allow host to turn this PC off', "A linked host may shut this PC down, one PC at a time, with this PC's app lock PIN typed on the host. On unless you turn it off. A guest can never do it. It stays off until someone switches it on again."],
    peer: ['Let PCs my host introduces connect to this PC directly', 'A PC linked to the same host may connect to this PC without the host in the middle, over the home network only, and only the PCs that host names. The other switches here still decide what such a PC may do. Off until you switch it on.'],
  };
  const tiles = part.split(/<div class="share-tile(?: share-tile-wide)?">/).slice(1);
  assert.equal(tiles.length, Object.keys(words).length, 'one tile per tick');
  for (const [key, [name, tip]] of Object.entries(words)) {
    const t = tiles.find(x => x.includes(`data-allow="${key}"`));
    assert.ok(t, key);
    assert.match(t, /<span class="share-icon" aria-hidden="true"><svg viewBox="0 0 24 24">/, `${key}: an icon`);
    assert.ok(t.includes(`<span class="perm-switch"><input type="checkbox" id="allow-${key}" data-allow="${key}" aria-describedby="allow-${key}-tip"><span class="perm-knob"></span></span>`), `${key}: a switch`);
    assert.ok(t.includes(`<label for="allow-${key}">${name}</label>`), `${key}: its name`);
    assert.ok(t.includes(`<button class="info-mark" type="button" aria-label="About ${name}" aria-describedby="allow-${key}-tip">!</button><span class="info-tip" role="tooltip" id="allow-${key}-tip">${tip}</span>`), `${key}: its (!)`);
  }
  // The help is no longer a line under each tick, taking up room.
  assert.doesNotMatch(part, /Allows others on the network to copy this PC's models/);
  assert.doesNotMatch(part, /<label class="check"><input type="checkbox" data-allow=/);
  // The cluster tile keeps when it lends, with its minutes, in sight (a choice cannot sit in a hover).
  const lend = tiles.find(x => x.includes('data-allow="lend"'))!;
  assert.match(lend, /<p class="hint">Only while nobody is using this PC: when Windows is locked, or after <select id="node-lend-idle"[^]*<\/select> minutes with no key press or mouse move\. Using this PC again ends it at once\.<\/p>/);
  // Allow all is a switch too, first in the part (Open sharing permissions focuses the first box there).
  assert.match(part, /<legend>Sharing and cluster permissions:<\/legend>\s*<div class="share-all"><span class="perm-switch"><input type="checkbox" id="node-allow-all">/);
  // The words show on hover or focus, colours by the page's own names, nothing under 12px.
  const css = read('public/style.css');
  const block = css.slice(css.indexOf('/* ---- Network, Setup: the models in two columns'));
  assert.match(block, /\.info:hover \.info-tip, \.info:focus-within \.info-tip \{ display: block; \}/);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i, 'no colour by number');
  for (const m of block.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 12, m[0]);
});

test('straight after Save pin and lock, the codes window and then the lock screen say the lock is on and what opens it', () => {
  const js = read('public/lock.js');
  const save = js.slice(js.indexOf("$('#applock-new-form').addEventListener('submit'"), js.indexOf('// ---- The lock screen ----'));
  assert.ok(save.indexOf("store('applock-just-set', '1')") < save.indexOf('location.reload()'), 'marked before the page starts again');
  assert.match(save, /await showCodes\(r\.recoveryCodes, newKind\(\)\)/);
  assert.match(js, /The app lock is on now\. Once you press I've saved them, TOMLIN locks: open it with the \$\{lockWord\(locks\)\} you just made\./);
  assert.match(js, /The app lock is on\. Type the \$\{lockWord\(kind\)\} you just made to open TOMLIN\./);
  assert.match(js, /Then this PC turns on as a node\./);
  // Said once: opening the lock clears it.
  assert.match(js, /async function appLockOpened\(\) \{\s*store\('applock-just-set', ''\);/);
  // New set in Settings makes codes without locking: its window says nothing about a lock.
  assert.match(js, /await showCodes\(recoveryCodes\);/);
  assert.match(read('public/index.html'), /<p class="hint" id="codes-next" role="note" hidden><\/p>/);
});
