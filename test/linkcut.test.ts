// A linked PC's answer cut part way (the network dropped, the PC went to sleep mid-answer) is said as a cut answer, not
// as a PC that "answered without the encrypted link" (which sent people to link it again for nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import * as link from '../src/link.ts';
import { hello } from '../src/jobrun/links.ts';

test('an answer cut part way is said as cut, and one with no seal at all still asks to link again', { timeout: 60_000 }, async () => {
  let mode: 'cut' | 'plain' = 'cut';
  const server = createServer(sock => {
    sock.once('data', () => {
      if (mode === 'cut') {
        // Whole headers, then half an answer, then the connection ends.
        sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 400\r\n\r\n{"box":"AAAA');
        setTimeout(() => sock.destroy(), 50);
      } else {
        const body = '{"ok":true}';
        sock.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = { id: 'cut1', name: 'Cut PC', url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: randomBytes(32).toString('hex'), key: link.keysText(randomBytes(64)) };
    await assert.rejects(hello(r, 10_000), (e: Error) => {
      assert.match(e.message, /part way/);
      assert.doesNotMatch(e.message, /encrypted link|link it again/i);
      return true;
    });
    mode = 'plain';
    await assert.rejects(hello(r, 10_000), /answered without the encrypted link/);
  } finally {
    server.close();
  }
});
