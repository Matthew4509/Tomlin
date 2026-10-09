// The Orbit view.
'use strict';

// ---- Orbit: every running site floats over the Earth; click one to shoot it. A site the Bridge started raises its
// shields and fights the other sites (missiles both ways) while it is being stopped, then blows up. Another
// program's (◐) is stopped the same way, with no question first; the fight runs while it closes. Empty sky = a harmless miss. A site stopped any other way (Stop, Stop all) also blows up here; a
// new one launches up from the horizon. ----
const orbitEls = new Map(), dying = new Set();
const hashOf = t => { let x = 0; for (const c of t) x = (x * 31 + c.charCodeAt(0)) | 0; return Math.abs(x); };
function orbitPoint(el) { const o = $('orbit').getBoundingClientRect(), b = el.getBoundingClientRect(); return [b.left - o.left + b.width / 2, b.top - o.top + b.height / 2]; }
function fire(x, y) {
  const o = $('orbit'), sx = o.clientWidth / 2, sy = o.clientHeight - 41, dx = x - sx, dy = y - sy;
  const beam = h('i', { class: 'beam', style: 'left:' + sx + 'px;top:' + sy + 'px;width:' + Math.hypot(dx, dy).toFixed(1) + 'px;--a:' + Math.atan2(dy, dx).toFixed(4) + 'rad' });
  o.append(beam); setTimeout(() => beam.remove(), 340);
}
function burst(x, y, n, big) {
  const o = $('orbit');
  if (big) { const f = h('i', { class: 'flash', style: 'left:' + x + 'px;top:' + y + 'px' }); o.append(f); setTimeout(() => f.remove(), 500); }
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, d = (big ? 40 : 12) + Math.random() * (big ? 60 : 16);
    const sp = h('i', { class: 'spark', style: 'left:' + x + 'px;top:' + y + 'px;--dx:' + (Math.cos(a) * d).toFixed(1) + 'px;--dy:' + (Math.sin(a) * d).toFixed(1) + 'px' });
    o.append(sp); setTimeout(() => sp.remove(), 750);
  }
}
function explode(el) {
  if (el.isConnected && el.getBoundingClientRect().width) { const [x, y] = orbitPoint(el.querySelector('.sat-body')); burst(x, y, 16, true); }
  el.classList.add('boom');
  setTimeout(() => el.remove(), 460);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// n missiles from one satellite, `gap` ms apart (never more than 90 in the air, so a long fight stays smooth).
// n missiles from one satellite, `gap` ms apart; `targets` = whom to fire at (one picked per missile; none = Earth).
function salvo(fromEl, n, gap, targets) {
  for (let i = 0; i < n; i++) setTimeout(() => missile(fromEl, targets && targets.length ? targets[Math.floor(Math.random() * targets.length)] : null), i * gap + Math.random() * 40);
}
// A missile from one satellite to another (it bursts on the other's shield, which flashes), or, with no satellite
// to aim at, down to the atmosphere over the ground station.
function missile(fromEl, toEl) {
  const o = $('orbit');
  if (!fromEl || !fromEl.isConnected || !o.clientWidth || calm() || o.querySelectorAll('.missile').length >= 90) return;
  const [x0, y0] = orbitPoint(fromEl.querySelector('.sat-body'));
  const W = o.clientWidth, H = o.clientHeight;
  const aimed = toEl && toEl.isConnected;
  let x1, y1;
  if (aimed) { const [tx, ty] = orbitPoint(toEl.querySelector('.sat-body')); x1 = tx + (Math.random() - 0.5) * 60; y1 = ty + (Math.random() - 0.5) * 50; }
  else { x1 = W / 2 + (Math.random() - 0.5) * 180; y1 = H - 50 - Math.random() * 10; }
  // Satellite to satellite: a high arc over the top (they sit side by side); to Earth: a curve down.
  const cx = (x0 + x1) / 2 + (Math.random() - 0.5) * (aimed ? 120 : 260);
  const cy = aimed ? Math.max(4, Math.min(y0, y1) - 60 - Math.random() * 50) : Math.min(y0, y1) - 20 - Math.random() * 50;
  const dur = (aimed ? 600 : 700) + Math.random() * 350;
  const m = h('i', { class: 'missile', style: "offset-path:path('M " + x0.toFixed(1) + ' ' + y0.toFixed(1) + ' Q ' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + x1.toFixed(1) + ' ' + y1.toFixed(1) + "');animation-duration:" + Math.round(dur) + 'ms' });
  o.append(m);
  setTimeout(() => {
    m.remove(); burst(x1, y1, 7);
    if (aimed && toEl.isConnected && !toEl.classList.contains('shielded')) { toEl.classList.remove('hit'); void toEl.offsetWidth; toEl.classList.add('hit'); }
  }, dur);
}
// The fight lasts as long as the site takes to close (at least 1.6 s, so it is seen; at most 30 s). Won = it
// explodes; lost (it did not stop, or a test copy) = its shields held and it stays in orbit.
async function battle(x, stopped, winText) {
  const el = orbitEls.get(x.id);
  if (!el) return;
  orbitEls.delete(x.id); dying.add(x.id);
  el.classList.remove('held'); el.classList.add('shielded');
  let settled = false, ok = false;
  stopped.then(v => { ok = !!v; }, () => {}).finally(() => { settled = true; });
  const t0 = Date.now();
  // Opening barrage: the target empties its racks as its shields come up.
  const others = () => [...orbitEls.values()].filter(o => o !== el && o.isConnected);
  salvo(el, 6, 60, others());
  while ((!settled || Date.now() - t0 < 2200) && Date.now() - t0 < 30000 && el.isConnected) {
    const [tx, ty] = orbitPoint(el.querySelector('.sat-body'));
    fire(tx, ty); setTimeout(() => burst(tx, ty, 4), 110);
    salvo(el, 2 + Math.floor(Math.random() * 3), 80, others());          // the target fires at the other sites: 2-4 a volley
    for (const other of others()) if (Math.random() < 0.8) salvo(other, 1 + Math.floor(Math.random() * 3), 110, [el]); // they fire back: up to 3 each
    await sleep(320);
  }
  el.classList.remove('shielded');
  dying.delete(x.id);
  if (ok) { explode(el); if (winText) info(winText); }
  else { orbitEls.set(x.id, el); el.classList.add('held'); el.querySelector('.shield-tag').textContent = 'Shields held'; setTimeout(() => { el.classList.remove('held'); el.querySelector('.shield-tag').textContent = 'Shields up'; }, 2500); }
  load();
}
function shoot(x) {
  const el = orbitEls.get(x.id);
  if (!el) return;
  const [px, py] = orbitPoint(el.querySelector('.sat-body'));
  fire(px, py);
  setTimeout(() => {
    burst(px, py, 6);
    if (!x.mine) return stopPort(x.port, stopping => battle(x, stopping));
    const stopping = api('/api/stop', { id: x.r.id }).then(() => true, e => { info(e.message, true); return false; });
    battle(x, stopping, x.r.name + ' shot down: its local copy on :' + x.port + ' is stopped. Run local copy starts it again.');
  }, 130);
}
// Pictures: the badge is the site's own icon (from the running site, else its folder), the panel a snapshot of its
// page (taken by a hidden Edge; reused for 10 minutes, checked every minute, retried after 15 s if it failed).
const pics = new Map();
async function keyedBlob(u) {
  const r = await fetch(BASE + u, { headers: { 'X-Bridge-Key': KEY }, cache: 'no-store' });
  if (toLock(r) || !r.ok) return null;
  const blob = await r.blob();
  // A raster image is inert, so a blob: URL (same origin) is fine. An SVG is a document: opened from a blob: URL
  // (right-click "open image in new tab") it would run its own scripts in the Bridge's origin and could read the
  // key. A data: URL is an opaque origin, so a hostile favicon.svg can do nothing from it. img-src allows data:.
  if (/^image\/svg/i.test(blob.type)) return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
  return URL.createObjectURL(blob);
}
function picsFor(x) {
  let p = pics.get(x.id);
  if (!p) { p = { icon: null, snap: null, snapAt: 0, checked: 0, asking: false }; pics.set(x.id, p);
    keyedBlob('/api/icon?id=' + encodeURIComponent(x.id)).then(u => { p.icon = u; paintPics(x.id); }).catch(() => {}); }
  if (!p.asking && Date.now() - p.checked > 60000) refreshSnap(x.id, p);
  paintPics(x.id);
}
async function refreshSnap(id, p) {
  p.asking = true; p.checked = Date.now(); paintPics(id);
  try {
    const r = await api('/api/snap', { id });
    if (!r.ok) p.checked = Date.now() - 45000;
    if (r.ok && r.at !== p.snapAt) {
      const u = await keyedBlob('/api/snap-image?id=' + encodeURIComponent(id));
      if (u) { if (p.snap) URL.revokeObjectURL(p.snap); p.snap = u; p.snapAt = r.at; }
    }
    // The site's own icon is read while its picture is taken: ask again if there was none before.
    if (r.ok && !p.icon) p.icon = await keyedBlob('/api/icon?id=' + encodeURIComponent(id));
  } catch {}
  p.asking = false; paintPics(id);
}
function paintPics(id) {
  const el = orbitEls.get(id), p = pics.get(id);
  if (!el || !p) return;
  const shot = el.querySelector('.shot'), img = shot.querySelector(':scope > img');
  if (p.snap && img.getAttribute('src') !== p.snap) img.src = p.snap;
  img.hidden = !p.snap; shot.classList.toggle('has', !!p.snap);
  shot.querySelector('.ph span').textContent = p.asking && !p.snap ? 'taking a picture…' : '';
  const av = el.querySelector('.av'), ai = av.querySelector('img');
  if (p.icon && ai.getAttribute('src') !== p.icon) ai.src = p.icon;
  ai.hidden = !p.icon; av.classList.toggle('has', !!p.icon);
}
function makeSat() {
  return h('div', { class: 'sat launch' }, h('div', { class: 'float' },
    h('span', { class: 'wing', 'aria-hidden': 'true' }), h('span', { class: 'strut', 'aria-hidden': 'true' }),
    h('button', { class: 'sat-body', type: 'button' },
      h('span', { class: 'shot' }, h('img', { alt: '', hidden: true }), h('span', { class: 'ph', 'aria-hidden': 'true' }, h('b'), h('span')),
        h('span', { class: 'av', 'aria-hidden': 'true' }, h('img', { alt: '', hidden: true }), h('span'))),
      h('span', { class: 'tx' }, h('b'), h('span'))),
    h('span', { class: 'strut', 'aria-hidden': 'true' }), h('span', { class: 'wing', 'aria-hidden': 'true' })),
    h('button', { class: 'sat-open', type: 'button' }, icon(0xE8A7)), h('span', { class: 'shield-tag', role: 'status' }, 'Shields up'));
}
function fillSat(el, x) {
  el.classList.toggle('other', !x.mine);
  const k = hashOf(x.id);
  el.querySelector('.float').style.cssText = '--dur:' + (5 + k % 4) + 's;--delay:-' + (k % 5) + 's';
  const b = el.querySelector('.sat-body');
  const letter = x.r.name.trim().charAt(0).toUpperCase();
  b.querySelector('.av span').textContent = letter;
  b.querySelector('.ph b').textContent = letter;
  b.querySelector('.tx b').textContent = x.r.name;
  b.querySelector('.tx span').textContent = (x.mine ? '● :' : '◐ :') + x.port;
  picsFor(x);
  b.title = x.mine ? 'Shoot to stop ' + x.r.name + ' (its local copy on :' + x.port + ')' : 'Another program holds :' + x.port + '. Shoot to see what it is and choose whether to stop it.';
  b.setAttribute('aria-label', 'Shoot down ' + x.r.name + ' on port ' + x.port + (x.mine ? ' (stops it)' : ' (asks first)'));
  b.onclick = e => { e.stopPropagation(); shoot(x); };
  const o = el.querySelector('.sat-open');
  o.title = 'Open localhost:' + x.port + ' in your browser'; o.setAttribute('aria-label', 'Open ' + x.r.name + ' in your browser');
  o.onclick = e => { e.stopPropagation(); act('open-browser', x.r); };
}
function renderOrbit() {
  const sky = $('orbit-sky');
  if (!sky) return;
  const list = [...rows.filter(r => r.running).map(r => ({ id: r.id, r, mine: true, port: r.running.port })),
    ...rows.filter(r => !r.running && r.portInUse).map(r => ({ id: r.id, r, mine: false, port: r.portInUse }))];
  const want = new Set(list.map(x => x.id));
  for (const [id, el] of orbitEls) if (!want.has(id)) { orbitEls.delete(id); explode(el); }
  for (const x of list) {
    if (dying.has(x.id)) continue;
    let el = orbitEls.get(x.id);
    if (!el) { el = makeSat(); orbitEls.set(x.id, el); sky.append(el); }
    fillSat(el, x);
  }
  const n = orbitEls.size;
  $('orbit').classList.toggle('empty', !n);
  $('orbit-hint').textContent = n ? n + ' in orbit · click one to shoot it down (stops it) · ↗ opens it' : '';
  $('orbit-empty').hidden = !!n;
}
$('orbit').addEventListener('click', e => {
  if (e.target.closest('.sat')) return;
  const o = $('orbit').getBoundingClientRect(), x = e.clientX - o.left, y = e.clientY - o.top;
  fire(x, y); setTimeout(() => burst(x, y, 5), 110);
});
