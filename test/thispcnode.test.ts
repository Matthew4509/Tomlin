// This PC is the one home for this PC: "Use this PC as a node", its setup (name, setup code, PIN, port, address), the
// PCs linked to it and the sharing and cluster permission ticks are on the page itself. Network keeps the other PCs; its
// node and storage tabs open This PC. One set of elements and one handler each (nothing duplicated).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const page = (id: string) => html.slice(html.indexOf(`<section class="nodes" id="${id}"`), html.indexOf('\n</section>\n', html.indexOf(`<section class="nodes" id="${id}"`)));
const home = read('home.js');

test('the node switch, its setup and the ticks are on This PC, not on Network, each once', () => {
  const thispc = page('thispc');
  const nodes = page('nodes');
  for (const id of ['node-on', 'node-name', 'node-code', 'node-code-new', 'node-addrs', 'node-pin-on', 'node-port', 'node-autostart', 'node-paired', 'node-host-pins', 'node-claims', 'node-allow', 'node-allow-all', 'node-share-list', 'node-plain-links', 'node-lend-idle']) {
    assert.match(thispc, new RegExp(`id="${id}"`), `${id} on This PC`);
    assert.doesNotMatch(nodes, new RegExp(`id="${id}"`), `${id} not on Network`);
    assert.equal(html.match(new RegExp(`id="${id}"`, 'g'))?.length, 1, `${id} once in the page`);
  }
  for (const k of ['pull', 'receive', 'backup', 'update', 'tune', 'off', 'peer', 'give', 'lend']) assert.equal(html.match(new RegExp(`data-allow="${k}"`, 'g'))?.length, 1, `${k}: one tick`);
  assert.match(thispc, /<b id="node-on-label">Use this PC as a node<\/b>/);
  assert.match(thispc, /<h3 id="node-sharing-title">Sharing and cluster permissions<\/h3>/);
  assert.match(thispc, /<div class="fault" id="thispc-fault" role="alert" hidden><\/div>/);
  // The old jump button on This PC is gone: the ticks are there.
  assert.doesNotMatch(html, /id="thispc-allow-open"/);
  assert.doesNotMatch(html, /id="net-sec-pc"|id="net-sec-sharing"/);
  // Network keeps the other PCs.
  for (const id of ['net-sec-linked', 'net-sec-guests', 'net-sec-advanced', 'direct-links', 'node-adv', 'node-cluster', 'node-fault']) assert.match(nodes, new RegExp(`id="${id}"`), id);
});

test('Network: the node and storage tabs open This PC; the old part names open it at that part', () => {
  assert.match(page('nodes'), /<button type="button" class="net-tab" data-thispc="node">This is a node: set it up on This PC &#8250;<\/button>/);
  assert.match(page('nodes'), /<button type="button" class="net-tab" data-thispc="sharing">/);
  assert.match(home, /const NET_ROLES = \{\n {2}admin: \['linked', 'guests', 'advanced'\],\n\};/);
  assert.match(home, /const THISPC_PARTS = \{ pc: '#node-on', node: '#node-on', sharing: '#thispc-sharing' \};/);
  assert.match(home, /function netSection\(name\) \{\n {2}if \(THISPC_PARTS\[name\]\) return thisPcAt\(name\);/);
  assert.match(home, /b\.addEventListener\('click', \(\) => \(b\.dataset\.thispc \? thisPcAt\(b\.dataset\.thispc\) : netRole\(b\.dataset\.role\)\)\)/);
  // This PC's window, the setup card on Home and the lock-then-node path all go to This PC now.
  assert.match(home, /app\.pcMore = id => \(id === 'here' \? openThisPc\(\) : app\.openPcs\(\)\);/);
  assert.match(read('homeview.js'), /'This PC', \(\) => openThisPc\(\)\)\)\);/);
  assert.match(home, /store\('node-on-after-lock', ''\);\n {2}await openThisPc\(\);\n {2}await nodeShare\(\{ on: true \}\);/);
});

test('one handler each: the ticks, the switch and the fault line', () => {
  assert.equal(home.match(/\$\('#node-on'\)\.addEventListener\('change'/g)?.length, 1);
  assert.equal(home.match(/for \(const t of document\.querySelectorAll\('#node-allow \[data-allow\]'\)\) t\.addEventListener\('change'/g)?.length, 1);
  assert.equal(home.match(/\$\('#node-allow-all'\)\.addEventListener\('change'/g)?.length, 1);
  // A refusal shows on the page the change was made on, the other line is cleared.
  const fault = home.slice(home.indexOf('function nodeFault(text) {'), home.indexOf('\n}\n', home.indexOf('function nodeFault(text) {')));
  assert.match(fault, /const here = homeUi\.view === 'thispc' \? '#thispc-fault' : '#node-fault';/);
  // Both pages are drawn from the one answer (/api/nodes).
  assert.match(home, /if \(homeUi\.view !== 'nodes' && homeUi\.view !== 'thispc'\) return;/);
});

test('behaviour: netSection sends pc and sharing to This PC and keeps the Network parts on Network', () => {
  const calls: string[] = [];
  const NET_ROLES = { admin: ['linked', 'guests', 'advanced'] };
  const THISPC_PARTS: Record<string, string> = { pc: '#node-on', node: '#node-on', sharing: '#thispc-sharing' };
  const src = home.slice(home.indexOf('function netSection(name) {'), home.indexOf('app.netSection = netSection;'));
  const netSection = new Function('NET_ROLES', 'THISPC_PARTS', 'thisPcAt', 'netRole', 'store', `${src}; return netSection;`)(
    NET_ROLES, THISPC_PARTS, (n: string) => calls.push(`thispc:${n}`), (r: string) => calls.push(`role:${r}`), () => 'admin');
  netSection('pc');
  netSection('sharing');
  netSection('guests');
  assert.deepEqual(calls, ['thispc:pc', 'thispc:sharing', 'role:admin']);
});

test('server words say the switch and the ticks are on This PC', () => {
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  assert.match(src('linkhelp.ts'), /'Use this PC as a node is off: other PCs cannot link to it\.'/);
  assert.match(src('jobrun/who.ts'), /with "Use this PC as a node" on \(This PC\)/);
  assert.match(src('carry.ts'), /its owner ticks "Accept models from linked PCs" on This PC/);
  for (const f of ['linkhelp.ts', 'jobrun/who.ts', 'jobrun/links.ts', 'jobrun/linking.ts', 'carry.ts', 'update.ts', 'poweroff.ts', 'runset.ts']) assert.doesNotMatch(src(f), /Enable this PC as a node|ticks? "[^"]+" under Network/, f);
});

test('one node switch: This PC\'s top box and My PC say the role, Network\'s card links to This PC', () => {
  const pcs = read('pcs.js');
  const net = read('netmap.js');
  // The top box keeps the role as words and the network backup switch; no "A node" switch beside it.
  assert.doesNotMatch(pcs, /role\('A node'/);
  assert.match(pcs, /role\('A network backup', /);
  // My PC: the role as one line and Change, which opens This PC at the switch.
  assert.match(pcs, /const roles = dlg\.open\n\s+\? el\('div', \{ class: 'pc-roles' \}, el\('span', \{ class: 'pc-role', id: 'pc-role-line', text: roleWords\(sh\) \}\),/);
  assert.match(pcs, /text: 'Change', title: 'Opens This PC, where the node switch is', onclick: \(\) => \{ dlg\.close\(\); app\.netSection\?\.\('node'\); \}/);
  // Network's map card: a link to This PC, no switch of its own.
  assert.doesNotMatch(net, /Set as node|Stop being a node|\$\('#node-on'\)\.click\(\)/);
  assert.match(net, /text: 'This PC settings \\u203a'.*onclick: \(\) => app\.netSection\('node'\)/);
  const roleWords = new Function(`${pcs.slice(pcs.indexOf('  function roleWords(sh) {'), pcs.indexOf('  app.roleWords = roleWords;'))}; return roleWords;`)();
  assert.equal(roleWords({ on: false }), 'Admin PC; not a node');
  assert.equal(roleWords({ on: true, allow: {} }), 'Admin PC; a node');
  assert.equal(roleWords({ on: true, allow: { backup: true } }), 'Admin PC; a node and a network backup');
  assert.equal(roleWords(null), 'Admin PC; not a node');
});

test('a refusal said on This PC is not carried into the My PC window', () => {
  const pcs = read('pcs.js');
  assert.match(pcs, /\(dlg\.open \? '' : here\.shareFault\) \|\| here\.fault \?/);
  assert.match(pcs, /here\.el = el\('section'[^\n]+\n[^\n]+\n {4}here\.shareFault = '';/);
});

/** Runs home.js's nodeShare with the server answering `answer` (an error with data, or a reply). */
async function runNodeShare(answer: { error?: string; data?: object; reply?: object }) {
  const said: string[] = [];
  const kept: Record<string, string> = {};
  const src = home.slice(home.indexOf('async function nodeShare(body, onSaved) {'), home.indexOf("\n$('#node-autostart')"));
  const api = async () => {
    if (answer.error) throw Object.assign(new Error(answer.error), { data: answer.data });
    return answer.reply;
  };
  const nodeShare = new Function('homeUi', 'api', 'nodeFault', 'nodePinNeed', 'askAppPin', 'store', 'openAppLockNew', 'refreshNodes', `${src}; return nodeShare;`)(
    { drawn: {} }, api, (t: string) => said.push(`fault:${t}`), (on: boolean) => said.push(`need:${on}`), async () => null,
    (k: string, v: string) => { kept[k] = v; }, () => said.push('lock window'), async () => undefined);
  const saved = await nodeShare({ on: true });
  return { said, kept, saved };
}

test('behaviour: turning the node on with no app lock opens the App lock window and says so once, beside the switch', async () => {
  const r = await runNodeShare({ error: 'A node must have the app lock: set a PIN first (Settings, Data and lock).', data: { needAppLock: true } });
  assert.equal(r.saved, false);
  assert.deepEqual(r.said, ['fault:', 'need:true', 'lock window'], 'no red line at the top; the line beside the switch and the window');
  assert.equal(r.kept['node-on-after-lock'], '1', 'the node turns on once the PIN is saved');
  const other = await runNodeShare({ error: 'The port is in use.' });
  assert.deepEqual(other.said, ['fault:The port is in use.']);
  const ok = await runNodeShare({ reply: { on: true } });
  assert.deepEqual(ok.said, ['fault:', 'need:false']);
  // The line names where the PIN is set and has the button; Cancel in the window forgets the waiting node.
  assert.match(html, /<div class="hint set-block" id="node-pin-need" role="status" hidden>\s*<p>A node must have the app lock, so it is still off\. The PIN is set under Settings, Data and lock, or here\. <button class="btn" type="button" id="node-pin-set">Set a PIN…<\/button><\/p>/);
  assert.match(home, /\$\('#applock-cancel'\)\.addEventListener\('click', \(\) => store\('node-on-after-lock', ''\)\);/);
  assert.match(html, /Also ask for a link PIN \(optional\): a second, 6-digit PIN typed when a PC links, not the app lock PIN/);
});

test('the App lock window speaks in plain case and says PIN', () => {
  const lock = read('lock.js');
  assert.match(html, /<p class="applock-warn" role="note" id="applock-warn">You will need this PIN \(or a recovery code\) to open TOMLIN\.<\/p>/);
  assert.match(lock, /\$\('#applock-warn'\)\.textContent = `You will need this \$\{w\} \(or a recovery code\) to open TOMLIN\.`;/);
  assert.doesNotMatch(lock + html, /WARNING|USE \$\{w\.toUpperCase\(\)\}|Create a new pin|Confirm pin|lose my pin|Save pin and lock/);
});

test('This PC: model storage under its own heading, and the backups folder only on a network backup PC, under its own heading', () => {
  const pcs = readFileSync(new URL('../public/pcs.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(pcs, /el\('h4', \{ class: 'pc-store-head', text: 'Model storage \(admin PC\):' \}\),\n\s+where\('models', 'Models are kept in'/);
  assert.match(pcs, /backup \? el\('h4', \{ class: 'pc-store-head', text: 'Network backup storage \(backup PC only\):' \}\) : null,/);
  assert.match(pcs, /backup \? where\('backups', 'Backups from other PCs are kept in', here\.backups, false, ''\) : null/);
  // A heading, not a small label over one: the same size as the page's other headings.
  assert.match(readFileSync(new URL('../public/style.css', import.meta.url), 'utf8'), /\.pc-store-head \{[^}]*font-size: var\(--fs-md\)/);
});

test('Use this PC as a node with no PIN yet: the PIN is made, typed once to open TOMLIN, and the node turns on with it; no third PIN box, a confirmation instead', () => {
  const lock = readFileSync(new URL('../public/lock.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const home = readFileSync(new URL('../public/home.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // At the unlock, the node is switched on with the PIN just typed (never kept), before the page opens again.
  assert.match(lock, /if \(store\('node-on-after-lock'\) === '1'\) \{\n\s+const on = await api\('\/api\/share', \{ on: true, appPin: pin \}\)/);
  assert.match(lock, /store\('node-on-done', '1'\);/);
  assert.doesNotMatch(lock, /store\('[^']*', pin\)/, 'the PIN is not stored');
  // After it, This PC opens and says so once, in the owner's words, with the way to the permissions.
  assert.match(home, /'Now set as a node, check permissions so another PC can connect to it'/);
  assert.match(home, /text: 'Check permissions', onclick: \(\) => \{ close\(\); app\.openSharePermissions\?\.\(\); \}/);
  assert.match(home, /if \(store\('node-on-done'\) !== '1'\) return;\n\s+store\('node-on-done', ''\);/);
});

test('the first time a PC becomes a node its permissions start as Allow all; a node that had its own ticks keeps them', async () => {
  const node = readFileSync(new URL('../src/jobrun/node.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(node, /if \(turningOn && shareState\.allow === undefined && !\('allow' in b\)\) \{\n\s+shareState\.allow = carry\.cleanAllow\(\{ pull: true, backup: true, update: true, tune: true, receive: true, give: true, lend: true, off: true, peer: true \}\);/);
  const { cleanAllow: ca } = await import('../src/carry.ts');
  assert.equal(ca({ peer: true }).peer, true, 'Let PCs my host introduces connect to this PC directly');
  // Exactly what the "Allow all" box ticks, so it shows ticked.
  const { allowsAll, cleanAllow } = await import('../src/carry.ts');
  assert.ok(allowsAll(cleanAllow({ pull: true, backup: true, update: true, tune: true, receive: true, give: true, lend: true, off: true })));
  // A fresh PC has no permissions saved, so the first switch-on is the one that sets them.
  const { DEFAULT_SHARE } = await import('../src/share.ts');
  assert.equal((DEFAULT_SHARE as { allow?: unknown }).allow, undefined);
});

test('a node lets its admin choose an unencrypted cluster link: no tick on the node, the admin\'s Cluster page decides', async () => {
  const { NODE_PLAIN_LINKS } = await import('../src/share.ts');
  assert.equal(NODE_PLAIN_LINKS, true);
  const maxnode = readFileSync(new URL('../src/jobrun/maxnode.ts', import.meta.url), 'utf8');
  assert.match(maxnode, /const plain = opened\.body\.plain === true && share\.NODE_PLAIN_LINKS;/);
  const node = readFileSync(new URL('../src/jobrun/node.ts', import.meta.url), 'utf8');
  assert.equal(node.split('plainLinks: share.NODE_PLAIN_LINKS').length - 1, 3, 'what the node tells its admin, and This PC');
  assert.doesNotMatch(node, /plainLinks: shareState\.plainLinks === true/);
  // A guest never gets one.
  assert.match(node, /plainLinks: false/);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<label class="node-plain" hidden>/);
  assert.match(html, /id="node-plain-why" hidden>/);
});
