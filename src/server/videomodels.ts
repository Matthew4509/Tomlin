// The video models on this PC (src/videomodels.ts): the list with the fits guide for this PC's card, for the Models page,
// Hire staff and Edit staff; and their downloads, through a Registry of their own (files in models/video, checked by
// SHA-256 and carried on from where they stopped, as the picture models are).
import { Registry } from '../registry.ts';
import type { VideoModelFiles } from '../video.ts';
import { VIDEO_MODELS, cardGBOf, fitLine, modelFit, shortVideoName, videoMakeOf, videoRegistryModels, type VideoFit } from '../videomodels.ts';
import { type Routes, hardware, json, modelsHome } from './core.ts';
import { images } from './panes.ts';

const registry = new Registry(videoRegistryModels(), modelsHome.dir());

/** The Registry, kept to the same models folder, other copies and drive checks as the picture models' one. */
export function videoRegistry(): Registry {
  registry.dir = images.registry.dir;
  registry.copies = images.registry.copies;
  registry.elsewhere = images.registry.elsewhere;
  registry.noHome = images.registry.noHome;
  return registry;
}

/**
 * A downloaded video model's files for the runner, by role, from where the Models page put them (models/video, or a
 * whole copy in another models folder); null until every file is whole. With the model's own settings (Wan 2.2 TI2V:
 * 24 frames a second, its guidance, flow shift and steps; Wan 2.1 is 16 a second with the runner's defaults).
 */
export async function videoModelFiles(id: string): Promise<VideoModelFiles | null> {
  const reg = videoRegistry();
  const m = reg.get(id);
  const meta = VIDEO_MODELS.find(x => x.id === id);
  if (!m || !meta || !reg.installed(m)) return null;
  const of = (role: string) => m.files.find(f => f.role === role);
  const diffusion = of('diffusion');
  const vae = of('vae');
  const textenc = of('textenc');
  if (!diffusion || !vae || !textenc) return null;
  return { name: shortVideoName(meta), diffusion: reg.filePath(m, diffusion), vae: reg.filePath(m, vae), textEncoder: reg.filePath(m, textenc), fps: 16, ...videoMakeOf(id) };
}

/** This PC's graphics card in GB (the biggest that is not a built-in chip); 0 with none. */
export const cardHere = (): number => cardGBOf(hardware.gpus);

export interface VideoRow {
  id: string;
  name: string;
  short: string;
  about: string;
  licence: string;
  source: string;
  bytes: number;
  installed: boolean;
  missing: number;
  vramGB: number;
  vramMeasured: boolean;
  /** The fits guide on `cardGB` (this PC's card unless asked for another's). */
  fit: VideoFit | null;
  fitLine: string;
  download: ReturnType<Registry['download']> | null;
}

/** Every video model, smallest first, with the fits guide for a card of `cardGB` (this PC's when left out). */
export function videoList(cardGB: number | null = cardHere(), where = 'this PC'): VideoRow[] {
  const r = videoRegistry();
  return VIDEO_MODELS.map(m => {
    const reg = r.get(m.id)!;
    return {
      id: m.id,
      name: m.name,
      short: shortVideoName(m),
      about: m.about,
      licence: m.licence,
      source: m.source,
      bytes: r.bytes(reg),
      installed: r.installed(reg),
      missing: r.missing(reg),
      vramGB: m.vramGB,
      vramMeasured: m.vramMeasured,
      fit: modelFit(m, cardGB),
      fitLine: fitLine(m, cardGB, where),
      download: r.download(m.id) ?? null,
    };
  });
}

export const videoModelsGet: Routes = {
  '/api/videomodels': async ({ res }) => json(res, 200, { card: cardHere(), models: videoList() }),
};

export const videoModelsPost: Routes = {
  // {id}: download a video model's missing files (nothing starts without this press on the Models page).
  '/api/videomodels/start': async ({ res, b }) => {
    try {
      return json(res, 202, await videoRegistry().start(String(b.id ?? '')));
    } catch (error) {
      const room = (error as { room?: unknown }).room;
      return json(res, 400, { error: (error as Error).message, ...(room ? { room } : {}) });
    }
  },
  '/api/videomodels/stop': async ({ res, b }) => {
    videoRegistry().stop(String(b.id ?? ''));
    return json(res, 200, { ok: true });
  },
};
