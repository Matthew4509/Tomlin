// "Send to…": a prompt to read and change before it is handed on. Copy puts it on the clipboard (to paste anywhere);
// "Write it as a prompt for…" has the chat model turn the words into what that person works from (the instruction is
// picked by code from their role); Send opens that person's chat (or the subject named) and sends it at once: an artist
// draws it, anyone else answers, and a model that is not loaded loads first. Both chats say so: "Sent from …" on the
// message that arrives, "Sent to …" under the answer it came from. Opened from "Send to…" under an answer, and from the
// blog writer's picture button (whose picture, drawn by an artist here, is added to the post).
// Uses app.js's helpers ($, el, api, app, poll) and chats.js's and home.js's (chatUi, loadChats, showOpened, plainWho, homeUi).
'use strict';

const sendDlg = $('#send-to');
const sendWho = $('#send-to-who');
const sendText = $('#send-to-text');
/** from: where the words came from ({ chat, label, text }); blog: the post, when the blog writer opened the card. */
const sendUi = { from: null, blog: null, before: '', last: '' };

function sendFault(text) {
  $('#send-to-fault').textContent = text ?? '';
  $('#send-to-fault').hidden = !text;
}
const sendPerson = who => chatUi.people.find(p => p.who === who) ?? null;

/** Everyone who can be sent to, grouped as the left panel groups them. */
function drawSendPeople(pick) {
  const people = chatUi.people;
  const opt = p => el('option', { value: p.who, text: `${p.name} · ${p.role.replace(/ · draws what you ask$/, '')}${p.pc && p.pc !== 'this PC' ? ` · on "${p.pc}"` : ''}` });
  const group = (label, list) => (list.length ? el('optgroup', { label }, ...list) : null);
  const artists = people.filter(p => p.kind === 'image').map(opt);
  // The blog writer's picture can also come from the picture model connected here, with no artist.
  if (sendUi.blog) artists.unshift(el('option', { value: '', text: 'No artist: the picture model connected here' }));
  sendWho.replaceChildren(...[
    group('The host', people.filter(p => p.who === 'manager').map(opt)),
    group('Artists', artists),
    group('Staff', people.filter(p => p.kind === 'chat' && p.who.startsWith('staff:')).map(opt)),
  ].filter(Boolean));
  const has = v => [...sendWho.options].some(o => o.value === v);
  sendWho.value = pick !== undefined && pick !== null && has(pick) ? pick : has(sendUi.last) ? sendUi.last : sendWho.options[0]?.value ?? '';
}

/** What Send will do with the person picked, said before it is pressed. */
function drawSendWhat() {
  const who = sendWho.value;
  const p = sendPerson(who);
  const name = p ? app.inSentence(p.name) : '';
  const first = name.split(/\s+/)[0];
  const blogDraw = !!sendUi.blog && (who === '' || (p?.kind === 'image' && who.startsWith('staff:') && p.pc === 'this PC'));
  const elsewhere = p && p.pc !== 'this PC' ? ` on "${p.pc.replace(/ \(off now\)$/, '')}"` : '';
  const busy = (homeUi.data?.answering ?? [])[0];
  $('#send-to-what').textContent = [
    blogDraw ? `Draws it at once${who ? `, as ${first}` : ''}, and adds the picture to the post. A picture model that is not loaded loads first.`
      : !p ? ''
      : p.kind === 'image' ? `Opens ${first}'s pictures and draws it at once${elsewhere}${sendUi.blog ? ': the picture stays in their pictures, it is not added to the post' : ''}. A model that is not loaded loads first.`
      : `Opens the chat with ${name} and sends it at once: ${p.who === 'manager' ? 'the host answers' : `${first} answers`}${elsewhere}. A model that is not loaded loads first.`,
    busy && !blogDraw ? `${busy.name} is answering in "${busy.title}" now: opening another chat stops that answer.` : '',
  ].filter(Boolean).join(' ');
  $('#send-to-go').textContent = blogDraw ? 'Draw it for the post' : p ? `Send to ${p.who === 'manager' ? 'the host' : first}` : 'Send';
  $('#send-to-write').textContent = p ? `Write it as a prompt for ${p.who === 'manager' ? 'the host' : first}` : 'Write it as a prompt';
  $('#send-to-write').hidden = !p;
  // Their subjects, to pick one (a new name makes a new subject). The blog's own picture has no subject.
  $('#send-to-subject-row').hidden = blogDraw || !p;
  $('#send-to-subjects').replaceChildren(...chatUi.list.filter(c => c.who === who && c.title).map(c => el('option', { value: c.title })));
}
sendWho.addEventListener('change', () => {
  sendFault(null);
  drawSendWhat();
});

/**
 * Opens the card. text: the words to start from; who: the person to pick first; from: where they came from
 * ({ chat, label, text }); blog: { path } when the blog writer opened it.
 */
app.openSend = async ({ text, who = null, from = null, blog = null }) => {
  await loadChats();
  Object.assign(sendUi, { from, blog, before: '' });
  sendFault(null);
  $('#send-to-said').textContent = '';
  $('#send-to-undo').hidden = true;
  sendText.value = text ?? '';
  $('#send-to-subject').value = '';
  $('#send-to-about').textContent = blog ? 'The picture prompt written from the post. Change anything before it is drawn, or copy it to use somewhere else.'
    : `${from?.label ? `From ${from.label}. ` : ''}Read it and change anything before it goes, copy it to paste somewhere else, or send it to someone.`;
  drawSendPeople(who);
  drawSendWhat();
  if (!sendDlg.open) sendDlg.showModal();
  sendText.focus();
};

$('#send-to-copy').addEventListener('click', async () => {
  const said = $('#send-to-said');
  try {
    await navigator.clipboard.writeText(sendText.value);
    said.textContent = 'Copied: paste it anywhere (another chat, another program).';
  } catch {
    // Some browsers refuse the clipboard to a page: the words are selected for Ctrl+C instead.
    sendText.focus();
    sendText.select();
    said.textContent = 'Selected: press Ctrl+C to copy it.';
  }
});

$('#send-to-write').addEventListener('click', async () => {
  sendFault(null);
  const btn = $('#send-to-write');
  const said = $('#send-to-said');
  btn.disabled = true;
  said.textContent = 'Writing it…';
  try {
    const r = await api('/api/prompt/write', { text: sendText.value, who: sendWho.value });
    sendUi.before = sendText.value;
    sendText.value = r.prompt;
    said.textContent = `Written as ${r.label}. Change anything before it goes.`;
    $('#send-to-undo').hidden = false;
  } catch (err) {
    said.textContent = '';
    sendFault(err.message);
  } finally {
    btn.disabled = false;
  }
});
$('#send-to-undo').addEventListener('click', () => {
  sendText.value = sendUi.before;
  $('#send-to-undo').hidden = true;
  $('#send-to-said').textContent = 'Back to the words as they were.';
});

/** Loads someone's model (here or on their PC) and waits until it answers, saying how it is going. */
app.wakeAndWait = async (who, say) => {
  let v = await api('/api/staff/wake', { who });
  for (let i = 0; i < 900 && (v.state === 'loading' || v.state === 'connecting'); i++) {
    say(v.state === 'connecting' ? v.text : `Loading ${v.model}${v.pc && v.pc !== 'this PC' ? ` on "${v.pc}"` : ''} · ${v.elapsed} s of about ${v.expect} s`);
    await new Promise(r => setTimeout(r, 1000));
    v = await api(`/api/staff/wake?who=${encodeURIComponent(who)}`);
  }
  if (v.state !== 'on') throw new Error(`${v.text ?? 'Their model did not load.'} Nothing was drawn: the prompt is in the box.`);
  await poll();
};

/** An artist's pictures are open: the prompt goes in their box and is drawn at once (their model loads first if needed). */
async function drawSent(who, p, text, r) {
  $('#img-prompt').value = text;
  $('#img-prompt').dispatchEvent(new Event('input'));
  const v = app.status?.panes.image;
  try {
    if (p.pc === 'this PC' && r.imageModel && !(v?.state === 'connected' && v.model === r.imageModel)) {
      await app.wakeAndWait(who, app.imageNote);
    }
  } catch (err) {
    app.imageNote(err.message);
    return;
  }
  app.imageNote('');
  await app.drawAs?.();
  $('#img-form').requestSubmit();
}

$('#send-to-go').addEventListener('click', async () => {
  sendFault(null);
  const text = sendText.value.trim();
  if (!text) return sendFault('The box is empty: type what to send first.');
  const who = sendWho.value;
  const p = sendPerson(who);
  const subject = $('#send-to-subject').value.trim();
  const blogDraw = !!sendUi.blog && (who === '' || (p?.kind === 'image' && who.startsWith('staff:') && p.pc === 'this PC'));
  if (!blogDraw && !p) return sendFault('Pick who to send it to: they may have left the team.');
  sendUi.last = who;
  const go = $('#send-to-go');
  go.disabled = true;
  try {
    if (blogDraw) {
      sendDlg.close();
      await app.blogDraw(text, who);
      return;
    }
    let r;
    if (subject) r = await api('/api/chats/new', { who, plain: plainWho(), title: subject, chatId: app.chatId ?? '' });
    else {
      // Their latest chat, as a click on them in the left panel opens (or a new one when there is none).
      const last = chatUi.list.find(c => c.who === who);
      r = last ? await api('/api/chats/open', { id: last.id, plain: plainWho() }) : await api('/api/chats/new', { who, plain: plainWho() });
    }
    const from = sendUi.from;
    sendDlg.close();
    if ($('#files').open) $('#files').close();
    await showOpened(r);
    // The answer it came from says where it went (not when it was sent into the same chat).
    if (from?.chat && from.chat !== r.chat.id) {
      const to = `${p.who === 'manager' ? 'the host' : p.name}${r.chat.title && r.chat.title !== 'New chat' ? ` · ${r.chat.title}` : ''}`;
      api('/api/chats/sent', { chat: from.chat, text: from.text, to }).catch(() => undefined);
    }
    if (p.kind === 'image') await drawSent(who, p, text, r);
    else app.sendNow(text, from?.label ?? '');
  } catch (err) {
    if (sendDlg.open) sendFault(err.message);
    else app.chatNote?.(`Not sent: ${err.message}`);
  } finally {
    go.disabled = false;
  }
});

/** The words picked inside a message, when the pick is all inside it; else nothing. */
function pickedIn(msg) {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !msg) return '';
  const range = sel.rangeCount ? sel.getRangeAt(0) : null;
  return range && msg.contains(range.commonAncestorContainer) ? sel.toString().trim() : '';
}

/** "Send to…" under an answer in the chat with who: the whole answer, or only the part picked in it. */
app.sendButton = (text, who) => {
  if (!who || !text?.trim()) return null;
  const b = el('button', { class: 'link pin send-on icon-act', type: 'button', title: 'Send to…: hand this on. Read and change it first, copy it, or send it to someone. Pick part of the answer first to send only that part.', 'aria-label': 'Send to…' }, app.lineIcon(...app.SEND_ICON));
  // The pick is read as the button is pressed: some browsers let it go on the click itself.
  b.addEventListener('pointerdown', () => { b.dataset.picked = pickedIn(b.closest('.msg')); });
  b.addEventListener('click', () => {
    const part = b.dataset.picked || pickedIn(b.closest('.msg'));
    b.dataset.picked = '';
    const p = sendPerson(who);
    const title = chatUi.open?.title;
    const label = `${p ? `${app.inSentence(p.name)}'s chat` : 'a chat'}${title && title !== 'New chat' ? ` "${title}"` : ''}`;
    app.openSend({ text: part || text, from: { chat: app.chatId ?? '', label, text: part || text } });
  });
  return b;
};

// ---- Start from the Bridge (its prompts, a project's prompt, a review, faults to fix): the Bridge's page puts the
// words in this browser's session and opens /?start=1; the card opens with them, to read, change and send to a hire. ----
{
  const q = new URLSearchParams(location.search);
  if (q.get('start') === '1') {
    history.replaceState(null, '', location.pathname);
    let start = null;
    try {
      start = JSON.parse(sessionStorage.getItem('sm-start') ?? 'null');
      sessionStorage.removeItem('sm-start');
    } catch {
      // the session's storage is off: nothing to open
    }
    // Only words put there in the last 10 minutes (a reload later does not open the card again).
    if (start && typeof start.text === 'string' && Date.now() - Number(start.at) < 600_000) {
      window.addEventListener('load', () => setTimeout(() => app.openSend({ text: start.text, from: { label: String(start.label ?? 'the Bridge') } }), 300), { once: true });
    }
  }
}
