// Signing a release, as npm run pack does after every zip it makes (and npm run release on its own, for a zip made
// earlier). The release key's private half lives outside the repo: at TOMLIN_RELEASE_KEY when that is set, otherwise
// in the private folder in your home folder (KEY_DEFAULT). A missing or different key stops the pack (a lost file never
// makes a new key by itself); --new-key makes a new pair and writes its public half into src/release.ts, and that one
// version is then installed by hand once (Check zip, Install anyway). Every signature is checked against the public
// half TOMLIN carries before it is written, so a wrong key is caught here, not on every PC. Tested in test/sign.test.ts.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicOf, signRelease, zipCheck } from '../src/release.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_TS = join(ROOT, 'src', 'release.ts');
export const KEY_DEFAULT = join(homedir(), 'claude-private', 'tomlin-release-key.pem');
const keyPath = () => process.env.TOMLIN_RELEASE_KEY || KEY_DEFAULT;
const KEY_LINE = /export const RELEASE_KEY = '([^']*)';/;

/** The public half TOMLIN carries, read from src/release.ts as it is on disk now. */
export const carried = (file = RELEASE_TS) => KEY_LINE.exec(readFileSync(file, 'utf8'))?.[1] ?? '';

/**
 * The release key: { pem, made } or { error }. newKey: the key is lost, so a new pair replaces the one TOMLIN carries
 * (the file in its place, if any, is kept beside it, never overwritten).
 */
export function ensureKey({ file = keyPath(), releaseTs = RELEASE_TS, newKey = false } = {}): { pem: string; made: boolean; said?: string } | { error: string } {
  const pub = carried(releaseTs);
  if (existsSync(file) && !newKey) {
    const pem = readFileSync(file, 'utf8');
    let mine = '';
    try {
      mine = publicOf(pem);
    } catch {
      return { error: `The release key at ${file} could not be read as a key. Put the right file back there (or set TOMLIN_RELEASE_KEY to where it is), then try again.` };
    }
    if (mine !== pub) return { error: `The release key at ${file} is not the one TOMLIN carries in src/release.ts. Put the right key there; or, only if the right one is lost, pack with --new-key.` };
    return { pem, made: false };
  }
  if (!newKey) return { error: `The release key is not at ${file}. Found it? Put it back there (or set TOMLIN_RELEASE_KEY to where it is), then try again. Lost it? Pack with --new-key: that one version is then installed by hand once (Check zip, Install anyway), and Check git takes the ones after it.` };
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  if (existsSync(file)) renameSync(file, `${file}.replaced-${Date.now()}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, pem, { mode: 0o600 });
  const text = readFileSync(releaseTs, 'utf8');
  if (!KEY_LINE.test(text)) throw new Error(`${releaseTs} has no RELEASE_KEY line to write the new key into`);
  writeFileSync(releaseTs, text.replace(KEY_LINE, `export const RELEASE_KEY = '${publicOf(pem)}';`));
  return { pem, made: true, said: `Made a new release key: ${file} (keep a copy somewhere safe; it never goes in the repo or a zip). Its public half is now in src/release.ts: commit it with this version.` };
}

/** Writes <zip>.sig, checked first against the key TOMLIN carries. The sentence to print, or it throws. */
export function signZip(zip: string, version: string, pem: string, releaseTs = RELEASE_TS): string {
  const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
  const sig = signRelease(pem, version, sha256);
  const c = zipCheck(sig, version, sha256, carried(releaseTs));
  if (c.code) throw new Error(`not signed: ${c.why}. The key used is not the one src/release.ts carries`);
  writeFileSync(`${zip}.sig`, `${JSON.stringify(sig, null, 1)}\n`);
  return `Signed: ${basename(dirname(zip))}/${basename(zip)}.sig (sha256 ${sha256.slice(0, 16)}…).`;
}

// Spelled in two parts so this file is not a hit itself.
const BLOCK = new RegExp('-----BEGIN [A-Z ]*' + 'PRIVATE KEY-----');
const MARK = Buffer.from('PRIVATE KEY-----');

/** Every file under `dir` that is a private key, or holds one: its path from `dir`, with forward slashes. */
export function keyHits(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) {
        walk(f);
        continue;
      }
      const at = relative(dir, f).replace(/\\/g, '/');
      if (/\.(pem|key|p12|pfx)$/i.test(e.name)) {
        hits.push(at);
        continue;
      }
      if (statSync(f).size > 512 * 1024 ** 2) continue;
      const b = readFileSync(f);
      // Only a file with the marker in it is read as text (most are programs and libraries).
      for (let i = b.indexOf(MARK); i >= 0; i = b.indexOf(MARK, i + 1)) {
        if (BLOCK.test(b.toString('latin1', Math.max(0, i - 40), i + MARK.length))) {
          hits.push(at);
          break;
        }
      }
    }
  };
  walk(dir);
  return hits;
}

/** The steps that stay yours: the GitHub Release with both files. */
export function nextSteps(version: string, repo: string | null): string {
  const name = `tomlin-${version}.zip`;
  return [
    `Next, on GitHub: ${repo ? `https://github.com/${repo}/releases/new` : 'the repo\'s Releases page'}`,
    `  Tag: v${version}   Title: TOMLIN ${version}`,
    `  Attach both files: build/${name} and build/${name}.sig, then Publish release.`,
    'Check git on every PC then offers it. Copied by hand, the two files go together (Check zip takes both).',
  ].join('\n');
}
