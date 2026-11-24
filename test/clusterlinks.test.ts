// "This PC takes part" off needs the PCs in the cluster linked to each other at the PCs themselves: the Cluster page says
// so in one line before the switch is pressed (src/cluster/loader.ts linksNeeded, sent by src/jobrun.ts, shown by
// public/home.js), and the switch's own refusal stays as it was. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseLoader, linksNeeded, type LoaderFacts } from '../src/cluster/loader.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GB = 2 ** 30;
const A = 'aaaa0001';
const B = 'bbbb0002';
const C = 'cccc0003';
const pc = (id: string, name: string, card: number, borrows: string[] | null, more: Partial<LoaderFacts> = {}): LoaderFacts => ({
  id, name, answering: true, away: false, guest: false, backupsOnly: false, card: card * GB, ram: 64 * GB, cluster: borrows ? { borrows, via: 'Ethernet' } : null, ...more,
});

test('members not linked to each other: one line names the PC to link them on and what to do there', () => {
  const set = [pc(A, 'HP 800', 8, []), pc(B, 'Z820', 16, [])];
  assert.ok('why' in chooseLoader(set), 'the switch would be refused');
  assert.equal(linksNeeded(set), 'To switch this off, the PCs in the cluster must be linked to each other at the PCs themselves: on "Z820", link "HP 800" under Network with its setup code, and tick "Allow to be used as part of a cluster" on it.');
  const three = [pc(A, 'HP 800 A', 8, []), pc(B, 'Z820', 16, [A]), pc(C, 'HP 800 B', 8, [])];
  assert.equal(linksNeeded(three), 'To switch this off, the PCs in the cluster must be linked to each other at the PCs themselves: on "Z820", link "HP 800 B" under Network with its setup code, and tick "Allow to be used as part of a cluster" on it.');
  const none = [pc(A, 'HP 800 A', 8, []), pc(B, 'Z820', 16, []), pc(C, 'HP 800 B', 8, [])];
  assert.match(linksNeeded(none), /on "Z820", link "HP 800 A" and "HP 800 B" under Network with their own setup codes, and tick "Allow to be used as part of a cluster" on each of them\.$/);
});

test('nothing is said when a member can load the model, or when links are not what stops it', () => {
  assert.equal(linksNeeded([pc(A, 'HP 800', 8, []), pc(B, 'Z820', 16, [A])]), '', 'linked: the switch works');
  assert.equal(linksNeeded([pc(A, 'HP 800', 8, [])]), '', 'one PC: the refusal says it needs two');
  assert.equal(linksNeeded([]), '');
  assert.equal(linksNeeded([pc(A, 'HP 800', 8, [], { answering: false }), pc(B, 'Z820', 16, [], { answering: false })]), '', 'both off');
  assert.equal(linksNeeded([pc(A, 'HP 800', 8, null), pc(B, 'Z820', 16, null)]), '', 'older TOMLIN: it does not say its links');
  const wifi = [pc(A, 'Laptop', 8, [], { cluster: { borrows: [], via: 'Wi-Fi' } }), pc(B, 'Z820', 16, [], { guest: true })];
  assert.equal(linksNeeded(wifi), '', 'on Wi-Fi or a guest: links would not help');
  // The strongest that could load the model but for its links is the one named; a strongest one that is off is passed over.
  const strongOff = [pc(A, 'HP 800', 8, []), pc(B, 'Z820', 16, [], { answering: false }), pc(C, 'HP 600', 4, [])];
  assert.match(linksNeeded(strongOff), /^To switch this off, .*: on "HP 800", link "Z820" and "HP 600" under Network/);
});

test('the server sends the line with the cluster, the page shows it before the switch, and the refusal is unchanged', () => {
  const jobrun = readFileSync(join(ROOT, 'src', 'jobrun.ts'), 'utf8');
  // Sent only when something is missing, so the cluster's answer keeps its shape otherwise.
  assert.match(jobrun, /const need = linksNeeded\(membersFacts\(c, d\.store\.peek\(\)\?\.remotes \?\? \[\]\)\);\s*return \{ \.\.\.c, gaps: clusterGaps\(\), \.\.\.\(need \? \{ linksNeeded: need \} : \{\}\) \};/);
  const home = readFileSync(join(ROOT, 'public', 'home.js'), 'utf8');
  assert.match(home, /!cl\.out && cl\.members\.length && cl\.linksNeeded \? el\('p', \{ class: 'hint', role: 'note', 'data-key': 'cluster-links-needed', text: cl\.linksNeeded \}\) : null\);/);
  // Shown inside the "This PC takes part" card, ahead of the cluster's PCs.
  const card = home.indexOf("const partRow = el('div', { class: 'set-card cluster-part' }");
  assert.ok(card > 0 && home.indexOf("'data-key': 'cluster-links-needed'") > card);
  assert.match(home, /if \(!\(await changeCluster\(\{ takesPart: want \}, ask\)\)\) e\.target\.checked = !want;/);
  assert.match(readFileSync(join(ROOT, 'src', 'jobrun', 'linking.ts'), 'utf8'), /return \{ status: 400, body: \{ error: `This PC cannot stay out of the cluster yet: \$\{chosen\.why\.replace\(\/\\\.\$\/, ''\)\}\.` \} \};/);
});
