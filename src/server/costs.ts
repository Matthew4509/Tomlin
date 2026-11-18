// A PC's window (press a PC in the left panel): how long it has been up, what its chat models did, and what that cost
// in power against the same tokens on the Claude and ChatGPT APIs, per project (src/meter.ts).
import type { ServerResponse } from 'node:http';
import { readFile, statfs } from 'node:fs/promises';
import { uptime as pcUptime } from 'node:os';
import { readings } from '../engine.ts';
import * as brains from '../brains.ts';
import { chatNeed } from '../calc.ts';
import { added, API_PRICES, cleanPower, cleanPrices, costs, dayOf, powerFault, PRICES_CHECKED, scope, ZERO, type ApiPrice, type Costs, type Power, type Tally } from '../meter.ts';
import { nowModel, roleOf } from '../staff.ts';
import type { Assigned } from '../assigned.ts';
import * as update from '../update.ts';
import { type Routes, BUILD, lastUsed, STARTED_AT, VERSION, byModel, byStaff, faultWords, json, ledger, meter, pcProfiles, shortName, staff, store, uptime } from './core.ts';
import { photoPng, profileView, shownName } from '../pcprofile.ts';
import { pcLook } from '../home.ts';
import { refreshDisks } from './slowdisk.ts';
import { jobRoutes } from './jobs.ts';
import { cpuHere, memoryNow, modelsHere } from './thispc.ts';
import { chatList } from './panes.ts';
import { assignedTo, staffLines } from '../assigned.ts';
import { driveReport } from '../modelhome.ts';

/** The hires who work on one PC ('here' or a linked PC's id) now, with the time each worked in the last 7 days. */
function staffOn(key: string) {
  const week = byStaff.workedBetween(dayOf(new Date(Date.now() - 6 * 86_400_000)), dayOf());
  return staff.list().filter(m => {
    const b = brains.parseRef(nowModel(m) ?? m.model);
    return key === 'here' ? b.kind !== 'remote' : b.kind === 'remote' && b.pc === key;
  }).map(m => ({ id: m.id, name: m.name, role: roleOf(m.role).name, kind: roleOf(m.role).kind ? 'image' : 'chat', ms: week[m.id] ?? 0 }))
    .sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name));
}

/** One PC's most-used models over the last 7 days, by the name shown for them. */
function topModels(key: string) {
  const names = key === 'here' ? new Map(chatList().map(m => [m.id, m.name])) : null;
  return byModel.top(key, 7).slice(0, 5).map(x => ({ name: shortName(names?.get(x.model) ?? x.model) || x.model, ms: x.ms, answers: x.answers }));
}

/** Free and total space on the drive TOMLIN keeps its data on (null when Windows does not say). */
async function diskHere(): Promise<{ free: number; total: number } | null> {
  try {
    const f = await statfs(store.dir);
    return { free: f.bavail * f.bsize, total: f.blocks * f.bsize };
  } catch {
    return null;
  }
}

// Every answer a chat model writes on this PC: counted in its totals, and in the log under the project it was for: here,
// or (work for a linked PC) under "for-<that link>" and the project that PC said, which it reads as its final tally.
readings.used = (model, u) => {
  meter.add(u);
  // Per model of this PC, whoever it worked for (the PC window's "Most-used models").
  byModel.add('here', model, u);
  lastUsed.touch(model);
  const s = scope.getStore();
  if (s) s.used = added(s.used, u);
  if (s?.forPc) {
    if (s.forLink) ledger.add(`for-${s.forLink}`, s.forProject ?? '', u);
  } else {
    ledger.add('here', s?.project ?? '', u);
    byStaff.add(s?.staff, u);
  }
};

const FILE = 'power.json';
type PowerFile = { pcs?: Record<string, unknown>; prices?: unknown };
const readPower = () => store.readJson<PowerFile>(FILE, {});

/** A hire's tokens so far (any PC that answered for them) and what the same tokens would cost on each API. */
export async function staffUsage(id: string): Promise<{ tally: Tally; last: string; apis: Costs['apis'] }> {
  const { tally, last } = byStaff.of(id);
  return { tally, last, apis: costs(tally, { watts: null, kwh: null }, cleanPrices((await readPower()).prices)).apis };
}

/** Said in a linked PC's window when it did not answer: never the network's own error text. */
export const NOT_ANSWERING = 'This PC is not answering: it may be off, asleep or off the network. What it said last is shown.';

/**
 * Everything the PC window shows for one PC ('here' for this one). `quick`: a linked PC is not asked; what it said last
 * is drawn at once (`checking`), and the page asks again without `quick` for the answer from that PC now.
 */
async function pcView(id: string, quick = false): Promise<{ status: number; body: unknown }> {
  const here = !id || id === 'here';
  const s = await store.settings();
  const r = here ? null : s.remotes.find(x => x.id === id);
  if (!here && !r) return { status: 404, body: { error: 'That PC is no longer linked to this one. Close this window: the list on the left has the PCs linked now.' } };
  const key = here ? 'here' : r!.id;
  // A linked PC behind this one: its version, and whether "Update it" can send this version there (or why not), as its
  // tile under Other PCs says. Its own log of its work for this PC is the final tally: read now too (it is also read
  // once a minute). Both are asked at once, so a PC that is off costs one wait of 3 s, not two.
  let fault = '';
  let answered = false;
  const asked = here || quick ? null : await Promise.all([
    jobRoutes.syncUsage(r!, 3000).catch(() => false),
    jobRoutes.hello(r!, 3000).catch(e => {
      // A PC that answered and refused says why in its own words; one that did not answer gets plain words, never the
      // network's own ("The operation was aborted due to timeout").
      answered = (e as { answered?: boolean }).answered === true;
      fault = answered ? `It answered but said: ${(e as Error).message.replace(/\.$/, '')}.` : NOT_ANSWERING;
      return null;
    }),
  ]);
  const synced = here ? true : asked ? asked[0] : false;
  // Quick: what it said last (nothing while it is not answering, src/jobrun/links.ts seen).
  const h = here ? null : asked ? asked[1] : jobRoutes.lastHello(r!.id);
  // Its state: the same word as the left panel (src/home.ts pcLook).
  const look = here ? { state: 'on', text: 'This PC', activity: 'available', word: 'Available' } : pcLook({ ok: !!h, model: h?.model, image: h?.image, away: h?.away, answered, error: fault, backupsOnly: r!.backupsOnly === true });
  const why = h ? update.updateWhy({ name: r!.name, ok: true, version: h.version, build: h.build, away: h.away, can: h.can, restarts: h.restarts, allowUpdate: h.allow?.update === true }, VERSION, BUILD) : null;
  // Ahead of this PC (a newer version, or the same with other files): whether "Update this PC from it" can take it here.
  const pullWhy = h ? update.pullWhy({ name: r!.name, ok: true, version: h.version, build: h.build, away: h.away, can: h.can ?? [], allowGive: h.allow?.give === true }, VERSION, BUILD, process.env.TOMLIN_LOOP === '1') : null;
  // This PC's drives and whether each is a hard disk or an SSD, for the HDD mark on its models (src/server/modelhome.ts).
  if (here) await refreshDisks();
  const said = here ? { up: { since: STARTED_AT, pc: Math.round(pcUptime()) }, meter: meter.view(), at: Date.now() } : jobRoutes.lastSaid(key);
  const profile = await pcProfiles.get(key);
  const file = await readPower();
  const power = cleanPower(file.pcs?.[key]);
  const apis = cleanPrices(file.prices);
  // Projects by name (a job's name, else its goal); '' is the work not in a project.
  const names = new Map<string, string>();
  const rows = [];
  let mine: Tally = { ...ZERO };
  const sum = (a: Tally, b: Tally): Tally => ({ in: a.in + b.in, cached: a.cached + b.cached, out: a.out + b.out, ms: a.ms + b.ms, answers: a.answers + b.answers });
  for (const row of ledger.forPc(key)) {
    if (row.project && !names.has(row.project)) {
      const job = await jobRoutes.loadJob(row.project);
      names.set(row.project, job ? job.name || job.goal.slice(0, 80) : 'A project no longer in this workspace');
    }
    mine = sum(mine, row.tally);
    rows.push({ project: row.project, name: row.project ? names.get(row.project)! : 'Not allocated to a project', tally: row.tally, last: row.last, costs: costs(row.tally, power, apis) });
  }
  return {
    status: 200,
    body: {
      id: key,
      name: shownName(profile, here ? 'My PC' : r!.name),
      // Its own name (what it calls itself), and your words for it and its photo (src/pcprofile.ts).
      ownName: here ? 'My PC' : r!.name,
      profile: profileView(key, profile),
      here,
      online: here || !!jobRoutes.lastHello(key),
      look,
      // Drawn from what it said last; the answer from that PC now follows.
      checking: !here && quick,
      version: here ? VERSION : h?.version ?? null,
      // When that PC's TOMLIN was put there ("Up to date: Last updated ..."), and its memory for the top line.
      installed: h?.installed ?? null,
      memory: here ? memoryNow() : h?.memory ?? (r ? jobRoutes.lastHello(r.id)?.memory : null) ?? null,
      // What code it runs, 7 characters ('' from an older TOMLIN); update.other: the same version with different files.
      build: update.shortBuild(here ? BUILD : h?.build),
      update: why === null ? null : { why, mine: VERSION, build: update.shortBuild(BUILD), other: !!h && update.standing(h, VERSION, BUILD) === 'other' },
      pull: pullWhy === null || !h ? null : { why: pullWhy, mine: VERSION, build: update.shortBuild(BUILD), other: !update.newer(h.version, VERSION) },
      // Whether this PC may turn that PC off from its window: it knows how (can), its owner's tick is on (allowed), and it is not asleep or away.
      off: here || !h ? null : { can: Array.isArray(h.can) && h.can.includes('power-off'), allowed: h.allow?.off === true, away: !!h.away },
      ours: VERSION,
      ourBuild: update.shortBuild(BUILD),
      // Why a linked PC did not answer just now, in its own words ('' when it did).
      fault,
      // From that PC's own log just now (else as counted here from its answers, or as last read).
      synced,
      up: said?.up ?? null,
      saidAt: said ? new Date(said.at).toISOString() : null,
      checks: here ? null : uptime.share(key, 7),
      meter: said?.meter ? { ...said.meter, costs: costs(said.meter.total, power, apis) } : null,
      mine: { tally: mine, costs: costs(mine, power, apis) },
      rows,
      power,
      apis,
      defaults: API_PRICES,
      checked: PRICES_CHECKED,
      // The PC window's layout (8 Oct): its processor and drive (this PC only), the models on it, who works on it, and
      // its most-used models. A linked PC's models are the ones it lets this PC use (as it last said).
      cpu: here ? cpuHere() : null,
      disk: here ? await diskHere() : null,
      // Every drive with its free space, for the line above "Free up space": this PC reads them; a linked PC says them in its hello (an older TOMLIN: only the one drive its hello names).
      drives: here ? await driveReport() : h?.drives?.length ? h.drives : (r ? jobRoutes.lastHello(r.id)?.drives : null) ?? [],
      diskThere: here ? null : h?.disk ?? (r ? jobRoutes.lastHello(r.id)?.disk : null) ?? null,
      models: here ? modelsHere() : ((h?.models ?? r!.models ?? []) as { id: string; name: string; kind: 'chat' | 'image'; bytes: number; loaded?: boolean; busy?: boolean; hidden?: boolean; assigned?: Assigned[] }[]).map(m => ({
        id: m.id, name: shortName(m.name) || m.name, kind: m.kind === 'image' ? 'image' : 'chat', bytes: m.bytes || 0, need: m.kind === 'image' ? m.bytes || 0 : Math.round(chatNeed(m.bytes || 0)),
        loaded: !!h && !!m.loaded, busy: !!h && !!m.busy, hidden: m.hidden === true,
        // The hires on it: this PC's (on that PC's model) and that PC's own, when it says (an older TOMLIN does not).
        staffNote: staffLines({ mine: assignedTo(staff.list(), `remote:${r!.id}:${m.id}`), theirs: m.assigned ?? null, pcName: r!.name }).note,
      })),
      staff: staffOn(key),
      top: topModels(key),
    },
  };
}

/**
 * A project's final tally: every PC that worked on it (this one, and each linked PC from its own log), with its power
 * at that PC's watts and price, and the same tokens on each API.
 */
async function projectUsage(id: string): Promise<{ status: number; body: unknown }> {
  const job = await jobRoutes.loadJob(id);
  if (!job) return { status: 404, body: { error: 'That project is not in this workspace any more.' } };
  const s = await store.settings();
  const file = await readPower();
  const apis = cleanPrices(file.prices);
  const rows = ledger.forProject(id).map(x => {
    const name = x.pc === 'here' ? 'My PC' : s.remotes.find(r => r.id === x.pc)?.name ?? 'A PC no longer linked';
    return { pc: x.pc, name, tally: x.tally, costs: costs(x.tally, cleanPower(file.pcs?.[x.pc]), apis) };
  });
  const total = rows.reduce<Tally>((a, r) => ({ in: a.in + r.tally.in, cached: a.cached + r.tally.cached, out: a.out + r.tally.out, ms: a.ms + r.tally.ms, answers: a.answers + r.tally.answers }), { ...ZERO });
  // Power adds up PC by PC (each at its own watts and price); a PC with neither leaves it unknown.
  const powers = rows.map(r => r.costs.power);
  const power = rows.length && powers.every(p => p !== null) ? powers.reduce((a, p) => a + p!, 0) : null;
  return { status: 200, body: { rows, total: { tally: total, costs: { ...costs(total, { watts: null, kwh: null }, apis), power } }, apis, checked: PRICES_CHECKED } };
}

/** A PC's photo: GET /api/pc/photo/<key>. */
export async function pcPhotoFile(key: string, res: ServerResponse): Promise<void> {
  const file = await pcProfiles.photoPath(key);
  const png = file ? await readFile(file).catch(() => null) : null;
  if (!png) return json(res, 404, { error: 'Not found.' });
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
  return void res.end(png);
}

export const costsGet: Routes = {
  '/api/pc': async ({ res, url }) => {
    const r = await pcView(url.searchParams.get('id') ?? 'here', url.searchParams.get('quick') === '1');
    return json(res, r.status, r.body);
  },
  '/api/pc/profiles': async ({ res }) => {
    // Every PC's name, make and model and photo, for the left panel ('here' = this PC; linked PCs still linked only).
    const all = await pcProfiles.all();
    const keys = new Set(['here', ...(await store.settings()).remotes.map(r => r.id)]);
    return json(res, 200, { profiles: Object.fromEntries(Object.entries(all).filter(([k]) => keys.has(k)).map(([k, p]) => [k, profileView(k, p)])) });
  },
  '/api/project/usage': async ({ res, url }) => {
    const r = await projectUsage(url.searchParams.get('id') ?? '');
    return json(res, r.status, r.body);
  },
};

export const costsPost: Routes = {
  '/api/pc/power': async ({ res, b }) => {
    // {id, watts, kwh}: that PC's draw while a model works and the price of a kWh (either left empty: not used).
    const id = String(b.id ?? 'here');
    if (id !== 'here' && !(await store.settings()).remotes.some(x => x.id === id)) return json(res, 404, { error: 'That PC is no longer linked to this one.' });
    const fault = powerFault(b);
    if (fault) return json(res, 400, { error: fault });
    const power: Power = cleanPower(b);
    await store.updateJson<PowerFile>(FILE, {}, now => ({ ...now, pcs: { ...(now.pcs ?? {}), [id]: power } }));
    const r = await pcView(id);
    return json(res, r.status, r.body);
  },
  '/api/pc/profile': async ({ res, b }) => {
    // {id, name, model}: what you call this PC and its make and model ('' clears either).
    const id = String(b.id ?? 'here');
    if (id !== 'here' && !(await store.settings()).remotes.some(x => x.id === id)) return json(res, 404, { error: 'That PC is no longer linked to this one.' });
    await pcProfiles.setWords(id, { name: b.name, model: b.model });
    const r = await pcView(id);
    return json(res, r.status, r.body);
  },
  '/api/pc/photo': async ({ res, b }) => {
    // {id, image}: a photo of the PC (a data: address); {id, image: null}: the photo taken away.
    const id = String(b.id ?? 'here');
    if (id !== 'here' && !(await store.settings()).remotes.some(x => x.id === id)) return json(res, 404, { error: 'That PC is no longer linked to this one.' });
    try {
      await pcProfiles.setPhoto(id, b.image === null ? null : await photoPng(b.image));
    } catch (e) {
      return json(res, 400, { error: faultWords(e) });
    }
    const r = await pcView(id);
    return json(res, r.status, r.body);
  },
  '/api/pc/prices': async ({ res, b }) => {
    // {apis, id}: the APIs compared with and their prices (US$ per million tokens); {reset: true} puts the checked ones back.
    const prices: ApiPrice[] = b.reset === true ? API_PRICES : cleanPrices(b.apis);
    await store.updateJson<PowerFile>(FILE, {}, now => ({ ...now, prices }));
    const r = await pcView(String(b.id ?? 'here'));
    return json(res, r.status, r.body);
  },
};
