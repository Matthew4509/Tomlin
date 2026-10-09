import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../src/firewall.ts';

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
