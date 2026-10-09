import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askPending, askText, askUntil, cleanAskHours, cleanWorkerUrl, DEFAULT_SHARE, hashToken, isPrivateAddress, newPin, newToken, pairedBy, PinGuard, readStream } from '../src/share.ts';

test('only this PC and the home network count as private', () => {
  for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.1.1', '::1', '::ffff:192.168.0.5', 'fd12:3456::1', 'fe80::1']) assert.equal(isPrivateAddress(ok), true, ok);
  for (const bad of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '2001:4860::8888', '', undefined, 'localhost']) assert.equal(isPrivateAddress(bad), false, String(bad));
});

test('a worker address is cleaned to http://host:port and must be on the home network when it is a number', () => {
  assert.equal(cleanWorkerUrl('192.168.1.20'), 'http://192.168.1.20:8741');
  assert.equal(cleanWorkerUrl('192.168.1.20:9000'), 'http://192.168.1.20:9000');
  assert.equal(cleanWorkerUrl('http://desk.local:8741/'), 'http://desk.local:8741');
  for (const bad of ['8.8.8.8', 'https://192.168.1.2', 'http://u:p@192.168.1.2', '192.168.1.2/x', 'file:///c:/', 'a b', '']) assert.equal(cleanWorkerUrl(bad), null, bad);
});

test('PINs and tokens: six digits; a token is found only by its hash', () => {
  assert.match(newPin(), /^\d{6}$/);
  const token = newToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  const state = { ...DEFAULT_SHARE, paired: [{ name: 'Laptop', hash: hashToken(token), at: '' }] };
  assert.equal(pairedBy(state, token)?.name, 'Laptop');
  assert.equal(pairedBy(state, newToken()), null);
  assert.equal(pairedBy(state, hashToken(token)), null);
  assert.equal(pairedBy(state, undefined), null);
});

test('five wrong PINs lock an address for ten minutes; a right one clears it', () => {
  let t = 0;
  const g = new PinGuard(() => t);
  for (let i = 0; i < 4; i++) g.wrong('a');
  assert.equal(g.lockedFor('a'), 0);
  g.wrong('a');
  assert.equal(g.lockedFor('a'), 10);
  assert.equal(g.lockedFor('b'), 0);
  t = 9 * 60_000;
  assert.equal(g.lockedFor('a'), 1);
  t = 10 * 60_000 + 1;
  assert.equal(g.lockedFor('a'), 0);
  g.wrong('c');
  g.right('c');
  assert.equal(g.lockedFor('c'), 0);
});

test('a worker stream gives its text, and its faults as errors', async () => {
  const stream = (s: string) => new Response(new Blob([s]).stream());
  const seen: string[] = [];
  assert.equal(await readStream(stream('event: text\ndata: {"text":"he"}\n\nevent: text\ndata: {"text":"hello"}\n\nevent: done\ndata: {}\n\n'), t => seen.push(t)), 'hello');
  assert.deepEqual(seen, ['he', 'hello']);
  await assert.rejects(readStream(stream('event: error\ndata: {"text":"no model"}\n\n'), () => undefined), /worker said: no model/);
  await assert.rejects(readStream(stream('event: text\ndata: {"text":"x"}\n\n'), () => undefined), /stopped before/);
});

test('linking needs the setup code; the PIN only when that PC asks for one', async () => {
  const { newCode, cleanCode, pairAllowed, scanTargets } = await import('../src/share.ts');
  const code = newCode();
  assert.match(code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(cleanCode(' abcd efgh '), 'ABCDEFGH');
  const st = { code, pinOn: false, pin: '123456' };
  assert.equal(pairAllowed(st, code.toLowerCase().replace('-', ' '), ''), true);
  assert.equal(pairAllowed(st, 'WRONG-CODE', ''), false);
  assert.equal(pairAllowed({ ...st, code: '' }, '', ''), false);
  assert.equal(pairAllowed({ ...st, pinOn: true }, code, '000000'), false);
  assert.equal(pairAllowed({ ...st, pinOn: true }, code, '123456'), true);
  const t = scanTargets(['192.168.1.37', '8.8.8.8']);
  assert.equal(t.length, 254);
  assert.equal(t[0], '192.168.1.1');
  assert.ok(!t.some(x => x.startsWith('8.')));
});

test('a worker that goes quiet mid-answer is given up on, with what it had said kept out of the error', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({ start(c) { c.enqueue(enc.encode('event: text\ndata: {"text":"Once upon"}\n\n')); } });
  const seen: string[] = [];
  const t0 = Date.now();
  await assert.rejects(readStream(new Response(body), t => seen.push(t), undefined, 150), /went quiet/);
  assert.deepEqual(seen, ['Once upon']);
  assert.ok(Date.now() - t0 < 2000);
});

test('a heartbeat line keeps a slow worker alive', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 60)); c.enqueue(enc.encode(': still working\n\n')); }
      c.enqueue(enc.encode('event: text\ndata: {"text":"done"}\n\nevent: done\ndata: {}\n\n'));
      c.close();
    },
  });
  assert.equal(await readStream(new Response(body), () => undefined, undefined, 150), 'done');
});

test('a link is named by its token fingerprint: the hash finds it, the token itself does not', async () => {
  const { pairedByHash } = await import('../src/share.ts');
  const token = newToken();
  const state = { ...DEFAULT_SHARE, paired: [{ name: 'Office', hash: hashToken(token), at: '' }] };
  assert.equal(pairedByHash(state, hashToken(token))?.name, 'Office');
  assert.equal(pairedByHash(state, token), null);
  assert.equal(pairedByHash(state, 'x'), null);
});

test('Send host: the request word for word, 1, 2 or 4 hours, waiting until the main PC answers', () => {
  assert.equal(askText(1), 'I need to use the pc, please log out for 1 hour');
  assert.equal(askText(4), 'I need to use the pc, please log out for 4 hours');
  assert.deepEqual([1, 2, 4, '2', 3, 0, -1, 'x', null].map(cleanAskHours), [1, 2, 4, 2, null, null, null, null, null]);
  const at = '2026-10-08T10:00:00.000Z';
  assert.deepEqual(askPending({ hours: 2, at }), { hours: 2, at });
  assert.equal(askPending({ hours: 2, at, answer: 'no' }), null);
  assert.equal(askPending({ hours: 2, at, answer: 'yes' }), null);
  assert.equal(askPending(null), null);
  assert.equal(askUntil(2, Date.parse(at)), '2026-10-08T12:00:00.000Z');
});
