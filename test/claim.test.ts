// A3 + A4 on real PCs (test/pcs.ts): a person's PC sends its backup name and backup PIN to the backup PC (hashes only,
// a nudge when the PIN is its screen PIN), and a new PC gets those backups: the name with the backup PIN or a
// recovery code, the backup PC's owner allows it (or not), the new link then holds the old restore points and the
// old link is cut off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_PIN, codeIn, freePort, link, nodeHome, startPc, transferEnd, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every owner.json kept on the backup PC, with its folder. */
function ownersOn(nodeDir: string): { keep: string; text: string }[] {
  const root = join(nodeDir, 'backups from other PCs');
  return (existsSync(root) ? readdirSync(root) : []).flatMap(keep => {
    try {
      return [{ keep, text: readFileSync(join(root, keep, 'owner.json'), 'utf8') }];
    } catch {
      return [];
    }
  });
}

test('A3 + A4: backup name and PIN on the backup PC, then a new PC gets the backups once the owner allows it', { timeout: 600_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-claim-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort, 'Z820');
    const node = await startPc({ root: ROOT, home: nodeDir });
    pcs.push(node);
    await unlock(node);

    // ---- A3, on the person's PC (the one that is later lost) ----
    const old = await startPc({ root: ROOT, home: join(top, 'old') });
    pcs.push(old);
    const oldPc = await link(old, workerPort);
    const set = await old.post('/api/applock', { action: 'set', pin: '1357', pin2: '1357', agree: true });
    assert.equal(set.status, 200);
    let codes: string[] = set.body.recoveryCodes;
    assert.equal((await old.post('/api/applock', { action: 'unlock', pin: '1357' })).status, 200);

    assert.equal((await old.post('/api/network/owner', { pc: oldPc, name: 'K', pin: '2580', pin2: '2580' })).status, 400, 'a name of 2 to 40');
    assert.equal((await old.post('/api/network/owner', { pc: oldPc, name: 'Kid 1', pin: '25', pin2: '25' })).status, 400, 'a PIN of 4 to 12 digits');
    assert.equal((await old.post('/api/network/owner', { pc: oldPc, name: 'Kid 1', pin: '2580', pin2: '2581' })).status, 400, 'typed twice the same');
    // The same as the screen PIN: the nudge, and nothing is sent until "Keep it anyway".
    const same = await old.post('/api/network/owner', { pc: oldPc, name: 'Kid 1', pin: '1357', pin2: '1357' });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.same, true);
    assert.match(same.body.said, /same as your screen PIN/);
    assert.deepEqual(ownersOn(nodeDir), [], 'nothing sent before the answer');
    const kept = await old.post('/api/network/owner', { pc: oldPc, name: 'Kid 1', pin: '1357', pin2: '1357', anyway: true });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    // A different one: no nudge, and it takes the place of the first.
    const diff = await old.post('/api/network/owner', { pc: oldPc, name: 'Kid 1', pin: '2580', pin2: '2580' });
    assert.equal(diff.status, 200, JSON.stringify(diff.body));
    assert.notEqual(diff.body.same, true);
    // The nudge checks the screen PIN, so it is counted: 5 checks in 10 minutes, then a wait (else trying 0000-9999
    // here would find the screen PIN). Two so far; three more pass, the next waits and nothing is checked or sent.
    for (let i = 0; i < 3; i++) assert.equal((await old.post('/api/network/owner', { pc: oldPc, name: 'Kid 1', pin: '2580', pin2: '2580' })).status, 200);
    const tooMany = await old.post('/api/network/owner', { pc: oldPc, name: 'Kid 1', pin: '1357', pin2: '1357' });
    assert.equal(tooMany.status, 429, JSON.stringify(tooMany.body));
    assert.match(tooMany.body.error, /backup PIN was set \d+ times in a few minutes.*Wait \d+ minutes?/);
    assert.equal(tooMany.body.same, undefined);
    assert.equal((await old.get(`/api/network/owner?pc=${oldPc}`)).body.name, 'Kid 1');
    const owners = ownersOn(nodeDir);
    assert.equal(owners.length, 1);
    const ownerJson = JSON.parse(owners[0].text);
    assert.equal(ownerJson.name, 'Kid 1');
    assert.deepEqual(Object.keys(ownerJson.pin).sort(), ['cost', 'hash', 'salt'], 'the PIN as a hash only');
    assert.ok(!/"2580"|"1357"/.test(owners[0].text));
    assert.equal(ownerJson.codes.length, 10);
    for (const c of codes) assert.ok(!owners[0].text.includes(c.replace('-', '')) && !owners[0].text.includes(c), 'codes as hashes only');
    // A new set made on the person's PC goes on to the backup PC by itself (the old set no longer works there either).
    const newSet = await old.post('/api/applock', { action: 'codes-new', current: '1357' });
    assert.equal(newSet.status, 200, JSON.stringify(newSet.body));
    codes = newSet.body.recoveryCodes;
    await until('the new codes to reach the backup PC', async () => JSON.parse(ownersOn(nodeDir)[0].text).codes[0].salt !== ownerJson.codes[0].salt, 30_000, 300);

    const sent = await old.post('/api/network/backup', { pc: oldPc });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal((await transferEnd(old, sent.body.transfer.id)).state, 'done');
    const listedOld = (await old.get(`/api/network/backups?pc=${oldPc}`)).body.backups as { name: string; bytes: number }[];
    assert.equal(listedOld.length, 1);

    // ---- A4, on a new PC ----
    const fresh = await startPc({ root: ROOT, home: join(top, 'new') });
    pcs.push(fresh);
    const newPc = await link(fresh, workerPort, codeIn(nodeDir));
    assert.deepEqual((await fresh.get(`/api/network/backups?pc=${newPc}`)).body.backups, [], 'a new link starts with an empty folder');
    // The name is taken on that backup PC.
    const taken = await fresh.post('/api/network/owner', { pc: newPc, name: 'kid 1', pin: '9999', pin2: '9999' });
    assert.equal(taken.status, 409, JSON.stringify(taken.body));
    assert.match(taken.body.error, /taken/);

    const wrongPin = await fresh.post('/api/network/claim', { pc: newPc, name: 'Kid 1', pin: '1111' });
    const wrongName = await fresh.post('/api/network/claim', { pc: newPc, name: 'Kid 9', pin: '2580' });
    assert.equal(wrongPin.status, 403);
    assert.equal(wrongName.status, 403);
    assert.equal(wrongPin.body.error, wrongName.body.error, 'a wrong name and a wrong PIN get the same answer');

    const asked = await fresh.post('/api/network/claim', { pc: newPc, name: 'kid 1', pin: '2580' });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.state, 'waiting');
    assert.match(asked.body.said, /Waiting for the owner of Z820/);
    assert.equal((await fresh.get(`/api/network/claim?pc=${newPc}`)).body.state, 'waiting');

    // On the backup PC: the claim is shown, with the new PC's name.
    const claims = (await node.get('/api/jobs/setup')).body.share.claims as { id: string; name: string; pc: string }[];
    assert.equal(claims.length, 1, JSON.stringify(claims));
    assert.equal(claims[0].name, 'Kid 1');
    assert.equal((await node.get('/api/status')).body.claims?.length, 1, 'the pop-up learns of it with the status');
    assert.equal((await node.post('/api/share', { claimId: claims[0].id, claimAllow: true })).body.needAppPin, true, 'Allow needs the app lock PIN on a node');
    const allowed = await node.post('/api/share', { claimId: claims[0].id, claimAllow: true, appPin: NODE_PIN });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.claims.length, 0);

    assert.equal((await fresh.get(`/api/network/claim?pc=${newPc}`)).body.state, 'allowed');
    const listedNew = (await fresh.get(`/api/network/backups?pc=${newPc}`)).body.backups as { name: string; bytes: number }[];
    assert.deepEqual(listedNew, listedOld, 'the new link holds the old restore points');
    assert.notEqual((await old.get(`/api/network/backups?pc=${oldPc}`)).status, 200, 'the lost PC is cut off');
    // The newest restore point comes back through the usual path (unchecked: the record of it went with the old PC).
    const back = await fresh.post('/api/network/bring', { pc: newPc, name: listedNew[0].name, bytes: listedNew[0].bytes });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const end = await transferEnd(fresh, back.body.transfer.id);
    assert.equal(end.state, 'done', end.said);
    assert.equal(statSync(join(top, 'new', 'backups', listedNew[0].name)).size, listedNew[0].bytes);
    // Noted as come back from another PC (audit X1): putting it back keeps this PC's PIN, sharing and link keys.
    assert.ok(JSON.parse(readFileSync(join(top, 'new', 'backups', '.brought.json'), 'utf8')).includes(listedNew[0].name));

    // ---- A recovery code in place of the PIN; Don't allow; the code is used either way ----
    const third = await startPc({ root: ROOT, home: join(top, 'third') });
    pcs.push(third);
    const thirdPc = await link(third, workerPort, codeIn(nodeDir));
    const byCode = await third.post('/api/network/claim', { pc: thirdPc, name: 'Kid 1', code: codes[4] });
    assert.equal(byCode.status, 200, JSON.stringify(byCode.body));
    const c2 = ((await node.get('/api/jobs/setup')).body.share.claims as { id: string }[])[0];
    assert.equal((await node.post('/api/share', { claimId: c2.id, claimAllow: false, appPin: NODE_PIN })).status, 200);
    assert.equal((await third.get(`/api/network/claim?pc=${thirdPc}`)).body.state, 'denied');
    assert.deepEqual((await third.get(`/api/network/backups?pc=${thirdPc}`)).body.backups, [], 'not allowed: still its own empty folder');
    assert.equal((await third.post('/api/network/claim', { pc: thirdPc, name: 'Kid 1', code: codes[4] })).status, 403, 'the code was used');

    // ---- Wrong tries pause, as linking does (Don't allow counted as one) ----
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await third.post('/api/network/claim', { pc: thirdPc, name: 'Kid 1', pin: `000${i}` })).status;
    assert.equal(last, 429);
    assert.equal((await third.post('/api/network/claim', { pc: thirdPc, name: 'Kid 1', pin: '2580' })).status, 429, 'even the right PIN waits');
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
