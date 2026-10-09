// Orbit pictures and project icons.
// A snapshot of a running site's own page, taken by a hidden browser (headless: no window, no taskbar button) with
// its own throwaway profile in data/snaps/profile, so it never touches the person's own browser or its sign-ins. Only
// the project's own local address is loaded (its running copy, or a start port another program holds). One at a
// time; a picture is reused for 10 minutes. The icon is the site's own, else a favicon read from the project's folder
// (read only, never written).
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const os = require('./platform');
const { takeSnapshot } = require('./snapshot');
const { siteUrlOf } = require('./runner');

const FRESH_MS = 10 * 60 * 1000;
let queue = Promise.resolve();
const safe = p => p.id.replace(/[^\w-]/g, '_');
const snapFile = p => path.join(cfg.SNAPS, safe(p) + '.png');
const siteIconFile = p => path.join(cfg.SNAPS, safe(p) + '.icon');

async function snapshot(p, force) {
  const file = snapFile(p);
  try { const st = fs.statSync(file); if (!force && Date.now() - st.mtimeMs < FRESH_MS) return { ok: true, at: st.mtimeMs }; } catch {}
  const url = await siteUrlOf(p);
  if (!url) return { ok: false, error: p.name + ' is not running, so there is no page to take a picture of.' };
  const browser = os.findBrowser();
  if (!browser) return { ok: false, error: 'Microsoft Edge was not found, so the Bridge cannot take a picture of ' + p.name + '.' };
  const job = queue.then(async () => {
    const tmp = file + '.new.png';
    try {
      const shoot = () => takeSnapshot({ edge: browser, url, out: tmp, profile: path.join(cfg.SNAPS, 'profile') });
      await shoot().catch(async () => { await new Promise(r => setTimeout(r, 1500)); return shoot(); }); // one more try
      fs.renameSync(tmp, file);
      await fetchSiteIcon(p, url).catch(() => {});
      return { ok: true, at: Date.now() };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, error: 'The picture of ' + p.name + ' (' + url + ') did not come out: ' + e.message + '.' };
    }
  });
  queue = job.catch(() => {});
  return job;
}

// The icon the running site itself uses: the <link rel="icon"> on its page, else /favicon.ico. Only fetched from the
// site's own local address (same host and port as its page); images only, under 512 KB.
async function fetchSiteIcon(p, pageUrl) {
  const page = new URL(pageUrl);
  const get = u => fetch(u, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
  const found = [];
  try {
    const html = (await (await get(pageUrl)).text()).slice(0, 200000);
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      if (!/\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(m[0])) continue;
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
      if (href) try { found.push(new URL(href[1], pageUrl)); } catch {}
    }
  } catch {}
  found.push(new URL('/favicon.ico', pageUrl));
  for (const u of found) {
    if (u.protocol !== 'http:' || u.host !== page.host) continue;
    try {
      const r = await get(u.href);
      const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!r.ok || !/^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp)$/.test(type)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > 512 * 1024) continue;
      fs.writeFileSync(siteIconFile(p), buf);
      fs.writeFileSync(siteIconFile(p) + '.type', type);
      return true;
    } catch {}
  }
  return false;
}

const ICON_PLACES = ['favicon.svg', 'favicon.png', 'favicon.ico', 'public/favicon.svg', 'public/favicon.png', 'public/favicon.ico',
  'static/favicon.svg', 'static/favicon.png', 'static/favicon.ico', 'assets/favicon.svg', 'assets/favicon.png', 'assets/favicon.ico',
  'img/favicon.png', 'images/favicon.png', 'public/img/favicon.png', 'public/images/favicon.png', 'src/favicon.ico', 'app/favicon.ico',
  'src/app/favicon.ico', 'public/icon.svg', 'icon.svg', 'apple-touch-icon.png', 'public/apple-touch-icon.png', 'public/logo.svg', 'logo.svg'];
const IMG_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
// The picture to show for a project: the running site's own icon if one was fetched, else a favicon in its folder.
function iconOf(p) {
  let siteType = null;
  try { siteType = fs.readFileSync(siteIconFile(p) + '.type', 'utf8'); } catch {}
  if (siteType && fs.existsSync(siteIconFile(p))) return { file: siteIconFile(p), type: siteType };
  for (const rel of ICON_PLACES) {
    const f = path.join(p.dir, rel);
    try { const st = fs.statSync(f); if (st.isFile() && st.size > 0 && st.size < 512 * 1024) return { file: f, type: IMG_TYPES[path.extname(f).toLowerCase()] }; } catch {}
  }
  return null;
}

module.exports = { snapshot, snapFile, iconOf };
