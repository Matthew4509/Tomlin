// A chat's log and Find in this chat (src/layers.ts on the server), for a chat of 16K context or more: "Add to log"
// under a message, the log in Memory (each line seen, changed, ticked Done or deleted there), the chat's "Short, mid and
// long memory" tick, and Find, which brings an older message back into the chat word for word. Lines are his: a model
// never writes one. Loaded after memory.js; its names stay inside this block (the page's scripts share one scope).
'use strict';
{
  const num = x => Number(x).toLocaleString('en-GB');
  const aboutMin = s => (!(s > 0) ? '' : s < 60 ? 'under a minute' : `about ${Math.max(1, Math.round(s / 60))} min`);
  const KINDS = { decision: 'Decision', todo: 'To do', learned: 'Learned', fact: 'Name or number' };
  /** A list with ticks. */
  const LOG_ICON = ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M3 6l1.5 1.5L7 5', 'M3 12l1.5 1.5L7 11', 'M3 18l1.5 1.5L7 17'];
  const kindPick = (value = 'decision') => {
    const s = el('select', { 'aria-label': 'Kind of line' }, ...Object.entries(KINDS).map(([v, t]) => el('option', { value: v, text: t })));
    s.value = value;
    return s;
  };

  // ---- Where the log is read: Add to log and Find show only there ----
  /** The open chat's layers (from "What X reads"), null for a chat that keeps no log here. */
  let layers = null;
  app.chatLayers = l => {
    layers = l ?? null;
    const on = !!(layers && layers.can && layers.on);
    $('#chat-log').classList.toggle('no-log', !on);
    $('#chat-find-open').hidden = !on;
  };
  app.chatLayers(null);

  // ---- Add to log, under a message: opens a window with the line to keep (the words selected in it, or its start) ----
  const addDlg = $('#log-add');
  const addFault = text => {
    $('#log-add-fault').hidden = !text;
    $('#log-add-fault').textContent = text ?? '';
  };
  let addDone = null;
  app.logButton = text => {
    const who = String(app.chatWho?.() ?? '');
    if (who.startsWith('node:') || !text?.trim()) return null;
    const b = el('button', { class: 'link pin icon-act log-btn', type: 'button', title: "Add to log: keep a decision, a to do or a fact from this in the chat's log", 'aria-label': 'Add to log' }, app.lineIcon(...LOG_ICON));
    // The words selected in this message, taken before the press (a click on the button can end the selection).
    let picked = '';
    b.addEventListener('pointerdown', () => {
      const sel = window.getSelection();
      const msg = b.closest('.msg');
      picked = sel && msg && !sel.isCollapsed && msg.contains(sel.anchorNode) && msg.contains(sel.focusNode) ? sel.toString() : '';
    });
    b.addEventListener('click', () => {
      const words = (picked || text).replace(/\s+/g, ' ').trim();
      picked = '';
      addFault(null);
      $('#log-add-kind').value = 'decision';
      $('#log-add-text').value = words.slice(0, 300);
      $('#log-add-cut').hidden = words.length <= 300;
      addDone = () => b.replaceWith(el('span', { class: 'pin-done', text: 'In the chat log (Memory shows it)' }));
      addDlg.showModal();
      $('#log-add-text').focus();
    });
    return b;
  };
  $('#log-add-form').addEventListener('submit', async e => {
    e.preventDefault();
    addFault(null);
    try {
      await api('/api/chat/log', { chatId: app.chatId ?? '', action: 'add', kind: $('#log-add-kind').value, text: $('#log-add-text').value });
      addDone?.();
      addDone = null;
      addDlg.close();
      if (layers) layers.waiting = true;
    } catch (err) {
      addFault(err.message);
    }
  });
  $('#log-add-cancel').addEventListener('click', () => addDlg.close());

  // ---- The log in Memory ----
  /** What a fold reads here, in words: "about 4,600 tokens: about 4 min". */
  const foldCost = l => `about ${num(l.foldTokens ?? 0)} tokens${l.foldSeconds ? `: ${aboutMin(l.foldSeconds)}` : ''}`;

  /** This chat's log, its tick and what a fold costs, at the top of Memory; null where the chat keeps no log here. */
  app.chatLogSection = async r => {
    app.chatLayers(r.layers);
    const l = r.layers;
    if (!l || l.plain || !r.chat) return null;
    const box = el('section', { class: 'nb chat-logbox' }, el('h3', { text: "This chat's log" }));
    if (!l.can) {
      box.append(el('p', { class: 'hint', text: `A chat log, and Find in this chat, come with a context of ${num(l.min)} tokens or more (Model settings, Context). This chat runs with ${num(r.ctx)}.` }));
      return box;
    }
    const tick = el('input', { type: 'checkbox', id: 'layers-on' });
    tick.checked = !!l.on;
    const about = el('p', { class: 'hint' });
    const fault = el('p', { class: 'fault', hidden: true });
    const say = t => {
      fault.hidden = !t;
      fault.textContent = t ?? '';
    };
    const drawAbout = () => {
      about.textContent = !l.on
        ? 'Off: this chat works as a smaller one does. Older messages are only summarised, and a handoff is offered when it gets large. The log below is kept, but not read while this is off.'
        : `The latest messages are sent word for word, up to about ${num(l.shortTokens)} tokens. When they pass that, the oldest third stops being sent (a fold), and this log keeps what matters. ${l.older ? `${num(l.older)} older message${l.older === 1 ? ' is' : 's are'} out now: Find in this chat brings one back.` : 'Nothing has moved out yet.'} A fold reads ${foldCost(l)} here${l.readPerSecond ? '' : ' (its time shows once this model has answered here)'}; the fold wait (${l.foldMinutes} min) is in Model settings.`;
    };
    drawAbout();
    tick.addEventListener('change', async () => {
      say(null);
      try {
        await api('/api/chat/layers', { chatId: r.chat, on: tick.checked });
        // Built again from the server: what it reads now, and the tick's own facts.
        $('#notebook').close();
        $('#notebook-open').click();
      } catch (e) {
        tick.checked = !tick.checked;
        say(e.message);
      }
    });
    const waiting = el('p', { class: 'hint chat-log-wait', role: 'status', hidden: true });
    const drawWaiting = () => {
      waiting.hidden = !(l.on && l.waiting);
      const now = el('button', { class: 'link', type: 'button', text: 'Send them now' });
      now.addEventListener('click', async () => {
        try {
          await api('/api/chat/fold', { chatId: r.chat });
          waiting.replaceChildren(`The next answer reads the log as it is now: ${foldCost(l)}.`);
        } catch (e) {
          say(e.message);
        }
      });
      waiting.replaceChildren(`Your changes since the last fold go in at the next one, so the answers in between are not slowed. `, now, ` (one fold's reading, ${foldCost(l)})`);
    };
    const list = el('ul', { class: 'nb-lines' });
    const undo = el('p', { class: 'hint nb-undo', role: 'status', hidden: true });
    async function act(body) {
      say(null);
      try {
        const got = await api('/api/chat/log', { chatId: r.chat, ...body });
        draw(got.lines);
        l.waiting = true;
        drawWaiting();
        return got;
      } catch (e) {
        say(e.message);
        return null;
      }
    }
    function draw(lines) {
      list.replaceChildren();
      if (!lines.length) list.append(el('li', { class: 'hint nb-empty', text: 'Nothing in the log yet: press "Add to log" under a message, or add a line here.' }));
      for (const x of lines) {
        const text = el('span', { class: 'nb-text', text: x.text });
        const kind = el('span', { class: 'nb-from', text: x.kind === 'todo' && x.done ? 'To do, done' : KINDS[x.kind] ?? x.kind });
        const acts = el('span', { class: 'nb-acts' });
        if (x.kind === 'todo') {
          const done = el('input', { type: 'checkbox', 'aria-label': `Done: ${x.text}` });
          done.checked = !!x.done;
          done.addEventListener('change', () => act({ action: 'edit', id: x.id, done: done.checked }));
          acts.append(el('label', { class: 'check' }, done, ' Done'));
        }
        const edit = el('button', { class: 'link', type: 'button', text: 'Edit' });
        const toMemory = el('button', { class: 'link', type: 'button', text: 'To memory', title: `Move this line into ${r.book}: read in every chat, not only this one` });
        const del = el('button', { class: 'link', type: 'button', text: 'Delete' });
        acts.append(edit, toMemory, del);
        const row = el('li', { class: 'nb-line' }, el('span', { class: 'nb-body' }, text, kind), acts);
        edit.addEventListener('click', () => {
          const input = el('input', { type: 'text', maxlength: '300', value: x.text, 'aria-label': 'Change this line' });
          const pick = kindPick(x.kind);
          const save = el('button', { class: 'btn primary', type: 'button', text: 'Save' });
          const cancel = el('button', { class: 'btn quiet', type: 'button', text: 'Cancel' });
          save.addEventListener('click', () => act({ action: 'edit', id: x.id, text: input.value, kind: pick.value }));
          input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save.click();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancel.click();
            }
          });
          cancel.addEventListener('click', () => draw(lines));
          row.replaceChildren(el('span', { class: 'nb-edit' }, pick, input, save, cancel));
          input.focus();
        });
        toMemory.addEventListener('click', async () => {
          say(null);
          try {
            await api('/api/memory', { action: 'add', scope: r.scope, text: x.text, from: 'owner' });
          } catch (e) {
            return say(e.message);
          }
          // Drawn again from the server, so the line shows in its new list.
          if (await act({ action: 'delete', id: x.id })) {
            $('#notebook').close();
            $('#notebook-open').click();
          }
        });
        // Deleted at once, with Undo (it puts the line back, at the end).
        del.addEventListener('click', async () => {
          if (!(await act({ action: 'delete', id: x.id }))) return;
          undo.hidden = false;
          undo.replaceChildren(`Deleted: "${x.text.length > 60 ? `${x.text.slice(0, 60)}…` : x.text}" `, el('button', { class: 'link', type: 'button', text: 'Undo', onclick: async () => {
            undo.hidden = true;
            await act({ action: 'add', kind: x.kind, text: x.text });
          } }));
        });
        list.append(row);
      }
    }
    const pick = kindPick();
    const add = el('input', { type: 'text', maxlength: '300', placeholder: 'A decision, to do or fact, in one line', 'aria-label': "Add a line to this chat's log" });
    const form = el('form', { class: 'nb-add' }, pick, add, el('button', { class: 'btn', type: 'submit', text: 'Add' }));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (add.value.trim() && (await act({ action: 'add', kind: pick.value, text: add.value }))) add.value = '';
    });
    const fresh = el('button', { class: 'btn quiet', type: 'button', text: 'Start a fresh chat from this' });
    fresh.addEventListener('click', () => {
      $('#notebook').close();
      app.writeHandoff?.();
    });
    box.append(el('label', { class: 'check' }, tick, ' Short, mid and long memory in this chat'), about, waiting, list, undo, fault, form,
      el('div', { class: 'team-actions' }, fresh), el('p', { class: 'hint', text: 'A fresh chat starts from a handoff the model writes now, with this log; this chat stays as it is.' }));
    try {
      draw((await api(`/api/chat/log?chat=${encodeURIComponent(r.chat)}`)).lines);
    } catch (e) {
      say(e.message);
    }
    drawWaiting();
    return box;
  };

  // ---- Find in this chat: an older message brought back, word for word ----
  const findDlg = $('#chat-find');
  const findFault = text => {
    $('#chat-find-fault').hidden = !text;
    $('#chat-find-fault').textContent = text ?? '';
  };
  async function runFind(q) {
    findFault(null);
    const list = $('#chat-find-list');
    list.replaceChildren();
    if (!q.trim()) return;
    let r;
    try {
      r = await api(`/api/chat/find?chat=${encodeURIComponent(app.chatId ?? '')}&q=${encodeURIComponent(q)}`);
    } catch (e) {
      return findFault(e.message);
    }
    if (!r.older) return list.append(el('p', { class: 'hint', text: 'Nothing has moved out of this chat yet: every message is still sent word for word.' }));
    if (!r.found.length) return list.append(el('p', { class: 'hint', text: `None of the ${num(r.older)} older messages has those words. Try other words.` }));
    const them = app.chatPerson?.name ?? 'They';
    list.append(el('ul', { class: 'nb-lines' }, ...r.found.map(f => {
      const back = el('button', { class: 'btn', type: 'button', text: 'Bring it back' });
      back.addEventListener('click', async () => {
        findFault(null);
        try {
          await api('/api/chat/recall', { chatId: app.chatId ?? '', at: f.at, role: f.role });
        } catch (e) {
          return findFault(e.message);
        }
        findDlg.close();
        try {
          showChat(await api(chatUrl(app.chatId ?? '')));
        } catch {
          // The line is saved; the chat shows it at the next reload.
        }
        app.chatNote('Brought back into the chat: it is read with your next message.');
      });
      const when = f.at ? new Date(f.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      return el('li', { class: 'nb-line' }, el('span', { class: 'nb-body' }, el('span', { class: 'nb-from', text: `${f.role === 'user' ? 'You' : them}${when ? ` · ${when}` : ''}` }), el('span', { class: 'nb-text find-text', text: f.text })), el('span', { class: 'nb-acts' }, back));
    })));
  }
  /** Opens Find with these words; false where this chat keeps no log (then "find: ..." is sent as a message). */
  app.findInChat = q => {
    if (!(layers && layers.can && layers.on) || !app.chatId) return false;
    findFault(null);
    $('#chat-find-q').value = q ?? '';
    $('#chat-find-list').replaceChildren();
    findDlg.showModal();
    $('#chat-find-q').focus();
    if (q?.trim()) runFind(q);
    return true;
  };
  $('#chat-find-form').addEventListener('submit', e => {
    e.preventDefault();
    runFind($('#chat-find-q').value);
  });
  $('#chat-find-open').addEventListener('click', () => app.findInChat(''));
}
