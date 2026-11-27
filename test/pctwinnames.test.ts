// Two linked PCs with one name ("Worker PC") are told apart wherever a list names them: the Direct links pickers, the
// update and copy lines in Models on my other PCs, the admin key's "Holding the key" list and the Network tiles, as the
// left panel does (app.pcLabel: the computer's own name, else the address).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const home = read('home.js');
const net = read('network.js');

test('behaviour: pcShown adds the computer name for a twin, keeps the name for this PC and unknown PCs', () => {
  const src = home.slice(home.indexOf('app.pcShown = '), home.indexOf('\n', home.indexOf('app.pcShown = ')));
  const homeUi = { pcs: [{ id: 'a', name: 'Worker PC', computer: 'DESKTOP-7Q4M2KD' }, { id: 'b', name: 'Worker PC', computer: 'HP800' }] };
  const app: Record<string, (id: string, name?: string) => string> = { pcLabel: id => `Worker PC (${homeUi.pcs.find(p => p.id === id)!.computer})` };
  new Function('app', 'homeUi', src)(app, homeUi);
  assert.equal(app.pcShown('a', 'Worker PC'), 'Worker PC (DESKTOP-7Q4M2KD)');
  assert.equal(app.pcShown('b', 'Worker PC'), 'Worker PC (HP800)');
  assert.equal(app.pcShown('here', 'My PC'), 'My PC');
  assert.equal(app.pcShown('guest-1', 'Visitor'), 'Visitor');
});

test('behaviour: the left panel words give the computer name to each of two PCs called Worker PC', () => {
  const src = home.slice(home.indexOf('function pcTwinWords('), home.indexOf('/** A PC\'s name as every list shows it'));
  const pcName = (_k: string, f: string) => f;
  const twins = new Function('pcName', 'homeUi', `${src}; return pcTwinWords;`)(pcName, { pcs: [] })([
    { id: 'a', name: 'Worker PC', computer: 'DESKTOP-7Q4M2KD', url: 'https://192.168.1.20:8741' },
    { id: 'b', name: 'Worker PC', computer: 'HP800', url: 'https://192.168.1.21:8741' },
    { id: 'c', name: 'Z820', computer: 'Z820', url: 'https://192.168.1.22:8741' },
  ]);
  assert.deepEqual(twins, { a: 'DESKTOP-7Q4M2KD', b: 'HP800' });
});

test('Direct links, the admin key list and the Network tiles use it', () => {
  const links = home.slice(home.indexOf('function drawDirectLinks(sh) {'), home.indexOf('/** Follows a direct copy on the page'));
  assert.match(links, /const nm = p => app\.pcShown\(p\.id, p\.name\);/);
  assert.match(links, /const opts = \(\) => pcs\.map\(p => el\('option', \{ value: p\.id, text: nm\(p\), disabled: !choosable\(p\) \}\)\);/);
  assert.match(links, /el\('span', \{ text: `\$\{nm\(p\.a\)\} and \$\{nm\(p\.b\)\}` \}\)/);
  assert.match(links, /text: `\$\{c\.m\.name\}: from \$\{nm\(c\.from\)\} to \$\{nm\(c\.to\)\}`/);
  assert.doesNotMatch(links, /text: p\.name, disabled/);
  assert.match(home, /const names = list => list\.map\(p => `"\$\{app\.pcShown\(p\.id, p\.name\)\}"`\)\.join\(', '\);/);
  assert.match(home, /el\('span', \{ class: 'pc-tile-name' \}, el\('strong', \{ text: app\.pcShown\(p\.id, p\.name\) \}\)/);
  assert.match(home, /el\('strong', \{ text: app\.pcShown\(p\.id, p\.name\) \}\),\n\s+\/\/ What tells two PCs of the same name apart/);
});

test('the update and copy lines in Models on my other PCs use it', () => {
  assert.match(net, /const netPcName = \(id, name\) => app\.pcShown\?\.\(id, name\) \?\? name;/);
  assert.match(net, /const verb = x => \{ const t = \{ \.\.\.x, pcName: netPcName\(x\.pc, x\.pcName\) \};/);
});
