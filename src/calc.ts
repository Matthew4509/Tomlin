// "What can this PC run?": for a PC (this one, or one typed in), whether each chat and picture model fits, about how
// fast it answers or draws, and how long a typical job takes. Pure: the numbers come from what is passed in.
//
// How the speed is worked out: while a chat model writes, every word reads the model's weights from memory once, so
// words a second is about (memory speed) / (bytes read per word). The memory speeds below were checked against the
// measured figures in Help (public/index.html, "Which model?"), with a small fixed cost per word on top (PER_WORD):
//   laptop i7-6600U, DDR4-2133: Qwen 3.5 0.8B (0.5 GB) 17.7 tokens/s -> 8.9 GB/s; Gemma 2 2B (1.7 GB) 6.4 -> 10.9 GB/s
//   32 GB i5 desktop, CPU only: 35B-A3B (about 1.9 GB read a word) 5.2 -> 9.9 GB/s; Mistral Nemo 12B (7.5 GB) 2.1 -> 15.8 GB/s
// So a CPU is 7-16 GB/s, about 10. A graphics card is far faster (its own memory). "Test this PC" measures the real
// figure, which then replaces the guess for this PC.

export const GB = 2 ** 30;

export interface Hardware {
  /** RAM in bytes. */
  ram: number;
  /** The graphics card's own memory in bytes (0: none, or a chip built into the processor). */
  vram: number;
  /** 'nvidia' and 'amd' cards hold a model in their own memory; 'builtin' and 'none' run chat on the CPU. */
  card: 'none' | 'builtin' | 'nvidia' | 'amd';
  /** Physical CPU cores. */
  cores: number;
  /** The card's memory speed in GB/s when known (a preset names it), else a typical figure for its size. */
  cardSpeed?: number;
}

export interface ChatModel {
  name: string;
  /** File size in bytes (Q4_K_M unless said). */
  bytes: number;
  /** Bytes read for each word: the whole file, or only the active experts of a mixture-of-experts model. */
  readBytes?: number;
  /** True when this PC has it installed. */
  here?: boolean;
  /** A real figure: tokens a second, and where. */
  measured?: { perSecond: number; on: string };
}

/** Chat models people ask about, at Q4_K_M (sizes from their Hugging Face files, rounded). */
export const CHAT_MODELS: ChatModel[] = [
  { name: 'Qwen 3.5 0.8B', bytes: 0.5 * GB, measured: { perSecond: 17.7, on: 'the HD 520 laptop (CPU)' } },
  { name: 'Gemma 3 1B', bytes: 0.8 * GB },
  { name: 'Qwen 3.5 2B', bytes: 1.3 * GB },
  { name: 'Gemma 2 2B', bytes: 1.7 * GB, measured: { perSecond: 6.4, on: 'the HD 520 laptop (CPU)' } },
  { name: 'Llama 3.2 3B', bytes: 2.0 * GB },
  { name: 'Gemma 3 4B', bytes: 2.5 * GB },
  { name: 'Phi-4 mini (3.8B)', bytes: 2.5 * GB },
  { name: 'Qwen 3.5 4B', bytes: 2.7 * GB },
  { name: 'Qwen 3.5 9B', bytes: 5.7 * GB },
  { name: 'Gemma 3 12B', bytes: 7.3 * GB },
  { name: 'Mistral Nemo 12B', bytes: 7.5 * GB, measured: { perSecond: 2.1, on: 'the 32 GB desktop (CPU)' } },
  { name: 'Qwen 3.5 35B-A3B (mixture of experts)', bytes: 22 * GB, readBytes: 1.9 * GB, measured: { perSecond: 5.2, on: 'the 32 GB desktop (CPU)' } },
];

/** Graphics cards to pick from: memory and memory speed (GB/s) from their makers' sheets. */
export const CARDS: { id: string; name: string; card: Hardware['card']; vram: number; speed: number }[] = [
  { id: 'p2000', name: 'NVIDIA Quadro P2000 (5 GB)', card: 'nvidia', vram: 5 * GB, speed: 140 },
  { id: 'gtx1060', name: 'NVIDIA GTX 1060 (6 GB)', card: 'nvidia', vram: 6 * GB, speed: 192 },
  { id: 'rtx3060', name: 'NVIDIA RTX 3060 (12 GB)', card: 'nvidia', vram: 12 * GB, speed: 360 },
  { id: 'rtx4060ti', name: 'NVIDIA RTX 4060 Ti (16 GB)', card: 'nvidia', vram: 16 * GB, speed: 288 },
  { id: 'rtx3090', name: 'NVIDIA RTX 3090 (24 GB)', card: 'nvidia', vram: 24 * GB, speed: 936 },
];

/** CPU memory speed a word really gets (GB/s): a typical figure and the range seen on the two measured PCs. */
export const CPU_SPEED = { mid: 10, low: 7, high: 16 };
/** Share of a card's rated memory speed a chat model gets in practice. */
const CARD_SHARE = 0.7;
/** Fixed work for every word whatever the size (seconds): it is what keeps a tiny model from going 400 words a second. */
const PER_WORD = { card: 0.003, cpu: 0.005 };
/** Windows and other programs keep about this much RAM. */
export const OS_RAM = 3 * GB;
/** Words in a typical blog post, and tokens for them (a token is about three quarters of a word). */
export const POST_WORDS = 600;
const POST_TOKENS = Math.round(POST_WORDS / 0.75);

export type Level = 'ok' | 'tight' | 'no';

export interface ChatRow {
  name: string;
  bytes: number;
  here: boolean;
  level: Level;
  /** Where it runs: on the card, the CPU, or split between them. */
  where: 'card' | 'cpu' | 'split';
  /** Tokens a second: the middle figure and a range. */
  perSecond: { mid: number; low: number; high: number } | null;
  /** Seconds for a 600-word post (middle and range). */
  post: { mid: number; low: number; high: number } | null;
  /** "measured", "from this PC's test" or "estimate". */
  basis: 'measured' | 'tested' | 'estimate';
  measured?: { perSecond: number; on: string };
}

/** Memory a chat model needs loaded with an 8K context: the file, its context (about a fifth of the file, at most
 * 1.5 GB), 10% on top and 0.8 GB for the runner (the fit marks' formula, src/nodes.ts needOf). */
export function chatNeed(bytes: number): number {
  return (bytes + Math.min(bytes * 0.2, 1.5 * GB)) * 1.1 + 0.8 * GB;
}

/** A card's speed when not named: a typical figure for its memory size. */
export function cardSpeedOf(hw: Hardware): number {
  if (hw.cardSpeed) return hw.cardSpeed;
  if (hw.card !== 'nvidia' && hw.card !== 'amd') return 0;
  return hw.vram >= 16 * GB ? 300 : hw.vram >= 8 * GB ? 250 : 150;
}

/** Whether it fits: a card that holds it all, else the card and RAM together; "tight" within 2 GB over. */
export function fitOf(need: number, hw: Hardware): { level: Level; where: ChatRow['where'] } {
  const onCard = hw.card === 'nvidia' || hw.card === 'amd' ? hw.vram : 0;
  if (onCard && need <= onCard) return { level: 'ok', where: 'card' };
  const room = Math.max(0, hw.ram - OS_RAM) + onCard;
  const where = onCard ? 'split' : 'cpu';
  if (need <= room) return { level: 'ok', where };
  if (need <= room + 2 * GB) return { level: 'tight', where };
  return { level: 'no', where };
}

/**
 * The leeway before a model is called too big for a PC: 5% over all its memory (his call, 11 Oct). The need is an
 * estimate and runs high (the 35B-A3B: about 26.7 GB worked out, about 24 GB in Help's note from the 32 GB desktop).
 */
export const FIT_LEEWAY = 1.05;
/**
 * Whether a model needing `need` bytes fits a PC's memory as a whole (not what is free now): its graphics cards' own
 * memory (every card, `vram`) and its RAM together, as llama.cpp spreads a model over the cards and the RAM, with 3 GB
 * of the RAM kept for Windows; "tight" up to 5% over all of it (FIT_LEEWAY); "no" beyond. null when the RAM or the need
 * is not known. Hire staff marks the models on linked PCs with it, and moving someone to a PC refuses a model marked "no".
 */
export function ramFit(need: number, mem: { ram: number; vram: number }): Level | null {
  if (!mem.ram || !need) return null;
  return need <= mem.vram + Math.max(0, mem.ram - OS_RAM) ? 'ok' : need <= (mem.vram + mem.ram) * FIT_LEEWAY ? 'tight' : 'no';
}

/** RAM this full (in use / total) or more: the PC's card in the left panel shows a yellow (!) (public/home.js). */
export const RAM_FULL = 0.95;
export const ramNearlyFull = (used: number, total: number) => total > 0 && used / total >= RAM_FULL;

/** Why a move was refused: the model, what it needs, what that PC has, and what to do instead. */
export function moveWontFit(model: string, need: number, pcWord: string, mem: { ram: number; vram: number }): string {
  const gb = (n: number) => `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
  const card = mem.vram ? ` and ${gb(mem.vram)} of graphics-card memory` : '';
  return `Not moved: ${model} needs about ${gb(need)} of memory, and ${pcWord} has ${gb(mem.ram)} of RAM${card} (3 GB of it is kept for Windows). Pick a smaller model for them there, or move them to a PC with more memory.`;
}

/** Tokens a second for `read` bytes a word. `tested` is this PC's measured CPU speed (GB/s), when there is one. */
export function speedOf(read: number, need: number, hw: Hardware, where: ChatRow['where'], tested?: number): { mid: number; low: number; high: number } {
  const g = read / GB;
  const cpu = tested ? { mid: tested, low: tested * 0.85, high: tested * 1.15 } : CPU_SPEED;
  const card = cardSpeedOf(hw) * CARD_SHARE;
  const tps = (bw: number, fixed: number) => 1 / (g / bw + fixed);
  if (where === 'card') return { mid: tps(card, PER_WORD.card), low: tps(card * 0.7, PER_WORD.card), high: tps(card * 1.2, PER_WORD.card) };
  if (where === 'cpu') return { mid: tps(cpu.mid, PER_WORD.cpu), low: tps(cpu.low, PER_WORD.cpu), high: tps(cpu.high, PER_WORD.cpu) };
  // Split: the part on the card is quick, the rest goes at the CPU's speed; the slow part decides.
  const share = Math.min(1, hw.vram / need);
  const t = (c: number) => (share * g) / card + ((1 - share) * g) / c + PER_WORD.cpu;
  return { mid: 1 / t(cpu.mid), low: 1 / t(cpu.low), high: 1 / t(cpu.high) };
}

const round = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

/** One row per chat model. `tested` (GB/s) comes from "Test this PC" and is used only when `hw` is this PC. */
export function chatRows(models: ChatModel[], hw: Hardware, tested?: number): ChatRow[] {
  return models.map(m => {
    const need = chatNeed(m.bytes);
    const f = fitOf(need, hw);
    const read = m.readBytes ?? m.bytes;
    const s = f.level === 'no' ? null : speedOf(read, need, hw, f.where, f.where === 'card' ? undefined : tested);
    const perSecond = s ? { mid: round(s.mid), low: round(s.low), high: round(s.high) } : null;
    const post = s ? { mid: Math.round(POST_TOKENS / s.mid), low: Math.round(POST_TOKENS / s.high), high: Math.round(POST_TOKENS / s.low) } : null;
    return { name: m.name, bytes: m.bytes, here: !!m.here, level: f.level, where: f.where, perSecond, post, basis: tested && f.where !== 'card' ? 'tested' : 'estimate', measured: m.measured };
  });
}

export interface PictureRow {
  name: string;
  level: Level;
  where: 'card' | 'builtin' | 'cpu';
  /** Seconds for one 512 px picture in 4 steps (middle and range). */
  seconds: { mid: number; low: number; high: number } | null;
  basis: 'measured' | 'estimate';
  note: string;
}

/**
 * A fast SD 1.5 picture model (512 px, 4 steps), the kind TOMLIN ships. Measured on the HD 520 laptop: 42.6 s
 * a step on its 2 CPU cores (about 3 min a picture), about 50 s a picture on its built-in chip. A step's work is
 * shared by the cores, and an NVIDIA or AMD card does it in about a second.
 */
export function pictureRow(hw: Hardware, measured?: { seconds: number; on: string }): PictureRow {
  const name = 'SD 1.5 fast picture (512 px, 4 steps)';
  const need = 2.6 * GB;
  const onCard = (hw.card === 'nvidia' || hw.card === 'amd') && hw.vram >= 4 * GB;
  const level: Level = onCard || need <= hw.ram - OS_RAM ? 'ok' : need <= hw.ram - OS_RAM + 2 * GB ? 'tight' : 'no';
  if (level === 'no') return { name, level, where: 'cpu', seconds: null, basis: 'estimate', note: 'Needs about 2.6 GB free.' };
  if (measured) return { name, level, where: onCard ? 'card' : hw.card === 'builtin' ? 'builtin' : 'cpu', seconds: { mid: measured.seconds, low: measured.seconds, high: measured.seconds }, basis: 'measured', note: `Measured on ${measured.on}.` };
  if (onCard) return { name, level, where: 'card', seconds: { mid: 8, low: 4, high: 15 }, basis: 'estimate', note: 'On the graphics card.' };
  if (hw.card === 'builtin') return { name, level, where: 'builtin', seconds: { mid: 55, low: 45, high: 90 }, basis: 'estimate', note: 'On the built-in graphics chip (an Intel HD 520 took about 50 s).' };
  const perStep = (42.6 * 2) / Math.max(1, hw.cores);
  return { name, level, where: 'cpu', seconds: { mid: Math.round(perStep * 4), low: Math.round(perStep * 4 * 0.75), high: Math.round(perStep * 4 * 1.4) }, basis: 'estimate', note: 'On the CPU (2 laptop cores took about 3 min).' };
}

/** "45 s", "3 min", "1 h 20 min". */
export function timeText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The CPU memory speed (GB/s) a test showed: the bytes read a word over the time a word took, less the fixed work. */
export function testedSpeed(perSecond: number, bytes: number): number {
  const t = Math.max(1 / perSecond - PER_WORD.cpu, 1e-4);
  return Math.round((bytes / GB / t) * 10) / 10;
}
