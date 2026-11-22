// A linked PC that moved (the router gave it another address) is found again on the home network: the TOMLIN PCs found
// are put in order, most likely first, and only the one that answers over this PC's own sealed link is taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import * as link from '../src/link.ts';
import { answersAt } from '../src/jobrun/links.ts';
import { foundWords, ipForMac, MAX_TRIES, notFoundWords, rankFound } from '../src/findagain.ts';

const ARP = `
Interface: 192.168.1.226 --- 0x5
  Internet Address      Physical Address      Type
  192.168.1.1           02-aa-bb-cc-dd-02     dynamic
  192.168.1.176         02-aa-bb-cc-dd-01     dynamic
  192.168.1.199         02-11-22-33-44-55     dynamic
  192.168.1.255         ff-ff-ff-ff-ff-ff     static
`;

test('the ARP table gives the address its network card is at now, in any MAC form', () => {
  assert.equal(ipForMac(ARP, '02:11:22:33:44:55'), '192.168.1.199');
  assert.equal(ipForMac(ARP, '02-11-22-33-44-55'), '192.168.1.199');
  assert.equal(ipForMac(ARP, 'aa:bb:cc:dd:ee:ff'), null);
  assert.equal(ipForMac(ARP, undefined), null);
  assert.equal(ipForMac(ARP, 'ff:ff:ff:ff:ff:ff'), null);
});

test('its network card first, then its name, then the same port and the nearest address; its old address never', () => {
  const was = { url: 'http://192.168.1.200:8741', name: 'Worker PC', computer: 'DESKTOP-WORKER1', mac: '02:11:22:33:44:55' };
  const found = [
    { url: 'http://192.168.1.200:8741', name: 'Worker PC' },
    { url: 'http://192.168.1.176:8741', name: 'Office PC' },
    { url: 'http://192.168.1.201:8741', name: 'Spare' },
    { url: 'http://192.168.1.40:8741', name: 'worker pc' },
    { url: 'http://192.168.1.199:8741', name: 'Renamed there' },
  ];
  // The card is at .199: first, though it gives another name now.
  assert.deepEqual(rankFound(was, found, '192.168.1.199'), ['http://192.168.1.199:8741', 'http://192.168.1.40:8741', 'http://192.168.1.201:8741', 'http://192.168.1.176:8741']);
  // No card known: the same name first (in any case), then the nearest.
  assert.deepEqual(rankFound(was, found, null), ['http://192.168.1.40:8741', 'http://192.168.1.199:8741', 'http://192.168.1.201:8741', 'http://192.168.1.176:8741']);
  // The computer's own name counts as its name.
  assert.equal(rankFound(was, [{ url: 'http://192.168.1.9:8741', name: 'Other' }, { url: 'http://192.168.1.90:8741', name: 'desktop-worker1' }], null)[0], 'http://192.168.1.90:8741');
  // The same port before another.
  assert.deepEqual(rankFound(was, [{ url: 'http://192.168.1.201:9000', name: 'x' }, { url: 'http://192.168.1.150:8741', name: 'y' }], null), ['http://192.168.1.150:8741', 'http://192.168.1.201:9000']);
});

test('a crowded network is asked at most MAX_TRIES times, each address once', () => {
  const found = Array.from({ length: 40 }, (_, i) => ({ url: `http://192.168.1.${i + 2}:8741`, name: 'x' }));
  const order = rankFound({ url: 'http://192.168.1.200:8741', name: 'Worker PC' }, [...found, ...found], null);
  assert.equal(order.length, MAX_TRIES);
  assert.equal(new Set(order).size, MAX_TRIES);
});

test('the words name both addresses when found, and what to check when not', () => {
  const yes = foundWords('Worker PC', 'http://192.168.1.200:8741', 'http://192.168.1.199:8741');
  assert.match(yes, /192.168.1.199:8741/);
  assert.match(yes, /192.168.1.200:8741/);
  assert.doesNotMatch(yes, /http:/);
  assert.match(notFoundWords('Worker PC', 0), /^No TOMLIN PC answered/);
  assert.match(notFoundWords('Worker PC', 1), /^1 TOMLIN PC answered .* none of them is "Worker PC"/);
  assert.match(notFoundWords('Worker PC', 3), /^3 TOMLIN PCs answered/);
});

/** A PC on 127.0.0.1 that holds `keys` for its link and answers a sealed hello, or refuses what it cannot open. */
async function node(keys: Buffer, plain = false): Promise<{ server: Server; url: string }> {
  const seen = new link.Seen();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (plain) return res.end(JSON.stringify({ name: 'Plain PC' }));
      const got = link.openRequest(keys, JSON.parse(raw || '{}'), req.url ?? '', seen);
      if ('error' in got) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: got.error }));
      }
      res.end(JSON.stringify({ box: link.sealAnswer(keys, got.id, 0, { name: 'Worker PC', version: '2.1.1' }) }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test('only the PC that holds the link answers over it: another TOMLIN, or one answering unsealed, is not taken', { timeout: 30_000 }, async () => {
  const keys = randomBytes(64);
  const r = { id: 'moved1', name: 'Worker PC', url: 'http://127.0.0.1:1', token: randomBytes(32).toString('hex'), key: link.keysText(keys) };
  const same = await node(keys);
  const other = await node(randomBytes(64));
  const plain = await node(keys, true);
  try {
    assert.equal(await answersAt(r, same.url), true);
    assert.equal(await answersAt(r, other.url), false);
    assert.equal(await answersAt(r, plain.url), false);
    // Nothing listening there at all.
    assert.equal(await answersAt(r, 'http://127.0.0.1:1', 2000), false);
  } finally {
    for (const n of [same, other, plain]) n.server.close();
  }
});
