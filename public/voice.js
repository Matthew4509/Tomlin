// Voice: lines typed are read aloud on this PC (Kokoro, src/server/voice.ts) and kept as WAV files on the Voice shelf,
// each with a player, Save a copy and Delete. Opened from a Videographer's chat (beside Videos) and from the gallery's
// Voice shelf; a voice-over made from a project's chat is copied into that project too. Uses app.js's helpers ($, el,
// api, app).
'use strict';

const voiceDlg = $('#voice-dlg');
const voiceText = $('#voice-text');
const voicePick = $('#voice-pick');
const voiceSpeed = $('#voice-speed');
const voiceSpeakBtn = $('#voice-speak');
const voiceLine = $('#voice-line');
const voiceKeep = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(`app-voice-${k}`);
    localStorage.setItem(`app-voice-${k}`, v);
  } catch {
    // Not kept in this browser.
  }
  return null;
};
const voiceFault = text => {
  const f = $('#voice-fault');
  f.textContent = text ?? '';
  f.hidden = !text;
};
const voiceUrl = rel => `/api/voice/file/${rel.split('/').map(encodeURIComponent).join('/')}`;
const voiceMB = n => `${Math.max(1, Math.round(n / 2 ** 20))} MB`;
/** "the waves come in" as a file name: what Save a copy offers. */
const voiceFileName = v => `${(v.text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50).trim() || 'voice')}.wav`;

/** The chat the window was opened from: a voice-over made there is copied into its project. */
let voiceChat = '';
let voiceOptions = null;
let voiceTimer = 0;

/** The voices and speeds, once; and whether the voice model is here (Get the voice model, or its download). */
async function loadVoiceOptions() {
  const o = await api('/api/voice/options').catch(error => {
    voiceFault(error.message);
    return null;
  });
  if (!o) return;
  if (!voiceOptions) {
    voicePick.replaceChildren(...o.voices.map(v => el('option', { value: v.id, text: v.name })));
    voicePick.value = voiceKeep('voice') ?? o.voices[0].id;
    if (!voicePick.value) voicePick.value = o.voices[0].id;
    voiceSpeed.replaceChildren(...o.speeds.map(s => el('option', { value: String(s.id), text: s.name })));
    voiceSpeed.value = voiceKeep('speed') ?? '1';
    if (!voiceSpeed.value) voiceSpeed.value = '1';
  }
  voiceOptions = o;
  drawVoiceGet(o);
}

/** Not downloaded yet: the button to get it, or how far its download is; nothing once it is here. */
function drawVoiceGet(o) {
  const box = $('#voice-get');
  clearTimeout(voiceTimer);
  voiceSpeakBtn.disabled = !o.ready;
  if (o.ready || !o.model) {
    box.hidden = true;
    box.replaceChildren();
    if (!o.model && !o.ready) voiceFault('This copy of TOMLIN does not list the voice model.');
    return;
  }
  box.hidden = false;
  const dl = o.model.download;
  const moving = dl && !dl.done && !dl.error;
  if (moving) {
    const pc = Math.floor((dl.got / dl.bytes) * 100);
    box.replaceChildren(el('p', { class: 'hint', text: `${dl.checking ? 'Checking' : 'Downloading'} the voice model: ${pc}% of ${voiceMB(dl.bytes)}.` }));
    if (voiceDlg.open) voiceTimer = setTimeout(loadVoiceOptions, 1000);
    return;
  }
  const get = el('button', { class: 'btn', type: 'button', text: `Get the voice model (${voiceMB(o.model.bytes)})` });
  get.addEventListener('click', async () => {
    get.disabled = true;
    voiceFault(null);
    try {
      await api('/api/downloads/start', { id: o.model.id });
    } catch (error) {
      voiceFault(error.message);
      get.disabled = false;
      return;
    }
    loadVoiceOptions();
  });
  box.replaceChildren(
    el('p', { class: 'hint', text: `The voice model (${o.model.name}, ${o.model.licence}) is not on this PC yet. It is downloaded once, then reads on this PC with nothing sent anywhere.` }),
    ...(dl?.error ? [el('p', { class: 'fault-line', text: dl.error })] : []),
    get);
}

/** One voice-over: its words, the voice and length, a player, Save a copy and Delete. */
function voiceRow(v, redraw) {
  const audio = el('audio', { src: voiceUrl(v.file), controls: '', preload: 'metadata' });
  const save = el('a', { class: 'btn quiet', href: voiceUrl(v.file), download: voiceFileName(v), text: 'Save a copy' });
  const del = el('button', { class: 'btn quiet', type: 'button', text: 'Delete' });
  del.addEventListener('click', async () => {
    if (!confirm('Delete this voice-over from this PC? A copy already in a project stays there.')) return;
    del.disabled = true;
    try {
      await api('/api/voice/delete', { id: v.id });
      redraw();
    } catch (error) {
      del.disabled = false;
      voiceFault(error.message);
    }
  });
  const voice = voiceOptions?.voices.find(x => x.id === v.voice)?.name ?? v.voice;
  return el('div', { class: 'voice-item' },
    el('p', { class: 'voice-words', text: v.text, title: v.text }),
    el('p', { class: 'hint', text: `${voice} · ${v.seconds} s · ${new Date(v.at).toLocaleString()}` }),
    audio,
    el('div', { class: 'voice-acts' }, save, del));
}

/** Draws the Voice shelf into `box`: every voice-over, newest first (`q`: words in the text; `speak`: a Speak a line button first). */
app.drawVoiceShelf = async (box, { q = '', speak = false } = {}) => {
  const qs = new URLSearchParams({ limit: '60' });
  if (q) qs.set('q', q);
  try {
    if (!voiceOptions) await loadVoiceOptions();
    const r = await api(`/api/voice/shelf?${qs}`);
    const redraw = () => app.drawVoiceShelf(box, { q, speak });
    const kids = r.items.map(v => voiceRow(v, redraw));
    if (speak) kids.unshift(el('div', { class: 'voice-acts span-all' }, el('button', { class: 'btn', type: 'button', text: 'Speak a line', onclick: () => app.openVoice(app.chatId ?? '') })));
    if (!kids.length) kids.push(el('p', { class: 'hint', text: q ? `No voice-overs with "${q}" in them.` : 'No voice-overs yet: press Voice, type a line and press Speak.' }));
    if (r.total > r.items.length) kids.push(el('p', { class: 'hint', text: `The newest ${r.items.length} of ${r.total} are shown.` }));
    box.replaceChildren(...kids);
  } catch (error) {
    box.replaceChildren(el('p', { class: 'hint', text: error.message }));
  }
};

/** The Voice window, opened for `chat` (its project gets a copy of each voice-over). */
app.openVoice = (chat = '') => {
  voiceChat = chat || '';
  voiceFault(null);
  voiceLine.textContent = '';
  loadVoiceOptions();
  app.drawVoiceShelf($('#voice-list'));
  voiceDlg.showModal();
  voiceText.focus();
};

voicePick.addEventListener('change', () => voiceKeep('voice', voicePick.value));
voiceSpeed.addEventListener('change', () => voiceKeep('speed', voiceSpeed.value));
voiceSpeakBtn.addEventListener('click', async () => {
  const text = voiceText.value.trim();
  if (!text) return voiceFault('Type a line to read first.');
  voiceFault(null);
  voiceSpeakBtn.disabled = true;
  voiceLine.textContent = 'Reading it aloud on this PC…';
  try {
    const r = await api('/api/voice/speak', { text, voice: voicePick.value, speed: Number(voiceSpeed.value), chat: voiceChat });
    voiceLine.textContent = `Done: ${r.item.seconds} s, on the Voice shelf below.`;
    await app.drawVoiceShelf($('#voice-list'));
    $('#voice-list audio')?.focus();
  } catch (error) {
    voiceLine.textContent = '';
    voiceFault(error.message);
    if (error.data?.needModel) loadVoiceOptions();
  } finally {
    voiceSpeakBtn.disabled = !voiceOptions?.ready;
  }
});
$('#voice-open').addEventListener('click', () => app.openVoice(app.chatId ?? ''));
// A player left playing in a closed window stops; a download being followed is no longer asked about.
voiceDlg.addEventListener('close', () => {
  clearTimeout(voiceTimer);
  for (const a of voiceDlg.querySelectorAll('audio')) a.pause();
  // The gallery's Voice shelf, when it shows, gets the new ones too.
  const shelf = $('.g-shelf[data-shelf="voice"][aria-pressed="true"]');
  if (shelf) app.drawVoiceShelf($('#gallery'), { q: $('#g-search').value.trim(), speak: true });
});
