// Network, "Scan for hardware changes": TOMLIN reads a PC's processor, RAM and graphics cards once, when it starts, so a
// card or RAM added since was not seen until a restart. This reads this PC's again, then asks each linked PC (not one
// this PC is a guest on) to read its own (/worker/hardware-rescan, from 2.1.12) and says, PC by PC, what changed.
// A linked PC on an older TOMLIN is named as such: it reads its hardware only when it starts.
import * as brains from '../brains.ts';
import { d } from './shared.ts';
import { hello } from './links.ts';
import { wireFor } from './copies.ts';

export async function hardwareScan(): Promise<{ status: number; body: Record<string, unknown> }> {
  const mine = d.rescanHardware ? await d.rescanHardware() : [];
  const s = await d.store.settings();
  const labels = brains.pcLabels(s.remotes);
  const theirs = await Promise.all(s.remotes.filter(r => r.role !== 'guest').map(async r => {
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
  const here = `This PC: ${mine.length ? mine.join('; ') : 'no change'}.`;
  return { status: 200, body: { said: [here, ...theirs].join(' '), changed: mine.length > 0 || theirs.some(t => !/: (no change|not answering now|runs an older)/.test(t)) } };
}
