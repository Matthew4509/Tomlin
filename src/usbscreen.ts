// A Bootable USB node's own screen (tty1: the stick's PC has no desktop). TOMLIN writes it every 10 seconds: what the
// PC is called, where to reach it, whose it is, who is linked, what it runs, and anything wrong. Nothing is typed here:
// everything is done from the admin PC.
import { writeFile } from 'node:fs/promises';

export interface ScreenFacts {
  name: string;
  version: string;
  addresses: string[];
  admin: string;
  tag: string;
  linked: string[];
  models: string[];
  lending: string;
  hardware: string;
  fault: string;
  now: Date;
}

/** The screen's text: plain lines, 78 characters at most, so an 80-column console never wraps. */
export function screenText(f: ScreenFacts): string {
  const cut = (s: string) => (s.length > 78 ? `${s.slice(0, 77)}…` : s);
  const lines = [
    `TOMLIN node: ${f.name}   (TOMLIN ${f.version}, from a Bootable USB stick)`,
    '',
    `Address:   ${f.addresses.length ? f.addresses.join('  ') : 'no network yet: plug in a cable'}`,
    `Admin:     ${f.admin} (admin key tag ${f.tag || 'none'})`,
    `Linked to: ${f.linked.length ? f.linked.join(', ') : `nobody yet. On ${f.admin}: Network, Add another PC, Find PCs on my network.`}`,
    `Running:   ${f.models.length ? f.models.join(', ') : 'no model loaded'}`,
    ...(f.lending ? [`Lending:   ${f.lending}`] : []),
    ...(f.hardware ? [`Hardware:  ${f.hardware}`] : []),
    ...(f.fault ? ['', `Problem:   ${f.fault}`] : []),
    '',
    `Updated ${f.now.toLocaleTimeString()}. Everything is done from the admin PC; nothing is typed here.`,
    'Alt+F2 gives a login (user / live) for looking at the logs: journalctl -u tomlin-node',
  ];
  return lines.map(cut).join('\n');
}

/** Writes the screen every 10 s to `tty` (clearing it first); a write that fails is tried at the next tick. */
export function startScreen(tty: string, facts: () => ScreenFacts, every = 10_000): () => void {
  let last = '';
  const draw = async () => {
    const text = screenText(facts());
    const body = text.replace(/^Updated .*$/m, '');
    if (body === last) return;
    last = body;
    await writeFile(tty, `\x1b[2J\x1b[H${text}\n`).catch(() => {
      last = '';
    });
  };
  void draw();
  const t = setInterval(() => void draw(), every);
  t.unref();
  return () => clearInterval(t);
}
