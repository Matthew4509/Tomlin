// A reading every minute while this PC does long work for another PC (a picture drawn for a linked PC): how busy the
// CPU is, the RAM free, and the graphics card's heat, clock and throttle reasons (nvidia-smi, when there is one). Added
// 26 Nov 2026: a 4-core node drawing on its CPU stopped part-way twice and its log said nothing about why.
// CPU heat is not read: Windows gives it only to tools running as administrator.
import { execFile } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';

export interface Reading {
  cpuPct: number;
  freeGB: number;
  card: string | null;
}

/** Busy share of all CPU threads between two samples of os.cpus() times, 0-100. */
export function cpuBusy(a: ReturnType<typeof cpus>, b: ReturnType<typeof cpus>): number {
  let busy = 0;
  let all = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const t0 = a[i].times;
    const t1 = b[i].times;
    const idle = t1.idle - t0.idle;
    const total = t1.user - t0.user + t1.nice - t0.nice + t1.sys - t0.sys + t1.irq - t0.irq + idle;
    busy += total - idle;
    all += total;
  }
  return all > 0 ? Math.round((busy / all) * 100) : 0;
}

/** nvidia-smi's line for the first card as words ("card 71 °C, 1290 MHz, throttle: none"), or null without one. */
export function cardWords(csv: string): string | null {
  const [temp, clock, throttle] = csv.trim().split('\n')[0]?.split(',').map(s => s.trim()) ?? [];
  if (!temp || !/^\d+/.test(temp)) return null;
  const reasons = throttle && /^0x0+$/.test(throttle) ? 'none' : throttle || 'unknown';
  return `card ${temp} °C, ${clock} MHz, throttle: ${reasons}`;
}

function readCard(): Promise<string | null> {
  return new Promise(ok => {
    execFile('nvidia-smi', ['--query-gpu=temperature.gpu,clocks.sm,clocks_throttle_reasons.active', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 10_000 }, (err, out) => ok(err ? null : cardWords(String(out))));
  });
}

/** The line written to the log for one reading. */
export const readingLine = (what: string, r: Reading): string => `${what}: CPU ${r.cpuPct}% busy, RAM ${r.freeGB.toFixed(1)} GB free of ${(totalmem() / 2 ** 30).toFixed(0)}${r.card ? `, ${r.card}` : ''}.`;

/** Starts the readings for `what`; the returned function stops them. */
export function startReadings(what: string, say: (line: string) => void, everyMs = 60_000): () => void {
  let last = cpus();
  const timer = setInterval(() => {
    const now = cpus();
    const cpuPct = cpuBusy(last, now);
    last = now;
    void readCard().then(card => say(readingLine(what, { cpuPct, freeGB: freemem() / 2 ** 30, card })));
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
