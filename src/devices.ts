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

/**
 * A chip built into the processor, by the names Intel, AMD and Qualcomm give them: Intel UHD/HD/Iris and the Arc built
 * into Core Ultra ("Arc(TM) Graphics", "Arc(TM) 140V GPU"; an Arc card has a letter and number, "Arc A770", "Arc B580",
 * "Arc Pro A60"), AMD's "Radeon(TM) Graphics", "Radeon 780M / 890M / 8060S Graphics", "Radeon 610M", "Vega 8" and
 * "R7 Graphics" (a Radeon card is "RX", "PRO" or "VII"), and Adreno. The one rule for the hardware list and the runners'
 * lists (src/hardware.ts gpusFrom, cardsOf below).
 */
export function builtIn(name: string): boolean {
  const n = name.replace(/\((R|TM)\)/gi, '').replace(/\s+/g, ' ');
  if (/\bIntel\b.*\b(UHD|HD|Iris)\b/i.test(n)) return true;
  if (/\bArc\b/i.test(n)) return !/\bArc (Pro )?[AB]\d{2,3}/i.test(n);
  if (/\bRadeon\b/i.test(n)) return !/\bRadeon (RX|PRO|VII)\b/i.test(n) && /\bRadeon ((\d{3,4}[MS]|Vega \d+)( Graphics)?|R\d Graphics|Graphics)\b/i.test(n);
  return /\bAdreno\b|\bMicrosoft Basic\b/i.test(n);
}

const key = (s: string) => s.toLowerCase().replace(/\(r\)|\(tm\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The physical cards from each runner's list: the same name and about the same size (within 10%: CUDA and Vulkan count
 * a little differently) is one card, matched in each runner's own order, so two cards of one kind stay two. Built-in
 * chips (by `integrated`, names from this PC's hardware list, or the names above) are left out. Biggest first.
 */
export function cardsOf(lists: RunnerDevice[][], integrated: string[] = []): Card[] {
  const listed = new Set(integrated.map(key));
  const cards: (Card & { k: string })[] = [];
  for (const list of lists) {
    const taken = new Set<Card>();
    for (const d of list) {
      if (builtIn(d.desc) || listed.has(key(d.desc))) continue;
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

/** A runner lists a chip built into the processor (llama.cpp's Vulkan build then uses it, beside any card). */
export const builtInListed = (lists: RunnerDevice[][], integrated: string[] = []) =>
  lists.some(list => list.some(d => builtIn(d.desc) || integrated.map(key).includes(key(d.desc))));

/**
 * The cards a chat start names (-dev): the model's own choice; else, when a runner lists a chip built into the
 * processor beside real cards, every real card, so llama.cpp (which spreads layers over every chip it finds) leaves the
 * built-in one out. Undefined: llama.cpp picks, as before.
 */
export function startCards(saved: string[] | undefined, cards: Card[], builtInHere: boolean): string[] | undefined {
  if (saved?.length) return saved;
  return builtInHere && cards.length ? cards.flatMap(c => c.ids) : saved;
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

/** The devices in the picture runner's `sd-server --list-devices` output: one "name<TAB>description" a line. */
export function parseSdDevices(out: string): { name: string; desc: string }[] {
  return out.split(/\r?\n/).map(l => /^([A-Za-z]+\d*)\t(.+?)\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => ({ name: m[1], desc: m[2] }));
}

/**
 * The device the picture runner is held to (--backend): the biggest real card by the hardware list, when the runner
 * sees more than one graphics chip (left alone, it picks one itself, a built-in chip listed first included). Null: one
 * graphics device, or only built-in chips, so its own pick stands.
 */
export function pickSdDevice(list: { name: string; desc: string }[], gpus: { name: string; total: number | null; integrated: boolean }[]): string | null {
  const chips = list.filter(d => !/^cpu$/i.test(d.name));
  const cards = chips.filter(d => !builtIn(d.desc) && !gpus.some(g => g.integrated && key(g.name) === key(d.desc)));
  if (chips.length < 2 || !cards.length) return null;
  const biggest = [...gpus].filter(g => !g.integrated && g.total).sort((a, b) => b.total! - a.total!)[0];
  return (biggest && cards.find(d => key(d.desc).includes(key(biggest.name)) || key(biggest.name).includes(key(d.desc))))?.name ?? cards[0].name;
}

/**
 * A picture model's weights wait in RAM (--offload-to-cpu) only when the model is known to be bigger than 85% of the
 * card; a card of unknown size is left to sd-server's own fit (--auto-fit, on by default), which reads the free memory.
 */
export const pictureOffload = (bytes: number, cardTotal: number | null) => cardTotal !== null && bytes > cardTotal * 0.85;

/** Reads the picture runner's device list (it loads its card libraries, lists, and ends): [] when it cannot. */
export function listSdDevices(exe: string, env?: NodeJS.ProcessEnv): Promise<{ name: string; desc: string }[]> {
  return new Promise(resolve => {
    execFile(exe, ['--list-devices'], { windowsHide: true, timeout: 30_000, env }, (_e, stdout, stderr) => resolve(parseSdDevices(`${stdout}\n${stderr}`)));
  });
}

/** Reads one runner's device list (the program loads its card libraries, lists, and ends): [] when it cannot. */
export function listDevices(exe: string, env?: NodeJS.ProcessEnv): Promise<RunnerDevice[]> {
  return new Promise(resolve => {
    execFile(exe, ['--list-devices'], { windowsHide: true, timeout: 30_000, env }, (_e, stdout, stderr) => resolve(parseDevices(`${stdout}\n${stderr}`)));
  });
}
