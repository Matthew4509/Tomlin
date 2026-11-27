// The video models a Videographer can be given: what each is, its files (pinned to one Hugging Face revision and
// checked by SHA-256, as the picture models are in registry/*.json), and how well it fits a PC's graphics card.
// Downloads go through src/registry.ts (a Registry of its own, files in models/video), so they carry on where they
// stopped and are checked the same way. Plain parts: test/videomodels.test.ts.
import type { RegistryFile, RegistryModel } from './registry.ts';
import type { VideoQuality } from './videotypes.ts';

/** How a video model sits on a graphics card: the fits guide in Hire staff, Edit staff and the Models page. */
export type VideoFit = 'Fits' | 'Tight fit' | 'Not enough memory';

export interface VideoModelFile {
  /** diffusion: the video model itself; vae: turns its output into frames; textenc: reads the prompt (waits in RAM). */
  role: 'diffusion' | 'vae' | 'textenc';
  repo: string;
  rev: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface VideoModel {
  id: string;
  name: string;
  about: string;
  licence: string;
  /** The page the files come from. */
  source: string;
  quant: string;
  /** Graphics memory it needs to make a clip, in GB (1024^3): an estimate until phase 1 measures it on the Z820. */
  vramGB: number;
  /** False while `vramGB` is an estimate, not measured. */
  vramMeasured: boolean;
  /** RAM it wants beside the card (the prompt reader waits there), in GB. */
  minRamGB: number;
  /** True when it can start a clip from a picture (image to video: Wan 2.2 TI2V takes `-i` as it is). */
  startPicture: boolean;
  /** True for a model made for 720p: the 1280 by 704 sizes are offered for it (src/clips.ts clipSizesFor). */
  hd?: boolean;
  /**
   * The model's own settings, when they are not Wan 2.1's (src/video.ts WAN and STEPS): frames a second, guidance
   * (CFG), flow shift and the sampling steps of each quality.
   */
  make?: VideoMake;
  files: VideoModelFile[];
}

export interface VideoMake {
  fps: number;
  cfg: number;
  flowShift: number;
  steps: Record<VideoQuality, number>;
}

/** Steps of each quality for Wan 2.1 (and any model without its own). */
export const WAN21_STEPS: Record<VideoQuality, number> = { draft: 12, normal: 20, best: 30 };

/**
 * Wan 2.2 TI2V 5B, from its own published settings: a 720p model (1280 by 704, a high-compression VAE), 121 frames at
 * 24 a second for 5 s, guidance 5, flow shift 5 and 50 steps. Best is those 50; Normal 30 and Draft 20 keep a 5 s shot
 * to a time that can be waited for. With Wan 2.1's settings (guidance 6, shift 3, 20 steps) a chain of shots grew more
 * saturated and softer with each shot.
 */
const WAN22_5B_MAKE: VideoMake = { fps: 24, cfg: 5, flowShift: 5, steps: { draft: 20, normal: 30, best: 50 } };

const GB = 2 ** 30;

/** Wan 2.1 and 2.2 repackaged files (one VAE and the text encoder are shared, so each is kept once on disk). */
const WAN21 = { repo: 'Comfy-Org/Wan-2.1', rev: 'd6258323e18f14c60d37899da97ca555f3118259' };
const WAN22 = { repo: 'Comfy-Org/Wan-2.2', rev: '5df3a4a3ed0628002308022198249dbbbd045d09' };
const WAN22_GGUF = { repo: 'QuantStack/Wan2.2-TI2V-5B-GGUF', rev: '57437632ddd08bdcbd1508c866aa22e126ed51d2' };
const UMT5 = { repo: 'city96/umt5-xxl-encoder-gguf', rev: 'b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7' };

const TEXT_ENCODER: VideoModelFile = { role: 'textenc', ...UMT5, path: 'umt5-xxl-encoder-Q8_0.gguf', bytes: 6043068256, sha256: '2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc' };
const WAN21_VAE: VideoModelFile = { role: 'vae', ...WAN21, path: 'split_files/vae/wan_2.1_vae.safetensors', bytes: 253815318, sha256: '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b' };
const WAN22_VAE: VideoModelFile = { role: 'vae', ...WAN22, path: 'split_files/vae/wan2.2_vae.safetensors', bytes: 1409400960, sha256: 'e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156' };

/**
 * The list, smallest first. File names, sizes and SHA-256 were read from each repository's Hugging Face file list on
 * 25 Nov 2026 at the revision pinned here. The graphics memory needed is an estimate (vramMeasured false) until phase 1
 * has made a clip with each on the Z820's 12 GB card.
 */
export const VIDEO_MODELS: VideoModel[] = [
  {
    id: 'wan21-t2v-1.3b',
    name: 'Wan 2.1 1.3B (text to video, small)',
    about: 'The smallest Wan model: short clips at 480p from a prompt. Runs on a 5 GB card (slowly).',
    licence: 'Apache-2.0',
    source: 'https://huggingface.co/Comfy-Org/Wan-2.1',
    quant: 'fp16',
    // Measured 25 Nov 2026: stable-diffusion.cpp peaked at 4.7 GB on a Quadro P2000 (5 GB) with VAE tiling.
    vramGB: 4.7,
    vramMeasured: true,
    minRamGB: 16,
    // Text to video only: Wan 2.1's picture models also need a CLIP vision file, which is not listed.
    startPicture: false,
    files: [
      { role: 'diffusion', ...WAN21, path: 'split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors', bytes: 2838303560, sha256: 'be531024cd9018cb5b48c40cfbb6a6191645b1c792eb8bf4f8c1c6e10f924dc5' },
      WAN21_VAE,
      TEXT_ENCODER,
    ],
  },
  {
    id: 'wan22-ti2v-5b-q8',
    name: 'Wan 2.2 5B Q8 (text or picture to video)',
    about: 'Wan 2.2\'s 5B model, packed to 8 bits so it fits a 12 GB card. Sharper than the 1.3B; can start from a picture.',
    licence: 'Apache-2.0',
    source: 'https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF',
    quant: 'Q8_0',
    vramGB: 9,
    vramMeasured: false,
    minRamGB: 16,
    startPicture: true,
    hd: true,
    make: WAN22_5B_MAKE,
    files: [
      { role: 'diffusion', ...WAN22_GGUF, path: 'Wan2.2-TI2V-5B-Q8_0.gguf', bytes: 5400179040, sha256: '57bece983817ab2f957546683bb670f13be7d99022d45674840cd999a050ea8f' },
      WAN22_VAE,
      TEXT_ENCODER,
    ],
  },
  {
    id: 'wan22-ti2v-5b',
    name: 'Wan 2.2 5B (text or picture to video, full size)',
    about: 'Wan 2.2\'s 5B model at full size (16 bits): the best of these, and a tight fit on a 12 GB card.',
    licence: 'Apache-2.0',
    source: 'https://huggingface.co/Comfy-Org/Wan-2.2',
    quant: 'fp16',
    vramGB: 12,
    vramMeasured: false,
    minRamGB: 24,
    startPicture: true,
    hd: true,
    make: WAN22_5B_MAKE,
    files: [
      { role: 'diffusion', ...WAN22, path: 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors', bytes: 9999658848, sha256: '456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e' },
      WAN22_VAE,
      TEXT_ENCODER,
    ],
  },
];

/** GB to spare on the card for a clip to count as a plain fit (frames and the runner's own work room). */
export const SPARE_GB = 2;

/**
 * How a model needing `needGB` of graphics memory sits on a card of `cardGB`: Fits with SPARE_GB to spare, Tight fit
 * when it only just fits, else Not enough memory (no card at all is 0). Null when the card is not known.
 */
export function fitFor(cardGB: number | null | undefined, needGB: number): VideoFit | null {
  if (cardGB === null || cardGB === undefined || !Number.isFinite(cardGB)) return null;
  if (cardGB >= needGB + SPARE_GB) return 'Fits';
  // A card reports a little under its label (a "12 GB" card as 11.9 GB): a tenth of a GB is let off.
  if (cardGB >= needGB - 0.1) return 'Tight fit';
  return 'Not enough memory';
}

/** The fits guide for one model on a card, in the words the screens show. */
export function modelFit(m: VideoModel, cardGB: number | null | undefined): VideoFit | null {
  return fitFor(cardGB, m.vramGB);
}

/** The line under a fit ("Needs about 8 GB of graphics memory (estimate); this PC's card has 12 GB"). */
export function fitLine(m: VideoModel, cardGB: number | null | undefined, where = 'this PC'): string {
  const need = `Needs about ${m.vramGB} GB of graphics memory${m.vramMeasured ? '' : ' (estimate)'}`;
  if (cardGB === null || cardGB === undefined) return `${need}; the graphics card of ${where} is not known.`;
  if (cardGB <= 0) return `${need}; ${where} has no graphics card.`;
  return `${need}; the card of ${where} has ${cardGB.toFixed(cardGB % 1 ? 1 : 0)} GB.`;
}

export const videoModel = (id: unknown): VideoModel | undefined => VIDEO_MODELS.find(m => m.id === id);

/** Bytes on disk for all of a model's files. */
export const videoBytes = (m: VideoModel): number => m.files.reduce((n, f) => n + f.bytes, 0);

/** A short name ("Wan 2.1 1.3B") for rows and cards: the name without its bracket. */
export const shortVideoName = (m: VideoModel): string => m.name.replace(/\s*\(.*\)$/, '');

/** The settings the runner is given for the model with this id (none for Wan 2.1 and unknown ones: the Wan defaults). */
export function videoMakeOf(id: unknown): Partial<VideoMake> {
  const m = videoModel(id)?.make;
  return m ? { fps: m.fps, cfg: m.cfg, flowShift: m.flowShift, steps: { ...m.steps } } : {};
}

/** Sampling steps a clip of `quality` takes with the model with this id. */
export const stepsFor = (id: unknown, quality: VideoQuality): number => (videoModel(id)?.make?.steps ?? WAN21_STEPS)[quality] ?? WAN21_STEPS.normal;

/** True when the model with this id is made for 720p (unknown models are not). */
export const isHdModel = (id: unknown): boolean => videoModel(id)?.hd === true;

/** True when the model with this id can start a clip from a picture; unknown models are let through (the runner says). */
export const takesStartPicture = (id: unknown): boolean => videoModel(id)?.startPicture ?? true;

/** Said when a hire's model cannot start from a picture. */
export function wordsOnlyLine(id: unknown): string {
  const m = videoModel(id);
  return `${m ? shortVideoName(m) : String(id || 'This video model')} makes clips from words only: pick Wan 2.2 5B in Edit staff to start from a picture.`;
}

/** The list as Registry models (kind 'video'), so downloads use the checked, resumable path the picture models use. */
export function videoRegistryModels(list: VideoModel[] = VIDEO_MODELS): RegistryModel[] {
  return list.map(m => ({
    id: m.id,
    kind: 'video' as const,
    name: m.name,
    about: m.about,
    licence: m.licence,
    quant: m.quant,
    minRamGB: m.minRamGB,
    minVramGB: m.vramGB,
    files: m.files.map((f): RegistryFile => ({ role: f.role, repo: f.repo, rev: f.rev, path: f.path, bytes: f.bytes, sha256: f.sha256 })),
  }));
}

/** The biggest graphics card's memory in GB (not a built-in chip), as a PC reports its cards; 0 with none. */
export function cardGBOf(gpus: { integrated?: boolean; total?: number | null }[] | null | undefined): number {
  const best = (gpus ?? []).filter(g => !g.integrated && g.total).sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0];
  return best?.total ? Math.round((best.total / GB) * 10) / 10 : 0;
}

/** A Videographer on this PC, as Home shows them: no model, a model not downloaded yet, or ready (it loads for a clip). */
export function videoState(model: string | null | undefined, row: { installed: boolean } | undefined): { state: 'none' | 'asleep'; text: string } {
  if (!model) return { state: 'none', text: 'No video model given' };
  if (!row?.installed) return { state: 'none', text: 'Video model not downloaded on this PC yet' };
  return { state: 'asleep', text: 'Ready: the video model loads when a clip is made' };
}

/** The parts of a Registry that sending a video model to a linked PC uses. */
export interface VideoRegistryLike {
  get: (id: string) => RegistryModel | undefined;
  installed: (m: RegistryModel) => boolean;
  fileName: (f: RegistryFile) => string;
  filePath: (m: RegistryModel, f: RegistryFile) => string;
  ownPath: (m: RegistryModel, f: RegistryFile) => string;
}

/** A video model's files to send to a linked PC: every file, only once all are whole here (null otherwise). */
export function videoSendFiles(reg: VideoRegistryLike, id: string): { name: string; path: string; bytes: number }[] | null {
  const m = reg.get(id);
  if (!m || m.kind !== 'video' || !reg.installed(m)) return null;
  return m.files.map(f => ({ name: reg.fileName(f), path: reg.filePath(m, f), bytes: f.bytes }));
}

/**
 * Where each file of a video model sent here goes (models/video in this PC's own models folder), its size and SHA-256 from
 * this PC's list, and whether it is here whole already (in any models folder); null when this PC does not know the model.
 */
export function videoReceiveDest(reg: VideoRegistryLike, id: string, size: (path: string) => number): { name: string; path: string; bytes: number; have: boolean; sha256: string }[] | null {
  const m = reg.get(id);
  if (!m || m.kind !== 'video') return null;
  return m.files.map(f => ({ name: reg.fileName(f), path: reg.ownPath(m, f), bytes: f.bytes, have: size(reg.filePath(m, f)) === f.bytes, sha256: f.sha256 }));
}
