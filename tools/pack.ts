// Makes build/tomlin-<version>.zip and its signature, build/tomlin-<version>.zip.sig: everything needed to run TOMLIN on
// another Windows PC (unzip, then double-click "Start TOMLIN.cmd"). The CPU model runners and the Windows parts of the
// picture tools are included; models, the data folder, git and other platforms' files are not. The graphics builds
// (Vulkan) are included when this PC has them. Every zip is signed with the release key (tools/sign.ts): a missing or
// different key stops the pack before anything is made, and a private key anywhere in what would ship stops it too.
//   npm run pack                 (npm run pack -- --new-key: the release key is lost, make a new one)
import '../src/envnames.ts';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoOf } from '../src/release.ts';
import { PARTS, SKIP } from '../src/update.ts';
import { ensureKey, keyHits, nextSteps, signZip } from './sign.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version as string;
const name = `tomlin-${version}`;
const stage = join(ROOT, 'build', 'stage');
const zip = join(ROOT, 'build', `${name}.zip`);
// What a copy of the app is: the same list an update pushed to a node carries (src/update.ts).
// The release carries its own Node.js (the installer and TOMLIN.exe use it): npm run fetch -- node puts it there.
if (!existsSync(join(ROOT, 'runtime', 'node', 'node.exe')) || !existsSync(join(ROOT, 'runtime', 'node', 'LICENSE'))) {
  console.error('runtime/node/node.exe or its LICENSE is missing: run  npm run fetch -- node  first.');
  process.exit(1);
}
// The release key first: with a new one (--new-key), src/release.ts carries its public half before it is copied in.
const key = ensureKey({ newKey: process.argv.includes('--new-key') });
if ('error' in key) {
  console.error(`Pack stopped: ${key.error}`);
  process.exit(1);
}
if (key.said) console.log(key.said);
await rm(stage, { recursive: true, force: true });
await rm(zip, { force: true });
await rm(`${zip}.sig`, { force: true });
for (const p of PARTS) await cp(join(ROOT, p), join(stage, name, p), { recursive: true, filter: src => !SKIP.test(src.slice(ROOT.length)) });
for (const d of ['models/chat', 'models/image/loras']) await mkdir(join(stage, name, ...d.split('/')), { recursive: true });
// A private key (the release key above all) never ships: a .pem / .key / .p12 / .pfx file, or a key block in any file.
const keys = keyHits(join(stage, name));
if (keys.length) {
  await rm(stage, { recursive: true, force: true });
  console.error(`Pack stopped: a private key would ship in ${keys.length} file(s). Take it out, then pack again:\n  ${keys.join('\n  ')}`);
  process.exit(1);
}
// Windows' own tar makes zip files; named by full path because Git's tar reads "C:\..." as a remote machine.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-a', '-c', '-f', zip, '-C', stage, name], { stdio: 'inherit' });
await rm(stage, { recursive: true, force: true });
console.log(`Made ${zip}`);
try {
  console.log(signZip(zip, version, key.pem));
} catch (e) {
  await rm(`${zip}.sig`, { force: true });
  console.error(`The zip was made but NOT signed: ${(e as Error).message}.`);
  process.exit(1);
}
console.log(nextSteps(version, repoOf(pkg.repository)));
