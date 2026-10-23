// A3 + A4: a person's backup name and backup PIN kept on the backup PC (owner.json, hashes only), and a claim from a
// new PC: the name with the backup PIN or a recovery code, the same answer for a wrong name and a wrong PIN, the
// owner's Allow re-pointing the new link to the old folder and cutting the old link off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashSecret } from '../src/lock.ts';
import { hashCodes, makeCodes } from '../src/recovery.ts';
import { CLAIM_DAYS, allowClaim, checkClaim, claimState, cleanBackupName, cleanClaims, cleanOwnerFile, mergeCodes, nameKey, nameTaken, readOwners, writeOwnerFile, type Claim, type OwnerFile } from '../src/owner.ts';

test('a backup name is 2 to 40 characters of free text, spaces tidied; the same name in another case is the same name', () => {
  assert.equal(cleanBackupName('  Kid   1 '), 'Kid 1');
  assert.equal(cleanBackupName('Zoë'), 'Zoë');
  assert.equal(cleanBackupName('a'), null);
  assert.equal(cleanBackupName('x'.repeat(41)), null);
  assert.equal(cleanBackupName('bad\u0000name'), null);
  assert.equal(cleanBackupName(42), null);
  assert.equal(nameKey('Kid 1'), nameKey('  kid  1'));
});

async function ownerOf(name: string, pin: string, codes: string[]): Promise<OwnerFile> {
  return { name, pin: await hashSecret(pin), codes: (await hashCodes(codes)).codes, at: new Date().toISOString() };
}

test('owner.json holds hashes only, is read back whole, and a damaged or doctored one is not read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tomlin-owner-'));
  try {
    const codes = makeCodes();
    const f = await ownerOf('Kid 1', '4826', codes);
    await writeOwnerFile(join(root, 'aaaa'), f);
    const text = readFileSync(join(root, 'aaaa', 'owner.json'), 'utf8');
    // No value is the PIN itself (a hex hash may happen to hold those digits, so each value is compared whole).
    assert.deepEqual(Object.keys(JSON.parse(text).pin).sort(), ['cost', 'hash', 'salt']);
    assert.ok(!/"4826"/.test(text), 'no PIN in clear');
    for (const c of codes) assert.ok(!text.includes(c) && !text.includes(c.replace('-', '')));
    mkdirSync(join(root, 'bbbb'));
    const owners = await readOwners(root);
    assert.equal(owners.length, 1);
    assert.equal(owners[0].keep, 'aaaa');
    assert.deepEqual(owners[0].file, f);
    assert.equal(cleanOwnerFile({ ...f, pin: { salt: 'x', hash: 'not hex', cost: 1 } }), null);
    assert.equal(cleanOwnerFile({ ...f, name: '' }), null);
    assert.equal(cleanOwnerFile(null), null);
    // Unique on the backup PC: taken by another folder, free for its own.
    assert.equal(nameTaken(owners, 'KID 1', 'cccc'), true);
    assert.equal(nameTaken(owners, 'Kid 1', 'aaaa'), false);
    assert.equal(nameTaken(owners, 'Kid 2', 'cccc'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a claim: the name with the backup PIN or a code; a wrong name and a wrong PIN give the same answer; a code works once', async () => {
  const codes = makeCodes();
  let saved = null as OwnerFile | null;
  const owners = [{ keep: 'aaaa', file: await ownerOf('Kid 1', '4826', codes) }];
  const save = async (_keep: string, f: OwnerFile) => {
    saved = f;
    owners[0].file = f;
  };
  assert.deepEqual(await checkClaim(owners, 'kid 1', { pin: '4826' }, save), { keep: 'aaaa', name: 'Kid 1' });
  assert.equal(await checkClaim(owners, 'Kid 1', { pin: '4827' }, save), null);
  assert.equal(await checkClaim(owners, 'Kid 2', { pin: '4826' }, save), null);
  assert.equal(await checkClaim(owners, 'Kid 1', { pin: 'abcd' }, save), null);
  assert.equal(await checkClaim(owners, 'Kid 1', {}, save), null);
  assert.deepEqual(await checkClaim(owners, 'Kid 1', { code: codes[1] }, save), { keep: 'aaaa', name: 'Kid 1' });
  assert.ok(saved, 'the used code is crossed off in owner.json');
  assert.equal(saved!.codes.filter(c => c.used).length, 1);
  assert.equal(await checkClaim(owners, 'Kid 1', { code: codes[1] }, save), null, 'a code works once');
  assert.equal(await checkClaim(owners, 'Kid 2', { code: codes[2] }, save), null);
});

test('codes sent again keep the ones used on either side crossed off; a new set replaces them', async () => {
  const set = await hashCodes(makeCodes());
  const usedThere = set.codes.map((c, i) => (i === 0 ? { ...c, used: '2026-10-22T00:00:00.000Z' } : c));
  const usedHere = set.codes.map((c, i) => (i === 1 ? { ...c, used: '2026-10-22T01:00:00.000Z' } : c));
  const merged = mergeCodes(usedThere, usedHere);
  assert.equal(merged.filter(c => c.used).length, 2);
  const fresh = (await hashCodes(makeCodes())).codes;
  assert.deepEqual(mergeCodes(usedThere, fresh), fresh);
});

test('a claim waits for the owner up to 7 days, then it has expired', () => {
  const at = Date.parse('2026-10-22T00:00:00Z');
  const c: Claim = { id: 'c1', name: 'Kid 1', oldKeep: 'aaaa', newHash: 'h2', pc: 'LAPTOP-7', linkedAt: new Date(at).toISOString(), ip: '10.0.0.9', at: new Date(at).toISOString(), state: 'waiting' };
  assert.equal(CLAIM_DAYS, 7);
  assert.equal(claimState(c, at + 6 * 86_400_000), 'waiting');
  assert.equal(claimState(c, at + 7 * 86_400_000 + 1), 'expired');
  assert.equal(claimState({ ...c, state: 'allowed' }, at + 30 * 86_400_000), 'allowed');
  assert.deepEqual(cleanClaims([c, { id: 1 }, null]), [c]);
});

test('Allow re-points the new link to the old folder and removes the old link (the lost PC is cut off)', () => {
  const paired = [
    { name: 'Lost PC', hash: 'h1', keep: 'aaaa', at: '' },
    { name: 'Other', hash: 'h3', keep: 'bbbb', at: '' },
    { name: 'LAPTOP-7', hash: 'h2', keep: 'cccc', at: '' },
  ];
  const keepOf = (x: { keep?: string; hash: string }) => x.keep ?? x.hash.slice(0, 16);
  const c: Claim = { id: 'c1', name: 'Kid 1', oldKeep: 'aaaa', newHash: 'h2', pc: 'LAPTOP-7', linkedAt: '', ip: '', at: '', state: 'waiting' };
  const r = allowClaim(paired, c, keepOf);
  assert.ok(!('error' in r));
  assert.deepEqual(r.map(x => [x.name, keepOf(x)]), [['Other', 'bbbb'], ['LAPTOP-7', 'aaaa']]);
  assert.ok('error' in allowClaim(paired.filter(x => x.hash !== 'h2'), c, keepOf), 'the new link was removed meanwhile');
});
