// One llama.cpp build for a Max mode set (src/runnermatch.ts): the PCs of the owner's home network, as their hellos say
// them, and the cases around them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildsOf, pickBuild, type Member, type Option } from '../src/runnermatch.ts';

const opt = (build: string, device: Option['device'], pin: string, have = true, tested = false): Option => ({ build, device, pin, have, tested });

/** The main PC: a Quadro P2000, everything b11284 in the zip; CUDA 12.4 b11284 unpacked, b12250 could be sent. */
const main = (): Member => ({ name: 'Main PC', host: true, options: [opt('b11284', 'cuda', 'llama-cuda'), opt('b12250', 'cuda', 'llama-cuda3', false), opt('b10750', 'cuda', 'llama-cuda2', false), opt('b11284', 'vulkan', 'llama-vulkan'), opt('b11284', 'cpu', 'llama-cpu')] });
/** The Z820: an RTX 3060. b11284 CUDA crashed there, so b11284 is only left on Vulkan and the CPU; b12250 is unpacked and tested. */
const z820 = (): Member => ({ name: 'Z820', host: false, options: [opt('b12250', 'cuda', 'llama-cuda3', true, true), opt('b11284', 'vulkan', 'llama-vulkan'), opt('b11284', 'cpu', 'llama-cpu')], no: { b11284: 'its CUDA runner crashed on the RTX 3060' } });
/** The HP 800: a Quadro K1200, no CUDA build it can use; b11284 on Vulkan and the CPU. */
const hp = (): Member => ({ name: 'HP 800', host: false, options: [opt('b11284', 'vulkan', 'llama-vulkan'), opt('b11284', 'cpu', 'llama-cpu')], no: { b12250: 'it has no NVIDIA card with code for that build' } });

test('the three home PCs share b11284, which is unpacked on all of them: nothing to install, nothing to say', () => {
  const c = pickBuild([main(), z820(), hp()]);
  assert.equal(c.build, 'b11284');
  assert.deepEqual(c.lenders, ['Z820', 'HP 800']);
  assert.deepEqual(c.needs, []);
  assert.deepEqual(c.left, []);
  assert.equal(c.line, '');
});

test('b12250 would be tested on the Z820, but a build unpacked everywhere beats one that has to be installed', () => {
  const c = pickBuild([main(), z820()]);
  assert.equal(c.build, 'b11284');
  assert.deepEqual(c.needs, []);
});

test('when the common build is not unpacked on a PC, installing it there is listed (asked first, never done here)', () => {
  // This PC could run b12250 (CUDA code for its card) but has only b11284 unpacked, and b11284 is not safe on the Z820's CUDA.
  const newOnly: Member = { ...main(), options: [opt('b12250', 'cuda', 'llama-cuda3', false)] };
  const c = pickBuild([newOnly, z820()]);
  assert.equal(c.build, 'b12250');
  assert.deepEqual(c.needs.map(n => [n.name, n.host, n.pin, n.device, n.build]), [['Main PC', true, 'llama-cuda3', 'cuda', 'b12250']]);
  assert.match(c.line, /b12250 is not installed on "Main PC \(this PC\)" yet: installing it is asked first/);
});

test('a lender with no build in common is named as the PC that blocks, and the rest carry on', () => {
  const onlyNewest = (m: Member): Member => ({ ...m, options: m.options!.filter(o => o.build === 'b12250') });
  const lone = (): Member => ({ name: 'Old Laptop', host: false, options: [opt('b11284', 'cpu', 'llama-cpu')], no: { b12250: 'it has no NVIDIA card' } });
  const c = pickBuild([onlyNewest(main()), z820(), lone()]);
  assert.equal(c.build, 'b12250');
  assert.deepEqual(c.lenders, ['Z820']);
  assert.deepEqual(c.left.map(l => l.name), ['Old Laptop']);
  assert.match(c.line, /No single llama\.cpp build runs safely on all of them/);
  assert.match(c.line, /"Old Laptop" blocks it: it can only run b11284/);
  assert.match(c.line, /Left out: "Old Laptop"\. Using b12250 on the rest\./);
});

test('no lender fits the host: nothing is borrowed, each is named', () => {
  const host: Member = { name: 'Main PC', host: true, options: [opt('b11284', 'cuda', 'llama-cuda')] };
  const other: Member = { name: 'Z820', host: false, options: [opt('b12250', 'cuda', 'llama-cuda3')], no: { b11284: 'it crashed on the RTX 3060' } };
  const c = pickBuild([host, other]);
  assert.equal(c.build, null);
  assert.deepEqual(c.lenders, []);
  assert.deepEqual(c.left.map(l => l.name), ['Z820']);
  assert.match(c.line, /No single llama\.cpp build runs safely on this PC and "Z820"/);
  assert.match(c.line, /"Z820" blocks it: it can only run b12250 \(it crashed on the RTX 3060\)/);
});

test('the biggest group that shares a build is kept', () => {
  const only = (m: Member, b: string): Member => ({ ...m, options: m.options!.filter(o => o.build === b) });
  const a = { ...only(main(), 'b11284') };
  const c = pickBuild([a, { ...hp(), name: 'One' }, { ...only(z820(), 'b12250') }, { ...hp(), name: 'Two' }]);
  assert.equal(c.build, 'b11284');
  assert.deepEqual(c.lenders, ['One', 'Two']);
  assert.deepEqual(c.left.map(l => l.name), ['Z820']);
});

test('a lender on an older TOMLIN says nothing: it is not counted, and the line says to update it', () => {
  const old: Member = { name: 'Old TOMLIN', host: false, options: null };
  const c = pickBuild([main(), old]);
  assert.equal(c.build, 'b11284');
  assert.deepEqual(c.lenders, ['Old TOMLIN']);
  assert.deepEqual(c.unknown, ['Old TOMLIN']);
  assert.match(c.line, /"Old TOMLIN" did not say which llama\.cpp builds it runs \(an older TOMLIN\): update it/);
});

test('a lender with no safe runner at all is left out, not a reason to stop', () => {
  const c = pickBuild([main(), { name: 'Bare', host: false, options: [] }, hp()]);
  assert.equal(c.build, 'b11284');
  assert.deepEqual(c.lenders, ['HP 800']);
  assert.deepEqual(c.left.map(l => l.name), ['Bare']);
});

test('with no lender there is nothing to match and nothing to say', () => {
  const c = pickBuild([main()]);
  assert.equal(c.build, null);
  assert.equal(c.line, '');
});

test('a host with no safe runner borrows nothing', () => {
  const c = pickBuild([{ name: 'Main PC', host: true, options: [] }, hp()]);
  assert.equal(c.build, null);
  assert.match(c.line, /has no llama\.cpp runner it can use safely/);
});

test('among builds that need the same installs, the better tested and better placed one wins, then the newer', () => {
  const x: Member = { name: 'Main PC', host: true, options: [opt('b11284', 'cuda', 'a', true, false), opt('b12250', 'cuda', 'b', true, true)] };
  const y: Member = { name: 'Z820', host: false, options: [opt('b12250', 'cuda', 'b', true, true), opt('b11284', 'cuda', 'a', true, false)] };
  assert.equal(pickBuild([x, y]).build, 'b12250');
  const p: Member = { name: 'Main PC', host: true, options: [opt('b11284', 'cuda', 'a'), opt('b12250', 'cuda', 'b')] };
  const q: Member = { name: 'Z820', host: false, options: [opt('b12250', 'cuda', 'b'), opt('b11284', 'cuda', 'a')] };
  assert.equal(pickBuild([p, q]).build, 'b12250', 'tied on places: the newer');
});

test('buildsOf lists each build once, in the PC\'s own order', () => {
  assert.deepEqual(buildsOf(z820().options!), ['b12250', 'b11284']);
});
