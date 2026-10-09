// The Bridge part as a whole: This PC numbers, the Git program check, Stop all, stopping a port another program holds,
// the folder picker, Scan folders, token recount and the live check of every site. Setup, shortcuts, Start with Windows,
// Uninstall and Quit are TOMLIN's own (its installer, Nodes and memory, its icon by the clock), so they are not here.
'use strict';
const { state, saveSettings, refreshTokens } = require('../state');
const { laptopStats, scanFolders } = require('../views');
const { checkAllLive, setLiveEvery } = require('../live-state');
const { foreignPorts, stopForeign, stopAllProjects } = require('../runner');
const { portBusy } = require('../ports');
const desktop = require('../desktop');
const cfg = require('../config');
const gitProgram = require('../git-program');
const disclosure = require('../disclosure');
const bringIn = require('../import');

// Audits › Private details: the page sees labels and lengths, never the values (they live in data/ only).
const privateDetails = () => ({ details: disclosure.listForPage(cfg.PRIVATE_FILE),
  auto: [...new Set(disclosure.autoDetails(state.settings.workingFolders || []).map(d => d.label))] });

const gitOnline = () => !!state.settings.gitOnlineCheck;

const get = {
  '/api/stats': () => laptopStats(),
  // About › Bring in from Myia Bridge: the Myia Bridge folders found beside the projects.
  '/api/import': () => ({ candidates: bringIn.candidates() }),
  '/api/private-details': privateDetails,
  // The Git program's version. Asks GitHub for the newest one only when the person has ticked that on.
  '/api/git-program': ({ url }) => gitProgram.status({ online: gitOnline(), fresh: url.searchParams.get('fresh') === '1' }),
};

const post = {
  '/api/import': ({ body }) => bringIn.importFrom(body.folder),
  '/api/refresh-tokens': () => { refreshTokens(); return { ok: true }; },
  '/api/pick-folder': ({ body }) => desktop.pickFolder(body.purpose),
  '/api/scan': () => ({ ok: true, ...scanFolders() }),
  '/api/port-owners': async () => ({ ok: true, owners: await foreignPorts() }),
  '/api/live/check-all': () => {
    if (!state.projects.some(p => p.liveUrl)) return { ok: false, error: 'No project has a live address yet: use a project\'s … menu › Hosted live.' };
    checkAllLive().catch(e => console.error('Live checks stopped: ' + ((e && e.message) || e)));
    return { ok: true, busy: true };
  },
  '/api/live/every': ({ body }) => setLiveEvery(body.minutes),
  // [{ id?, label, value? }]: a row with an id and no value keeps the saved value.
  '/api/private-details': ({ body }) => {
    if (!Array.isArray(body.details) || body.details.length > 50) return { ok: false, error: 'Send a list of up to 50 details.' };
    const r = disclosure.savePrivateList(cfg.PRIVATE_FILE, body.details);
    return r.ok ? { ok: true, ...privateDetails() } : r;
  },
  '/api/git-online': async ({ body }) => {
    state.settings.gitOnlineCheck = body.on === true;
    saveSettings();
    return { ok: true, git: await gitProgram.status({ online: gitOnline(), fresh: gitOnline() }) };
  },
  '/api/stop-port': async ({ body }) => {
    const port = Number(body.port);
    const o = (await foreignPorts()).find(x => x.port === port);
    // Already closed (it stopped by itself, or another click got there first): what was wanted, so not a fault.
    if (!o && state.projects.some(p => p.commands.some(c => c.port === port)) && !(await portBusy(port))) return { ok: true, free: true, port };
    if (!o) return { ok: false, error: 'Port ' + body.port + ' is not held by another program any more (or is not a project port).' };
    if (body.pid && Number(body.pid) !== o.pid) return { ok: false, error: 'A different program holds port ' + o.port + ' now (' + o.name + '). Look again before stopping it.' };
    return stopForeign(o);
  },
  // Stop all: everything the Bridge started; with others=true, also the other programs holding project ports (only
  // the ones the page listed, by port and program id, so nothing new is stopped unseen).
  '/api/stop-all': async ({ body }) => {
    const stopped = stopAllProjects();
    const others = [];
    if (body.others && Array.isArray(body.listed)) {
      const listed = new Set(body.listed.map(x => x.port + ':' + x.pid));
      for (const o of await foreignPorts()) if (listed.has(o.port + ':' + o.pid)) others.push(await stopForeign(o));
    }
    return { ok: true, stopped, others };
  },
};

module.exports = { get, post };
