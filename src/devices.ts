// Which graphics cards a model runs on (card choice). Each card runner (CUDA, Vulkan) names the cards it can use in its
// own way ("CUDA0", "Vulkan1"), and in its own order, so the names are read from the runner itself (llama-server
// --list-devices) and the same physical card is matched across runners by its name and size. A model's chosen cards are
// kept as every runner's name for them (RunOptions.cards), so the choice holds whichever runner starts it. A chip built
// into the processor is left out: it shares the RAM (Auto already skips it for chat). Plain parts, tested in
// test/devices.test.ts; read once per installed runner and kept.
import { execFile } from 'node:child_process';

const MIB = 2 ** 20;

/** One device as a runner lists it. */
export interface RunnerDevice {
  /** The runner's name for it: "CUDA0", "Vulkan1". */
  id: string;
  /** What the runner calls it: "NVIDIA GeForce RTX 3060". */
  desc: string;
  total: number;
  free: number;
}

/** One physical card: its name, its memory, and each runner's name for it. */
export interface Card {
  label: string;
  total: number;
  ids: string[];
}

/** A card id a runner may give (and the only kind a setting may keep). */
export const CARD_ID = /^(CUDA|Vulkan)\d{1,2}$/;

/** The devices in `llama-server --list-devices` output ("  CUDA0: NVIDIA GeForce RTX 3060 (12287 MiB, 11234 MiB free)"). */
export function parseDevices(out: string): RunnerDevice[] {
  const found: RunnerDevice[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*((?:CUDA|Vulkan)\d{1,2}):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)\s*$/.exec(line);
    if (m) found.push({ id: m[1], desc: m[2], total: Number(m[3]) * MIB, free: Number(m[4]) * MIB });
  }
  return found;
}

/** A chip built into the processor, by the names Intel and AMD give them (the hardware list says so where it can). */
const BUILT_IN = /\b(Intel\(R\) (UHD|HD|Iris)|Intel (UHD|HD|Iris)|AMD Radeon\(TM\) Graphics|Radeon Vega \d+ Graphics|Microsoft Basic)/i;

const key = (s: string) => s.toLowerCase().replace(/\(r\)|\(tm\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The physical cards from each runner's list: the same name and about the same size (within 10%: CUDA and Vulkan count
 * a little differently) is one card, matched in each runner's own order, so two cards of one kind stay two. Built-in
 * chips (by `integrated`, names from this PC's hardware list, or the names above) are left out. Biggest first.
 */
export function cardsOf(lists: RunnerDevice[][], integrated: string[] = []): Card[] {
  const builtIn = new Set(integrated.map(key));
  const cards: (Card & { k: string })[] = [];
  for (const list of lists) {
    const taken = new Set<Card>();
    for (const d of list) {
      if (BUILT_IN.test(d.desc) || builtIn.has(key(d.desc))) continue;
      const k = key(d.desc);
      const same = cards.find(c => !taken.has(c) && c.k === k && Math.abs(c.total - d.total) <= c.total * 0.1 && !c.ids.some(id => id.replace(/\d+$/, '') === d.id.replace(/\d+$/, '')));
      if (same) {
        same.ids.push(d.id);
        taken.add(same);
      } else {
        const c = { label: d.desc, total: d.total, ids: [d.id], k };
        cards.push(c);
        taken.add(c);
      }
    }
  }
  return cards.sort((a, b) => b.total - a.total).map(({ k: _k, ...c }) => c);
}

/** The ids in `ids` that `device`'s runner knows ("CUDA…" for CUDA, "Vulkan…" for Vulkan; none for the CPU). */
export function idsFor(device: 'cpu' | 'vulkan' | 'cuda', ids: string[] | undefined): string[] {
  if (device === 'cpu' || !ids) return [];
  const prefix = device === 'cuda' ? 'CUDA' : 'Vulkan';
  return ids.filter(id => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)));
}

/** A setting's card ids as saved or sent: only runner names, no repeats, 16 at most (anything else dropped). */
export function cleanCardIds(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && CARD_ID.test(x)))].slice(0, 16) : [];
}

/** The cards `ids` name, by label (for plain words); an id no card has is left out. */
export const cardLabels = (cards: Card[], ids: string[]) => cards.filter(c => c.ids.some(id => ids.includes(id))).map(c => c.label);

/** Reads one runner's device list (the program loads its card libraries, lists, and ends): [] when it cannot. */
export function listDevices(exe: string, env?: NodeJS.ProcessEnv): Promise<RunnerDevice[]> {
  return new Promise(resolve => {
    execFile(exe, ['--list-devices'], { windowsHide: true, timeout: 30_000, env }, (_e, stdout, stderr) => resolve(parseDevices(`${stdout}\n${stderr}`)));
  });
}
