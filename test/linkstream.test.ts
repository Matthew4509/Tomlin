import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { FRAME, newNonce, Opener, Sealer, sealedPipe, streamKeys } from '../src/linkstream.ts';

const linkKeys = randomBytes(64);

test('both sides make the same stream keys, one each way, and other nonces make other keys', () => {
  const h = newNonce();
  const n = newNonce();
  const host = streamKeys(linkKeys, h, n, 'host');
  const node = streamKeys(linkKeys, h, n, 'node');
  assert.deepEqual(host.send, node.read);
  assert.deepEqual(host.read, node.send);
  assert.notDeepEqual(host.send, host.read);
  assert.notDeepEqual(streamKeys(linkKeys, newNonce(), n, 'host').send, host.send);
  assert.throws(() => streamKeys(linkKeys, Buffer.alloc(8), n, 'host'), /16 bytes/);
});

test('frames open in order, big writes are cut into frames, and nothing is readable on the wire', () => {
  const key = randomBytes(32);
  const s = new Sealer(key, 'max|host');
  const o = new Opener(key, 'max|host');
  const big = Buffer.alloc(FRAME * 2 + 10, 'secret weights ');
  const wire = Buffer.concat([...s.frames(Buffer.from('hello')), ...s.frames(Buffer.alloc(0)), ...s.frames(big)]);
  assert.ok(!wire.toString('latin1').includes('secret'));
  // Bytes arrive in odd pieces: frames still come out whole and in order.
  const got: Buffer[] = [];
  for (let i = 0; i < wire.length; i += 7777) got.push(...o.push(wire.subarray(i, i + 7777)));
  assert.equal(got.length, 5, 'hello, a heartbeat, and three frames for the big write');
  assert.equal(got[0].toString(), 'hello');
  assert.equal(got[1].length, 0);
  assert.deepEqual(Buffer.concat(got.slice(2)), big);
});

test('a changed, dropped, replayed or wrongly-keyed frame ends the stream', () => {
  const key = randomBytes(32);
  const frames = () => {
    const s = new Sealer(key, 'max|host');
    return [Buffer.concat(s.frames(Buffer.from('one'))), Buffer.concat(s.frames(Buffer.from('two')))];
  };
  const [a, b] = frames();
  const changed = Buffer.from(a);
  changed[10] ^= 1;
  assert.throws(() => new Opener(key, 'max|host').push(changed), /could not be opened/);
  assert.throws(() => new Opener(key, 'max|host').push(b), /could not be opened/, 'the first frame dropped');
  const o = new Opener(key, 'max|host');
  o.push(a);
  assert.throws(() => o.push(a), /could not be opened/, 'the same frame again');
  assert.throws(() => new Opener(key, 'max|node').push(a), /could not be opened/, 'the other direction');
  assert.throws(() => new Opener(randomBytes(32), 'max|host').push(a), /could not be opened/);
  assert.throws(() => new Opener(key, 'max|host').push(Buffer.from([0xff, 0xff, 0xff, 0xff, 1])), /not one TOMLIN sends/);
});

/** A connected pair of TCP sockets on this PC. */
async function pair(): Promise<[Socket, Socket]> {
  let far!: Socket;
  const srv = createServer(s => (far = s)).listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const near = connect((srv.address() as { port: number }).port, '127.0.0.1');
  await new Promise(r => near.once('connect', r));
  while (!far) await new Promise(r => setTimeout(r, 10));
  srv.close();
  return [near, far];
}

/**
 * A local echo server standing in for rpc-server, two sealed pipes, and a "network" between them that can be cut
 * without closing (as when a PC drops off the network: nothing more arrives, and nothing says so).
 */
async function rig(o: { silentMs?: number; beatMs?: number } = {}) {
  const echo = createServer(s => s.pipe(s)).listen(0, '127.0.0.1');
  await new Promise(r => echo.once('listening', r));
  const h = newNonce();
  const n = newNonce();
  const [hostWire, relayIn] = await pair();
  const [relayOut, nodeWire] = await pair();
  let cut = false;
  relayIn.on('data', c => void (!cut && relayOut.write(c)));
  relayOut.on('data', c => void (!cut && relayIn.write(c)));
  relayIn.on('close', () => !cut && relayOut.destroy());
  relayOut.on('close', () => !cut && relayIn.destroy());
  const rpc = connect((echo.address() as { port: number }).port, '127.0.0.1');
  await new Promise(r => rpc.once('connect', r));
  // The runner's side on the host.
  const [runner, runnerEnd] = await pair();
  const hostEnded = sealedPipe(runnerEnd, hostWire, streamKeys(linkKeys, h, n, 'host'), 'host', o);
  const nodeEnded = sealedPipe(rpc, nodeWire, streamKeys(linkKeys, h, n, 'node'), 'node', o);
  const close = () => {
    echo.close();
    relayIn.destroy();
    relayOut.destroy();
  };
  return { runner, hostWire, nodeWire, hostEnded, nodeEnded, close, cut: () => void (cut = true) };
}

test('bytes go through the sealed pipes and back, a big write included', async () => {
  const r = await rig();
  const sent = randomBytes(3 * FRAME + 123);
  const back: Buffer[] = [];
  r.runner.on('data', c => back.push(c));
  r.runner.write(sent);
  for (let t = 0; Buffer.concat(back).length < sent.length && t < 200; t++) await new Promise(res => setTimeout(res, 20));
  assert.deepEqual(Buffer.concat(back), sent);
  r.runner.destroy();
  assert.equal(await r.hostEnded, '');
  assert.equal(await r.nodeEnded, '', 'one side closing closes the other');
  r.close();
});

test('a changed byte on the network ends both sides', async () => {
  const r = await rig();
  // Something in the middle writes junk at the node, as if a frame had been changed.
  r.hostWire.write(Buffer.concat([Buffer.from([0, 0, 0, 40]), randomBytes(40)]));
  assert.match(await r.nodeEnded, /could not be opened/);
  await r.hostEnded;
  r.close();
});

test('a PC that goes quiet is dropped after the silent time', async () => {
  const r = await rig({ beatMs: 50, silentMs: 300 });
  r.cut();
  assert.match(await r.hostEnded, /went quiet/);
  assert.match(await r.nodeEnded, /went quiet/);
  r.close();
});
