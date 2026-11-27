// Agents (Part B of the 26 Nov plan): standing jobs kept on this PC in data/agents.json (src/agents.ts), started by
// their triggers (src/agenttriggers.ts) as "agent" items in the queue, run by src/agentrun.ts with the tools of
// src/agenttools.ts, and written up as report.md in the workspace (src/agentreport.ts). Also: the Agents page's routes,
// the link door a linked admin PC uses to set and read this PC's agents (D6: on a node only the admin PC changes them),
// collecting reports from linked PCs, waiting for a busy PC, keeping Windows awake, the drive-free check and unloading
// the model 5 minutes after a run.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readData, updateData } from '../atomic.ts';
import * as A from '../agents.ts';
import type { AgentsFile, Job, Run } from '../agents.ts';
import { AGENT_TOOLS, approvalLines, checkAgainst, CHATBOT_PROMPT, cleanRecipe, NEVER, readRecipe, recipeHash, recipeText, STARTERS, taskWarning, type AgentTool } from '../recipe.ts';
import { scanText } from '../promptscan.ts';
import { looksSecret } from '../rules.ts';
import { afterMatches, filesDue, nextTime, timed, triggerWords, whenWords } from '../agenttriggers.ts';
import { AgentKit, resultsDir, runFolder, type FoundReport } from '../agenttools.ts';
import { runAgent, type RunNotes } from '../agentrun.ts';
import { collectedPath, homeText, reportMarkdown, toCollect, toPrune } from '../agentreport.ts';
import { agentDoor } from '../agentdoor.ts';
import { stamp } from '../folders.ts';
import * as ws from '../workspace.ts';
import { freeOn } from '../lowdisk.ts';
import { inScope } from '../meter.ts';
import { INBOX_GROUP, agentBookRoom, bookText, pickLines } from '../memory.ts';
import { roleOf, staffSystem, worksAlone, type StaffMember } from '../staff.ts';
import { log } from '../log.ts';
import { HOME, json, notebooks, notifier, staff, store, workspaceDir, type Routes } from './core.ts';
import { jobRoutes } from './jobs.ts';
import { answeringBusy } from './answering.ts';
import { runnerUsed } from './panes.ts';
import { addAgentItem, agentHold, cancelAgentItem, queueHooks } from './queue.ts';
import { KEY_MINUTES, lastInUse, readInUse, saveInUse, settingsFile as inUseFile } from '../pcbusy.ts';
import { changesBlock, dropLines, lookPage, readLines, watchDue, watchHit, writeLines, type PageState } from '../pagewatch.ts';
import { fetchPublic, POLITE, siteOf } from '../webtools.ts';
import { cleanCalendarUrl, maskCalendar, readIcs, type CalEvent } from '../ics.ts';
import { maskTopic, noPaths, cleanServer, cleanTopic, readPhone, readSecrets, savePhone, saveSecrets, setDir as notifyDir, tellPhone, testPhone, windowsLine } from '../agentnotify.ts';
import { workerPost } from '../jobrun/links.ts';
import type { Pane } from '../pane.ts';

const FILE = join(HOME.data, 'agents.json');
const NOTES_DIR = join(HOME.data, 'agent-runs');
let now: AgentsFile = A.EMPTY_FILE;
/** Below this much free space on the workspace's drive a run is held (a node keeps 2-10 GB free). */
export const DISK_MIN = 2 * 2 ** 30;
/** The model a run loaded is unloaded this long after it, unless a chat used it since. */
export const UNLOAD_AFTER_MS = 5 * 60_000;

async function change(fn: (f: AgentsFile) => void): Promise<AgentsFile> {
  now = await updateData<AgentsFile>(FILE, A.EMPTY_FILE, raw => {
    const f = A.cleanFile(raw);
    fn(f);
    return f;
  });
  return now;
}
const newId = () => randomBytes(6).toString('hex');
const jobOf = (id: string) => now.jobs.find(j => j.id === id);
const agentsHere = () => staff.list().filter(m => worksAlone(m.role)).map(m => ({ id: m.id, name: m.name }));
const nameOf = (id: string) => staff.get(id)?.name ?? id;
/** This PC is a node: its agents are set from the admin PC (D6), not here. */
const isNode = () => jobRoutes.shareOn();
const NODE_WHY = 'This PC is a node: its agents are set from the admin PC (Agents there, under this PC\'s name). Pause, Run now and Stop still work here.';

// ---- Adding a run to the queue ----

/** Jobs whose run is being put in line now: a second Run now pressed meanwhile is told it is waiting already. */
const starting = new Set<string>();

/** One run of a job, added to the queue (none when one is waiting or running already). `changes`: a page watch's block. */
async function startRun(jobId: string, by: string, file?: string, changes?: string): Promise<{ run?: Run; error?: string }> {
  const j = jobOf(jobId);
  if (!j) return { error: 'That job is not here any more.' };
  if (!A.approvedNow(j)) return { error: 'This job has changed since it was approved: approve it again before it runs.' };
  const already = A.inLine(now, jobId);
  if (already) return { error: `${j.recipe.name} is ${already.state === 'running' ? 'running' : 'waiting in the queue'} already.` };
  if (starting.has(jobId)) return { error: `${j.recipe.name} is waiting in the queue already.` };
  starting.add(jobId);
  try {
    return await putInLine(j, by, file, changes);
  } finally {
    starting.delete(jobId);
  }
}

async function putInLine(j: Job, by: string, file?: string, changes?: string): Promise<{ run?: Run; error?: string }> {
  const m = staff.get(j.recipe.agent);
  const run: Run = { id: newId(), job: j.id, name: j.recipe.name, agent: j.recipe.agent, agentName: m?.name ?? j.recipe.agent, by, ...(file ? { file } : {}), state: 'waiting', added: new Date().toISOString(), line: 'Waiting for its PC.', held: [] };
  if (changes) {
    await mkdir(NOTES_DIR, { recursive: true });
    await writeFile(changesFile(run.id), changes);
  }
  // The run is listed before its queue item is added: the queue may start the item at once, and a run it cannot find
  // failed the item while the run stayed "waiting" for good.
  await change(f => { f.runs.push(run); f.runs = f.runs.slice(-A.RUNS_KEPT); });
  const q = await addAgentItem({ title: `${run.agentName}: ${j.recipe.name}`, agentRun: run.id, as: j.recipe.agent });
  if ('error' in q) {
    await change(f => { f.runs = f.runs.filter(x => x.id !== run.id); });
    await rm(changesFile(run.id), { force: true }).catch(() => undefined);
    return { error: q.error };
  }
  run.queue = q.id;
  await change(f => { const x = f.runs.find(y => y.id === run.id); if (x) x.queue = q.id; });
  return { run };
}

// ---- Running one (called by the queue) ----

/** The agent's memory as the model is sent it: their notebook and the team's, picked by the task's words, within a fifth of the room. */
async function memoryFor(m: StaffMember, task: string, ctx: number): Promise<string> {
  const parts: string[] = [];
  for (const [scope, title] of [[`staff:${m.id}`, `${m.name}'s memory:`], ['team', 'The team\'s memory:']] as const) {
    const lines = await notebooks.read(scope).catch(() => []);
    if (!lines.length) continue;
    const got = pickLines(lines, task, agentBookRoom(ctx));
    if (got.lines.length) parts.push(bookText(title, got.lines));
  }
  return parts.join('\n\n');
}

async function lastReportOf(jobId: string, before: string): Promise<string> {
  const last = [...now.runs].reverse().find(r => r.job === jobId && r.id !== before && r.report && A.RUN_FINISHED.includes(r.state) && r.state !== 'failed');
  if (!last?.report) return '';
  return readFile(join(await workspaceDir(), last.report), 'utf8').catch(() => '');
}

/** N5: the last report of the job a recipe's Reads names (on this PC, or collected from a linked PC). */
async function reportOfJob(name: string, self: string): Promise<FoundReport | null> {
  const last = [...now.runs].reverse().find(r => r.job !== self && A.RUN_FINISHED.includes(r.state) && r.state !== 'stopped' && afterMatches(name, { name: r.name, agentName: r.agentName }));
  if (!last) return null;
  const at = last.ended ?? last.started ?? last.added;
  if (!last.report || last.state === 'failed' || last.state === 'skipped') return { name: last.name, state: last.state, line: last.line, at, text: '' };
  const full = await ws.inside(await workspaceDir(), last.report);
  const text = full ? await readFile(full, 'utf8').catch(() => null) : null;
  return text === null ? { name: last.name, state: 'failed', line: 'its report is not in the workspace any more', at, text: '' } : { name: last.name, state: last.state, line: last.line, at, text };
}

/** N6: his calendars' events, fetched by TOMLIN (never the model) at most every 10 minutes; what failed said without its address. */
let calCache: { at: number; key: string; got: { events: CalEvent[]; said: string[] } } | null = null;
async function calendarEvents(): Promise<{ events: CalEvent[]; said: string[] }> {
  const urls = (await readSecrets()).calendars ?? [];
  if (!urls.length) return { events: [], said: ['No calendar is set: he can add one on the Agents page (Settings, Calendar).'] };
  const key = urls.join('\n');
  if (calCache && calCache.key === key && Date.now() - calCache.at < 10 * 60_000) return calCache.got;
  const events: CalEvent[] = [];
  const said: string[] = [];
  for (const [i, url] of urls.entries()) {
    try {
      const r = await fetchPublic(url, { signal: AbortSignal.timeout(30_000), maxBytes: 8 << 20, publicOnly: true, headers: { Accept: 'text/calendar, text/plain;q=0.5' } });
      if (r.status < 200 || r.status >= 300) { said.push(`Calendar ${i + 1} did not open (the site answered ${r.status}).`); continue; }
      const got = readIcs(r.body.toString('utf8'));
      if (!got.length && !/BEGIN:VCALENDAR/i.test(r.body.subarray(0, 2000).toString('utf8'))) { said.push(`Calendar ${i + 1} is not a calendar (iCal) address.`); continue; }
      events.push(...got);
    } catch {
      said.push(`Calendar ${i + 1} did not open.`);
    }
  }
  calCache = { at: Date.now(), key, got: { events, said } };
  return calCache.got;
}

/** The jobs a Reads line may name: the standing jobs here and the ones whose reports are collected from linked PCs. */
const readableJobs = () => [...now.jobs.map(j => ({ name: j.recipe.name, agentName: nameOf(j.recipe.agent) })), ...now.runs.filter(r => r.from).map(r => ({ name: r.name, agentName: r.agentName }))];

const notesFile = (runId: string) => join(NOTES_DIR, `${runId}.json`);
/** A page watch's run: what changed, kept beside its notes until it has run. */
const changesFile = (runId: string) => join(NOTES_DIR, `${runId}.changes.txt`);

/** Unloads the model a run used, UNLOAD_AFTER_MS after it, unless a chat used it since (whatever the PC's idle setting). */
function unloadLater(pane: Pane | undefined, model: string, endedAt: number): void {
  if (!pane) return;
  setTimeout(() => {
    if (pane.view.state !== 'connected' || pane.view.model !== model || answeringBusy(pane)) return;
    if ((runnerUsed.get(pane) ?? 0) > endedAt + 1000) return;
    if (now.runs.some(r => r.state === 'running')) return;
    console.log(`Unloading ${pane.view.modelName ?? model}: an agent run used it and nothing has since.`);
    void pane.disconnect();
  }, UNLOAD_AFTER_MS).unref();
}

/**
 * Runs the agent run `runId` to its end (the queue's "agent" item). Anything its setup throws ends the run as failed in
 * words too, so the run never stays "Waiting for its PC." while its queue item has failed.
 */
async function runOne(runId: string, signal: AbortSignal, st: { stage: string }): Promise<{ state: 'done' | 'failed'; result?: string; error?: string }> {
  try {
    return await runOneNow(runId, signal, st);
  } catch (e) {
    const why = ((e as Error).message || 'something went wrong').replace(/\.$/, '');
    await change(f => {
      const r = f.runs.find(x => x.id === runId);
      if (r && (r.state === 'waiting' || r.state === 'running')) Object.assign(r, { state: 'failed', line: `Failed: ${noPaths(why).slice(0, 200)}.`, ended: new Date().toISOString() });
    }).catch(() => undefined);
    return { state: 'failed', error: why };
  }
}

async function runOneNow(runId: string, signal: AbortSignal, st: { stage: string }): Promise<{ state: 'done' | 'failed'; result?: string; error?: string }> {
  const run = now.runs.find(r => r.id === runId);
  if (!run) return { state: 'failed', error: 'That agent run is not listed any more.' };
  const j = jobOf(run.job);
  const finish = async (patch: Partial<Run>): Promise<Run> => {
    let out = run;
    await change(f => {
      const r = f.runs.find(x => x.id === runId);
      if (r) out = Object.assign(r, { ended: new Date().toISOString() }, patch);
    });
    return out;
  };
  const fail = async (why: string) => {
    await finish({ state: 'failed', line: `Failed: ${why.replace(/\.$/, '')}.` });
    return { state: 'failed' as const, error: why };
  };
  if (!j) return fail('its job was deleted');
  if (!A.approvedNow(j)) return fail('the job changed after it was approved; approve it again');
  const m = staff.get(j.recipe.agent);
  if (!m || !worksAlone(m.role)) return fail(`${run.agentName} is not on the team as an Agent any more`);
  // A run cut by a restart goes on once from its notes; cut a second time, it fails.
  const saved = run.started ? await readData<RunNotes | null>(notesFile(runId), null, { leave: true }).catch(() => null) : null;
  if (saved?.resumed) return fail('it was cut by a restart twice');
  const workspace = await workspaceDir();
  const root = resultsDir(workspace, m.id, j.recipe.results.folder);
  // B6: a drive nearly full holds the run (it would fill it).
  const free = await freeOn(workspace);
  if (free !== null && free < DISK_MIN) {
    await finish({ state: 'held', line: `Held: the drive has only ${(free / 2 ** 30).toFixed(1)} GB free (keep at least 2 GB free).`, held: [{ what: 'run while the drive is nearly full' }] });
    return { state: 'done', result: 'Held: the drive is nearly full.' };
  }
  // A results folder that cannot be made (a file has its name, the drive refused it) fails the run in words, not left
  // "Waiting for its PC." while its queue item has failed.
  let dir: string;
  try {
    await mkdir(root, { recursive: true });
    const taken = new Set(await readdir(root).catch(() => [] as string[]));
    dir = runFolder(stamp(), taken);
    await mkdir(join(root, dir), { recursive: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    return fail(`its results folder "${j.recipe.results.folder}" could not be made (${code === 'EEXIST' || code === 'ENOTDIR' ? 'a file in the way has its name' : code === 'EPERM' || code === 'EACCES' ? 'Windows refused it' : 'the drive refused it'})`);
  }
  const startedAt = run.started ?? new Date().toISOString();
  await change(f => { const r = f.runs.find(x => x.id === runId); if (r) Object.assign(r, { state: 'running', started: startedAt, line: 'Running.' }); });
  agentDoor.running++;
  try {
    return await inScope({ project: '', queue: true, staff: m.id }, async () => {
      st.stage = 'Getting the model ready';
      const hb = await jobRoutes.hireBrain(m, t => { st.stage = t; }, signal);
      const s = await store.settings();
      const ctx = hb.brain.ctx || 8192;
      const perCall = Math.max(2000, Math.min(12_000, Math.floor(ctx * 4 * 0.15)));
      const memory = await memoryFor(m, j.recipe.task, ctx);
      // N4: his note for the next run, given to this one only (cleared once the run has had it). Like its memory, a
      // search may not carry it out of the PC.
      const note = j.nextNote?.text ?? '';
      const kit = new AgentKit({ memory: [memory, note].filter(Boolean).join('\n\n'), recipe: j.recipe, root, runDir: dir, search: s.webSearch ?? { provider: 'duckduckgo' }, perCall, total: Math.max(6000, Math.min(120_000, ctx * 4 * 0.5)), seed: [j.recipe.task], deadline: Date.now() + j.recipe.stop.minutes * 60_000, reports: name => reportOfJob(name, j.id), calendar: calendarEvents });
      const by = run.file ? `${run.by} (${run.file})` : run.by;
      // A page watch's run: what changed is given in the brief, and counts as read (its quotes are checked against it).
      const changes = await readFile(changesFile(runId), 'utf8').catch(() => '');
      if (changes) {
        kit.read.push({ source: 'the watched pages', text: changes });
        // A change that looks like orders for an AI stops the web for the run, as a page read in it would.
        const scan = scanText(changes, { long: false });
        if (scan.suspect) kit.stopWeb('a watched page', scan.reasons);
      }
      const result = await runAgent({
        recipe: j.recipe, agentName: m.name, system: staffSystem(m), memory, lastReport: await lastReportOf(j.id, runId), by, resume: saved, ...(changes ? { changes } : {}), ...(note ? { note } : {}),
        chat: hb.brain.chat, kit, signal, ctx, stage: t => { st.stage = t; },
        save: async n => { await mkdir(NOTES_DIR, { recursive: true }); await writeFile(notesFile(runId), JSON.stringify(n)); },
      });
      if (note) await change(f => { const x = f.jobs.find(y => y.id === j.id); if (x?.nextNote?.text === note) delete x.nextNote; });
      const ended = new Date().toISOString();
      const rel = `agents/${m.id}/${j.recipe.results.folder}/${dir}/report.md`;
      await writeFile(join(root, dir, 'report.md'), reportMarkdown({ job: j.recipe.name, agentName: m.name, pc: 'this PC', by, started: startedAt, ended, model: hb.model }, result));
      // B7: proposals wait in the agent's Inbox; a model never writes memory by itself.
      for (const p of result.proposals) await notebooks.add(`staff:${m.id}`, p, 'suggested', INBOX_GROUP).catch(() => null);
      // Only the last N runs are kept (the recipe's "keep").
      for (const old of toPrune(await readdir(root).catch(() => []), j.recipe.results.keep)) await rm(join(root, old), { recursive: true, force: true }).catch(() => undefined);
      await rm(notesFile(runId), { force: true }).catch(() => undefined);
      await rm(changesFile(runId), { force: true }).catch(() => undefined);
      const state = result.state === 'stopped' ? 'stopped' : result.state;
      const done = await finish({ state, line: result.line, report: rel, held: result.held.map(h => ({ what: h.what, ...(h.tool ? { tool: h.tool } : {}), ...(h.never ? { never: true } : {}) })), ended });
      if (hb.here) unloadLater(hb.pane, hb.pane?.view.model ?? '', Date.now());
      void tellOutside(done, j);
      for (const next of A.afterRuns(now, done)) void startRun(next, `After ${j.recipe.name}`);
      if (result.state === 'failed') return { state: 'failed', error: result.error ?? result.line };
      return { state: 'done', result: homeText(m.name, j.recipe.name, state, result.line) };
    });
  } catch (e) {
    if (signal.aborted) {
      await finish({ state: 'stopped', line: 'Stopped.' });
      return { state: 'failed', error: 'Stopped.' };
    }
    const out = await fail((e as Error).message);
    const r = now.runs.find(x => x.id === runId);
    if (r) void tellOutside(r, j);
    return out;
  } finally {
    agentDoor.running = Math.max(0, agentDoor.running - 1);
  }
}

/**
 * N3: a finished run told outside TOMLIN, by code: a silent Windows notification (the person and the event only), and
 * the one-line summary to his phone when the job's tick and Settings say so. Never the report.
 */
/** A job's last phone summary that was not sent, in words (kept until one is sent; not across a restart). */
const phoneMiss = new Map<string, string>();

async function tellOutside(r: Run, j: Job | undefined): Promise<void> {
  const o = { agentName: r.agentName, job: r.name, state: r.state, line: r.line };
  const w = windowsLine(o);
  if (w) await notifier.tell(r.state === 'failed' || r.state === 'skipped' ? 'stuck' : 'finished', w, 'home:').catch(() => undefined);
  if (j?.phone) {
    const sent = await tellPhone(o).catch(() => ({ sent: false, why: 'it could not be sent' }));
    // A send that failed is said on the job's card (and in Settings) until one goes, not only in the console.
    if (sent.sent) phoneMiss.delete(j.id);
    else if (sent.why && !['off', 'nothing to send'].includes(sent.why)) {
      const at = new Date().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      phoneMiss.set(j.id, `The summary of ${at} was not sent to your phone: ${noPaths(sent.why).replace(/\.$/, '')}.`);
      console.log(`An agent summary was not sent to the phone: ${sent.why}.`);
    }
  }
}

// ---- The timer: clock triggers, files landing, waiting too long ----

async function tick(): Promise<void> {
  try {
    now = A.cleanFile(await readData(FILE, A.EMPTY_FILE));
    const t = Date.now();
    const due = A.clockTick(now, t);
    await change(f => { for (const j of f.jobs) if (due.next[j.id]) j.next = due.next[j.id]; });
    for (const s of due.start) await startRun(s.job, s.by);
    // Files landing: each file trigger's folder inside the job's results, once a minute.
    if (Math.floor(t / 30_000) % 2 === 0) {
      const workspace = await workspaceDir();
      for (const j of now.jobs) {
        for (const [i, tr] of j.recipe.when.entries()) {
          if (tr.kind !== 'file') continue;
          const folder = join(resultsDir(workspace, j.recipe.agent, j.recipe.results.folder), tr.folder);
          await mkdir(folder, { recursive: true }).catch(() => undefined);
          const there = (await readdir(folder, { withFileTypes: true }).catch(() => [])).filter(d => d.isFile()).map(d => d.name);
          // One run is in line per job, so one new file is taken a look while there is room; the rest stay new (not
          // seen) for a later look, rather than being noted and never run for. A paused job notes files as before.
          const was = j.seen[String(i)];
          const runs = A.mayRun(j);
          if (runs && was && !A.fileRoom(now, j.id, t)) continue;
          const got = filesDue(was, there, runs ? 1 : 5);
          let seen = got.seen;
          if (runs) for (const file of got.run) if ((await startRun(j.id, `${A.FILE_BY} ${tr.folder}`, `${tr.folder}/${file}`)).error) seen = seen.filter(s => s !== file);
          await change(f => { const x = f.jobs.find(y => y.id === j.id); if (x) x.seen[String(i)] = seen; });
        }
      }
    }
    void pageLooks();
    // B6: a run that waited longer than its job's "Wait at most" for its PC is skipped, with the reason. N1: while a
    // person uses this PC (src/pcbusy.ts), a waiting run says so, and a skip says why.
    const using = agentHold.why;
    for (const r of now.runs.filter(x => x.state === 'waiting')) {
      const j = jobOf(r.job);
      const most = (j?.recipe.waitMinutes ?? 60) * 60_000;
      if (t - Date.parse(r.added) > Math.max(most, 60_000)) {
        if (r.queue) await cancelAgentItem(r.queue);
        await change(f => { const x = f.runs.find(y => y.id === r.id); if (x) Object.assign(x, { state: 'skipped', ended: new Date().toISOString(), line: A.skipLine(f, x, Math.round(most / 60_000), using || (x.heldWhy ?? '')) }); });
        const sk = now.runs.find(y => y.id === r.id);
        if (sk) void tellOutside(sk, j);
      } else if (using ? r.line !== A.inUseLine(using) : r.line.startsWith(A.IN_USE_LINE)) {
        await change(f => { const x = f.runs.find(y => y.id === r.id); if (x && x.state === 'waiting') Object.assign(x, using ? { line: A.inUseLine(using), heldWhy: using } : { line: 'Waiting for its PC.' }); });
      }
    }
  } catch (e) {
    log.error('agents', e);
  }
}

// ---- Page watches (N2): looked at by code, a run only when a page changed ----

let looking = false;
/** Each page watch that is due: its pages looked at one after another (no model loaded); a change starts one run. */
async function pageLooks(): Promise<void> {
  if (looking) return;
  looking = true;
  try {
    for (const j of now.jobs) {
      const tr = A.pageTrigger(j);
      // A paused or unapproved job is not looked at, nor one with a run in line (its change would be used up unseen).
      if (!tr || !A.mayRun(j) || A.inLine(now, j.id)) continue;
      const t = Date.now();
      const states = j.watch ?? [];
      if (!watchDue(states, j.recipe.pages, tr.everyMinutes, t)) continue;
      const kept = await readLines(HOME.data, j.id);
      const nextStates: PageState[] = [];
      const changed: { url: string; gone: string[]; added: string[]; more: boolean }[] = [];
      const said: string[] = [];
      let linesChanged = false;
      for (const url of j.recipe.pages) {
        const got = await lookPage(url, states.find(x => x.url === url), kept[url] ?? [], { pace: POLITE });
        nextStates.push(got.state);
        if (got.lines) {
          kept[url] = got.lines;
          linesChanged = true;
        }
        if (got.change && watchHit(got.change, j.recipe.watchFor ?? [])) changed.push({ url, ...got.change });
        if (got.failSay) said.push(got.failSay);
      }
      for (const url of Object.keys(kept)) {
        if (j.recipe.pages.includes(url)) continue;
        delete kept[url];
        linesChanged = true;
      }
      if (linesChanged) await writeLines(HOME.data, j.id, kept);
      await change(f => { const x = f.jobs.find(y => y.id === j.id); if (x) x.watch = nextStates; });
      const m = staff.get(j.recipe.agent);
      for (const line of said) {
        const at = new Date().toISOString();
        await change(f => {
          f.runs.push({ id: newId(), job: j.id, name: j.recipe.name, agent: j.recipe.agent, agentName: m?.name ?? j.recipe.agent, by: 'Its page watch', state: 'skipped', added: at, ended: at, line: `Page watch: ${line}`, held: [] });
          f.runs = f.runs.slice(-A.RUNS_KEPT);
        });
      }
      if (changed.length) {
        const sites = [...new Set(changed.map(c => siteOf(c.url)))].slice(0, 3).join(', ');
        const r = await startRun(j.id, `${A.PAGE_BY}: ${sites}`, undefined, changesBlock(changed));
        if (r.error) log.error('agents', new Error(`page watch: ${r.error}`));
      }
    }
  } catch (e) {
    log.error('agents', e);
  } finally {
    looking = false;
  }
}

// ---- Collecting reports from linked PCs (B5) ----

async function others() {
  const s = await store.settings();
  return s.remotes.filter(r => r.role !== 'guest');
}

/** Pulls new reports from each linked PC that answers, into agents/from <PC>/ here. */
export async function collect(): Promise<{ got: number; said: string[] }> {
  let got = 0;
  const said: string[] = [];
  const workspace = await workspaceDir();
  for (const r of await others()) {
    try {
      const listRes = await workerPost(r, '/worker/agents', { action: 'list' }, AbortSignal.timeout(6000));
      if (listRes.status === 404) continue;
      const list = (await listRes.json().catch(() => ({}))) as { runs?: Run[] };
      const there = (list.runs ?? []).map(A.cleanRun).filter((x): x is Run => !!x && !!x.report && A.RUN_FINISHED.includes(x.state));
      const want = toCollect(there.map(x => ({ id: x.id, started: x.started ?? x.added })), new Set(now.collected[r.id] ?? []));
      for (const id of want) {
        const one = there.find(x => x.id === id)!;
        const res = await workerPost(r, '/worker/agents', { action: 'report', run: id }, AbortSignal.timeout(15_000));
        const body = (await res.json().catch(() => ({}))) as { text?: string };
        if (typeof body.text !== 'string') continue;
        const rel = collectedPath(r.name, one.report!);
        const full = await ws.inside(workspace, rel);
        if (!full) continue;
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, body.text.slice(0, 2_000_000));
        await change(f => {
          f.collected[r.id] = [...(f.collected[r.id] ?? []), id].slice(-2000);
          f.runs.push({ ...one, id: newId(), job: one.job, report: rel, from: r.name, seen: false });
          f.runs = f.runs.slice(-A.RUNS_KEPT);
        });
        got++;
      }
    } catch {
      said.push(`${r.name} did not answer: its reports are collected when it is on.`);
    }
  }
  return { got, said };
}

// ---- What the page reads ----

/** Runs newest first, by when they started (or were added). */
const byTime = (rs: Run[]): Run[] => [...rs].sort((a, b) => (b.started ?? b.added).localeCompare(a.started ?? a.added));

function jobView(j: Job, t = Date.now()) {
  const nextAt = j.next.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)[0] ?? null;
  const runs = byTime(now.runs.filter(r => r.job === j.id && !r.from));
  const last = runs.find(r => A.RUN_FINISHED.includes(r.state));
  const inLine = A.inLine(now, j.id);
  const m = staff.get(j.recipe.agent);
  // What runs since it was last approved held (an Allow next time approves it again, so those drop off), once each.
  const heldNow = runs.filter(r => !j.approvedAt || (r.ended ?? r.added) >= j.approvedAt).flatMap(r => r.held).filter((h, i, all) => all.findIndex(x => x.what === h.what) === i && !(h.tool && j.recipe.tools.includes(h.tool))).slice(0, 8);
  return {
    id: j.id, recipe: j.recipe, text: recipeText(j.recipe, m?.name ?? j.recipe.agent), agentName: m?.name ?? j.recipe.agent, agentGone: !m || !worksAlone(m.role),
    approved: A.approvedNow(j), paused: j.paused, when: j.recipe.when.map(triggerWords),
    next: j.paused ? 'Paused' : !A.approvedNow(j) ? 'Not approved' : nextAt ? whenWords(nextAt, t) : j.recipe.when.some(timed) ? 'Not set' : 'On its trigger',
    nextAt, running: inLine?.state ?? null, last: last ? { state: last.state, line: last.line, at: last.ended ?? last.added, report: last.report ?? '', run: last.id } : null,
    held: heldNow, approval: approvalLines(j.recipe), warning: taskWarning(j.recipe.task), phone: !!j.phone, phoneSaid: j.phone ? phoneMiss.get(j.id) ?? '' : '', nextNote: j.nextNote?.text ?? '',
    watch: A.pageTrigger(j) ? j.recipe.pages.map(url => ({ url, line: j.watch?.find(w => w.url === url)?.last || 'Not looked at yet.' })) : [],
  };
}

async function view() {
  const t = Date.now();
  return {
    time: new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    node: isNode(),
    jobs: now.jobs.map(j => jobView(j, t)),
    runs: byTime(now.runs).slice(0, 80),
    agents: agentsHere(),
  };
}

/** Each linked PC's agents, as its door says (off: said so). */
async function othersView() {
  return Promise.all((await others()).map(async r => {
    try {
      const res = await workerPost(r, '/worker/agents', { action: 'list' }, AbortSignal.timeout(5000));
      if (res.status === 404) return { pc: r.id, name: r.name, state: 'old' as const };
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { pc: r.id, name: r.name, state: 'on' as const, ...b };
    } catch {
      return { pc: r.id, name: r.name, state: 'off' as const };
    }
  }));
}

// ---- Changing a job ----

/** Saves a recipe (new or changed). `approve`: he pressed Approve and save on the card that lists every tool. */
async function saveJob(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const read = typeof b.text === 'string' ? readRecipe(b.text) : cleanRecipe(b.recipe);
  const checked = checkAgainst(read.recipe, { agents: agentsHere(), pcs: [], jobs: readableJobs() });
  const problems = [...read.problems, ...checked.problems];
  if (problems.length) return { status: 400, body: { error: problems[0], problems, notes: read.notes } };
  const recipe = checked.recipe;
  if (b.approve !== true) return { status: 409, body: { error: 'Approve the tools on the card first.', approve: true, approval: approvalLines(recipe), warning: taskWarning(recipe.task) } };
  const id = typeof b.id === 'string' && jobOf(b.id) ? b.id : newId();
  const full = { status: 409, body: { error: `${A.JOBS_MOST} standing jobs is the most on one PC.` } };
  if (!jobOf(id) && now.jobs.length >= A.JOBS_MOST) return full;
  const at = new Date().toISOString();
  // Checked again in the file's own turn: a burst of saves at once never passes the most, and never says "saved" for a
  // job the next save would drop. Two jobs of one Agent never share a results folder (one job's "keep" would delete
  // the other's reports).
  let refused: { status: number; body: unknown } | null = null;
  await change(f => {
    const was = f.jobs.find(x => x.id === id);
    if (!was && f.jobs.length >= A.JOBS_MOST) { refused = full; return; }
    const sharing = f.jobs.find(x => x.id !== id && x.recipe.agent === recipe.agent && x.recipe.results.folder.toLowerCase() === recipe.results.folder.toLowerCase());
    if (sharing) { refused = { status: 400, body: { error: `"${sharing.recipe.name}" already keeps ${nameOf(recipe.agent)}'s results in the folder "${recipe.results.folder}": give this job a folder of its own (Results: folder "...").` } }; return; }
    const watch = recipe.when.some(tr => tr.kind === 'page') ? (was?.watch ?? []).filter(w => recipe.pages.includes(w.url)) : [];
    const job: Job = { id, recipe, approved: recipeHash(recipe), approvedAt: at, paused: was?.paused ?? false, next: recipe.when.map(tr => (timed(tr) ? nextTime(tr, Date.now()) : null)), seen: was && JSON.stringify(was.recipe.when) === JSON.stringify(recipe.when) ? was.seen : {}, ...(watch.length ? { watch } : {}), made: was?.made ?? at, changed: at };
    if (was) {
      if (!job.watch) delete was.watch;
      Object.assign(was, job);
    }
    else f.jobs.push(job);
  });
  if (refused) return refused;
  return { status: 200, body: { saved: id, notes: read.notes, ...(await view()) } };
}

/** The actions every caller has (the page here, and an admin PC over the link). `local`: from this PC's own page. */
async function act(b: Record<string, unknown>, local: boolean, also: { id: string; name: string }[] = []): Promise<{ status: number; body: unknown }> {
  const action = String(b.action ?? '');
  const id = String(b.job ?? '');
  const changing = ['save', 'delete', 'allow'].includes(action);
  if (local && changing && isNode()) return { status: 403, body: { error: NODE_WHY } };
  if (action === 'check') {
    const read = typeof b.text === 'string' ? readRecipe(b.text) : cleanRecipe(b.recipe);
    const checked = checkAgainst(read.recipe, { agents: [...agentsHere(), ...also], pcs: [], jobs: readableJobs() });
    return { status: 200, body: { recipe: checked.recipe, problems: [...read.problems, ...checked.problems], notes: read.notes, text: recipeText(checked.recipe, nameOf(checked.recipe.agent)), approval: approvalLines(checked.recipe), warning: taskWarning(checked.recipe.task) } };
  }
  if (action === 'save') return saveJob(b);
  const j = jobOf(id);
  if (!j && action !== 'seen') return { status: 404, body: { error: 'That job is not here any more.' } };
  if (action === 'delete') {
    const r = A.inLine(now, id);
    if (r?.queue) await cancelAgentItem(r.queue);
    // A run of it still waiting is ended too, so it is not left listed as waiting for a job that is gone.
    await change(f => {
      f.jobs = f.jobs.filter(x => x.id !== id);
      for (const x of f.runs) if (x.job === id && x.state === 'waiting') Object.assign(x, { state: 'stopped', ended: new Date().toISOString(), line: 'Stopped before it ran: the job was deleted.' });
    });
    await dropLines(HOME.data, id).catch(() => undefined);
  } else if (action === 'pause') {
    const paused = b.paused !== false;
    await change(f => { const x = f.jobs.find(y => y.id === id); if (x) x.paused = paused; });
    // A run of it still waiting for the PC does not go ahead once it is paused (one already running goes on: Stop ends it).
    const r = paused ? A.inLine(now, id) : null;
    if (r?.queue && r.state === 'waiting') {
      await cancelAgentItem(r.queue);
      await change(f => { const x = f.runs.find(y => y.id === r.id); if (x && x.state === 'waiting') Object.assign(x, { state: 'stopped', ended: new Date().toISOString(), line: 'Stopped before it ran: the job was paused.' }); });
    }
  } else if (action === 'run') {
    const r = await startRun(id, 'Run now');
    if (r.error) return { status: 409, body: { error: r.error } };
  } else if (action === 'stop') {
    const r = A.inLine(now, id);
    if (!r?.queue) return { status: 409, body: { error: 'It is not running or waiting.' } };
    await cancelAgentItem(r.queue);
    if (r.state === 'waiting') await change(f => { const x = f.runs.find(y => y.id === r.id); if (x) Object.assign(x, { state: 'stopped', ended: new Date().toISOString(), line: 'Stopped before it ran.' }); });
  } else if (action === 'allow') {
    const tool = String(b.tool ?? '') as AgentTool;
    if (!AGENT_TOOLS.some(t => t.id === tool)) return { status: 400, body: { error: 'That is not a tool an agent can be given.' } };
    await change(f => { const i = f.jobs.findIndex(x => x.id === id); if (i >= 0) f.jobs[i] = A.allowTool(f.jobs[i], tool); });
  } else if (action === 'phone') {
    // Not a recipe change: the job stays approved.
    const on = b.phone === true;
    await change(f => { const x = f.jobs.find(y => y.id === id); if (x) { if (on) x.phone = true; else delete x.phone; } });
  } else if (action === 'note') {
    // "Next run, also: ...": one note, for the next run only. Read by the prompt scan as a pasted message is.
    const text = typeof b.text === 'string' ? b.text.replace(/\r/g, '').trim() : '';
    if (text.length > A.NOTE_MOST) return { status: 400, body: { error: `A note for the next run is at most ${A.NOTE_MOST} characters.` } };
    if (text && looksSecret(text)) return { status: 400, body: { error: 'The note looks like it holds a password, key or token. Take it out: an agent never handles those.' } };
    const scan = text ? scanText(text, { long: false }) : null;
    if (scan?.suspect && b.anyway !== true) return { status: 409, body: { error: `The note looks like orders for an AI (${scan.reasons.slice(0, 2).join('; ')}). Keep it anyway only if you wrote it yourself.`, scan: true } };
    await change(f => { const x = f.jobs.find(y => y.id === id); if (x) { if (text) x.nextNote = { text, at: new Date().toISOString() }; else delete x.nextNote; } });
  } else if (action === 'seen') {
    const ids = new Set((Array.isArray(b.runs) ? b.runs : []).filter((x): x is string => typeof x === 'string'));
    await change(f => { for (const r of f.runs) if (ids.has(r.id)) r.seen = true; });
  } else return { status: 400, body: { error: 'TOMLIN does not know that action for agents.' } };
  return { status: 200, body: await view() };
}

/** An admin PC's ask over the link (src/jobrun/node.ts /worker/agents). */
async function door(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const action = String(b.action ?? '');
  if (action === 'list') {
    const v = await view();
    return { status: 200, body: { time: v.time, jobs: v.jobs, runs: byTime(now.runs.filter(r => !r.from)).slice(0, 80), agents: v.agents } };
  }
  if (action === 'report') {
    const r = now.runs.find(x => x.id === String(b.run ?? ''));
    if (!r?.report) return { status: 404, body: { error: 'That report is not here.' } };
    const full = await ws.inside(await workspaceDir(), r.report);
    const text = full ? await readFile(full, 'utf8').catch(() => null) : null;
    return text === null ? { status: 404, body: { error: 'That report is not on this PC any more (only the last runs are kept).' } } : { status: 200, body: { text } };
  }
  // The admin PC hires the Agent here when the recipe names one this PC does not have yet (an Agent with no model of
  // their own answers on the model loaded here). Checked first as if they were here.
  if ((action === 'save' || action === 'check') && typeof b.text === 'string') {
    const name = readRecipe(b.text).recipe.agent.trim();
    const known = A.agentKnown(name, agentsHere());
    if (name && !known) {
      if (action === 'check') return act(b, false, [{ id: name, name }]);
      await staff.hire(name, 'agent', 'default', null);
    }
  }
  return act(b, false);
}

// ---- The Agents page's settings (N1: while a person uses this PC) ----

async function settingsView() {
  const u = await readInUse();
  const node = isNode();
  const held = lastInUse();
  const p = await readPhone();
  const sec = await readSecrets();
  return {
    node,
    inUse: { whileInUse: u.whileInUse ?? node, chosen: u.whileInUse !== undefined, keyMinutes: u.keyMinutes, defaultMinutes: KEY_MINUTES, now: held?.busy ? held.why : '' },
    phone: { ...p, topic: maskTopic(sec.topic ?? ''), hasTopic: !!sec.topic, jobs: now.jobs.filter(j => j.phone).map(j => j.recipe.name), notSent: now.jobs.filter(j => j.phone && phoneMiss.has(j.id)).map(j => `${j.recipe.name}: ${phoneMiss.get(j.id)}`) },
    calendars: (sec.calendars ?? []).map(maskCalendar),
  };
}

async function saveSettings(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const u = (b.inUse && typeof b.inUse === 'object' ? b.inUse : null) as Record<string, unknown> | null;
  if (u) {
    const minutes = u.keyMinutes === undefined ? undefined : Math.round(Number(u.keyMinutes));
    if (minutes !== undefined && !(minutes >= 1 && minutes <= 120)) return { status: 400, body: { error: 'Count a key press for 1 to 120 minutes.' } };
    await saveInUse({ ...(typeof u.whileInUse === 'boolean' ? { whileInUse: u.whileInUse } : {}), ...(minutes !== undefined ? { keyMinutes: minutes } : {}) });
  }
  const p = (b.phone && typeof b.phone === 'object' ? b.phone : null) as Record<string, unknown> | null;
  if (p) {
    if (typeof p.server === 'string' && p.server.trim() && !cleanServer(p.server)) return { status: 400, body: { error: 'Give the ntfy server as https://ntfy.sh or https://your-server, or http:// only for a server on your own network.' } };
    if (typeof p.topic === 'string' && p.topic.trim() && !cleanTopic(p.topic)) return { status: 400, body: { error: 'A topic is letters, digits, _ and -, at most 64 (as the ntfy app shows it).' } };
    if (typeof p.topic === 'string' && p.topic.trim()) await saveSecrets({ topic: cleanTopic(p.topic) });
    if (p.clearTopic === true) await saveSecrets({ topic: '' });
    await savePhone({ ...(typeof p.on === 'boolean' ? { on: p.on } : {}), ...(typeof p.server === 'string' ? { server: p.server } : {}), ...(typeof p.onlyChanged === 'boolean' ? { onlyChanged: p.onlyChanged } : {}) });
  }
  // N6: calendar addresses, kept as secrets; added one per line, taken off by their place in the list.
  if (typeof b.addCalendars === 'string') {
    const lines = b.addCalendars.split(/\s+/).map(x => x.trim()).filter(Boolean);
    const bad = lines.filter(x => !cleanCalendarUrl(x));
    if (bad.length) return { status: 400, body: { error: `${bad.length === 1 ? 'One address is' : `${bad.length} addresses are`} not a calendar address: give the secret iCal address (it starts https:// or webcal://).` } };
    // Added in the file's own turn, from what is there then: two adds at once both stay.
    let tooMany = false;
    await saveSecrets(s => {
      const next = [...new Set([...(s.calendars ?? []), ...lines.map(cleanCalendarUrl)])];
      if (next.length > 10) { tooMany = true; return undefined; }
      return { calendars: next };
    });
    if (tooMany) return { status: 400, body: { error: '10 calendars is the most.' } };
    calCache = null;
  }
  if (Number.isInteger(b.dropCalendar)) {
    await saveSecrets(s => ({ calendars: (s.calendars ?? []).filter((_, i) => i !== b.dropCalendar) }));
    calCache = null;
  }
  if (b.action === 'test-calendar') {
    calCache = null;
    const got = await calendarEvents();
    const said = got.events.length ? `Read ${got.events.length} event${got.events.length === 1 ? '' : 's'} in all.${got.said.length ? ` ${got.said.join(' ')}` : ''}` : got.said.join(' ') || 'The calendar opened but has no events.';
    return { status: 200, body: { ...(await settingsView()), said } };
  }
  if (b.action === 'test-phone') {
    const t = await testPhone();
    return { status: t.ok ? 200 : 409, body: { ...(await settingsView()), said: t.said, ...(t.ok ? {} : { error: t.said }) } };
  }
  return { status: 200, body: await settingsView() };
}

// ---- Routes ----

export const agentsGet: Routes = {
  '/api/agents': async ({ res }) => json(res, 200, await view()),
  '/api/agents/others': async ({ res }) => json(res, 200, { pcs: await othersView() }),
  '/api/agents/settings': async ({ res }) => json(res, 200, await settingsView()),
  '/api/agents/help': async ({ res }) => json(res, 200, { starters: STARTERS, prompt: CHATBOT_PROMPT, tools: AGENT_TOOLS.map(({ id, name, what }) => ({ id, name, what })), never: NEVER.map(n => n.name), roles: roleOf('agent').hint }),
  '/api/agents/report': async ({ res, url }) => {
    const r = now.runs.find(x => x.id === url.searchParams.get('run'));
    if (!r?.report) return json(res, 404, { error: 'That run has no report.' });
    const full = await ws.inside(await workspaceDir(), r.report);
    const text = full ? await readFile(full, 'utf8').catch(() => null) : null;
    return text === null ? json(res, 404, { error: 'That report is not here any more: only the last runs are kept.' }) : json(res, 200, { text, path: r.report, run: r });
  },
};

export const agentsPost: Routes = {
  '/api/agents': async ({ res, b }) => {
    const r = await act(b, true);
    return json(res, r.status, r.body);
  },
  '/api/agents/collect': async ({ res }) => json(res, 200, await collect()),
  '/api/agents/settings': async ({ res, b }) => {
    let r: Awaited<ReturnType<typeof saveSettings>>;
    try {
      r = await saveSettings(b);
    } catch (e) {
      // A settings file another program holds (a scanner, a sync program): nothing was written over it.
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw e;
      return json(res, 409, { error: 'The agent settings could not be saved: another program is holding the file. Nothing was lost. Try again in a moment.' });
    }
    return json(res, r.status, r.body);
  },
  // A job on a linked PC, from this (admin) PC: the same actions, over the link.
  '/api/agents/remote': async ({ res, b }) => {
    const r = (await others()).find(x => x.id === b.pc);
    if (!r) return json(res, 404, { error: 'That PC is not linked any more.' });
    try {
      const got = await workerPost(r, '/worker/agents', b, AbortSignal.timeout(15_000));
      if (got.status === 404) return json(res, 409, { error: `"${r.name}" has an older TOMLIN without agents: update it first.` });
      return json(res, got.status, await got.json().catch(() => ({})));
    } catch {
      return json(res, 503, { error: `"${r.name}" did not answer: is it on?` });
    }
  },
};

/** Home's lines for finished agent runs not yet seen. */
export function agentHome() {
  // N5: that morning's brief (a job that reads the others' reports) comes first.
  const brief = (l: { runs: string[]; kind: string }) => {
    const r = l.kind === 'agent' ? now.runs.find(x => x.id === l.runs[0]) : undefined;
    const j = r ? jobOf(r.job) : undefined;
    return !!j?.recipe.tools.includes('reports') && new Date(r!.ended ?? r!.added).toDateString() === new Date().toDateString();
  };
  const lines = A.agentHomeLines(now, r => homeText(r.agentName, r.name, r.state, r.line));
  return [...lines.filter(brief), ...lines.filter(l => !brief(l))].map(l => {
    const r = l.kind === 'agent' && l.report ? now.runs.find(x => x.id === l.runs[0]) : undefined;
    // N4: Ask about this, in a chat with the Agent who wrote it (one on this PC's team).
    const ask = r && !r.from && staff.get(r.agent) ? { askAgent: r.agent } : {};
    return { ...l, agent: true, action: l.kind === 'agent-quiet' ? 'See them' : l.report ? 'Read the report' : 'See the job', ids: l.runs, ...ask };
  });
}

/** At start: runs left running go back to waiting (they carry on from their notes), then the timer every 30 s. */
export async function startAgents(): Promise<void> {
  now = A.cleanFile(await readData(FILE, A.EMPTY_FILE));
  inUseFile(HOME.data);
  notifyDir(HOME.data);
  queueHooks.agent = runOne;
  agentDoor.handle = door;
  setInterval(() => void tick(), 30_000).unref();
  setInterval(() => void collect().catch(() => undefined), 10 * 60_000).unref();
  void tick();
}
