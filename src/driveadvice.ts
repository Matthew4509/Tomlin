// How much free room the drive the models are kept on should have, set against this PC's RAM. Advice only: nothing is
// stopped or refused. A few large models fill a drive fast (50, 100 and 150 GB each), and the bigger the RAM, the
// bigger the models a PC can run, so the room wanted goes up with it: twice the RAM is suggested, and less than the RAM
// itself is warned about (a 32 GB PC: 64 GB free is fine; 256 GB of RAM: 512 GB; 1 TB of RAM: 1 TB at least, 2 TB better).
// Tested in test/driveadvice.test.ts; the page shows the line under "Where models are kept" (public/models.js).
const GB = 2 ** 30;
/** The room suggested never goes below this, so a small PC is not told 16 GB is plenty. */
export const ROOM_FLOOR = 64 * GB;

const words = (bytes: number): string => (bytes >= 1024 * GB ? `${Math.round((bytes / (1024 * GB)) * 10) / 10} TB` : `${Math.round(bytes / GB)} GB`);

/** The free room suggested on the models drive for a PC with this much RAM: twice the RAM, never under 64 GB. */
export const roomSuggested = (ram: number): number => Math.max(ROOM_FLOOR, 2 * ram);

/** The free room below which the advice is a warning: the RAM itself (and never under 32 GB). */
export const roomWarned = (ram: number): number => Math.max(ROOM_FLOOR / 2, ram);

/**
 * The advice line for the models drive: '' when it has enough room, a suggestion under twice the RAM, a warning under the
 * RAM. `free` null (not known) says nothing. `total` is the whole drive: said when no free space on it could ever be enough.
 */
export function driveAdvice(ram: number, free: number | null, drive = 'that drive', total: number | null = null): string {
  if (!(ram > 0) || free === null || !Number.isFinite(free)) return '';
  const want = roomSuggested(ram);
  if (free >= want) return '';
  const warn = free < roomWarned(ram);
  const small = total !== null && Number.isFinite(total) && total > 0 && total < want ? ` The whole drive is ${words(total)}: a larger one is suggested.` : '';
  const head = warn
    ? `Only ${words(free)} free on ${drive}, and this PC has ${words(ram)} of RAM: a few large models would fill it.`
    : `${words(free)} free on ${drive}. With ${words(ram)} of RAM, a few large models could fill it.`;
  return `${head} About ${words(want)} free is suggested (a large hard drive does for keeping models).${small} Nothing is stopped.`;
}
