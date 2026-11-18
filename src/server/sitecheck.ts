// The website check's routes (src/sitecheck.ts): start one, follow it, stop it, read its report. One runs at a time; the
// model is the connected one, or a hire's (here or on a linked PC), and gets a context sized for the web first. Nothing
// is saved: the report stays in memory for the last few checks, and Save in the window writes it as a note.
import { randomBytes } from 'node:crypto';
import { checkSite, reportText, type SiteAnswer, type SiteAsk, type SiteProgress, type SiteReport } from '../sitecheck.ts';
import { normalUrl } from '../webtools.ts';
import { WEB_CTX } from '../webctx.ts';
import * as brains from '../brains.ts';
import type { Brain } from '../jobrun.ts';
import { type Routes, json, staff, staffId } from './core.ts';
import { jobRoutes } from './jobs.ts';
import { main, runOn } from './panes.ts';
import { loadAsk, widenForWeb } from './webctx.ts';

interface Job {
  id: string;
  url: string;
  who: string;
  state: 'starting' | 'running' | 'done' | 'stopped' | 'failed';
  /** What it is doing now, in words. */
  words: string;
  /** What was done to get the model ready (context, loading), in words. */
  notes: string[];
  progress: SiteProgress | null;
  /** The model's name and where it runs. */
  ran: string;
  report: SiteReport | null;
  text: string;
  error: string;
  ac: AbortController;
}

const jobs = new Map<string, Job>();
const view = (j: Job) => ({ id: j.id, url: j.url, state: j.state, words: j.words, notes: j.notes, progress: j.progress, ran: j.ran, report: j.report, text: j.text, error: j.error });

/** The model for a check: the connected one, or a hire's; its context widened for the web where it runs here or is lent. */
async function brainFor(j: Job): Promise<{ brain: Brain; ran: string }> {
  const say = (text: string) => {
    j.words = text;
    if (!j.notes.includes(text)) j.notes.push(text);
  };
  const member = staffId(j.who) ? staff.get(j.who.slice(6)) : undefined;
  const get = async () => {
    if (member && brains.refsOf(member).length) return jobRoutes.hireBrain(member, say, j.ac.signal);
    const b = await jobRoutes.brainForRef('', 'the website check', 'in Models', say, j.ac.signal);
    return { ...b, ref: '' };
  };
  let got = await get();
  if (got.here) {
    const runner = got.pane ?? main();
    const wide = await widenForWeb(runner, say, j.ac.signal, await loadAsk());
    if (wide !== runner || got.brain.ctx !== runOn(wide).ctx) got = await get();
  } else if (got.ref) {
    const far = await jobRoutes.widenFar(got.ref);
    if (far) {
      say('words' in far ? far.words : far.note);
      if ('words' in far) got.brain.ctx = far.ctx;
    }
  }
  return { brain: got.brain, ran: `${got.model} on ${got.pc}` };
}

async function run(j: Job, pages: number): Promise<void> {
  try {
    j.state = 'starting';
    j.words = 'Getting the model ready…';
    const { brain, ran } = await brainFor(j);
    j.ran = ran;
    j.state = 'running';
    const ask: SiteAsk = async (system, user, signal): Promise<SiteAnswer> => {
      const text = await brain.ask(system, user, 400, () => undefined, signal, { plain: true });
      const last = brain.last;
      const estimated = !last?.readTokens || !last.tokens;
      return { text, tokensIn: last?.readTokens ?? Math.ceil((system.length + user.length) / 3), tokensOut: last?.tokens ?? Math.ceil(text.length / 3), ...(estimated ? { estimated: true } : {}) };
    };
    const report = await checkSite({
      start: j.url,
      maxPages: pages,
      ask,
      ctx: brain.ctx || WEB_CTX,
      signal: j.ac.signal,
      onProgress: p => {
        j.progress = p;
        j.words = p.words;
      },
    });
    j.report = report;
    j.text = reportText(report);
    j.state = report.stopped ? 'stopped' : 'done';
    j.words = report.stopped ? 'Stopped.' : 'Done.';
  } catch (e) {
    j.state = j.ac.signal.aborted ? 'stopped' : 'failed';
    j.error = j.ac.signal.aborted ? '' : (e as Error).message;
    j.words = j.ac.signal.aborted ? 'Stopped.' : 'Did not finish.';
  }
}

export const sitecheckGet: Routes = {
  // ?id=<job>: where it is, and the report when it is done. Without id: the check running now, and the last one.
  '/api/sitecheck': async ({ res, url }) => {
    const id = url.searchParams.get('id') ?? '';
    if (id) {
      const j = jobs.get(id);
      return j ? json(res, 200, view(j)) : json(res, 404, { error: 'That website check is not there any more.' });
    }
    const all = [...jobs.values()];
    const running = all.find(j => j.state === 'starting' || j.state === 'running');
    return json(res, 200, { running: running?.id ?? null, last: all.at(-1)?.id ?? null });
  },
};

export const sitecheckPost: Routes = {
  // { url, pages?, who? }: starts a check of the site at that address (its own pages only), at most `pages` of them.
  '/api/sitecheck': async ({ res, b }) => {
    const url = normalUrl(String(b.url ?? '').trim());
    if (!url) return json(res, 400, { error: 'That is not a web address. Give the full address, starting https:// or http://.' });
    if ([...jobs.values()].some(j => j.state === 'starting' || j.state === 'running')) return json(res, 409, { error: 'A website check is running now. Wait for it, or stop it.' });
    const pages = Math.max(1, Math.min(60, Math.floor(Number(b.pages) || 15)));
    const j: Job = { id: randomBytes(6).toString('hex'), url, who: typeof b.who === 'string' ? b.who : '', state: 'starting', words: 'Starting…', notes: [], progress: null, ran: '', report: null, text: '', error: '', ac: new AbortController() };
    jobs.set(j.id, j);
    while (jobs.size > 5) jobs.delete(jobs.keys().next().value!);
    void run(j, pages);
    return json(res, 200, view(j));
  },
  '/api/sitecheck/stop': async ({ res, b }) => {
    const j = jobs.get(String(b.id ?? ''));
    if (!j) return json(res, 404, { error: 'That website check is not there any more.' });
    j.ac.abort();
    return json(res, 200, view(j));
  },
};
