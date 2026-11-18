// A linked PC's graphics cards as this PC shows them: the card TOMLIN would really use there first.
//
// From this version on a PC lists every card, strongest first (src/hardware.ts strongestFirst, sent in its hello's
// memory as cards.list). An older TOMLIN sent only the first card Windows listed, which on a PC with an old 2 GB card in
// the first slot and a 12 GB NVIDIA card in the second was the old one. It did send how many cards it has and their
// memory together, and whether it has an NVIDIA card (its runner part), so the NVIDIA card's memory is the rest.

export interface CardLine {
  name: string;
  total: number;
}

type Memory = Record<string, unknown> & {
  gpu?: { name?: unknown; total?: unknown; used?: unknown; shared?: unknown } | null;
  cards?: { count?: unknown; total?: unknown; list?: unknown } | null;
};

const isNvidia = (name: string) => /nvidia|geforce|quadro|rtx|gtx|tesla/i.test(name);

/** The NVIDIA card's name as its runner wrote it on its last start ("Device 0: NVIDIA GeForce RTX 3060, ..."), or ''. */
function nvidiaNameOf(runner: { last?: { lines?: string[] } | null } | null | undefined): string {
  for (const line of runner?.last?.lines ?? []) {
    const m = /Device \d+:\s*(NVIDIA [^,]{2,60})/i.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

/** Each card a hello's memory names, strongest first, cleaned (at most 8). */
export function cardList(memory: unknown): CardLine[] {
  const list = (memory as Memory | null)?.cards?.list;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).flatMap(x => {
    const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
    const total = Number(o.total);
    return typeof o.name === 'string' && o.name.trim() && Number.isFinite(total) && total >= 0 ? [{ name: o.name.trim().slice(0, 80), total }] : [];
  });
}

/**
 * A linked PC's memory with its graphics card set right: the card it would use, not the first Windows listed. A PC that
 * lists its cards is believed; an older one with an NVIDIA card (its runner says so) whose card reads as another make,
 * and two or more cards, has the NVIDIA card's memory worked out from the cards' total. Anything else is as it came.
 */
export function cardFix<T>(memory: T, runner: { nvidia?: boolean; last?: { lines?: string[] } | null } | null | undefined): T {
  if (!memory || typeof memory !== 'object') return memory;
  const m = memory as unknown as Memory;
  const gpu = m.gpu && typeof m.gpu === 'object' ? m.gpu : null;
  const list = cardList(m);
  if (list.length) {
    // A new PC: its gpu already is the strongest; the list is what the window shows, cleaned (at most 8 cards, each with
    // a name and a size: a stray entry from another PC stopped the PC window drawing).
    return { ...m, cards: { ...m.cards, list } } as unknown as T;
  }
  const count = Number(m.cards?.count);
  const together = Number(m.cards?.total);
  const gpuTotal = Number(gpu?.total);
  if (!gpu || gpu.shared === true || !runner?.nvidia || isNvidia(String(gpu.name ?? '')) || !(count >= 2) || !Number.isFinite(gpuTotal) || !(together > gpuTotal)) return memory;
  const rest = together - gpuTotal;
  const name = nvidiaNameOf(runner) || 'NVIDIA card';
  // Two cards: the other one is the NVIDIA card. More than two: the NVIDIA ones together (their memory, "and others").
  const nv = { name: count === 2 ? name : `${name} and other cards`, total: rest };
  return {
    ...m,
    gpu: { ...gpu, name: nv.name, total: nv.total, used: 0, shared: false, guessed: true },
    cards: { ...m.cards, list: [nv, { name: String(gpu.name ?? 'Graphics card'), total: gpuTotal }] },
  } as unknown as T;
}
