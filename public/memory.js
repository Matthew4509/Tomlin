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
  const draw = lines => {
    list.replaceChildren();
    if (!lines.length) list.append(el('li', { class: 'hint nb-empty', text: 'Nothing kept yet.' }));
    for (const l of lines) {
      const text = el('span', { class: 'nb-text', text: l.text });
      const from = el('span', { class: 'nb-from', text: l.from === 'pin' ? 'pinned' : l.from === 'suggested' ? 'suggested, you saved it' : 'you' });
      const edit = el('button', { class: 'link', type: 'button', text: 'Edit' });
      const del = el('button', { class: 'link', type: 'button', text: 'Delete' });
      const row = el('li', { class: 'nb-line' }, el('span', { class: 'nb-body' }, text, from), el('span', { class: 'nb-acts' }, edit, del));
      edit.addEventListener('click', () => {
        const input = el('input', { type: 'text', maxlength: '300', value: l.text, 'aria-label': 'Change this line' });
        const save = el('button', { class: 'btn primary', type: 'button', text: 'Save' });
        const cancel = el('button', { class: 'btn quiet', type: 'button', text: 'Cancel' });
        save.addEventListener('click', () => act({ action: 'edit', id: l.id, text: input.value }));
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
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
          await act({ action: 'add', text: l.text, from: l.from });
        } }));
      });
      list.append(row);
    }
  };
  async function act(body) {
    say(null);
    try {
      draw((await api('/api/memory', { scope, ...body })).lines);
      return true;
    } catch (e) {
      say(e.message);
      return false;
    }
  }
  const add = el('input', { type: 'text', maxlength: '300', placeholder: 'A fact to keep, in one line', 'aria-label': `Add a line to ${title}` });
  const addBtn = el('button', { class: 'btn', type: 'submit', text: 'Add' });
  const form = el('form', { class: 'nb-add' }, add, addBtn);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (add.value.trim() && (await act({ action: 'add', text: add.value }))) add.value = '';
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
function notebookButtons(chat) {
  const who = String(chat?.who ?? '');
  const changed = who !== openWho || !chat;
  openWho = who;
  const off = who.startsWith('node:');
  $('#notebook-open').hidden = off;
  // The button says whose: "What Theo remembers".
  if (!off && changed) api(readingAddress(chat?.id, who)).then(r => ($('#notebook-open').title = `What ${r.name} and the team remember: see, change or delete each line`)).catch(() => undefined);
}

/** A Pin under a message: its text (first 300 characters) becomes a line in this chat's notebook. */
app.pinButton = text => {
  const who = String(app.chatWho?.() ?? '');
  if (who.startsWith('node:') || !text?.trim()) return null;
  const b = el('button', { class: 'link pin icon-act', type: 'button', title: 'Pin: keep this in Memory (you can change it there)', 'aria-label': 'Pin: keep this in Memory' }, app.lineIcon(...app.PIN_ICON));
  b.addEventListener('click', async () => {
    try {
      const r = await api(readingAddress(app.chatId, app.chatWho?.()));
      await api('/api/memory', { action: 'add', scope: r.scope, text, from: 'pin' });
      // A line keeps at most 300 characters: a longer message is cut, and says so.
      b.replaceWith(el('span', { class: 'pin-done', text: `Pinned in ${r.book}${text.trim().length > 300 ? ' (its first 300 characters: change the line there)' : ''}` }));
    } catch (e) {
      app.chatNote?.(e.message);
    }
  });
  return b;
};

/** A model's suggestion after an answer: Save writes it to the notebook; No drops it. */
app.offerMemory = (data, out) => {
  if (!data.suggest) return;
  const save = el('button', { class: 'btn', type: 'button', text: 'Save' });
  const no = el('button', { class: 'btn quiet', type: 'button', text: 'No' });
  const box = el('div', { class: 'mem-suggest' }, el('span', { text: `Keep this in ${data.book}? "${data.suggest}"` }), save, no);
  save.addEventListener('click', async () => {
    try {
      await api('/api/memory', { action: 'add', scope: data.scope, text: data.suggest, from: 'suggested' });
      box.replaceChildren(el('span', { class: 'hint', text: `Saved in ${data.book}.` }));
    } catch (e) {
      box.replaceChildren(el('span', { class: 'fault', text: e.message }));
    }
  });
  no.addEventListener('click', () => box.remove());
  out.after(box);
};
