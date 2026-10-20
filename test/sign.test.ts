import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicOf, zipCheck } from '../src/release.ts';
import { carried, ensureKey, keyHits, signZip } from '../tools/sign.ts';

// Every folder made here is removed when the file ends.
const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tomlin-sign-'));
  made.push(d);
  return d;
};
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
/** A stand-in for src/release.ts: only its RELEASE_KEY line matters here. */
function releaseTs(dir: string, key: string): string {
  const f = join(dir, 'release.ts');
  writeFileSync(f, `// the release key\nexport const RELEASE_KEY = '${key}';\nexport const other = 1;\n`);
  return f;
}

test('the pack signs with the key TOMLIN carries, and stops on a lost or wrong key unless --new-key', () => {
  const d = tmp();
  const mine = pem();
  const rts = releaseTs(d, publicOf(mine));
  const file = join(d, 'keys', 'tomlin-release-key.pem');
  // Lost: the pack stops and says how to go on; nothing is made or written.
  const lost = ensureKey({ file, releaseTs: rts });
  assert.ok('error' in lost && /is not at .*--new-key/s.test(lost.error), JSON.stringify(lost));
  assert.equal(existsSync(file), false);
  assert.equal(carried(rts), publicOf(mine));
  // Found: taken as it is.
  mkdirSync(join(d, 'keys'));
  writeFileSync(file, mine);
  const found = ensureKey({ file, releaseTs: rts });
  assert.ok('pem' in found && found.pem === mine && !found.made);
  // Another key in its place: not used.
  writeFileSync(file, pem());
  const wrong = ensureKey({ file, releaseTs: rts });
  assert.ok('error' in wrong && /not the one TOMLIN carries/.test(wrong.error));
  // --new-key: a new pair; the old file is kept aside, never overwritten, and src/release.ts carries the new half.
  const fresh = ensureKey({ file, releaseTs: rts, newKey: true });
  assert.ok('pem' in fresh && fresh.made);
  assert.equal(carried(rts), publicOf(readFileSync(file, 'utf8')));
  assert.notEqual(carried(rts), publicOf(mine));
  assert.equal(readdirSync(join(d, 'keys')).filter(n => n.includes('.replaced-')).length, 1);
  assert.match(readFileSync(rts, 'utf8'), /export const other = 1;/);
});

test('a zip is signed only when the signature checks with the key TOMLIN carries', () => {
  const d = tmp();
  const mine = pem();
  const rts = releaseTs(d, publicOf(mine));
  const zip = join(d, 'tomlin-2.0.56.zip');
  writeFileSync(zip, 'zip bytes');
  assert.match(signZip(zip, '2.0.56', mine, rts), /Signed: .*tomlin-2\.0\.56\.zip\.sig/);
  const sig = JSON.parse(readFileSync(`${zip}.sig`, 'utf8'));
  assert.equal(zipCheck(sig, '2.0.56', sig.sha256, publicOf(mine)).code, '');
  const other = join(d, 'tomlin-2.0.57.zip');
  writeFileSync(other, 'zip bytes');
  assert.throws(() => signZip(other, '2.0.57', pem(), rts), /not signed/);
  assert.equal(existsSync(`${other}.sig`), false);
});

test('no private key ships: a key file, or a key block in any file, is found', () => {
  const d = tmp();
  mkdirSync(join(d, 'src', 'deep'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export const RELEASE_KEY = "public half only";');
  writeFileSync(join(d, 'src', 'deep', 'b.bin'), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(keyHits(d), []);
  // Spelled in two parts so this file is not a hit itself.
  const block = `-----BEGIN ${'PRIVATE KEY'}-----\nMC4CAQAwBQYDK2VwBCIEIA\n-----END PRIVATE KEY-----\n`;
  writeFileSync(join(d, 'src', 'deep', 'c.js'), `const k = \`${block}\`;`);
  writeFileSync(join(d, 'src', 'deep', 'd.bin'), Buffer.concat([Buffer.from([0, 255]), Buffer.from(block.replace('PRIVATE', 'EC PRIVATE'))]));
  writeFileSync(join(d, 'release.pem'), 'anything');
  writeFileSync(join(d, 'cert.P12'), 'anything');
  assert.deepEqual(keyHits(d).sort(), ['cert.P12', 'release.pem', 'src/deep/c.js', 'src/deep/d.bin']);
});
