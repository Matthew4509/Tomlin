// The Cluster page's "Choose an LLM" lists only the chat models already on your PCs: new models are added under
// Models (download, import, a copy), never from this list. Run: node --test test/clusterpick.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('measured cluster examples: a pop-up, each setup its PCs\' full hardware above, then what was measured on it', () => {
  type Pc = { name: string; cpu: string; ram: string; card: string };
  type Row = { model: string; file: string; how: string; tool: string; tokS: number | null; date: string; answers: number; note?: string };
  const d = JSON.parse(read('public/cluster-measured.json')) as { pcs: Record<string, Pc>; setups: { id: string; title: string; pcs: string[]; results: Row[] }[]; findings: string[] };
  assert.ok(d.setups.length >= 5 && d.findings.length >= 3);
  for (const s of d.setups) {
    assert.ok(s.pcs.length >= 1 && s.results.length >= 1, s.id);
    for (const id of s.pcs) for (const k of ['name', 'cpu', 'ram', 'card'] as const) assert.ok(d.pcs[id]?.[k], `${s.id}: ${id} has no ${k}`);
    for (const r of s.results) {
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${s.id}: ${r.model} date`);
      assert.ok(r.tool === 'app' || r.tool === 'test run', `${s.id}: ${r.model} tool`);
      // A run that worked has its speed; a failed one says why and has none.
      assert.ok(r.tokS === null ? /fail/.test(r.note ?? '') : r.tokS > 0, `${s.id}: ${r.model} speed`);
    }
  }
  assert.doesNotMatch(JSON.stringify(d), /DESKTOP-|C:\\|@[a-z0-9-]+\.(com|net|org)|Matthew/i);
  const js = read('public/clusterextra.js');
  assert.match(js, /\$\('#cluster-measured-open'\)\?\.addEventListener\('click', openMeasured\);/);
  assert.ok(js.indexOf("el('div', { class: 'cluster-table' }, hw)") < js.indexOf("el('div', { class: 'cluster-table' }, res)"), 'the hardware above the results');
  const html = read('public/index.html');
  assert.match(html, /id="cluster-measured-open" aria-haspopup="dialog">See measured cluster examples<\/button>/);
  assert.match(html, /<dialog id="cluster-measured-dlg"/);
  assert.doesNotMatch(html, /128 GB node with a 12 GB card/);
  assert.doesNotMatch(read('public/home.js'), /app\.clusterExtra\.examples\(\)/);
});

test('Choose an LLM: this PC and the linked PCs only, no model to download', () => {
  const js = read('public/clusterextra.js');
  assert.doesNotMatch(js, /POPULAR|huggingface|\/api\/chatmodels\/(get|sizes)|not installed: downloaded/);
  assert.match(js, /const rank = r => \(r\.here \? 0 : 1\);/);
  assert.match(js, /throw new Error\('it is not on any of your PCs: add it under Models first'\);/);
  // Short beside the name: "Copied on demand"; which PC it comes from is behind its (!).
  assert.match(js, /const noteOf = r => \(r\.here \? 'on this PC' : 'Copied on demand'\);/);
  assert.match(js, /`It is copied from "\$\{r\.remotes\.find\(o => o\.copy\)\.name\}" to this PC first/);
  // "Loads the model" only once there is a cluster for it to load for.
  assert.match(read('public/home.js'), /cl\.out \|\| !cl\.members\.length \? null : el\('span', \{ class: 'cluster-tag cluster-loads', text: 'Loads the model' \}\)/);
  assert.match(read('public/home.js'), /\? 'Choose a model from your network\.'/);
});

test('the Cluster page switches encryption for its PCs: both halves set from here, or what that PC\'s owner ticks', () => {
  const home = read('public/home.js');
  assert.match(home, /    partRow,\n    clusterPlainRow\(members, ask\),\n/);
  const row = home.slice(home.indexOf('function clusterPlainRow('), home.indexOf('/** A speech bubble'));
  assert.match(row, /await api\('\/api\/remotes', \{ action: 'plain-link', id: p\.id, on: !encrypt \}\);/);
  assert.match(row, /const r = await permSetWithPin\(p, \{ plainLinks: true \}\);/);
  assert.match(row, /p\.allow\?\.tune !== true/);
  assert.match(row, /if \(!encrypt && !confirm\('Turn off encryption for the cluster\?/);
});

test('Choose an LLM: the picked row is marked, said again under the list, then Staff (someone hired or Add staff) and Start chat', () => {
  const home = read('public/home.js');
  const css = read('public/style.css');
  assert.match(css, /\.cluster-llm-row\.on \{ background: var\(--accent-soft\); box-shadow: inset 3px 0 0 var\(--accent\); \}/);
  assert.match(home, /r => \{ homeUi\.clusterLlm = r\.key; showPicked\(r\); \}/);
  assert.match(home, /el\('option', \{ value: '', text: 'Add staff' \}\), \.\.\.chatStaff\.map/);
  // Someone already hired takes the picked model as theirs; Add staff hires someone new with it.
  assert.match(home, /if \(whoPick\.value\) \{\n\s+team\.data = await api\('\/api\/staff', \{ action: 'change', id: whoPick\.value, model \}\);\n\s+await app\.talkTo\(`staff:\$\{whoPick\.value\}`\);/);
  assert.match(home, /el\('div', \{ class: 'cluster-go' \}, pickedLine, el\('div', \{ class: 'cluster-go-row' \}/);
});
