// Updates from git (Nodes and memory, Update this install, Check git): the newest GitHub Release of TOMLIN's repo
// (package.json `repository`) carries tomlin-<version>.zip and its signature beside it, tomlin-<version>.zip.sig, made
// by npm run pack with the release key (tools/sign.ts). That key never ships: TOMLIN carries only its public half,
// below, and a downloaded zip whose signature does not match it is never opened. A zip picked by hand (Check zip) is
// checked too, with its .sig picked beside it; a missing or failing one is a warning the person may override (Install
// anyway), so an offline PC can still be updated from a copy. Plain parts here, tested in test/release.test.ts; the
// server's doors are in src/server/selfupdate.ts.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { isVersion } from './update.ts';

/** The release key's public half (Ed25519, SPKI, base64). */
export const RELEASE_KEY = 'MCowBQYDK2VwAyEAAtaiE1qxqj+7KXlKW98yF5F8i2+L2ZYoOGy3DwUdtnU=';
const keyOf = (spki: string) => createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });

/**
 * "owner/name" of the GitHub repo in package.json's `repository` ("https://github.com/owner/name.git", or the object
 * npm writes), or in TOMLIN_RELEASE_REPO; null when it names no GitHub repo.
 */
export function repoOf(raw: unknown): string | null {
  const url = String((raw as { url?: unknown })?.url ?? raw ?? '').trim();
  const m = /^(?:git\+)?(?:https:\/\/github\.com\/|github:)?([A-Za-z0-9-]{1,39}\/[\w.-]{1,100}?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1] : null;
}

/** What is signed: the version and the zip's SHA-256, so a signature fits one zip of one version only. */
export const signedText = (version: string, sha256: string) => `TOMLIN release ${version}\nsha256 ${sha256}\n`;

/** The public half (SPKI, base64) of a private key in PEM. */
export const publicOf = (privatePem: string) => createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'der' }).toString('base64');

/** The .sig file beside a release zip. `key` names the public half it was made with (so a new key can be told apart). */
export interface ReleaseSig { version: string; sha256: string; key?: string; signature: string }

export function signRelease(privatePem: string, version: string, sha256: string): ReleaseSig {
  const signature = sign(null, Buffer.from(signedText(version, sha256)), createPrivateKey(privatePem)).toString('base64');
  return { version, sha256, key: publicOf(privatePem), signature };
}

function verifies(spki: string, version: string, sha256: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(signedText(version, sha256.toLowerCase())), keyOf(spki), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Why a signature does not pass, each with a code the page uses ('' when it passes):
 *   none     no signature came with it               format   it is not a signature file TOMLIN makes
 *   version  it is for another version               changed  the zip is not the one that was signed
 *   newkey   whole, but made with a key this TOMLIN does not carry (the maker may have changed keys)
 *   bad      it does not check out with any key it names
 */
export type SigCode = '' | 'none' | 'format' | 'version' | 'changed' | 'newkey' | 'bad';

export function zipCheck(raw: unknown, version: string, sha256: string, key: string = RELEASE_KEY): { code: SigCode; why: string } {
  if (raw == null) return { code: 'none', why: 'no signature came with it' };
  const s = (typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof s.signature !== 'string' || typeof s.sha256 !== 'string' || typeof s.version !== 'string') return { code: 'format', why: 'its signature file is not one TOMLIN makes' };
  if (s.version !== version) return { code: 'version', why: `its signature is for TOMLIN ${s.version.slice(0, 20)}, not ${version}` };
  if (s.sha256.toLowerCase() !== sha256.toLowerCase()) return { code: 'changed', why: 'the zip that came is not the one that was signed (it was changed, or cut short)' };
  if (verifies(key, version, sha256, s.signature)) return { code: '', why: '' };
  if (typeof s.key === 'string' && s.key !== key && verifies(s.key, version, sha256, s.signature)) return { code: 'newkey', why: 'it is signed with a key this TOMLIN does not know (TOMLIN\'s maker may have changed keys)' };
  return { code: 'bad', why: 'its signature was not made with the TOMLIN release key, so it was not opened' };
}

/** Why a downloaded zip may not be opened ('' when it may). */
export const sigWhy = (raw: unknown, version: string, sha256: string, key: string = RELEASE_KEY) => zipCheck(raw, version, sha256, key).why;

/**
 * The .sig picked with a zip, as the page sends it (header x-tomlin-sig: the file's text in base64): parsed, null when
 * none came, or 'bad' when it is not JSON (it then checks as `format`).
 */
export function sigOf(header: unknown): unknown {
  if (typeof header !== 'string' || !header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return 'bad';
  }
}

/** What the person is told about a signature that does not pass, for a zip picked by hand (Check zip). */
export const WARN: Record<Exclude<SigCode, ''>, string> = {
  none: 'There is no signature with it (tomlin-<version>.zip.sig, picked together with the zip).',
  format: 'The signature picked with it is not one TOMLIN\'s maker makes.',
  version: 'The signature picked with it is for another version.',
  changed: 'The zip was changed after it was signed (or the download was cut short).',
  newkey: 'It is signed with a key this TOMLIN does not know. If TOMLIN\'s maker changed keys, this is expected once.',
  bad: 'Its signature was not made with TOMLIN\'s release key.',
};

/** The newest release, as Check git shows it. */
export interface Latest {
  version: string;
  tag: string;
  published: string;
  /** The release's own words, first lines only. */
  notes: string;
  zip: { name: string; url: string; bytes: number };
  sig: { url: string };
}

/** Only GitHub's own download addresses are followed (a release's assets live there); a test's stand-in names its own. */
const fromBase = (url: unknown, base: string) => typeof url === 'string' && url.startsWith(base) && url.length < 600;

/**
 * GitHub's answer for the newest release -> what to download, or why there is nothing to take: no version in its tag
 * ("v2.0.56" or "2.0.56"), or the zip or its .sig not attached.
 */
export function latestOf(raw: unknown, base = 'https://github.com/'): Latest | string {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tag = String(r.tag_name ?? '');
  const version = tag.replace(/^v/i, '');
  if (!isVersion(version)) return `the newest release on GitHub (${tag || 'no tag'}) does not name a TOMLIN version`;
  const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
  const name = `tomlin-${version}.zip`;
  const zip = assets.find(a => a.name === name);
  const sig = assets.find(a => a.name === `${name}.sig`);
  if (!zip || !fromBase(zip.browser_download_url, base)) return `TOMLIN ${version} is on GitHub, but its ${name} is not attached to the release yet`;
  if (!sig || !fromBase(sig.browser_download_url, base)) return `TOMLIN ${version} is on GitHub, but its signature (${name}.sig) is not attached, so it cannot be checked`;
  const notes = String(r.body ?? '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4).join(' ').slice(0, 400);
  return { version, tag, published: String(r.published_at ?? ''), notes, zip: { name, url: String(zip.browser_download_url), bytes: Math.max(0, Number(zip.size) || 0) }, sig: { url: String(sig.browser_download_url) } };
}
