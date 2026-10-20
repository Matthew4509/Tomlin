// Runners sent from one PC to a linked PC (2.0.56): a host downloads a CUDA runner's zips once and sends them over the
// encrypted link in the sealed pieces copies use (src/carry.ts), so a node with an NVIDIA card gets it without anyone
// at that PC. No tick is asked there: what keeps it safe is that the node takes only the build its OWN runtimes.json
// pins (the same parts, sizes and SHA-256), names the files itself, checks every zip's SHA-256 before anything is
// unpacked, and unpacks into its home's runtime folder only. Tested in test/runnerpush.test.ts; the doors are in
// src/jobrun/node.ts (the node) and src/jobrun/copies.ts (the host).
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sha256 } from './download.ts';
import { addPiece, finish, freeBytes, partOf, readPiece, roomWhy, sizeOf, type NodeAnswer, type Progress, type Wire } from './carry.ts';
import type { Device, Engine, RuntimePin, Runtimes } from './runtimes.ts';

/** Where a runner is with a node, as its hello says it. */
export type RunnerState = 'none' | 'coming' | 'checking' | 'unpacking' | 'installed' | 'failed';
const STATES: RunnerState[] = ['none', 'coming', 'checking', 'unpacking', 'installed', 'failed'];

/** What a node says about its runners in its hello (2.0.56 on). */
export interface RunnerHello {
  /** It has an NVIDIA card of its own. */
  nvidia: boolean;
  /** Its NVIDIA driver's version, when nvidia-smi gave one. */
  driver: string | null;
  /** Why the CUDA runner cannot help there ('' when it can). */
  why: string;
  /** Its CUDA chat runner. */
  cuda: RunnerState;
  /** The last word about it (ready, or why it failed). */
  said: string;
  /** The last chat model start there: on which device, how long it took, and the runner's own lines about the card. */
  last: { device: string; seconds: number | null; lines: string[] } | null;
}

/** The unpacked runners' share of the room needed, against their zips (a CUDA build is about 1.6 times its zips). */
const UNPACKED = 2;

/** A line from a runner's start worth keeping: which device it found, and how much of the model went on it. */
export function startFact(line: string): boolean {
  return /ggml_cuda_init:|^\s*Device \d+:|ggml_vulkan: (Found|\d+ =)|offloaded \d+\/\d+ layers|graph splits|no usable GPU|using device/i.test(line);
}

/** A runner part of a hello as the host keeps it: each field checked, the words cut short; null from an older TOMLIN. */
export function cleanRunner(raw: unknown): RunnerHello | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const text = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
  const l = o.last && typeof o.last === 'object' ? (o.last as Record<string, unknown>) : null;
  return {
    nvidia: o.nvidia === true,
    driver: typeof o.driver === 'string' && /^\d+(\.\d+)+$/.test(o.driver) ? o.driver : null,
    why: text(o.why, 300),
    cuda: STATES.includes(o.cuda as RunnerState) ? (o.cuda as RunnerState) : 'none',
    said: text(o.said, 300),
    last: l
      ? {
        device: text(l.device, 12),
        seconds: typeof l.seconds === 'number' && Number.isFinite(l.seconds) ? l.seconds : null,
        lines: (Array.isArray(l.lines) ? l.lines : []).filter((x): x is string => typeof x === 'string').slice(0, 12).map(x => x.slice(0, 200)),
      }
      : null,
  };
}

/** A linked PC as far as sending it a runner goes. */
export interface RunnerPc {
  name: string;
  ok: boolean;
  away: string | null;
  can: string[];
  backupsOnly?: boolean;
  runner: RunnerHello | null;
}

/** Why the CUDA runner cannot be sent to a linked PC now ('' when it can). */
export function sendRunnerWhy(pc: RunnerPc): string {
  if (!pc.ok) return `"${pc.name}" is off or not answering now.`;
  if (pc.away) return `"${pc.name}" is being used by its owner for now.`;
  if (!pc.can.includes('runner') || !pc.runner) return `"${pc.name}" runs an older TOMLIN that cannot take a runner: update it first (Network: connect PCs, Update).`;
  if (pc.backupsOnly) return `"${pc.name}" is set to Backups only: no runner is sent to it (untick Backups only on its card to use it for models).`;
  if (pc.runner.why) return pc.runner.why;
  if (pc.runner.cuda === 'installed') return `"${pc.name}" already has it.`;
  return '';
}

export interface RunnerNodeDeps {
  runtimes: Runtimes;
  pcName: () => string;
  /** Why this PC cannot use a runner for `device` ('' when it can): src/runtimes.ts runnerWhy with its own cards. */
  why: (device: Device) => string;
  freeBytes?: (dir: string) => Promise<number>;
  /** True while a model runs on that device here (its runner cannot be taken away then). */
  inUse?: (device: Device) => boolean;
  /** Told when a runner was installed or taken away here. */
  onChange?: () => void;
}

const no = (status: number, error: string): NodeAnswer => ({ status, json: { error } });
const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : -1);

/** The doors of a node for runners: /worker/runner-offer, -put, -state, -drop and -remove. */
export function runnerSide(d: RunnerNodeDeps) {
  const room = d.freeBytes ?? freeBytes;
  const jobs = new Map<string, { state: RunnerState; said: string }>();
  const writing = new Map<string, { pc: string; at: number }>();
  const claim = (file: string, pc: string): boolean => {
    const w = writing.get(file);
    if (w && w.pc !== pc && Date.now() - w.at < 120_000) return false;
    writing.set(file, { pc, at: Date.now() });
    return true;
  };

  function state(id: string): { state: RunnerState; said: string } {
    const job = jobs.get(id);
    if (job && job.state !== 'installed') return { ...job };
    const pin = d.runtimes.pins[id];
    if (pin && d.runtimes.installed(pin.engine, pin.device)) return { state: 'installed', said: job?.said ?? '' };
    return { state: 'none', said: '' };
  }

  /** The runner a host names, checked against this PC's own pin; the files it goes into are named here. */
  function asked(b: Record<string, unknown>): { id: string; pin: RuntimePin; engine: Engine; device: Device; files: { path: string; bytes: number; sha256: string }[] } | string {
    const id = typeof b.id === 'string' ? b.id.slice(0, 40) : '';
    const pin = d.runtimes.pins[id];
    if (!pin) return `"${d.pcName()}" does not know the runner ${id || '(none named)'}: update TOMLIN there first.`;
    if (pin.device !== 'cuda') return 'Only the NVIDIA (CUDA) runners are sent between PCs; the others come with TOMLIN.';
    const why = d.why(pin.device);
    if (why) return why;
    const sent = (Array.isArray(b.parts) ? b.parts : []).slice(0, 8).map(p => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {}));
    const same = sent.length === pin.parts.length && pin.parts.every((p, k) => sent[k].sha256 === p.sha256 && int(sent[k].bytes) === p.bytes);
    if (!same) return `"${d.pcName()}" pins another build of that runner: update TOMLIN on both PCs so they are the same version.`;
    return { id, pin, engine: pin.engine, device: pin.device, files: pin.parts.map((p, k) => ({ path: d.runtimes.zipOf(pin.engine, pin.device, k), bytes: p.bytes, sha256: p.sha256 })) };
  }

  const allWhole = async (files: { path: string; bytes: number }[]) => (await Promise.all(files.map(f => sizeOf(f.path)))).every((n, k) => n === files[k].bytes);

  /** Every zip is here: each is checked against the pin, then the runner is unpacked (in the background; -state follows it). */
  async function settle(a: Exclude<ReturnType<typeof asked>, string>): Promise<void> {
    const job = { state: 'checking' as RunnerState, said: '' };
    jobs.set(a.id, job);
    try {
      for (const f of a.files) {
        if ((await sha256(f.path)) !== f.sha256) {
          await rm(f.path, { force: true });
          throw new Error(`A file of ${a.pin.name} changed on the way to "${d.pcName()}" (its SHA-256 did not match), so it was thrown away. Send it again.`);
        }
      }
      job.state = 'unpacking';
      await d.runtimes.unpack(a.engine, a.device, a.files.map(f => f.path));
      job.state = 'installed';
      job.said = `${a.pin.name} is ready on "${d.pcName()}": the next model loaded there uses it.`;
      d.onChange?.();
    } catch (e) {
      job.state = 'failed';
      job.said = (e as Error).message;
    }
  }

  async function handle(p: string, b: Record<string, unknown>, who: { key: string; name: string }, piece?: Buffer): Promise<NodeAnswer> {
    if (p === '/worker/runner-state') {
      const id = typeof b.id === 'string' ? b.id : '';
      return { status: 200, json: { ...state(id) } };
    }
    if (p === '/worker/runner-remove') {
      const pin = d.runtimes.pins[typeof b.id === 'string' ? b.id : ''];
      if (!pin || pin.device !== 'cuda') return no(400, 'Only a runner sent here can be taken away from here.');
      if (d.inUse?.(pin.device)) return no(409, `a model runs on it on "${d.pcName()}" now: drop that model there first, then remove the runner.`);
      try {
        await d.runtimes.remove(pin.engine, pin.device);
      } catch (e) {
        return no(409, `It could not be taken away on "${d.pcName()}" (${(e as Error).message.replace(/\.$/, '')}). Drop every model there and try again.`);
      }
      jobs.delete(String(b.id));
      d.onChange?.();
      return { status: 200, json: { ok: true } };
    }
    const a = asked(b);
    if (typeof a === 'string') return no(403, a);
    const now = state(a.id).state;
    switch (p) {
      case '/worker/runner-offer': {
        if (now === 'installed') return { status: 200, json: { have: true } };
        const at = await Promise.all(a.files.map(async f => ((await sizeOf(f.path)) === f.bytes ? f.bytes : sizeOf(partOf(f.path)))));
        // Checking or unpacking already: nothing more to send, the host follows it.
        if (now === 'checking' || now === 'unpacking') return { status: 200, json: { have: false, at: a.files.map(f => f.bytes) } };
        jobs.set(a.id, { state: 'coming', said: '' });
        const need = a.files.reduce((n, f, k) => n + f.bytes - Math.min(at[k], f.bytes), 0) + a.files.reduce((n, f) => n + f.bytes, 0) * UNPACKED;
        const why = roomWhy(need, await room(dirname(a.files[0].path)), `"${d.pcName()}"`);
        if (why) {
          jobs.delete(a.id);
          return no(507, why);
        }
        // Every zip came whole before (the last send stopped while checking): checked and unpacked now.
        if (await allWhole(a.files)) void settle(a);
        return { status: 200, json: { have: false, at } };
      }
      case '/worker/runner-put': {
        const f = a.files[int(b.file)];
        if (!f || !piece) return no(400, 'that piece is not part of the runner.');
        if ((await sizeOf(f.path)) === f.bytes) return { status: 409, json: { error: 'that file of the runner is whole here already.', at: f.bytes } };
        if (!claim(f.path, who.key)) return no(409, `another PC is sending that runner to "${d.pcName()}" now.`);
        const r = await addPiece(partOf(f.path), int(b.from), piece);
        if ('error' in r) return { status: 409, json: r };
        if (r.at > f.bytes) {
          await rm(partOf(f.path), { force: true });
          return no(400, 'more came than the file holds, so it was thrown away. Send it again.');
        }
        const done = r.at === f.bytes && (await finish(partOf(f.path), f.path, f.bytes));
        if (done) {
          writing.delete(f.path);
          if (await allWhole(a.files)) void settle(a);
        }
        return { status: 200, json: { at: r.at, done } };
      }
      case '/worker/runner-drop': {
        // A send that was stopped: its unfinished parts go.
        for (const f of a.files) {
          const w = writing.get(f.path);
          if (w && w.pc !== who.key) continue;
          writing.delete(f.path);
          await rm(partOf(f.path), { force: true });
        }
        if (now === 'coming') jobs.delete(a.id);
        return { status: 200, json: { ok: true } };
      }
      default:
        return no(404, 'this PC does not know that door.');
    }
  }

  return { handle, state };
}

/**
 * Sends a runner's zips (here, checked) to a linked PC, carrying on from what it has, then waits while that PC checks
 * and unpacks them. 'had' when it had that runner already. `every`: how often it asks how the unpacking goes (ms).
 */
export async function pushRunner(w: Wire, o: { id: string; files: { path: string; bytes: number; sha256: string }[]; progress: (p: Progress) => void; signal: AbortSignal; every?: number }): Promise<'sent' | 'had'> {
  const ask = { id: o.id, parts: o.files.map(f => ({ bytes: f.bytes, sha256: f.sha256 })) };
  const offer = await w.ask('/worker/runner-offer', ask);
  if (offer.have === true) return 'had';
  const at0 = Array.isArray(offer.at) ? offer.at.map(int) : [];
  const bytes = o.files.reduce((n, f) => n + f.bytes, 0);
  let before = 0;
  for (const [k, f] of o.files.entries()) {
    let at = Math.max(0, at0[k] ?? 0);
    if (at > f.bytes) at = 0;
    while (at < f.bytes) {
      if (o.signal.aborted) {
        await w.ask('/worker/runner-drop', ask).catch(() => undefined);
        throw new Error('Stopped.');
      }
      o.progress({ done: before + at, bytes });
      const r = await w.putPiece('/worker/runner-put', { ...ask, file: k, from: at }, await readPiece(f.path, at));
      at = int(r.at);
      if (at < 0) throw new Error('that PC did not say how much it has.');
    }
    before += f.bytes;
  }
  o.progress({ done: bytes, bytes });
  // Checked and unpacked there (a minute or two for a real CUDA build).
  for (const t0 = Date.now(); Date.now() - t0 < 15 * 60_000;) {
    if (o.signal.aborted) throw new Error('Stopped.');
    const s = await w.ask('/worker/runner-state', { id: o.id });
    if (s.state === 'installed') return 'sent';
    if (s.state === 'failed') throw new Error(String(s.said || 'it could not be unpacked there.'));
    if (s.state === 'none') throw new Error('that PC no longer has the files (it may have started again). Send it again.');
    await new Promise(r => setTimeout(r, o.every ?? 1000));
  }
  throw new Error('that PC took more than 15 minutes to unpack it. Look at it there, or send it again.');
}
