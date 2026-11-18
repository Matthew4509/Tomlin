// The cluster test door's links to the running app (src/cluster/testdoor.ts takes them as deps, so its tests stand in
// for them): this PC's sharing state, the presence reader, whether Max mode lends now, the runner's RPC server program,
// and a short-lived RPC server for one test stream (started on 127.0.0.1 only, stopped when the stream ends).
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { freemem, totalmem } from 'node:os';
import { dirname } from 'node:path';
import * as maxlend from '../maxlend.ts';
import * as leftovers from '../leftovers.ts';
import { log } from '../log.ts';
import { d } from '../jobrun/shared.ts';
import { shareState, taken } from '../jobrun/node.ts';
import { lentTo } from '../jobrun/maxnode.ts';
import type { DoorDeps } from './testdoor.ts';

const presence = new maxlend.PresenceReader();

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

const answers = (port: number) => new Promise<boolean>(resolve => {
  const s = connect(port, '127.0.0.1');
  s.once('connect', () => {
    s.destroy();
    resolve(true);
  });
  s.once('error', () => resolve(false));
});

/** One RPC server of this PC's runner for one test stream, with no weight cache (a test uses no model). */
async function startRpc(p: maxlend.RpcProgram): Promise<{ port: number; stop: () => void }> {
  const port = await freePort();
  const child = spawn(p.exe, maxlend.rpcArgs(port, p, false), { windowsHide: true, cwd: dirname(p.exe), stdio: ['ignore', 'ignore', 'pipe'] });
  leftovers.started(child.pid, p.exe);
  const tail = maxlend.keepTail(child);
  let gone = false;
  let stopping = false;
  child.on('error', () => undefined);
  child.on('exit', (code, signal) => {
    gone = true;
    leftovers.ended(child.pid);
    // Stopped on its own, not at the stream's end: say how, with the free RAM then and its last lines (a crash is
    // otherwise invisible here: the asking PC only sees its connection drop).
    if (!stopping) log.warn('cluster', `Cluster test: ${maxlend.stoppedWords(code, signal, { total: totalmem(), free: freemem() }, tail())}.`);
  });
  const stop = () => {
    stopping = true;
    if (!gone) child.kill();
  };
  process.once('exit', stop);
  for (let t = 0; t < maxlend.RPC_START_MS / 200; t++) {
    if (gone) throw new Error('it stopped as it started');
    if (await answers(port)) return { port, stop };
    await new Promise(r => setTimeout(r, 200));
  }
  stop();
  throw new Error(`it did not start in ${maxlend.RPC_START_MS / 1000} seconds`);
}

export function nodeTestDeps(): DoorDeps {
  return {
    state: () => shareState,
    taken,
    presence: async () => presence.now() ?? (await presence.first()),
    presenceNow: () => presence.now(),
    lending: () => lentTo(),
    program: build => d.rpcProgram?.(build) ?? null,
    builds: () => d.rpcBuilds?.() ?? [],
    startRpc,
    say: line => log.info('cluster', line),
  };
}
