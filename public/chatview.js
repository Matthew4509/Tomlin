// The open chat: "This chat is getting large", showing a chat and following its answer, the draft, sending (and
// Connect then send), Help and the chat's profile photo. Moved out of app.js, whose helpers it uses; loaded right after it.
'use strict';

// ---- "This chat is getting large" (PLAN F10 G1): a handoff into a new chat, or Ignore (asked again at 90%) ----
const large = $('#chat-large');
function drawLarge(l) {
  large.hidden = !l;
  if (!l) return;
  const write = el('button', { class: 'btn primary', type: 'button', text: 'Write a handoff and start fresh' });
  const ignore = el('button', { class: 'btn quiet', type: 'button', text: 'Ignore' });
  write.addEventListener('click', () => {
    if (streamingHere()) return;
    large.hidden = true;
    log.querySelector('.empty')?.remove();
    const out = el('div', { class: 'msg assistant' }, typingNote('Writing the handoff'));
    log.append(out);
    log.scrollTop = log.scrollHeight;
    talk('/api/chat/handoff', chatNamed(), out, '');
  });
  ignore.addEventListener('click', () => {
    large.hidden = true;
    api('/api/chat/large', chatNamed()).catch(() => undefined);
  });
  large.replaceChildren(
    el('p', { text: l.fill > 100
      ? `This chat is getting large: it now needs ${l.fill}% of what the model can read, so the oldest messages are only summarised. A handoff carries the work into a new chat that starts clear.`
      : `This chat is getting large: it fills about ${l.fill}% of what the model can read. Past 100% the oldest messages are only summarised. A handoff carries the work into a new chat that starts clear.` }),
    el('div', { class: 'team-actions' }, write, ignore));
}

/** A chat's lines on screen, and who and what it is (chats.js draws the title and the left panel). */
/**
 * A question in the chat's own box (#chat-ask: "Load X and send?", "busy: add to the queue?") belongs to the chat it was
 * asked in: opening another chat calls it off, so its answer can never send into the chat now on screen.
 */
const chatKey = () => `${app.chatId ?? ''}|${app.chatWho?.() ?? ''}`;
app.askFor = (box, cancel) => {
  if (box.id !== 'chat-ask') return;
  box.askKey = chatKey();
  box.cancelAsk = cancel;
};
function dropOtherAsk() {
  const box = $('#chat-ask');
  if (box && !box.hidden && box.cancelAsk && box.askKey !== chatKey()) {
    const cancel = box.cancelAsk;
    box.cancelAsk = null;
    cancel();
  }
}
function showChat(r) {
  drawChat(r.lines, r.chat);
  syncSend(r.chat?.id ?? '');
  setThink(!!r.chat?.think);
  // Where this chat's last answer ran, for the chat head ("Rowan · Coder · on laptop 9B").
  app.lastRan = [...r.lines].reverse().find(l => l.ran && !l.picture)?.ran ?? '';
  app.onChat?.(r.chat ?? null);
  restoreDraft(r.chat?.id ?? '');
  if (r.chat?.live) followAnswer(r.chat.id);
  dropOtherAsk();
}

/**
 * An answer still being written in this chat, asked before a reload (or from another window): it carries on in the
 * server, and this page follows it from where it is now, as if it had asked. Stop works on it as on any answer.
 */
function followAnswer(chatId) {
  if (!chatId || streams.has(chatId)) return;
  const out = el('div', { class: 'msg assistant' }, typingNote());
  log.querySelector('.empty')?.remove();
  log.append(out);
  log.scrollTop = log.scrollHeight;
  talk('/api/chat/follow', { chatId }, out, '');
}

// The app lock starts the page again so no chat stays on screen: a message being typed is kept in this tab and put
// back in its own chat's box once the app is open again.
const DRAFT_KEY = 'app-lock-draft';
app.keepDraft = () => {
  const text = input.value;
  if (!text.trim()) return;
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ chat: app.chatId ?? '', text }));
  } catch {
    // Not kept: the browser refuses storage here.
  }
};
function restoreDraft(chatId) {
  let d = null;
  try {
    d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null');
  } catch {
    return;
  }
  if (!d || d.chat !== chatId || input.value.trim()) return;
  input.value = d.text;
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Already gone.
  }
}
api('/api/chat').then(showChat).catch(() => undefined);

app.chatNote = text => {
  log.querySelector('.empty')?.remove();
  log.append(el('div', { class: 'msg system', text }));
  log.scrollTop = log.scrollHeight;
};

/**
 * The answers streaming into this window, one per chat: chat id -> { ac, out, inPlace } (its bubble; in place: a
 * Continue grows the answer it carries on). Another chat can be opened, and sent to, while one streams; coming back to
 * it shows it carrying on. Send and Stop are the open chat's own.
 */
const streams = new Map();
const streamingHere = () => streams.has(app.chatId ?? '');
app.liveChat = id => streams.has(id);
/** Send and Stop for the chat on screen: Stop while its own answer streams, Send otherwise. */
function syncSend(id = app.chatId ?? '') {
  const busy = streams.has(id);
  sendBtn.disabled = busy;
  stopBtn.hidden = !busy;
}
/** A message from the Send to card (sendto.js): where it came from, and that Send was the ask to load a model. */
const sentWith = { from: '', asked: false };
function send(message, from = '', agree = false, now = false) {
  log.querySelector('.empty')?.remove();
  const mine = userBubble(message);
  if (from) mine.append(sentLine({ from }));
  log.append(mine);
  const out = el('div', { class: 'msg assistant' }, typingNote());
  log.append(out);
  log.scrollTop = log.scrollHeight;
  large.hidden = true;
  return talk('/api/chat', { ...chatNamed(), message, ...(from ? { from } : {}), ...(agree ? { agree: true } : {}), ...(now ? { now: true } : {}), ...(thinkOn() ? { think: true } : {}) }, out, message, from);
}

/**
 * The chat on screen, named in everything sent about it (the server's "open chat" is whichever window opened one
 * last): its id, or for a chat with no messages yet who it is with, and how the host talks.
 */
function chatNamed() {
  return { chatId: app.chatId ?? '', who: String(app.chatWho?.() ?? ''), ...(typeof plainWho === 'function' ? { plain: plainWho() } : {}) };
}

/**
 * This PC is a node and what is about to run touches a linked PC's work (their model answering, or pushed out of
 * memory): "Using this can impact connected users", with why, and a tick. True only when I agree is ticked and Go ahead
 * pressed. The button stays pressable and says why when the tick is missing.
 */
app.agreeImpact = text => new Promise(resolve => {
  const dlg = $('#impact-dlg');
  $('#impact-text').textContent = text;
  $('#impact-agree').checked = false;
  $('#impact-why').textContent = '';
  let done = false;
  const end = v => {
    if (done) return;
    done = true;
    if (dlg.open) dlg.close();
    resolve(v);
  };
  $('#impact-form').onsubmit = e => {
    e.preventDefault();
    if (!$('#impact-agree').checked) {
      $('#impact-why').textContent = 'Tick "I agree" first: it says you know the linked PC may have to wait.';
      return;
    }
    end(true);
  };
  $('#impact-cancel').onclick = () => end(false);
  dlg.onclose = () => end(false);
  dlg.showModal();
});
/** Send to…: the text goes into this chat's box and is sent at once, as if typed and sent here. */
app.sendNow = (text, from) => {
  input.value = text;
  Object.assign(sentWith, { from: from ?? '', asked: true });
  $('#chat-form').requestSubmit();
};

/** Streams one answer into `out`: a new message's, the rest of a cut answer (Continue), or a handoff. */
async function talk(url, body, out, message, from = '') {
  const ac = new AbortController();
  // The chat this answer belongs to, and who it is with, as they were when it was sent (another may be open by the end).
  const chatId = app.chatId ?? '';
  const who = chatUi.open?.who ?? app.chatWho?.();
  const here = () => (app.chatId ?? '') === chatId;
  const scroll = () => { if (out.isConnected) log.scrollTop = log.scrollHeight; };
  streams.set(chatId, { ac, out, inPlace: url === '/api/chat/continue' });
  syncSend();
  const t0 = performance.now();
  let first = 0;
  // Agreed after "Using this can impact connected users": sent again once this stream has ended.
  let again = false;
  // The model's working before its answer (Think): folded above the answer as it streams. While it works, Answer now
  // stops the working and asks for the answer with what it has worked out so far.
  let thought = null;
  let hurry = null;
  const withThought = (...rest) => out.replaceChildren(...(thought ? [thought] : []), ...(hurry ? [hurry] : []), ...rest);
  const hurryButton = () => {
    const b = el('button', { class: 'btn quiet answer-now', type: 'button', text: 'Answer now', title: 'Stop working it out and answer with what it has worked out so far' });
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Asking for the answer…';
      try {
        await api('/api/chat/answer-now', { chatId: streams.get(chatId)?.liveId ?? chatId });
      } catch (e) {
        b.textContent = e.message;
      }
    });
    return b;
  };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    // The answer followed ended just before: it is in the chat now, so the chat is shown again.
    if (url === '/api/chat/follow' && res.status === 404) {
      out.remove();
      if (here()) again = 'reload';
      return;
    }
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `TOMLIN answered ${res.status}.`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (\w+)/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
        if (ev === 'thinking') {
          thought = thoughtFold(data.text, data.seconds, false, thought);
          hurry ??= hurryButton();
          if (thought.parentNode !== out) withThought();
          scroll();
        } else if (ev === 'text') {
          if (!first) first = performance.now();
          if (thought) thought.querySelector('summary').textContent = 'Thought first: the answer follows';
          hurry = null;
          withThought(formatted(data.text));
          scroll();
        } else if (ev === 'chat' || ev === 'brain') {
          // A new chat's id, known once its first message is in: Stop and Answer now reach this answer by it (a Stop
          // pressed before it came is sent now).
          const s = streams.get(chatId);
          if (s && data.chat) {
            s.liveId = data.chat;
            if (s.stopAsked) {
              s.stopAsked = false;
              api('/api/chat/stop', { chatId: data.chat }).catch(() => undefined);
            }
          }
          if (ev === 'brain' && here()) app.onBrain?.(data.ran);
        } else if (ev === 'status') {
          hurry = null;
          out.replaceChildren(data.text);
        } else if (ev === 'progress') {
          out.replaceChildren(el('span', { class: 'hint', text: progressText(data) }));
        } else if (ev === 'reading') {
          // Before the first word: how far the model has read the chat (gone once the answer or its working begins).
          const said = readingText(data);
          if (said && !first && !thought) out.replaceChildren(el('span', { class: 'hint', text: said }));
        } else if (ev === 'picture') {
          out.replaceChildren(pictureBubble({ output: data.output, prompt: data.prompt }, data.caption));
          scroll();
        } else if (ev === 'note') {
          out.className = 'msg system';
          out.textContent = data.text;
        } else if (ev === 'refused') {
          out.replaceChildren(data.text);
          out.classList.add('system');
          scroll();
        } else if (ev === 'done' && data.picture) {
          if (data.ran || data.note) out.append(el('span', { class: 'speed', text: [data.ran ? `drawn ${data.ran}` : '', data.note].filter(Boolean).join(' · ') }));
          scroll();
        } else if (ev === 'done' && data.handoff) {
          // The handoff opens a new chat with the same person; the old one stays in the list as it was. Shown only when
          // its chat is still the one on screen: another chat opened meanwhile is not taken away.
          const r = here() ? await api(chatUrl(data.handoff)).catch(() => null) : null;
          if (r?.chat) showChat(r);
        } else if (ev === 'done') {
          thought = data.thought?.text ? thoughtFold(data.thought.text, data.thought.seconds, true, thought) : null;
          hurry = null;
          withThought(data.text ? formatted(data.text) : '(no answer)');
          if (data.perSecond > 0 && here()) {
            chatSpeeds.push(data.perSecond);
            drawAverage();
          }
          if (data.cut) out.append(continueButton());
          if (data.waiting) {
            out.append(reconnectLine(data.waiting));
            watchOwed(chatId);
          }
          if (data.large && here()) drawLarge(data.large);
          const secs = ((performance.now() - t0) / 1000).toFixed(1);
          const stats = statsLine([`First word after ${first ? ((first - t0) / 1000).toFixed(1) : secs} s`, `whole answer ${secs} s`, data.ran, data.perSecond ? `${data.perSecond.toFixed(1)} tokens a second` : ''], [data.sources ? `Read: ${data.sources}` : '', data.note]);
          if (stats) out.append(stats);
          if (data.text && !data.saved && !data.continued) {
            // A chat made by this first message is not open in the list yet: the person picked for it is.
            const acts = msgActs(data.text, true, who);
            if (acts) out.append(acts);
            const mine = out.previousElementSibling;
            const pinMine = mine?.classList.contains('user') && !data.saved ? msgActs(message, false) : null;
            if (pinMine) mine.append(pinMine);
          }
          if (!data.continued) app.offerMemory?.(data, out);
        } else if (ev === 'error') {
          out.className = 'msg system';
          out.textContent = data.text;
        } else if (ev === 'impact') {
          // A linked PC is using that model on this PC: the message comes out of the chat (nothing was saved), and is
          // sent again only when he agrees.
          out.previousElementSibling?.classList.contains('user') && out.previousElementSibling.remove();
          out.remove();
          if (here()) input.value = message;
          if (message && here() && (await app.agreeImpact(data.text))) {
            input.value = '';
            again = true;
          }
        } else if (ev === 'queue') {
          // The hire's PC is busy with the queue: the message comes out of the chat (nothing was saved), and he picks:
          // add it to the queue, send it now anyway, or not now (it stays in the box).
          out.previousElementSibling?.classList.contains('user') && out.previousElementSibling.remove();
          out.remove();
          if (here()) input.value = message;
          const s = streams.get(chatId);
          if (s && data.chat) s.liveId = data.chat;
          if (message && here()) {
            const how = await app.offerQueue(data, message, thinkOn());
            if ((how === 'queued' || how === 'now') && here()) input.value = '';
            if (how === 'now' && here()) again = 'now';
          }
        } else if (ev === 'backup') {
          // Their PC is off: the message comes out of the chat until a backup is picked, then it is sent again.
          if (!message) return;
          if (!here()) {
            out.className = 'msg system';
            out.textContent = 'Their PC is off, so this was not sent. Open this chat again and send it once more to pick a backup.';
            continue;
          }
          out.previousElementSibling?.classList.contains('user') && out.previousElementSibling.remove();
          out.remove();
          input.value = message;
          app.openBackup?.(data, message);
        }
      }
    }
  } catch (error) {
    if (!ac.signal.aborted) {
      out.className = 'msg system';
      out.textContent = error.message;
    }
  } finally {
    const sentTo = streams.get(chatId)?.liveId || chatId;
    streams.delete(chatId);
    syncSend();
    scroll();
    // The first message names a new chat, and a message moves it to the top of the list. Sent again (agreed, or "send
    // now anyway"): the chat the first try made is taken up first, so the message goes into it, not a second new chat.
    if (again === true || again === 'now') {
      await app.afterSend?.(sentTo, chatId);
      send(message, from, again === true, again === 'now');
    } else {
      if (again === 'reload') api(chatUrl(chatId)).then(r => { if (here()) showChat(r); }).catch(() => undefined);
      app.afterSend?.(sentTo, chatId);
    }
  }
}

$('#chat-form').addEventListener('submit', e => {
  e.preventDefault();
  // Sent from the Send to card: taken once, so nothing of it is left for the next message typed here.
  const card = { ...sentWith };
  Object.assign(sentWith, { from: '', asked: false });
  const message = input.value.trim();
  if (!message) return;
  if (streamingHere()) return app.chatNote('This chat is still answering: wait for it, or press Stop, then send.');
  // Pictures are drawn in an artist's own chat, from the words as typed: "/image ..." here says who to ask.
  if (/^\/image\b/i.test(message)) {
    input.value = '';
    app.chatNote(app.artistPointer?.() ?? 'Pictures are drawn by an artist: open their chat and type what to draw.');
    return;
  }
  // A hire who lives on another PC answers there: nothing needs to be connected here. "remember: ..." is saved by the
  // app to the notebook, without a model.
  // The person in the chat on screen (the server's chosen "who" is whichever window chose last).
  const who = String(app.chatWho?.() ?? app.models?.settings?.who ?? '');
  // A picture asked for here ("can you draw a lighthouse", "make me a picture of…") needs no model: who draws, and where.
  if (/^\s*(?:please\s+)?(?:(?:can|could|will|would)\s+you\s+)?(?:please\s+)?(?:(?:draw|paint|sketch)\b|(?:make|create|generate|render|show|send|give)(?:\s+(?:me|us))?\s+(?:an?\s+|the\s+|some\s+)?(?:\w+\s+)?(?:image|picture|pic|photo|drawing|illustration|selfie|portrait|cartoon|avatar)s?\b)/i.test(message)) {
    input.value = '';
    log.querySelector('.empty')?.remove();
    log.append(userBubble(message));
    app.chatNote(app.artistPointer?.() ?? 'Pictures are drawn by an artist: open their chat and type what to draw.');
    return;
  }
  // The same test as the server's (src/memory.ts rememberCommand): "remember: ...", or "remember that ..." with no question in it.
  const remember = !who.startsWith('node:') && /^\s*remember\s*(for\s+(the\s+)?(whole\s+)?team\s*)?(:|\s-\s|\bthat\b(?![^?]*\?))/i.test(message);
  // A hire answers on their own brain (here or on a linked PC): the server checks it, and says so when it cannot.
  if (app.status?.panes.chat.state !== 'connected' && !who.startsWith('node:') && !who.startsWith('staff:') && !remember) {
    connectThenSend(message, card);
    return;
  }
  input.value = '';
  send(message, card.from);
});

/**
 * The host with no model loaded: one press loads the model picked beside Connect and sends the
 * message, as a hire's model loads on Send. Nothing loads by itself: the press is the ask.
 */
async function connectThenSend(message, card = { from: '', asked: false }) {
  const p = panes.chat;
  const state = app.status?.panes.chat.state;
  if (state === 'loading' || state === 'unloading') return app.chatNote(`The chat model is ${state === 'loading' ? 'still loading' : 'unloading'}: send again once it says Connected.`);
  const m = (app.models?.chat ?? []).find(x => x.id === p.model.value && x.installed !== false);
  if (!m) return app.chatNote('No chat model is on this PC yet, so nobody can answer. Get one under Settings, Set up, Add a model, then press Connect beside it.');
  const tight = m.fit?.level === 'no' ? ` It needs about ${gb(m.fit.need)} and only ${gb(m.fit.free)} is free, so it may make the PC very slow, or fail.` : '';
  // Send in the Send to card was the ask (it said a model loads first), unless the model does not fit: that is asked.
  if (!(card.asked && !tight) && !(await askHere($('#chat-ask'), `No model is loaded for this chat yet (nothing loads by itself).${tight} Load ${m.name} and send your message?`, `Load ${m.name} and send`, 'Not now', !!tight))) return;
  input.value = '';
  const typedIn = chatKey();
  await app.chatModelPicked?.(m.id);
  log.querySelector('.empty')?.remove();
  const mine = userBubble(message);
  const wait = el('div', { class: 'msg system', text: `Loading ${m.name}…` });
  log.append(mine, wait);
  log.scrollTop = log.scrollHeight;
  const back = text => {
    mine.remove();
    wait.textContent = text;
    input.value = message;
  };
  try {
    await loadModel(m.id, { device: p.device.value, threads: Number(p.threads.value) || 0 });
  } catch (err) {
    return back(`${m.name} did not load: ${err.message} Your message is back in the box.`);
  }
  for (let i = 0; i < 1800; i++) {
    await new Promise(r => setTimeout(r, 500));
    await poll();
    const v = app.status?.panes.chat;
    if (v?.state === 'connected') break;
    if (v?.state === 'failed' || (v?.state === 'disconnected' && i > 6)) return back(`${m.name} did not load${v.error ? `: ${v.error}` : ''}. Your message is back in the box.`);
    wait.textContent = `Loading ${m.name}${v?.stage ? `: ${v.stage}` : ''}…`;
  }
  mine.remove();
  wait.remove();
  // Another chat was opened while the model loaded: the message is not sent into it.
  if (chatKey() !== typedIn) return app.chatNote(`${m.name} is loaded, but your message was typed in another chat, so it was not sent here. Open that chat and send it again: "${message.length > 80 ? message.slice(0, 80) + '…' : message}"`);
  send(message, card.from);
}
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
// Stop ends the open chat's own answer; one running in another chat carries on.
// A new chat's id comes with the answer's first word from the server: a Stop pressed before that is sent once it comes
// (sent as '' it would stop the blog writer instead).
stopBtn.addEventListener('click', () => {
  const s = streams.get(app.chatId ?? '');
  const id = s?.liveId || app.chatId || '';
  if (!id) {
    if (s) s.stopAsked = true;
    return;
  }
  api('/api/chat/stop', { chatId: id }).catch(() => undefined);
});
// Empty this chat (in its … window): asked on the page first, and a refusal is said, not hidden.
const clearBtn = $('#chat-clear');
clearBtn.addEventListener('click', () => {
  const row = $('#chat-clear-actions');
  const back = () => row.replaceChildren(clearBtn);
  const yes = el('button', { class: 'btn danger', type: 'button', text: 'Empty it for good' });
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      const cleared = app.chatId ?? '';
      streams.get(cleared)?.ac.abort();
      await api('/api/chat/clear', { chatId: cleared });
      // Drawn again from the server: the chat's documents stay (and are still read), so their bar stays too.
      const again = cleared ? await api(chatUrl(cleared)).catch(() => null) : null;
      if ((app.chatId ?? '') === cleared) again ? showChat(again) : drawChat([]);
      back();
      $('#chat-menu').close();
    } catch (err) {
      back();
      $('#chat-menu-fault').textContent = 'Nothing was emptied: ' + err.message;
      $('#chat-menu-fault').hidden = false;
    }
  });
  row.replaceChildren(el('span', { class: 'hint', text: 'Empty this chat for good?' }), yes, el('button', { class: 'btn quiet', type: 'button', text: 'Keep the messages', onclick: back }));
  yes.focus();
});
// The window opens with the plain button, whatever was left showing.
app.resetClear = () => $('#chat-clear-actions').replaceChildren(clearBtn);
$('#chat-menu').addEventListener('close', app.resetClear);

// ---- Help: which model (the Help button, and "Which model?" under each pane) ----
// Each cell carries its column's name, so a phone can show the rows as cards (style.css).
for (const table of document.querySelectorAll('.help-table')) {
  const names = [...table.querySelectorAll('thead th')].map(th => th.textContent);
  for (const row of table.querySelectorAll('tbody tr')) [...row.children].forEach((cell, i) => cell.setAttribute('data-label', names[i] ?? ''));
}
/** Help is a page, like Models (it was a window): it opens at the part asked for, or at the top. */
function openHelp(part) {
  // A window open over the page would cover it (the ? buttons in windows open Help too).
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  setView('help');
  const at = part && part !== 'help-title' ? document.getElementById(part) : null;
  if (at) at.scrollIntoView({ block: 'start' });
  else $('#help').scrollTop = 0;
}
app.openHelp = openHelp;
document.addEventListener('click', e => {
  const opener = e.target.closest?.('[data-help]');
  if (opener) openHelp(opener.dataset.help);
});

// "Open the log" in Help (PLAN F10 G8): today's log file in Notepad, or the logs folder when today has none.
$('#log-open').addEventListener('click', async () => {
  try {
    $('#log-said').textContent = (await api('/api/keep', { do: 'open-log' })).said;
  } catch (err) {
    $('#log-said').textContent = err.message;
  }
});

// ---- Profile photo of the open chat's person (faces.js draws it): left of the chat model ----
const avatar = $('#chat-avatar');
// The photo says how to set one: a picture from an artist's chat (the pictures live there now, not beside the chat).
avatar.addEventListener('click', () => {
  app.chatNote('To set a profile photo: open an artist\'s chat, click a picture, then press "Set as profile photo" and pick whose photo it is.');
});

// Every window has its title and a Close button in a bar that stays at the top while the window scrolls (the Close at
// the bottom stays too). Windows that already have the bar (Staff) are left as they are.
for (const h of document.querySelectorAll('dialog > .help-body > h2:first-child')) {
  const dlg = h.closest('dialog');
  // A centred pop-up (Move, Fire) asks one thing: its own buttons close it, no bar on top.
  if (dlg.classList.contains('ask-pop')) continue;
  const last = dlg.querySelector('.help-body > form[method="dialog"]:last-child button');
  const top = el('div', { class: 'dlg-top' });
  h.replaceWith(top);
  top.append(h, el('form', { method: 'dialog' }, el('button', { class: 'btn', type: 'submit', text: last?.textContent || 'Close' })));
}
