import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get, Agent } from 'node:http';
import { keepSocketsOpen } from '../src/sockettimeouts.ts';

test('the server keeps an idle connection open longer than a client reuses it', () => {
  const s = createServer();
  keepSocketsOpen(s);
  assert.ok(s.keepAliveTimeout >= 60_000);
  assert.ok(s.headersTimeout > s.keepAliveTimeout);
  s.close();
});

test('a connection left idle for 6 s (past the old 5 s default) is still reused, not reset', async () => {
  const s = createServer((_q, r) => r.end('ok'));
  keepSocketsOpen(s);
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const once = () => new Promise<string>((res, rej) => get({ port, host: '127.0.0.1', agent }, m => { let b = ''; m.on('data', c => (b += c)); m.on('end', () => res(b)); }).on('error', rej));
  assert.equal(await once(), 'ok');
  await new Promise(r => setTimeout(r, 5500));
  assert.equal(await once(), 'ok');
  agent.destroy();
  s.close();
});
