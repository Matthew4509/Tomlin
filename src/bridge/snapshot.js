// A picture of a local site's page, for the Orbit view. A hidden (headless) Edge with its own throwaway profile, driven over its DevTools connection, so the
// picture is taken after the page has drawn itself: Edge's plain --screenshot fires at the load event, and caught
// slow single-page apps on their loading screen. No packages: Node 22+ has WebSocket built in.
'use strict';
const { spawn } = require('child_process');
const { killTree, portOwners } = require('./platform');
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function drive({ port, url, out, settleMs, deadline }) {
  let target = null;
  while (!target) {
    if (Date.now() > deadline) throw new Error('Edge did not open a page');
    try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page'); } catch {}
    if (!target) await sleep(150);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('no DevTools connection')); });
  let next = 0;
  const waiting = new Map(), listeners = new Set();
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); if (d.error) w.rej(new Error(d.error.message)); else w.res(d.result); }
    else if (d.method) for (const f of listeners) f(d);
  };
  const call = (method, params = {}) => new Promise((res, rej) => { const i = ++next; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  try {
    await call('Page.enable');
    // A page that pops alert()/confirm() would stall the picture: dismiss it.
    listeners.add(d => { if (d.method === 'Page.javascriptDialogOpening') call('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); });
    const loaded = new Promise(res => listeners.add(d => { if (d.method === 'Page.loadEventFired') res(); }));
    const nav = await call('Page.navigate', { url });
    if (nav.errorText) throw new Error(nav.errorText);
    await Promise.race([loaded, sleep(Math.max(0, deadline - Date.now() - settleMs - 1000))]);
    await sleep(settleMs); // let scripts draw the page (boot screens, fonts, first data)
    const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 } });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  } finally { try { ws.close(); } catch {} }
}

// Closes the hidden Edge the polite way, over its DevTools connection. The msedge.exe the Bridge starts is only a
// launcher: it hands over to the real browser and exits at once, so stopping it (killTree) leaves ~7 processes and
// ~400 MB running, holding the profile, and every later picture failed with "Edge did not start".
async function closeBrowser(port) {
  if (!port) return;
  try {
    const v = await (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(2000) })).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise(res => {
      const t = setTimeout(res, 2500);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      ws.onclose = ws.onerror = () => { clearTimeout(t); res(); };
    });
    try { ws.close(); } catch {}
  } catch {}
}
// Waits until no browser answers on the DevTools port any more (up to ms).
async function gone(port, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    try { await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(500) }); } catch { return true; }
  }
  return false;
}

// Stops the hidden Edge listening on this DevTools port: Browser.close first, then (still answering) the Edge program
// that holds the port, with its renderers. Windows does not let the Bridge read Edge's command lines, so the port it
// wrote in DevToolsActivePort is how the real browser is found. Only an Edge that answers as a DevTools browser.
async function stopBrowser(port) {
  if (!port) return;
  let devtools = false;
  try { devtools = !!(await (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) })).json()).webSocketDebuggerUrl; } catch {}
  if (!devtools) return;
  await closeBrowser(port);
  if (await gone(port, 3000)) return;
  for (const o of await portOwners([Number(port)])) if (/^msedge(\.exe)?$/i.test(o.name || '')) killTree(o.pid);
  await gone(port, 3000);
}

// Resolves true when `out` holds a fresh 640x400 PNG of `url`; throws with a short reason otherwise.
async function takeSnapshot({ edge, url, out, profile, settleMs = 3000, timeoutMs = 25000 }) {
  if (typeof WebSocket !== 'function') throw new Error('this Node.js is too old for pictures (Node 22 or newer needed)');
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  // A browser left from an earlier picture (a Bridge stopped mid-picture) still holds the profile: stop it first.
  try { await stopBrowser(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim()); } catch {}
  fs.rmSync(portFile, { force: true });
  // The last picture's Edge can hold the profile for a moment after it is stopped; a new Edge started then hands
  // itself to the old one and quits. Wait until the profile's lock can be removed.
  const lock = path.join(profile, 'lockfile');
  for (let i = 0; i < 40; i++) { try { fs.rmSync(lock, { force: true }); break; } catch { await sleep(150); } }
  const child = spawn(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--window-size=1280,800', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const deadline = Date.now() + timeoutMs;
  let port = null;
  try {
    while (!port) {
      if (Date.now() > deadline) throw new Error('Edge did not start');
      try { port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim() || null; } catch {}
      if (!port) await sleep(150);
    }
    await Promise.race([drive({ port, url, out, settleMs, deadline }),
      sleep(Math.max(1000, deadline - Date.now())).then(() => { throw new Error('the page took too long'); })]);
    return true;
  } finally {
    // Polite close first; then anything still holding the profile is stopped, so nothing is left running.
    await stopBrowser(port);
    killTree(child.pid);
  }
}

module.exports = { takeSnapshot };
