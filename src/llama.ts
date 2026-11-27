// The chat runner: llama.cpp's own server (llama-server), one model per process, started by Connect and ended by
// Disconnect (src/pane.ts). It listens on 127.0.0.1 only, on a free port, and is never reached from outside this PC.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNER_FILE_HELP, RUNNER_FILE_LINE, VCRT_HELP, vcrtFault } from './vcrt.ts';
import { idsFor } from './devices.ts';
import { timeUpWords } from './loadlimit.ts';

/** llama-server could not read the chat template inside the model file. */
export const TEMPLATE_FAULT = /FilterExpression|chat template is not supported|failed to apply template|Unable to generate parser|unknown test|unknown filter/i;

/**
 * The runner would not open the model's vision add-on (an mmproj made for another model, or one this build cannot read).
 * llama-server says "failed to load multimodal model" when its vision part (mtmd, clip) fails to start: the model is then
 * started again without it (src/server/panes.ts), so a bad add-on never stops the model itself from loading.
 */
export const VISION_FAULT = /failed to load multimodal model|mtmd_init_from_file: (?:error|fail)|clip_init: failed|unknown projector type/i;

/** The runner's last lines say a PC lending its card (Max mode's RPC) went away. */
export const maxFault = (tail: string) => /\brpc\b|ggml_backend_rpc|failed to connect to/i.test(tail);
/** A loaded model stopped because a PC lending its card for it took it back. */
export const MAX_STOPPED = 'The model stopped: a PC lending its card for Max mode took it back (someone started using that PC, or it left the network). Press Connect to load it again on the PCs that lend now.';

/**
 * The runner does not know how the file's numbers are packed (its quant type). llama.cpp b11284 says, for a type id it
 * has no entry for: "tensor 'x' has invalid ggml type 45. should be in [0, 43)", then "failed to read tensor info"
 * (checked 20 Nov 2026 with a made-up file). A type it lists but no longer runs (Q4_0_4_4 and the like) has a block size
 * of 0: "not a multiple of block size". A quant made by another llama.cpp fork (TQ3_0) is one of these, not a damaged file.
 */
export const UNKNOWN_TYPE = /invalid ggml type|not a multiple of block size|type \S+ is no longer supported|unknown (tensor|ggml) type/i;
const UNKNOWN_ARCH = /unknown (model )?architecture|unsupported model|unknown pre-tokenizer/i;
/**
 * The model file is not there (its drive unplugged, or the file moved or deleted between the list and the start).
 * llama.cpp b11284 says "gguf_init_from_file: failed to open GGUF file '<path>' (No such file or directory)" (checked
 * 21 Nov 2026 with the shipped CPU runner): no other runner would find it either.
 */
const MISSING = /failed to open GGUF file/i;
const DAMAGED = /invalid magic|failed to read|unexpectedly reached end of file|corrupt|not within the file bounds/i;

/** The quant type a file's name ends with ("Model-TQ3_0.gguf" -> "TQ3_0"), or ''. */
export function quantOfName(name: string): string {
  const m = /[-_.]((?:UD-)?(?:I?Q\d\w*|TQ\d\w*|F16|BF16|F32|MXFP4\w*))(?:\.gguf)?$/i.exec(name.split(/[\\/]/).pop() ?? '');
  return m ? m[1] : '';
}

/**
 * A fault of the file itself (not there, its kind, its packing, its bytes, or the chat format written inside it): no
 * other runner on this PC would read it either, so a start on CUDA that ends with one is not tried again on Vulkan and
 * then the CPU (src/pane.ts). A chat format fault is one only after the start with llama.cpp's plain formats failed the
 * same way (the pane's second try on that device): the format is read the same on every device.
 */
export function fileFault(tail: string): boolean {
  return !vcrtFault(tail) && !timeUpWords(tail) && !tail.includes(RUNNER_FILE_LINE) && (MISSING.test(tail) || UNKNOWN_TYPE.test(tail) || UNKNOWN_ARCH.test(tail) || DAMAGED.test(tail) || TEMPLATE_FAULT.test(tail));
}

/** Why a model would not load, in plain words (what went wrong, why, what to do), from llama-server's last lines. */
export function whyItFailed(tail: string, file = ''): string {
  if (vcrtFault(tail)) return VCRT_HELP;
  const late = timeUpWords(tail);
  if (late) return late;
  if (tail.includes(RUNNER_FILE_LINE)) return RUNNER_FILE_HELP;
  const t = tail.toLowerCase();
  if (MISSING.test(tail)) return "This model did not load: its file (or its guessing model's file) is not there any more. The drive it is on may have been unplugged, or the file moved or deleted. Plug the drive in again (or put the file back), then load it again.";
  // Before the damaged-file test: an unknown type ends with "failed to read tensor info", and the file is whole.
  if (UNKNOWN_TYPE.test(tail)) {
    const quant = quantOfName(file);
    const typeNo = /invalid ggml type (\d+)/i.exec(tail)?.[1];
    return `This model did not load: TOMLIN's model runner (llama.cpp b11284) cannot read the way this file is packed${quant ? ` (${quant})` : typeNo ? ` (type ${typeNo})` : ''}. The file is not damaged: it was made with a newer or different version of llama.cpp than TOMLIN runs, so downloading it again will not help. Pick another copy of this model (a Q2_K, Q3_K, Q4_K or IQ quant), or another model.`;
  }
  if (UNKNOWN_ARCH.test(t)) {
    return 'This model did not load: it is a kind of model newer than TOMLIN\'s chat runner (llama.cpp b11284) can read. Pick another model; this one needs a newer runner.';
  }
  if (TEMPLATE_FAULT.test(t)) {
    return 'This model did not load: the chat format written inside the model file is one the model runner cannot read, and its plain formats did not work for it either. Pick another model, or another copy of this one.';
  }
  if (DAMAGED.test(t)) {
    return 'This model did not load: the file is incomplete or damaged (often a download that stopped part-way). Download it again, or pick another model.';
  }
  if (maxFault(tail)) return 'This model did not load: a PC lending its card for Max mode stopped answering while it loaded (someone started using it, or it left the network). Load it again: it then uses the PCs that lend now.';
  if (/doesn't contain mtp layers|failed to create mtp context/.test(t)) {
    return 'This model did not load: it was set to use its built-in guesser (MTP), but this file has none. Set Guessing model to None (or a smaller model) in its gear, beside Connect, then load it again.';
  }
  if (/failed to allocate|unable to allocate|out of memory|not enough memory|bad_alloc/.test(t)) {
    return 'This model did not load: this PC ran out of free memory (RAM) for it. Close other programs (LM Studio too, if it has a model open; or drop the picture model with Drop in the top bar), or pick a smaller model.';
  }
  return 'This model did not load: the model runner stopped while opening it. Try once more; if it fails again, pick another model. The runner\'s own words are under "What does this mean?".';
}

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

/** Where llama-server is: runtime/, or a folder inside it (the release zip unpacks with or without one). */
export function findServer(runtimeDir: string): string | null {
  const direct = join(runtimeDir, EXE);
  if (existsSync(direct)) return direct;
  if (!existsSync(runtimeDir)) return null;
  for (const d of readdirSync(runtimeDir)) {
    const p = join(runtimeDir, d, EXE);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * The .gguf files in `modelsDir` and its folders (LM Studio keeps them as publisher/model/file.gguf), as paths relative
 * to it with forward slashes, smallest first. A model split into parts (name-00001-of-00003.gguf) is listed once, by
 * its first part, with the size of all parts; llama.cpp finds the rest itself. Vision add-ons (mmproj) are left out.
 */
/**
 * A split model's part from its file name ("Big-Q4_K_M-00002-of-00004.gguf"): the name before the numbers, which part
 * and of how many; null for a file in one piece.
 */
export function splitPart(fileName: string): { base: string; part: number; of: number } | null {
  const m = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(fileName);
  return m && Number(m[2]) >= 1 && Number(m[3]) >= 1 ? { base: m[1], part: Number(m[2]), of: Number(m[3]) } : null;
}

/** A chat model's name as lists show it: the file's name without ".gguf", and a split model's without "-00001-of-00004". */
export function plainModelName(file: string): string {
  return file.split(/[\\/]/).pop()!.replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/i, '');
}

/**
 * The chat models in a folder (and its folders, 3 deep). A model split into parts is one entry: its first part's file
 * (the one llama.cpp is given), the size of all its parts, `parts` (how many it should have) and `missing` (the parts not
 * there). A model with a part missing is still listed, so it can be seen and deleted, but it cannot be loaded.
 */
export function listModels(modelsDir: string): Array<{ file: string; bytes: number; parts?: number; missing?: number[] }> {
  const found: Array<{ file: string; bytes: number; parts?: number; missing?: number[] }> = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    // Each split model in this folder, by its name and part count: the parts there, their size together, its first part.
    const groups = new Map<string, { of: number; have: Set<number>; bytes: number; first: { part: number; name: string } }>();
    for (const n of names) {
      const full = join(dir, n);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 3 && !n.startsWith('.')) walk(full, rel ? `${rel}/${n}` : n, depth + 1);
        continue;
      }
      if (!/\.gguf$/i.test(n) || /mmproj/i.test(n)) continue;
      const split = splitPart(n);
      if (split) {
        const key = `${split.base.toLowerCase()}|${split.of}`;
        const g = groups.get(key) ?? { of: split.of, have: new Set<number>(), bytes: 0, first: { part: split.part, name: n } };
        if (!g.have.has(split.part)) g.bytes += st.size;
        g.have.add(split.part);
        if (split.part < g.first.part) g.first = { part: split.part, name: n };
        groups.set(key, g);
        continue;
      }
      found.push({ file: rel ? `${rel}/${n}` : n, bytes: st.size });
    }
    // A split model: one entry, the size of all its parts; the parts not there are named (it cannot be loaded).
    for (const g of groups.values()) {
      const missing = Array.from({ length: g.of }, (_, i) => i + 1).filter(p => !g.have.has(p));
      found.push({ file: rel ? `${rel}/${g.first.name}` : g.first.name, bytes: g.bytes, parts: g.of, ...(missing.length ? { missing } : {}) });
    }
  };
  walk(modelsDir, '', 0);
  return found.sort((a, b) => a.bytes - b.bytes);
}

/** A model's full path, only when `file` is one listModels found (so a name can never reach outside the folder). */
export function modelPath(modelsDir: string, file: string): string | null {
  return listModels(modelsDir).some(m => m.file === file) ? join(modelsDir, ...file.split('/')) : null;
}


export interface ChatRun {
  /** Context in tokens (8192 unless the person chose otherwise for this model). */
  ctx: number;
  /** Cache type: f16, or q8_0 / q4_0 to fit a longer context in less memory (needs flash attention, so it is turned on). */
  cache: 'f16' | 'q8_0' | 'q4_0';
  /**
   * The context cache in RAM, not on the card (--no-kv-offload). At a 262,144 context Qwen3.8's cache took 6.0 GB of
   * the Z820's 3060 (0.8 GB at 32k), so about 5 GB of weights went to the processors and it wrote 3 times slower.
   */
  kvRam?: boolean;
  /**
   * Where the weights go on a graphics device (PLAN F8). 'auto': on a PC with a card of its own, llama.cpp's own fit
   * (on by default; it changes only what is not set) fills the card or cards from their real free memory and puts the
   * rest in RAM, the experts first on a mixture-of-experts model. 'card': every layer on the chip. 'ram': every expert
   * in RAM and the rest on the card (a big mixture-of-experts model on a small card).
   */
  place: 'auto' | 'card' | 'ram' | 'layers';
  /**
   * A guessing model's file (speculative drafts): a small model of the same family guesses the next few words and the
   * big one checks them in one pass. The answer is the big model's own; only the speed changes. On a card it sits on the
   * card with the big one (unless draftOn is 'ram'); on the CPU in RAM.
   */
  draft?: string;
  /** The speed setups (src/speedfinder.ts; RunOptions in src/store.ts says what each one is). */
  moeCpu?: number;
  fitMargin?: number;
  fa?: 'on' | 'off';
  threads?: number;
  spec?: 'ngram' | 'mtp';
  draftOn?: 'ram';
  draftCache?: 'q8_0';
  draftMax?: number;
  /**
   * A mixture-of-experts model (read from its header). On a graphics card it reads prompts in chunks of 2048 tokens,
   * not llama.cpp's 512: with the experts in RAM, each chunk carries the experts to the card once, so bigger chunks read
   * a long prompt several times faster.
   */
  moe?: boolean;
  /** The runner build has llama.cpp's MMQ expert-matrix padding fault (runtimes.json `mmqIdsFault`): no 2048-token chunks, whatever the model. */
  smallBatch?: boolean;
  /**
   * Max mode: linked PCs' cards (or RAM) as more devices, each an address on 127.0.0.1 that is a sealed stream to that
   * PC (src/jobrun/maxhost.ts). llama.cpp's own fit then places the layers over them and this PC.
   */
  rpc?: string[];
  /**
   * Max mode "all" with a mixture-of-experts model (src/maxplace.ts): the layers dealt out by the RAM each PC may lend,
   * the experts in that PC's RAM and the rest on its card. `device`: the runner it was worked out for (device names
   * differ per runner). Set with `rpc`, which then holds only the lenders in use.
   */
  maxPlace?: { device: 'cuda' | 'vulkan' | 'cpu'; dev: string[]; split: number[]; override: string[]; /** The layers off this PC's processor (src/layersplit.ts); unset: all. */ ngl?: number };
  /** Expert parallel (src/jobrun/epload.ts): the patched runner's environment (LLAMA_EXPERT_SPLIT and the rest). */
  env?: Record<string, string>;
  /** Expert parallel: the batch buffers (-b and -ub), small so the card's compute buffer stays small. Unset: the runner's own. */
  batch?: number;
  /** Answers it writes together (src/slots.ts "At once"): more than 1 starts it with that many slots, each with the whole context. Unset or 1: as before. */
  slots?: number;
  /** The runner gives each slot a context of its own (--no-kv-unified). */
  slotSplit?: boolean;
  /** The cards it runs on and its guessing model's card (src/devices.ts names; unset: every card, as llama.cpp picks). */
  cards?: string[];
  draftCard?: string[];
  /**
   * The model's vision add-on (an mmproj file beside it, src/capabilities.ts visionPathFor): started with it, the model
   * can look at a picture sent with a message. Unset: no add-on, or it would not start with it (VISION_FAULT).
   */
  mmproj?: string;
}

/** The most RAM, in MB, the chat runner keeps for the readings of earlier prompts (llama.cpp's own default is 8192). */
export const PROMPT_CACHE_MB = 2048;

/** How llama-server is started for chat on `device`. `plainTemplates`: llama.cpp's own chat formats, for a model
 * whose template it cannot read (Mistral Nemo's). `card`: the device is a graphics card with memory of its own (a chip
 * built into the processor shares the RAM, so Auto keeps every layer on it there, as measured before). `key`: it then
 * answers only requests that carry it (src/runnerkeys.ts), and its slots page (what each slot is working on) is off. */
export function chatArgs(model: string, port: number, device: 'cpu' | 'vulkan' | 'cuda', threads: number, plainTemplates = false, run: ChatRun = { ctx: 8192, cache: 'f16', place: 'auto' }, card = false, key = ''): string[] {
  // Auto on a card: no layer count, so llama.cpp fits it; otherwise every layer goes to the chip (none on the CPU).
  // With Max mode, its fit places the layers on every device, the lent ones too (the CPU runner included).
  const placed = !!run.rpc?.length && !!run.maxPlace && run.maxPlace.device === device;
  const fits = !placed && ((device !== 'cpu' && run.place === 'auto' && card) || !!run.rpc?.length);
  // Log level 4: only then does the runner write which devices it found and used ("using device CUDA0", "offloaded
  // N/M layers"), which tell a card start from one that quietly went to the CPU. No chat text is written at that level.
  // At once (src/slots.ts): N slots, each keeping the whole context, so N times the context in all. 1: as before.
  const slots = run.slots && run.slots > 1 ? run.slots : 1;
  // --cache-ram: llama.cpp keeps the reading of each finished prompt in RAM so another chat can pick up where it left
  // off. Left to itself it keeps up to 8 GB, which nothing in the memory check counts: over a long session the runner
  // grew by gigabytes on top of the model. PROMPT_CACHE_MB caps it.
  const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', String(run.ctx * slots), '--no-webui', '--cache-ram', String(PROMPT_CACHE_MB), '-lv', '4', ...(fits ? [] : ['-ngl', placed && run.maxPlace!.ngl !== undefined ? String(run.maxPlace!.ngl) : device === 'cpu' ? '0' : '999'])];
  // llama.cpp's own fit keeps 1024 MB free on each card unless told a smaller margin.
  if (fits && run.fitMargin) args.push('-fitt', String(run.fitMargin));
  if (run.cache !== 'f16') args.push('-fa', 'on', '-ctk', run.cache, '-ctv', run.cache);
  else if (run.fa && device !== 'cpu') args.push('-fa', run.fa);
  if (run.kvRam && device !== 'cpu') args.push('--no-kv-offload');
  if (!placed && run.place === 'ram' && device !== 'cpu') args.push('--cpu-moe');
  if (!placed && run.place === 'layers' && run.moeCpu && device !== 'cpu') args.push('--n-cpu-moe', String(run.moeCpu));
  const t = run.threads && run.threads > 0 ? run.threads : threads;
  if (run.batch && run.batch > 0) args.push('-b', String(run.batch), '-ub', String(run.batch));
  else if (run.moe && !run.smallBatch && device !== 'cpu') args.push('-ub', '2048');
  if (t > 0) args.push('-t', String(t));
  if (plainTemplates) args.push('--no-jinja');
  if (key) args.push('--api-key', key, '--no-slots');
  // With lenders, the weights are read into memory, not mapped from the file: a model bigger than this PC's RAM, mapped,
  // lets Windows drop this PC's own layers and read them from disk again for every word. DeepSeek-V4-Flash (90 GiB)
  // over three PCs ran at 1.31 tok/s read in, against 0.25 mapped (docs/cluster-native/deepseek3-2026-11-14.txt).
  if (run.rpc?.length) args.push('--rpc', run.rpc.join(','), '-lm', 'none');
  // Card choice: only these cards (with Max mode's lent ones, RPC0, RPC1… in --rpc order, which must be named too).
  const mine = placed ? [] : idsFor(device, run.cards);
  if (placed) args.push('-dev', run.maxPlace!.dev.join(','), '-ts', run.maxPlace!.split.join(','), ...(run.maxPlace!.override.length ? ['-ot', run.maxPlace!.override.join(',')] : []));
  else if (mine.length) args.push('-dev', [...mine, ...(run.rpc ?? []).map((_, i) => `RPC${i}`)].join(','));
  if (run.draft) {
    args.push('--spec-type', 'draft-simple', '-md', run.draft, '-ngld', device === 'cpu' || run.draftOn === 'ram' ? '0' : '999');
    const its = run.draftOn === 'ram' ? [] : idsFor(device, run.draftCard);
    if (its.length) args.push('-devd', its[0]);
    if (run.cache !== 'f16') args.push('-ctkd', run.cache, '-ctvd', run.cache);
    else if (run.draftCache) args.push('-ctkd', run.draftCache, '-ctvd', run.draftCache);
  } else if (run.spec === 'ngram') args.push('--spec-type', 'ngram-mod');
  else if (run.spec === 'mtp') args.push('--spec-type', 'draft-mtp');
  if ((run.draft || run.spec === 'mtp') && run.draftMax) args.push('--spec-draft-n-max', String(run.draftMax));
  if (slots > 1) args.push('-np', String(slots), ...(run.slotSplit ? ['--no-kv-unified'] : []));
  if (run.mmproj) args.push('--mmproj', run.mmproj);
  return args;
}
