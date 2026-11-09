// Builds the one-file installer, build/TOMLIN-Setup-<version>.exe: tools/setup.cs compiled with the C# compiler that
// comes with Windows, then the release zip written after the exe's own bytes, with its SHA-256 and length behind it
// (the layout setup.cs FindPayload reads: [zip][64 hex][length, 8 bytes LE][TOMLPAY1]). Run by tools/pack.ts after the zip
// is made. The exe checks the zip against that number before it unpacks anything; the signed zip and .sig stay the way
// updates are checked (Check zip), so they are still made.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import * as inst from '../src/installer.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MAGIC = 'TOMLPAY1';

/** The csc arguments that build the setup program (the manifest says: no administrator). */
export function setupCscArgs(o: { out: string; icon: string }): string[] {
  return [
    '-nologo', '-target:winexe', '-optimize+', `-win32icon:${o.icon}`, `-win32manifest:${join(ROOT, 'tools', 'setup.manifest')}`,
    `-out:${o.out}`, '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', '-r:System.IO.Compression.dll', '-r:System.IO.Compression.FileSystem.dll',
    join(ROOT, 'tools', 'setup.cs'),
  ];
}

/** The 80 bytes after the zip. */
export function trailer(sha256Hex: string, zipBytes: number): Buffer {
  const b = Buffer.alloc(80);
  b.write(sha256Hex, 0, 64, 'ascii');
  b.writeBigInt64LE(BigInt(zipBytes), 64);
  b.write(MAGIC, 72, 8, 'ascii');
  return b;
}

/** Compiles the setup program and writes `out` = it + the zip + the trailer. Returns the size of the file. */
export async function buildSetupExe(zip: string, out: string): Promise<number> {
  const csc = inst.places().csc.find(c => existsSync(c));
  if (!csc) throw new Error('the C# compiler that comes with Windows is not on this PC');
  execFileSync(csc, setupCscArgs({ out, icon: join(ROOT, 'public', 'icon.ico') }), { stdio: 'pipe', windowsHide: true, maxBuffer: 1 << 24 });
  const hash = createHash('sha256');
  let bytes = 0;
  const src = createReadStream(zip);
  src.on('data', c => {
    hash.update(c);
    bytes += (c as Buffer).length;
  });
  const dest = createWriteStream(out, { flags: 'a' });
  await pipeline(src, dest, { end: false });
  await new Promise<void>((res, rej) => dest.end(trailer(hash.digest('hex'), bytes), (e?: Error | null) => (e ? rej(e) : res())));
  return statSync(out).size;
}
