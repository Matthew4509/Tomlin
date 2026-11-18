// The bytes read from one drive while a model loads, from Windows' own disk counter (typeperf, once a second). It
// counts what the drive really gave, whether the runner reads the file in or maps it: llama-server prints no progress
// of its own while it loads (b11284), so this is the loading screen's real measure. A file already in Windows' memory
// reads nothing from the drive; the screen then goes by the clock. Other programs reading the same drive count too.
import { spawn, type ChildProcess } from 'node:child_process';

/** The bytes a second on one line of typeperf's CSV ("time","value"), or null for its header and its closing words. */
export function rateOfLine(line: string): number | null {
  const m = /^"[^"]*","([\d.]+)"\s*$/.exec(line.trim());
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** Adds up a rate sampled once a second into bytes. */
export class ReadCount {
  bytes = 0;
  private lastAt: number | null = null;
  /** `rate`: bytes a second over the second before `now`. */
  add(rate: number, now = Date.now()): void {
    const s = this.lastAt === null ? 1 : Math.min(5, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    this.bytes += rate * s;
  }
}

/**
 * Watches `drive` ("D:") until stop(). `onBytes` gets the bytes read so far, about once a second. Nothing on a PC that
 * is not Windows, or a drive without a letter (a network share): the screen then goes by the clock.
 */
export function watchDrive(drive: string, onBytes: (bytes: number, now: number) => void): { stop: () => void; counting: boolean } {
  if (process.platform !== 'win32' || !/^[A-Z]:$/i.test(drive)) return { stop: () => undefined, counting: false };
  let child: ChildProcess | null = null;
  try {
    child = spawn('typeperf', [`\\LogicalDisk(${drive.toUpperCase()})\\Disk Read Bytes/sec`, '-si', '1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { stop: () => undefined, counting: false };
  }
  const count = new ReadCount();
  let held = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (piece: string) => {
    const lines = (held + piece).split(/\r?\n/);
    held = lines.pop() ?? '';
    for (const l of lines) {
      const r = rateOfLine(l);
      if (r === null) continue;
      const now = Date.now();
      count.add(r, now);
      onBytes(count.bytes, now);
    }
  });
  child.on('error', () => undefined);
  return {
    counting: true,
    stop: () => {
      if (child && child.exitCode === null) child.kill();
      child = null;
    },
  };
}
