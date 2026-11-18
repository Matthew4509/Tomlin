import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileStem, hireModel, hireModelShort, type HireModelFacts } from '../src/hiremodel.ts';

const PC = '0a1b2c3d';
const facts = (more: Partial<HireModelFacts> = {}): HireModelFacts => ({
  here: [{ id: 'Fakemodel-7B-Q4_K_M.gguf', name: 'Fakemodel-7B' }],
  pcs: [{ id: PC, name: 'Workbench', models: [{ id: 'Bigmodel-30B-Q4_K_M.gguf', name: 'Bigmodel-30B' }], loaded: 'Bigmodel-30B' }],
  connected: null,
  ...more,
});

test('a model on this PC is named, and needs nothing picked', () => {
  const h = hireModel('Fakemodel-7B-Q4_K_M.gguf', facts());
  assert.deepEqual(h, { state: 'here', name: 'Fakemodel-7B', pc: 'this PC', text: 'Fakemodel-7B', pick: false });
});

test('a model no longer on this PC (one from another drive too) is missing, by its file name, with Pick a model', () => {
  const h = hireModel('*/Gonemodel-35B-UD-Q2_K_XL.gguf', facts());
  assert.equal(h.state, 'missing');
  assert.equal(h.pick, true);
  assert.equal(h.text, 'Gonemodel-35B-UD-Q2_K_XL, no longer on this PC');
  assert.equal(hireModelShort(h), 'its model is no longer here');
});

test('no model given: the model loaded here answers; with none loaded it says so plainly and asks for one', () => {
  const on = hireModel(null, facts({ connected: 'Fakemodel-7B' }));
  assert.equal(on.state, 'connected');
  assert.equal(on.pick, false);
  assert.match(on.text, /loaded here \(Fakemodel-7B\)/);
  const off = hireModel('', facts());
  assert.equal(off.state, 'none');
  assert.equal(off.pick, true);
  assert.equal(off.text, 'no model given, and none is loaded here');
  assert.equal(hireModelShort(off), 'no model given');
  assert.equal(hireModel(null, facts({ picture: true })).text, 'no picture model given, and none is loaded here');
});

test('a linked PC\'s model: named while that PC lends it; missing once it no longer does', () => {
  const lent = hireModel(`remote:${PC}:Bigmodel-30B-Q4_K_M.gguf`, facts());
  assert.deepEqual(lent, { state: 'pc', name: 'Bigmodel-30B', pc: 'Workbench', text: 'Bigmodel-30B on "Workbench"', pick: false });
  // The case where All staff said "a model no longer here" while New chat named it: both now say the same.
  const gone = hireModel(`remote:${PC}:Othermodel-35B-Q4_K_S.gguf`, facts());
  assert.equal(gone.state, 'missing');
  assert.equal(gone.text, 'Othermodel-35B-Q4_K_S, no longer lent by "Workbench"');
  // Not known yet what it lends (never answered): named from its file, not called missing.
  const unknown = hireModel(`remote:${PC}:Othermodel-35B-Q4_K_S.gguf`, facts({ pcs: [{ id: PC, name: 'Workbench', models: null }] }));
  assert.equal(unknown.state, 'pc');
  assert.equal(unknown.name, 'Othermodel-35B-Q4_K_S');
});

test('a PC no longer linked, or set to Backups only, leaves the hire with nothing to answer on', () => {
  assert.equal(hireModel('remote:ffffffff:x.gguf', facts()).state, 'missing');
  assert.match(hireModel('remote:ffffffff:x.gguf', facts()).text, /no longer linked/);
  const backups = hireModel(`remote:${PC}:Bigmodel-30B-Q4_K_M.gguf`, facts({ pcs: [{ id: PC, name: 'Workbench', models: [], backupsOnly: true }] }));
  assert.equal(backups.pick, true);
  assert.match(backups.text, /Backups only/);
});

test('whatever a linked PC has loaded (an older ref) is named by what it said it has loaded', () => {
  assert.equal(hireModel(`remote:${PC}`, facts()).text, 'Bigmodel-30B on "Workbench"');
  assert.equal(hireModel(`remote:${PC}`, facts({ pcs: [{ id: PC, name: 'Workbench', models: null, loaded: null }] })).text, 'what "Workbench" has loaded');
});

test('a file stem drops the folder, the other-drive mark and .gguf', () => {
  assert.equal(fileStem('*/Some-Model-Q4.gguf'), 'Some-Model-Q4');
  assert.equal(fileStem('sub\\folder/Other.GGUF'), 'Other');
});
