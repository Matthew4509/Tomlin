// This PC's settings, its data and updates (src/keep.ts: the home folder, import, backups), and Connect Claude.
import type { ServerResponse } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { log, logFile } from '../log.ts';
import { toneOf } from '../persona.ts';
import { roleOf } from '../staff.ts';
import * as claude from '../claude.ts';
import * as keep from '../keep.ts';
import { clearDamaged, damaged } from '../atomic.ts';
import { HOME, PORT, ROOT, type Routes, VERSION, chatModels, json, publicSettings, ready, staff, store } from './core.ts';
import { askedOf, chatList, cleanRun, images, threadsOf } from './panes.ts';
import { setWho, whoId } from './people.ts';
import { jobRoutes } from './jobs.ts';

/** The Import question, while it is unanswered (the page asks it once). */
let offer = ready.state === 'offer' ? ready.sources : null;
// Decide later on that question: not asked again until TOMLIN starts again (a reload of the page does not ask).
let offerLater = false;

// ---- Your data and updates (src/keep.ts): the home folder, import, backups ----

/** True when Start TOMLIN.cmd starts TOMLIN again after it ends with keep.RESTART_CODE. */
const canRestart = process.env.TOMLIN_LOOP === '1';
/** When this run started: the page waits for a different one after asking for a restart. */
const startedAt = Date.now();

/**
 * Connect Claude (src/claude.ts): the prompt that makes Claude the project manager of this PC's network. Nothing secret
 * goes in it: no PIN, setup code or link key (the linked PCs are reached through this copy's own API).
 */
async function claudeView() {
  const node = jobRoutes.shareView();
  // Handovers are kept in docs/handoffs (2.0.35); older copies kept them in the app folder itself.
  const listed = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const kept = claude.newestHandoff(listed(join(ROOT, 'docs', 'handoffs')));
  const handoff = kept ? `docs\\handoffs\\${kept}` : claude.newestHandoff(listed(ROOT));
  const prompt = claude.claudePrompt({
    version: VERSION,
    appFolder: ROOT,
    homeFolder: HOME.home,
    handoff,
    port: PORT,
    pcName: node.name !== 'Worker PC' ? node.name : 'This PC',
    node: { on: node.on, port: node.port },
  });
  return { prompt };
}

/**
 * Files found damaged since the start (src/atomic.ts): said once on the page, in plain words, with where each was kept
 * and the way back (a backup from before).
 */
function damagedNote(): string {
  const list = damaged();
  if (!list.length) return '';
  const names = list.map(x => `${x.file.slice(HOME.data.length + 1).replace(/\\/g, '/')} (kept as ${x.keptAs}, beside it)`);
  return [
    `Some of your data could not be read, so TOMLIN started without it: ${names.join('; ')}.`,
    'This happens when the PC loses power while a file is being saved. Nothing was saved over the damaged file.',
    'To get it back, put back a backup from before it happened (Settings, Your data and updates), or send the kept file to someone who helps.',
  ].join('\n');
}

async function keepView() {
  const v = keep.readVersion(HOME);
  const hurt = damagedNote();
  return {
    home: HOME.home,
    version: VERSION,
    canRestart,
    startedAt,
    note: [hurt, v?.note ?? ''].filter(Boolean).join('\n\n'),
    noteTitle: hurt ? 'Some data could not be read' : v?.noteTitle ?? '',
    offer: offerLater ? null : offer?.map(s => ({ dir: s.dir, version: s.version, at: s.at, chats: s.chats, modelBytes: s.modelBytes, here: resolve(s.dir).toLowerCase() === ROOT.toLowerCase() })) ?? null,
    backups: await keep.listBackups(HOME),
    dataBytes: keep.folderBytes(HOME.data),
  };
}

/** Ends this run so Start TOMLIN.cmd starts it again (the models end with it); the planned step runs at that start. */
function restartSoon() {
  if (!canRestart) return;
  setTimeout(() => process.exit(keep.RESTART_CODE), 400).unref();
}

/**
 * Opens a program on this PC (Notepad, Explorer) without waiting for it. True when it started; false when Windows could
 * not start it (Notepad is an optional app in Windows 11), which is logged and never ends TOMLIN.
 */
async function openOnPc(program: string, args: string[]): Promise<boolean> {
  const cp = await import('node:child_process');
  return new Promise(done => {
    const child = cp.spawn(program, args, { detached: true, stdio: 'ignore' });
    child.once('spawn', () => (child.unref(), done(true)));
    child.once('error', e => (log.error('Open on this PC', `${program}: ${e.message}`), done(false)));
  });
}

/** One backup at a time: a second press while one is being made waits for it instead of writing the same zip. */
let backingUp: Promise<string> | null = null;

async function keepAction(res: ServerResponse, b: Record<string, unknown>) {
  const restartWords = canRestart ? 'TOMLIN is starting again to do it (about 10 seconds).' : 'It happens the next time TOMLIN starts: close its window and start it again.';
  switch (b.do) {
    case 'bring-in': {
      const from = offer?.find(s => s.dir === b.from);
      if (!from) return json(res, 400, { error: 'That copy is not one TOMLIN offered to import. Close this window and open the page again.' });
      await keep.planNext(HOME, { do: 'bring-in', from: from.dir });
      restartSoon();
      return json(res, 200, { restarting: canRestart, said: restartWords });
    }
    case 'start-empty':
      await keep.startEmpty(HOME, VERSION);
      offer = null;
      return json(res, 200, await keepView());
    case 'backup': {
      if (backingUp) return json(res, 409, { error: 'A backup is being made now. Wait for it to finish (it shows in the list below).' });
      backingUp = keep.backup(HOME, 'by hand');
      const name = await backingUp.finally(() => { backingUp = null; });
      return json(res, 200, { ...(await keepView()), said: `Backed up as "${name.replace(/\.zip$/, '')}".` });
    }
    case 'restore': {
      const name = (await keep.listBackups(HOME)).find(x => x.name === b.name)?.name;
      if (!name) return json(res, 400, { error: 'That backup is no longer in the backups folder. Close this window and open it again.' });
      await keep.planNext(HOME, { do: 'restore', name });
      restartSoon();
      return json(res, 200, { restarting: canRestart, said: restartWords });
    }
    case 'later':
      offerLater = true;
      return json(res, 200, { ok: true });
    case 'note-shown':
      clearDamaged();
      await keep.noteShown(HOME);
      return json(res, 200, { ok: true });
    case 'open':
      if (process.platform === 'win32' && !(await openOnPc('explorer', [HOME.home]))) return json(res, 500, { error: `Windows could not open the folder. It is ${HOME.home}.` });
      return json(res, 200, { ok: true });
    case 'open-log': {
      // Today's log in the PC's own text viewer (Notepad), or the logs folder when nothing was logged today.
      const file = logFile();
      const there = file && existsSync(file);
      const folder = join(HOME.data, 'logs');
      // Without Notepad (it can be removed in Windows 11) the logs folder opens instead.
      const inNotepad = process.platform === 'win32' && !!file && there && (await openOnPc('notepad', [file]));
      if (process.platform === 'win32' && file && !inNotepad) await openOnPc('explorer', [folder]);
      const said = inNotepad ? `Opened ${file}.` : there ? `Notepad is not on this PC, so the logs folder (${folder}) is open: today's log is ${file}.` : `Nothing went wrong today, so today's log is empty. The logs folder (${folder}) is open: it keeps the last 7 days.`;
      return json(res, 200, { ok: true, file, empty: !there, said });
    }
    default:
      return json(res, 400, { error: 'Unknown action.' });
  }
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const settingsGet: Routes = {
  '/api/keep': async ({ res }) => json(res, 200, await keepView()),
  '/api/claude': async ({ res }) => json(res, 200, await claudeView()),
};

/** POST requests answered here, by path (the body is read already). */
export const settingsPost: Routes = {
  '/api/settings': async ({ res, b }) => {
    const pane = b.pane === 'image' ? 'image' : 'chat';
    const change: Record<string, unknown> = {};
    if ('threads' in b) change.threads = threadsOf(b.threads);
    if ('idleMinutes' in b) change.idleMinutes = Math.max(0, Math.min(1440, Math.floor(Number(b.idleMinutes) || 0)));
    if ('asked' in b) change.asked = askedOf(b.asked);
    if ('model' in b) change.model = typeof b.model === 'string' ? b.model : null;
    // Everything is checked before anything is saved, so a refused change never leaves half of the others saved.
    const to = 'who' in b ? whoId(b.who) : null;
    const hostModel = 'hostModel' in b ? (typeof b.hostModel === 'string' ? b.hostModel : '') : null;
    if (hostModel && !chatList().some(m => m.id === hostModel)) return json(res, 400, { error: 'That model is not on this PC any more. Pick another, or get one under Add a model.' });
    if (to !== null) await setWho(to);
    if ('tone' in b) await store.saveSettings({ tone: toneOf(b.tone).id });
    if (hostModel !== null) await store.saveSettings({ hostModel });
    if ('imageAs' in b) {
      const v = String(b.imageAs);
      const m = staff.get(v);
      await store.saveSettings({ imageAs: m && roleOf(m.role).kind ? m.id : '' });
    }
    if ('draftDays' in b) {
      const days = [0, 7, 30, 90].includes(Number(b.draftDays)) ? Number(b.draftDays) : 0;
      await store.saveSettings({ draftDays: days });
      await images.gallery.clearDrafts(days).catch(() => 0);
    }
    if (typeof b.runModel === 'string' && chatModels.path(b.runModel)) await store.saveSettings({ run: { [b.runModel]: cleanRun(b.run) } });
    return json(res, 200, publicSettings(await store.saveSettings({ [pane]: change })));
  },
  '/api/keep': async ({ res, b }) => keepAction(res, b),
};
