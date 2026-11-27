// A node with no PIN: its owner, at that PC, refuses an app lock and acknowledges the risks (a tick, then a button). The
// node then listens with no lock; a linked PC still cannot update it, turn it off, delete a model or change its
// permissions (pinGate asks for a lock); a PIN set later is asked for every change again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostpin from '../src/hostpin.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const node = read('src/jobrun/node.ts');
const html = read('public/index.html');
const home = read('public/home.js');

test('the node listens with no lock only for a Bootable USB stick or a refusal made here', () => {
  assert.match(node, /if \(!d\.appLockOn\(\) && !usbStick && !shareState\.noPin\) \{/);
});

test('turning the node on with no lock needs the refusal in the same request, or one made before', () => {
  assert.match(node, /const refusing = turningOn && !d\.appLockOn\(\) && b\.refusePin === true;/);
  assert.match(node, /if \(turningOn && !d\.appLockOn\(\) && !refusing && !shareState\.noPin\) return \{ status: 409/);
  assert.match(node, /if \(refusing\) shareState\.noPin = new Date\(\)\.toISOString\(\);/);
  // A PIN set later is typed for every change again.
  assert.match(node, /const pinChecked = \(shareState\.on \|\| turningOn\) && !\(!d\.appLockOn\(\) && \(refusing \|\| !!shareState\.noPin\)\);/);
  // Only this PC's own page sets it: the worker door (other PCs) never reads refusePin.
  assert.equal(node.match(/refusePin/g)?.length, 1);
});

test('a linked PC still cannot update, turn off, delete a model or change permissions on a node with no lock', async () => {
  const gate = { damaged: () => '', lock: () => null } as unknown as Parameters<typeof hostpin.pinGate>[0];
  for (const doing of [false, true, 'power', 'perms'] as const) {
    const r = await hostpin.pinGate(gate, '1234', 'w', doing);
    assert.ok('error' in r && r.status === 409 && /has no app lock/.test(r.error), String(doing));
  }
});

test('the page: the risks, the tick, a button that works only once ticked, and a note while it runs with no PIN', () => {
  assert.match(html, /<label class="check"><input type="checkbox" id="node-nopin-tick"> I refuse to have a PIN and acknowledge the risks<\/label>/);
  assert.match(html, /<button class="btn" type="button" id="node-nopin-go" disabled>Turn the node on without a PIN<\/button>/);
  assert.match(html, /they are not encrypted either way/);
  assert.match(home, /\$\('#node-nopin-go'\)\.disabled = !e\.target\.checked;/);
  assert.match(home, /nodeShare\(\{ on: true, refusePin: true \}\)/);
  assert.match(home, /\$\('#node-nopin-note'\)\.hidden = !\(sh\.on && sh\.noPin\);/);
});
