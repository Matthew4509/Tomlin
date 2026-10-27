// The link helper (2.0.64): what stops a main PC linking a node, in plain words, from both sides. The case it was
// built for (all values here made up): a node whose Check said "reachable" (it read only its own firewall) while
// nothing reached it, because its address had been typed in by hand as 192.168.1.1 on a 192.168.0.x network; on the
// main PC the address typed was 192.178.0.1 (a typo, and the router's .1), and the link PIN box got the app lock PIN.
// Pure rules only (src/linkhelp.ts); the Windows readers are in src/netfacts.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addressAdvice, adapterKind, countV6Only, diagnoseLink, nodeChecklist, parseAdapters, pinAdvice, probeOf, type Adapter, type LinkFacts, type NodeFacts } from '../src/linkhelp.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// The main PC that afternoon, and the node as it really was.
const MAIN = [{ alias: 'Ethernet', address: '192.168.0.30', prefix: 24, gateway: '192.168.0.1' }];
const SPARE: Adapter = { alias: 'Ethernet', description: 'Realtek PCIe GbE Family Controller', address: '192.168.1.1', prefix: 24, dhcp: false, gateway: null, gatewayAnswers: null };
const FW_OK = { ok: true, problems: [], networks: [{ alias: 'Ethernet', category: 'Private' }] };
const node = (over: Partial<NodeFacts> = {}): NodeFacts => ({ on: true, listening: true, port: 8741, adapters: [SPARE], firewall: FW_OK, others: [], ...over });
const facts = (over: Partial<LinkFacts> = {}): LinkFacts => ({ own: MAIN, nodeOn: true, address: '', name: '', port: 8741, ping: null, probe: null, whoami: null, named: null, v6Only: 0, ...over });

test('SPARE-PC, node side: an address typed in by hand with no router is named, with the way to Automatic, even though the firewall is fine', () => {
  const r = nodeChecklist(node());
  assert.equal(r.ok, false);
  const bad = r.lines.find(l => l.state === 'bad')!;
  assert.match(bad.text, /192\.168\.1\.1, was typed in by hand/);
  assert.match(bad.text, /\.1 is the address a router usually has/);
  assert.match(bad.text, /no router answers/);
  assert.ok(bad.steps!.some(s => /IP assignment, press Edit and pick Automatic \(DHCP\)/.test(s)), 'the fix, step by step');
  assert.ok(bad.steps!.some(s => /Settings, Network & internet, Ethernet/.test(s)));
  // The firewall passing is still said (it is true), but it no longer reads as "reachable".
  assert.ok(r.lines.some(l => l.state === 'ok' && /Windows Firewall lets other PCs in on port 8741/.test(l.text)));
  assert.equal(r.typeThis, null, 'no address to type on the main PC until it has a working one');
  // Always: these are this PC's own settings; the real test is from the main PC.
  assert.match(r.lines.at(-1)!.text, /this PC's own settings.*tested from your main PC/i);
});

test('node side: a healthy node says which address to type, from its home connection, and sets the virtual ones aside', () => {
  const r = nodeChecklist(node({ adapters: [
    { alias: 'Ethernet', description: 'Intel(R) Ethernet Connection', address: '192.168.0.50', prefix: 24, dhcp: true, gateway: '192.168.0.1', gatewayAnswers: true },
    { alias: 'VMware Network Adapter VMnet8', description: 'VMware Virtual Ethernet Adapter for VMnet8', address: '192.168.56.1', prefix: 24, dhcp: false, gateway: null, gatewayAnswers: null },
  ] }));
  assert.equal(r.ok, true);
  assert.equal(r.typeThis, '192.168.0.50:8741');
  assert.ok(r.lines.some(l => l.state === 'ok' && /Connected by Ethernet: 192\.168\.0\.50, router 192\.168\.0\.1 answers/.test(l.text)));
  assert.ok(r.lines.some(l => l.state === 'info' && /Ignore VMware Network Adapter VMnet8 \(192\.168\.56\.1\)/.test(l.text)));
  // An address typed in by hand that matches its router is fine, and said so.
  const fixed = nodeChecklist(node({ adapters: [{ alias: 'Ethernet', address: '192.168.0.50', prefix: 24, dhcp: false, gateway: '192.168.0.1', gatewayAnswers: true }] }));
  assert.equal(fixed.ok, true);
  assert.match(fixed.lines.find(l => l.state === 'ok' && /Connected/.test(l.text))!.text, /typed in by hand, and it matches the router: fine/);
});

test('node side: off, not listening, no connection, no router address, Public, another firewall and a VPN each get their own line', () => {
  assert.match(nodeChecklist(node({ on: false })).lines[0].text, /Enable this PC as a node is off/);
  assert.match(nodeChecklist(node({ listening: false })).lines[0].text, /could not open port 8741/);
  assert.match(nodeChecklist(node({ adapters: [] })).lines.find(l => l.state === 'bad')!.text, /not connected to a router/);
  const apipa = nodeChecklist(node({ adapters: [{ alias: 'Wi-Fi', address: '169.254.10.20', prefix: 16, dhcp: true, gateway: null, gatewayAnswers: null }] }));
  assert.match(apipa.lines.find(l => l.state === 'bad')!.text, /Wi-Fi did not get an address from your router/);
  const wifi = nodeChecklist(node({ adapters: [{ ...SPARE, alias: 'Wi-Fi' }] }));
  assert.ok(wifi.lines.find(l => l.state === 'bad')!.steps!.some(s => /Wi-Fi, then your network's properties/.test(s)));
  const pub = nodeChecklist(node({ adapters: [{ alias: 'Wi-Fi', address: '192.168.0.50', prefix: 24, dhcp: true, gateway: '192.168.0.1', gatewayAnswers: true }], firewall: { ok: false, problems: ['The network on Wi-Fi is set to Public, so Windows blocks other PCs.'], networks: [{ alias: 'Wi-Fi', category: 'Public' }] } }));
  assert.equal(pub.ok, false);
  assert.ok(pub.lines.some(l => l.state === 'bad' && /set to Public/.test(l.text) && l.steps!.some(s => /Copy/.test(s))));
  const more = nodeChecklist(node({ adapters: [{ alias: 'Ethernet', address: '192.168.0.50', prefix: 24, dhcp: true, gateway: '192.168.0.1', gatewayAnswers: true }, { alias: 'ProtonVPN', address: '10.2.0.2', prefix: 32, dhcp: false, gateway: null, gatewayAnswers: null }], others: ['Norton 360'] }));
  assert.equal(more.ok, true, 'warnings do not fail it');
  assert.ok(more.lines.some(l => l.state === 'warn' && /Norton 360 also guards this PC/.test(l.text) && /cannot be checked from here/.test(l.text)));
  assert.ok(more.lines.some(l => l.state === 'warn' && /A VPN is on \(ProtonVPN\)/.test(l.text)));
  assert.match(nodeChecklist(node({ firewall: null, adapters: [{ alias: 'Ethernet', address: '192.168.0.50', prefix: 24, dhcp: true, gateway: '192.168.0.1', gatewayAnswers: true }] })).lines.find(l => l.state === 'warn')!.text, /Could not read this PC's firewall/);
});

test('adapters: home, virtual and VPN told apart by their names', () => {
  assert.equal(adapterKind('Ethernet', 'Intel(R) Ethernet Connection'), 'home');
  assert.equal(adapterKind('Wi-Fi', 'Intel(R) Wi-Fi 6 AX201 160MHz'), 'home');
  for (const [alias, desc] of [['vEthernet (Default Switch)', 'Hyper-V Virtual Ethernet Adapter'], ['VirtualBox Host-Only Network', ''], ['VMware Network Adapter VMnet1', ''], ['Local Area Connection* 10', 'Microsoft Wi-Fi Direct Virtual Adapter #2'], ['vEthernet (WSL)', ''], ['Bluetooth Network Connection', 'Bluetooth Device (Personal Area Network)']]) assert.equal(adapterKind(alias, desc), 'virtual', alias);
  for (const [alias, desc] of [['ProtonVPN', ''], ['Tailscale', 'Tailscale Tunnel'], ['Ethernet 2', 'TAP-Windows Adapter V9'], ['NordLynx', 'NordLynx Tunnel'], ['wg0', 'WireGuard Tunnel'], ['ZeroTier One [abc]', '']]) assert.equal(adapterKind(alias, desc), 'vpn', alias);
});

test("Windows' adapter list read: one entry or many, Dhcp as Windows writes it, loopback left out", () => {
  const one = parseAdapters('{"alias":"Ethernet","description":"Realtek","address":"192.168.1.1","prefix":24,"dhcp":"Disabled","gateway":""}');
  assert.deepEqual(one, [{ alias: 'Ethernet', description: 'Realtek', address: '192.168.1.1', prefix: 24, dhcp: false, gateway: null, gatewayAnswers: null }]);
  const many = parseAdapters('[{"alias":"Wi-Fi","description":"","address":"192.168.0.9","prefix":24,"dhcp":"Enabled","gateway":"192.168.0.1"},{"alias":"Loopback Pseudo-Interface 1","address":"127.0.0.1","prefix":8,"dhcp":"Disabled","gateway":""}]');
  assert.equal(many.length, 1);
  assert.equal(many[0].dhcp, true);
  assert.equal(many[0].gateway, '192.168.0.1');
  assert.deepEqual(parseAdapters('not json'), []);
});

test('the typed address: 192.178 is a typo for 192.168, the router is not the node, this PC is not either', () => {
  // That afternoon's typo, which would also have been the router.
  const t = addressAdvice('192.178.0.1:8741', MAIN);
  assert.equal(t.url, null);
  assert.match(t.problem!, /192\.178\.0\.1 is not a home-network address/);
  assert.match(t.problem!, /192\.168\.0\.1 would be your router/);
  const t2 = addressAdvice('192.178.0.50', MAIN);
  assert.match(t2.problem!, /did you mean 192\.168\.0\.50/);
  assert.equal(t2.suggest, '192.168.0.50:8741');
  assert.match(addressAdvice('192.168.0.1:8741', MAIN).problem!, /192\.168\.0\.1 is your router/);
  assert.match(addressAdvice('192.168.0.30', MAIN).problem!, /this PC's own address/);
  assert.match(addressAdvice('192.168.0.255', MAIN).problem!, /not a PC's address/);
  assert.match(addressAdvice('8.8.8.8', MAIN).problem!, /not on your home network/);
  assert.match(addressAdvice('', MAIN).problem!, /for example 192\.168\.0\.20:8741/);
  // Fine.
  assert.deepEqual(addressAdvice('192.168.0.50', MAIN), { url: 'http://192.168.0.50:8741', problem: null, suggest: null, warn: null });
  assert.equal(addressAdvice('desk.local:9000', MAIN).url, 'http://desk.local:9000');
  // On another network (SPARE-PC's own address): tried, with the warning that it will not be reached from here.
  const other = addressAdvice('192.168.1.1:8741', MAIN);
  assert.equal(other.url, 'http://192.168.1.1:8741');
  assert.match(other.warn!, /different network from this PC \(192\.168\.0\.30\)/);
  assert.match(other.warn!, /should start 192\.168\.0\./);
});

test('the link PIN: 6 digits or nothing; 4 or 5 digits is read as the app lock PIN', () => {
  assert.equal(pinAdvice(''), null);
  assert.equal(pinAdvice('123 456'), null);
  assert.match(pinAdvice('1234')!, /A link PIN is 6 digits/);
  assert.match(pinAdvice('1234')!, /app lock PIN/);
  assert.match(pinAdvice('1234567')!, /6 digits/);
});

test('SPARE-PC, main side: on another network, nothing answers, and a device here has no home address: its address was typed in by hand', () => {
  const r = diagnoseLink(facts({ address: '192.168.1.1:8741', name: 'SPARE-PC', named: { found: [] }, ping: false, probe: 'timeout', v6Only: 1 }));
  assert.equal(r.state, 'bad');
  assert.match(r.title, /192\.168\.1\.1 is on a different network from this PC/);
  assert.ok(r.lines.some(l => /This PC: 192\.168\.0\.30 on Ethernet, router 192\.168\.0\.1/.test(l.text)));
  assert.ok(r.lines.some(l => /No PC called SPARE-PC answered by name/.test(l.text)));
  assert.ok(r.lines.some(l => /1 device on your network has no 192\.168\.0\. address/.test(l.text) && /typed in by hand/.test(l.text)));
  assert.ok(r.steps.some(s => /On SPARE-PC: Settings, Network & internet/.test(s)));
  assert.ok(r.steps.some(s => /Automatic \(DHCP\)/.test(s)));
});

test('main side: each probe result is one plain verdict', () => {
  const at = { address: '192.168.0.50' };
  assert.equal(diagnoseLink(facts({ ...at, probe: 'open', ping: true, whoami: { tomlin: true, version: '2.0.64', linkOk: true } })).state, 'ok');
  assert.match(diagnoseLink(facts({ ...at, probe: 'open', ping: true, whoami: { tomlin: true, version: '2.0.64', linkOk: true } })).title, /TOMLIN answers at 192\.168\.0\.50:8741/);
  assert.match(diagnoseLink(facts({ ...at, probe: 'open', whoami: { tomlin: true, version: '2.0.20', linkOk: false } })).title, /older TOMLIN \(2\.0\.20\)/);
  assert.match(diagnoseLink(facts({ ...at, probe: 'open', whoami: { tomlin: false, version: '', linkOk: false } })).title, /Something else answers/);
  assert.match(diagnoseLink(facts({ ...at, probe: 'refused', ping: true })).title, /is there, but TOMLIN's node is not listening on port 8741/);
  const fw = diagnoseLink(facts({ ...at, probe: 'timeout', ping: true, v6Only: 1 }));
  assert.match(fw.title, /192\.168\.0\.50 is on, but something on it blocks port 8741/);
  // It answers on this network, so a device with no address here is not it: that hint is left out.
  assert.ok(!fw.lines.some(l => /has no 192\.168\.0\. address/.test(l.text)));
  assert.ok(diagnoseLink(facts({ ...at, probe: 'timeout', ping: false, v6Only: 1 })).lines.some(l => /has no 192\.168\.0\. address/.test(l.text)));
  assert.ok(fw.steps.some(s => /antivirus/.test(s)));
  assert.ok(fw.steps.some(s => /Install TOMLIN\.cmd again there and answer Yes to the firewall question/.test(s)));
  assert.match(diagnoseLink(facts({ ...at, probe: 'timeout', ping: false })).title, /Nothing answers at 192\.168\.0\.50/);
  assert.match(diagnoseLink(facts({ nodeOn: false, address: '192.168.0.50' })).title, /Start TOMLIN on the other PC first/);
  assert.match(diagnoseLink(facts({ address: '192.178.0.1' })).title, /192\.168\.0\.1 would be your router/);
  assert.match(diagnoseLink(facts({ own: [] })).title, /no home-network connection/);
  assert.match(diagnoseLink(facts()).title, /Type the address shown on that PC, or its name/);
  // A name that is found, on this network: used, and said.
  const named = diagnoseLink(facts({ name: 'DESK', named: { found: ['192.168.0.50'] }, probe: 'open', whoami: { tomlin: true, version: '2.0.64', linkOk: true } }));
  assert.ok(named.lines.some(l => /DESK is at 192\.168\.0\.50/.test(l.text)));
  assert.equal(named.state, 'ok');
});

test('probe results, and devices seen only by a link-local address', () => {
  assert.equal(probeOf('ECONNREFUSED'), 'refused');
  assert.equal(probeOf('ETIMEDOUT'), 'timeout');
  assert.equal(probeOf('timeout'), 'timeout');
  assert.equal(probeOf('EHOSTUNREACH'), 'unreachable');
  assert.equal(probeOf('ENETUNREACH'), 'unreachable');
  const n = [
    { ip: '192.168.0.50', mac: 'AA-AA-AA-AA-AA-01' }, { ip: 'fe80::1', mac: 'AA-AA-AA-AA-AA-01' },
    { ip: 'fe80::1234:5678:9abc:def0', mac: '02-00-5E-00-00-4A' },
    { ip: 'ff02::1', mac: '33-33-00-00-00-01' }, { ip: 'fe80::9', mac: '00-00-00-00-00-00' },
    { ip: '192.168.1.5', mac: 'BB-BB-BB-BB-BB-02' }, { ip: 'fe80::2', mac: 'BB-BB-BB-BB-BB-02' },
  ];
  // SPARE-PC's card: link-local only. One on another IPv4 network (192.168.1.5) is counted too: it has no address here.
  assert.equal(countV6Only(n, MAIN), 2);
});

test('the pages, the installer and Help use it', () => {
  const html = read('public/index.html');
  assert.match(html, /<details class="sub" id="link-help">/);
  assert.match(html, /Is TOMLIN open on the other PC, with "Enable this PC as a node" ticked\?/);
  assert.match(html, /id="link-help-name"/);
  assert.match(html, /Checks this PC's own settings/);
  const home = read('public/home.js');
  assert.match(home, /api\('\/api\/remotes', \{ action: 'diagnose'/);
  assert.match(home, /fetch\('\/api\/share\/reach'/);
  // Find found nothing, or a link failed: the helper opens, with the address carried over.
  assert.match(home, /openLinkHelp\(/);
  assert.match(read('src/jobrun/linking.ts'), /b\.action === 'diagnose'/);
  assert.match(read('src/jobrun/linking.ts'), /share\.pinAdvice\(|pinAdvice\(/);
  assert.match(read('src/jobrun.ts'), /p === '\/api\/share\/reach'/);
  // The installer's firewall question: Yes unless answered No (a node needs it; the rule covers the home network only).
  assert.match(read('tools/install.ts'), /Will other PCs link to this one[^']*', true, 'firewall'\)/);
  assert.match(html, /<b>Link helper<\/b>/);
});
