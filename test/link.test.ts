import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostAsk, hostFinish, keysOf, keysText, LINK_WINDOW_MS, nodeAnswer, open, openAnswer, openRequest, openStream, pairKey, seal, sealAnswer, sealedEvent, sealRequest, Seen, toHost, toNode } from '../src/link.ts';
import { newToken } from '../src/share.ts';

const me = { id: 'a1b2c3d4', name: 'Laptop' };

async function linked() {
  const key = await pairKey('ABCD-EFGH', '');
  const { ask, priv } = hostAsk(key, '0f0f0f0f', 'Office PC', false);
  const token = newToken();
  const got = nodeAnswer(await pairKey('abcd efgh', ''), JSON.parse(JSON.stringify(ask)), me, token)!;
  const host = hostFinish(key, ask, priv, JSON.parse(JSON.stringify(got.answer)));
  return { ask, answer: got.answer, nodeKeys: got.keys, host, token };
}

test('linking: both PCs end with the same keys and the token, and the code never crosses the network', async () => {
  const { ask, answer, nodeKeys, host, token } = await linked();
  assert.equal(host.token, token);
  assert.deepEqual(host.keys, nodeKeys);
  assert.equal(host.id, me.id);
  const wire = JSON.stringify([ask, answer]);
  for (const secret of ['ABCD-EFGH', 'ABCDEFGH', 'abcd efgh', token]) assert.ok(!wire.includes(secret), secret);
  assert.equal(keysOf(keysText(host.keys))!.equals(host.keys), true);
  assert.equal(keysOf('short'), null);
});

test('a wrong setup code, or a missing PIN, fails at the node', async () => {
  const { ask } = hostAsk(await pairKey('ABCD-EFGH', ''), '0f0f0f0f', 'Office PC', false);
  assert.equal(nodeAnswer(await pairKey('ABCD-EFGJ', ''), ask as never, me, newToken()), null);
  assert.equal(nodeAnswer(await pairKey('ABCD-EFGH', '123456'), ask as never, me, newToken()), null);
  // The PIN, when typed on both sides, is part of the key.
  const withPin = hostAsk(await pairKey('ABCD-EFGH', '123456'), '0f0f0f0f', 'Office PC', true);
  assert.ok(nodeAnswer(await pairKey('ABCD-EFGH', '123456'), withPin.ask as never, me, newToken()));
});

test('a device in the middle cannot swap keys: a changed key or name in either message is refused', async () => {
  const key = await pairKey('ABCD-EFGH', '');
  const { ask, priv } = hostAsk(key, '0f0f0f0f', 'Office PC', false);
  const evil = hostAsk(await pairKey('ZZZZ-ZZZZ', ''), '0f0f0f0f', 'Office PC', false);
  assert.equal(nodeAnswer(key, { ...ask, pub: evil.ask.pub } as never, me, newToken()), null);
  assert.equal(nodeAnswer(key, { ...ask, name: 'Someone else' } as never, me, newToken()), null);
  const got = nodeAnswer(key, ask as never, me, newToken())!;
  const other = nodeAnswer(key, ask as never, me, newToken())!;
  assert.throws(() => hostFinish(key, ask, priv, { ...got.answer, pub: other.answer.pub }), /in the middle/);
  assert.throws(() => hostFinish(key, ask, priv, { ...got.answer, name: 'Fake laptop' }), /in the middle/);
});

test('sealed text cannot be read, and one changed byte is refused', () => {
  const key = Buffer.alloc(32, 7);
  const box = seal(key, Buffer.from('a private picture prompt'), 'x');
  assert.ok(!Buffer.from(box, 'base64url').toString('latin1').includes('private'));
  assert.equal(open(key, box, 'x')!.toString(), 'a private picture prompt');
  const raw = Buffer.from(box, 'base64url');
  raw[20] ^= 1;
  assert.equal(open(key, raw.toString('base64url'), 'x'), null);
  assert.equal(open(key, box, 'y'), null, 'meant for somewhere else');
  assert.equal(open(Buffer.alloc(32, 8), box, 'x'), null, 'another key');
});

test('a request opens only at its own door, in time, once', async () => {
  const { host, nodeKeys } = await linked();
  const now = Date.now();
  const req = sealRequest(host.keys, '/worker/run', { user: 'write the plan' }, now);
  assert.ok(!JSON.stringify(req).includes('write the plan'));
  const seen = new Seen();
  assert.equal('error' in openRequest(nodeKeys, req, '/worker/draw', seen, now), true, 'wrong door');
  const ok = openRequest(nodeKeys, req, '/worker/run', seen, now);
  assert.ok('body' in ok && ok.body.user === 'write the plan');
  const again = openRequest(nodeKeys, req, '/worker/run', seen, now);
  assert.ok('error' in again && /already taken/.test(again.error));
  const old = sealRequest(host.keys, '/worker/run', {}, now - LINK_WINDOW_MS - 1000);
  const late = openRequest(nodeKeys, old, '/worker/run', new Seen(), now);
  assert.ok('error' in late && /clocks/.test(late.error));
  // Sealed the other way (node to host) does not open as a request.
  assert.ok('error' in openRequest(nodeKeys, { box: seal(toHost(nodeKeys), Buffer.from('{}'), 'request') }, '/worker/run', new Seen(), now));
  assert.notDeepEqual(toNode(nodeKeys), toHost(nodeKeys));
});

test('answers are tied to their request and their place in a stream', async () => {
  const { host, nodeKeys } = await linked();
  const a = sealAnswer(nodeKeys, 'req1', 0, { model: 'Qwen' });
  assert.deepEqual(openAnswer(host.keys, 'req1', 0, a), { model: 'Qwen' });
  assert.throws(() => openAnswer(host.keys, 'req2', 0, a), /refused/);
  assert.throws(() => openAnswer(host.keys, 'req1', 1, a), /refused/);
});

test('a sealed stream reads back as plain events in order; a swapped or changed event ends it', async () => {
  const { host, nodeKeys } = await linked();
  const read = async (parts: string[]) => {
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } });
    return new Response(openStream(host.keys, 'r', body)).text();
  };
  const e1 = sealedEvent(nodeKeys, 'r', 1, 'text', { text: 'hello' });
  const e2 = sealedEvent(nodeKeys, 'r', 2, 'done', {});
  assert.ok(!e1.includes('hello'));
  assert.equal(await read([e1.slice(0, 10), e1.slice(10), ': still working\n\n', e2]), `event: text\ndata: {"text":"hello"}\n\n: still working\n\nevent: done\ndata: {}\n\n`);
  const swapped = await read([e2, e1]);
  assert.match(swapped, /^event: error/);
  assert.ok(!swapped.includes('done'));
});
