// The Agents page, in the middle panel (src/server/agents.ts on the server): every standing job on this PC and on each
// linked PC, its next run on that PC's own clock, its last result, what it held (Allow next time), and Run now, Pause,
// Stop, Edit, Copy recipe and Delete. New standing job: a short form (Name, Agent, When, Task) or the whole recipe as text (or start from a starter, shown first while there is no job, or have a chatbot
// write one with the prompt shown here); Check reads it as code and names every problem, and the card lists every tool before
// Approve and save. A report opens on the page. Home's line for a finished run is drawn here too (app.agentCard).
// Loaded after team.js (the role icons) and home.js (setView); its names stay inside this block.
'use strict';
{
  const ag = { data: null, help: null, others: [], back: 'home', edit: null, report: null, ask: null, settings: null };
  const STATE = { waiting: 'Waiting', running: 'Running now', done: 'Done', held: 'Done, held some', budget: 'Used its budget', failed: 'Did not finish', skipped: 'Skipped', stopped: 'Stopped' };
  const ICONS = {
    add: ['M12 5v14', 'M5 12h14'],
    book: ['M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z', 'M8 7h7'],
    chat: ['M4 4h16v12H8l-4 4z'],
    pull: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 20h16'],
    again: ['M4 12a8 8 0 0 1 14-5.3L20 9', 'M20 4v5h-5', 'M20 12a8 8 0 0 1-14 5.3L4 15', 'M4 20v-5h5'],
    gear: ['M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M4.9 4.9l2.1 2.1', 'M17 17l2.1 2.1', 'M4.9 19.1L7 17', 'M17 7l2.1-2.1'],
  };
  const tool = (icon, label, onclick, title) => el('button', { class: 'btn quiet mem-tool', type: 'button', title: title ?? label, onclick }, app.lineIcon(...ICONS[icon]), label);
  const say = (t, bad = false) => {
    $('#agents-said').textContent = t ?? '';
    $('#agents-said').classList.toggle('fault', !!bad && !!t);
  };
  const when = at => {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const spy = () => {
    const s = el('span', { class: 'ag-icon', 'aria-hidden': 'true' });
    s.append(typeof roleIcon === 'function' ? roleIcon('agent') : app.lineIcon(...ICONS.book));
    return s;
  };

  /** A yes or no asked on the page (no browser pop-up). */
  const askYes = (text, yes = 'Yes') => new Promise(done => {
    const box = $('#agents-ask');
    const end = v => { box.replaceChildren(); box.hidden = true; done(v); };
    box.replaceChildren(el('p', { text }), el('div', { class: 'ag-actions' }, el('button', { class: 'btn primary', type: 'button', text: yes, onclick: () => end(true) }), el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => end(false) })));
    box.hidden = false;
    box.querySelector('button').focus();
  });

  // ---- Opening ----

  app.openAgents = async (o = {}) => {
    for (const d of document.querySelectorAll('dialog[open]')) if (!d.classList.contains('as-page')) d.close();
    ag.back = o.back ?? (homeUi.view && homeUi.view !== 'agents' ? homeUi.view : ag.back);
    ag.edit = null;
    ag.report = null;
    ag.settings = null;
    say('');
    setView('agents');
    $('#agents-page').scrollTop = 0;
    drawTools();
    await load();
    if (o.run) await openReport(o.run);
  };

  async function load() {
    say('');
    try {
      ag.data = await api('/api/agents');
      ag.help ??= await api('/api/agents/help');
    } catch (e) {
      say(e.message, true);
    }
    draw();
    // Linked PCs are asked after (each may take a few seconds, or be off).
    api('/api/agents/others').then(r => { ag.others = r.pcs; if (!ag.edit && !ag.report) draw(); }, () => undefined);
  }

  function drawTools() {
    $('#agents-tools').replaceChildren(
      tool('add', 'New standing job', () => openEdit(null)),
      tool('book', 'Starters', () => openStarters()),
      tool('chat', 'Write a recipe with a chatbot', () => openChatbot()),
      tool('pull', 'Collect reports', collect, 'Collect new reports from linked PCs now (it is also done every 10 minutes)'),
      tool('again', 'Refresh', () => load()),
      tool('gear', 'Settings', () => openSettings(), 'When agents may run on this PC, and their summaries to your phone'));
  }

  async function collect() {
    say('Collecting reports from linked PCs…');
    try {
      const r = await api('/api/agents/collect', {});
      say([r.got ? `${r.got} new report${r.got === 1 ? '' : 's'} collected.` : 'No new reports on linked PCs.', ...r.said].join(' '));
      await load();
    } catch (e) {
      say(e.message, true);
    }
  }

  // ---- The page ----

  function draw() {
    const d = ag.data;
    $('#agents-clock').textContent = d ? `Times are this PC's own clock: now ${d.time}.${d.node ? ' This PC is a node: its jobs are set from the admin PC.' : ''}` : '';
    const main = $('#agents-main');
    if (ag.settings) return drawSettings(main);
    if (ag.report) return drawReport(main);
    if (ag.edit) return drawEdit(main);
    if (!d) return main.replaceChildren();
    // No standing job yet: the Starters come first, then the empty list says what to do (with Hire an Agent when there is none).
    const empty = d.agents.length ? el('p', { class: 'hint', text: 'No standing jobs yet. Pick one of the Starters above, or press New standing job.' })
      : el('div', { class: 'ag-empty' }, el('p', { class: 'hint', text: 'No standing jobs yet. First hire an Agent (Hire staff, role Agent), then press New standing job.' }),
        el('div', { class: 'ag-actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Hire an Agent', onclick: () => app.openHire?.({ role: 'agent' }) })));
    const parts = [!d.jobs.length && ag.help?.starters?.length ? startersPart() : '', el('section', { class: 'ag-part', 'aria-labelledby': 'ag-here' }, el('h3', { id: 'ag-here', text: 'On this PC' }),
      d.jobs.length ? el('ul', { class: 'ag-list' }, ...d.jobs.map(j => jobCard(j, null))) : empty)];
    for (const pc of ag.others) {
      const body = pc.state === 'on' ? (pc.jobs?.length ? el('ul', { class: 'ag-list' }, ...pc.jobs.map(j => jobCard(j, pc))) : el('p', { class: 'hint', text: 'No standing jobs there.' }))
        : el('p', { class: 'hint', text: pc.state === 'old' ? 'Its TOMLIN is older and has no agents: update it first.' : 'Off or not answering: its jobs carry on there, and its reports are collected when it is on.' });
      parts.push(el('section', { class: 'ag-part' }, el('h3', { text: `On ${pc.name}${pc.time ? ` (its clock: ${pc.time})` : ''}` }), body,
        pc.state === 'on' ? el('div', { class: 'ag-actions' }, el('button', { class: 'btn', type: 'button', text: `New standing job on ${pc.name}`, onclick: () => openEdit(null, pc) })) : ''));
    }
    parts.push(runsPart(d.runs));
    main.replaceChildren(...parts);
  }

  function jobCard(j, pc) {
    const last = j.last;
    const go = (action, extra = {}) => act({ action, job: j.id, ...extra }, pc);
    const held = (j.held ?? []).length ? el('div', {}, el('span', { class: 'hint', text: 'Held since it was approved (not done):' }), el('ul', { class: 'ag-held' }, ...j.held.map(h => el('li', {}, `Wanted to ${h.what}. `, h.tool && !h.never ? el('button', { class: 'link', type: 'button', text: 'Allow next time', title: 'Adds this tool to the recipe; your press approves it', onclick: () => go('allow', { tool: h.tool }) }) : '')))) : '';
    const running = j.running === 'running' || j.running === 'waiting';
    return el('li', { class: 'ag-job' },
      el('div', { class: 'ag-job-head' }, spy(), el('strong', { text: j.recipe.name }), el('span', { class: 'hint', text: `by ${j.agentName}` }),
        el('span', { class: `ag-state${!j.approved || j.agentGone ? ' bad' : ''}`, text: j.agentGone ? 'Agent not on the team' : !j.approved ? 'Needs approving' : j.paused ? 'Paused' : running ? STATE[j.running] : 'On' })),
      el('div', { class: 'ag-meta' }, el('span', { text: `When: ${j.when.join('; ')}` }), el('span', { text: `Next: ${j.next}` }),
        last ? el('span', { text: `Last: ${STATE[last.state] ?? last.state}, ${when(last.at)}: ${last.line}` }) : el('span', { text: 'Not run yet' })),
      j.warning ? el('p', { class: 'hint', text: j.warning }) : '',
      j.phoneSaid ? el('p', { class: 'fault', text: j.phoneSaid }) : '',
      j.nextNote ? el('p', { class: 'hint' }, `Next run, also: ${j.nextNote} `, pc ? '' : el('button', { class: 'link', type: 'button', text: 'Take it off', onclick: () => go('note', { text: '' }) })) : '',
      (j.watch ?? []).length ? el('ul', { class: 'ag-held ag-watch', 'aria-label': 'Watched pages' }, ...j.watch.map(w => el('li', { text: `${w.url}: ${w.line}` }))) : '',
      held,
      el('div', { class: 'ag-actions' },
        running ? el('button', { class: 'btn', type: 'button', text: 'Stop', onclick: () => go('stop') }) : el('button', { class: 'btn primary', type: 'button', text: 'Run now', disabled: !j.approved || j.agentGone, onclick: () => go('run') }),
        el('button', { class: 'btn', type: 'button', text: j.paused ? 'Resume' : 'Pause', onclick: () => go('pause', { paused: !j.paused }) }),
        last?.report && !pc ? el('button', { class: 'btn', type: 'button', text: 'Read the report', onclick: () => openReport(last.run) }) : '',
        el('button', { class: 'btn', type: 'button', text: j.approved ? 'Edit' : 'Edit and approve', onclick: () => openEdit(j, pc) }),
        el('button', { class: 'btn quiet', type: 'button', text: 'Copy recipe', onclick: () => copy(j.text) }),
        el('label', { class: 'ag-check', title: 'Its one-line summary goes to your phone (Settings on this page): never the report' }, phoneBox(j, go), ' Send its summary to my phone'),
        el('button', { class: 'btn quiet', type: 'button', text: 'Delete', onclick: async () => { if (await askYes(`Delete the standing job "${j.recipe.name}"? Its reports stay in the workspace.`, 'Delete')) go('delete'); } })));
  }

  function phoneBox(j, go) {
    const box = el('input', { type: 'checkbox' });
    box.checked = !!j.phone;
    box.addEventListener('change', () => go('phone', { phone: box.checked }));
    return box;
  }

  function runsPart(runs) {
    if (!runs.length) return el('section', { class: 'ag-part' }, el('h3', { text: 'Recent runs' }), el('p', { class: 'hint', text: 'No runs yet.' }));
    return el('section', { class: 'ag-part', 'aria-labelledby': 'ag-runs' }, el('h3', { id: 'ag-runs', text: 'Recent runs' }),
      el('table', { class: 'ag-runs' }, el('thead', {}, el('tr', {}, el('th', { text: 'When' }), el('th', { text: 'Job' }), el('th', { text: 'How it ended' }), el('th', { class: 'ag-wide', text: 'Started by' }), el('th', { text: '' }))),
        el('tbody', {}, ...runs.slice(0, 40).map(r => el('tr', {},
          el('td', { text: when(r.started ?? r.added) }),
          el('td', { text: `${r.agentName}: ${r.name}${r.from ? ` (on ${r.from})` : ''}` }),
          el('td', { text: `${STATE[r.state] ?? r.state}. ${r.line}${r.held?.length ? ` Held ${r.held.length}.` : ''}` }),
          el('td', { class: 'ag-wide', text: r.by }),
          el('td', {}, r.report ? el('button', { class: 'link', type: 'button', text: 'Report', onclick: () => openReport(r.id) }) : ''))))));
  }

  async function act(body, pc) {
    say('');
    try {
      const r = pc ? await api('/api/agents/remote', { ...body, pc: pc.pc }) : await api('/api/agents', body);
      if (!pc && r.jobs) ag.data = r;
      if (pc) ag.others = (await api('/api/agents/others')).pcs;
      say(body.action === 'run' ? 'Added to the queue: it runs when its PC is free.' : body.action === 'allow' ? 'Allowed from the next run.' : '');
      draw();
      app.refreshHome?.();
    } catch (e) {
      say(e.message, true);
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      say('Recipe copied.');
    } catch {
      say('The recipe could not be copied: select it in Edit and copy it there.', true);
    }
  }

  // ---- New job and Edit: the recipe as text, checked by code, then the approval card ----

  function openEdit(j, pc = null, text = '') {
    ag.report = null;
    const t = text || j?.text || (ag.help?.starters ? blank() : '');
    // The short form first (Name, Agent, When, Task); a recipe in JSON opens as text.
    ag.edit = { id: j?.id ?? null, pc, text: t, checked: null, form: !t.trim().startsWith('{') };
    draw();
    $('#agents-main input, #agents-main textarea')?.focus();
  }

  // ---- The short form: Name, Agent, When and Task, written into the recipe's own lines (the rest stays as it is) ----

  /** A line that starts a field of the recipe (the words of src/recipe.ts FIELDS); other lines carry on the one above. */
  const FIELD_WORDS = /^\s*(name|title|agent|who|runs on|run on|pc|computer|when|schedule|trigger|triggers|task|job|what|instructions|pages|sites|urls|addresses|tools|must hold|hold|results|output|stop after|stop|limits|budget|memory|wait at most|wait|watch for|reads)\s*:/i;
  const FORM_FIELDS = { Name: /^(name|title)$/i, Agent: /^(agent|who)$/i, When: /^(when|schedule|triggers?)$/i, Task: /^(task|job|what|instructions)$/i, Tools: /^tools$/i };
  const FORM_ORDER = ['Name', 'Agent', 'When', 'Task'];
  const WHEN_EXAMPLES = ['Every weekday at 07:00', 'Every day at 18:00', 'Every Monday at 09:00', 'Every 6 hours', 'Once on 2026-12-01 at 08:00', 'When a file lands in inbox', 'When a page changes (every 2 hours)', 'By hand'];
  const linesOf = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** Where a field is: [its first line, the line after its last], or null. */
  function fieldAt(lines, field) {
    const i = lines.findIndex(l => FORM_FIELDS[field].test(FIELD_WORDS.exec(l)?.[1].trim() ?? ''));
    if (i < 0) return null;
    let j = i + 1;
    while (j < lines.length && !FIELD_WORDS.test(lines[j])) j++;
    while (j > i + 1 && !lines[j - 1].trim()) j--;
    return [i, j];
  }
  function fieldGet(text, field) {
    const lines = linesOf(text);
    const at = fieldAt(lines, field);
    return at ? [lines[at[0]].replace(FIELD_WORDS, ''), ...lines.slice(at[0] + 1, at[1])].map(l => l.trim()).join('\n').trim() : '';
  }
  /** The recipe with one field set to `value` (several lines for a long task); a field not there yet goes in the usual order. */
  function fieldSet(text, field, value) {
    const lines = linesOf(text);
    const said = String(value ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
    // A task line that would read as a field of its own ("What: ...") is kept as task words.
    const mine = [`${field}: ${said[0] ?? ''}`, ...said.slice(1).map(l => (FIELD_WORDS.test(l) ? `- ${l}` : l))];
    const at = fieldAt(lines, field);
    if (at) lines.splice(at[0], at[1] - at[0], ...mine);
    else lines.splice(Math.max(0, ...FORM_ORDER.slice(0, FORM_ORDER.indexOf(field)).map(f => fieldAt(lines, f)?.[1] ?? 0)), 0, ...mine);
    return lines.join('\n');
  }
  app.agentFields = { fieldGet, fieldSet };

  function formPart(e, changed) {
    const set = (field, v) => {
      e.text = fieldSet(e.text, field, v);
      changed();
    };
    const field = (label, box, about) => el('label', { class: 'field ag-field' }, el('span', { text: label }), box, about ? el('span', { class: 'hint', text: about }) : '');
    const name = el('input', { type: 'text', maxlength: '80', autocomplete: 'off', placeholder: 'Morning price check', value: fieldGet(e.text, 'Name') });
    name.addEventListener('input', () => set('Name', name.value));
    const now = fieldGet(e.text, 'Agent');
    const names = (ag.data?.agents ?? []).map(a => a.name);
    if (now && !names.includes(now)) names.unshift(now);
    const who = el('select', {}, ...(names.length ? names.map(n => el('option', { value: n, text: n })) : [el('option', { value: '', text: 'No Agent hired yet' })]));
    who.value = now || names[0] || '';
    who.disabled = !names.length;
    if (names.length && who.value !== now) set('Agent', who.value);
    who.addEventListener('change', () => set('Agent', who.value));
    const when = el('input', { type: 'text', autocomplete: 'off', list: 'ag-when-list', placeholder: WHEN_EXAMPLES[0], value: fieldGet(e.text, 'When') });
    when.addEventListener('input', () => set('When', when.value));
    const task = el('textarea', { rows: '5', 'aria-label': 'Task', placeholder: 'Open these five product pages, note any price change since the last run, write a short summary.' });
    task.value = fieldGet(e.text, 'Task');
    task.addEventListener('input', () => set('Task', task.value));
    const tools = fieldGet(e.text, 'Tools');
    return el('div', { class: 'ag-form' },
      field('Name', name),
      field('Agent', who, names.length ? (e.pc ? `Hired on ${e.pc.name} if it has no Agent of that name.` : '') : 'Hire one first: Hire staff, role Agent.'),
      !names.length ? el('div', { class: 'ag-actions' }, el('button', { class: 'btn', type: 'button', text: 'Hire an Agent', onclick: () => app.openHire?.({ role: 'agent' }) })) : '',
      field('When', when, 'For example: Every weekday at 07:00; Every 6 hours; When a file lands in inbox; By hand. Several, with ; between them.'),
      el('datalist', { id: 'ag-when-list' }, ...WHEN_EXAMPLES.map(w => el('option', { value: w }))),
      el('label', { class: 'field ag-field' }, el('span', { text: 'Task' }), task),
      el('p', { class: 'hint', text: `Tools: ${tools || 'none'}. Pages, results, limits and memory are as in the recipe: Edit as text to change them.` }));
  }
  const blank = () => ['Name: ', `Agent: ${ag.data?.agents?.[0]?.name ?? ''}`, 'When: Every weekday at 07:00', 'Task: ', 'Pages: ', 'Tools: web pages, working notes, calculate', 'Results: folder ""; keep 30 runs', 'Stop after: 20 rounds, 15 minutes, 40,000 words read', 'Wait at most: 60 minutes', 'Memory: no'].join('\n');

  function drawEdit(main) {
    const e = ag.edit;
    const card = el('div');
    const changed = () => { e.checked = null; card.replaceChildren(); };
    const box = el('textarea', { 'aria-label': 'The recipe', spellcheck: 'false' });
    box.value = e.text;
    box.addEventListener('input', () => { e.text = box.value; changed(); });
    const flip = el('button', { class: 'link', type: 'button', text: e.form ? 'Edit as text' : 'Back to the short form', onclick: () => { e.form = !e.form; drawEdit(main); } });
    const check = async () => {
      say('');
      try {
        e.checked = e.pc ? await localCheck(e.text) : await api('/api/agents', { action: 'check', text: e.text });
        drawCard(card);
      } catch (err) {
        say(err.message, true);
      }
    };
    main.replaceChildren(el('section', { class: 'ag-part ag-edit' },
      el('h3', { text: `${e.id ? 'Edit' : 'New'} standing job${e.pc ? ` on ${e.pc.name}` : ''}` }),
      el('p', { class: 'hint', text: e.form ? 'Fill in these four; the rest of the recipe keeps its usual tools and limits. Check reads it and names anything it could not; nothing runs until you approve its tools.' : 'The whole recipe: one "Field: value" per line. A line with no field carries on the one above (a long task). Check reads it and names anything it could not; nothing runs until you approve its tools.' }),
      e.form ? formPart(e, changed) : box,
      el('div', { class: 'ag-actions' }, flip),
      el('div', { class: 'ag-actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Check', onclick: check }), el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => { ag.edit = null; draw(); } })),
      card));
    if (e.checked) drawCard(card);
  }

  /** A recipe for a linked PC is checked on that PC (its Agents), as it will be when saved there. */
  async function localCheck(text) {
    return api('/api/agents/remote', { pc: ag.edit.pc.pc, action: 'check', text });
  }

  function drawCard(card) {
    const e = ag.edit;
    const c = e.checked;
    if (!c) return card.replaceChildren();
    const parts = [];
    if (c.problems.length) parts.push(el('div', { class: 'ag-card' }, el('strong', { text: 'Not kept yet: put these right, then Check again' }), el('ul', { class: 'ag-problems' }, ...c.problems.map(p => el('li', { text: p })))));
    if (c.notes?.length) parts.push(el('div', { class: 'ag-card' }, el('strong', { text: 'Read with these notes' }), el('ul', {}, ...c.notes.map(p => el('li', { text: p })))));
    const r = c.recipe;
    parts.push(el('div', { class: 'ag-card' }, el('strong', { text: 'As TOMLIN read it' }), el('ul', {},
      el('li', { text: `Name: ${r.name || '(none)'}` }), el('li', { text: `Agent: ${(ag.data?.agents ?? []).find(x => x.id === r.agent)?.name ?? r.agent}${e.pc ? ` (hired on ${e.pc.name} if it has no Agent of that name)` : ''}` }), el('li', { text: `When: ${c.text.split('\n').find(l => l.startsWith('When:'))?.slice(5).trim() ?? ''}` }),
      el('li', { text: `Pages: ${r.pages.length ? r.pages.join(', ') : 'none'}` }), el('li', { text: `Results: folder "${r.results.folder}", the last ${r.results.keep} runs kept` }),
      el('li', { text: `Stops after ${r.stop.rounds} rounds, ${r.stop.minutes} minutes or ${r.stop.words.toLocaleString('en-GB')} words read; waits at most ${r.waitMinutes} minutes for its PC` }))));
    if (!c.problems.length) {
      const yes = el('button', { class: 'btn primary', type: 'button', text: 'Approve and save', onclick: () => save() });
      parts.push(el('div', { class: 'ag-card', role: 'group', 'aria-label': 'Approve its tools' },
        el('strong', { text: 'Approve its tools: this is the only permission it has' }),
        el('p', { class: 'hint', text: 'Each run may use these, and only these. Anything else it wants is held and listed in its report, never asked.' }),
        el('ul', {}, ...(c.approval.tools.length ? c.approval.tools.map(t => el('li', { text: t })) : [el('li', { text: 'No tools: it can only write from its memory and the task.' })])),
        el('p', { class: 'hint', text: `Never, whatever the recipe says: ${c.approval.never.join('; ')}.` }),
        c.approval.leak ? el('p', { class: 'fault', text: c.approval.leak }) : '',
        c.warning ? el('p', { class: 'fault', text: c.warning }) : '',
        el('div', { class: 'ag-actions' }, yes)));
    }
    card.replaceChildren(...parts);
  }

  async function save() {
    const e = ag.edit;
    try {
      const body = { action: 'save', text: e.text, approve: true, ...(e.id ? { job: e.id, id: e.id } : {}) };
      if (e.pc) {
        // On a linked PC: the Agent named is hired there when it has none of that name (it answers on its loaded model).
        const name = e.checked?.recipe?.agent ?? '';
        await api('/api/agents/remote', { ...body, pc: e.pc.pc, hire: { name } });
        ag.others = (await api('/api/agents/others')).pcs;
      } else ag.data = await api('/api/agents', body);
      ag.edit = null;
      say('Saved and approved.');
      draw();
    } catch (err) {
      say(err.message, true);
    }
  }

  // ---- Starters and the chatbot prompt ----

  function startersPart() {
    const list = el('div', { class: 'ag-starters' }, ...(ag.help?.starters ?? []).map(s => el('div', { class: 'ag-card' },
      el('strong', { text: s.name }), el('p', { class: 'hint', text: s.about }),
      el('button', { class: 'btn', type: 'button', text: 'Use this', onclick: () => openEdit(null, null, s.text.replace(/^Agent: $/m, `Agent: ${ag.data?.agents?.[0]?.name ?? ''}`)) }))));
    return el('section', { class: 'ag-part', 'aria-labelledby': 'ag-starters-title' }, el('h3', { id: 'ag-starters-title', text: 'Starters' }), el('p', { class: 'hint', text: 'Each opens as a filled recipe to change: put in your own pages and topics before you approve it.' }), list);
  }

  function openStarters() {
    ag.edit = null;
    ag.report = null;
    draw();
    // With no job yet the Starters are on the page already.
    if (!$('#ag-starters-title')) $('#agents-main').prepend(startersPart());
    $('#ag-starters-title').scrollIntoView({ block: 'nearest' });
  }

  function openChatbot() {
    ag.edit = null;
    ag.report = null;
    draw();
    const box = el('textarea', { class: 'ag-prompt', readonly: true, rows: '14', 'aria-label': 'The prompt for a chatbot' });
    box.value = ag.help?.prompt ?? '';
    $('#agents-main').prepend(el('section', { class: 'ag-part' }, el('h3', { text: 'Write a recipe with a chatbot' }),
      el('p', { class: 'hint', text: 'Copy this to Claude, or any chatbot, and add what you want the job to do. Paste the recipe it gives back into New standing job (Edit as text): TOMLIN checks every line before anything is kept.' }),
      box, el('div', { class: 'ag-actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Copy the prompt', onclick: async () => { try { await navigator.clipboard.writeText(box.value); say('Prompt copied.'); } catch { box.select(); say('Press Ctrl+C to copy it.'); } } }), el('button', { class: 'btn', type: 'button', text: 'New standing job', onclick: () => { openEdit(null); ag.edit.form = false; draw(); } }))));
  }

  // ---- A report ----

  async function openReport(run) {
    try {
      ag.report = await api(`/api/agents/report?run=${encodeURIComponent(run)}`);
      ag.edit = null;
      draw();
      api('/api/agents', { action: 'seen', runs: [run] }).then(() => app.refreshHome?.(), () => undefined);
    } catch (e) {
      say(e.message, true);
    }
  }

  function drawReport(main) {
    const r = ag.report;
    const run = r.run ?? {};
    const mine = !run.from && (ag.data?.agents ?? []).some(a => a.id === run.agent);
    const job = (ag.data?.jobs ?? []).find(j => j.id === run.job);
    main.replaceChildren(el('section', { class: 'ag-part ag-report' },
      el('div', { class: 'ag-actions' }, el('button', { class: 'btn', type: 'button', text: '‹ All jobs', onclick: () => { ag.report = null; draw(); } }),
        mine ? el('button', { class: 'btn primary', type: 'button', text: 'Ask about this', title: `A new chat with ${run.agentName}: an ordinary chat, with your own permissions`, onclick: () => app.askAboutReport({ agent: run.agent, path: r.path, at: run.started ?? run.added, text: r.text }) }) : '',
        job && !run.from ? el('button', { class: 'btn', type: 'button', text: 'Next run, also…', onclick: () => noteBox(job) }) : ''),
      el('div', { id: 'ag-note-box' }),
      el('p', { class: 'hint', text: `In the workspace: ${r.path.replace(/\//g, '\\')}` }),
      el('pre', { text: r.text })));
  }

  /** "Next run, also: ...": one note kept with the job for its next run only (not a recipe change, so no approving). */
  function noteBox(job) {
    const box = el('textarea', { rows: '3', maxlength: '600', 'aria-label': 'A note for the next run only', placeholder: 'Also check the delivery price.' });
    box.value = job.nextNote ?? '';
    const send = async (anyway = false) => {
      try {
        ag.data = await api('/api/agents', { action: 'note', job: job.id, text: box.value, ...(anyway ? { anyway: true } : {}) });
        say(box.value.trim() ? 'Kept for the next run only.' : 'The note is taken off.');
        $('#ag-note-box').replaceChildren();
      } catch (e) {
        if (e.status === 409 && !anyway && await askYes(e.message, 'Keep it anyway')) return send(true);
        say(e.message, true);
      }
    };
    $('#ag-note-box').replaceChildren(el('div', { class: 'ag-card ag-set' }, el('strong', { text: 'Next run, also' }),
      el('p', { class: 'hint', text: 'Given to the next run only, then cleared. It does not change the recipe, so nothing needs approving again. At most 600 characters.' }),
      box, el('div', { class: 'ag-actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Keep for the next run', onclick: () => send() }), el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => $('#ag-note-box').replaceChildren() }))));
    box.focus();
  }

  /**
   * N4: a new, ordinary chat with the Agent who wrote a report (his own permissions and rounds, not the recipe's tools;
   * it starts no run), the report added to it as a document (the paperclip's way, read by the prompt scan), and the
   * first line filled in.
   */
  app.askAboutReport = async ({ agent, path, at, text }) => {
    try {
      const r = await api('/api/chats/new', { who: `staff:${agent}` });
      await app.showOpened(r);
      const d = new Date(at);
      const when = Number.isNaN(d.getTime()) ? '' : ` from ${d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
      const name = `report ${when.replace(/^ from /, '').replace(/[^\w ]+/g, '').trim() || 'agent'}.md`;
      if (typeof text === 'string' && app.addDocs) await app.addDocs([new File([text], name, { type: 'text/markdown' })]);
      const input = $('#chat-input');
      input.value = `About your report${when} (${typeof text === 'string' && app.addDocs ? `added to this chat as ${name}` : `in the workspace: ${path}`}): `;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {
      say(`No chat was started: ${e.message}`, true);
    }
  };

  // ---- Settings: while he uses this PC (N1) ----

  async function openSettings() {
    ag.edit = null;
    ag.report = null;
    try {
      ag.settings = await api('/api/agents/settings');
    } catch (e) {
      return say(e.message, true);
    }
    draw();
  }

  async function saveSettings(body, said = 'Saved.') {
    try {
      ag.settings = await api('/api/agents/settings', body);
      say(said);
      draw();
    } catch (e) {
      say(e.message, true);
    }
  }

  function drawSettings(main) {
    const st = ag.settings;
    const u = st.inUse;
    const allow = el('input', { type: 'checkbox', id: 'ag-while-use' });
    allow.checked = u.whileInUse;
    allow.addEventListener('change', () => saveSettings({ inUse: { whileInUse: allow.checked } }));
    const mins = el('input', { type: 'number', min: '1', max: '120', step: '1', id: 'ag-key-minutes', value: String(u.keyMinutes), disabled: u.whileInUse });
    mins.addEventListener('change', () => saveSettings({ inUse: { keyMinutes: Number(mins.value) } }));
    const inUse = el('section', { class: 'ag-part ag-set', 'aria-labelledby': 'ag-set-use' }, el('h3', { id: 'ag-set-use', text: 'While you use this PC' }),
      el('label', { class: 'ag-check' }, allow, ' Agents may run while I use this PC'),
      el('p', { class: 'hint', text: u.whileInUse
        ? 'A timed run starts even while a game or another full-screen program is in front, or you are at the keyboard.'
        : 'A timed run waits while a game or another full-screen program is in front, while another program keeps the graphics card busy, or after a key press. It is skipped, with the reason, after its "Wait at most". Chats and pictures you start yourself never wait for this.' }),
      el('label', { class: 'field ag-field' }, el('span', { text: 'Count me as using it for this many minutes after a key press' }), mins),
      el('p', { class: 'hint', text: `${u.chosen ? '' : `Not set yet: ${st.node ? 'on, as this PC is a node' : 'off, as this PC is not a node'}. `}TOMLIN reads only whether a full-screen program is in front, how busy the graphics card is and when a key was last pressed, never a window's or program's name.${u.now ? ` Now: ${u.now.replace(/ was /, ' is ')}.` : ''}` }));
    main.replaceChildren(el('div', { class: 'ag-actions' }, el('button', { class: 'btn', type: 'button', text: '‹ All jobs', onclick: () => { ag.settings = null; draw(); } })), inUse, phonePart(st.phone), calendarPart(st.calendars ?? []));
  }

  function calendarPart(list) {
    const add = el('textarea', { rows: '2', id: 'ag-cal-add', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Calendar addresses to add, one per line', placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics' });
    return el('section', { class: 'ag-part ag-set', 'aria-labelledby': 'ag-set-cal' }, el('h3', { id: 'ag-set-cal', text: 'Calendar' }),
      el('p', { class: 'hint', text: 'For a job with the Calendar tool: give your calendar\'s secret iCal address (Google: Settings, your calendar, Secret address in iCal format; Outlook: Shared calendars, Publish a calendar, ICS; Apple: Public calendar). TOMLIN fetches it itself and gives the job only the events; the agent never sees the address and can never add, change or answer anything. Kept secret: shown shortened, never in a backup sent to another PC.' }),
      list.length ? el('ul', { class: 'ag-held' }, ...list.map((c, i) => el('li', {}, `${c} `, el('button', { class: 'link', type: 'button', text: 'Take it off', onclick: () => saveSettings({ dropCalendar: i }, 'Taken off.') })))) : el('p', { class: 'hint', text: 'No calendar is set.' }),
      el('label', { class: 'field ag-field' }, el('span', { text: 'Add (one address per line)' }), add),
      el('div', { class: 'ag-actions' },
        el('button', { class: 'btn primary', type: 'button', text: 'Add', onclick: () => saveSettings({ addCalendars: add.value }, 'Kept.') }),
        list.length ? el('button', { class: 'btn', type: 'button', text: 'Test', onclick: async () => { try { const r = await api('/api/agents/settings', { action: 'test-calendar' }); ag.settings = r; draw(); say(r.said); } catch (e) { say(e.message, true); } } }) : ''));
  }

  function phonePart(p) {
    const on = el('input', { type: 'checkbox', id: 'ag-phone-on' });
    on.checked = p.on;
    const server = el('input', { type: 'text', id: 'ag-phone-server', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://ntfy.sh, or your own ntfy server', value: p.server });
    const topic = el('input', { type: 'password', id: 'ag-phone-topic', autocomplete: 'off', spellcheck: 'false', placeholder: p.hasTopic ? `Kept: ${p.topic}` : 'The topic your phone subscribes to' });
    const changed = el('input', { type: 'checkbox', id: 'ag-phone-changed' });
    changed.checked = p.onlyChanged;
    const body = () => ({ phone: { on: on.checked, server: server.value, onlyChanged: changed.checked, ...(topic.value.trim() ? { topic: topic.value.trim() } : {}) } });
    on.addEventListener('change', () => saveSettings(body()));
    changed.addEventListener('change', () => saveSettings(body()));
    return el('section', { class: 'ag-part ag-set', 'aria-labelledby': 'ag-set-phone' }, el('h3', { id: 'ag-set-phone', text: 'Agent summaries to my phone' }),
      el('label', { class: 'ag-check' }, on, ' Send a finished run\'s one-line summary to my phone'),
      el('p', { class: 'hint', text: 'Through ntfy: install the ntfy app on your phone and subscribe to a topic. TOMLIN sends only the summary line with the agent\'s and the job\'s names, never the report, a page, a file or memory, and only for jobs you tick. On ntfy.sh that line goes through a public server; your own ntfy server keeps it on your network.' }),
      el('label', { class: 'field ag-field' }, el('span', { text: 'Server' }), server),
      el('label', { class: 'field ag-field' }, el('span', { text: 'Topic (kept secret: shown masked, never in a backup sent to another PC)' }), topic),
      el('label', { class: 'ag-check' }, changed, ' Only when something changed (a run that found nothing new is not sent)'),
      el('div', { class: 'ag-actions' },
        el('button', { class: 'btn primary', type: 'button', text: 'Save', onclick: () => saveSettings(body()) }),
        el('button', { class: 'btn', type: 'button', text: 'Test', onclick: async () => { await saveSettings(body(), ''); try { const r = await api('/api/agents/settings', { action: 'test-phone' }); ag.settings = r; say(r.said); draw(); } catch (e) { say(e.message, true); } } }),
        p.hasTopic ? el('button', { class: 'btn quiet', type: 'button', text: 'Forget the topic', onclick: () => saveSettings({ phone: { clearTopic: true } }, 'The topic is forgotten.') }) : ''),
      el('p', { class: 'hint', text: p.jobs.length ? `Ticked: ${p.jobs.join(', ')}.` : 'No job is ticked yet: tick "Send its summary to my phone" on a job.' }),
      ...(p.notSent ?? []).map(t => el('p', { class: 'fault', text: t })));
  }

  // ---- Home: a run came back ----

  app.agentCard = (x, key) => {
    const go = el('button', { class: 'btn primary', type: 'button', text: x.action, 'data-key': key, onclick: async () => {
      // Opened, the line has been seen (a failed run has no report: the page shows its job and why).
      if (!x.report || x.kind === 'agent-quiet') await api('/api/agents', { action: 'seen', runs: x.runs }).catch(() => undefined);
      await app.openAgents(x.report && x.kind !== 'agent-quiet' ? { run: x.runs[x.runs.length - 1], back: 'home' } : { back: 'home' });
      app.refreshHome?.();
    } });
    const off = el('button', { class: 'btn quiet', type: 'button', text: 'Seen', title: 'Take this line off Home', 'data-key': `${key}:seen`, onclick: async () => { await api('/api/agents', { action: 'seen', runs: x.runs }).catch(() => undefined); app.refreshHome?.(); } });
    const ask = x.askAgent ? el('button', { class: 'btn', type: 'button', text: 'Ask about this', 'data-key': `${key}:ask`, onclick: async () => {
      try {
        const rep = await api(`/api/agents/report?run=${encodeURIComponent(x.runs[0])}`);
        await api('/api/agents', { action: 'seen', runs: x.runs }).catch(() => undefined);
        await app.askAboutReport({ agent: x.askAgent, path: rep.path, at: rep.run?.started ?? x.at, text: rep.text });
        app.refreshHome?.();
      } catch (e) {
        say(e.message, true);
      }
    } }) : '';
    return el('article', { class: `home-item k-agent` },
      el('div', { class: 'home-item-text' }, el('strong', { text: x.text }), el('span', { class: 'hint', text: x.detail })),
      el('div', { class: 'home-item-actions' }, go, ask, off));
  };

  $('#agents-back').addEventListener('click', () => setView(ag.back || 'home'));
  // Chat permissions' line: standing jobs' tools are approved on this page, per job.
  $('#perms-agents-open')?.addEventListener('click', () => app.openAgents({ back: 'perms' }));
}
