// Style samples (src/styles.ts): one picture per style for each picture model, kept in data/stylesamples/<model id>/
// as <style id>.png (or .webp) with <style id>.json, the record of how it was drawn. A sample is kept only from a
// picture the queue drew for it (src/server/queue.ts runPicture), with the facts that picture gives; nothing here is
// typed or guessed. The Images window's Style picker, Character sets and Hire staff read them.
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as brains from '../brains.ts';
import { writeAtomic } from '../atomic.ts';
import type { Picture } from '../gallery.ts';
import { drawsPictures } from '../staff.ts';
import { cleanRecord, formValue, honestLine, isModelKey, pickedStyle, SAMPLE_PROMPT, SAMPLE_QUALITY, SAMPLE_SEED, sampleRecord, STYLES, type SampleRecord } from '../styles.ts';
import { qualitySide } from '../quality.ts';
import { HOME, type Routes, SECURITY_HEADERS, json, shortName, staff, store } from './core.ts';
import { images } from './panes.ts';
import { jobRoutes } from './jobs.ts';
import type { Drawn } from './pictures.ts';
import { seenNow, styleFits } from './pairing.ts';

const DIR = join(HOME.data, 'stylesamples');

/** A hire's picture model: its id in TOMLIN's list (null when their PC draws with whatever it has loaded), and where. */
function modelOf(m: Parameters<typeof brains.refsOf>[0]): { model: string | null; pc: string } {
  const ref = brains.refsOf(m)[0];
  const b = ref ? brains.parseRef(ref) : { kind: 'none' as const };
  if (b.kind === 'here') return { model: b.id, pc: '' };
  if (b.kind === 'remote') return { model: b.model ?? null, pc: b.pc };
  return { model: null, pc: '' };
}

/** The side a hire's model draws Mid at, from TOMLIN's list (a linked PC's model has the same id there): 512 when not known. */
export function sampleSide(m: Parameters<typeof brains.refsOf>[0]): number {
  const id = modelOf(m).model;
  const r = id ? images.registry.get(id) : undefined;
  return r ? qualitySide(r, SAMPLE_QUALITY) : 512;
}

/** Keeps a drawn picture as `styleId`'s sample for the model that drew it. The record comes from the picture (sampleRecord). */
export async function keepSample(styleId: string, pic: Picture, drawn: Drawn): Promise<{ record: SampleRecord; styleName: string } | { error: string }> {
  const r = sampleRecord(styleId, pic, drawn);
  if ('error' in r) return r;
  const data = await readFile(join(images.gallery.dir, pic.output)).catch(() => null);
  if (!data) return { error: 'its file is not in the gallery any more.' };
  const dir = join(DIR, r.model);
  await mkdir(dir, { recursive: true });
  // The other kind of file from a sample drawn before goes, so one style has one picture.
  const other = r.file.endsWith('.png') ? `${r.style}.webp` : `${r.style}.png`;
  await rm(join(dir, other), { force: true }).catch(() => undefined);
  await writeAtomic(join(dir, r.file), data);
  await writeAtomic(join(dir, `${r.style}.json`), JSON.stringify(r, null, 1));
  // The gallery picture says its style too, as its record does, so a clip started from it knows (src/pairing.ts).
  await images.gallery.update(pic.id, { style: r.style }).catch(() => undefined);
  return { record: r, styleName: pickedStyle(r.style)!.name };
}

/** Every sample kept, by model id then style id: each record with its honest line. */
async function allSamples(): Promise<Record<string, Record<string, SampleRecord & { line: string }>>> {
  const out: Record<string, Record<string, SampleRecord & { line: string }>> = {};
  const models = await readdir(DIR, { withFileTypes: true }).catch(() => []);
  for (const d of models) {
    if (!d.isDirectory() || !isModelKey(d.name)) continue;
    for (const f of await readdir(join(DIR, d.name)).catch(() => [] as string[])) {
      if (!f.endsWith('.json')) continue;
      const r = cleanRecord(await readFile(join(DIR, d.name, f), 'utf8').then(JSON.parse).catch(() => null));
      // A record kept under another model's folder, or one whose picture is gone, is not shown.
      if (!r || r.model !== d.name || `${r.style}.json` !== f) continue;
      const has = await readdir(join(DIR, d.name)).then(xs => xs.includes(r.file), () => false);
      if (!has) continue;
      (out[d.name] ??= {})[r.style] = { ...r, line: honestLine(r) };
    }
  }
  return out;
}

export const styleSamplesGet: Routes = {
  // The styles, the sample prompt and seed, every sample kept, and the picture hires with their model.
  '/api/stylesamples': async ({ res }) => {
    const remotes = (await store.settings()).remotes;
    const labels = brains.pcLabels(remotes);
    const artists = staff.list().filter(m => drawsPictures(m.role)).map(m => {
      const { model, pc } = modelOf(m);
      const r = remotes.find(x => x.id === pc);
      const name = model ? shortName(images.list().find(x => x.id === model)?.name ?? (pc ? jobRoutes.sharedName(pc, model) : model)) : '';
      return { id: m.id, name: m.name, model, modelName: name, pc: pc ? labels[pc] ?? r?.name ?? 'a linked PC' : '' };
    });
    const samples = await allSamples();
    // Each style's line for video (src/pairing.ts) per picture model: an artist's, a sample's, and '' for none known.
    const rows = await seenNow().catch(() => []);
    const models = new Map<string, string>([['', '']]);
    for (const [id, s] of Object.entries(samples)) models.set(id, Object.values(s)[0]?.modelName ?? id);
    for (const a of artists) if (a.model) models.set(a.model, a.modelName || models.get(a.model) || a.model);
    return json(res, 200, {
      prompt: SAMPLE_PROMPT, seed: SAMPLE_SEED, quality: SAMPLE_QUALITY,
      styles: STYLES.map(s => ({ id: s.id, name: s.name, about: s.about, shape: s.shape, quality: s.quality, mode: s.mode, value: formValue(s) })),
      samples, artists,
      video: Object.fromEntries([...models].map(([id, name]) => [id, styleFits(id, name, rows)])),
    });
  },
  // ?model=<id>&style=<id>: that sample's picture.
  '/api/stylesamples/file': async ({ res, url }) => {
    const model = url.searchParams.get('model') ?? '';
    const style = pickedStyle(url.searchParams.get('style'));
    if (!isModelKey(model) || !style) return json(res, 404, { error: 'No such sample.' });
    for (const [ext, type] of [['png', 'image/png'], ['webp', 'image/webp']] as const) {
      const data = await readFile(join(DIR, model, `${style.id}.${ext}`)).catch(() => null);
      if (!data) continue;
      res.writeHead(200, { 'content-type': type, 'content-length': data.length, ...SECURITY_HEADERS, 'cache-control': 'no-store' });
      return res.end(data);
    }
    return json(res, 404, { error: 'That sample is not kept here.' });
  },
};
