// Talking to linked PCs over the encrypted link: hellos, their models as brains, pictures drawn there, their meters.
import * as share from '../share.ts';
import * as link from '../link.ts';
import { cleanReading, type AskOpts } from '../engine.ts';
import * as brains from '../brains.ts';
import * as nodestaff from '../nodestaff.ts';
import * as carry from '../carry.ts';
import * as update from '../update.ts';
import * as speedKeys from '../speed.ts';
import { cleanRid, ridOf } from '../outbox.ts';
import { cleanTally, cleanUsed, scope } from '../meter.ts';
import type { Remote } from '../store.ts';
import { d, sleep } from './shared.ts';
import type { Brain, Hello } from '../jobrun.ts';

/** A node's "running since" and how long that PC has been on, as it said (2.0.39 on). */
function upOf(raw: unknown): Hello['up'] {
  const u = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  return u && typeof u.since === 'string' && !Number.isNaN(Date.parse(u.since)) ? { since: u.since, pc: Math.max(0, Math.round(Number(u.pc) || 0)) } : null;
}
function meterOf(raw: unknown): Hello['meter'] {
  const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  return m && typeof m.since === 'string' && !Number.isNaN(Date.parse(m.since)) ? { since: m.since, total: cleanTally(m.total) } : null;
}
/** What each linked PC last said about its uptime and its work, kept while it is off (the PC window shows it). */
export const lastSaid = new Map<string, { up: Hello['up']; meter: Hello['meter']; at: number }>();

/** What each paired PC said last (Home and the team read it without asking again). */
export const seen = new Map<string, Hello & { at: number }>();
/** When each linked PC last said "I need to log off for now" (told once per press). */
const awayTold = new Map<string, string>();
/** The request from each linked PC's lock screen already told (by when it was sent), so it is told once. */
const askTold = new Map<string, string>();
/** The chat model each linked PC had loaded when it last answered (kept while it is off, to name a hire's own model). */
export const lastModel = new Map<string, string>();

/**
 * One call to a linked PC over the encrypted link (src/link.ts): the request is sealed, and the answer comes back
 * opened, as a plain Response, so the readers stay as they are. Only a refusal may come back unsealed (one made
 * before the link was checked: it carries no work); any other answer that is not sealed is refused.
 */
async function linkFetch(r: Remote, path: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
  // The last lock for a "Backups only" PC: nothing that is work for it, whatever asked (read now, not from `r`).
  if (WORK_PATHS.has(path) && backupsOnly(r.id)) throw new Error(backupsOnlyWhy(r.name));
  const keys = link.keysOf(r.key);
  if (!keys) throw Object.assign(new Error(`"${r.name}" was linked before links were encrypted. Link it again: Other PCs, Find PCs on my network, then its setup code.`), { relink: true });
  const req = link.sealRequest(keys, path, payload);
  const id = link.requestId(req.box);
  const res = await fetch(`${r.url}${path}`, { method: 'POST', headers: { authorization: `Link ${share.hashToken(r.token)}`, 'content-type': 'application/json' }, body: JSON.stringify(req), signal });
  if ((res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    if (!res.body) throw new Error(`"${r.name}" sent nothing back.`);
    return new Response(link.openStream(keys, id, res.body), { status: res.status, headers: { 'content-type': 'text/event-stream' } });
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof data.box === 'string') return Response.json(link.openAnswer(keys, id, 0, data.box), { status: res.status });
  if (res.ok) throw new Error(`"${r.name}" answered without the encrypted link, so the answer was not used. Update TOMLIN there, then link it again.`);
  return Response.json(data, { status: res.status });
}
/** What is work for a linked PC: answering, drawing, loading a model, and taking a copy of a model. */
const WORK_PATHS = new Set(['/worker/run', '/worker/draw', '/worker/switch', '/worker/carry-offer', '/worker/carry-put']);
/** Set to "Backups only" on this PC (as saved now). */
export const backupsOnly = (id: string) => d.store.peek()?.remotes.find(x => x.id === id)?.backupsOnly === true;
export const backupsOnlyWhy = (name: string) => `"${name}" is set to Backups only: it keeps backups and does no other work. To use it for staff again, untick Backups only on its card (Nodes and memory, Other PCs).`;

/** A link from before the encryption: said as it is, not as "could not be reached". */
const relink = (e: unknown) => (e as { relink?: boolean }).relink === true;

/** A request from a linked PC's lock screen, as its hello says it (anything else is none). */
export function askOf(v: unknown): Hello['ask'] {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  const hours = share.cleanAskHours(x.hours);
  return hours && typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)) ? { hours, at: x.at } : null;
}

/** Every linked PC that asked to be logged out and is waiting for an answer (as it said in its last hello). */
export function pcAsks(): { pc: string; name: string; hours: number; at: string }[] {
  return [...seen.entries()].filter(([, h]) => h.ask && !h.away).map(([pc, h]) => ({ pc, name: h.name, hours: h.ask!.hours, at: h.ask!.at }));
}

export async function hello(r: Remote, ms = 4000): Promise<Hello> {
  let res: Response;
  try {
    res = await linkFetch(r, '/worker/hello', {}, AbortSignal.timeout(ms));
  } catch (e) {
    // Not answering: what it said before no longer counts as "on" (its staff show as off).
    seen.delete(r.id);
    throw e;
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Unlinked there, or refusing: it no longer counts as on. It did answer, so what it said is shown (not "not answering").
    seen.delete(r.id);
    throw Object.assign(new Error(String(data.error ?? `it answered ${res.status}`)), { answered: true });
  }
  const img = data.image && typeof data.image === 'object' ? (data.image as Record<string, unknown>) : null;
  // An older worker sends no memory, no "can" and no picture part: the manager says so instead of guessing.
  const h: Hello = {
    name: String(data.name ?? r.name),
    model: data.model ? String(data.model) : null,
    ctx: Number(data.ctx) || 8192,
    version: String(data.version ?? ''),
    // An older TOMLIN sends no build id: it is then judged by its version alone (src/update.ts standing).
    build: update.isBuild(data.build) ? data.build : '',
    memory: data.memory && typeof data.memory === 'object' ? data.memory : null,
    can: Array.isArray(data.can) ? data.can.map(String) : [],
    image: img
      ? {
        model: img.model ? String(img.model) : null,
        name: img.name ? String(img.name) : null,
        styles: Array.isArray(img.styles) ? img.styles.map(String) : [],
        swaps: img.swaps === true,
        coverage: Array.isArray(img.coverage) ? (img.coverage as ReturnType<typeof brains.styleCoverage>) : [],
      }
      : null,
    models: nodestaff.cleanShared(data.models),
    away: typeof data.away === 'string' && !Number.isNaN(Date.parse(data.away)) ? data.away : null,
    ask: askOf(data.ask),
    allow: data.allow && typeof data.allow === 'object' ? carry.cleanAllow(data.allow) : null,
    restarts: data.restarts === true,
    up: upOf(data.up),
    meter: meterOf(data.meter),
    installed: typeof data.installed === 'string' && !Number.isNaN(Date.parse(data.installed)) ? data.installed : null,
    disk: carry.cleanDisk(data.disk),
  };
  // A "Backups only" PC lends nothing here: no model of it is offered for a hire, a chat, a job or a picture.
  if (backupsOnly(r.id)) Object.assign(h, { models: [], image: null });
  // "I need to log off for now": told once each time someone at that PC presses it.
  if (h.away && awayTold.get(r.id) !== h.away) d.onNodeAway?.(r.name);
  if (h.away) awayTold.set(r.id, h.away);
  else awayTold.delete(r.id);
  // "I need to use the pc, please log out for N hours": told once for each request sent there.
  if (h.ask && askTold.get(r.id) !== h.ask.at) d.onNodeAsk?.(h.name, h.ask.hours);
  if (h.ask) askTold.set(r.id, h.ask.at);
  else askTold.delete(r.id);
  seen.set(r.id, { ...h, at: Date.now() });
  if (h.up || h.meter) lastSaid.set(r.id, { up: h.up, meter: h.meter, at: Date.now() });
  if (h.model) lastModel.set(r.id, h.model);
  // The PC answered: a note that cannot be saved must not make it look switched off.
  await remember(r, h).catch(() => undefined);
  return h;
}

/**
 * Keeps what a linked PC said about itself: its own name (the host cannot rename a node) and the models it lets this PC
 * use, so hires on them keep their model names while it is off. Written only when something changed.
 */
async function remember(r: Remote, h: Hello): Promise<void> {
  const name = h.name.replace(/[^\w .'-]/g, '').trim().slice(0, 40) || r.name;
  // An older PC says nothing about shared models: what was kept stays.
  const models = h.can.includes('models') ? h.models.map(x => ({ ...x, loaded: false, busy: false })) : r.models ?? [];
  if (name === r.name && JSON.stringify(models) === JSON.stringify(r.models ?? [])) return;
  const s = await d.store.settings();
  if (!s.remotes.some(x => x.id === r.id)) return;
  r.name = name;
  r.models = models;
  await d.store.saveSettings({ remotes: s.remotes.map(x => (x.id === r.id ? { ...x, name, models } : x)) });
}

/**
 * A linked PC's model as a brain: what it has loaded, or (`shared`) one of the models it lets linked PCs use, which it
 * loads first when it is not loaded. While that model answers someone else there, this waits and asks again (told
 * through `stage`), up to 10 minutes or until Stop.
 */
/** How long an answer cut part-way is asked for again before the chat (or the step) is told and offered Reconnect. */
export const RECONNECT_MS = 2 * 60_000;

/** The error when the connection to a linked PC was lost part-way and did not come back: the answer is still owed. */
export type Lost = Error & { lost: { pc: string; name: string; rid: string } };
export const lostOf = (e: unknown): Lost['lost'] | null => (e as Partial<Lost>)?.lost ?? null;

export function remoteBrain(r: Remote, h: Hello, shared?: nodestaff.SharedModel, stage?: (text: string) => void): Brain {
  /** One ask, waiting while the model there answers someone else (up to 10 minutes, or Stop). */
  const once = async (body: Record<string, unknown>, signal: AbortSignal): Promise<Response> => {
    const until = Date.now() + 10 * 60_000;
    let told = false;
    for (;;) {
      let res: Response;
      try {
        res = await linkFetch(r, '/worker/run', body, signal);
      } catch (e) {
        if (signal.aborted) throw new Error('Stopped.');
        if (relink(e)) throw e;
        throw Object.assign(new Error(`The linked PC "${r.name}" could not be reached at ${r.url} (${(e as Error).message}). Is TOMLIN running there with "Enable this PC as a node" ticked?`), { unreached: true });
      }
      if (res.ok || res.status !== 409 || !shared) return res;
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (data.busy !== true || Date.now() > until) throw new Error(`"${r.name}": ${String(data.error ?? 'busy')}`);
      if (!told) stage?.(`${shared.name} on "${r.name}" is answering something else. This answer starts when it is free (or press Stop).`);
      told = true;
      await sleep(3000);
      if (signal.aborted) throw new Error('Stopped.');
    }
  };
  const run = async (payload: Record<string, unknown>, onText: (t: string) => void, signal: AbortSignal, onThought?: AskOpts['onThought'], askedRid?: string, onReading?: AskOpts['onReading']) => {
    const body: Record<string, unknown> = shared ? { ...payload, model: shared.id } : { ...payload };
    // The project this is for, so that PC logs its work under it (its log is the final tally: src/meter.ts).
    const project = scope.getStore()?.project;
    if (project) body.project = project;
    // Work from the queue: that PC may unload a model it loaded for linked PCs to make room (src/jobrun/node.ts).
    if (scope.getStore()?.queue) body.queue = true;
    // A PC that keeps answers (2.0.38 on) is asked with a request id: if the connection is lost part-way, it finishes
    // the answer and keeps it, and asking again with the same id follows it or gets it (src/outbox.ts).
    const rid = h.can.includes('outbox') ? cleanRid(askedRid) ?? ridOf(body) : null;
    if (rid) body.rid = rid;
    // Stop here stops it there too (a closed connection alone no longer does).
    const stop = () => void workerPost(r, '/worker/stop', { rid }, AbortSignal.timeout(5000)).catch(() => undefined);
    if (rid) signal.addEventListener('abort', stop, { once: true });
    try {
      let res = await once(body, signal);
      if (!res.ok) throw new Error(`"${r.name}": ${String(((await res.json().catch(() => ({}))) as Record<string, unknown>).error ?? `answered ${res.status}`)}${res.status === 401 ? '. Link it again under Nodes and memory, Other PCs.' : ''}`);
      let lostAt = 0;
      for (;;) {
        try {
          brain.last = null;
          brain.thought = null;
          brain.cut = false;
          // A linked PC's speed comes back on its done line (an older PC sends none), and is kept here for that PC; so
          // does its working when it thought first (Think), which streams while it thinks.
          const text = await share.readStream(res, onText, (ev, data) => {
            if (ev === 'status') stage?.(`"${r.name}": ${String(data.text ?? '')}`);
            if (ev === 'thinking') onThought?.(String(data.text ?? ''), Number(data.seconds) || 0);
            // How far that PC's model is through reading the chat (2.0.49 on).
            if (ev === 'reading') {
              const r = cleanReading(data);
              if (r) onReading?.(r);
            }
            if (ev === 'done') {
              brain.last = keepRemoteSpeed(r, String(data.model ?? shared?.name ?? h.model ?? ''), data.speed);
              // Stopped at its length limit there (2.0.43 on): Continue is offered here.
              brain.cut = data.cut === true;
              // What that PC used for it (2.0.39 on), counted for that PC under the project this is for.
              const used = cleanUsed(data.usage);
              if (used) d.usage(r.id, used, String(data.model ?? shared?.name ?? ''));
              const t = data.thought as { text?: unknown; seconds?: unknown; stopped?: unknown } | null | undefined;
              const stopped = (['loop', 'long', 'hurry'] as const).find(x => x === t?.stopped);
              if (t && typeof t.text === 'string' && t.text) brain.thought = { text: t.text.slice(-40_000), seconds: Math.max(0, Math.round(Number(t.seconds) || 0)), ...(stopped ? { stopped } : {}) };
            }
          });
          // It came in whole: that PC need not keep it any longer.
          if (rid) void workerPost(r, '/worker/taken', { rids: [rid] }, AbortSignal.timeout(5000)).catch(() => undefined);
          return text;
        } catch (e) {
          if (signal.aborted) throw new Error('Stopped.');
          // What that PC said went wrong (a fault there) is not a lost connection.
          if (!rid || /^The worker said/.test((e as Error).message)) throw e;
          lostAt ||= Date.now();
        }
        // The connection was lost part-way: that PC carries on. It is asked again with the same id every 5 s, which
        // follows the answer there (or gets it, once done); after two minutes the chat is told, with Reconnect.
        for (;;) {
          if (Date.now() - lostAt > RECONNECT_MS) throw Object.assign(new Error(`Lost the connection to "${r.name}" part-way: it is still working on it.`), { lost: { pc: r.id, name: r.name, rid } });
          stage?.(`Lost the connection to "${r.name}": it is still working on it. Reconnecting…`);
          await sleep(5000);
          if (signal.aborted) throw new Error('Stopped.');
          try {
            res = await once(body, signal);
          } catch (e) {
            if (signal.aborted || !(e as { unreached?: boolean }).unreached) throw e;
            continue;
          }
          if (res.ok) break;
          throw new Error(`"${r.name}": ${String(((await res.json().catch(() => ({}))) as Record<string, unknown>).error ?? `answered ${res.status}`)}`);
        }
      }
    } finally {
      signal.removeEventListener('abort', stop);
    }
  };
  const brain: Brain = {
    label: `${shared?.name ?? h.model} on ${r.name}`,
    ctx: shared?.ctx ?? h.ctx,
    ask: (system, user, maxTokens, onText, signal) => run({ system, user, maxTokens }, onText, signal),
    // An older worker takes one message: the conversation is written into it.
    // `plain` and `think` go with it; an older PC does not read them and asks with its own settings.
    chat: (turns, maxTokens, onText, signal, opts) => run(h.can.includes('turns') ? { turns, maxTokens, ...(opts?.plain ? { plain: true } : {}), ...(opts?.think ? { think: true } : {}) } : { ...brains.flatten(turns), maxTokens }, onText, signal, opts?.onThought, opts?.rid, opts?.onReading),
    last: null,
  };
  return brain;
}

/**
 * Where an answer owed by a linked PC is now (src/outbox.ts): still being written (its words so far), finished, or not
 * there any more; null when that PC does not answer.
 */
export async function owedNow(r: Remote, rid: string): Promise<{ state: 'working'; text: string } | { state: 'done' | 'error'; text: string; done?: Record<string, unknown>; error?: string; at: string } | { state: 'gone'; why: string } | null> {
  let res: Response;
  try {
    res = await linkFetch(r, '/worker/result', { rid }, AbortSignal.timeout(6000));
  } catch {
    return null;
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 404 && data.gone === true) return { state: 'gone', why: String(data.error ?? `"${r.name}" does not have that answer any more. Send your message again.`) };
  if (!res.ok) return null;
  if (data.state === 'working') return { state: 'working', text: String(data.text ?? '') };
  if (data.state === 'done' || data.state === 'error') return { state: data.state, text: String(data.text ?? ''), done: data.done && typeof data.done === 'object' ? (data.done as Record<string, unknown>) : undefined, error: data.error ? String(data.error) : undefined, at: String(data.at ?? '') };
  return null;
}

/** That PC has the owed answers now: it need not keep them. */
export const owedTaken = (r: Remote, rids: string[]) => workerPost(r, '/worker/taken', { rids }, AbortSignal.timeout(5000)).then(() => undefined, () => undefined);

/** A linked PC's figures for one answer: kept for that PC and model (src/speed.ts), and handed back for the speed line. */
function keepRemoteSpeed(r: Remote, model: string, raw: unknown): Brain['last'] {
  const s = raw && typeof raw === 'object' ? (raw as { write?: unknown; tokens?: unknown; read?: unknown }) : null;
  const write = Number(s?.write);
  if (!s || !(write > 0)) return null;
  const speed = { write, tokens: Math.round(Number(s.tokens) || 0), ...(Number(s.read) > 0 ? { read: Number(s.read) } : {}) };
  if (model) d.speeds.add(speedKeys.pcKey(r.id, model), model, r.name, speed, 'answer');
  return speed;
}

export async function workerPost(r: Remote, path: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
  try {
    return await linkFetch(r, path, payload, signal);
  } catch (e) {
    if (signal?.aborted) throw new Error('Stopped.');
    if (relink(e)) throw e;
    throw new Error(`"${r.name}" could not be reached at ${r.url} (${(e as Error).message}). Is TOMLIN running there with sharing on?`);
  }
}

/** Why one of a linked PC's shared models cannot answer for this PC now ('' when it can: loaded there or loadable). */
export function sharedWhy(r: Remote, h: Hello, model: string): string {
  const name = sharedName(r.id, model);
  if (backupsOnly(r.id)) return backupsOnlyWhy(r.name);
  if (h.away) return `"${r.name}" is being used by its owner for now (they pressed "I need to use the pc")`;
  if (!h.can.includes('models')) return `"${r.name}" runs an older TOMLIN that cannot lend its models by name: update it there`;
  if (!h.models.some(x => x.id === model && x.kind === 'chat')) return `"${r.name}" no longer lets other PCs use ${name} (its owner ticks the models others may use under Nodes and memory)`;
  return '';
}

/** A linked PC's shared model by name: as it last said, else as kept, else from its file name. */
export function sharedName(pc: string, model: string): string {
  return seen.get(pc)?.models.find(x => x.id === model)?.name
    ?? d.store.peek()?.remotes.find(x => x.id === pc)?.models?.find(x => x.id === model)?.name
    ?? model.split(/[\\/]/).pop()!.replace(/\.gguf$/i, '');
}

// ---- Pictures on a paired PC ----

/**
 * A linked PC that can draw now. A ref naming one of its shared picture models (`remote:<pc>:<model>`): that PC, when it
 * still lets this one use it (it loads there when asked). A ref naming only the PC, or (anyPc) any linked PC: one with a
 * picture model loaded. `why`: what was found wrong with the named ones, for the message when none can draw.
 */
export async function pictureDrawer(refs: string[], anyPc: boolean, why: string[] = []): Promise<{ r: Remote; h: Hello; model?: string } | null> {
  const s = await d.store.settings();
  const named = refs.map(brains.parseRef).flatMap(b => (b.kind === 'remote' ? s.remotes.filter(r => r.id === b.pc).map(r => ({ r, model: b.model })) : []));
  for (const { r, model } of named.length ? named : anyPc ? s.remotes.map(r => ({ r, model: undefined })) : []) {
    if (r.backupsOnly) {
      if (model || named.length) why.push(backupsOnlyWhy(r.name));
      continue;
    }
    const h = await hello(r, 3000).catch(() => null);
    if (!h) {
      why.push(`"${r.name}" is off or not answering`);
      continue;
    }
    if (model) {
      const no = h.away ? `"${r.name}" is being used by its owner for now`
        : !h.can.includes('draw-models') ? `"${r.name}" runs an older TOMLIN that cannot lend its picture models: update it there`
        : !h.models.some(x => x.id === model && x.kind === 'image') ? `"${r.name}" no longer lets other PCs use ${sharedName(r.id, model)}` : '';
      if (!no) return { r, h, model };
      why.push(no);
    } else if (h.can.includes('draw') && h.image?.model) return { r, h };
  }
  return null;
}

/**
 * Asks a linked PC to draw: a prompt and a style in, the picture back. With `model` (one it lets this PC use) it draws on
 * that, loading it first, and while it draws for someone else this waits and asks again every 3 s (up to 10 minutes or
 * Stop); without, it uses its own loaded model (or another of its own for the style).
 */
export async function drawOn(r: Remote, ask: { prompt: string; style: string | null; width?: number; height?: number; model?: string; queue?: boolean }, progress: (p: Record<string, unknown>) => void, signal: AbortSignal): Promise<{ png: Buffer; modelName: string; modelPrompt: string; mode: string; seconds: number; note: string }> {
  let res: Response;
  const until = Date.now() + 10 * 60_000;
  let told = false;
  for (;;) {
    try {
      res = await linkFetch(r, '/worker/draw', ask, signal);
    } catch (e) {
      if (signal.aborted) throw new Error('Stopped.');
      if (relink(e)) throw e;
      throw new Error(`"${r.name}" could not be reached at ${r.url} (${(e as Error).message}).`);
    }
    if (res.ok || res.status !== 409 || !ask.model) break;
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.busy !== true || Date.now() > until) throw new Error(`"${r.name}": ${String(data.error ?? 'busy')}`);
    if (!told) progress({ text: `${sharedName(r.id, ask.model)} is drawing something else there. This picture starts when it is free (or press Stop)` });
    told = true;
    await sleep(3000);
    if (signal.aborted) throw new Error('Stopped.');
  }
  if (!res.ok || !res.body) throw new Error(`"${r.name}": ${String(((await res.json().catch(() => ({}))) as Record<string, unknown>).error ?? `answered ${res.status}`)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      // The node writes a line every 20 s while it draws: 75 s with nothing means it went off (as readStream).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const silent = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`"${r.name}" went quiet for 75 s while drawing (it may have been closed, asleep or off the network).`));
          void reader.cancel().catch(() => undefined);
        }, 75_000);
      });
      const { value, done } = await Promise.race([reader.read(), silent]).finally(() => clearTimeout(timer));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (\w+)/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') as Record<string, unknown>;
        if (ev === 'progress') progress(data);
        else if (ev === 'error') throw new Error(`"${r.name}" said: ${String(data.text)}`);
        else if (ev === 'picture') {
          const png = Buffer.from(String(data.png ?? ''), 'base64');
          // Only a PNG is taken in: anything else is not what was asked for.
          if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47 || png.length > 20 * 2 ** 20) throw new Error(`"${r.name}" sent something that is not a picture.`);
          return { png, modelName: String(data.modelName ?? ''), modelPrompt: String(data.modelPrompt ?? ''), mode: String(data.mode ?? 'custom'), seconds: Number(data.seconds) || 0, note: String(data.note ?? '') };
        }
      }
    }
  } catch (e) {
    if (signal.aborted) throw new Error('Stopped.');
    throw e;
  }
  throw new Error(`"${r.name}" stopped before the picture was finished (it may have been closed, or its picture model disconnected).`);
}

/**
 * Reads a linked PC's own log of the work it did for this PC, per project, and takes it as the final tally for that PC
 * (src/meter.ts). False when it did not answer, or keeps no log (before 2.0.40).
 */
export async function syncUsage(r: Remote, ms = 4000): Promise<boolean> {
  try {
    const res = await linkFetch(r, '/worker/usage', {}, AbortSignal.timeout(ms));
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { rows?: unknown };
    const rows = (Array.isArray(data.rows) ? data.rows : []).flatMap((x: Record<string, unknown>) => (typeof x?.project === 'string' && /^[\w-]{0,40}$/.test(x.project) ? [{ project: x.project, tally: cleanTally(x.tally), last: String(x.last ?? '') }] : []));
    d.usageTake(r.id, rows);
    return true;
  } catch {
    return false;
  }
}

/** Each paired worker PC, asked whether it is there and what model it has loaded. */
/** Linked PCs whose saved link can work, and those linked before links were encrypted (they need linking again). */
export async function linkCount(): Promise<{ working: number; broken: string[] }> {
  const s = await d.store.settings();
  return { working: s.remotes.filter(r => link.keysOf(r.key)).length, broken: s.remotes.filter(r => !link.keysOf(r.key)).map(r => r.name) };
}

export async function remoteStatus() {
  const s = await d.store.settings();
  return Promise.all(s.remotes.map(async r => {
    try {
      const h = await hello(r, 3000);
      const behind = update.updateWhy({ name: r.name, ok: true, version: h.version, build: h.build, away: h.away, can: h.can, restarts: h.restarts, allowUpdate: h.allow?.update === true }, d.version, d.build());
      // build: the 7 characters shown beside its version ('' from an older TOMLIN); update.other: the same version with
      // different files, and update.build this PC's, for "Runs 2.0.48 but different files from this PC (build x there, y here)".
      return { id: r.id, name: r.name, url: r.url, ok: true, model: h.model, ctx: h.ctx, version: h.version, build: update.shortBuild(h.build), memory: h.memory, can: h.can, image: h.image, away: h.away, models: h.models, allow: h.allow, disk: h.disk, backupsOnly: r.backupsOnly === true, update: behind === null ? null : { why: behind, mine: d.version, build: update.shortBuild(d.build()), other: update.standing(h, d.version, d.build()) === 'other' } };
    } catch (e) {
      return { id: r.id, name: r.name, url: r.url, ok: false, backupsOnly: r.backupsOnly === true, error: (e as Error).message, relink: relink(e), answered: (e as { answered?: boolean }).answered === true };
    }
  }));
}

/** What a paired PC said last, without asking again (null when it has not been asked yet). */
export const lastHello = (id: string) => seen.get(id) ?? null;

/**
 * A paired PC's meters now, for the top bar while a chat with someone on it is open: 'on' with the figures, 'old' when
 * its TOMLIN is from before meters were shared, 'off' when it does not answer in 2.5 s, 'gone' when it is not linked.
 * `model`: the chat model loaded there, as its last hello said (about once a minute), or null.
 */
export async function nodeStats(pc: string): Promise<{ state: 'on'; stats: nodestaff.NodeStats; name: string; model: string | null } | { state: 'old' | 'off' | 'gone'; name: string; model: string | null }> {
  const r = (await d.store.settings()).remotes.find(x => x.id === pc);
  if (!r) return { state: 'gone', name: '', model: null };
  const model = seen.get(pc)?.model ?? null;
  try {
    const res = await linkFetch(r, '/worker/stats', {}, AbortSignal.timeout(2500));
    if (res.status === 404) return { state: 'old', name: r.name, model };
    const stats = res.ok ? nodestaff.cleanStats(await res.json().catch(() => null)) : null;
    return stats ? { state: 'on', stats, name: r.name, model } : { state: 'off', name: r.name, model };
  } catch {
    return { state: 'off', name: r.name, model };
  }
}

/** A hire's linked PC keeps an answer when the connection is lost (src/outbox.ts): it said so in its last hello (2.0.38 on). */
export const canKeep = (ref: string) => {
  const x = brains.parseRef(ref);
  return x.kind === 'remote' && !!seen.get(x.pc)?.can.includes('outbox');
};

/** A hire's linked PC can think first when asked (Think): it said so in its last hello (2.0.31 on). */
export const canThink = (ref: string) => {
  const x = brains.parseRef(ref);
  return x.kind === 'remote' && !!seen.get(x.pc)?.can.includes('think');
};

export function startLinks(): void {
  // The main PC asks each linked PC once a minute, so "I need to log off for now" is told even with no page open.
  // Each answer (or not) is that PC's uptime check (src/meter.ts Uptime).
  // Each answer (or not) is that PC's uptime check; one that keeps a log of its work for this PC is read too.
  setInterval(() => void d.store.settings().then(s => Promise.all(s.remotes.map(r => hello(r, 3000).then(h => {
    d.uptimeMark(r.id, true);
    if (h.can.includes('usage')) return syncUsage(r);
  }, () => d.uptimeMark(r.id, false))))).catch(() => undefined), 60_000).unref();
}
