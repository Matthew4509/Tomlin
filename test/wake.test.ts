import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMac, macFromArp, magicPacket, silentWords, wakeNode, wakeFailed, SILENT_WARN_MS } from '../src/wake.ts';

test('a MAC address is kept in one form; broadcast, empty and malformed ones are refused', () => {
  assert.equal(cleanMac('AA-BB-CC-DD-EE-0F'), 'aa:bb:cc:dd:ee:0f');
  assert.equal(cleanMac('aabbccddee0f'), 'aa:bb:cc:dd:ee:0f');
  assert.equal(cleanMac('ff-ff-ff-ff-ff-ff'), null);
  assert.equal(cleanMac('00:00:00:00:00:00'), null);
  assert.equal(cleanMac('hello'), null);
  assert.equal(cleanMac(42), null);
});

test('the magic packet is six 0xff bytes then the MAC sixteen times', () => {
  const p = magicPacket('aa:bb:cc:dd:ee:0f');
  assert.equal(p.length, 102);
  assert.deepEqual([...p.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  for (let i = 0; i < 16; i++) assert.equal(p.subarray(6 + i * 6, 12 + i * 6).toString('hex'), 'aabbccddee0f');
});

test('the MAC of a linked PC is read from the ARP table for its address only', () => {
  const text = `
Interface: 192.168.0.10 --- 0x7
  Internet Address      Physical Address      Type
  192.168.0.1           11-22-33-44-55-66     dynamic
  192.168.0.20          aa-bb-cc-dd-ee-0f     dynamic
  192.168.0.77         de-ad-be-ef-00-01     dynamic
  192.168.0.255         ff-ff-ff-ff-ff-ff     static
`;
  assert.equal(macFromArp(text, '192.168.0.77'), 'de:ad:be:ef:00:01');
  assert.equal(macFromArp(text, '192.168.0.2'), null, 'not a prefix match');
  assert.equal(macFromArp(text, '192.168.0.255'), null);
});

test('a sleeping PC is woken and waited for until it answers', async () => {
  let t = 0;
  const sent: string[] = [];
  let tries = 0;
  const r = await wakeNode({ mac: 'aa:bb:cc:dd:ee:0f', send: async m => void sent.push(m), reached: async () => ++tries >= 3, waitMs: 90_000, stepMs: 5000, sleep: async ms => void (t += ms), now: () => t });
  assert.equal(r, true);
  assert.deepEqual(sent, ['aa:bb:cc:dd:ee:0f']);
  assert.equal(t, 15_000);
});

test('a PC that does not come back is given up on at the time limit', async () => {
  let t = 0;
  const r = await wakeNode({ mac: 'aa:bb:cc:dd:ee:0f', send: async () => undefined, reached: async () => false, waitMs: 30_000, stepMs: 5000, sleep: async ms => void (t += ms), now: () => t });
  assert.equal(r, false);
  assert.ok(t >= 30_000 && t < 40_000);
});

test('the words when a PC will not wake say what to check, and without a MAC say how it is learned', () => {
  const w = wakeFailed('Z820', 90, true);
  assert.match(w, /"Z820"/);
  assert.match(w, /did not come back within 90 seconds/);
  assert.match(w, /wake-on-LAN/i);
  assert.match(w, /BIOS/);
  const n = wakeFailed('Z820', 90, false);
  assert.match(n, /has not been seen awake/i);
});

test('a PC silent for minutes is named as silent, with what that usually means', () => {
  assert.equal(SILENT_WARN_MS, 60_000);
  const w = silentWords('Z820', 300_000);
  assert.match(w, /"Z820"/);
  assert.match(w, /5 minutes/);
  assert.match(w, /asleep|sleep/i);
  assert.doesNotMatch(w, /terminated/);
  assert.match(silentWords('Z820', 90_000), /90 seconds/);
});
