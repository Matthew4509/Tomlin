// Hosted live: is each project's live address up? One plain GET per site when the Bridge starts and every 5, 10 or 15
// minutes, as chosen in the Live sites panel (15 to start with), and on "Check now". Different domains are asked at
// the same time (up to 4 at once), so one slow site does not hold up the rest; two addresses on the same domain are
// asked one after the other, 10 s apart. The last answer per project is kept in <data>/live.json.
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { keyOf } = require('./projects');
const { checkSite, isLocalHost, runByHost } = require('./live');
const { state, refreshProjects, saveSettings } = require('./state');

const EVERY_CHOICES = [5, 10, 15];
const everyMin = () => EVERY_CHOICES.includes(state.settings.liveEveryMin) ? state.settings.liveEveryMin : 15;
const live = { state: {}, rev: 0, busy: false };
try { live.state = JSON.parse(fs.readFileSync(cfg.LIVE_FILE, 'utf8')) || {}; } catch {}

// Demo: the made-up .example addresses are answered by the demo's own little servers on this PC
// (data-demo/live-sites.json, demo/live-sites.js); plain http:// goes to its "move to https" server; any other address
// is "refused", so a demo never sends a request off this PC.
function demoResolve(u) {
  let c = { sites: [] };
  try { c = JSON.parse(fs.readFileSync(path.join(cfg.DATA, 'live-sites.json'), 'utf8')); } catch {}
  const s = c.sites.find(x => x.host === u.hostname.toLowerCase());
  if (s && u.protocol === 'http:' && c.httpPort) return { host: '127.0.0.1', port: c.httpPort };
  return { host: '127.0.0.1', port: s ? s.port : 9 };
}
// Live requests are paced 5 s apart; only a made-up (demo) or on-this-PC address (tests) is asked faster.
function liveOpts(url) {
  const local = cfg.DEMO || isLocalHost(new URL(url).hostname);
  return cfg.DEMO ? { resolve: demoResolve, gapMs: 300, minGapMs: 0 } : local ? { gapMs: 200, minGapMs: 0 } : {};
}
function liveOf(p) {
  const s = p.liveUrl && live.state[keyOf(p.dir)];
  return s && s.url === p.liveUrl ? s : null;
}
function saveLive() { try { fs.writeFileSync(cfg.LIVE_FILE, JSON.stringify(live.state, null, 2)); } catch {} }
function forget(dir) { delete live.state[keyOf(dir)]; saveLive(); live.rev++; }
async function checkLive(p) {
  const r = await checkSite(p.liveUrl, { ...liveOpts(p.liveUrl), retryMs: cfg.DEMO ? 200 : 5000, timeout: cfg.DEMO ? 3000 : 10000 });
  live.state[keyOf(p.dir)] = r;
  saveLive();
  live.rev++;
  return r;
}
async function checkAllLive() {
  if (live.busy) return;
  live.busy = true; live.rev++;
  try {
    const list = refreshProjects().filter(p => p.liveUrl);
    // One queue per domain (paced 10 s apart, as before); up to 4 domains are asked at the same time.
    await runByHost(list, p => new URL(p.liveUrl).hostname.replace(/^www\./, ''), checkLive,
      { gapMs: cfg.DEMO ? 0 : 10000, parallel: 4, onError: (e, p) => console.error('Live check of ' + p.liveUrl + ' failed: ' + ((e && e.message) || e)) });
    // Every site failing before any answer, on two or more domains, points at this PC's connection, not the sites.
    const results = list.map(liveOf).filter(Boolean);
    if (new Set(list.map(p => { try { return new URL(p.liveUrl).hostname; } catch { return ''; } })).size >= 2 && results.length && results.every(r => r.net)) {
      for (const r of results) { r.state = 'unsure'; r.reason = 'No live site answered at all, so this PC is probably offline. ' + r.reason; }
      saveLive();
    }
  } finally { live.busy = false; live.rev++; }
}

// The round timer: a few seconds after start, then every everyMin(). Changing the choice restarts the wait from now.
let timer = null;
function scheduleLive(firstMs) {
  clearTimeout(timer);
  timer = setTimeout(() => { checkAllLive().catch(e => console.error('Live checks stopped: ' + ((e && e.message) || e))).finally(() => scheduleLive()); }, firstMs != null ? firstMs : everyMin() * 60000);
  timer.unref();
}
function setLiveEvery(min) {
  min = Number(min);
  if (!EVERY_CHOICES.includes(min)) return { ok: false, error: 'Choose 5, 10 or 15 minutes.' };
  state.settings.liveEveryMin = min;
  saveSettings();
  scheduleLive();
  return { ok: true, every: min };
}

module.exports = { live, everyMin, scheduleLive, setLiveEvery, liveOpts, liveOf, forget, checkLive, checkAllLive };
