// Nodes talk to each other directly: a PC started from a TOMLIN USB stick starts with "Let PCs my host introduces connect
// to this PC directly" on (so stick nodes copy models straight to each other), and the Direct links part says linked PCs
// need no introducing for a copy (a copy order sets up the link itself, src/jobrun/peersync.ts copyOrder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as adminkey from '../src/adminkey.ts';
import * as usbnode from '../src/usbnode.ts';
import { cleanAllow } from '../src/carry.ts';
import { DEFAULT_SHARE } from '../src/share.ts';

const stick = { v: 2, adminPub: adminkey.newAdminKey().pub, stick: adminkey.newStick(), admin: 'Desk PC', name: 'USB node', allow: usbnode.STICK_ALLOW, plainLinks: false, port: 8741, minted: '2026-11-26T00:00:00.000Z', version: '2.1.27' };

test('a stick node starts with direct connections on, from Mint through to share.json', () => {
  assert.equal(usbnode.STICK_ALLOW.peer, true);
  // What Mint writes (src/server/usb.ts: STICK_ALLOW under the ticks Mint sends, only the cluster one today).
  const minted = cleanAllow({ ...usbnode.STICK_ALLOW, ...{ lend: false } });
  assert.equal(minted.peer, true);
  assert.equal(minted.lend, false);
  assert.match(readFileSync(new URL('../src/server/usb.ts', import.meta.url), 'utf8'), /const allow = cleanAllow\(\{ \.\.\.STICK_ALLOW, \.\.\.\(b\.allow && typeof b\.allow === 'object' \? b\.allow : \{\}\) \}\);/);
  // Read back from the stick and laid over a fresh share.json: the node lets its admin's PCs connect directly.
  const read = usbnode.cleanStick(JSON.parse(JSON.stringify({ ...stick, allow: minted })))!;
  assert.equal(read.allow.peer, true);
  assert.equal(cleanAllow(usbnode.applyStick({ ...DEFAULT_SHARE }, read, true).allow).peer, true);
  // A stick with no ticks written gets the same start.
  const { allow: _none, ...bare } = stick;
  assert.equal(usbnode.cleanStick(JSON.parse(JSON.stringify(bare)))!.allow.peer, true);
  // A PC installed by hand still starts with it off.
  assert.notEqual(cleanAllow(DEFAULT_SHARE.allow).peer, true);
});

test('Direct links says linked PCs need no introducing for copies; introducing by hand is marked as not needed', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const part = html.slice(html.indexOf('<section class="set-part" id="direct-links"'), html.indexOf('</section>', html.indexOf('<section class="set-part" id="direct-links"')));
  assert.match(part, /Linked PCs need no introducing to copy a model to each other: a copy ordered from this PC sets up their direct link by itself/);
  assert.match(part, /<summary>Introduce two linked PCs by hand \(not needed for copying models\)<\/summary>/);
  assert.doesNotMatch(part, /<summary>\(!\) Introduce two linked PCs/);
  const help = readFileSync(new URL('../public/help/direct-links.html', import.meta.url), 'utf8');
  assert.match(help, /Nobody introduces them first: a copy ordered from the host sets up their direct link by itself\./);
  assert.match(help, /is not needed for copying models\./);
  assert.match(readFileSync(new URL('../public/help/bootable-usb.html', import.meta.url), 'utf8'), /so stick nodes copy models straight to each other\./);
});
