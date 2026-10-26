// The model runners on this PC, for the Models page's runner rows: which are here, why the CUDA one cannot help (no
// NVIDIA card, an old driver), downloading a card runner here (CUDA or Vulkan: checked, in the background, with Stop)
// and taking a CUDA one away. Sending it to a linked PC is src/jobrun/copies.ts runnerTo.
import { type Progress } from '../download.ts';
import { pageDownloads, pinWhy } from '../runtimes.ts';
import { hardware, json, runtimes, type Routes } from './core.ts';
import { images, runners } from './panes.ts';

/** A download here: how far it is, or how it ended. */
const getting = new Map<string, { got: number; bytes: number; checking: boolean; error: string | null; done: boolean; stop: AbortController }>();

const whyHere = (id: string) => pinWhy(runtimes.pins[id], hardware.gpus, hardware.nvidiaDriver ?? null, 'This PC', Object.values(runtimes.pins));
/** A model running (or loading) on that device holds its runner's files open. */
const inUse = (device: string) => [...runners, images.pane].some(p => p.view.device === device && (p.view.state === 'connected' || p.view.state === 'loading'));

function list() {
  return Object.entries(runtimes.pins).map(([id, p]) => {
    const g = getting.get(id);
    return {
      id,
      name: p.name,
      engine: p.engine,
      device: p.device,
      licence: p.licence,
      bytes: runtimes.bytesPin(id),
      installed: runtimes.installedPin(id),
      // Its zips are kept here, downloaded for sending to a linked PC.
      zips: runtimes.zipsHerePin(id),
      why: whyHere(id),
      // The CUDA build Auto starts first on this PC (the one with code made for its card).
      best: p.device === 'cuda' && runtimes.order(p.engine, 'cuda')[0] === id,
      cuda: p.cuda?.version ?? null,
      getting: g ? { got: g.got, bytes: g.bytes, checking: g.checking, error: g.error, done: g.done } : null,
    };
  });
}

/** The CUDA runner named in a request: only those are downloaded or taken away from here. */
function cudaPin(b: Record<string, unknown>) {
  const id = String(b.id ?? '');
  const pin = runtimes.pins[id];
  return pin && pin.device === 'cuda' ? { id, pin } : null;
}

export const runtimesGet: Routes = {
  '/api/runtimes': ({ res }) => json(res, 200, { runtimes: list(), nvidia: hardware.gpus.some(g => g.vendor === 'nvidia' && !g.integrated), driver: hardware.nvidiaDriver ?? null }),
};

export const runtimesPost: Routes = {
  '/api/runtimes/get': ({ res, b }) => {
    const id = String(b.id ?? '');
    const c = pageDownloads(runtimes.pins[id]) ? { id, pin: runtimes.pins[id] } : null;
    if (!c) return json(res, 400, { error: 'Only the card runners (CUDA, Vulkan) are downloaded from here; the CPU ones come with TOMLIN.' });
    const why = whyHere(c.id);
    if (why) return json(res, 409, { error: why });
    if (runtimes.installedPin(c.id)) return json(res, 409, { error: `${c.pin.name} is on this PC already.` });
    const now = getting.get(c.id);
    if (now && !now.done && !now.error) return json(res, 409, { error: `${c.pin.name} is downloading already.` });
    const job = { got: 0, bytes: runtimes.bytesPin(c.id), checking: false, error: null as string | null, done: false, stop: new AbortController() };
    getting.set(c.id, job);
    void runtimes.installPin(c.id, (p: Progress) => Object.assign(job, p), job.stop.signal).then(() => {
      job.done = true;
    }, e => {
      job.error = job.stop.signal.aborted ? 'Stopped. Download it again to carry on from where it stopped.' : (e as Error).message;
    });
    return json(res, 200, { ok: true });
  },
  '/api/runtimes/stop': ({ res, b }) => {
    const job = getting.get(String(b.id ?? ''));
    job?.stop.abort();
    return json(res, 200, { stopped: !!job });
  },
  '/api/runtimes/remove': async ({ res, b }) => {
    const c = cudaPin(b);
    if (!c) return json(res, 400, { error: 'Only a downloaded runner (the NVIDIA one) is taken away from here.' });
    if (inUse(c.pin.device)) return json(res, 409, { error: 'A model runs on it now: drop that model first, then remove the runner.' });
    try {
      await runtimes.removePin(c.id);
    } catch (e) {
      return json(res, 409, { error: `It could not be taken away (${(e as Error).message.replace(/\.$/, '')}). Drop every model and try again.` });
    }
    getting.delete(c.id);
    return json(res, 200, { ok: true, runtimes: list() });
  },
};
