// Every request goes through here, in this order: local Host only, the page and its files, then the API, which
// needs the per-run key. Inside TOMLIN the path arrives without its /bridge start (src/server/bridge.ts), after
// TOMLIN's own checks (this PC's address, its own page's origin, the app lock). API routes live in the files beside this one, as tables of path -> handler.
// A handler gets { req, res, url, body, p } and returns the JSON to send (or nothing, when it answered itself).
'use strict';
const cfg = require('../config');
const { send, readBody, servePublic } = require('../http');
const { findProject } = require('../state');
const system = require('./system');
const lists = require('./lists');
const prompts = require('./prompts');
const project = require('./project');
const hosting = require('./hosting');

const GET = { ...system.get, ...lists.get, ...prompts.get, ...hosting.get };
const POST = { ...system.post, ...lists.post, ...prompts.post, ...hosting.post };
const PGET = { ...project.get, ...hosting.pget };
const PPOST = { ...project.post, ...hosting.ppost };
const ALLOWED_HOSTS = new Set(['127.0.0.1:' + cfg.PORT, 'localhost:' + cfg.PORT]);

async function reply(res, out) {
  const v = await out;
  if (v !== undefined && !res.headersSent) send(res, 200, v);
}

async function handle(req, res) {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, { error: 'TOMLIN only answers on 127.0.0.1:' + cfg.PORT + '.' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (servePublic(req, res, url.pathname)) return;
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.headers['x-bridge-key'] !== cfg.KEY) return send(res, 403, { error: 'This page is from before TOMLIN was restarted. Reload the page.' });
    const ctx = { req, res, url, body: {} };

    if (req.method === 'GET') {
      if (GET[url.pathname]) return await reply(res, GET[url.pathname](ctx));
      if (PGET[url.pathname]) {
        const p = findProject(url.searchParams.get('id'));
        return p ? await reply(res, PGET[url.pathname]({ ...ctx, p })) : send(res, 404, { error: 'Unknown project.' });
      }
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

    // A pasted report-back table can be long; everything else is small.
    ctx.body = await readBody(req, url.pathname.startsWith('/api/prompts/') ? prompts.BODY_LIMIT : url.pathname === '/api/audit/import' ? 200000 : url.pathname === '/api/hosting/secrets' ? 400000 : 10000);
    if (POST[url.pathname]) return await reply(res, POST[url.pathname](ctx));
    if (PPOST[url.pathname]) {
      const p = findProject(ctx.body.id);
      return p ? await reply(res, PPOST[url.pathname]({ ...ctx, p })) : send(res, 404, { error: 'Unknown project. Reload the list.' });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (res.headersSent) return;
    if (e && e.status) return send(res, e.status, { error: e.message });
    send(res, 500, { error: 'The Bridge hit an error: ' + (e.message || e) + '. Try again; if it repeats, the details are in TOMLIN\'s log (Settings, Your data, Open log).' });
  }
}

module.exports = { handle };
