// A quick read test of the drive a model is on, for the loading screen's estimate (src/loadeta.ts) before this PC has a
// measured speed for that drive. Until then the estimate used a fixed figure for the kind of drive (a hard disk: 120 MB/s),
// and the first load of DeepSeek-V4-Flash from D: (a hard disk that read 78 MB/s) took 2.4 times what it said.
// It reads a slice from the middle of the model's file, which is almost never in Windows' memory, and times it.
import { open, stat } from 'node:fs/promises';

/** What is read: enough to time a hard disk (about a second and a half), small enough not to be felt. */
export const PROBE_BYTES = 96 * 2 ** 20;
const CHUNK = 2 ** 20;
/** A figure this high came from Windows' memory, not the drive: it says nothing of the drive. */
const CACHED_RATE = 1.5e9;

/** The largest part of a model split into parts (name-00001-of-00003.gguf): the first part alone can be a few megabytes. */
async function biggest(file: string): Promise<string> {
  const m = /^(.*)-(\d+)-of-(\d+)(\.gguf)$/i.exec(file);
  if (!m) return file;
  const total = Number(m[3]);
  let best = file;
  let bestSize = (await stat(file)).size;
  for (let i = 1; i <= total && i <= 64; i++) {
    const part = `${m[1]}-${String(i).padStart(m[2].length, '0')}-of-${m[3]}${m[4]}`;
    const size = await stat(part).then(s => s.size, () => 0);
    if (size > bestSize) [best, bestSize] = [part, size];
  }
  return best;
}

/**
 * Bytes a second the drive reads at, from a slice of `file`; null when the file is too small to test, cannot be read, or
 * was already in memory. `at`: where in the file the slice starts (0-1, the middle by default).
 */
export async function probeRead(file: string, at = 0.5, now: () => number = () => performance.now()): Promise<number | null> {
  try {
    const part = await biggest(file);
    const size = (await stat(part)).size;
    if (size < PROBE_BYTES * 4) return null;
    const handle = await open(part, 'r');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      let pos = Math.min(size - PROBE_BYTES, Math.floor(size * at));
      let read = 0;
      const t0 = now();
      while (read < PROBE_BYTES) {
        const { bytesRead } = await handle.read(buf, 0, CHUNK, pos);
        if (!bytesRead) break;
        read += bytesRead;
        pos += bytesRead;
      }
      const seconds = (now() - t0) / 1000;
      if (read < PROBE_BYTES || !(seconds > 0)) return null;
      const rate = read / seconds;
      return rate >= CACHED_RATE ? null : rate;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
