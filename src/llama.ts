// The chat runner: llama.cpp's own server (llama-server), one model per process, started by Connect and ended by
// Disconnect (src/pane.ts). It listens on 127.0.0.1 only, on a free port, and is never reached from outside this PC.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RUNNER_FILE_HELP, RUNNER_FILE_LINE, VCRT_HELP, vcrtFault } from './vcrt.ts';
import { idsFor } from './devices.ts';

/** llama-server could not read the chat template inside the model file. */
export const TEMPLATE_FAULT = /FilterExpression|chat template is not supported|failed to apply template|Unable to generate parser|unknown test|unknown filter/i;

/** The runner's last lines say a PC lending its card (Max mode's RPC) went away. */
export const maxFault = (tail: string) => /\brpc\b|ggml_backend_rpc|failed to connect to/i.test(tail);
/** A loaded model stopped because a PC lending its card for it took it back. */
export const MAX_STOPPED = 'The model stopped: a PC lending its card for Max mode took it back (someone started using that PC, or it left the network). Press Connect to load it again on the PCs that lend now.';

/** Why a model would not load, in plain words (what went wrong, why, what to do), from llama-server's last lines. */
export function whyItFailed(tail: string): string {
  if (vcrtFault(tail)) return VCRT_HELP;
  if (tail.includes(RUNNER_FILE_LINE)) return RUNNER_FILE_HELP;
  const t = tail.toLowerCase();
  if (/unknown (model )?architecture|unsupported model|unknown pre-tokenizer/.test(t)) {
    return 'This model did not load: it is a kind of model newer than TOMLIN\'s chat runner (llama.cpp b11284) can read. Pick another model; this one needs a newer runner.';
  }
  if (TEMPLATE_FAULT.test(t)) {
    return 'This model did not load: the chat format written inside the model file is one the model runner cannot read, and its plain formats did not work for it either. Pick another model, or another copy of this one.';
  }
  if (/invalid magic|failed to read|unexpectedly reached end of file|corrupt|not within the file bounds/.test(t)) {
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
export function listModels(modelsDir: string): Array<{ file: string; bytes: number }> {
  const found: Array<{ file: string; bytes: number }> = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const parts = new Map<string, number>();
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
      const split = /^(.*)-(\d{5})-of-\d{5}\.gguf$/i.exec(n);
      if (split) {
        parts.set(split[1], (parts.get(split[1]) ?? 0) + st.size);
        if (split[2] !== '00001') continue;
      }
      found.push({ file: rel ? `${rel}/${n}` : n, bytes: st.size });
    }
    // A split model's size is the size of all its parts.
    for (const f of found) {
      const split = /^(.*)-00001-of-\d{5}\.gguf$/i.exec(f.file.split('/').pop()!);
      if (split && parts.has(split[1]) && dirname(f.file) === (rel || '.')) f.bytes = parts.get(split[1])!;
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
  /**
   * Max mode: linked PCs' cards (or RAM) as more devices, each an address on 127.0.0.1 that is a sealed stream to that
   * PC (src/jobrun/maxhost.ts). llama.cpp's own fit then places the layers over them and this PC.
   */
  rpc?: string[];
  /** The cards it runs on and its guessing model's card (src/devices.ts names; unset: every card, as llama.cpp picks). */
  cards?: string[];
  draftCard?: string[];
}

/** How llama-server is started for chat on `device`. `plainTemplates`: llama.cpp's own chat formats, for a model
 * whose template it cannot read (Mistral Nemo's). `card`: the device is a graphics card with memory of its own (a chip
 * built into the processor shares the RAM, so Auto keeps every layer on it there, as measured before). `key`: it then
 * answers only requests that carry it (src/runnerkeys.ts), and its slots page (what each slot is working on) is off. */
export function chatArgs(model: string, port: number, device: 'cpu' | 'vulkan' | 'cuda', threads: number, plainTemplates = false, run: ChatRun = { ctx: 8192, cache: 'f16', place: 'auto' }, card = false, key = ''): string[] {
  // Auto on a card: no layer count, so llama.cpp fits it; otherwise every layer goes to the chip (none on the CPU).
  // With Max mode, its fit places the layers on every device, the lent ones too (the CPU runner included).
  const fits = (device !== 'cpu' && run.place === 'auto' && card) || !!run.rpc?.length;
  // Log level 4: only then does the runner write which devices it found and used ("using device CUDA0", "offloaded
  // N/M layers"), which tell a card start from one that quietly went to the CPU. No chat text is written at that level.
  const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', String(run.ctx), '--no-webui', '-lv', '4', ...(fits ? [] : ['-ngl', device === 'cpu' ? '0' : '999'])];
  // llama.cpp's own fit keeps 1024 MB free on each card unless told a smaller margin.
  if (fits && run.fitMargin) args.push('-fitt', String(run.fitMargin));
  if (run.cache !== 'f16') args.push('-fa', 'on', '-ctk', run.cache, '-ctv', run.cache);
  else if (run.fa && device !== 'cpu') args.push('-fa', run.fa);
  if (run.place === 'ram' && device !== 'cpu') args.push('--cpu-moe');
  if (run.place === 'layers' && run.moeCpu && device !== 'cpu') args.push('--n-cpu-moe', String(run.moeCpu));
  const t = run.threads && run.threads > 0 ? run.threads : threads;
  if (run.moe && device !== 'cpu') args.push('-ub', '2048');
  if (t > 0) args.push('-t', String(t));
  if (plainTemplates) args.push('--no-jinja');
  if (key) args.push('--api-key', key, '--no-slots');
  if (run.rpc?.length) args.push('--rpc', run.rpc.join(','));
  // Card choice: only these cards (with Max mode's lent ones, RPC0, RPC1… in --rpc order, which must be named too).
  const mine = idsFor(device, run.cards);
  if (mine.length) args.push('-dev', [...mine, ...(run.rpc ?? []).map((_, i) => `RPC${i}`)].join(','));
  if (run.draft) {
    args.push('--spec-type', 'draft-simple', '-md', run.draft, '-ngld', device === 'cpu' || run.draftOn === 'ram' ? '0' : '999');
    const its = run.draftOn === 'ram' ? [] : idsFor(device, run.draftCard);
    if (its.length) args.push('-devd', its[0]);
    if (run.cache !== 'f16') args.push('-ctkd', run.cache, '-ctvd', run.cache);
    else if (run.draftCache) args.push('-ctkd', run.draftCache, '-ctvd', run.draftCache);
  } else if (run.spec === 'ngram') args.push('--spec-type', 'ngram-mod');
  else if (run.spec === 'mtp') args.push('--spec-type', 'draft-mtp');
  if ((run.draft || run.spec === 'mtp') && run.draftMax) args.push('--spec-draft-n-max', String(run.draftMax));
  return args;
}
