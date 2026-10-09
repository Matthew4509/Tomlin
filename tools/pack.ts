// Makes build/tomlin-<version>.zip: everything needed to run TOMLIN on another Windows PC (unzip, then double-click
// "Start TOMLIN.cmd"). The CPU model runners and the Windows parts of the picture tools are included; models, the
// data folder, git and other platforms' files are not. The graphics builds (Vulkan) are included when this PC has them.
//   npm run pack
import '../src/envnames.ts';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARTS, SKIP } from '../src/update.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version as string;
const name = `tomlin-${version}`;
const stage = join(ROOT, 'build', 'stage');
const zip = join(ROOT, 'build', `${name}.zip`);
// What a copy of the app is: the same list an update pushed to a node carries (src/update.ts).
// The release carries its own Node.js (the installer and TOMLIN.exe use it): npm run fetch -- node puts it there.
if (!existsSync(join(ROOT, 'runtime', 'node', 'node.exe')) || !existsSync(join(ROOT, 'runtime', 'node', 'LICENSE'))) {
  console.error('runtime/node/node.exe or its LICENSE is missing: run  npm run fetch -- node  first.');
  process.exit(1);
}
await rm(stage, { recursive: true, force: true });
await rm(zip, { force: true });
for (const p of PARTS) await cp(join(ROOT, p), join(stage, name, p), { recursive: true, filter: src => !SKIP.test(src.slice(ROOT.length)) });
for (const d of ['models/chat', 'models/image/loras']) await mkdir(join(stage, name, ...d.split('/')), { recursive: true });
// Windows' own tar makes zip files; named by full path because Git's tar reads "C:\..." as a remote machine.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-a', '-c', '-f', zip, '-C', stage, name], { stdio: 'inherit' });
await rm(stage, { recursive: true, force: true });
console.log(`Made ${zip}`);
