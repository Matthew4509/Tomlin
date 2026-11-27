// The owner's menu and Settings page (drawn in docs/mockups/settings-tiles.html, approved 2 Nov): TOMLIN - HOME, then
// Settings with its submenu under it; pressing Settings opens tiles, one short sentence each, low priority on the last
// row. Read from the page's own files; walked in the browser on a throwaway copy. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const menu = html.slice(html.indexOf('id="rail-setup-fold"'), html.indexOf('</nav>'));
const sub = menu.slice(menu.indexOf('id="rail-settings-sub"'));

/** The submenu's lines, in order: what each opens, its words and its tile's sentence. */
const lines = [...sub.matchAll(/data-setup="(\w+)" data-about="([^"]+)"><svg.*?<\/svg>([^<]+)<\/button>/g)].map(m => ({ opens: m[1], about: m[2], name: m[3] }));

test('the left panel has no TOMLIN - HOME or Settings line; only the submenu is left', () => {
  assert.doesNotMatch(html, /TOMLIN - HOME/);
  assert.doesNotMatch(html, /id="rail-setup-home"/);
  assert.doesNotMatch(menu, /data-setup="settings"/);
  assert.doesNotMatch(menu, /Set up/);
  assert.ok(menu.includes('id="rail-settings-sub"'));
  // Nothing in the page's scripts may still look for the removed line (a missing element stops the whole page).
  assert.doesNotMatch(read('home.js'), /rail-setup-home/);
  // Home and Settings stay one press away: the logo and the Home row, and the top bar's Settings button.
  assert.match(html, /id="rail-home-row"/);
  assert.match(html, /id="settings-open"/);
});

test('eighteen lines in the order drawn: Hire staff, Agents, Memory, Models, This PC; then Add another PC, Bootable USB, Network, Manage, Cluster, Network Storage, Create a guest pass; Theme at the very end', () => {
  assert.deepEqual(lines.map(l => l.name), ['Hire staff', 'Agents', 'Memory', 'Models', 'This PC', 'Add another PC', 'Bootable USB', 'Network', 'Manage', 'Cluster', 'Network Storage', 'Create a guest pass', 'Jobs', 'Files and blog writer', 'Manage updates', 'Data and lock', 'Chat permissions', 'Theme']);
  assert.deepEqual(lines.map(l => l.opens), ['staff', 'agents', 'memory', 'models', 'thispc', 'addpc', 'usb', 'nodes', 'manage', 'cluster', 'storage', 'guestpass', 'jobs', 'files', 'updates', 'data', 'perms', 'colours']);
});

test('each has one short sentence', () => {
  for (const l of lines) {
    assert.ok(l.about.length <= 62, `${l.name}: ${l.about}`);
    assert.equal(l.about.match(/\./g)?.length, 1, l.about);
    assert.match(l.about, /\.$/);
  }
  assert.match(lines.find(l => l.name === 'Data and lock')!.about, /set a PIN and choose alerts/);
  assert.match(lines.find(l => l.name === 'Chat permissions')!.about, /may do on its own/);
});

test('three groups shown, the same in the submenu and on the tiles page: Staff and models, Your network, This app (Work is hidden)', () => {
  // Each heading comes right before the first line of its group; the last value: that group is hidden.
  const groups = [...sub.matchAll(/<li class="rail-group"( hidden)?><h3 class="rail-group-head" id="rail-group-(\w+)">([^<]+)<\/h3><\/li>\s*<li( hidden)?><button class="link" type="button" data-setup="(\w+)"/g)].map(m => [m[2], m[3], m[5], !!m[1] && !!m[4]]);
  assert.deepEqual(groups, [['staff', 'Staff and models', 'staff', false], ['network', 'Your network', 'addpc', false], ['work', 'Work', 'jobs', true], ['app', 'This app', 'updates', false]]);
  // Jobs and Files and blog writer are not in Settings: their lines are hidden, and a hidden line makes no tile.
  assert.match(sub, /<li hidden><button class="link" type="button" data-setup="files"/);
  assert.match(read('homeview.js'), /if \(li\.hidden\) continue;/);
  // The group heading is the same size as the lines under it: no small label above them.
  const css = read('style.css');
  assert.match(css, /\.rail-group-head \{[^}]*font-size: var\(--fs-md\)/);
  assert.match(css, /\.settings-group > h3 \{[^}]*font-size: var\(--fs-md\)/);
});

test('the tiles are made from the submenu, so the two always match', () => {
  assert.match(html, /<div class="settings-groups" id="settings-tiles"><\/div>/);
  const view = read('homeview.js');
  assert.match(view, /document\.querySelectorAll\('#rail-settings-sub > li'\)/);
  assert.match(view, /li\.querySelector\('\.rail-group-head'\)/);
  assert.match(view, /\$\('#settings-tiles'\)\.replaceChildren\(/);
  assert.match(view, /el\('div', \{ class: 'settings-tiles' \}, \.\.\.g\.tiles\)/);
  assert.match(view, /dataset\.about/);
  // Three across, so the last row is the low-priority three; fewer only on a narrow screen.
  assert.match(read('style.css'), /\.settings-tiles \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test('Settings opens the tiles; what was on its long page has pages of its own', () => {
  const page = html.slice(html.indexOf('id="settings"'), html.indexOf('id="setup-page"'));
  const tiles = page.slice(0, page.indexOf('id="settings-data"'));
  for (const gone of ['settings-web', 'settings-notify', 'settings-lock', 'settings-keep', 'data-colours-pick', 'settings-update']) assert.ok(!tiles.includes(gone), `${gone} is not on the tile page`);
  const data = page.slice(page.indexOf('id="settings-data"'), page.indexOf('id="settings-colours"'));
  for (const here of ['settings-keep', 'settings-lock', 'settings-notify']) assert.ok(data.includes(here), `${here} is on Data and lock`);
  // Permissions, the rules and web search have a page of their own: Permissions.
  for (const gone of ['settings-web', 'settings-permissions', 'settings-rules']) assert.ok(!data.includes(gone), `${gone} is not on Data and lock`);
  assert.ok(data.includes('id="settings-perms-body"'), 'Permissions has its own page');
  assert.ok(page.slice(page.indexOf('id="settings-colours"')).includes('data-colours-pick'));

  const mute = read('mute.js');
  const open = /function openSettings\(\) \{[\s\S]*?\n\}/.exec(mute)![0];
  assert.doesNotMatch(open, /replaceChildren/, 'the tiles need nothing drawn');
  assert.match(open, /showSettingsPage\('settings'/);
  const data2 = /function openDataLock\(\) \{[\s\S]*?\n\}/.exec(mute)![0];
  for (const box of ['notifyBox', 'appLockBox', 'keepBox']) assert.ok(data2.includes(box), box);
  assert.match(data2, /showSettingsPage\('data'/);
  const perms = /function openPermissions\(\) \{[\s\S]*?\n\}/.exec(mute)![0];
  assert.match(perms, /app\.permissionsPage\?\.\(\)/);
  assert.match(perms, /showSettingsPage\('perms', '#settings-perms'\)/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'perms'\) app\.openPermissions\?\.\(\)/);
  assert.match(mute, /app\.openDataLock = openDataLock;/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'data'\) app\.openDataLock\?\.\(\)/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'colours'\) app\.openColours\?\.\(\)/);
});

test('the two new pages behave like the other Settings pages', () => {
  assert.match(read('home.js'), /const SETUP_VIEWS = \['settings', 'models', 'storage', 'nodes', 'thispc', 'staff', 'jobs', 'files', 'updates', 'data', 'perms', 'colours', 'usb', 'addpc', 'manage', 'cluster', 'agents', 'memory'];/);
  assert.match(read('home.js'), /data: '#settings-data', perms: '#settings-perms', colours: '#settings-colours'/);
  const css = read('style.css');
  assert.match(css, /\.shell:not\(\[data-view="data"\]\) > #settings-data/);
  assert.match(css, /\.shell:not\(\[data-view="colours"\]\) > #settings-colours/);
});

test('Storage is a Settings page too: in the menu after Models, shown alone, the menu kept beside it', () => {
  const home = read('home.js');
  assert.match(home, /storage: '#storage-page'/);
  const css = read('style.css');
  assert.match(css, /\.shell:not\(\[data-view="storage"\]\) > #storage-page/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'storage'\) app\.openStorage/);
  const page = read('storage.js');
  assert.match(page, /app\.openStorage = /);
  // Where this PC runs its models from is the same choice as Where models are kept; a drive's jobs are the Network page's.
  assert.match(page, /'\/api\/models\/where', \{ dir: `\$\{pick\.value\}\\\\TOMLIN models` \}/);
  assert.match(page, /'\/api\/network\/drive-jobs', \{ pc, drive, jobs \}/);
  // Two tiles, each with Duplicate or Extended and + Add; Select in the picker gives the drive the tile's job.
  assert.match(page, /\{ job: 'store', name: 'Main model storage'/);
  assert.match(page, /\{ job: 'backups', name: 'Backup storage'/);
  assert.match(page, /\{ mode: 'mirror', name: 'Duplicate'/);
  assert.match(page, /\{ mode: 'spread', name: 'Extended'/);
  assert.match(page, /'\+ Add'/);
  assert.match(page, /if \(await setJob\(p\.id, d\.drive, t\.job, true\)\) openPicker\(''\);/);
  assert.doesNotMatch(read('index.html'), /id="storage-add-form"/);
  assert.match(read('index.html'), /<script src="storage\.js"><\/script>/);
});

test('Manage updates is a page of its own: pressing it goes there and marks it, whatever is on This PC', () => {
  const home = read('home.js');
  const open = /app\.openUpdateInstall = [^\n]*\n[\s\S]*?\n\};/.exec(home)![0];
  assert.match(open, /setView\('updates'\)/);
  assert.doesNotMatch(open, /openThisPc|scrollIntoView/, 'it was a scroll down This PC, lost as that page drew its models');
  assert.match(home, /updates: '#updates-page'/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'updates'\) app\.openUpdateInstall\?\.\(\)/);
  const thispc = html.slice(html.indexOf('id="thispc"'), html.indexOf('id="updates-page"'));
  assert.ok(thispc.length > 0 && !thispc.includes('id="node-install"'), 'not on This PC any more');
  assert.match(html, /<h2 id="thispc-title">This PC<\/h2>/);
  assert.match(html, /id="updates-page"[\s\S]*?<h2 id="updates-title">Manage updates<\/h2>[\s\S]*?id="node-install"/);
  assert.doesNotMatch(/function openThisPc\(\) \{[\s\S]*?\n\}/.exec(home)![0], /drawInstall/);
  assert.match(read('style.css'), /\.shell:not\(\[data-view="updates"\]\) > #updates-page/);
});

test('everywhere else the foot of the left panel shows nothing, and the submenu opens on Settings pages', () => {
  const css = read('style.css');
  assert.match(css, /:not\(\[data-view="colours"\]\):not\(\[data-view="usb"\]\):not\(\[data-view="addpc"\]\):not\(\[data-view="cluster"\]\):not\(\[data-view="manage"\]\):not\(\[data-view="agents"\]\):not\(\[data-view="memory"\]\) > \.rail #rail-settings-sub \{ display: none; \}/);
  assert.match(css, /:not\(\[data-view="colours"\]\):not\(\[data-view="usb"\]\):not\(\[data-view="addpc"\]\):not\(\[data-view="cluster"\]\):not\(\[data-view="manage"\]\):not\(\[data-view="agents"\]\):not\(\[data-view="memory"\]\) > \.rail > \.rail-setup \{ display: none; \}/, 'no empty box with a line across it');
});

test('links to what moved go to its new place, and no words send anyone to "Set up"', () => {
  assert.match(read('mute.js'), /text: 'Settings, Data and lock'/);
  assert.match(read('owner.js'), /Settings, Data and lock, then Put back/);
  assert.match(read('help/backups.html'), /Settings, Data and lock<\/b>/);
  for (const f of ['app.js', 'chatview.js', 'images.js', 'jobs.js', 'team.js', 'homeview.js']) assert.doesNotMatch(read(f), /(under |\()?Set up, /, f);
  const words = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(words, /<b>Set up<\/b>|Set up menu|Set up, /);
  assert.doesNotMatch(words, /aria-label="Set up"/);
});

test('Guest passes has no Add a node; the map\'s + Add a node opens the Add another PC page', () => {
  assert.doesNotMatch(html, /id="node-pass-addnode"/);
  assert.match(read('netmap.js'), /onclick: \(\) => app\.addNode\?\.\(\) \}/);
  assert.match(read('home.js'), /app\.addNode = \(\) => app\.openAddPc\(\);/);
});

test('the bottom of Linked PCs: Join another network as a guest, which opens the address and code boxes', () => {
  const linked = html.slice(html.indexOf('id="node-linked-pcs"'), html.indexOf('</section>', html.indexOf('id="node-linked-pcs"')));
  assert.match(linked, /<b>Join another network as a guest<\/b><span class="set-about">With a guest pass another PC's owner gave you<\/span>/);
  assert.doesNotMatch(html, /<b>Guest:<\/b>/);
  // The guest pass help is a "?" with words, like the others, not a bare "(!)".
  // Guest passes, as the Node row: a switch with its state line and the ! beside it; the passes open under it when on.
  assert.match(html, /<b id="pass-on-label">Guest passes<\/b><span class="set-about" id="pass-on-line">Off\. Turn on to let users access your network with a passcode\.<\/span>/);
  assert.match(html, /<span class="set-side pass-side"><span class="info"><button class="info-mark" type="button" aria-label="About guest passes" aria-describedby="node-pass-tip">!<\/button>/);
  assert.match(html, /<input type="checkbox" role="switch" id="pass-on" aria-labelledby="pass-on-label">/);
  assert.match(html, /<div class="set-block" id="pass-area" hidden>/);
  assert.doesNotMatch(html, /About guest passes<\/summary>/);
  assert.match(html, /aria-controls="node-pass-new">New guest pass<\/button>/);
  const home = read('home.js');
  // It stays on while a pass is listed: turning it off would not end them.
  assert.match(home, /if \(!e\.target\.checked && passCount > 0\) \{\n\s+e\.target\.checked = true;\n\s+said\.textContent = 'Remove the guest passes below first: turning this off does not end them\.';/);
  assert.match(home, /passCount = passes\.length;\n\s+drawPassRow\(\);/);
  assert.ok(linked.lastIndexOf('id="net-join-guest"') > linked.indexOf('id="node-update-all"'), 'at the bottom');
  assert.match(read('home.js'), /\$\('#net-join-guest'\)\.addEventListener\('click', \(\) => \{\s+app\.addNode\(\);\s+\$\('#node-addr-box'\)\.open = true;/);
});

test('a guest pass\'s models: chat on the left, pictures on the right, with the one-model-per-PC advice', () => {
  const home = read('home.js');
  assert.match(home, /\.\.\.passModelCols\(p, ticked\)\)\)\)/);
  assert.match(home, /col\('Chat', p\.models\.filter\(m => m\.kind !== 'image'\)\), col\('Pictures', p\.models\.filter\(m => m\.kind === 'image'\)\)/);
  assert.match(home, /'\(!\) With several people on the network, share one model per PC:/);
  assert.match(read('style.css'), /\.node-pass-cols \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});

test('a guest pass names each PC as the left panel does, with its specs, so two "Worker PC"s are told apart', () => {
  const home = read('home.js');
  assert.match(home, /el\('b', \{ text: p\.self \? `This PC \(\$\{app\.pcLabel\('here'\)\}\)` : app\.pcLabel\?\.\(p\.id\) \|\| p\.name \}\), el\('span', \{ class: 'hint', text: passPcSpecs\(p\) \}\)/);
  assert.match(home, /const bits = \[p\.self \? '' : pcTwinWords\(\)\[p\.id\] \?\? '', mem\?\.ram \? memWords\(mem\.ram, mem\.vram\) : '', pcMake\(p\.self \? 'here' : p\.id\)\]/);
  assert.match(home, /const fsig = JSON\.stringify\(pcs\.map\(p => \[p\.id, p\.name, passPcSpecs\(p\),/);
});

test('Create a guest pass opens Network on Guest passes with the new-pass form open', () => {
  const view = read('homeview.js');
  assert.match(view, /else if \(b\.dataset\.setup === 'guestpass'\) \{\s+\/\/[^\n]*\s+openNodes\(\);\s+app\.netSection\('guests'\);\s+app\.passesOn\?\.\(\);\s+if \(\$\('#node-pass-new'\)\.hidden\) \$\('#node-pass-create'\)\.click\(\);/);
});

test('the admin PC with no app lock manages nothing and says to set a PIN; there is no switch or typed host PIN', () => {
  const home = read('home.js');
  const hp = readFileSync(new URL('../src/jobrun/hostpins.ts', import.meta.url), 'utf8');
  // The server: the host key is used only while an app lock is set and open; turning it on with none is refused.
  assert.match(hp, /new hostpin\.HostKey\(raw, f => d\.store\.writeJson\(hostpin\.KEY_FILE, f\), \(\) => d\.appLockOn\(\) && !d\.appLocked\(\)\)/);
  assert.match(hp, /if \(!d\.appLockOn\(\)\) return \{ status: 409, body: \{ error: 'The admin PC needs an app lock: set a PIN first \(Settings, Data and lock\)\.', needAppLock: true \} \};/);
  assert.doesNotMatch(hp, /key-off|key-on|OwnHostPin/);
  assert.match(hp, /unlocked: !d\.appLocked\(\), lock: d\.appLockOn\(\), wasOff: k\.wasOff \}/);
  // The page: the title and line say so, and Set a PIN opens the App lock window.
  assert.match(html, /<b id="host-key-title">Admin PC: manages the linked PCs while unlocked<\/b>/);
  assert.doesNotMatch(html, /host-key-off|host-key-on|host-pin-|node-pin-either/);
  assert.match(html, /<button class="btn primary" type="button" id="host-key-lock" hidden>Set a PIN…<\/button>/);
  assert.match(home, /\$\('#host-key-title'\)\.textContent = noLock \? 'Admin PC: needs an app lock' : 'Admin PC: manages the linked PCs while unlocked';/);
  assert.match(home, /\$\('#host-key-lock'\)\.addEventListener\('click', \(\) => openAppLockNew\(\)\);/);
});

test('what guests may do: No limit beside each size (sent as 0), Web use and Their own tools ticks', () => {
  const html = read('index.html');
  for (const id of ['node-cap-answer-none', 'node-cap-prompt-none', 'node-cap-web', 'node-cap-tools']) assert.match(html, new RegExp(`<input type="checkbox" id="${id}">`), id);
  assert.match(html, /id="node-cap-web"> Web use: guests may search and read web pages through this PC/);
  const home = read('home.js');
  assert.match(home, /answer: \$\('#node-cap-answer-none'\)\.checked \? 0 : Number\(\$\('#node-cap-answer'\)\.value\) \|\| 2000,/);
  assert.match(home, /web: \$\('#node-cap-web'\)\.checked,\n\s+tools: \$\('#node-cap-tools'\)\.checked,/);
});
