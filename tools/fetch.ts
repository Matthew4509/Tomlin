// Downloads and unpacks model runners named in runtimes.json, each checked by SHA-256.
//   npm run fetch                      the CPU builds (enough to run everything)
//   npm run fetch -- sd-vulkan llama-cuda   named builds
//   npm run fetch -- node              this PC's own Node.js into runtime/node, so the release and the updates it
//                                      pushes carry one (only its LICENSE is downloaded; 22.18 or newer, Windows x64)
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtimes, type Device, type Engine } from '../src/runtimes.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimes = new Runtimes(join(ROOT, 'runtime'), join(ROOT, 'runtimes.json'));
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['llama-cpu', 'sd-cpu'];

for (const id of ids) {
  if (id === 'node') {
    const [a, b] = process.versions.node.split('.').map(Number);
    if (process.platform !== 'win32' || process.arch !== 'x64' || a < 22 || (a === 22 && b < 18)) {
      console.log(`Node.js ${process.version} (${process.platform} ${process.arch}) is not one to ship: use Node.js 22.18 or newer for Windows x64.`);
      process.exitCode = 1;
      continue;
    }
    const dir = join(ROOT, 'runtime', 'node');
    await mkdir(dir, { recursive: true });
    await copyFile(process.execPath, join(dir, 'node.exe'));
    // Its full licence text (MIT, with V8, OpenSSL, ICU, libuv and the rest), for this exact version: the Node.js
    // installer does not keep it on the PC, so it comes from the Node.js project's own repository.
    const licence = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
    if (!licence.ok) throw new Error(`The Node.js ${process.version} LICENSE could not be fetched (${licence.status}): try again, it must ship beside node.exe.`);
    await writeFile(join(dir, 'LICENSE'), Buffer.from(await licence.arrayBuffer()));
    await writeFile(join(dir, 'VERSION.txt'), `Node.js ${process.version} for Windows x64, copied from ${process.execPath.endsWith('node.exe') ? 'the official installer\'s node.exe' : 'node'} on the PC that made this release.\r\nNode.js is under the MIT licence; it contains parts under their own licences (V8, OpenSSL, ICU, libuv and others): the full text is in LICENSE beside it.\r\n`);
    console.log(`Node.js ${process.version}: copied to runtime/node, with its LICENSE.`);
    continue;
  }
  const pin = runtimes.pins[id];
  if (!pin) {
    console.log(`No build called ${id}. Builds: ${Object.keys(runtimes.pins).join(', ')}`);
    process.exitCode = 1;
    continue;
  }
  if (runtimes.installed(pin.engine as Engine, pin.device as Device)) {
    console.log(`${pin.name}: already here.`);
    continue;
  }
  let shown = -1;
  await runtimes.install(pin.engine, pin.device, p => {
    const pc = Math.floor((p.got / p.bytes) * 100);
    if (pc !== shown && pc % 10 === 0) console.log(`${pin.name}: ${p.checking ? 'checking' : `${pc}%`}`);
    shown = pc;
  });
  console.log(`${pin.name}: ready.`);
}
