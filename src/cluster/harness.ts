// The expert-parallel prototype's harness: a lead and expert workers that talk the frames of src/cluster/wire.ts over
// TCP, on the small test model of src/cluster/moe.ts. It proves the parts that do not need llama.cpp: the split answer
// equals the one-PC answer, the PCs' work overlaps, a worker that goes quiet ends the word with plain words instead of
// a hang, and how long a layer's round trip takes. Off by default: nothing in TOMLIN starts it.
//
// From a terminal (the probe is what needs the real PCs, run by the owner; the server listens on 127.0.0.1 unless
// --lan is given, and stops by itself after --minutes, 10 unless set):
//   node src/cluster/harness.ts bench                         two workers on this PC, timings per layer
//   node src/cluster/harness.ts serve [--lan] [--port 47100] [--minutes 10]
//   node src/cluster/harness.ts probe <address:port> [--hidden 2560] [--count 2000]
// Tested in test/clustermoe.test.ts.
import { createServer, connect, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode, FrameReader, type Frame, type Pick } from './wire.ts';
import { forward, nextInput, partial, route, sharedPart, testLayer, type MoeLayer } from './moe.ts';

/** How long the lead waits for a worker's answer to one layer before the word ends (a PC that lost power sends no close). */
export const LAYER_WAIT_MS = 5_000;

/** A PC holding experts: answers each compute frame with the weighted sum of the chosen experts it holds. */
export class ExpertWorker {
  readonly layers: MoeLayer[];
  readonly from: number;
  readonly to: number;
  /** Extra time per chosen expert, to stand in for a slow PC's compute in a timing check (ms; 0: none). */
  delayPerExpertMs: number;
  /** Stops answering (a PC that went quiet), for the tests. */
  quiet = false;
  /** When each compute frame was taken and answered (performance.now()), to check that workers overlap without timing a busy PC. */
  readonly events: { kind: 'asked' | 'answered'; at: number }[] = [];
  private server: Server | null = null;
  private sockets = new Set<Socket>();

  constructor(layers: MoeLayer[], from: number, to: number, delayPerExpertMs = 0) {
    this.layers = layers;
    this.from = from;
    this.to = to;
    this.delayPerExpertMs = delayPerExpertMs;
  }

  /** Its answer to one compute frame. */
  answer(f: Frame): Frame {
    const layer = this.layers[f.layer];
    if (!layer || !f.values || !f.picks) return { kind: 'error', layer: f.layer, seq: f.seq, rows: 0, hidden: 0, text: `no layer ${f.layer} here` };
    const out = new Float32Array(f.rows * f.hidden);
    for (let r = 0; r < f.rows; r++) {
      const x = f.values.subarray(r * f.hidden, (r + 1) * f.hidden);
      const part = partial(layer, x, f.picks[r], id => id >= this.from && id < this.to);
      out.set(part, r * f.hidden);
    }
    return { kind: 'result', layer: f.layer, seq: f.seq, rows: f.rows, hidden: f.hidden, values: out };
  }

  /** Listens on `host` (127.0.0.1 unless told otherwise) and gives back the port. */
  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    this.server = createServer(socket => {
      this.sockets.add(socket);
      socket.setNoDelay(true);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      const reader = new FrameReader();
      socket.on('data', chunk => {
        let frames: Frame[];
        try {
          frames = reader.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const f of frames) {
          if (this.quiet || f.kind !== 'compute') continue;
          this.events.push({ kind: 'asked', at: performance.now() });
          const reply = encode(this.answer(f));
          const n = f.picks?.reduce((a, p) => a + p.length, 0) ?? 0;
          const wait = this.delayPerExpertMs * n;
          const send = () => {
            this.events.push({ kind: 'answered', at: performance.now() });
            socket.write(reply);
          };
          if (wait > 0) setTimeout(send, wait);
          else send();
        }
      });
    });
    await new Promise<void>((ok, fail) => {
      this.server!.once('error', fail);
      this.server!.listen(port, host, () => ok());
    });
    return (this.server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>(ok => (this.server ? this.server.close(() => ok()) : ok()));
  }
}

/** A connection from the lead to one worker: sends compute frames and matches the answers by seq. */
class Link {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  private socket: Socket;
  private waiting = new Map<number, { ok: (f: Frame) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ended = '';

  constructor(name: string, socket: Socket, from: number, to: number) {
    this.name = name;
    this.socket = socket;
    this.from = from;
    this.to = to;
    socket.setNoDelay(true);
    const reader = new FrameReader();
    socket.on('data', chunk => {
      try {
        for (const f of reader.push(chunk)) {
          const w = this.waiting.get(f.seq);
          if (!w) continue;
          this.waiting.delete(f.seq);
          clearTimeout(w.timer);
          if (f.kind === 'error') w.fail(new Error(`"${this.name}" could not work out its experts: ${f.text}`));
          else w.ok(f);
        }
      } catch (e) {
        this.end(`"${this.name}" sent something that is not an answer (${(e as Error).message})`);
      }
    });
    socket.on('close', () => this.end(`"${this.name}" closed the connection`));
    socket.on('error', e => this.end(`"${this.name}" could not be reached (${e.message})`));
  }

  private end(why: string): void {
    if (!this.ended) this.ended = why;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.fail(new Error(this.ended));
    }
    this.waiting.clear();
    this.socket.destroy();
  }

  ask(f: Frame, waitMs: number): Promise<Frame> {
    if (this.ended) return Promise.reject(new Error(this.ended));
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.waiting.delete(f.seq);
        fail(new Error(`"${this.name}" did not answer layer ${f.layer} within ${Math.round(waitMs / 1000)} seconds (it went quiet: off the network, asleep, or busy)`));
      }, waitMs);
      this.waiting.set(f.seq, { ok, fail, timer });
      this.socket.write(encode(f));
    });
  }

  close(): void {
    this.end(`"${this.name}" was closed by the lead`);
  }
}

export interface LayerTiming {
  layer: number;
  /** The whole layer, from routing to the summed answer. */
  ms: number;
  /** The slowest worker's round trip (0 when no remote expert was chosen). */
  wireMs: number;
  /** Chosen experts held by the lead and by the workers. */
  here: number;
  away: number;
}

/** The PC that leads: it routes, computes the experts it holds (`from`..`to`-1), and asks the workers for the rest. */
export class Lead {
  readonly layers: MoeLayer[];
  readonly from: number;
  readonly to: number;
  readonly links: Link[] = [];
  waitMs = LAYER_WAIT_MS;
  private seq = 1;

  constructor(layers: MoeLayer[], from: number, to: number) {
    this.layers = layers;
    this.from = from;
    this.to = to;
  }

  /** Connects to a worker holding experts `from`..`to`-1. */
  async join(name: string, port: number, from: number, to: number, host = '127.0.0.1'): Promise<void> {
    const socket = await new Promise<Socket>((ok, fail) => {
      const s = connect(port, host, () => ok(s));
      s.once('error', fail);
    });
    this.links.push(new Link(name, socket, from, to));
  }

  /** Which holder has expert `id` (the lead itself: -1). */
  owner(id: number): number {
    if (id >= this.from && id < this.to) return -1;
    const i = this.links.findIndex(l => id >= l.from && id < l.to);
    if (i < 0) throw new Error(`no PC in the cluster holds expert ${id}`);
    return i;
  }

  /** One layer for one word, the experts shared out: the same answer as forward(), up to rounding. */
  async layer(index: number, x: Float32Array): Promise<{ out: Float64Array; timing: LayerTiming }> {
    const t0 = performance.now();
    const layer = this.layers[index];
    const picks = route(layer, x);
    const byLink = new Map<number, Pick[]>();
    let here = 0;
    for (const p of picks) {
      const o = this.owner(p.id);
      if (o < 0) here++;
      else byLink.set(o, [...(byLink.get(o) ?? []), p]);
    }
    // The workers first (their round trip runs while the lead computes its own experts).
    let wireMs = 0;
    const asked = [...byLink.entries()].map(([i, ps]) => {
      const sent = performance.now();
      return this.links[i].ask({ kind: 'compute', layer: index, seq: this.seq++, rows: 1, hidden: layer.hidden, picks: [ps], values: x }, this.waitMs).then(f => {
        wireMs = Math.max(wireMs, performance.now() - sent);
        return f;
      });
    });
    // Yield once so the frames go out before the lead's own arithmetic holds the thread.
    await new Promise(r => setImmediate(r));
    const out = partial(layer, x, picks, id => id >= this.from && id < this.to);
    const sh = sharedPart(layer, x);
    for (let i = 0; i < out.length; i++) out[i] += sh[i];
    for (const f of await Promise.all(asked)) for (let i = 0; i < out.length; i++) out[i] += f.values![i];
    return { out, timing: { layer: index, ms: performance.now() - t0, wireMs, here, away: picks.length - here } };
  }

  /** A word through every layer (the stand-in for attention between them is nextInput). */
  async word(x: Float32Array): Promise<{ out: Float32Array; timings: LayerTiming[] }> {
    const timings: LayerTiming[] = [];
    let h = x;
    for (let i = 0; i < this.layers.length; i++) {
      const { out, timing } = await this.layer(i, h);
      timings.push(timing);
      h = nextInput(h, out);
    }
    return { out: h, timings };
  }

  close(): void {
    for (const l of this.links) l.close();
  }
}

/** The same word through every layer on one PC: the reference the lead's answer is checked against. */
export function wordAlone(layers: MoeLayer[], x: Float32Array): Float32Array {
  let h = x;
  for (const layer of layers) h = nextInput(h, forward(layer, h));
  return h;
}

// ---- The network probe (for the real PCs; the owner runs it) ----

/** An echo worker for the probe: answers each compute frame at once with values of the same size (no arithmetic). */
export async function echoServer(port: number, host: string): Promise<Server> {
  const server = createServer(socket => {
    socket.setNoDelay(true);
    socket.on('error', () => socket.destroy());
    const reader = new FrameReader();
    socket.on('data', chunk => {
      try {
        for (const f of reader.push(chunk)) if (f.kind === 'compute') socket.write(encode({ kind: 'result', layer: f.layer, seq: f.seq, rows: f.rows, hidden: f.hidden, values: f.values }));
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok());
  });
  return server;
}

/** Sorted round trips (ms) of `count` layer-sized frames to an echo server, one at a time as the lead would send them. */
export async function probe(host: string, port: number, hidden: number, count: number): Promise<number[]> {
  const socket = await new Promise<Socket>((ok, fail) => {
    const s = connect(port, host, () => ok(s));
    s.once('error', fail);
  });
  socket.setNoDelay(true);
  const reader = new FrameReader();
  let wake: (() => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  let ended: Error | null = null;
  socket.on('data', c => {
    if (reader.push(c).length && wake) wake();
  });
  // A stream that closes or goes quiet must end the probe, not leave it waiting for an answer that never comes.
  const end = (e: Error) => {
    ended ??= e;
    fail?.(ended);
  };
  socket.on('close', () => end(new Error(`the stream to ${host}:${port} closed before every frame came back`)));
  socket.on('error', e => end(e));
  const values = new Float32Array(hidden).fill(0.5);
  const picks: Pick[][] = [Array.from({ length: 5 }, (_, i) => ({ id: i, weight: 0.2 }))];
  const times: number[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const t = performance.now();
      await new Promise<void>((ok, no) => {
        if (ended) return no(ended);
        const quiet = setTimeout(() => no(new Error(`frame ${i} did not come back from ${host}:${port} in ${frameWaitMs / 1000} seconds`)), frameWaitMs);
        wake = () => {
          clearTimeout(quiet);
          ok();
        };
        fail = e => {
          clearTimeout(quiet);
          no(e);
        };
        socket.write(encode({ kind: 'compute', layer: i % 48, seq: i, rows: 1, hidden, picks, values }));
      });
      times.push(performance.now() - t);
    }
  } finally {
    wake = fail = null;
    socket.destroy();
  }
  return times.sort((a, b) => a - b);
}
/** How long the probe waits for one frame to come back before it gives up. */
const frameWaitMs = 10_000;

/** The middle, the 90th and the 99th percentile of sorted times. */
export function spread(sorted: number[]): { median: number; p90: number; p99: number } {
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { median: at(0.5), p90: at(0.9), p99: at(0.99) };
}

// ---- From a terminal ----

const flag = (args: string[], name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : fallback;
};

async function main(args: string[]): Promise<void> {
  const [what, where] = args;
  if (what === 'serve') {
    const host = args.includes('--lan') ? '0.0.0.0' : '127.0.0.1';
    const port = flag(args, '--port', 47100);
    const minutes = flag(args, '--minutes', 10);
    const server = await echoServer(port, host);
    console.log(`Expert-parallel probe answering on ${host}:${port} for ${minutes} minutes (Ctrl+C stops it sooner).${host === '0.0.0.0' ? ' Other PCs on the network can reach it; Windows may ask to allow it through the firewall.' : ''}`);
    setTimeout(() => server.close(() => process.exit(0)), minutes * 60_000).unref();
    return;
  }
  if (what === 'probe' && where) {
    const [host, port] = where.split(':');
    const hidden = flag(args, '--hidden', 2560);
    const count = flag(args, '--count', 2000);
    const times = await probe(host, Number(port), hidden, count);
    const s = spread(times);
    console.log(`${count} layer frames of ${hidden} values to ${where}: median ${s.median.toFixed(3)} ms, 90% under ${s.p90.toFixed(3)} ms, 99% under ${s.p99.toFixed(3)} ms (there and back).`);
    console.log(`For a 48-layer model that is about ${(48 * s.median).toFixed(1)} ms a word on the wire alone.`);
    return;
  }
  if (what === 'bench') {
    const opts = { hidden: 256, ff: 64, experts: 64, used: 8, shared: true };
    const ls = Array.from({ length: 8 }, (_, i) => testLayer(100 + i, opts));
    const a = new ExpertWorker(ls, 22, 43);
    const b = new ExpertWorker(ls, 43, 64);
    const lead = new Lead(ls, 0, 22);
    await lead.join('worker A', await a.listen(), 22, 43);
    await lead.join('worker B', await b.listen(), 43, 64);
    const x = new Float32Array(opts.hidden).fill(0.1);
    const all: LayerTiming[] = [];
    for (let i = 0; i < 50; i++) all.push(...(await lead.word(x)).timings);
    const s = spread(all.map(t => t.ms).sort((p, q) => p - q));
    const w = spread(all.filter(t => t.away).map(t => t.wireMs).sort((p, q) => p - q));
    console.log(`On this PC (loopback): a layer took median ${s.median.toFixed(3)} ms (90%: ${s.p90.toFixed(3)}); the workers' round trip median ${w.median.toFixed(3)} ms.`);
    lead.close();
    await a.close();
    await b.close();
    return;
  }
  console.log('Use: bench | serve [--lan] [--port N] [--minutes N] | probe <address:port> [--hidden N] [--count N]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
