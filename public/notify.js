// Notifications in the page: one short sound per kind of event (finished, question, stuck) while the page is open, at
// the volume he picks; the server raises the silent Windows notification when the page is not in front (src/notify.ts)
// and its click opens ?chat=<id> or ?room=<job id> (the job) here. Settings sit in the top bar's bell window (mute.js).
// Uses app.js's helpers (el, api, $) and home.js's (homeUi, openRoom); chats.js's openChat.
'use strict';

const notifyUi = { seen: null, ctx: null };

/** Whether this page is in front (shown and focused): the server only raises a Windows notification when it is not. */
app.inFront = () => document.visibilityState === 'visible' && document.hasFocus();

// ---- Sounds: made here, no files. Finished rises, a question asks twice, stuck falls. ----
const TUNES = {
  finished: [[660, 0, 0.12], [880, 0.13, 0.18]],
  question: [[740, 0, 0.1], [740, 0.18, 0.1]],
  stuck: [[523, 0, 0.16], [392, 0.18, 0.26]],
};
function play(event, volume) {
  const tune = TUNES[event];
  if (!tune || !volume) return;
  try {
    notifyUi.ctx ??= new AudioContext();
    const ctx = notifyUi.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    for (const [freq, start, len] of tune) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      const peak = 0.3 * (volume / 100);
      g.gain.setValueAtTime(0, t0 + start);
      g.gain.linearRampToValueAtTime(peak, t0 + start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + start);
      o.stop(t0 + start + len + 0.05);
    }
  } catch {
    // No sound on this browser: the line on Home still says it.
  }
}
// A browser plays sound only after the page was touched once.
document.addEventListener('pointerdown', () => { if (notifyUi.ctx?.state === 'suspended') notifyUi.ctx.resume(); }, { passive: true });

/** After each Home refresh: a sound for each new event (not for the chat he is reading in front of him). */
app.afterHome = () => {
  const n = homeUi.data?.notify;
  if (!n) return;
  // The first answer only sets the mark: events from before the page opened make no sound.
  if (notifyUi.seen === null) {
    notifyUi.seen = n.seq;
    return;
  }
  const fresh = n.told.filter(t => t.seq > notifyUi.seen);
  notifyUi.seen = n.seq;
  if (!n.settings.sound) return;
  const reading = homeUi.view === 'chat' && app.inFront() ? `chat:${app.chatId}` : '';
  const loud = fresh.filter(t => t.open !== reading);
  // One sound per kind, the weightiest first: stuck, then a question, then finished.
  for (const kind of ['stuck', 'question', 'finished']) {
    if (loud.some(t => t.event === kind)) {
      play(kind, n.settings.volume);
      break;
    }
  }
};

// ---- A click on a Windows notification opens http://127.0.0.1:<port>/?chat=<id>, or ?room=<job id> (that job, in Jobs) ----
{
  const q = new URLSearchParams(location.search);
  const chat = q.get('chat');
  const room = q.get('room');
  if (chat || room) {
    history.replaceState(null, '', location.pathname);
    window.addEventListener('load', () => setTimeout(() => (chat ? app.openChat?.(chat) : app.openJob?.(room)), 300), { once: true });
  }
}

// ---- Settings page (top bar) ----

/** The Notifications part of the Settings page. */
app.notifyBox = () => {
  const s = { ...(homeUi.data?.notify?.settings ?? { windows: true, sound: true, volume: 60 }) };
  const note = el('p', { class: 'hint', role: 'status' });
  const save = async change => {
    try {
      const r = await api('/api/notify', change);
      if (homeUi.data?.notify) homeUi.data.notify.settings = r;
      Object.assign(s, r);
      note.textContent = 'Saved.';
    } catch (err) {
      note.textContent = err.message;
    }
  };
  const tick = (key, text) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = !!s[key];
    box.addEventListener('change', () => save({ [key]: box.checked }));
    return el('label', { class: 'check' }, box, ` ${text}`);
  };
  const vol = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(s.volume), 'aria-label': 'Sound volume' });
  vol.addEventListener('change', () => save({ volume: Number(vol.value) }));
  const tryIt = (kind, text) => el('button', { class: 'btn quiet', type: 'button', text, onclick: () => play(kind, Number(vol.value)) });
  const test = el('button', { class: 'btn quiet', type: 'button', text: 'Send a test notification', onclick: async () => {
    try {
      await api('/api/notify/test', {});
      note.textContent = 'Sent: it shows in the corner of the screen (Windows may hide it while Focus assist is on).';
    } catch (err) {
      note.textContent = err.message;
    }
  } });
  return el('div', { class: 'notify-box' },
    el('h3', { text: 'Notifications' }),
    el('p', { class: 'hint', text: 'When a step is finished, a plan or picture needs you, or a job is stuck. They name the person and what happened, never what was written. Mute silences them.' }),
    tick('windows', 'A Windows notification when this page is not in front (silent; a click opens it here)'),
    tick('sound', 'A short sound in this page'),
    el('label', { class: 'field notify-vol' }, el('span', { text: 'Volume' }), vol),
    el('div', { class: 'team-actions' }, tryIt('finished', '▶ Finished'), tryIt('question', '▶ Needs you'), tryIt('stuck', '▶ Stuck'), test),
    note);
};
