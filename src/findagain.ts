// Finding a linked PC again after it moved: the router gave it another address, so the saved one answers no more and
// its card said "Off: not answering" for good. "Find it on my network" scans the home network (as Find PCs on my network
// does), puts the TOMLIN PCs found in order, most likely first, and asks each over this PC's own sealed link to it: only
// the same PC holds that link's keys, so only it can answer. The first that does is that PC, and only its address is
// saved; nothing is linked again, so no setup code is needed and its chats, staff and settings stay as they were.
// Wired in src/jobrun/linking.ts (action "find-again"); the plain parts are tested in test/findagain.test.ts.
import { execFile } from 'node:child_process';
import { cleanMac, ipOf } from './wake.ts';

/** A TOMLIN PC that answered the scan: where, and the name it gives itself. */
export interface Found {
  url: string;
  name: string;
}

/** The saved link, as far as finding it goes. */
export interface Was {
  url: string;
  name: string;
  computer?: string;
  mac?: string;
}

/** Addresses asked over the link at most: each is one sealed hello, a few seconds at worst. */
export const MAX_TRIES = 16;

/** The IPv4 address the ARP table (the text of `arp -a`) holds for this network card, or null. */
export function ipForMac(arp: string, mac: string | undefined): string | null {
  const want = cleanMac(mac);
  if (!want) return null;
  for (const line of arp.split(/\r?\n/)) {
    const [a, b] = line.trim().split(/\s+/);
    if (a && /^\d{1,3}(\.\d{1,3}){3}$/.test(a) && cleanMac(b) === want) return a;
  }
  return null;
}

const portOf = (url: string): string => {
  try {
    return new URL(url).port;
  } catch {
    return '';
  }
};
const lastPart = (url: string): number => Number(ipOf(url)?.split('.')[3] ?? NaN);

/**
 * The addresses to ask, most likely first: the one its network card is at now (the ARP table, read after the scan),
 * then a PC giving the same name, then the rest; within each, the same port first, then the nearest address to the old
 * one (a router most often gives the next free one). Its old address is left out (it does not answer), and at most
 * MAX_TRIES are asked. Every one is still proved over the link: the order only makes the right one come sooner.
 */
export function rankFound(was: Was, found: Found[], macIp: string | null): string[] {
  const names = [was.name, was.computer].filter((x): x is string => !!x).map(x => x.trim().toLowerCase());
  const port = portOf(was.url);
  const old = lastPart(was.url);
  const score = (f: Found): number[] => [
    macIp && ipOf(f.url) === macIp ? 0 : 1,
    names.includes(f.name.trim().toLowerCase()) ? 0 : 1,
    portOf(f.url) === port ? 0 : 1,
    Number.isFinite(old) && Number.isFinite(lastPart(f.url)) ? Math.abs(lastPart(f.url) - old) : 999,
    // Two as near: the lower address first, so the order never hangs on which answered the scan first.
    Number.isFinite(lastPart(f.url)) ? lastPart(f.url) : 999,
  ];
  const seen = new Set<string>();
  return found
    .filter(f => f.url !== was.url && !seen.has(f.url) && seen.add(f.url))
    .map(f => ({ url: f.url, s: score(f) }))
    .sort((a, b) => a.s.reduce((n, v, i) => n || v - b.s[i], 0))
    .slice(0, MAX_TRIES)
    .map(x => x.url);
}

const where = (url: string) => url.replace(/^https?:\/\//, '');

/** Said when it was found and its new address saved. */
export function foundWords(name: string, from: string, to: string): string {
  return `Found "${name}" at its new address, ${where(to)} (it was ${where(from)}), and connected to it again. Its chats, staff and settings are as they were. To stop it moving again, give it a fixed address in your router (often called a DHCP reservation).`;
}

/** Said when no PC on the home network proved to be it. */
export function notFoundWords(name: string, tomlins: number): string {
  const seen = tomlins === 0 ? 'No TOMLIN PC answered on your home network' : `${tomlins} TOMLIN PC${tomlins === 1 ? '' : 's'} answered on your home network, but none of them is "${name}"`;
  return `${seen}. Check that "${name}" is switched on, awake and plugged into the network, and that TOMLIN is running there, then press Find it on my network again.`;
}

/** The ARP table as text (`arp -a`), or '' when it cannot be read. */
export function readArp(): Promise<string> {
  return new Promise(resolve => execFile('arp', ['-a'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? '' : String(out))));
}
