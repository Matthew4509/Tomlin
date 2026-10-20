import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { latestOf, publicOf, RELEASE_KEY, repoOf, sigOf, sigWhy, signRelease, signedText, WARN, zipCheck } from '../src/release.ts';

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};
const SHA = 'ab'.repeat(32);

test('a release signed with the key is taken; another zip, another version or another key is refused', () => {
  const k = pair();
  const sig = signRelease(k.pem, '2.0.56', SHA);
  assert.equal(sigWhy(sig, '2.0.56', SHA, k.pub), '');
  assert.match(sigWhy(sig, '2.0.56', 'cd'.repeat(32), k.pub), /not the one that was signed/);
  assert.match(sigWhy(sig, '2.0.57', SHA, k.pub), /for TOMLIN 2\.0\.56, not 2\.0\.57/);
  assert.match(sigWhy(sig, '2.0.56', SHA, pair().pub), /key this TOMLIN does not know/);
  assert.match(sigWhy({ ...sig, key: undefined }, '2.0.56', SHA, pair().pub), /not made with the TOMLIN release key/);
  // A signature moved onto another version's text does not pass, even with the version field changed to match.
  assert.match(sigWhy({ ...sig, version: '2.0.57' }, '2.0.57', SHA, k.pub), /not made with the TOMLIN release key/);
  assert.match(sigWhy(null, '2.0.56', SHA, k.pub), /no signature came with it/);
  assert.match(sigWhy({}, '2.0.56', SHA, k.pub), /not one TOMLIN makes/);
  assert.match(sigWhy({ version: '2.0.56', sha256: SHA, signature: 'not base64 at all!' }, '2.0.56', SHA, k.pub), /release key/);
  assert.equal(signedText('2.0.56', SHA), `TOMLIN release 2.0.56\nsha256 ${SHA}\n`);
  // TOMLIN's own key is a real Ed25519 public key (a made-up signature is refused by it, not thrown).
  assert.match(sigWhy({ ...sig, key: undefined }, '2.0.56', SHA, RELEASE_KEY), /release key/);
});

test('a signature that fails says why with a code: none, format, version, changed, a new key, or bad', () => {
  const k = pair();
  const sig = signRelease(k.pem, '2.0.56', SHA);
  // The .sig names the public half it was made with.
  assert.equal(sig.key, k.pub);
  assert.equal(publicOf(k.pem), k.pub);
  const code = (raw: unknown, v = '2.0.56', sha = SHA, key = k.pub) => zipCheck(raw, v, sha, key).code;
  assert.equal(code(sig), '');
  assert.equal(code(null), 'none');
  assert.equal(code({ version: '2.0.56' }), 'format');
  assert.equal(code(sig, '2.0.57'), 'version');
  assert.equal(code(sig, '2.0.56', 'cd'.repeat(32)), 'changed');
  // Whole, but made with a key this TOMLIN does not carry: told apart from a broken one.
  assert.equal(code(sig, '2.0.56', SHA, pair().pub), 'newkey');
  assert.match(zipCheck(sig, '2.0.56', SHA, pair().pub).why, /key this TOMLIN does not know/);
  // A key named in the .sig that does not make the signature pass is no excuse: bad.
  assert.equal(code({ ...sig, key: pair().pub }, '2.0.56', SHA, pair().pub), 'bad');
  // A .sig from before `key` was written (2.0.55's npm run release) still checks as before.
  const { key: _k, ...old } = sig;
  assert.equal(code(old), '');
  assert.equal(code(old, '2.0.56', SHA, pair().pub), 'bad');
  // The .sig picked with a hand-picked zip comes in a header, as base64 of its text.
  const header = (text: string) => Buffer.from(text).toString('base64');
  assert.equal(code(sigOf(header(JSON.stringify(sig, null, 1)))), '');
  assert.equal(code(sigOf(undefined)), 'none');
  assert.equal(code(sigOf('')), 'none');
  assert.equal(code(sigOf(header('not json'))), 'format');
  // Every code has the words a hand-picked zip's warning shows.
  for (const c of ['none', 'format', 'version', 'changed', 'newkey', 'bad'] as const) assert.ok(WARN[c].length > 20, c);
});

test("the repo comes from package.json's repository, and only a GitHub repo is taken", () => {
  assert.equal(repoOf(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).repository), 'Matthew4509/Tomlin');
  assert.equal(repoOf('https://github.com/a-b/c.d.git'), 'a-b/c.d');
  assert.equal(repoOf('git+https://github.com/a/b'), 'a/b');
  assert.equal(repoOf('a/b'), 'a/b');
  assert.equal(repoOf('https://example.com/a/b'), null);
  assert.equal(repoOf('https://github.com/a/b/c'), null);
  assert.equal(repoOf(undefined), null);
});

test('the newest release: its version from the tag, its zip and signature attached, only from GitHub', () => {
  const asset = (name: string, url = `https://github.com/o/r/releases/download/v2.0.56/${name}`) => ({ name, browser_download_url: url, size: 190_000_000 });
  const ok = latestOf({ tag_name: 'v2.0.56', published_at: '2026-10-20T10:00:00Z', body: 'Line one.\r\n\r\nLine two.', assets: [asset('tomlin-2.0.56.zip'), asset('tomlin-2.0.56.zip.sig')] });
  assert.ok(typeof ok !== 'string');
  assert.equal(ok.version, '2.0.56');
  assert.equal(ok.zip.bytes, 190_000_000);
  assert.equal(ok.notes, 'Line one. Line two.');
  // A tag with no version, the zip or its signature missing: said, nothing to take.
  assert.match(String(latestOf({ tag_name: 'latest', assets: [] })), /does not name a TOMLIN version/);
  assert.match(String(latestOf({ tag_name: '2.0.56', assets: [asset('tomlin-2.0.56.zip.sig')] })), /tomlin-2\.0\.56\.zip is not attached/);
  assert.match(String(latestOf({ tag_name: '2.0.56', assets: [asset('tomlin-2.0.56.zip')] })), /signature .* is not attached/);
  // A zip named for another version is not taken as this one.
  assert.match(String(latestOf({ tag_name: 'v2.0.56', assets: [asset('tomlin-2.0.55.zip'), asset('tomlin-2.0.55.zip.sig')] })), /not attached/);
  // A download address off GitHub is never followed (unless a check's stand-in names its own base).
  const away = { tag_name: 'v2.0.56', assets: [asset('tomlin-2.0.56.zip', 'https://example.com/z.zip'), asset('tomlin-2.0.56.zip.sig')] };
  assert.match(String(latestOf(away)), /not attached/);
  assert.ok(typeof latestOf({ tag_name: 'v2.0.56', assets: [asset('tomlin-2.0.56.zip', 'http://127.0.0.1:9/z.zip'), asset('tomlin-2.0.56.zip.sig', 'http://127.0.0.1:9/z.sig')] }, 'http://127.0.0.1:9/') !== 'string');
});
