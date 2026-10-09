// Makes public/icon.ico from public/icon.svg: the installed program's icon (TOMLIN.exe, its shortcuts, Apps).
// PNG pictures inside an ICO file (Windows Vista and later read them), at the sizes Windows asks for.
//   node tools/make-icon.ts
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** An ICO file holding one PNG per size. */
export function icoOf(pngs: { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let at = 6 + dir.length;
  pngs.forEach((p, k) => {
    const o = k * 16;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o);
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.png.length, o + 8);
    dir.writeUInt32LE(at, o + 12);
    at += p.png.length;
  });
  return Buffer.concat([head, dir, ...pngs.map(p => p.png)]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const svg = await readFile(join(ROOT, 'public', 'icon.svg'));
  const pngs = await Promise.all(SIZES.map(async size => ({ size, png: await sharp(svg, { density: Math.max(72, size * 3) }).resize(size, size).png().toBuffer() })));
  await writeFile(join(ROOT, 'public', 'icon.ico'), icoOf(pngs));
  console.log(`Made public/icon.ico (${SIZES.join(', ')} px).`);
}
