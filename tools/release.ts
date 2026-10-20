// Signs build/tomlin-<version>.zip again (npm run pack already signs every zip it makes): writes
// build/tomlin-<version>.zip.sig with the release key (tools/sign.ts says where it is kept), checked against the public
// half TOMLIN carries (src/release.ts), and says where both files go. The key itself never goes in the repo or a zip.
//   npm run release
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoOf } from '../src/release.ts';
import { ensureKey, nextSteps, signZip } from './sign.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version as string;
const name = `tomlin-${version}.zip`;
const zip = join(ROOT, 'build', name);

if (!existsSync(zip)) {
  console.error(`build/${name} is not there: run  npm run pack  first (it signs the zip too).`);
  process.exit(1);
}
const key = ensureKey();
if ('error' in key) {
  console.error(`Not signed: ${key.error}`);
  process.exit(1);
}
try {
  console.log(signZip(zip, version, key.pem));
} catch (e) {
  console.error(`${(e as Error).message}.`);
  process.exit(1);
}
console.log(nextSteps(version, repoOf(pkg.repository)));
