// Same model, smaller file, fits the card (src/quantfit.ts): what the speed finder offers for a chat model that spills
// over its card, and the download on the owner's press. The other files are found on Hugging Face: from where the
// file came from (data/model-sources.json), else from the repos named "<model>-GGUF" in the Hugging Face list this PC
// keeps (most downloaded first, at most 3), and only a repo that lists the file in use (the same name and size) counts
// as the same model. Nothing is downloaded here without {yes: true} and the size the window showed.
import { paramsFromName, type HfLookup } from '../download.ts';
import { CARDS } from '../calc.ts';
import { RATES, autoSplit, cardRate, pickSmaller, stemOf, type Pick } from '../quantfit.ts';
import { chatModels, hfList } from './core.ts';
import { getHf, lookCached, modelSources } from './hf.ts';

const GB = 2 ** 30;
export const SMALLER_NAME = 'Same model, smaller file, fits the card';

export interface SmallerOffer extends Pick {
  repo: string;
  rev: string;
  licence: string;
  /** This PC has the file already: test it instead of downloading. */
  have: string | null;
}

/** The repos to look in for a model's other files: where it came from, else "<model>-GGUF" repos, most downloaded first. */
async function reposFor(name: string): Promise<{ repos: string[]; known: boolean }> {
  const src = (await modelSources())[name];
  if (src) return { repos: [src.repo], known: true };
  const list = await hfList.get();
  if (!list) return { repos: [], known: false };
  const want = `${stemOf(name)}-gguf`.toLowerCase();
  const repos = list.models.filter(([repo]) => repo.split('/')[1]?.toLowerCase() === want).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([repo]) => repo);
  return { repos, known: false };
}

/**
 * The offer for one model (null with `why` in the "Not tried" list when there is none). Only for a dense model that
 * spills now: one already wholly on the card has nothing to gain, and a mixture-of-experts model never fits whole.
 */
export async function smallerOffer(o: {
  name: string;
  bytes: number;
  card: { name: string; total: number; free: number } | null;
  /** What it holds on the card now when loaded (null: not loaded). */
  held: number | null;
  spilled: boolean;
  moe: boolean;
  cacheBytes: number;
  /** A guessing model kept on the card beside it (its file, cache and working memory). */
  extra: number;
  measured: number | null;
  size: 'quick' | 'full';
}): Promise<{ offer: SmallerOffer | null; why: string }> {
  if (!o.card || !o.spilled || o.moe) return { offer: null, why: '' };
  const { repos } = await reposFor(o.name);
  if (!repos.length) return { offer: null, why: 'where this file came from is not known, and no "-GGUF" repo of that name is in this PC\'s Hugging Face list (Models page: Rescan Hugging Face)' };
  const room = o.card.free + (o.held ?? 0);
  const split = o.held !== null ? { card: o.held, ram: Math.max(0, o.bytes - o.held) } : autoSplit(o.bytes, o.cacheBytes, room);
  const rates = { card: cardRate(o.card.name, CARDS), ram: RATES.ram };
  let why = '';
  for (const repo of repos) {
    let l: HfLookup;
    try {
      l = await lookCached(repo);
    } catch (e) {
      why = `Hugging Face could not be asked (${(e as Error).message.replace(/\.$/, '')})`;
      continue;
    }
    // The same model: the repo has the file in use, the same size (within 1%).
    const mine = l.models.find(m => m.name.toLowerCase() === o.name.toLowerCase() && Math.abs(m.bytes - o.bytes) <= o.bytes * 0.01);
    if (!mine) {
      why ||= `${repo} has no file the same as yours, so it may not be the same model`;
      continue;
    }
    const params = l.params ?? paramsFromName(o.name);
    if (!params) {
      why ||= 'the model\'s number of weights is not known, so its smaller files cannot be weighed';
      continue;
    }
    const r = pickSmaller({ files: l.models.map(m => ({ name: m.name, bytes: m.bytes })), current: { name: mine.name, bytes: mine.bytes }, params, cacheBytes: o.cacheBytes, room, extra: o.extra, split, rates, measured: o.measured, size: o.size });
    if (!r.pick) {
      why ||= r.why;
      continue;
    }
    const m = l.models.find(x => x.name === r.pick!.file.name)!;
    const here = m.files.every(f => chatModels.has(f.path)) ? chatModels.list().find(x => x.where !== 'ollama' && x.file.toLowerCase().endsWith(m.files[0].path.split('/').pop()!.toLowerCase())) : undefined;
    return { offer: { ...r.pick, repo: l.repo, rev: l.rev, licence: l.licence, have: here?.id ?? null }, why: '' };
  }
  return { offer: null, why: why || 'no smaller file of this model was found' };
}

/** The offer as the finder window shows it (sizes in bytes, speeds rounded). */
export const offerView = (x: SmallerOffer) => ({
  name: SMALLER_NAME,
  file: x.file.name,
  bytes: x.file.bytes,
  quant: x.quant,
  bits: Math.round(x.bits * 10) / 10,
  bitsNow: Math.round(x.bitsNow * 10) / 10,
  leftGb: Math.round((x.left / GB) * 10) / 10,
  expect: Math.round(x.expect * 10) / 10,
  now: Math.round(x.now * 10) / 10,
  repo: x.repo,
  rev: x.rev,
  licence: x.licence,
  have: x.have,
});

/**
 * The download, on the owner's press only: {yes: true} and the same repo, file and size as the offer the window showed
 * (worked out again here, so a changed offer is not downloaded). The Models page's download does the rest: one at a
 * time, the drive's room checked, every file checked by SHA-256. The file in use is kept.
 */
export async function getSmaller(b: Record<string, unknown>, offer: SmallerOffer | null): Promise<{ status: number; body: Record<string, unknown> }> {
  if (b.yes !== true) return { status: 400, body: { error: 'Nothing was downloaded: the download starts only from its Download button, with its size shown.' } };
  if (!offer || offer.repo !== b.repo || offer.file.name !== b.name || offer.file.bytes !== Number(b.bytes)) return { status: 409, body: { error: 'The smaller file on offer changed since the window was opened (or there is none now). Nothing was downloaded: open Find the fastest setup again to see the offer as it is now.' } };
  if (offer.have) return { status: 409, body: { error: `${offer.file.name} is on this PC already: test it instead.` } };
  const r = await getHf(offer.repo, offer.rev, offer.file.name);
  if (r.status !== 200) return { status: r.status, body: r.json as Record<string, unknown> };
  return { status: 200, body: { said: `Downloading ${offer.file.name} (${(offer.file.bytes / GB).toFixed(1)} GB). The file in use now is kept. It shows on the Models page as it comes; once it is here, open Find the fastest setup again: it says when the smaller file is on this PC.` } };
}
