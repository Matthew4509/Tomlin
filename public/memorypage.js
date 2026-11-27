// The memory editor, a page in the middle panel (src/memory.ts on the server; each notebook is a plain .md file in the
// data folder, src/notebookfile.ts). Left: the notebooks, the team's and each hire's, with how full each is. Middle:
// one notebook, as a List (entries in their groups: Edit, Move, Delete, drag to reorder) or as Text (the whole file in
// one box, read back by code before it is kept). Right: what the hire's model gets of it on the next answer. Top: Search
// in every notebook, Add entry, Add group, Open file (Notepad) and Open folder. The Inbox group holds a model's
// suggestions until the person keeps or drops them; a model never writes memory by itself.
// Loaded after memory.js (memApi, the scan warning) and faces.js (app.avatar); its names stay inside this block.
'use strict';
{
  const ENTRY_MAX = 4000;
  const INBOX = 'Inbox';
  const ALWAYS = 'Always send';
  const NOBODY = 'Nobody is hired yet: the team notebook is read by everyone you hire.';
  const NOBODY_READS = 'Nobody on the team reads memory yet (the Default role reads none): the team notebook is read by everyone else you hire.';
  const num = x => Number(x).toLocaleString('en-GB');
  const mp = { scope: 'team', who: 'manager', view: 'list', books: [], book: null, back: 'chat', opened: new Set(), undo: null, q: '', found: null, folder: '', mark: '', text: null, picked: new Set() };
  const page = $('#memory-page');
  const say = (t, bad = false) => {
    $('#memory-said').textContent = t ?? '';
    $('#memory-said').classList.toggle('fault', !!bad && !!t);
  };
  const ICONS = {
    add: ['M12 5v14', 'M5 12h14'],
    group: ['M3 7h7l2 2h9v10H3z'],
    list: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
    text: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
    file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M10 14l2 2 4-4'],
    folder: ['M3 7h7l2 2h9v10H3z', 'M12 13h6'],
  };
  const iconBtn = (icon, label, onclick, title) => el('button', { class: 'btn quiet mem-tool', type: 'button', title: title ?? label, onclick }, app.lineIcon(...ICONS[icon]), label);
  const whoOf = scope => (scope === 'team' ? 'manager' : scope);
  const fromWords = l => (l.from === 'pin' ? 'pinned' : l.from === 'suggested' ? (l.group === INBOX ? 'suggested by a model' : 'suggested, you kept it') : 'you');
  const when = at => {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  };
  /** A name asked for on the page (no browser pop-up): the text typed, or '' for Cancel. */
  const askText = (label, value = '') => new Promise(done => {
    const box = $('#memory-ask');
    const input = el('input', { type: 'text', maxlength: '80', 'aria-label': label });
    input.value = value;
    const end = v => {
      box.replaceChildren();
      box.hidden = true;
      done(v);
    };
    const form = el('form', { class: 'mem-ask-form' }, el('label', { class: 'field' }, el('span', { text: label }), input), el('button', { class: 'btn primary', type: 'submit', text: 'OK' }), el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => end('') }));
    form.addEventListener('submit', e => {
      e.preventDefault();
      end(input.value.trim());
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        end('');
      }
    });
    box.replaceChildren(form);
    box.hidden = false;
    input.focus();
    input.select();
  });
  const share = f => Math.max(f.entries / f.maxEntries, f.chars / f.maxChars) * 100;
  const pct = f => Math.min(100, Math.round(share(f)));
  /** How full, in words: "under 1%" for a little (1 entry of 200 is not "1% full"), else the rounded per cent. */
  const fullWords = f => (share(f) > 0 && share(f) < 1 ? 'under 1%' : `${pct(f)}%`);
  app.memFullWords = fullWords;

  // ---- Opening ----

  /**
   * Opens the editor at `scope` ('team' or 'staff:<id>'). `back`: the view Back goes to (the one it was opened from).
   * `mark`: an entry to bring into view (from Search). `inbox`: open at the Inbox group.
   */
  app.openMemory = async (scope = 'team', o = {}) => {
    for (const d of document.querySelectorAll('dialog[open]')) if (!d.classList.contains('as-page')) d.close();
    mp.back = o.back ?? (homeUi.view && homeUi.view !== 'memory' ? homeUi.view : mp.back);
    mp.view = 'list';
    mp.mark = o.mark ?? '';
    mp.text = null;
    say('');
    setView('memory');
    page.scrollTop = 0;
    await loadBooks();
    await pick(mp.books.some(b => b.scope === scope) ? scope : 'team');
    if (o.inbox) $('#memory-main .mem-group[data-group="Inbox"]')?.scrollIntoView({ block: 'start' });
  };

  async function loadBooks() {
    try {
      const r = await api('/api/memory/books');
      mp.books = r.books;
      mp.folder = r.folder;
    } catch (e) {
      say(e.message, true);
    }
    drawBooks();
  }

  async function pick(scope) {
    mp.scope = scope;
    mp.who = whoOf(scope);
    mp.picked.clear();
    drawBooks();
    await loadBook();
    loadGets();
  }

  async function loadBook() {
    try {
      mp.book = await api(`/api/memory?scope=${encodeURIComponent(mp.scope)}`);
    } catch (e) {
      mp.book = null;
      say(e.message, true);
    }
    drawMain();
  }

  /** After any change: the notebook as the server now has it, and the left side's counts. */
  function took(r) {
    if (r?.lines) mp.book = r;
    const b = mp.books.find(x => x.scope === mp.scope);
    if (b && r?.full) Object.assign(b, { full: r.full, inbox: r.lines.filter(l => l.group === INBOX).length, problems: r.problems.length });
    drawBooks();
    drawMain();
    loadGets();
  }

  async function change(body) {
    say('');
    try {
      took(await app.memApi({ scope: mp.scope, ...body }));
      return true;
    } catch (e) {
      if (!e.quiet) say(e.message, true);
      return false;
    }
  }

  // ---- Left: the notebooks ----

  function drawBooks() {
    const list = $('#memory-books');
    list.replaceChildren(...mp.books.map(b => {
      const row = el('button', { class: 'mem-book', type: 'button', 'aria-current': b.scope === mp.scope ? 'true' : false, onclick: () => pick(b.scope) },
        app.avatar ? app.avatar(whoOf(b.scope), b.name.slice(0, 2).toUpperCase()) : '',
        el('span', { class: 'mem-book-text' },
          el('span', { class: 'mem-book-name', text: b.name }),
          el('span', { class: 'mem-book-sub', text: `${b.scope === 'team' ? 'Read by everyone' : b.role}${b.plain ? ' (Default role: reads no memory)' : ''}` }),
          el('span', { class: 'mem-book-sub', text: `${num(b.full.entries)} entr${b.full.entries === 1 ? 'y' : 'ies'} · ${fullWords(b.full)} full` })),
        b.inbox ? el('span', { class: 'rail-count mem-inbox-count', title: `${b.inbox} suggested line${b.inbox === 1 ? '' : 's'} waiting in the Inbox`, text: String(b.inbox) }) : '');
      return el('li', {}, row);
    }));
  }

  // ---- Middle: List or Text ----

  function drawMain() {
    $('#memory-list-btn').setAttribute('aria-pressed', String(mp.view === 'list'));
    $('#memory-text-btn').setAttribute('aria-pressed', String(mp.view === 'text'));
    const main = $('#memory-main');
    const b = mp.books.find(x => x.scope === mp.scope);
    $('#memory-page-title').textContent = b ? (b.scope === 'team' ? 'Memory: the team' : `Memory: ${b.name}`) : 'Memory';
    if (mp.q) return drawFound(main);
    if (!mp.book) return main.replaceChildren();
    if (mp.view === 'text') return drawText(main);
    const book = mp.book;
    const head = el('div', { class: 'mem-head' },
      el('p', { class: 'hint', text: b?.scope === 'team' ? 'Everyone on the team reads these, in every chat and every job step.' : `Only ${b?.name ?? 'they'} reads these, in chats and in the job steps they run.` }),
      fullBar(book.full));
    const problems = book.problems.length ? el('ul', { class: 'mem-problems', role: 'status' }, ...book.problems.map(p => el('li', { text: p }))) : '';
    const undo = mp.undo && mp.undo.scope === mp.scope ? el('p', { class: 'hint nb-undo', role: 'status' }, `Deleted: "${short(mp.undo.line.text, 60)}" `, el('button', { class: 'link', type: 'button', text: 'Undo', onclick: undoDelete })) : '';
    // The Inbox first (it waits for him), then the groups in file order; an empty notebook says how to start.
    const waiting = book.lines.some(l => l.group === INBOX);
    // An empty Inbox is not shown: it has nothing to say.
    const groups = book.groups.filter(g => g !== INBOX || waiting);
    if (waiting && !groups.includes(INBOX)) groups.unshift(INBOX);
    groups.sort((x, y) => Number(y === INBOX) - Number(x === INBOX));
    const parts = groups.map(g => drawGroup(g, book.lines.filter(l => l.group === g)));
    const none = !book.lines.length ? el('p', { class: 'hint mem-none', text: 'Nothing kept yet. Press Add entry, type "remember: ..." in a chat, or press Pin under a message. A group called "Always send" is sent on every turn.' }) : '';
    main.replaceChildren(head, problems, undo, addForm(), none, ...parts);
    if (mp.mark) {
      const at = main.querySelector(`[data-id="${CSS.escape(mp.mark)}"]`);
      at?.classList.add('mem-marked');
      at?.scrollIntoView({ block: 'center' });
      mp.mark = '';
    }
  }

  const short = (t, n) => (t.length > n ? `${t.slice(0, n).replace(/\s+/g, ' ')}…` : t.replace(/\s+/g, ' '));

  function fullBar(f) {
    const p = pct(f);
    const bar = el('div', { class: 'mem-full' },
      // Its width set from the script: the page allows no style written into the page itself.
      el('div', { class: 'rd-bar', role: 'img', 'aria-label': `${fullWords(f).replace('%', ' per cent')} full` }, el('div', { class: 'rd-fill' })),
      el('span', { class: 'hint', text: `${num(f.entries)} of ${num(f.maxEntries)} entries, ${num(f.chars)} of ${num(f.maxChars)} characters` }));
    bar.querySelector('.rd-fill').style.width = `${p}%`;
    return bar;
  }

  function drawGroup(g, lines) {
    const inbox = g === INBOX;
    const acts = inbox
      ? [el('button', { class: 'btn', type: 'button', text: 'Keep the ticked', onclick: () => inboxAll('keep') }), el('button', { class: 'btn quiet', type: 'button', text: 'Drop the ticked', onclick: () => inboxAll('drop') })]
      : [el('button', { class: 'link', type: 'button', text: 'Rename', onclick: () => renameGroup(g) }), lines.length ? '' : el('button', { class: 'link', type: 'button', text: 'Delete group', onclick: () => change({ action: 'group', do: 'remove', name: g }) })];
    const head = el('div', { class: 'mem-group-head' },
      el('h3', { text: g }),
      el('span', { class: 'hint', text: inbox ? `${lines.length} waiting for you: never sent to a model until you keep it` : g === ALWAYS ? 'sent on every turn' : `${lines.length} entr${lines.length === 1 ? 'y' : 'ies'}` }),
      el('span', { class: 'mem-group-acts' }, ...acts));
    const list = el('ul', { class: 'mem-lines', 'data-group': g });
    list.addEventListener('dragover', e => {
      if (mp.dragging) e.preventDefault();
    });
    list.addEventListener('drop', e => {
      e.preventDefault();
      const target = e.target.closest?.('.mem-line');
      if (mp.dragging) dropAt(mp.dragging, g, target?.dataset.id ?? '');
    });
    for (const l of lines) list.append(drawLine(l, inbox));
    if (!lines.length) list.append(el('li', { class: 'hint mem-empty', text: inbox ? 'Nothing waiting.' : 'Nothing in this group yet: drag an entry here, or Add entry.' }));
    return el('section', { class: `mem-group${inbox ? ' mem-inbox' : ''}`, 'data-group': g }, head, list);
  }

  function drawLine(l, inbox) {
    const long = l.text.split('\n').length > 3 || l.text.length > 320;
    const open = mp.opened.has(l.id);
    const text = el('div', { class: `nb-text mem-text${long && !open ? ' mem-fold' : ''}`, text: l.text });
    if (long) {
      text.title = open ? 'Click to fold it' : 'Click to see all of it';
      text.addEventListener('click', () => {
        if (mp.opened.has(l.id)) mp.opened.delete(l.id);
        else mp.opened.add(l.id);
        drawMain();
      });
    }
    const meta = el('span', { class: 'nb-from', text: `${fromWords(l)}${when(l.at) ? ` · ${when(l.at)}` : ''} · ${num(l.text.length)} characters${l.withheld ? ' · never sent: it looks like a key or a password' : ''}` });
    const move = el('select', { class: 'mem-move', 'aria-label': 'Move to group' }, el('option', { value: '', text: 'Move to…' }), ...mp.book.groups.filter(g => g !== l.group && g !== INBOX).map(g => el('option', { value: g, text: g })), el('option', { value: '+', text: 'A new group…' }));
    move.addEventListener('change', async () => {
      let g = move.value;
      if (g === '+') g = await askText('Name of the new group');
      if (g) await change({ action: 'edit', id: l.id, group: g });
      else move.value = '';
    });
    const acts = inbox
      ? [el('input', { type: 'checkbox', class: 'mem-tick', 'aria-label': 'Tick to keep or drop with the others', checked: mp.picked.has(l.id), onchange: e => (e.target.checked ? mp.picked.add(l.id) : mp.picked.delete(l.id)) }),
        el('button', { class: 'btn', type: 'button', text: 'Keep', onclick: () => change({ action: 'edit', id: l.id, group: 'Notes' }) }),
        el('button', { class: 'link', type: 'button', text: 'Edit then keep', onclick: () => editLine(row, l, 'Notes') }),
        el('button', { class: 'link', type: 'button', text: 'Drop', onclick: () => change({ action: 'delete', id: l.id }) })]
      : [el('button', { class: 'link', type: 'button', text: 'Edit', onclick: () => editLine(row, l) }), move, el('button', { class: 'link', type: 'button', text: 'Delete', onclick: () => deleteLine(l) })];
    const row = el('li', { class: `nb-line mem-line${l.withheld ? ' mem-withheld' : ''}`, 'data-id': l.id, draggable: inbox ? false : 'true' }, el('span', { class: 'nb-body' }, text, meta), el('span', { class: 'nb-acts' }, ...acts));
    row.addEventListener('dragstart', e => {
      mp.dragging = l.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', l.id);
      row.classList.add('mem-dragging');
    });
    row.addEventListener('dragend', () => {
      mp.dragging = '';
      row.classList.remove('mem-dragging');
    });
    return row;
  }

  /** Dropped on the entry `beforeId` (or the end of group `g`): moved to that group when it was in another, then put there. */
  async function dropAt(id, g, beforeId) {
    mp.dragging = '';
    if (id === beforeId) return;
    const lines = mp.book.lines;
    const l = lines.find(x => x.id === id);
    if (!l) return;
    if (l.group !== g && !(await change({ action: 'edit', id, group: g }))) return;
    const ids = mp.book.lines.map(x => x.id).filter(x => x !== id);
    const at = beforeId ? ids.indexOf(beforeId) : ids.map(x => mp.book.lines.find(y => y.id === x)?.group).lastIndexOf(g) + 1;
    ids.splice(at < 0 ? ids.length : at, 0, id);
    await change({ action: 'order', ids });
  }

  function editLine(row, l, keepTo) {
    const box = el('textarea', { class: 'mem-edit-box', rows: String(Math.min(14, Math.max(3, l.text.split('\n').length + 1))), maxlength: String(ENTRY_MAX), 'aria-label': 'Change this entry' });
    box.value = l.text;
    const count = el('span', { class: 'hint mem-count' });
    const tally = () => (count.textContent = `${num(box.value.length)} of ${num(ENTRY_MAX)}`);
    box.addEventListener('input', tally);
    tally();
    const save = el('button', { class: 'btn primary', type: 'button', text: keepTo ? 'Keep' : 'Save', onclick: () => change({ action: 'edit', id: l.id, text: box.value, was: l.text, ...(keepTo ? { group: keepTo } : {}) }) });
    const cancel = el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: drawMain });
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save.click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel.click();
      }
    });
    row.replaceChildren(el('div', { class: 'nb-edit mem-edit' }, box, el('div', { class: 'mem-edit-acts' }, save, cancel, count)));
    box.focus();
  }

  async function deleteLine(l) {
    if (await change({ action: 'delete', id: l.id })) {
      mp.undo = { scope: mp.scope, line: l };
      drawMain();
    }
  }

  async function undoDelete() {
    const u = mp.undo;
    mp.undo = null;
    if (u) await change({ action: 'add', text: u.line.text, from: u.line.from, group: u.line.group });
  }

  async function renameGroup(g) {
    const to = await askText(`New name for "${g}"`, g);
    if (to && to !== g) await change({ action: 'group', do: 'rename', name: g, to });
  }

  /** The Inbox's ticked lines (all of them when none is ticked), kept into Notes or dropped, at once. */
  async function inboxAll(how) {
    const all = mp.book.lines.filter(l => l.group === INBOX);
    const these = mp.picked.size ? all.filter(l => mp.picked.has(l.id)) : all;
    if (!these.length) return;
    for (const l of these) {
      const ok = await change(how === 'keep' ? { action: 'edit', id: l.id, group: 'Notes' } : { action: 'delete', id: l.id });
      if (!ok) break;
      mp.picked.delete(l.id);
    }
    say(`${these.length} ${how === 'keep' ? 'kept in Notes' : 'dropped'}.`);
  }

  // ---- Add entry (with a paste of several lines: one entry, or one per line) ----

  function addForm() {
    const form = el('form', { class: 'nb-add mem-add', hidden: !mp.adding });
    const add = el('textarea', { id: 'memory-add-text', rows: '4', maxlength: String(ENTRY_MAX), placeholder: 'A fact, a rule, a price list or a style guide: up to 4,000 characters, lines kept (Ctrl+Enter adds it)', 'aria-label': 'The entry to add' });
    const groups = [...new Set(['Notes', ...(mp.book?.groups ?? []).filter(g => g !== INBOX), ALWAYS])];
    const group = el('select', { 'aria-label': 'Group' }, ...groups.map(g => el('option', { value: g, text: g })));
    const count = el('span', { class: 'hint mem-count', text: `0 of ${num(ENTRY_MAX)}` });
    add.addEventListener('input', () => (count.textContent = `${num(add.value.length)} of ${num(ENTRY_MAX)}`));
    add.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    // A paste of several lines into an empty box: asked once, kept as one entry or one per line.
    add.addEventListener('paste', async e => {
      const pasted = e.clipboardData?.getData('text/plain') ?? '';
      const lines = pasted.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      if (add.value.trim() || lines.length < 2) return;
      e.preventDefault();
      const how = await askPick($('#memory-ask'), `You pasted ${lines.length} lines.`, [{ label: 'Keep as one note', value: 'one' }, { label: 'One note per line', value: 'each' }]);
      if (how === 'one') add.value = pasted;
      if (how === 'each') {
        let n = 0;
        for (const t of lines) if (await change({ action: 'add', text: t, group: group.value })) n++;
        say(`${n} of ${lines.length} kept, one note per line.`);
      }
      add.dispatchEvent(new Event('input'));
    });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!add.value.trim()) return add.focus();
      // Closed first: the redraw after the change draws the page without it.
      mp.adding = false;
      if (await change({ action: 'add', text: add.value, group: group.value })) say('Kept.');
      else {
        mp.adding = true;
        form.hidden = false;
      }
    });
    form.append(add, el('div', { class: 'mem-edit-acts' }, group, el('button', { class: 'btn primary', type: 'submit', text: 'Add' }), el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => ((mp.adding = false), drawMain()) }), count));
    return form;
  }

  // ---- Text: the whole file in one box ----

  async function drawText(main) {
    if (!mp.text || mp.text.scope !== mp.scope) {
      try {
        const r = await api(`/api/memory/text?scope=${encodeURIComponent(mp.scope)}`);
        mp.text = { scope: mp.scope, text: r.text, mtime: r.mtime, file: r.file };
      } catch (e) {
        return say(e.message, true);
      }
    }
    const box = el('textarea', { class: 'mem-text-box', spellcheck: 'true', 'aria-label': 'The whole memory file' });
    box.value = mp.text.text;
    const save = el('button', { class: 'btn primary', type: 'button', text: 'Save' });
    const cancel = el('button', { class: 'btn quiet', type: 'button', text: 'Cancel' });
    cancel.addEventListener('click', () => {
      mp.text = null;
      drawMain();
    });
    save.addEventListener('click', async () => {
      say('');
      const body = { scope: mp.scope, action: 'text', text: box.value, mtime: mp.text.mtime };
      try {
        // First read it back as code reads it: what is in it, and anything not sent as written, before it is kept.
        const seen = (await api('/api/memory', { ...body, check: true })).read;
        const words = `This reads as ${seen.entries} entr${seen.entries === 1 ? 'y' : 'ies'} in ${seen.groups.length} group${seen.groups.length === 1 ? '' : 's'}.`;
        if (seen.problems.length && !(await askHere($('#memory-ask'), `${words} ${seen.problems.join(' ')} Keep it as it is?`, 'Keep it', 'Go back', false))) return;
        const r = await app.memApi(body);
        mp.text = null;
        say(`Kept. ${words}`);
        mp.view = 'list';
        took(r);
      } catch (e) {
        if (!e.quiet) say(e.message, true);
      }
    });
    main.replaceChildren(
      el('p', { class: 'hint', text: 'The whole file, as Notepad shows it. "## " starts a group; each entry is a line starting "- ", with its other lines indented two spaces, or a block of lines up to a blank line. Save reads it back first and says what it found.' }),
      el('p', { class: 'hint mem-path', text: mp.text.file }),
      box, el('div', { class: 'mem-edit-acts' }, save, cancel));
    box.focus();
  }

  // ---- Search, in every notebook ----

  async function search(q) {
    mp.q = q.trim();
    if (!mp.q) return drawMain();
    try {
      mp.found = (await api(`/api/memory/search?q=${encodeURIComponent(mp.q)}`)).found;
    } catch (e) {
      mp.found = [];
      say(e.message, true);
    }
    if (mp.q === q.trim()) drawMain();
  }

  function drawFound(main) {
    const name = scope => mp.books.find(b => b.scope === scope)?.name ?? scope;
    const rows = (mp.found ?? []).map(f => el('li', { class: 'nb-line' }, el('button', { class: 'link mem-found', type: 'button', onclick: () => {
      mp.q = '';
      $('#memory-search').value = '';
      mp.mark = f.id;
      pick(f.scope);
    } }, el('span', { class: 'mem-found-where', text: `${name(f.scope)} · ${f.group}` }), el('span', { class: 'nb-text mem-text mem-fold', text: f.text }))));
    main.replaceChildren(el('h3', { text: `Found in every notebook: ${rows.length}${rows.length >= 100 ? ' (the first 100)' : ''}` }), rows.length ? el('ul', { class: 'mem-lines' }, ...rows) : el('p', { class: 'hint', text: 'Nothing has all of those words.' }));
  }

  // ---- Right: what each model gets ----

  async function loadGets() {
    const box = $('#memory-gets');
    const scope = mp.scope;
    let r;
    // The team's: as the host reads it; with the host off, as the first hire who reads memory does.
    const readers = scope === 'team' ? ['manager', ...mp.books.filter(b => b.scope !== 'team' && !b.plain).map(b => b.scope)] : [mp.who];
    try {
      for (const [i, who] of readers.entries()) {
        try {
          r = await api(`/api/memory/reading?chat=&who=${encodeURIComponent(who)}`);
          break;
        } catch (e) {
          if (i === readers.length - 1) throw e;
        }
      }
    } catch (e) {
      // Nobody hired yet: nobody reads the team notebook now, and there was never anybody to pick.
      const hires = mp.books.filter(b => b.scope !== 'team');
      const text = scope !== 'team' ? e.message : !hires.length ? NOBODY : !hires.some(b => !b.plain) ? NOBODY_READS : e.message;
      return box.replaceChildren(el('h3', { text: 'What the model gets' }), el('p', { class: 'hint', text }));
    }
    if (scope !== mp.scope) return;
    const want = scope === 'team' ? 'team' : 'own';
    const p = r.parts.find(x => x.key === want);
    const team = r.parts.find(x => x.key === 'team');
    const state = x => (!x ? 'Not read: the Default role reads no memory.' : x.state === 'whole' ? 'Sent whole' : x.state === 'cut' ? 'Part of it' : x.state === 'none' ? 'Nothing to send' : 'Left out: no room');
    const lines = mp.book?.lines ?? [];
    const always = lines.filter(l => l.group === ALWAYS && !l.withheld);
    const alwaysChars = always.reduce((n, l) => n + l.text.length + 3, 0);
    const room = Math.floor(r.room / 5);
    box.replaceChildren(
      el('h3', { text: `What ${r.name} gets` }),
      el('p', { class: 'hint', text: `${r.model ? `${r.model}, ` : ''}${num(r.ctx)} tokens of context. Each notebook may take up to a fifth of the room: about ${num(room)} characters here.` }),
      el('dl', { class: 'mem-gets-list' },
        el('dt', { text: scope === 'team' ? 'This notebook (team)' : 'This notebook' }), el('dd', { text: `${state(p)}${p?.note ? ` · ${p.note}` : ''}${p?.chars ? ` · ${num(p.chars)} characters` : ''}` }),
        ...(scope !== 'team' && team ? [el('dt', { text: 'Team memory' }), el('dd', { text: `${state(team)}${team.note ? ` · ${team.note}` : ''}` })] : []),
        el('dt', { text: ALWAYS }), el('dd', { text: !always.length ? 'No entries in it.' : alwaysChars <= room ? `All ${always.length} sent on every turn (${num(alwaysChars)} characters).` : `Too big to send whole (${num(alwaysChars)} of about ${num(room)} characters): the first ones are sent, and long ones in part.` }),
        // G4: on the smallest model this hire uses, some Always send lines may not fit at all.
        ...(scope !== 'team' && r.always && (r.always.left || r.always.part) ? [el('dt', { text: 'On their smallest model' }), el('dd', { class: 'fault', text: `${r.always.left ? `${r.always.left} of ${r.always.total} ${ALWAYS} lines will not be sent to ${r.always.model}` : ''}${r.always.left && r.always.part ? '; ' : ''}${r.always.part ? `${r.always.part} only in part` : ''} (${num(r.always.ctx)} tokens of context, about ${num(r.always.room)} characters for this notebook${r.always.agent ? ' in an agent run' : ''}). Make them shorter, or move some out of ${ALWAYS}.` })] : [])),
      el('p', { class: 'hint', text: r.measured ? 'Measured on the last answer in their latest chat.' : 'From the context set for their model here; it is measured once they answer.' }));
  }

  // ---- The page's own buttons ----

  $('#memory-back').addEventListener('click', () => setView(mp.back || 'chat'));
  $('#memory-tools').replaceChildren(
    el('input', { id: 'memory-search', type: 'search', placeholder: 'Search every notebook', 'aria-label': 'Search every notebook', autocomplete: 'off' }),
    iconBtn('add', 'Add entry', () => {
      mp.q = '';
      $('#memory-search').value = '';
      mp.view = 'list';
      mp.adding = true;
      drawMain();
      $('#memory-add-text')?.focus();
    }),
    iconBtn('group', 'Add group', async () => {
      const name = await askText('Name of the new group (for example: Style guide, Prices, Always send)');
      if (name) await change({ action: 'group', do: 'add', name });
    }),
    el('span', { class: 'mem-switch', role: 'group', 'aria-label': 'View' },
      Object.assign(iconBtn('list', 'List', () => ((mp.view = 'list'), (mp.text = null), drawMain()), 'Each entry on its own, in its group'), { id: 'memory-list-btn' }),
      Object.assign(iconBtn('text', 'Text', () => ((mp.view = 'text'), drawMain()), 'The whole file in one box'), { id: 'memory-text-btn' })),
    iconBtn('file', 'Open file', () => openOnPc(false), 'Open this memory in Notepad: save it there and the next answer uses it'),
    iconBtn('folder', 'Open folder', () => openOnPc(true), 'Open the memory folder in Explorer'));
  let searchTimer = 0;
  $('#memory-search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(e.target.value), 250);
  });

  async function openOnPc(folder) {
    try {
      say((await api('/api/memory/open', { scope: mp.scope, folder })).said);
    } catch (e) {
      say(e.message, true);
    }
  }

  // A notebook changed in Notepad while the page is open: read again when the window comes back to the front.
  window.addEventListener('focus', () => {
    if (homeUi.view === 'memory' && mp.view === 'list' && mp.book) {
      api(`/api/memory?scope=${encodeURIComponent(mp.scope)}`).then(r => {
        if (homeUi.view === 'memory' && r.mtime !== mp.book?.mtime && mp.view === 'list' && !page.querySelector('.mem-edit, .mem-add:not([hidden]) textarea:not(:placeholder-shown)')) took(r);
      }).catch(() => undefined);
    }
  });
}

// The ways in: the chat's Memory window, and the person page.
$('#notebook-editor').addEventListener('click', async () => {
  let scope = 'team';
  try {
    scope = (await api(readingAddress(app.chatId, app.chatWho?.()))).scope ?? 'team';
  } catch {
    // The team's, then.
  }
  $('#notebook').close();
  app.openMemory(scope, { back: 'chat' });
});
$('#person-page-memory').addEventListener('click', () => {
  const who = String(pageUi.who ?? '');
  app.openMemory(who.startsWith('staff:') ? who : 'team', { back: 'person' });
});
