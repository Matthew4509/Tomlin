// The chat's right panel, under Subjects: a scratch pad (kept as you type) and a snippet library, Snippets (global):
// prompts or notes to copy or put into the message box again, listed in the Browse window. The same in every chat; no model reads them (src/notes.ts keeps data/notes.json).
// Everything here sits in one block: page scripts share one global scope, so no name of this file can clash.
'use strict';
{
  const pad = $('#scratch-text');
  const padState = $('#scratch-state');
  const newBox = $('#snippet-new');
  const note = $('#snippet-note');
  const notes = { data: null, loading: false };
  let padDirty = false;
  let padTimer = 0;
  // The words this window's pad started from (as last loaded or saved): sent with each save, so a save never goes
  // over words another window saved meanwhile. Null when not loaded.
  let padBase = null;
  const clash = $('#scratch-clash');

  // ---- Loading: at the start, and again on the next status tick if it failed (the app lock was up, or the server) ----
  async function load() {
    if (notes.loading) return;
    notes.loading = true;
    try {
      notes.data = await api('/api/notes');
      if (!padDirty && clash.hidden) { pad.value = notes.data.scratch; padBase = notes.data.scratch; }
      drawSnippets();
    } catch {
      notes.data = null;
    }
    notes.loading = false;
  }
  app.onStatus.push(() => {
    if (!notes.data) load();
  });
  load();
  // Back to this window: another may have changed the pad (or the snippets) meanwhile.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !padDirty) load();
  });

  // ---- Scratch pad: saved a moment after typing stops, when the box is left, and when the page closes ----
  const say = (text, fault = false) => {
    padState.textContent = text;
    padState.classList.toggle('fault-line', fault);
  };
  // While Keep mine / Use the other window's is showing, nothing is saved by itself (leaving the box would send the
  // same refused save again, and its answer could come back after his choice): only Keep mine saves.
  let padSeq = 0;
  async function savePad(mine = false) {
    clearTimeout(padTimer);
    if (!padDirty || (!clash.hidden && mine !== true)) return;
    padDirty = false;
    const seq = ++padSeq;
    const words = pad.value;
    try {
      notes.data = { ...(await api('/api/notes', { scratch: words, ...(padBase !== null && mine !== true ? { was: padBase } : {}) })), id: undefined };
      if (seq !== padSeq) return;
      padBase = words;
      clash.hidden = true;
      say(padDirty ? 'Saving…' : 'Saved');
    } catch (e) {
      if (seq !== padSeq) return;
      padDirty = true;
      // Another window saved the pad meanwhile: these words stay here, and he picks which to keep.
      if (e.status === 409) {
        $('#scratch-clash-said').textContent = e.message;
        clash.hidden = false;
        say('Not saved', true);
        return;
      }
      say(`Not saved: ${e.message}`, true);
    }
  }
  $('#scratch-mine').addEventListener('click', () => {
    padDirty = true;
    savePad(true);
  });
  $('#scratch-theirs').addEventListener('click', async () => {
    clearTimeout(padTimer);
    padSeq++;
    try {
      notes.data = await api('/api/notes');
      pad.value = notes.data.scratch;
      padBase = notes.data.scratch;
      padDirty = false;
      clash.hidden = true;
      drawSnippets();
      say('The other window\'s words are here now.');
    } catch (e) {
      say(`Not loaded: ${e.message}`, true);
    }
    pad.focus();
  });
  pad.addEventListener('input', () => {
    padDirty = true;
    say(clash.hidden ? 'Saving…' : 'Not saved', !clash.hidden);
    clearTimeout(padTimer);
    padTimer = setTimeout(() => savePad(), 700);
  });
  pad.addEventListener('blur', () => savePad());
  addEventListener('pagehide', () => {
    if (!padDirty) return;
    fetch('/api/notes', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scratch: pad.value, ...(padBase !== null ? { was: padBase } : {}) }) }).catch(() => undefined);
  });

  // ---- Save note: the scratch pad as a file, in the notes folder or a project's admin notes (src/folders.ts) ----
  const where = $('#note-where');
  const noteSaid = $('#note-said');
  /** The projects to pick from, read again each time the list is opened (one may have been made meanwhile). */
  function drawWhere() {
    const was = where.value;
    const projects = typeof chatUi === 'undefined' ? [] : chatUi.projects;
    where.replaceChildren(el('option', { value: '', text: 'Notes' }), ...projects.map(p => el('option', { value: p.id, text: `${p.name.length > 40 ? `${p.name.slice(0, 40)}…` : p.name}: admin notes` })));
    where.value = projects.some(p => p.id === was) ? was : '';
  }
  where.addEventListener('focus', drawWhere);
  where.addEventListener('pointerdown', drawWhere);
  $('#note-save').addEventListener('click', async () => {
    noteSaid.hidden = false;
    noteSaid.classList.remove('fault-line');
    try {
      const r = await api('/api/notes/save', { text: pad.value, project: where.value });
      noteSaid.textContent = `Saved in ${r.where} as ${r.path.split('/').pop()}.`;
    } catch (e) {
      noteSaid.textContent = e.message;
      noteSaid.classList.add('fault-line');
    }
  });

  // ---- Snippets (global): saved here, read and copied in Browse; the save icon on the message box saves a prompt ----
  const browseDlg = $('#snippets-dlg');
  const browseNote = $('#snippets-dlg-note');
  const groups = $('#snippet-groups');
  const find = $('#snippets-find');
  let undoTimer = 0;
  /** A line under the right panel's Save, or (`where`) in the Browse window. */
  function tell(text, fault = false, where = note, ...more) {
    clearTimeout(undoTimer);
    where.replaceChildren(text, ...more);
    where.classList.toggle('fault', fault);
    where.hidden = !text;
  }

  async function act(body) {
    const before = new Set((notes.data?.snippets ?? []).map(s => s.id));
    const r = await api('/api/notes', body);
    notes.data = r;
    drawSnippets();
    return { id: r.id, existed: !!r.id && before.has(r.id) };
  }

  $('#snippet-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!newBox.value.trim()) return tell('Nothing to save: type the prompt or note first, then press Save.', true);
    try {
      const r = await act({ add: newBox.value });
      tell(r.existed ? 'Already saved: moved to the top.' : 'Saved.');
      newBox.value = '';
    } catch (err) {
      tell(err.message, true);
    }
  });
  // Ctrl+Enter in the snippet box saves it (Enter alone is a new line).
  newBox.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $('#snippet-form').requestSubmit();
    }
  });

  /** Into the message box: on its own if the box is empty, else on a new line after what is there. */
  function use(text) {
    const box = $('#chat-input');
    box.value = box.value.trim() ? `${box.value.replace(/\s+$/, '')}\n${text}` : text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    browseDlg.close();
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }

  async function remove(s) {
    const at = notes.data.snippets.findIndex(x => x.id === s.id);
    try {
      await act({ remove: s.id });
    } catch (e) {
      return tell(e.message, true, browseNote);
    }
    const first = s.text.length > 40 ? `${s.text.slice(0, 40)}…` : s.text;
    const undo = el('button', { class: 'link', type: 'button', text: 'Undo' });
    undo.addEventListener('click', async () => {
      try {
        await act({ restore: s, at });
        tell('Put back.', false, browseNote);
      } catch (e) {
        tell(e.message, true, browseNote);
      }
    });
    tell(`Deleted "${first}". `, false, browseNote, undo);
    undoTimer = setTimeout(() => {
      if (browseNote.contains(undo)) tell('', false, browseNote);
    }, 10000);
  }

  /** One press copies it; the button says Copied for two seconds. */
  function copyNow(text) {
    const b = el('button', { class: 'btn primary snippet-copy-big', type: 'button', text: 'Copy', title: 'Copy this snippet' });
    let timer = 0;
    b.addEventListener('click', async () => {
      const ok = await app.copyText(text);
      b.textContent = ok ? 'Copied' : 'Select and press Ctrl+C';
      clearTimeout(timer);
      timer = setTimeout(() => {
        b.textContent = 'Copy';
      }, 2000);
    });
    return b;
  }

  /** The right panel shows only how many there are; Browse lists them all, by subject, newest first. */
  function drawSnippets() {
    const all = notes.data?.snippets ?? [];
    $('#snippets-count').textContent = all.length ? `(${all.length})` : '';
    if (browseDlg.open) drawBrowse();
  }

  function drawBrowse() {
    const all = notes.data?.snippets ?? [];
    const q = find.value.trim().toLowerCase();
    const shown = q ? all.filter(s => `${s.subject} ${s.text}`.toLowerCase().includes(q)) : all;
    if (!shown.length) {
      groups.replaceChildren(el('p', { class: 'hint snippet-empty', text: all.length ? 'None match those words.' : 'No snippets yet. Type one under Snippets (global) and press Save, or press the save icon in the corner of the message box.' }));
      return;
    }
    // Subjects in the order of their newest snippet; snippets with no subject last.
    const bySubject = new Map();
    for (const s of shown) {
      const k = s.subject || '';
      if (!bySubject.has(k)) bySubject.set(k, []);
      bySubject.get(k).push(s);
    }
    const keys = [...bySubject.keys()].sort((a, b) => (a === '') - (b === ''));
    const named = keys.some(k => k);
    groups.replaceChildren(...keys.map(k => el('section', {},
      named ? el('h3', { text: k || 'No subject' }) : null,
      el('ul', { class: 'snippet-list' }, ...bySubject.get(k).map(s => {
        const words = el('p', { class: 'snippet-text', text: s.text, title: s.text.length > 200 ? 'Press to see all of it' : '' });
        words.addEventListener('click', () => words.classList.toggle('open'));
        return el('li', { class: 'snippet' }, words,
          el('div', { class: 'snippet-acts' },
            copyNow(s.text),
            el('button', { class: 'link', type: 'button', text: 'Use', title: 'Puts it into the message box (after anything typed there)', onclick: () => use(s.text) }),
            el('button', { class: 'link', type: 'button', text: 'Delete', onclick: () => remove(s) })));
      })))));
  }

  $('#snippet-browse').addEventListener('click', () => {
    tell('', false, browseNote);
    find.value = '';
    drawBrowse();
    browseDlg.showModal();
  });
  find.addEventListener('input', drawBrowse);

  // ---- Save to prompts (global): the save icon in the corner of the message box ----
  const saveDlg = $('#prompt-save-dlg');
  const saveFault = $('#prompt-save-fault');
  $('#prompt-save').addEventListener('click', () => {
    saveFault.hidden = true;
    $('#prompt-save-text').value = $('#chat-input').value;
    $('#prompt-save-subject').value = '';
    const subjects = [...new Set((notes.data?.snippets ?? []).map(s => s.subject).filter(Boolean))];
    $('#prompt-subjects').replaceChildren(...subjects.map(s => el('option', { value: s })));
    saveDlg.showModal();
    ($('#prompt-save-text').value.trim() ? $('#prompt-save-subject') : $('#prompt-save-text')).focus();
  });
  $('#prompt-save-cancel').addEventListener('click', () => saveDlg.close());
  $('#prompt-save-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await act({ add: $('#prompt-save-text').value, subject: $('#prompt-save-subject').value });
      saveDlg.close();
      tell(r.existed ? 'Already saved: moved to the top.' : 'Saved to Snippets (global).');
    } catch (err) {
      saveFault.textContent = err.message;
      saveFault.hidden = false;
    }
  });

  // ---- The two folds: open on a wide screen (unless he closed one), closed on a narrow one, where the panel is above the chat ----
  const wide = matchMedia('(min-width: 901px)');
  const folds = [$('#scratch-fold'), $('#snippets-fold')];
  const kept = f => {
    try {
      return localStorage.getItem(`sm-fold-${f.dataset.fold}`);
    } catch {
      return null;
    }
  };
  function fit() {
    for (const f of folds) f.open = wide.matches && kept(f) !== 'closed';
  }
  for (const f of folds) {
    f.addEventListener('toggle', () => {
      if (!wide.matches) return;
      try {
        localStorage.setItem(`sm-fold-${f.dataset.fold}`, f.open ? 'open' : 'closed');
      } catch {
        // Private window or blocked storage: the fold still works, it is just not remembered.
      }
    });
  }
  wide.addEventListener('change', fit);
  fit();
}
