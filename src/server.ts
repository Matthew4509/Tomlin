// TOMLIN's local server: serves the page, runs the two panes (chat, image) as separate worker processes that load only
// on Connect and unload on Disconnect, and offers the same things to other apps through OpenAI-style endpoints.
// Listens on 127.0.0.1 only.
// The parts live in src/server/ by area, each with its own routes; this file puts them together, guards every
// request and sends it to the area that answers it.
import './envnames.ts';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log.ts';
import { roleOf } from './staff.ts';
import { gateOf } from './applock.ts';
import { refreshTray } from './trayfresh.ts';
import { autostart } from './autostart.ts';
import { ALREADY_RUNNING, HOME, PORT, ROOT, startupOf, type Route, type Routes, VERSION, apiError, body, hooks, saidError, json, staff, staticFile, store } from './server/core.ts';
import { settingsGet, settingsPost } from './server/settings.ts';
import { appLock, appLockAction, appLockOn, appLockView, appOk } from './server/locks.ts';
import { images, loadModel, openAiChat, panesGet, panesPost, unloadPane } from './server/panes.ts';
import { answeringGet, answeringPost, askOnce } from './server/answering.ts';
import { faceFile, offHost, peopleGet, peoplePost } from './server/people.ts';
import { addDoc, chatGet, chatPost } from './server/chat.ts';
import { picturesPost } from './server/pictures.ts';
import { previewFile, projectPost, workGet, workPost } from './server/work.ts';
import { teamGet, teamPost } from './server/team.ts';
import { hfGet, hfPost } from './server/hf.ts';
import { noticesGet, noticesPost, tellChat } from './server/notices.ts';
import { thispcGet, thispcPost } from './server/thispc.ts';
import { jobRoutes, startJobs } from './server/jobs.ts';
import { owedPost, startOwed } from './server/owed.ts';
import { handInPicture, placesGet, placesPost } from './server/places.ts';
import { costsGet, costsPost, pcPhotoFile } from './server/costs.ts';
import { queueGet, queuePost, startQueue } from './server/queue.ts';
import { installGet, installPost } from './server/install.ts';
import { selfUpdateGet, selfUpdatePost, takeZip } from './server/selfupdate.ts';
import { BRIDGE_PATH, bridgeRoute, startBridge } from './server/bridge.ts';

/** Microsoft Edge, which opens TOMLIN in a window of its own (app mode); null when it is not on this PC. */
function appWindowBrowser(): string | null {
  for (const root of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
    const exe = root ? join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '';
    if (exe && existsSync(exe)) return exe;
  }
  return null;
}

// The parts that reach across areas, joined now that every part is in place.
hooks.chatSaved = tellChat;
images.askChat = askOnce;
images.onKept = handInPicture;
images.recipe = id => {
  const m = staff.get(id);
  const r = m ? roleOf(m.role) : null;
  return r?.kind && r.recipe ? r.recipe : null;
};

await store.settings();
// The host is off: a host still chosen in old settings hands over to the first hire who chats, once, here (a window
// reading its chat changes nothing).
await offHost();
startJobs();
startOwed();
await startQueue();
// The Bridge part: projects, local copies, audits, git, live sites and prompts (/bridge/).
startBridge();

// ---- Routes ----

const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map(h => `http://${h}`));
/** Every area's routes by path; a path answered by two areas stops the start (it would answer only one). */
function routesOf(...tables: Routes[]): Map<string, Route> {
  const all = new Map<string, Route>();
  for (const t of tables) {
    for (const [path, route] of Object.entries(t)) {
      if (all.has(path)) throw new Error(`Two parts of the server answer ${path}.`);
      all.set(path, route);
    }
  }
  return all;
}
const GET = routesOf(panesGet, teamGet, hfGet, noticesGet, settingsGet, thispcGet, workGet, chatGet, peopleGet, answeringGet, placesGet, costsGet, queueGet, installGet, selfUpdateGet);
const POST = routesOf(settingsPost, teamPost, workPost, chatPost, noticesPost, panesPost, thispcPost, hfPost, answeringPost, peoplePost, picturesPost, owedPost, placesPost, costsPost, queuePost, installPost, selfUpdatePost);

const server = createServer(async (req, res) => {
  try {
    // Only this PC, by its own address (a web page cannot reach in by another name), and a browser page from
    // another site cannot post here. Programs on this PC (no Origin header) can use the API.
    if (!HOSTS.has(req.headers.host ?? '')) return json(res, 403, { error: `Open TOMLIN at http://127.0.0.1:${PORT}` });
    const origin = req.headers.origin;
    if (origin && !ORIGINS.has(origin)) return json(res, 403, { error: 'Requests must come from TOMLIN\'s own page or a program on this PC.' });
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const p = url.pathname;
    // The app lock, before anything else: while locked only the page's files and the lock's own door answer.
    // Every reply below is awaited, so a fault in one reaches the catch at the end and is answered, never left waiting.
    if (p === '/api/applock') return void (req.method === 'POST' ? await appLockAction(req, res, await body(req, 4096)) : json(res, 200, appLockView(req)));
    if (appLockOn()) {
      // The Bridge's page while locked goes to the lock screen (its files and API stay shut, below).
      if (req.method === 'GET' && (p === '/bridge' || (p.startsWith(BRIDGE_PATH) && !p.startsWith(`${BRIDGE_PATH}api/`))) && !appOk(req)) {
        res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
        return void res.end();
      }
      const gate = gateOf(p);
      if (gate === 'door' && !appLock.isOpen()) return apiError(res, 423, 'TOMLIN is locked. Open it with its PIN in the browser first.', 'locked');
      if (gate === 'shut' && !appOk(req)) return json(res, 423, { error: 'TOMLIN is locked. Type the PIN to open it.', locked: true });
    }
    if (req.method === 'GET' && p.startsWith('/preview/')) return void (await previewFile(res, p));
    if (await bridgeRoute(req, res, p)) return;

    if (req.method === 'GET') {
      const route = GET.get(p);
      if (route) return void (await route({ req, res, url, p, b: {} }));
      if (await jobRoutes.get(p, url, res)) return;
      const face = /^\/api\/faces\/file\/([^/]+)$/.exec(p);
      if (face) return await faceFile(face, res);
      const pcPhoto = /^\/api\/pc\/photo\/([^/]+)$/.exec(p);
      if (pcPhoto) return await pcPhotoFile(decodeURIComponent(pcPhoto[1]), res);
      if (await images.get(req, res, url)) return;
      if (!p.startsWith('/api/') && !p.startsWith('/v1/')) return void (await staticFile(res, p));
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Not allowed.' });

    if (p === '/v1/chat/completions') return void (await openAiChat(req, res));
    if (p === '/v1/images/generations') return void (await images.openAi(req, res, await body(req)));

    const load = /^\/api\/models\/([^/]+)\/(load|unload)$/.exec(p);
    if (load) return await loadModel(load, req, res);
    const paneOff = /^\/api\/panes\/(chat|image)\/unload$/.exec(p);
    if (paneOff) return await unloadPane(paneOff, res);

    if (p === '/api/chat/doc') return void (await addDoc(req, res));
    // Update this install: the body is a TOMLIN zip (Nodes and memory).
    if (p === '/api/install/zip') return void (await takeZip(req, res));
    const b = await body(req);
    const route = POST.get(p);
    if (route) return void (await route({ req, res, url, p, b }));
    if (await projectPost(p, b, res)) return;
    if (await jobRoutes.post(p, b, res)) return;
    if (await images.post(req, res, url, b)) return;
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    log.error(`${req.method} ${(req.url ?? '').split('?')[0]}`, error);
    if (!res.headersSent) json(res, 500, { error: saidError(error) });
    else res.end();
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use: TOMLIN may already be running. Open http://127.0.0.1:${PORT} or close the other window.`
    : `TOMLIN could not start: ${error.message}`);
  process.exit(error.code === 'EADDRINUSE' ? ALREADY_RUNNING : 1);
});

server.listen(PORT, '127.0.0.1', () => {
  const clear = async () => images.gallery.clearDrafts((await store.settings()).draftDays).catch(() => 0);
  void clear();
  setInterval(clear, 3_600_000).unref();
  console.log(`TOMLIN ${VERSION} is running at http://127.0.0.1:${PORT}  (nothing is loaded until you press Connect; ${process.env.TOMLIN_TRAY === '1' ? 'quit it from its icon by the clock' : 'close this window to stop'})`);
  console.log(`Your chats, staff, pictures and downloaded models are kept in ${HOME.home}`);
  // A new copy started by Start TOMLIN.cmd after an update from a linked PC: it answered, so it is kept (no going back).
  if (process.env.TOMLIN_PREV) void writeFile(join(ROOT, '.started-ok'), '').catch(() => undefined);
  // Started again after a new copy failed to start: "Start with Windows", pointed at that copy, points here again.
  const failed = process.env.TOMLIN_FAILED;
  if (failed) void autostart(failed).on().then(async on => { if (on) await startupOf.set(true); }).then(() => console.log(`The new version in ${failed} did not start, so this version runs again.`)).catch(() => undefined);
  // Start TOMLIN.cmd asks for the browser only now, once the page can answer (opened earlier, it showed "can't reach this page").
  // Its own window (Microsoft Edge app mode: no tabs, no address bar), else a tab in the default browser.
  if (process.env.TOMLIN_OPEN === '1' && process.platform === 'win32') {
    const url = `http://127.0.0.1:${PORT}/`;
    const edge = appWindowBrowser();
    import('node:child_process').then(cp => {
      const child = edge
        ? cp.spawn(edge, [`--app=${url}`, '--window-size=1280,860'], { detached: true, stdio: 'ignore' })
        : cp.spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', e => console.error(`The page could not be opened (${e.message}). Open ${url} in a browser.`));
      child.unref();
    }).catch(() => undefined);
  }
  // Sharing this PC as a worker is off unless its owner turned it on in Jobs.
  void jobRoutes.startShare().catch(error => console.error(`Sharing as a worker could not start: ${(error as Error).message}`));
  // Linked PCs are asked once at start, so their staff show as on (or off) straight away.
  void jobRoutes.remoteStatus().catch(() => undefined);
  // An installed copy whose update brought a changed tools/tray.cs builds the program again (src/trayfresh.ts).
  if (process.platform === 'win32') {
    void refreshTray(ROOT)
      .then(r => r === 'built' && console.log('TOMLIN\'s program (by the clock) was built again for this version: the new one runs from the next start.'))
      .catch(error => console.error(`TOMLIN's program (by the clock) could not be built again: ${(error as Error).message}`));
  }
});
