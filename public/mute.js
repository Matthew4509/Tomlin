// Mute: quiet, not stopped. Mute a chat or a staff member (right-click its row in the left panel, or the
// chat's … menu), or everything (the bell in the top bar), for 1 hour, until
// tomorrow morning or until unmuted. A muted row shows a bell with a line and "Muted until …"; its number becomes a
// grey dot. Work carries on and still lands in Waiting for you. The server keeps the mutes (/api/mute, src/mute.ts)
// and words the times. Uses app.js's helpers (el, api, $) and home.js's (homeUi, drawRail, refresh).
'use strict';

const BELL = 'M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z';
/** A bell; struck through when muted (a shape, not colour alone). */
function bellIcon(off, size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' })) s.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', BELL);
  s.append(p);
  if (off) {
    const l = document.createElementNS(ns, 'path');
    l.setAttribute('d', 'M3 3l18 18');
    l.setAttribute('stroke', 'currentColor');
    l.setAttribute('stroke-width', '2.4');
    l.setAttribute('stroke-linecap', 'round');
    s.append(l);
  }
  return s;
}
app.bellIcon = bellIcon;

const muteNow = () => homeUi.data?.mute ?? { all: null, items: {}, stuckTells: true };

/**
 * The mute covering any of these keys ({ until, text }), or null: Mute all first, then "until you unmute", then the one
 * that ends last (the same order as mutedBy in src/mute.ts, which decides for notifications). all: true = it is Mute all.
 */
function mutedBy(keys) {
  const m = muteNow();
  if (m.all) return { ...m.all, all: true };
  const found = keys.filter(Boolean).map(k => m.items[k]).filter(Boolean);
  if (!found.length) return null;
  return found.find(x => x.until === null) ?? found.sort((a, b) => Date.parse(b.until) - Date.parse(a.until))[0];
}
app.mutedBy = mutedBy;
/** A row's words: under Mute all the top bar says it once, so rows keep only the bell and the grey dot. */
app.mutedWords = muted => (muted && !muted.all ? `Muted ${muted.text}` : '');
app.stuckTells = () => muteNow().stuckTells !== false;

/** The person key of a chat's "who" (the manager, a hire, a node hire). */
app.personKey = who => (String(who).startsWith('staff:') || String(who).startsWith('node:') ? String(who) : 'manager');

/** The bits a muted row adds: the bell with a line and its words, and a grey dot in place of the number. */
app.muteBits = (muted, count, loud = false) => ({
  icon: muted ? el('span', { class: 'rail-muted', title: `Muted ${muted.text}: no number, work carries on` }, bellIcon(true, 14)) : null,
  count: !count ? null
    : muted && !loud ? el('span', { class: 'rail-count is-muted', role: 'img', 'aria-label': `${count} new (muted)`, title: `${count} new (muted)` })
      : el('span', { class: 'rail-count', text: String(count), 'aria-label': `${count} new` }),
});

// ---- The Mute window: three lengths, Unmute when muted; Mute all also carries the "stuck" tick ----

const muteDlg = el('dialog', { class: 'small-dlg mute-dlg', 'aria-labelledby': 'mute-title' });
document.body.append(muteDlg);

/** Opens the Mute window for one key ("staff:rowan", "room:<id>", "chat:<id>", "manager") or 'all', named for him. */
async function openMute(key, label) {
  const fault = el('p', { class: 'fault', role: 'alert', hidden: true });
  const now = key === 'all' ? muteNow().all : muteNow().items[key];
  const go = async length => {
    try {
      homeUi.data && (homeUi.data.mute = await api('/api/mute', { key, for: length }));
      muteDlg.close();
      drawMuted();
    } catch (err) {
      fault.textContent = err.message;
      fault.hidden = false;
    }
  };
  const btn = (text, length, primary) => el('button', { class: `btn${primary ? ' primary' : ''}`, type: 'button', text, onclick: () => go(length) });
  const stuck = el('input', { type: 'checkbox', id: 'mute-stuck' });
  stuck.checked = muteNow().stuckTells !== false;
  stuck.addEventListener('change', async () => {
    try {
      homeUi.data && (homeUi.data.mute = await api('/api/mute', { stuckTells: stuck.checked }));
      drawMuted();
    } catch (err) {
      stuck.checked = !stuck.checked;
      fault.textContent = err.message;
      fault.hidden = false;
    }
  });
  muteDlg.replaceChildren(el('div', { class: 'help-body' },
    el('h2', { id: 'mute-title', text: key === 'all' ? 'Mute all' : `Mute ${label}` }),
    el('p', { class: 'hint', text: key === 'all'
      ? 'Quiet, not stopped: everyone keeps working, and what comes back still waits in "Waiting for you" on Home. The numbers, sounds and Windows notifications stop (a grey dot shows instead).'
      : `Quiet, not stopped: ${key.startsWith('room:') ? 'the job keeps going' : key.startsWith('chat:') ? 'the chat keeps its answers' : `${label} keeps working`}, and what comes back still waits in "Waiting for you" on Home. Its number, sound and Windows notification stop (a grey dot shows instead).` }),
    now ? el('p', { class: 'mute-now' }, bellIcon(true), ` Muted ${now.text}.`) : null,
    fault,
    el('div', { class: 'team-actions' }, btn('For 1 hour', 'hour', !now), btn('Until tomorrow morning', 'morning'), btn('Until I unmute', 'forever'), now ? btn('Unmute', 'off', true) : null),
    key === 'all' || key.startsWith('room:')
      ? el('label', { class: 'check' }, stuck, ` Still tell me when a job is stuck waiting for me (a step stopped on a fault, or the tests failed)${key === 'all' ? '' : ': one setting for every job room, not only this one'}`)
      : null,
    key === 'all' ? el('p', { class: 'hint' }, 'Sounds and Windows notifications: ', el('button', { class: 'link', type: 'button', text: 'Settings', onclick: () => {
      muteDlg.close();
      openSettings();
    } }), '.') : null,
    el('div', { class: 'team-actions' }, el('button', { class: 'btn quiet', type: 'button', text: 'Close', onclick: () => muteDlg.close() }))));
  muteDlg.showModal();
}
app.openMute = openMute;

// Right-click (or the keyboard's menu key) on a row in the left panel: Mute it.
$('#rail').addEventListener('contextmenu', e => {
  const row = e.target.closest('.rail-row[data-key]');
  const key = row?.dataset.key ?? '';
  if (!/^(manager|staff:|node:|chat:)/.test(key)) return;
  e.preventDefault();
  const name = row.querySelector('.rail-name')?.textContent ?? 'this';
  openMute(key, key.startsWith('chat:') ? `"${name}"` : name);
});

// ---- The top bar: a bell for Mute all; while all is muted, "All muted until …" and one Unmute button ----

$('#mute-all').addEventListener('click', () => openMute('all'));
$('#mute-all-off').addEventListener('click', async () => {
  try {
    homeUi.data && (homeUi.data.mute = await api('/api/mute', { key: 'all', for: 'off' }));
    drawMuted();
  } catch (err) {
    $('#mute-all-line').title = err.message;
  }
});

/** The top bar's bell and line (drawRail calls this on every refresh: a mute ends by itself). */
function drawMuteBar() {
  const all = muteNow().all;
  $('#mute-all').replaceChildren(bellIcon(!!all, 18));
  $('#mute-all').title = all ? `Everything is muted ${all.text}: change it or unmute` : 'Mute all (1 hour, until tomorrow morning or until you unmute) and notification settings';
  $('#mute-all').setAttribute('aria-label', all ? `All muted ${all.text}` : 'Mute all');
  $('#mute-all-line').hidden = !all;
  $('#mute-all-text').textContent = all ? `All muted ${all.text}` : '';
}
app.drawMuteBar = drawMuteBar;

// ---- Settings (top bar): notifications, app lock, your data and updates ----

/** Opens the Settings page (like Models, a page, not a window), each part drawn fresh from what the server says now. */
function openSettings() {
  $('#settings-notify').replaceChildren(app.notifyBox?.() ?? '');
  $('#settings-lock').replaceChildren(app.appLockBox?.() ?? '');
  $('#settings-keep').replaceChildren(app.keepBox?.() ?? '');
  // A window open over the page would cover it (the bell's own window has a Settings link).
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  setView('settings');
  // The left panel is the Set up menu here (style.css): open, whatever it was folded to before.
  $('#rail-setup-fold').open = true;
  $('#settings').scrollTop = 0;
}
app.openSettings = openSettings;
$('#settings-open').addEventListener('click', () => openSettings());

/** Redraws everything that shows a mute: the rows (which redraw the bar). */
function drawMuted() {
  drawRail();
  drawMuteBar();
}
drawMuteBar();
