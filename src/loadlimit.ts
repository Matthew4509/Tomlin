/**
 * How long a model gets to start before TOMLIN gives up on it.
 *
 * It was a flat 10 minutes. A file of 89 GB read at 100 MB/s from a hard disk, or streamed to lending PCs over the
 * network, needs about 16 minutes, so the runner was killed and started again with no word on screen.
 * The limit now follows the file size at a slow but real rate, never below the old 10 minutes.
 */

/** The old flat limit: the least any start gets. */
export const MIN_START_SECONDS = 600;
/** A start never waits longer than this (a stuck runner is still ended). */
export const MAX_START_SECONDS = 4 * 3600;
/** The slowest read assumed from a local drive: a hard disk measured about 100 MB/s, so this leaves room. */
const LOCAL_BYTES_PER_SECOND = 60 * 2 ** 20;
/** The slowest assumed when the file is also sent to lending PCs over the network (1 Gb/s carries about 110 MB/s at best). */
const LINKED_BYTES_PER_SECOND = 40 * 2 ** 20;

/** The first line of the message the runner's tail carries when a start ran out of time. */
export const TIME_UP = 'TOMLIN stopped waiting for this model to start after';

/** Seconds a start of a model file of `bytes` may take. `TOMLIN_LOAD_SECONDS` sets it by hand. */
export function startSeconds(bytes: number, linked: boolean, env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.TOMLIN_LOAD_SECONDS);
  if (Number.isFinite(set) && set >= 60) return Math.min(Math.round(set), 24 * 3600);
  const rate = linked ? LINKED_BYTES_PER_SECOND : LOCAL_BYTES_PER_SECOND;
  const wanted = Math.ceil((Math.max(0, bytes) / rate) * 1.25);
  return Math.min(MAX_START_SECONDS, Math.max(MIN_START_SECONDS, wanted));
}

/** The line kept with the runner's last lines when time ran out, and read back by whyItFailed. */
export function timeUpLine(seconds: number): string {
  return `${TIME_UP} ${Math.max(1, Math.round(seconds / 60))} minutes.`;
}

/** The plain words on screen for a start that ran out of time; null when the tail does not carry the line. */
export function timeUpWords(tail: string): string | null {
  const m = new RegExp(`${TIME_UP} (\\d+) minutes`).exec(tail);
  if (!m) return null;
  return `This model did not load: it was still starting after ${m[1]} minutes, so TOMLIN stopped it (it was not started again). A big file read from a slow hard disk takes long: copy it to an SSD, or give it more time with the TOMLIN_LOAD_SECONDS setting.`;
}
