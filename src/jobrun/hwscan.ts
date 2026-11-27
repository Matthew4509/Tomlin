// Network, "Scan for hardware changes": TOMLIN reads a PC's processor, RAM and graphics cards once, when it starts, so a
// card or RAM added since was not seen until a restart. This reads this PC's again, then asks each linked PC (not one
// this PC is a guest on) to read its own (/worker/hardware-rescan, from 2.1.12) and says, PC by PC, what changed.
// A linked PC on an older TOMLIN is named as such: it reads its hardware only when it starts.
import * as brains from '../brains.ts';
import { d } from './shared.ts';
import { hello } from './links.ts';
import { wireFor } from './copies.ts';

/** `only`: one linked PC's id (its own window's Scan): only that PC reads its hardware again, not this one. */
export async function hardwareScan(only = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const s = await d.store.settings();
  const pcs = s.remotes.filter(r => r.role !== 'guest' && (!only || r.id === only));
  if (only && !pcs.length) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
  const mine = !only && d.rescanHardware ? await d.rescanHardware() : [];
  const labels = brains.pcLabels(s.remotes);
  const theirs = await Promise.all(pcs.map(async r => {
    const name = labels[r.id] ?? r.name;
    const h = await hello(r, 10_000).catch(() => null);
    if (!h) return `"${name}": not answering now.`;
    if (!h.can.includes('hardware-rescan')) return `"${name}": runs an older TOMLIN, which reads its hardware only when it starts: update it, then scan again.`;
    try {
      const a = await wireFor(r).ask('/worker/hardware-rescan', {});
      const changes = Array.isArray(a.changes) ? a.changes.map(String) : [];
      // Asked again, so every page shows its new figures at once.
      await hello(r, 10_000).catch(() => undefined);
      return `"${name}": ${changes.length ? changes.join('; ') : 'no change'}.`;
    } catch (e) {
      return `"${name}": ${(e as { said?: string }).said ?? (e as Error).message}`;
    }
  }));
  const here = only ? '' : `This PC: ${mine.length ? mine.join('; ') : 'no change'}.`;
  return { status: 200, body: { said: [here, ...theirs].filter(Boolean).join(' '), changed: mine.length > 0 || theirs.some(t => !/: (no change|not answering now|runs an older)/.test(t)) } };
}
