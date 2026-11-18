// Waking a sleeping linked PC (wake-on-LAN) and saying plainly when one goes quiet.
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';

/** A MAC address as "aa:bb:cc:dd:ee:ff", or null when it is not one (or is the empty or broadcast address). */
export function cleanMac(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const hex = v.trim().toLowerCase().replace(/[:\-.]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex) || hex === 'ffffffffffff' || hex === '000000000000') return null;
  return hex.match(/../g)!.join(':');
}

/** The wake-on-LAN "magic packet": six 0xff bytes, then the MAC sixteen times. */
export function magicPacket(mac: string): Buffer {
  const m = Buffer.from(mac.replace(/:/g, ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 255), ...Array.from({ length: 16 }, () => m)]);
}

/** The MAC of `ip` in the text of `arp -a` (the whole address only). */
export function macFromArp(text: string, ip: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const [a, b] = line.trim().split(/\s+/);
    if (a === ip) return cleanMac(b);
  }
  return null;
}

/** Looks up the MAC of a PC on this network (it was just reached, so it is in the ARP table). Null if unknown. */
export function lookupMac(ip: string): Promise<string | null> {
  return new Promise(resolve => execFile('arp', ['-a'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : macFromArp(String(out), ip))));
}

/** The host name or address in a linked PC's url, when it is an IPv4 address (a name is looked up by the ARP table the same way after a reach). */
export const ipOf = (url: string): string | null => {
  try {
    const h = new URL(url).hostname;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? h : null;
  } catch {
    return null;
  }
};

/** Sends the magic packet out of every network card (to its broadcast address and the general one), on ports 9 and 7. */
export async function sendMagic(mac: string): Promise<void> {
  const pkt = magicPacket(mac);
  const targets = new Set(['255.255.255.255']);
  const from: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      from.push(i.address);
      const a = i.address.split('.').map(Number);
      const m = i.netmask.split('.').map(Number);
      targets.add(a.map((x, n) => x | (~m[n] & 255)).join('.'));
    }
  }
  await Promise.all((from.length ? from : ['0.0.0.0']).map(addr => new Promise<void>(resolve => {
    const s = createSocket('udp4');
    s.on('error', () => resolve());
    s.bind(0, addr, () => {
      s.setBroadcast(true);
      const sends = [...targets].flatMap(t => [9, 7].map(port => new Promise<void>(r => s.send(pkt, port, t, () => r()))));
      void Promise.all(sends).then(() => { s.close(); resolve(); });
    });
  })));
}

/** Sends the magic packet, then asks `reached` every `stepMs` until it says yes or `waitMs` has passed. */
export async function wakeNode(o: { mac: string; send: (mac: string) => Promise<void>; reached: () => Promise<boolean>; waitMs: number; stepMs: number; sleep: (ms: number) => Promise<void>; now: () => number }): Promise<boolean> {
  const start = o.now();
  await o.send(o.mac).catch(() => undefined);
  while (o.now() - start < o.waitMs) {
    await o.sleep(o.stepMs);
    if (await o.reached().catch(() => false)) return true;
  }
  return false;
}

/** How long a woken PC is waited for. */
export const WAKE_WAIT_MS = 90_000;

/** The words when a PC did not come back after a wake. */
export function wakeFailed(pc: string, seconds: number, hadMac: boolean): string {
  return hadMac
    ? `"${pc}" did not come back within ${seconds} seconds of being woken. It may be off, not on the network, or wake-on-LAN is not switched on there (in that PC's BIOS and its network card's settings). Wake it by hand, then press Send again.`
    : `"${pc}" is not answering and has not been seen awake yet by this PC, so it cannot be woken from here (its network address is learned while it is on). Wake it by hand, then press Send again.`;
}

/** How long a node may say nothing before the chat says so. */
export const SILENT_WARN_MS = 60_000;

/** A linked PC that has said nothing for a while, in plain words. */
export function silentWords(pc: string, ms: number): string {
  const s = Math.round(ms / 1000);
  const span = s >= 120 ? `${Math.round(s / 60)} minutes` : `${s} seconds`;
  return `"${pc}" has said nothing for ${span}. It may be busy reading a long chat, or asleep or off the network (Windows power saving).`;
}
