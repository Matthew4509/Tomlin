// A hosting connection's server name (src/bridge/hosting/connections.js): this PC or the home network is refused,
// whether typed as an address (every private range, not only 10. and 192.168.) or as a name that points there, so a
// password or key is never sent to a home device by a typing slip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { cleanHost, homeHostWhy } = createRequire(import.meta.url)('../src/bridge/hosting/connections.js') as {
  cleanHost: (t: string) => { host?: string; port?: number | null; error?: string };
  homeHostWhy: (h: string) => Promise<string>;
};

test('a private address of any range, or a .local name, is not a web host; a real host name is', () => {
  for (const t of ['172.20.1.5', '100.64.0.1', '0.0.0.0', '127.0.0.1', '10.1.2.3', '192.168.0.77', '169.254.9.9', 'printer.local', 'my.localhost'])
    assert.match(cleanHost(t).error ?? '', /is this PC or your home network, not a web host/, t);
  assert.deepEqual(cleanHost('https://server123.yourhost.com:2083/cpsess1/x'), { host: 'server123.yourhost.com', port: 2083 });
  assert.deepEqual(cleanHost('172.32.0.1'), { host: '172.32.0.1', port: null }, 'outside 172.16-31 is a public address');
});

test('a name that points at this PC is refused before anything is sent to it', async () => {
  assert.match(await homeHostWhy('localhost'), /^localhost points at this PC or your home network \((127\.0\.0\.1|::1)\), not a web host\.$/);
  assert.equal(await homeHostWhy('no-such-host.invalid'), '', 'not found: left to the connection to say');
});
