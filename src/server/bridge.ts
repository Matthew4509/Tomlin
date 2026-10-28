// The Bridge part (src/bridge/, plain JavaScript: projects, local copies, audits, git, live sites, prompts, tokens),
// started in TOMLIN's own process and drawn on its own page at /bridge/ in its own look. TOMLIN's checks
// (this PC's address, its own page's origin, the app lock) run first in src/server.ts; this hands the request on.
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HOME, PORT, ROOT, json, sampler } from './core.ts';
import { bridgeBackupBack, bridgeBackupNow, bridgeBackupProgress, bridgeBackups, bridgeBackupsNow, bridgeBackupSet, type BridgeBackups } from '../jobrun/copies.ts';

/** Where the Bridge part's page lives, and its address without the slash. */
export const BRIDGE_PATH = '/bridge/';

type Handle = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let handle: Handle | null = null;

/**
 * Its settings, read once by src/bridge/config.js: TOMLIN's port, its data under the home, and the first working
 * folder: the folder that holds this app folder when it is a project of its own (a git repository), else the workspace.
 */
export function bridgeEnv(env: NodeJS.ProcessEnv = process.env, root = ROOT, home = HOME) {
  return {
    BRIDGE_PORT: String(PORT),
    BRIDGE_DATA: env.BRIDGE_DATA ?? join(home.data, 'bridge'),
    // A home of its own (TOMLIN_HOME / TOMLIN_DATA: a test copy, a second copy) starts from its workspace only.
    BRIDGE_ROOT: env.BRIDGE_ROOT ?? (existsSync(join(root, '.git')) && !env.TOMLIN_HOME && !env.TOMLIN_DATA ? dirname(root) : join(home.data, 'workspace')),
    BRIDGE_SELF: home.home,
  };
}

/** Starts the Bridge part (once). A fault here leaves the rest of TOMLIN running and the page says why. */
export function startBridge(): void {
  if (handle) return;
  try {
    Object.assign(process.env, bridgeEnv());
    const require = createRequire(import.meta.url);
    // Lent before it starts, so it never starts readers of its own.
    Object.assign(require('../bridge/hooks.js') as object, { nodeBackup: nodeBackupHooks, pc: pcReading });
    handle = (require('../bridge/app.js') as { embed(): { handle: Handle } }).embed().handle;
    // Read once now, so the first list already carries each project's copies.
    void bridgeBackups().catch(() => undefined);
  } catch (error) {
    console.error('The Bridge part (projects, audits, prompts) could not start:', error);
  }
}

interface BridgeProject { id: string; dir: string; name: string }
interface BridgeParts {
  keyOf(dir: string): string;
  state: { projects: BridgeProject[]; backups: { status(): { finished: number | null } | null } };
  refreshProjects(): BridgeProject[];
  snapshot(p: BridgeProject, force: boolean): Promise<{ ok: boolean; at?: number; error?: string }>;
  snapFile(p: BridgeProject): string;
  iconOf(p: BridgeProject): { file: string; type: string } | null;
  siteUrlOf(p: BridgeProject): Promise<string | null>;
}
let parts: BridgeParts | null = null;
/** The Bridge's own modules, once it has started (null before, and in a copy where it did not start). */
function bridgeParts(): BridgeParts | null {
  if (!handle) return null;
  if (!parts) {
    const require = createRequire(import.meta.url);
    const { keyOf } = require('../bridge/projects.js') as Pick<BridgeParts, 'keyOf'>;
    const { state, refreshProjects } = require('../bridge/state.js') as Pick<BridgeParts, 'state' | 'refreshProjects'>;
    const { snapshot, snapFile, iconOf } = require('../bridge/snaps.js') as Pick<BridgeParts, 'snapshot' | 'snapFile' | 'iconOf'>;
    const { siteUrlOf } = require('../bridge/runner.js') as Pick<BridgeParts, 'siteUrlOf'>;
    parts = { keyOf, state, refreshProjects, snapshot, snapFile, iconOf, siteUrlOf };
  }
  return parts;
}
/**
 * Why TOMLIN should not stop now: a backup to a drive is running (Projects › Backups), '' when none. Its updates,
 * restarts and hand-over wait for it, as a backup stopped half way is not one. (Closing the window still stops it:
 * the Bridge part cancels it and removes the half-written zip.)
 */
export function backupRunning(): string {
  const j = bridgeParts()?.state.backups.status();
  return j && !j.finished ? 'A backup to your backup drive is running (Projects, Backups). Wait for it to finish, or Cancel it there, then try again.' : '';
}

/** The project folders on the Projects page (id and name), for the To Do; none before the Bridge part started. */
export function bridgeProjects(): { id: string; name: string }[] {
  const b = bridgeParts();
  if (!b) return [];
  return (b.state.projects.length ? b.state.projects : b.refreshProjects()).map(p => ({ id: p.id, name: p.name }));
}

/** The Bridge project in this folder (matched by folder only), or null. */
function projectAt(b: BridgeParts, dir: string): BridgeProject | null {
  const k = b.keyOf(dir);
  return b.state.projects.find(p => b.keyOf(p.dir) === k) ?? b.refreshProjects().find(p => b.keyOf(p.dir) === k) ?? null;
}

/**
 * A chat preview's picture (src/previews.ts): the Bridge's own picture of the site in a project's folder, its icon, and a
 * new picture taken only when that site is running (the Bridge never starts a site or Edge for one).
 */
export const bridgePictures = {
  find(dir: string): { at: number | null; icon: boolean } | null {
    const b = bridgeParts();
    const p = b && projectAt(b, dir);
    if (!b || !p) return null;
    let at: number | null = null;
    try { at = Math.round(statSync(b.snapFile(p)).mtimeMs); } catch { /* no picture yet */ }
    return { at, icon: !!b.iconOf(p) };
  },
  async take(dir: string): Promise<{ ok: boolean; running: boolean }> {
    const b = bridgeParts();
    const p = b && projectAt(b, dir);
    if (!b || !p || !(await b.siteUrlOf(p))) return { ok: false, running: false };
    return { ok: (await b.snapshot(p, true)).ok, running: true };
  },
  /** The picture's file, or the icon's file and type, for the window to show. */
  file(dir: string, which: 'picture' | 'icon'): { file: string; type: string } | null {
    const b = bridgeParts();
    const p = b && projectAt(b, dir);
    if (!b || !p) return null;
    return which === 'icon' ? b.iconOf(p) : existsSync(b.snapFile(p)) ? { file: b.snapFile(p), type: 'image/png' } : null;
  },
};

/** A project row's mark: its newest copy on a linked PC, and whether the project changed since. */
export function rowsOf(v: BridgeBackups | null) {
  if (!v) return null;
  const projects: Record<string, { on: true; name: string; at: number | null; pcName: string | null; current: boolean; copies: number }> = {};
  for (const [k, p] of Object.entries(v.projects)) {
    const newest = p.copies[0] ?? null;
    projects[k] = { on: true, name: p.name, at: newest?.at ?? null, pcName: newest?.pcName ?? null, current: !!newest?.current, copies: p.copies.length };
  }
  return { pcs: v.pcs.length, ready: v.pcs.filter(pc => !pc.why).length, projects };
}

/** This PC as TOMLIN's top bar reads it, in the shape the Bridge's This PC panel draws. */
export function pcReading() {
  const s = sampler.latest;
  const g = s.gpu;
  return {
    cpuPct: Math.round(s.cpu.percent),
    gpu: {
      pct: g && g.busy != null ? Math.round(g.busy) : null,
      engine: '',
      adapters: sampler.info.gpus.map(x => x.name),
      error: process.platform !== 'win32' ? 'GPU use is read from Windows counters, so it shows on Windows only.' : !g ? 'No graphics chip was found.' : g.busy == null ? 'Not read yet: it shows within a few seconds.' : null,
    },
  };
}

/** What the Bridge part borrows: TOMLIN's node backups (src/bridge/hooks.js says what each does). */
const nodeBackupHooks = {
  rows: () => rowsOf(bridgeBackupsNow()),
  view: () => bridgeBackups(),
  set: (dir: string, on: boolean) => bridgeBackupSet(dir, on),
  now: (only?: string[]) => bridgeBackupNow(only),
  progress: (ids: string[]) => bridgeBackupProgress(ids),
  back: (dir: string, pc: string) => bridgeBackupBack(dir, pc),
};

/** Answers /bridge and everything under it; false for any other address. */
export async function bridgeRoute(req: IncomingMessage, res: ServerResponse, p: string): Promise<boolean> {
  if (p !== '/bridge' && !p.startsWith(BRIDGE_PATH)) return false;
  if (p === '/bridge') {
    res.writeHead(301, { location: BRIDGE_PATH, 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (!handle) {
    json(res, 503, { error: 'The projects part of TOMLIN did not start. The reason is in the log (Settings, Your data, Open log); start TOMLIN again to try once more.' });
    return true;
  }
  // The Bridge part answers paths from its own root: /bridge/api/projects is its /api/projects.
  req.url = (req.url ?? '/').slice(BRIDGE_PATH.length - 1);
  await handle(req, res);
  return true;
}
