// Running jobs: who does each step (a local model, swapped in and out of memory, or a paired worker PC), the steps
// themselves with automatic syntax checks and retries, "run the rest" until something needs the person, the reviewer,
// tests on a button press, the end-of-job report, and the worker side for other PCs (off unless turned on).
// The plain parts live in jobs.ts, checks.ts and share.ts, which have tests; this file joins them to the server.
// Its parts are in src/jobrun/ by area; createJobs gives them the server's parts and starts them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as jobs from './jobs.ts';
import type { Step } from './jobs.ts';
import type { CheckResult } from './checks.ts';
import * as firewall from './firewall.ts';
import type { AskOpts, ChatTurn, ThoughtStop } from './engine.ts';
import * as brains from './brains.ts';
import type { Staff, StaffMember } from './staff.ts';
import * as nodestaff from './nodestaff.ts';
import * as carry from './carry.ts';
import * as home from './home.ts';
import * as memory from './memory.ts';
import * as speedKeys from './speed.ts';
import type { Speeds } from './speed.ts';
import { inScope, type Tally, type Used } from './meter.ts';
import type { Pane } from './pane.ts';
import type { Place } from './runners.ts';
import type { RunOptions, Settings, Store } from './store.ts';
import { d, useDeps } from './jobrun/shared.ts';
import { canKeep, canThink, drawOn, hello, lastHello, pcAsks, lastSaid, linkCount, lostOf, syncUsage, nodeStats, owedNow, owedTaken, pictureDrawer, remoteStatus, sharedName, startLinks } from './jobrun/links.ts';
import { backupChoices, hireBrain } from './jobrun/who.ts';
import { laneOfRef, nextLane, planLane, setup } from './jobrun/sizing.ts';
import { backupTo, bringBack, copyFrom, keptOn, network, projectsBack, projectsOn, projectsTo, sendTo, startProjectBackups, transfers, updatePc } from './jobrun/copies.ts';
import { jobView, listJobs, loadJob, loadWaiting, projectCards } from './jobrun/jobfiles.ts';
import { actionBusy, change, finalReview, homeJobs, plan, planQueued, review, runQueued, runRest, step, tests, unplanned } from './jobrun/actions.ts';
import { applyShare, askHost, impactOf, linkedUse, nodeView, projectsCopy, serving, setShare, shareState, shareView, startNode, startShare } from './jobrun/node.ts';
import { remotes } from './jobrun/linking.ts';
import { goAway } from './jobrun/giveway.ts';

/** The main chat runner as the jobs see it (the one a step with no model of its own runs on). */
export type ChatSeat = Pick<Pane, 'view' | 'worker' | 'disconnect' | 'busy'>;

export interface JobDeps {
  store: Store;
  /** How fast each model answers, here and on linked PCs (src/speed.ts). */
  speeds: Speeds;
  chat: ChatSeat;
  /** The runner holding chat model `id` (connected or loading), or null (two or more chat models can be loaded). */
  runnerFor: (id: string) => Pane | null;
  /** What a runner's model was started with (its context size). */
  runOn: (p: Pane) => RunOptions;
  /** Where a chat model would load (src/runners.ts), or why it cannot, in plain words. */
  place: (id: string) => Place;
  /** Every chat model connected on this PC now. */
  loadedChats: () => string[];
  staff: Staff;
  version: string;
  /** What code this copy is (src/update.ts buildId); '' until it is read at start. */
  build: () => string;
  headers: Record<string, string>;
  json: (res: ServerResponse, status: number, value: unknown) => void;
  body: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
  workspaceDir: () => Promise<string>;
  chatList: () => { id: string; name: string; bytes: number }[];
  /** Starts loading a chat model in the runner `place` picks (returns at once; the runner's state shows progress). */
  connectChat: (id: string, asked: Settings['chat']['asked'], threads: number) => Promise<{ ok: true; runner: Pane } | { error: string }>;
  /** How the connected chat model was started. */
  runNow: () => RunOptions;
  runOf: (s: Settings, id: string) => RunOptions;
  /** Memory a model needs with its context, against what is free now. */
  fit: (id: string, run: RunOptions) => { level: 'ok' | 'tight' | 'no'; need: number; free: number; otherOn: boolean };
  /** The single "someone is using the chat model" slot shared with the chat window. */
  /** A job step answers on `pane` (the main runner when none): it stops only what answers on that runner. */
  claim: (ac: AbortController, pane?: Pane) => void;
  release: (ac: AbortController) => void;
  /** True while the chat window or a job step is answering: on this runner when one is named, else anywhere. */
  busy: (pane?: Pane | null) => boolean;
  /** Marks a runner (the main one when none is given) as just used, for the idle unload. */
  touch: (p?: Pane) => void;
  /** This PC's own totals (src/meter.ts), told in the worker's hello with when this copy started. */
  meter: () => { since: string; total: Tally };
  startedAt: string;
  /** A linked PC's answer brought its usage back: counted for that PC (under the project it was for). */
  usage: (pc: string, u: Used, model?: string) => void;
  /** The minute's check of a linked PC: did it answer? */
  uptimeMark: (pc: string, ok: boolean) => void;
  /** This PC's usage log rows for one key (a node's "for-<link>": the work it did for that linked PC). */
  ledgerRows: (key: string) => { project: string; tally: Tally; last: string }[];
  /** A linked PC's own log of its work for this PC: the final tally for that PC (src/meter.ts Ledger.takeFrom). */
  usageTake: (pc: string, rows: { project: string; tally: Tally; last?: string }[]) => void;
  /** This PC's memory now, told to a manager PC in the worker's hello (for its memory bar). */
  memory: () => unknown;
  /** This PC's meters as the sampler last read them (it reads every second anyway): for a paired PC's chat head. */
  stats: () => nodestaff.NodeStats;
  /** The Images pane, for a manager PC asking this one to draw. */
  imagePane: Pane;
  /** Every picture model in the registry, with the styles it is made for and whether it is on this PC. */
  pictureModels: () => brains.PictureModel[];
  /** A model hidden by this PC's owner (Models on this PC, Hide): told to linked PCs so their pick lists leave it out. */
  isHidden?: (id: string) => boolean;
  /** Whether picture model `id` fits in the memory free now (counting what the picture model loaded frees). */
  pictureFit: (id: string) => 'ok' | 'tight' | 'no';
  /** Draws one picture on this PC's connected picture model (nothing is loaded for it), with progress. */
  draw: (o: { prompt: string; mode: string; width?: number; height?: number; forPc: string }, progress: (p: unknown) => void, signal: AbortSignal) => Promise<{ png: Buffer; modelName: string; modelPrompt: string; mode: string; seconds: number } | { error: string }>;
  /** Swaps the connected picture model for another on this PC (same device and cores); true when it is connected. */
  swapImage: (id: string) => Promise<boolean>;
  /** A hire's system prompt (who they are, the role, the level, the writing tone chosen here), for a paired PC's chat with them. */
  hireSystem: (m: StaffMember) => Promise<string>;
  /** Loads a picture model in the Images pane (returns at once; the pane's state shows progress). */
  connectImage: (id: string) => Promise<boolean>;
  /** Loads a picture model in the Images pane, in place of the one connected (if any), and waits: true once connected. */
  loadImage: (id: string) => Promise<boolean>;
  /** True while this PC's Images pane is drawing. */
  imageBusy: () => boolean;
  /** A picture hire's way of working (the words added to every picture), or null. */
  recipeOf: (id: string) => { mode?: string; boost: string } | null;
  /** Told after every job event is written (notifications: src/notify.ts). */
  onEvent?: (jobId: string, e: home.JobEvent) => void;
  /** The team notebook and one per hire (src/memory.ts): their lines go to the front of every job packet. */
  notebooks: memory.Notebooks;
  /** Whether the app lock has a PIN (F7 E3: a node must have one). */
  appLockOn: () => boolean;
  /** Checks the app lock PIN (wrong tries are counted there). */
  appPinCheck: (pin: unknown) => { ok: true } | { status: number; error: string };
  /** Unloads every model on this PC (F7 E5: the node gives way). */
  /** Unloads every model here; `still` is asked before each one (the node may be started again part-way). */
  unloadAll: (still?: () => boolean) => Promise<void>;
  /** Told when a linked PC says "I need to log off for now" (its name). */
  onNodeAway?: (name: string) => void;
  /** Told when someone at a linked PC sends "I need to use the pc, please log out for N hours" (its name, the hours). */
  onNodeAsk?: (name: string, hours: number) => void;
  /** "Start when this PC starts" (src/autostart.ts). */
  autostart: { on: () => Promise<boolean>; set: (on: boolean) => Promise<void> };
  /** Copies between linked PCs (src/carry.ts): this PC's model files, where models and restore points go. */
  carry: CarryDeps;
  /** Updates pushed to nodes (src/update.ts): this copy's folder, whether Start TOMLIN.cmd can start another, the switch. */
  update: UpdateDeps;
}

/** What a paired PC said in its last hello: what it has loaded and what it can do. */
/** What copies between linked PCs need from the server: model files and folders, and backups (src/carry.ts). */
export interface CarryDeps {
  chatFiles: (id: string) => carry.FileRef[] | null;
  chatDir: string;
  chatHas: (name: string) => boolean;
  pictureFiles: (id: string) => carry.FileRef[] | null;
  pictureDest: (id: string) => { name: string; path: string; bytes: number; have: boolean }[] | null;
  /** Restore points kept on this PC for linked PCs. */
  keptRoot: string;
  /** This PC's own backups folder. */
  backupsDir: string;
  /** Makes a backup of this PC's data now; gives its file name. */
  makeBackup: (label: string) => Promise<string>;
  /** A model came in from a linked PC (copied, or sent here): the model lists are read again. */
  onInstalled: () => void;
}

/** What updates pushed to nodes need from the server (src/update.ts). */
export interface UpdateDeps {
  /** This copy's app folder. */
  root: string;
  /** Started by Start TOMLIN.cmd (TOMLIN_LOOP), which can start the new copy. */
  restarts: boolean;
  /** The new copy is whole in `dir`: point "start with Windows" at it, name it in next-copy.txt, end so it starts. */
  switchTo: (dir: string) => Promise<void>;
}

export interface Hello {
  name: string;
  model: string | null;
  ctx: number;
  version: string;
  /** What code that PC runs (src/update.ts buildId): '' from an older TOMLIN, which is then judged by its version alone. */
  build: string;
  memory: unknown;
  /** What this worker understands: 'turns' (a whole chat), 'draw' (pictures). An older worker sends none. */
  can: string[];
  image: { model: string | null; name: string | null; styles: string[]; swaps: boolean; coverage: ReturnType<typeof brains.styleCoverage> } | null;
  /** The models that PC lets linked PCs use (ticked there): this PC's hires can run on them (an older PC sends none). */
  models: nodestaff.SharedModel[];
  /** Set while someone at that PC pressed "I need to use the pc": when they pressed it. */
  away: string | null;
  /** "I need to use the pc, please log out for N hours", sent from that PC's lock screen and not answered yet (2.0.44 on). */
  ask: { hours: number; at: string } | null;
  /** What that PC lets linked PCs do there (copy shared models, keep restore points, send models); null from one before 2.0.32. */
  allow: carry.Allow | null;
  /** Started by Start TOMLIN.cmd, so it can start a newer copy by itself (2.0.33 on). */
  restarts: boolean;
  /** When its TOMLIN started, and how long the PC has been on (seconds); null from one before 2.0.39. */
  up: { since: string; pc: number } | null;
  /** Everything its chat models did, since it started counting (2.0.39 on). */
  meter: { since: string; total: Tally } | null;
  /** When the TOMLIN it runs was put there (updated from a linked PC, or unzipped/installed); null before 2.0.44. */
  installed: string | null;
  /** The disk that keeps other PCs' backups there: its size and what is free (bytes); null before 2.0.47. */
  disk: { total: number; free: number } | null;
}

/** Something that answers: the local chat model, or a worker PC's. */
export interface Brain {
  label: string;
  ctx: number;
  ask: (system: string, user: string, maxTokens: number, onText: (t: string) => void, signal: AbortSignal) => Promise<string>;
  /**
   * A whole conversation (system line first). `plain`: a Default hire's, asked with the model's own settings (engine.ts
   * plainStyle). `think`: Think was chosen; the working so far goes to `onThought`.
   */
  chat: (turns: ChatTurn[], maxTokens: number, onText: (t: string) => void, signal: AbortSignal, opts?: AskOpts) => Promise<string>;
  /**
   * What the model worked out before its last answer, when it thought first (null otherwise, or a linked PC is older).
   * `stopped`: why the working was stopped before the answer (engine.ts ThoughtStop).
   */
  thought?: { text: string; seconds: number; stopped?: ThoughtStop } | null;
  /** How fast the last answer was written and its prompt read (null when the model did not say, or a linked PC is older). */
  last?: { write: number; tokens: number; read?: number } | null;
  /** The last answer stopped at its length limit, so Continue can carry it on (a linked PC says so from 2.0.43). */
  cut?: boolean;
}

/** The brain that answers for a hire, and where it is. */
export interface HireBrain {
  brain: Brain;
  ref: string;
  /** 'this PC' or the paired PC's name. */
  pc: string;
  /** The model's name as that PC knows it. */
  model: string;
  here: boolean;
  /** The runner it answers in, when it is a model on this PC (two or more chat models can be loaded). */
  pane?: Pane;
  /** Set when the preferred brain could not answer and another one did. */
  note: string;
  /** A backup smaller than the hire's own model answered: an intern, drafts only. */
  intern: boolean;
}

export interface StepResult extends jobs.Result {
  raw: string;
  checks: CheckResult[];
  /** What failed and could not be fixed by the retries (syntax checks, no file in the agreed form). */
  problems: string[];
  /** The plain cross-file check, as the files would be after saving. */
  warnings: string[];
  exists: Record<string, boolean>;
  /** Each step file's fingerprint when the step read it: saving is refused when the file has changed since. */
  base?: Record<string, string>;
  tries: number;
  worker: string;
  review?: { ok: boolean | null; problems: string[]; text: string };
}

export function createJobs(deps: JobDeps) {
  useDeps(deps);
  startNode();
  startLinks();
  startProjectBackups();
  return { get, post, startShare, loadJob, homeJobs, runQueued, planQueued, listJobs, unplanned, projectInfo: async (id: string) => { const c = await projectCards(id); return 'error' in c ? null : { name: c.name, goal: c.goal, folder: c.folder }; }, changeJob: change, actionBusy, laneOfRef, nextLane: async (id: string, skip = -1) => { const job = await loadJob(id); if (job) return nextLane(job, skip); const c = await projectCards(id); return 'error' in c ? null : planLane(c.team); }, shareView, remoteStatus, linkCount, hireBrain, backupChoices, pictureDrawer, drawOn, lastHello, sharedName, nodeStats, hello, linkedUse, impactOf, nodeView, goAway, askHost, pcAsks, applyShare, canKeep, canThink, lostOf, owedNow, owedTaken, syncUsage, lastSaid: (id: string) => lastSaid.get(id) ?? null, servingNow: () => [...serving.values()], shareOn: () => shareState.on };
}

// ---- Routes ----

async function get(p: string, url: URL, res: ServerResponse): Promise<boolean> {
  // The projects saved on Home and not planned yet come too: a chat can be put in one (Chats, Tools).
  if (p === '/api/jobs') return d.json(res, 200, { jobs: await listJobs(), unplanned: await unplanned() }), true;
  if (p === '/api/jobs/get') {
    const job = await loadJob(url.searchParams.get('id'));
    return job ? d.json(res, 200, { ...(await jobView(job)), waiting: await loadWaiting(job.id) }) : d.json(res, 404, { error: 'There is no such job in this workspace.' }), true;
  }
  if (p === '/api/jobs/setup') return d.json(res, 200, await setup()), true;
  if (p === '/api/remotes') return d.json(res, 200, { remotes: await remoteStatus() }), true;
  if (p === '/api/network') return d.json(res, 200, await network()), true;
  if (p === '/api/network/transfers') return d.json(res, 200, { transfers: transfers.view() }), true;
  if (p === '/api/network/backups') return reply(res, await keptOn(url.searchParams.get('pc'))), true;
  if (p === '/api/network/projects') return reply(res, await projectsOn(url.searchParams.get('pc'))), true;
  if (p === '/api/share/firewall') {
    const facts = await firewall.read(shareState.port, process.execPath);
    return d.json(res, 200, facts ? { ...firewall.judge(facts, shareState.port, process.execPath), port: shareState.port } : { unknown: true, port: shareState.port }), true;
  }
  if (p === '/api/home/pcs') return d.json(res, 200, { pcs: (await remoteStatus()).map(r => ({ id: r.id, name: r.name, url: r.url, model: r.ok ? r.model : null, picture: r.ok ? r.image?.name ?? null : null, speed: r.ok && r.model ? d.speeds.get(speedKeys.pcKey(r.id, r.model)) : null, ...pcMemory(r), activity: r.ok ? (r.away ? 'owner' : 'available') : 'offline', backupsOnly: r.backupsOnly === true, disk: r.ok ? r.disk ?? null : null, outdated: r.ok && r.update ? { version: r.version, mine: r.update.mine, other: r.update.other } : null, ...home.pcState(r) })) }), true;
  return false;
}

async function post(p: string, b: Record<string, unknown>, res: ServerResponse): Promise<boolean> {
  const reply = (r: { status: number; body: unknown }) => d.json(res, r.status, r.body);
  switch (p) {
    // Every model answer under these counts for the project (src/meter.ts).
    case '/api/jobs/plan': await inScope({ project: jobs.validId(b.project) ? b.project : '' }, () => plan(res, b)); return true;
    case '/api/jobs/step': await inScope({ project: jobs.validId(b.id) ? b.id : '' }, () => step(res, b)); return true;
    case '/api/jobs/run': await inScope({ project: jobs.validId(b.id) ? b.id : '' }, () => runRest(res, b)); return true;
    case '/api/jobs/review': await inScope({ project: jobs.validId(b.id) ? b.id : '' }, () => review(res, b)); return true;
    case '/api/jobs/final': await inScope({ project: jobs.validId(b.id) ? b.id : '' }, () => finalReview(res, b)); return true;
    case '/api/jobs/change': reply(await change(b)); return true;
    case '/api/jobs/test': reply(await tests(b)); return true;
    case '/api/remotes': reply(await remotes(b)); return true;
    case '/api/share': reply(await setShare(b)); return true;
    case '/api/share/projects-out': reply(await projectsCopy(b)); return true;
    case '/api/network/projects': reply(await projectsTo(b)); return true;
    case '/api/network/projects-back': reply(await projectsBack(b)); return true;
    case '/api/network/copy': reply(await copyFrom(b)); return true;
    case '/api/network/send': reply(await sendTo(b)); return true;
    case '/api/network/backup': reply(await backupTo(b)); return true;
    case '/api/network/bring': reply(await bringBack(b)); return true;
    case '/api/network/update': reply(await updatePc(b)); return true;
    case '/api/network/stop': d.json(res, 200, { stopped: transfers.stop(String(b.id ?? '')) }); return true;
    default: return false;
  }
}

const reply = (res: ServerResponse, r: { status: number; body: unknown }) => d.json(res, r.status, r.body);

/** A linked PC's total RAM and graphics-card memory, as it said in its last answer: null when it is off, VRAM 0 when it has no card of its own. */
function pcMemory(r: { ok: boolean; memory?: unknown }): { ram: number | null; vram: number | null; ramUsed: number | null } {
  const m = r.ok ? (r.memory as { ram?: { total?: unknown; used?: unknown }; gpu?: { total?: unknown } | null } | null | undefined) : null;
  const ram = typeof m?.ram?.total === 'number' ? m.ram.total : null;
  // RAM in use now (its card shows a (!) when it is nearly full, src/calc.ts RAM_FULL).
  const ramUsed = ram !== null && typeof m?.ram?.used === 'number' ? m.ram.used : null;
  return { ram, vram: ram === null ? null : typeof m?.gpu?.total === 'number' ? m.gpu.total : 0, ramUsed };
}

export type { Step };
