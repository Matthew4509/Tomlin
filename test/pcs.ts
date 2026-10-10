// Real TOMLIN copies for tests that need two PCs: each started as its own server on 127.0.0.1 with a home of its own
// in %TEMP%, its worker door on a port of its own, and every place a copy could write (Startup, desktop, Start menu,
// install folder, the Apps entry) moved into that home. Nothing here touches the real install or the real data.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { hashPin } from '../src/lock.ts';

export const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Waits until `check` gives something (not null, undefined or false), asking every `every` ms; throws with `what` after `ms`. */
export async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 60_000, every = 500): Promise<T> {
  let last: unknown = null;
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(every)) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Waited ${Math.round(ms / 1000)} s for ${what}${last ? ` (last fault: ${(last as Error).message})` : ''}`);
}

export interface Pc {
  base: string;
  home: string;
  proc: ChildProcess;
  /** Everything it printed so far. */
  said(): string;
  /** Its exit code once it ends (null when killed). */
  exited: Promise<number | null>;
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
  /** Sent with every request once set (the app lock's cookie). */
  cookie: string;
  stop(): Promise<void>;
}

/**
 * Starts the copy in `root` (its src/server.ts) on `home`. Both names of each setting are given: a copy from before the
 * TOMLIN name (2.0.44 and older) reads SHELBY_*, a newer one TOMLIN_*.
 */
export async function startPc(o: { root: string; home: string; env?: Record<string, string> }): Promise<Pc> {
  mkdirSync(join(o.home, 'startup'), { recursive: true });
  writeFileSync(join(o.home, 'models-folder.txt'), '');
  const port = await freePort();
  const set: Record<string, string> = {
    HOME: o.home, PORT: String(port), MODELS_FILE: join(o.home, 'models-folder.txt'), NO_TOAST: '1', OPEN: '',
    STARTUP_DIR: join(o.home, 'startup'), DESKTOP_DIR: join(o.home, 'desktop'), START_MENU_DIR: join(o.home, 'start-menu'),
    INSTALL_ROOT: join(o.home, 'install'), UNINSTALL_KEY: 'none', ...o.env,
  };
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^(TOMLIN|SHELBY)_/.test(k)) delete env[k];
  for (const [k, v] of Object.entries(set)) env[`TOMLIN_${k}`] = env[`SHELBY_${k}`] = v;
  const proc = spawn(process.execPath, [join(o.root, 'src', 'server.ts')], { cwd: o.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  proc.stdout!.on('data', d => (said += d));
  proc.stderr!.on('data', d => (said += d));
  const exited = new Promise<number | null>(r => proc.once('exit', code => r(code)));
  const base = `http://127.0.0.1:${port}`;
  const pc: Pc = {
    base, home: o.home, proc, said: () => said, exited, cookie: '',
    async get(path) {
      const r = await fetch(base + path, { headers: pc.cookie ? { cookie: pc.cookie } : {} });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    async post(path, body) {
      const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(pc.cookie ? { cookie: pc.cookie } : {}) }, body: JSON.stringify(body) });
      const set = r.headers.get('set-cookie');
      if (set && /^sm_app=/.test(set)) pc.cookie = set.split(';')[0];
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await exited;
    },
  };
  for (let i = 0; i < 300 && !/is running at/.test(said); i++) {
    if (proc.exitCode !== null) throw new Error(`The copy in ${o.root} ended at start (code ${proc.exitCode}):\n${said}`);
    await sleep(200);
  }
  if (!/is running at/.test(said)) {
    await pc.stop();
    throw new Error(`The copy in ${o.root} did not start:\n${said}`);
  }
  return pc;
}

export const NODE_PIN = '2468';
export const NODE_CODE = 'TEST-NQDE';

/**
 * A home for a node: the app lock set (a node needs one before it shares), sharing on at `workerPort` with a made-up
 * setup code and every tick on. Written before the copy starts, as the PC's own owner would have set it.
 */
export function nodeHome(home: string, workerPort: number, name = 'Test node'): void {
  const data = join(home, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'app-lock.json'), JSON.stringify({ ...hashPin(NODE_PIN), idleMinutes: 0 }));
  writeFileSync(join(data, 'share.json'), JSON.stringify({
    on: true, port: workerPort, name, id: 'a1b2c3d4', code: NODE_CODE, pinOn: false, pin: '', paired: [], models: [],
    allow: { pull: true, backup: true, push: true, update: true },
  }));
}

/** Unlocks a node's page (its app lock), so its /api answers. */
export async function unlock(node: Pc): Promise<void> {
  const r = await node.post('/api/applock', { action: 'unlock', pin: NODE_PIN });
  if (r.status !== 200 || !node.cookie) throw new Error(`The node did not unlock: ${r.status} ${JSON.stringify(r.body)}`);
}

/** Links `host` to the node whose worker door is at `workerPort`; gives the host's id for it. */
export async function link(host: Pc, workerPort: number): Promise<string> {
  const r = await until('the node\'s worker door to open', async () => {
    const a = await host.post('/api/remotes', { action: 'add', url: `127.0.0.1:${workerPort}`, code: NODE_CODE });
    return a.status === 200 ? a : null;
  }, 30_000, 1000);
  const remotes = (await host.get('/api/remotes')).body?.remotes ?? r.body?.remotes ?? [];
  const id = remotes.find((x: { url: string }) => x.url.endsWith(`:${workerPort}`))?.id;
  if (!id) throw new Error(`Linked, but the host does not list the node: ${JSON.stringify(remotes)}`);
  return id;
}

/** Waits for a transfer on the host to end (done, failed or stopped) and gives it. */
export async function transferEnd(host: Pc, id: string, ms = 120_000): Promise<{ state: string; said: string }> {
  return until(`transfer ${id} to end`, async () => {
    const t = ((await host.get('/api/network/transfers')).body?.transfers ?? []).find((x: { id: string }) => x.id === id);
    return t && t.state !== 'working' ? t : null;
  }, ms, 500);
}
