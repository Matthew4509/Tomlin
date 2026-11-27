// Memory (notebooks in the code) and "What they read for the next answer" (src/memory.ts on the server). The team's and one per hire: each line can be
// seen, changed and deleted here. Lines are written by him (Add, "remember: ..." in the chat, Pin on a message) or
// saved from a model's suggestion when he presses Save; a model never writes one by itself.
const memDlg = $('#notebook');
const memFault = text => {
  $('#notebook-fault').hidden = !text;
  $('#notebook-fault').textContent = text ?? '';
};

/** One notebook as an editable list, with a box to add a line. Redraws itself after each change. */
async function notebookList(scope, title, hint) {
  const box = el('section', { class: 'nb' }, el('h3', { text: title }), hint ? el('p', { class: 'hint', text: hint }) : null);
  const list = el('ul', { class: 'nb-lines' });
  const fault = el('p', { class: 'fault', hidden: true });
  const undo = el('p', { class: 'hint nb-undo', role: 'status', hidden: true });
  const say = t => {
    fault.hidden = !t;
    fault.textContent = t ?? '';
  };
  // The Inbox (a model's suggestions, not yet kept) is the editor's to show: here only what is read.
  const draw = all => {
    const lines = all.filter(l => l.group !== 'Inbox');
    list.replaceChildren();
    if (!lines.length) list.append(el('li', { class: 'hint nb-empty', text: 'Nothing kept yet.' }));
    for (const l of lines) {
      const text = el('span', { class: 'nb-text', text: l.text });
      const from = el('span', { class: 'nb-from', text: l.from === 'pin' ? 'pinned' : l.from === 'suggested' ? 'suggested, you saved it' : 'you' });
      const edit = el('button', { class: 'link', type: 'button', text: 'Edit' });
      const del = el('button', { class: 'link', type: 'button', text: 'Delete' });
      const row = el('li', { class: 'nb-line' }, el('span', { class: 'nb-body' }, text, from), el('span', { class: 'nb-acts' }, edit, del));
      edit.addEventListener('click', () => {
        const input = el('textarea', { rows: String(Math.min(12, Math.max(2, l.text.split('\n').length + 1))), maxlength: String(ENTRY_MAX), 'aria-label': 'Change this entry' });
        input.value = l.text;
        const save = el('button', { class: 'btn primary', type: 'button', text: 'Save' });
        const cancel = el('button', { class: 'btn quiet', type: 'button', text: 'Cancel' });
        save.addEventListener('click', () => act({ action: 'edit', id: l.id, text: input.value, was: l.text }));
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save.click();
          }
          // Escape leaves the line as it was; it does not close the window around it.
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancel.click();
          }
        });
        cancel.addEventListener('click', () => draw(lines));
        row.replaceChildren(el('span', { class: 'nb-edit' }, input, save, cancel));
        input.focus();
      });
      // Deleted at once, with Undo (it puts the line back, at the end).
      del.addEventListener('click', async () => {
        if (!(await act({ action: 'delete', id: l.id }))) return;
        undo.hidden = false;
        undo.replaceChildren(`Deleted: "${l.text.length > 60 ? `${l.text.slice(0, 60)}…` : l.text}" `, el('button', { class: 'link', type: 'button', text: 'Undo', onclick: async () => {
          undo.hidden = true;
          await act({ action: 'add', text: l.text, from: l.from, group: l.group });
        } }));
      });
      list.append(row);
    }
  };
  async function act(body) {
    say(null);
    try {
      draw((await memApi({ scope, ...body })).lines);
      return true;
    } catch (e) {
      if (!e.quiet) say(e.message);
      return false;
    }
  }
  const add = el('textarea', { rows: '2', maxlength: String(ENTRY_MAX), placeholder: 'A fact to keep (Ctrl+Enter adds it)', 'aria-label': `Add an entry to ${title}` });
  add.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  const addBtn = el('button', { class: 'btn', type: 'submit', text: 'Add' });
  const form = el('form', { class: 'nb-add' }, add, addBtn);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    // Add with the box empty: the box takes the keyboard, so the press does not look dead.
    if (!add.value.trim()) return add.focus();
    if (await act({ action: 'add', text: add.value })) add.value = '';
  });
  box.append(list, undo, fault, form);
  try {
    draw((await api(`/api/memory?scope=${encodeURIComponent(scope)}`)).lines);
  } catch (e) {
    say(e.message);
  }
  return box;
}
app.notebookList = notebookList;

const TEAM_HINT = 'Everyone on the team reads these, in every chat and every job step.';

/**
 * "What ... reads" for a chat named by its id (or, with no messages yet, the person it is with): never the chat another
 * window opened last, so Pin puts a line in this chat's notebook.
 */
const readingAddress = (chatId, who) => `/api/memory/reading?chat=${encodeURIComponent(chatId ?? '')}&who=${encodeURIComponent(who ?? '')}${typeof plainWho === 'function' ? `&plain=${encodeURIComponent(plainWho())}` : ''}`;

/** The chat's notebooks: the person's own (a hire) and the team's. */
async function openNotebook() {
  memFault(null);
  let r;
  try {
    r = await api(readingAddress(app.chatId, app.chatWho?.()));
  } catch (e) {
    memFault(e.message);
    $('#notebook-body').replaceChildren();
    if (!memDlg.open) memDlg.showModal();
    return;
  }
  const parts = [];
  // This chat's own log first, where the chat keeps one (chatlog.js).
  const chatLog = await app.chatLogSection?.(r);
  if (chatLog) parts.push(chatLog);
  if (r.scope !== 'team') parts.push(await notebookList(r.scope, `${r.name}'s memory`, `Only ${r.name} reads these, in chats and in the job steps ${r.name} runs.`));
  parts.push(await notebookList('team', 'Team memory', TEAM_HINT));
  $('#notebook-body').replaceChildren(...parts);
  drawReading(r);
  if (!memDlg.open) memDlg.showModal();
}

/**
 * "What they read for the next answer", folded at the foot of Memory: the parts of the next turn, in the order they are
 * filled, with their sizes (it was its own Reading window; Memory is where people look).
 */
function drawReading(r) {
  $('#reading-fault').hidden = true;
  $('#reading-title').textContent = `What ${r.name} reads for the next answer`;
  const n = x => Number(x).toLocaleString();
  const rows = r.parts.map((p, i) => el('tr', {},
    el('td', { text: `${i + 1}. ${p.label}` }),
    el('td', { class: 'num', text: p.chars ? `${n(p.chars)} (~${n(p.tokens)} tokens)` : '0' }),
    el('td', { text: `${p.state === 'whole' ? 'Sent whole' : p.state === 'cut' ? 'Part of it' : p.state === 'none' ? 'Nothing to send' : 'Left out: no room'}${p.note ? ` · ${p.note}` : ''}` })));
  const pct = Math.min(100, Math.round((r.used / r.room) * 100));
  $('#reading-body').replaceChildren(
    el('p', { text: `${r.name} reads this fresh for every answer; nothing is kept inside the model between answers. The context is ${n(r.ctx)} tokens: ${n(r.answerTokens)} are kept for the answer, the rest holds the parts below, filled in this order until it is full.` }),
    el('p', { class: 'hint', text: r.measured ? `Measured on the last answer${r.model ? `, ${r.model}` : ''}. The new message is not counted until you send it.` : 'No answer in this chat since TOMLIN started, so this uses the context set for their model here. The new message is not counted until you send it.' }),
    el('div', { class: 'rd-bar', role: 'img', 'aria-label': `${pct} per cent of the room used` }, el('div', { class: 'rd-fill' })),
    el('p', { class: 'hint', text: `${n(r.used)} of ${n(r.room)} characters used (${pct}%).` }),
    el('div', { class: 'rd-wrap' }, el('table', { class: 'rd-table' }, el('thead', {}, el('tr', {}, el('th', { text: 'Part' }), el('th', { text: 'Characters' }), el('th', { text: 'Sent' }))), el('tbody', {}, ...rows))));
  $('#reading-body .rd-fill').style.width = `${pct}%`;
}

$('#notebook-open').addEventListener('click', openNotebook);

/** The notebook buttons only for chats that read notebooks (the manager and hires on this PC). */
const before = app.onChat;
let openWho = '';
// No chat made yet ("New chat" with someone, after a restart too): the person in the head (chats.js), so the first
// message names who it is for and is not refused as naming nobody.
const headWho = app.chatWho;
app.chatWho = () => openWho || String(headWho?.() ?? '');
app.onChat = chat => {
  // The notebook buttons first: the chat head after it can still be waiting for faces.js at page load.
  try {
    notebookButtons(chat);
  } finally {
    before?.(chat);
  }
};
let openChatId = '';
function notebookButtons(chat) {
  const who = String(chat?.who ?? '');
  // Another chat with the same person counts too: each chat has its own log and its own layers tick.
  const changed = who !== openWho || !chat || (chat?.id ?? '') !== openChatId;
  openWho = who;
  openChatId = chat?.id ?? '';
  const off = who.startsWith('node:');
  $('#notebook-open').hidden = off;
  if (off) app.chatLayers?.(null);
  // The button says whose: "What Theo remembers". Add to log and Find show where this chat keeps a log.
  if (!off && changed) api(readingAddress(chat?.id, who)).then(r => {
    $('#notebook-open').title = `What ${r.name} and the team remember: see, change or delete each line`;
    if ((app.chatId ?? '') === (r.chat ?? '')) app.chatLayers?.(r.layers);
  }).catch(() => undefined);
}

/** The most an entry keeps (src/memory.ts ENTRY_MAX). */
const ENTRY_MAX = 4000;

/**
 * A change to a notebook. An entry that looks like orders for a model (src/promptscan.ts, as a chat message is read)
 * comes back 409 with what was found: the same warning as a chat message's, and it is kept only when he ticks and goes on.
 */
async function memApi(body) {
  try {
    return await api('/api/memory', body);
  } catch (e) {
    if (e.status !== 409 || !e.data?.scan) throw e;
    const go = await app.scanWarn(e.data.scan, e.data.text ?? String(body.text ?? ''), { title: 'This memory entry looks risky', hint: 'Memory is sent to the model on every turn, so words like these would act on every answer, not only one. Keep it only if you wrote it yourself and know what it does.' });
    if (!go) throw Object.assign(new Error('Not kept.'), { quiet: true });
    return api('/api/memory', { ...body, scanOk: true });
  }
}
app.memApi = memApi;

/** A Pin under a message: its text (up to 4,000 characters, his lines kept) becomes an entry in this chat's notebook. */
app.pinButton = text => {
  const who = String(app.chatWho?.() ?? '');
  if (who.startsWith('node:') || !text?.trim()) return null;
  const b = el('button', { class: 'link pin icon-act', type: 'button', title: 'Pin: keep this in Memory (you can change it there)', 'aria-label': 'Pin: keep this in Memory' }, app.lineIcon(...app.PIN_ICON));
  b.addEventListener('click', async () => {
    try {
      const whole = text.trim();
      // Longer than an entry keeps: asked once, never cut without a word.
      if (whole.length > ENTRY_MAX) {
        const box = el('div', { class: 'pin-ask', hidden: true });
        b.after(box);
        const ok = await askHere(box, `This message has ${whole.length.toLocaleString()} characters; a memory entry keeps ${ENTRY_MAX.toLocaleString()}. Keep the first ${ENTRY_MAX.toLocaleString()} characters?`, 'Keep the first part', 'Cancel', false);
        box.remove();
        if (!ok) return;
      }
      const r = await api(readingAddress(app.chatId, app.chatWho?.()));
      await memApi({ action: 'add', scope: r.scope, text: whole.slice(0, ENTRY_MAX), from: 'pin' });
      b.replaceWith(el('span', { class: 'pin-done', text: `Pinned in ${r.book}${whole.length > ENTRY_MAX ? ` (its first ${ENTRY_MAX.toLocaleString()} characters: change it there)` : ''}` }));
    } catch (e) {
      if (!e.quiet) app.chatNote?.(e.message);
    }
  });
  return b;
};

/**
 * A model's suggestion after an answer. It waits in the notebook's Inbox (src/server/chat.ts; never sent to a model):
 * Keep moves it into the notebook, Drop takes it out, and Inbox opens the editor there. One already kept word for word
 * says nothing. With no Inbox place (the notebook full): Save / No, as before.
 */
app.offerMemory = (data, out) => {
  if (!data.suggest || data.suggestKept) return;
  const done = (text, cls = 'hint') => box.replaceChildren(el('span', { class: cls, text }));
  const run = async (body, said) => {
    try {
      await memApi({ scope: data.scope, ...body });
      done(said);
    } catch (e) {
      if (!e.quiet) done(e.message, 'fault');
    }
  };
  const box = el('div', { class: 'mem-suggest' });
  if (data.suggestId) {
    box.append(el('span', { text: `Suggested for ${data.book}, waiting in its Inbox: "${data.suggest}"` }),
      el('button', { class: 'btn', type: 'button', text: 'Keep', onclick: () => run({ action: 'edit', id: data.suggestId, group: 'Notes' }, `Kept in ${data.book}.`) }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Drop', onclick: () => run({ action: 'delete', id: data.suggestId }, 'Dropped.') }),
      el('button', { class: 'link', type: 'button', text: 'Inbox', title: 'Open the memory editor at the Inbox', onclick: () => app.openMemory?.(data.scope, { inbox: true, back: 'chat' }) }));
  } else {
    box.append(el('span', { text: `Keep this in ${data.book}? "${data.suggest}"` }),
      el('button', { class: 'btn', type: 'button', text: 'Save', onclick: () => run({ action: 'add', text: data.suggest, from: 'suggested' }, `Saved in ${data.book}.`) }),
      el('button', { class: 'btn quiet', type: 'button', text: 'No', onclick: () => box.remove() }));
  }
  out.after(box);
};
