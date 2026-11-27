// A Videographer assigned to a linked PC makes its clip there (docs/PLAN-2026-11-25-VIDEOGRAPHER.md, phase 5). This PC
// sends the job over the sealed link (src/link.ts), follows the clip's progress as sealed events, can Stop it, and once
// it is made fetches the file in sealed pieces, written straight to disk here: a clip never sits whole in memory on
// either PC. The linked PC keeps the finished clip for its owner link only, until it is fetched (then deleted there) or
// KEEP_MS has passed, so a stream cut part way is followed again by asking for its state, never made twice.
//
// The far side (VideoNode) takes its VideoRunner by injection (setRunner), so the engine behind it can change. It takes
// no new clip while its owner pressed "I need to use the pc", while it is drawing a picture or already making a
// clip (a locked TOMLIN still makes them, as it draws pictures for linked PCs): each is a 'busy' VideoFault in a plain sentence. A PC that does not answer is
// 'pc-off', and the fault carries what the chat needs to offer the backup choices other hires get when their PC is off.
//
// Permissions: the doors below are a linked PC's only. A guest pass (src/guestpass.ts GUEST_DOORS) and a direct peer
// (src/peerlink.ts PEER_DOORS) list none of them, so both are refused before anything here runs; "Backups only" and a
// PC held by the cluster are refused here before anything is sent (videoWireFor). The prompt is cleaned as the picture
// door cleans it (spaces folded, 2,000 characters at most: a longer one is refused with a reason) and the characters a person cannot see are taken out; the
// chat on the asking PC reads it through the prompt scan first, as it does for a picture.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as link from './link.ts';
import * as share from './share.ts';
import { stripInvisible } from './promptscan.ts';
import { readPiece } from './carry.ts';
import type { Remote } from './store.ts';
import { backupsOnly, backupsOnlyWhy, clusterHeld, onHomeNetwork } from './jobrun/links.ts';
import { heldWhy } from './cluster/members.ts';
import { isPng, MAX_CLIP_SECONDS, MAX_START_BYTES, VideoFault, type VideoClip, type VideoFaultKind, type VideoJob, type VideoProgress, type VideoQuality, type VideoRunner } from './videotypes.ts';

export const VIDEO_MAKE = '/worker/video-make';
export const VIDEO_STATE = '/worker/video-state';
export const VIDEO_GET = '/worker/video-get';
export const VIDEO_STOP = '/worker/video-stop';
export const VIDEO_DROP = '/worker/video-drop';
export const VIDEO_DOORS: readonly string[] = [VIDEO_MAKE, VIDEO_STATE, VIDEO_GET, VIDEO_STOP, VIDEO_DROP];

/** One piece of a clip on the link: small enough that neither PC holds much of a clip at once. */
export const VIDEO_PIECE = 4 * 2 ** 20;
/** The largest clip taken from a linked PC (a few seconds of video is tens of MB). */
export const MAX_CLIP_BYTES = 2 * 2 ** 30;
/**
 * The largest sealed request to the make door: a job with its start picture (MAX_START_BYTES as base64, sealed, which is
 * base64 again). src/jobrun/node.ts reads the make door's body up to this; every other door keeps its small limit.
 */
export const VIDEO_MAKE_BODY = Math.ceil(MAX_START_BYTES * (4 / 3) * (4 / 3)) + (64 << 10);
/** A finished clip waits this long on the linked PC to be fetched, then it is deleted there. */
export const KEEP_MS = 30 * 60_000;
/** How long the stream may say nothing: the linked PC writes a line every 20 s while it works. */
export const QUIET_MS = 75_000;
/** After a stream is cut: how often its state is asked, and how long the linked PC may not answer before it counts as off. */
export const POLL_MS = 5_000;
export const LOST_MS = 90_000;
/** The longest prompt the link takes (spaces folded): a longer one is refused with a reason, never cut. */
export const LINK_PROMPT_MAX = 2000;
/** How long Stop waits for the linked PC to end the clip there, so the next clip finds its card free. */
export const STOP_WAIT_MS = 20_000;
/** How often the linked PC looks for finished clips kept past KEEP_MS (only while one waits to be fetched). */
export const SWEEP_MS = 250;
/** Clips stopped before their make request came, remembered at most this many (each for KEEP_MS). */
const EARLY_STOPS_MAX = 200;

const KINDS: readonly VideoFaultKind[] = ['not-installed', 'missing-model', 'out-of-memory', 'low-disk', 'crashed', 'stopped', 'busy', 'pc-off'];
const QUALITIES: readonly VideoQuality[] = ['draft', 'normal', 'best'];
const MIMES = ['video/mp4', 'video/webm'] as const;

// ---- words ----

export const awayWords = (pc: string) => `"${pc}" is being used by its owner for now (they pressed "I need to use the pc"), so it takes no new clips. Try again later, or move this hire to another PC.`;
export const makingWords = (pc: string) => `"${pc}" is already making a clip. Try again when that one is done.`;
export const busyWords = (pc: string, why: string) => `"${pc}" is busy (${why}), so it takes no new clips now. Try again in a few minutes.`;
export const noRunnerWords = (pc: string) => `"${pc}" has no video runner installed. Its owner installs it from Models there.`;
export const olderWords = (pc: string) => `"${pc}" runs an older TOMLIN that cannot make clips. Update TOMLIN there.`;
export const offWords = (pc: string) => `"${pc}" is off or not answering, so the clip was not made.`;
export const STOPPED = 'Stopped.';
export const tooLongWords = (n: number) => `the prompt is ${n.toLocaleString('en-GB')} characters once its @names are filled in, and a linked PC takes ${LINK_PROMPT_MAX.toLocaleString('en-GB')} at most. Shorten it, or name fewer characters and locations.`;

/**
 * A linked PC that is off: the fault carries `reasons` (as a hire's other faults do: "is off or not answering") and,
 * when the hire is named, `backup` with its id, so the chat offers "Pick a backup" with the same choices as for others.
 */
export type PcOff = VideoFault & { off: true; reasons: string[]; backup?: string };
export function pcOffFault(pc: string, hire?: { id: string; first: string }, more = ''): PcOff {
  const why = `"${pc}" is off or not answering`;
  const text = hire
    ? `${hire.first} cannot make the clip now: ${why}.${more ? ` ${more}` : ''} Pick a backup for ${hire.first} in their chat, or move ${hire.first} to another PC.`
    : `${offWords(pc)}${more ? ` ${more}` : ''}`;
  return Object.assign(new VideoFault('pc-off', text), { off: true as const, reasons: [why], ...(hire ? { backup: hire.id } : {}) });
}

const stopped = () => new VideoFault('stopped', STOPPED);
const kindOf = (v: unknown): VideoFaultKind | null => (KINDS.includes(v as VideoFaultKind) ? (v as VideoFaultKind) : null);

// ---- what crosses the link, read with care on both sides ----

const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : null);

/** A job as it came over the link, cleaned, or the reason it is refused. */
export function cleanJob(raw: unknown): VideoJob | { error: string } {
  const j = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  // As the picture door: spaces folded, 2,000 characters at most (a longer one is refused, never cut); and nothing a
  // person cannot see.
  const prompt = stripInvisible(String(j.prompt ?? '')).replace(/\s+/g, ' ').trim();
  if (!prompt) return { error: 'no prompt was sent.' };
  if (prompt.length > LINK_PROMPT_MAX) return { error: tooLongWords(prompt.length) };
  const seconds = int(j.seconds, 1, MAX_CLIP_SECONDS);
  if (seconds === null) return { error: `a clip is 1 to ${MAX_CLIP_SECONDS} seconds long.` };
  const width = int(j.width, 64, 2048);
  const height = int(j.height, 64, 2048);
  if (width === null || height === null) return { error: 'that clip size is not one TOMLIN makes.' };
  const quality = QUALITIES.includes(j.quality as VideoQuality) ? (j.quality as VideoQuality) : null;
  if (!quality) return { error: 'that quality is not one TOMLIN knows.' };
  const model = typeof j.model === 'string' ? j.model.trim() : '';
  if (!model || model.length > 300 || /[\0\r\n]/.test(model)) return { error: 'no video model was named.' };
  const seed = j.seed === undefined || j.seed === null ? undefined : int(j.seed, 0, 2 ** 32 - 1);
  if (seed === null) return { error: 'that seed is not a whole number TOMLIN takes.' };
  const negative = stripInvisible(String(j.negative ?? '')).replace(/\s+/g, ' ').trim().slice(0, 1000);
  const steps = j.steps === undefined || j.steps === null ? undefined : int(j.steps, 1, 60);
  if (steps === null) return { error: 'that number of steps is not one TOMLIN takes.' };
  return { prompt, seconds, width, height, quality, model, ...(seed === undefined ? {} : { seed }), ...(negative ? { negative } : {}), ...(steps === undefined ? {} : { steps }) };
}

/**
 * The start picture as it came over the link (base64 PNG in `job.start`): null when none was sent, else its bytes,
 * or the reason it is refused (too big, not a PNG).
 */
export function cleanStart(raw: unknown): Buffer | null | { error: string } {
  const j = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (j.start === undefined || j.start === null || j.start === '') return null;
  if (typeof j.start !== 'string' || j.start.length > Math.ceil(MAX_START_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(j.start)) return { error: `the start picture is not a PNG of ${MAX_START_BYTES / 2 ** 20} MB or less.` };
  const png = Buffer.from(j.start, 'base64');
  if (png.length > MAX_START_BYTES || !isPng(png)) return { error: `the start picture is not a PNG of ${MAX_START_BYTES / 2 ** 20} MB or less.` };
  return png;
}

export function cleanProgress(raw: unknown): VideoProgress | null {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!p || !['loading', 'making', 'joining'].includes(p.stage as string)) return null;
  const n = (v: unknown) => (Number.isFinite(v) && (v as number) >= 0 ? Math.min(Math.round(v as number), 1e9) : 0);
  const left = p.secondsLeft === null || p.secondsLeft === undefined ? null : n(p.secondsLeft);
  return { stage: p.stage as VideoProgress['stage'], done: n(p.done), total: n(p.total), secondsLeft: left };
}

/** A finished clip as the linked PC describes it (not the file: that comes in pieces). */
export interface ClipMeta {
  bytes: number;
  sha256: string;
  mime: VideoClip['mime'];
  seconds: number;
  width: number;
  height: number;
  model: string;
  tookMs: number;
}
export function cleanMeta(raw: unknown): ClipMeta | null {
  const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!m) return null;
  const bytes = int(m.bytes, 1, MAX_CLIP_BYTES);
  const sha256 = typeof m.sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.sha256) ? m.sha256 : null;
  const mime = MIMES.find(x => x === m.mime) ?? null;
  if (bytes === null || !sha256 || !mime) return null;
  const num = (v: unknown, hi: number) => (Number.isFinite(v) && (v as number) >= 0 ? Math.min(v as number, hi) : 0);
  return { bytes, sha256, mime, seconds: num(m.seconds, 3600), width: num(m.width, 8192), height: num(m.height, 8192), model: String(m.model ?? '').slice(0, 300), tookMs: num(m.tookMs, 86_400_000) };
}

/** Whether `head` (a file's first bytes) is the kind of video it says it is: mp4 has "ftyp" at byte 4, webm starts with EBML. */
export function looksLike(mime: ClipMeta['mime'], head: Buffer): boolean {
  if (mime === 'video/mp4') return head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp';
  return head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
}

const cleanCid = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : null);

// ---- the linked PC's side ----

/** What the linked PC tells the door about itself, read at each request. */
export interface VideoHere {
  name(): string;
  /** Its owner pressed "I need to use the pc": since when, or null. */
  away(): { since: string } | null;
  /** Why the card is taken by other work now (a picture being drawn), or null. */
  busy(): string | null;
}

/** How the door answers: a sealed JSON answer, a sealed stream of events, or one sealed piece of a file. */
export interface VideoOut {
  json(status: number, value: unknown): void;
  stream(): { send(event: string, data: unknown): void; end(): void };
  piece(bytes: Buffer): void;
}

interface Made {
  cid: string;
  owner: string;
  pcName: string;
  state: 'working' | 'done' | 'error';
  progress: VideoProgress | null;
  file?: string;
  meta?: ClipMeta;
  fault?: { kind: VideoFaultKind; text: string };
  ac: AbortController;
  endedAt: number;
  followers: Set<{ send(event: string, data: unknown): void; end(): void }>;
  /** Settles once the clip has ended there (made, failed or stopped), so Stop can wait for the card to be free. */
  ended: Promise<void>;
  over: () => void;
}

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** The receiving route on the linked PC. One clip at a time, for any linked PC; each link sees only its own clips. */
export class VideoNode {
  private runner: VideoRunner | null = null;
  private readonly here: VideoHere;
  private readonly made = new Map<string, Made>();
  private readonly remove: (file: string) => Promise<void>;
  private readonly keepMs: number;
  private readonly now: () => number;

  private readonly startDir: string;
  /** Clips Stop was pressed for before their make request came here (each link's own), and when. */
  private readonly early = new Map<string, { owner: string; at: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stopWaitMs: number;

  constructor(here: VideoHere, o: { remove?: (file: string) => Promise<void>; keepMs?: number; now?: () => number; startDir?: string; stopWaitMs?: number } = {}) {
    this.here = here;
    this.startDir = o.startDir ?? join(tmpdir(), 'tomlin-clip-starts');
    this.remove = o.remove ?? (file => rm(file, { force: true }));
    this.keepMs = o.keepMs ?? KEEP_MS;
    this.now = o.now ?? Date.now;
    this.stopWaitMs = o.stopWaitMs ?? STOP_WAIT_MS;
  }

  /**
   * While a finished clip waits to be fetched (or a stop came early), it is looked at on a timer, so a clip whose
   * asking PC never comes back is deleted after KEEP_MS without waiting for another request. The timer ends once
   * nothing waits.
   */
  private watch(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep();
      if (![...this.made.values()].some(m => m.state !== 'working') && !this.early.size) {
        clearInterval(this.timer!);
        this.timer = null;
      }
    }, SWEEP_MS);
    this.timer.unref?.();
  }

  /** The video runner on this PC (phase 2's), or null while there is none. */
  setRunner(runner: VideoRunner | null): void {
    this.runner = runner;
  }

  /** The clip being made now, if any (for the PC's own screens: "making a clip for ..."). */
  working(): { owner: string; progress: VideoProgress | null } | null {
    const m = [...this.made.values()].find(x => x.state === 'working');
    return m ? { owner: m.owner, progress: m.progress } : null;
  }

  /** Finished clips not fetched in time are deleted. */
  private sweep(): void {
    for (const m of this.made.values()) {
      if (m.state !== 'working' && this.now() - m.endedAt > this.keepMs) this.forget(m);
    }
    for (const [cid, e] of this.early) if (this.now() - e.at > this.keepMs) this.early.delete(cid);
  }

  private forget(m: Made): void {
    this.made.delete(m.cid);
    if (m.file) void this.remove(m.file).catch(() => undefined);
  }

  private mine(body: Record<string, unknown>, owner: string): Made | null {
    const cid = cleanCid(body.cid);
    const m = cid ? this.made.get(cid) : undefined;
    return m && m.owner === owner ? m : null;
  }

  private view(m: Made) {
    return { cid: m.cid, state: m.state, progress: m.progress, ...(m.meta ? { clip: m.meta } : {}), ...(m.fault ? { fault: m.fault } : {}) };
  }

  private follow(m: Made, out: VideoOut): void {
    const s = out.stream();
    if (m.progress) s.send('progress', m.progress);
    if (m.state === 'done') {
      s.send('clip', { cid: m.cid, ...m.meta });
      return s.end();
    }
    if (m.state === 'error') {
      s.send('error', m.fault);
      return s.end();
    }
    m.followers.add(s);
  }

  /** One request from a linked PC, already opened and checked by the worker door. `owner`: that link's own key. */
  async handle(path: string, body: Record<string, unknown>, owner: { key: string; name: string }, out: VideoOut): Promise<void> {
    this.sweep();
    const pc = this.here.name();
    if (path === VIDEO_STATE) {
      if (body.cid === undefined) return out.json(200, { installed: !!this.runner && (await this.runner.installed().catch(() => false)) });
      const m = this.mine(body, owner.key);
      return m ? out.json(200, this.view(m)) : out.json(404, { error: `"${pc}" has no such clip (it was fetched, or kept too long and deleted).`, kind: 'crashed' });
    }
    if (path === VIDEO_STOP) {
      const m = this.mine(body, owner.key);
      if (m?.state === 'working') {
        // Answered once the clip has ended here (its runner is ended and waited for), so the asking PC's next clip
        // finds the card free; at most STOP_WAIT_MS.
        m.ac.abort();
        let t: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([m.ended, new Promise(r => (t = setTimeout(r, this.stopWaitMs)))]);
        clearTimeout(t);
        return out.json(200, { ok: true, ended: m.state !== 'working' });
      }
      // Stop came before the clip's make request (a large start picture still on its way): that clip is never made.
      const cid = cleanCid(body.cid);
      if (cid && !m && !this.made.has(cid)) {
        if (this.early.size >= EARLY_STOPS_MAX) this.early.delete(this.early.keys().next().value!);
        this.early.set(cid, { owner: owner.key, at: this.now() });
        this.watch();
      }
      return out.json(200, { ok: true });
    }
    if (path === VIDEO_DROP) {
      const m = this.mine(body, owner.key);
      if (m && m.state !== 'working') this.forget(m);
      return out.json(200, { ok: true });
    }
    if (path === VIDEO_GET) {
      const m = this.mine(body, owner.key);
      if (!m || m.state !== 'done' || !m.file || !m.meta) return out.json(404, { error: `"${pc}" has no finished clip by that id.`, kind: 'crashed' });
      const at = int(body.at, 0, m.meta.bytes - 1);
      if (at === null) return out.json(400, { error: 'that part of the clip is past its end.' });
      return out.piece(await readPiece(m.file, at, Math.min(VIDEO_PIECE, m.meta.bytes - at)));
    }
    if (path !== VIDEO_MAKE) return out.json(404, { error: `"${pc}" has no such door.` });
    const cid = cleanCid(body.cid);
    if (!cid) return out.json(400, { error: 'the clip had no id.' });
    // Asked again with the same id (the stream was cut): followed, never made twice.
    const had = this.made.get(cid);
    if (had) return had.owner === owner.key ? this.follow(had, out) : out.json(409, { error: 'that clip id is taken.', kind: 'crashed' });
    const early = this.early.get(cid);
    if (early && early.owner === owner.key) {
      this.early.delete(cid);
      return out.json(409, { error: STOPPED, kind: 'stopped' });
    }
    if (!this.runner) return out.json(501, { error: noRunnerWords(pc), kind: 'not-installed' });
    if (this.here.away()) return out.json(503, { error: awayWords(pc), kind: 'busy', away: this.here.away()!.since });
    if ([...this.made.values()].some(x => x.state === 'working')) return out.json(409, { error: makingWords(pc), kind: 'busy', busy: true });
    const other = this.here.busy();
    if (other) return out.json(409, { error: busyWords(pc, other), kind: 'busy', busy: true });
    const job = cleanJob(body.job);
    if ('error' in job) return out.json(400, { error: job.error });
    const start = cleanStart(body.job);
    if (start && 'error' in start) return out.json(400, { error: start.error });
    let over = () => undefined as void;
    const ended = new Promise<void>(r => (over = r));
    const m: Made = { cid, owner: owner.key, pcName: owner.name, state: 'working', progress: null, ac: new AbortController(), endedAt: 0, followers: new Set(), ended, over };
    this.made.set(cid, m);
    const first = out.stream();
    m.followers.add(first);
    const tell = (event: string, data: unknown) => {
      for (const f of m.followers) f.send(event, data);
    };
    const end = () => {
      m.endedAt = this.now();
      for (const f of m.followers) f.end();
      m.followers.clear();
    };
    // Runs to its end even when the asking PC goes away (a cut stream is followed again by its id); only Stop ends it early.
    let startFile = '';
    try {
      if (start) {
        // Written here for the runner, under this clip's own id, and removed once the clip ends.
        await mkdir(this.startDir, { recursive: true });
        startFile = join(this.startDir, `start-${cid}.png`);
        await writeFile(startFile, start);
        job.startPicture = startFile;
      }
      const clip = await this.runner.make(job, p => {
        const c = cleanProgress(p);
        if (!c) return;
        m.progress = c;
        tell('progress', c);
      }, m.ac.signal);
      const st = await stat(clip.file);
      if (st.size > MAX_CLIP_BYTES) throw new VideoFault('crashed', `the clip "${pc}" made is larger than ${MAX_CLIP_BYTES / 2 ** 30} GB, so it was not sent.`);
      m.file = clip.file;
      m.meta = { bytes: st.size, sha256: await sha256Of(clip.file), mime: clip.mime, seconds: clip.seconds, width: clip.width, height: clip.height, model: clip.model, tookMs: clip.tookMs };
      m.state = 'done';
      tell('clip', { cid, ...m.meta });
    } catch (e) {
      const kind = e instanceof VideoFault ? e.kind : m.ac.signal.aborted ? 'stopped' : 'crashed';
      const text = kind === 'stopped' ? STOPPED : e instanceof VideoFault ? e.message : `the video runner on "${pc}" stopped by itself (${(e as Error).message}).`;
      m.fault = { kind, text };
      m.state = 'error';
      tell('error', m.fault);
    } finally {
      if (startFile) await rm(startFile, { force: true }).catch(() => undefined);
      end();
      m.over();
      this.watch();
    }
  }
}

// ---- this PC's side ----

/** How this PC calls the linked PC: a request that may answer with a stream, a plain request, and a piece of a file. */
export interface VideoWire {
  /** The opened answer: a stream of plain events (text/event-stream) or JSON. Throws a pc-off-able error when unreachable. */
  stream(path: string, body: unknown, signal: AbortSignal): Promise<Response>;
  ask(path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }>;
  /** The piece, opened, or throws the fault the linked PC said. */
  getPiece(path: string, body: unknown, signal?: AbortSignal): Promise<Buffer>;
}

/** A request that never reached the linked PC (off, asleep, off the network). */
type Unreachable = Error & { unreachable: true };
const unreachable = (e: unknown) => (e as Partial<Unreachable>)?.unreachable === true;

/** A refusal from the linked PC as a VideoFault: its own kind and words, or what its status means. */
export function refusalFault(pc: string, status: number, body: Record<string, unknown>): VideoFault {
  const said = typeof body.error === 'string' && body.error ? body.error : '';
  const kind = kindOf(body.kind) ?? (status === 503 || status === 409 || status === 429 ? 'busy' : status === 404 && !said ? 'not-installed' : 'crashed');
  const text = said ? (said.startsWith('"') ? said : `"${pc}": ${said}`) : status === 404 ? olderWords(pc) : `"${pc}" refused the clip (it answered ${status}).`;
  return new VideoFault(kind, text);
}

/** A linked PC as the settings keep it. */
export interface LinkedPc {
  name: string;
  url: string;
  token: string;
  key?: string;
}

/**
 * The sealed wire to a linked PC: each request sealed with the link's keys, each answer opened (a stream's events in
 * order, a piece by its request). `guard` runs before every request (the home-network check, Backups only, the cluster).
 */
export function sealedWire(r: LinkedPc, o: { guard?: () => Promise<void> | void } = {}): VideoWire {
  const keys = link.keysOf(r.key);
  if (!keys) throw new VideoFault('crashed', `"${r.name}" was linked before links were encrypted. Link it again: Network, Find PCs on my network, then its setup code.`);
  const send = async (path: string, body: unknown, signal?: AbortSignal) => {
    await o.guard?.();
    let dropped = false;
    let clockTried = false;
    for (;;) {
      const req = link.sealRequest(keys, path, body, link.nodeNow(r.url));
      let res: Response;
      try {
        res = await fetch(`${r.url}${path}`, { method: 'POST', headers: { authorization: `Link ${share.hashToken(r.token)}`, 'content-type': 'application/json', [link.BODY_PROOF]: link.bodyProof(keys, path, link.nodeNow(r.url)) }, body: JSON.stringify(req), signal });
      } catch (e) {
        // A request given up for time is a PC not answering (followed as one), never a Stop.
        if (signal?.aborted && (signal.reason as Error | undefined)?.name === 'TimeoutError') throw Object.assign(new Error(`"${r.name}" did not answer in time.`), { unreachable: true as const });
        if (signal?.aborted) throw stopped();
        // Once more, sealed afresh, after a moment: a kept connection the other PC had closed fails the first try.
        if (!dropped) {
          dropped = true;
          await new Promise(res => setTimeout(res, 300));
          continue;
        }
        throw Object.assign(new Error(`"${r.name}" could not be reached (${(e as Error).message}).`), { unreachable: true as const });
      }
      link.noteClock(r.url, res.headers.get('date'));
      // A refusal for the time teaches its clock (noteClock), and the request goes once more.
      if (!clockTried && (res.status === 400 || res.status === 401 || res.status === 403)) {
        clockTried = true;
        const first = (await link.readCapped(res.clone(), 64 << 10).then(t => JSON.parse(t)).catch(() => ({}))) as { error?: unknown };
        if (link.clockRefused(first.error)) continue;
      }
      return { res, id: link.requestId(req.box) };
    }
  };
  const opened = async (res: Response, id: string): Promise<Record<string, unknown>> => {
    // At most the largest answer there can be, given up when it goes quiet (U1).
    const data = (await link.readCapped(res).then(t => JSON.parse(t) as Record<string, unknown>).catch(() => ({}))) as Record<string, unknown>;
    if (typeof data.box === 'string') {
      const v = link.openAnswer(keys, id, 0, data.box);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    }
    if (res.ok) throw new VideoFault('crashed', `"${r.name}" answered without the encrypted link, so the answer was not used. Update TOMLIN there, then link it again.`);
    return data;
  };
  return {
    async stream(path, body, signal) {
      const { res, id } = await send(path, body, signal);
      if ((res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
        if (!res.body) throw new VideoFault('crashed', `"${r.name}" sent nothing back.`);
        return new Response(link.openStream(keys, id, res.body), { status: res.status, headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json(await opened(res, id), { status: res.status });
    },
    async ask(path, body, signal) {
      const { res, id } = await send(path, body, signal ?? AbortSignal.timeout(15_000));
      return { status: res.status, body: await opened(res, id) };
    },
    async getPiece(path, body, signal) {
      const { res, id } = await send(path, body, signal ?? AbortSignal.timeout(120_000));
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('application/octet-stream')) throw refusalFault(r.name, res.status, await opened(res, id));
      const piece = link.openBytes(link.toHost(keys), await link.readCappedBytes(res, VIDEO_PIECE + (64 << 10)), `piece|${id}`);
      if (!piece) throw new VideoFault('crashed', `a piece of the clip from "${r.name}" could not be opened (changed on the way), so it was refused.`);
      return piece;
    },
  };
}

/** Reads one clip's stream: its progress, then the clip's description or the fault it said. Null when the stream was cut. */
async function readClip(res: Response, onProgress: (p: VideoProgress) => void, quietMs: number): Promise<{ meta: ClipMeta } | { fault: VideoFault } | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const quiet = new Promise<'quiet'>(resolve => {
        timer = setTimeout(() => resolve('quiet'), quietMs);
      });
      const got = await Promise.race([reader.read(), quiet]).catch(() => 'cut' as const).finally(() => clearTimeout(timer));
      if (got === 'quiet' || got === 'cut' || got.done) return null;
      buf += dec.decode(got.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (\w+)/m.exec(block)?.[1];
        if (!ev) continue;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') as Record<string, unknown>;
        } catch {
          return null;
        }
        if (ev === 'progress') {
          const p = cleanProgress(data);
          if (p) onProgress(p);
        } else if (ev === 'error') {
          return { fault: new VideoFault(kindOf(data.kind) ?? 'crashed', String(data.text ?? 'the clip was not made.')) };
        } else if (ev === 'clip') {
          const meta = cleanMeta(data);
          return meta ? { meta } : { fault: new VideoFault('crashed', 'the linked PC described a clip TOMLIN cannot take.') };
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export interface RemoteVideoOptions {
  /** The linked PC's name, as people read it. */
  pc: string;
  wire: VideoWire;
  /** The folder on this PC the finished clip is written to. */
  dir: string;
  /** The hire the clip is for: named in a pc-off fault, so the chat offers "Pick a backup" for them. */
  hire?: { id: string; first: string };
  quietMs?: number;
  pollMs?: number;
  lostMs?: number;
}

/**
 * A VideoRunner whose clips are made on a linked PC: the job goes over the link, the progress comes back, Stop stops
 * it there, and the finished file is fetched in sealed pieces, checked (its kind, its length, its SHA-256) and only then
 * given its name here.
 */
export class RemoteVideoRunner implements VideoRunner {
  private readonly o: Required<Omit<RemoteVideoOptions, 'hire'>> & Pick<RemoteVideoOptions, 'hire'>;

  constructor(o: RemoteVideoOptions) {
    this.o = { quietMs: QUIET_MS, pollMs: POLL_MS, lostMs: LOST_MS, ...o };
  }

  async installed(): Promise<boolean> {
    try {
      const a = await this.o.wire.ask(VIDEO_STATE, {});
      return a.status === 200 && a.body.installed === true;
    } catch {
      return false;
    }
  }

  async make(job: VideoJob, onProgress: (p: VideoProgress) => void, signal: AbortSignal): Promise<VideoClip> {
    const { pc, wire } = this.o;
    if (signal.aborted) throw stopped();
    // The id it is made under there: the one this PC kept for it (a take cut by a restart here is followed, not made
    // again), else a new one.
    const cid = cleanCid(job.linkId) ?? randomBytes(16).toString('hex');
    // The start picture goes with the job (inside the sealed request), never its path on this PC; the link id is not sent.
    const { startPicture, linkId: _kept, ...plain } = job;
    let sent: Record<string, unknown> = plain;
    if (startPicture) {
      const png = await readFile(startPicture).catch(() => null);
      if (!png || png.length > MAX_START_BYTES || !isPng(png)) throw new VideoFault('crashed', `The start picture could not be sent to "${pc}": it is missing or not a PNG of ${MAX_START_BYTES / 2 ** 20} MB or less.`);
      sent = { ...plain, start: png.toString('base64') };
    }
    // Refused here before anything is sent: the linked PC would refuse it too (cleanJob).
    const folded = String(plain.prompt ?? '').replace(/\s+/g, ' ').trim();
    if (folded.length > LINK_PROMPT_MAX) throw new VideoFault('crashed', `"${pc}": ${tooLongWords(folded.length)}`);
    // Stop here stops it there too (the clip there runs on when only the connection closes). The stop is waited for
    // (the linked PC answers once the clip has ended there), so the next clip for that PC finds its card free; one
    // sent before the make request arrived there means that clip is never started.
    let stopping: Promise<unknown> = Promise.resolve();
    const stop = () => {
      stopping = wire.ask(VIDEO_STOP, { cid }, AbortSignal.timeout(STOP_WAIT_MS + 5000)).catch(() => undefined);
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      let res: Response | null = null;
      // The make request is answered with the stream's start at once; a PC that takes it and never answers is not
      // waited on for ever: its state is asked instead (followAgain), and it counts as off after lostMs.
      const heard = new AbortController();
      const deaf = setTimeout(() => heard.abort(new DOMException(`"${pc}" did not answer.`, 'TimeoutError')), this.o.quietMs);
      try {
        res = await wire.stream(VIDEO_MAKE, { cid, job: sent }, AbortSignal.any([signal, heard.signal]));
      } catch (e) {
        if (signal.aborted) throw stopped();
        if (!heard.signal.aborted) {
          if (unreachable(e)) throw pcOffFault(pc, this.o.hire);
          throw e;
        }
      } finally {
        clearTimeout(deaf);
      }
      if (res && !(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
        throw refusalFault(pc, res.status, (await res.json().catch(() => ({}))) as Record<string, unknown>);
      }
      let got = res ? await readClip(res, onProgress, this.o.quietMs) : null;
      if (!got) got = await this.followAgain(cid, onProgress, signal);
      if ('fault' in got) throw got.fault;
      const clip = await this.fetchClip(cid, got.meta, signal);
      void wire.ask(VIDEO_DROP, { cid }, AbortSignal.timeout(5000)).catch(() => undefined);
      return clip;
    } catch (e) {
      if (signal.aborted && !(e instanceof VideoFault && e.kind === 'pc-off')) {
        await stopping;
        throw stopped();
      }
      throw e;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  /** The stream was cut: the clip runs on there, so its state is asked until it is done, said a fault, or the PC is gone. */
  private async followAgain(cid: string, onProgress: (p: VideoProgress) => void, signal: AbortSignal): Promise<{ meta: ClipMeta } | { fault: VideoFault }> {
    const { pc, wire, pollMs, lostMs } = this.o;
    let lastHeard = Date.now();
    for (;;) {
      if (signal.aborted) throw stopped();
      try {
        // Each ask is given up within the time the PC may stay silent, so a PC that never answers is called off in time.
        const a = await wire.ask(VIDEO_STATE, { cid }, AbortSignal.timeout(Math.max(pollMs, Math.min(5000, lostMs))));
        lastHeard = Date.now();
        if (a.status !== 200) return { fault: refusalFault(pc, a.status, a.body) };
        const p = cleanProgress(a.body.progress);
        if (p) onProgress(p);
        if (a.body.state === 'done') {
          const meta = cleanMeta(a.body.clip);
          return meta ? { meta } : { fault: new VideoFault('crashed', `"${pc}" described a clip TOMLIN cannot take.`) };
        }
        if (a.body.state === 'error') {
          const f = a.body.fault as Record<string, unknown> | undefined;
          return { fault: new VideoFault(kindOf(f?.kind) ?? 'crashed', String(f?.text ?? 'the clip was not made.')) };
        }
      } catch (e) {
        if (signal.aborted) throw stopped();
        if (!unreachable(e) && !(e instanceof Error && e.name === 'TimeoutError')) throw e;
        if (Date.now() - lastHeard > lostMs) throw pcOffFault(pc, this.o.hire, 'It stopped answering while it made the clip.');
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  /** The clip in pieces, straight to a .part file here, checked, then named. Never whole in memory. */
  private async fetchClip(cid: string, meta: ClipMeta, signal: AbortSignal): Promise<VideoClip> {
    const { pc, wire, dir } = this.o;
    const name = `clip-${new Date().toISOString().replace(/[:.]/g, '-')}-${cid.slice(0, 8)}.${meta.mime === 'video/mp4' ? 'mp4' : 'webm'}`;
    const file = join(dir, name);
    const part = `${file}.part`;
    const h = await open(part, 'w');
    let done = false;
    try {
      const hash = createHash('sha256');
      let at = 0;
      while (at < meta.bytes) {
        if (signal.aborted) throw stopped();
        let piece: Buffer | null = null;
        for (let tries = 0; !piece; tries++) {
          try {
            piece = await wire.getPiece(VIDEO_GET, { cid, at });
          } catch (e) {
            if (!unreachable(e) || tries >= 2) throw unreachable(e) ? pcOffFault(pc, this.o.hire, 'It stopped answering while the clip was being sent here.') : e;
            await new Promise(r => setTimeout(r, Math.min(this.o.pollMs, 3000)));
          }
        }
        if (!piece.length || piece.length > VIDEO_PIECE || at + piece.length > meta.bytes) throw new VideoFault('crashed', `"${pc}" sent a piece of the clip that does not fit, so the clip was not kept.`);
        if (at === 0 && !looksLike(meta.mime, piece)) throw new VideoFault('crashed', `"${pc}" sent something that is not a video, so it was not kept.`);
        hash.update(piece);
        await h.write(piece, 0, piece.length, at);
        at += piece.length;
      }
      if (hash.digest('hex') !== meta.sha256) throw new VideoFault('crashed', `the clip from "${pc}" changed on the way (its check did not match), so it was not kept. Try again.`);
      await h.close();
      await rename(part, file);
      done = true;
      return { file, mime: meta.mime, bytes: meta.bytes, seconds: meta.seconds, width: meta.width, height: meta.height, model: meta.model, tookMs: meta.tookMs };
    } finally {
      if (!done) {
        await h.close().catch(() => undefined);
        await rm(part, { force: true }).catch(() => undefined);
      }
    }
  }
}

/** The wire to a linked PC as the settings keep it: refused before anything is sent when it is Backups only or held by the cluster. */
export function videoWireFor(r: Remote): VideoWire {
  return sealedWire(r, {
    guard: async () => {
      if (backupsOnly(r.id)) throw new VideoFault('busy', backupsOnlyWhy(r.name));
      if (clusterHeld(r.id)) throw new VideoFault('busy', heldWhy(r.name));
      try {
        await onHomeNetwork(r);
      } catch (e) {
        throw new VideoFault('crashed', (e as Error).message);
      }
    },
  });
}
