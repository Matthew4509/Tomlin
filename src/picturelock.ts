// The picture runner and the app lock (light audit S1, picture half). sd-server takes no key (its --help: an address and
// a port only), and a proxy in front of it would not help: its own port on 127.0.0.1 still answers any program on this
// PC. So while TOMLIN is locked, a picture model this PC's owner loaded is unloaded once it has had nothing to draw for a
// while; linked PCs draw through the sealed worker door (src/jobrun/node.ts), which loads one for them on demand and
// drops it PICTURE_DROP_MS after their last picture. While TOMLIN is open, a loaded picture model stays open to programs
// on this PC: the lock's words say so (public/lock.js, Help).

/** A picture model loaded for a linked PC stays this long after its last picture (back-to-back drawing with gaps). */
export const PICTURE_DROP_MS = 10 * 60_000;
/** Locked, a picture model of this PC's own is unloaded after this long with nothing drawn (a queue running is not cut). */
export const LOCKED_IDLE_MS = 2 * 60_000;

/** Whether to unload the picture model now. `idleMs`: since it last drew or loaded. */
export function unloadWhileLocked(s: { locked: boolean; state: string; forLinked: boolean; busy: boolean; idleMs: number }): boolean {
  return s.locked && s.state === 'connected' && !s.forLinked && !s.busy && s.idleMs > LOCKED_IDLE_MS;
}
