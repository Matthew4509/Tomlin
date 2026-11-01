import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeChecklist } from '../src/linkhelp.ts';
import { judge, liveOthers, portIn, profileWords, read, rulesFrom, type RawRule } from '../src/firewall.ts';

const exe = 'C:\\Program Files\\nodejs\\node.exe';

test('firewall: a Public network, a block rule and no allow rule each get their own fix line', () => {
  const r = judge({ networks: [{ alias: 'Wi-Fi', category: 'Public' }], portRules: [], appRules: [{ name: 'node.exe', profile: 'Public', action: 'Block' }], others: [] }, 8741, exe);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 3);
  assert.match(r.fix, /Set-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -NetworkCategory Private/);
  assert.match(r.fix, /-Program 'C:\\Program Files\\nodejs\\node\.exe'.*Disable-NetFirewallRule/);
  assert.match(r.fix, /New-NetFirewallRule -DisplayName 'TOMLIN node' .* -LocalPort 8741 -Action Allow -Profile Private,Domain/);
});

test('firewall: a Private network with an allow rule for the port (or Any) is fine', () => {
  const ok = judge({ networks: [{ alias: 'Ethernet', category: 'Private' }], portRules: [{ name: 'Smart Manager node', profile: 'Private, Domain', action: 'Allow' }], appRules: [], others: ['ESET Firewall'] }, 8741, exe);
  assert.equal(ok.ok, true);
  assert.equal(ok.fix, '');
  assert.deepEqual(ok.others, ['ESET Firewall']);
  assert.equal(judge({ networks: [{ alias: 'Wi-Fi', category: 'Private' }], portRules: [], appRules: [{ name: 'Node.js', profile: 'Any', action: 'Allow' }], others: [] }, 8741, exe).ok, true);
});

test('firewall: an allow rule for Public only does not count once the network is made Private', () => {
  const r = judge({ networks: [{ alias: 'Wi-Fi', category: 'Public' }], portRules: [], appRules: [{ name: 'Node.js', profile: 'Public', action: 'Allow' }], others: [] }, 8741, exe);
  assert.equal(r.problems.length, 2);
  assert.match(r.fix, /New-NetFirewallRule/);
});

test('firewall: quotes in an adapter name are doubled for PowerShell', () => {
  assert.match(judge({ networks: [{ alias: "Bob's LAN", category: 'Public' }], portRules: [], appRules: [], others: [] }, 8741, exe).fix, /'Bob''s LAN'/);
});

// ---- Found on a linked PC: without admin rights Windows refuses Get-NetFirewallRule, but its firewall object answers ----

const raw = (over: Partial<RawRule> = {}): RawRule => ({ name: 'TOMLIN node', profiles: 3, action: 1, protocol: 6, ports: '8741', app: '', ...over });

test("firewall: a network type is read from Windows' number", () => {
  assert.equal(profileWords(1), 'Domain');
  assert.equal(profileWords(2), 'Private');
  assert.equal(profileWords(3), 'Domain, Private');
  assert.equal(profileWords(4), 'Public');
  assert.equal(profileWords(7), 'Any');
  assert.equal(profileWords(2147483647), 'Any');
});

test("firewall: a rule's ports can be one, a list, a range or all", () => {
  for (const ports of ['8741', '*', '80,8741', '80, 8741', '8000-9000', '80,8700-8800']) assert.equal(portIn(ports, 8741), true, ports);
  for (const ports of ['', '80', '87410', '80,443', '9000-9100', 'RPC', 'IPHTTPSIn']) assert.equal(portIn(ports, 8741), false, ports);
});

test('firewall: only rules that really cover the port and this program count', () => {
  const r = rulesFrom([
    raw(), raw({ name: 'Second copy' }),
    raw({ name: 'All ports', ports: '*', protocol: 256 }),
    raw({ name: 'UDP only', protocol: 17 }),
    raw({ name: 'Another port', ports: '3000' }),
    raw({ name: 'Another program', app: 'C:\\Games\\game.exe' }),
    raw({ name: 'Node.js', ports: '*', protocol: 6, app: exe.toUpperCase(), profiles: 2147483647 }),
    raw({ name: 'Node.js blocked', ports: '*', app: exe, action: 0, profiles: 4 }),
    raw({ name: 'Node on another port', ports: '3000', app: exe }),
  ], 8741, exe);
  assert.deepEqual(r.portRules.map(x => x.name), ['TOMLIN node', 'Second copy', 'All ports']);
  assert.deepEqual(r.portRules[0], { name: 'TOMLIN node', profile: 'Domain, Private', action: 'Allow' });
  assert.deepEqual(r.appRules, [{ name: 'Node.js', profile: 'Any', action: 'Allow' }, { name: 'Node.js blocked', profile: 'Public', action: 'Block' }]);
});

test('firewall: the rules on that PC read as fine', () => {
  const rules = rulesFrom(Array.from({ length: 8 }, () => raw()), 8741, exe);
  const r = judge({ networks: [{ alias: 'Ethernet', category: 'Private' }], ...rules, others: [] }, 8741, exe);
  assert.equal(r.ok, true);
  assert.equal(r.fix, '');
});

test('firewall: rules that could not be read are never reported as no rule', () => {
  const r = judge({ networks: [{ alias: 'Ethernet', category: 'Private' }], portRules: [], appRules: [], rulesRead: false, others: [] }, 8741, exe);
  assert.equal(r.ok, false, 'not said to be fine either');
  assert.equal(r.unread, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.fix, '', 'nothing to run');
  const lines = nodeChecklist({ on: true, listening: true, port: 8741, adapters: [], firewall: r, others: [] }).lines;
  assert.ok(!lines.some(l => /No firewall rule|lets other PCs in on port/.test(l.text)), JSON.stringify(lines));
  assert.ok(lines.some(l => l.state === 'warn' && /Could not read this PC's firewall/.test(l.text)));
  // A Public network is still known, and still said.
  const pub = judge({ networks: [{ alias: 'Wi-Fi', category: 'Public' }], portRules: [], appRules: [], rulesRead: false, others: [] }, 8741, exe);
  assert.equal(pub.problems.length, 1);
  assert.match(pub.fix, /Set-NetConnectionProfile/);
  assert.doesNotMatch(pub.fix, /New-NetFirewallRule/);
});

test("firewall: running the fix again replaces TOMLIN's rule, never adds a copy", () => {
  const { fix } = judge({ networks: [{ alias: 'Ethernet', category: 'Private' }], portRules: [], appRules: [], others: [] }, 8741, exe);
  const lines = fix.split('\n');
  const remove = lines.findIndex(l => /^Remove-NetFirewallRule -DisplayName 'TOMLIN node' -ErrorAction SilentlyContinue$/.test(l));
  const add = lines.findIndex(l => /^New-NetFirewallRule -DisplayName 'TOMLIN node'/.test(l));
  assert.ok(remove >= 0 && add > remove, fix);
});

test('firewall: a firewall program that has been uninstalled is not reported', () => {
  assert.deepEqual(liveOthers([{ name: 'ESET Firewall', there: false }, { name: 'Norton', there: true }, { name: 'No path given', there: true }, { name: 'Norton', there: true }]), ['Norton', 'No path given']);
  assert.deepEqual(liveOthers(undefined), []);
  assert.deepEqual(liveOthers({ name: 'One alone', there: true }), ['One alone']);
});

test("firewall: reading this PC's own firewall answers, and what it says can be judged", { skip: process.platform !== 'win32' && 'Windows only', timeout: 90_000 }, async () => {
  const facts = await read(8741, process.execPath);
  assert.ok(facts, 'PowerShell answered');
  assert.ok(Array.isArray(facts.networks) && Array.isArray(facts.portRules) && Array.isArray(facts.appRules) && Array.isArray(facts.others));
  assert.equal(typeof judge(facts, 8741, process.execPath).ok, 'boolean');
});
