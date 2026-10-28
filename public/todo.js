// The To Do (Home's right panel, its third tab; the server's part is src/todo.ts): Today, This week and This month,
// each row a project, a size and an optional note, put there by hand. + Add (or a project folder's ⋯ › Add to To Do… on
// the Projects page) puts one in; a recent project's card on Home drags onto a part (over the To Do tab, it opens).
// Rows drag between parts, or move from their ⋯ menu (keyboard and touch). A tick moves a row to Done today; rows done
// before today show for this week, this month, or not at all. Quick checks (a project looked at every week or month)
// come into Today by themselves, 1 or 2 a day. My day sets the day's hours.
// Uses app.js's helpers ($, el, api, store, app, sayHere).
'use strict';

const todoUi = { data: null, at: 0, day: '' };
const TODO_ITEM = 'application/x-tomlin-todo';
const TODO_PROJECT = 'application/x-tomlin-project';
const todoDlg = $('#todo-dlg');
const todoZoneName = z => ({ today: 'Today', week: 'This week', month: 'This month' }[z] || z);

async function todoLoad() {
  try {
    todoUi.data = await api('/api/todo');
    todoUi.at = Date.now();
    todoUi.day = new Date().toDateString();
  } catch (err) {
    if (err.status !== 423) sayHere($('#home-todo-ask'), `The To Do could not be read: ${err.message}`);
  }
  drawTodo();
}
// Read at start, after every change, and once a minute (a new day brings carried rows and quick checks).
todoLoad();
setInterval(() => {
  if (Date.now() - todoUi.at > 60_000 || new Date().toDateString() !== todoUi.day) todoLoad();
}, 15_000);

/** A change; then the To Do is read again. A refusal is said in the panel, in its own words. */
async function todoCall(path, body) {
  try {
    await api(path, body);
  } catch (err) {
    sayHere($('#home-todo-ask'), err.message);
  }
  await todoLoad();
}

const todoSelect = (label, options, value, cls = 'todo-sel') => el('select', { class: cls, 'aria-label': label },
  ...options.map(([v, t]) => el('option', { value: String(v), selected: String(v) === String(value) }, t)));
const todoSizes = (value, label, short) => todoSelect(label, (todoUi.data?.sizes ?? []).map(s => [s.min, short && s.min < 60 ? 'Quick' : s.text]), value);
const todoCheckOf = project => todoUi.data?.checks?.find(c => c.project === project)?.every ?? 'off';
const todoEvery = value => todoSelect('Quick check', [['off', 'No quick check'], ['week', 'Quick check every week'], ['month', 'Quick check every month']], value);
const todoField = (label, input) => el('label', { class: 'field' }, el('span', { text: label }), input);

/** Opens the To Do's window with these parts and buttons. */
function todoWindow(title, kids, buttons) {
  todoDlg.replaceChildren(el('div', { class: 'help-body' }, el('h2', { id: 'todo-dlg-title', text: title }), ...kids, el('div', { class: 'team-actions todo-dlg-actions' }, ...buttons)));
  if (!todoDlg.open) todoDlg.showModal();
}
const todoCancel = () => el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => todoDlg.close() });

/** + Add: a project (TOMLIN's first, then the project folders), where, the size, a note, and its quick check. */
function todoAddWindow(project = null, zone = 'today') {
  const list = todoUi.data?.projects ?? [];
  if (!list.length) {
    sayHere($('#home-todo-ask'), 'There is no project to add yet. Make one with "Lets create a project" on Home, or add a project folder on the Projects page (left panel).');
    return;
  }
  const chosen = project && list.some(p => p.ref === project) ? project : list[0].ref;
  const group = (label, type) => {
    const ps = list.filter(p => p.type === type).sort((a, b) => a.name.localeCompare(b.name));
    return ps.length ? el('optgroup', { label }, ...ps.map(p => el('option', { value: p.ref, selected: p.ref === chosen }, p.name))) : null;
  };
  const pick = el('select', { class: 'todo-sel', 'aria-label': 'Project' }, group('TOMLIN projects', 'job'), group('Project folders (Projects page)', 'folder'));
  const where = todoSelect('When', [['today', 'Today'], ['week', 'This week'], ['month', 'This month']], zone);
  const size = todoSizes(60, 'How long');
  const note = el('input', { type: 'text', maxlength: '120', placeholder: 'What to do (optional), e.g. fix the header', 'aria-label': 'Note', autocomplete: 'off' });
  const every = todoEvery(todoCheckOf(chosen));
  pick.addEventListener('change', () => { every.value = todoCheckOf(pick.value); });
  const fault = el('p', { class: 'hint todo-fault', role: 'alert', hidden: true });
  const go = el('button', { class: 'btn primary', type: 'button', text: 'Add', onclick: async () => {
    const was = todoCheckOf(pick.value);
    go.disabled = true;
    try {
      await api('/api/todo/add', { project: pick.value, zone: where.value, size: Number(size.value), note: note.value, ...(every.value !== 'off' ? { every: every.value } : {}) });
      if (every.value === 'off' && was !== 'off') await api('/api/todo/check', { project: pick.value, every: 'off' });
      todoDlg.close();
      app.homeTab?.('tab-home-todo');
    } catch (err) {
      fault.textContent = err.message;
      fault.hidden = false;
      go.disabled = false;
      return;
    }
    await todoLoad();
  } });
  note.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
  todoWindow('Add to the To Do', [
    todoField('Project', pick),
    el('div', { class: 'todo-dlg-row' }, todoField('When', where), todoField('How long', size)),
    todoField('Note', note), todoField('Quick check', every),
    el('p', { class: 'hint', text: 'A quick check comes into Today by itself when it is due (15 min), so a project is never forgotten. A row stays until you tick it.' }),
    fault,
  ], [go, todoCancel()]);
  (project ? where : pick).focus();
}

function todoNoteWindow(it) {
  const note = el('input', { type: 'text', maxlength: '120', value: it.note, 'aria-label': 'Note', autocomplete: 'off' });
  const save = el('button', { class: 'btn primary', type: 'button', text: 'Save', onclick: () => { todoDlg.close(); todoCall('/api/todo/set', { item: it.id, note: note.value }); } });
  note.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
  todoWindow(`Note for ${it.name}`, [todoField('Note (one line, up to 120 letters)', note)], [save, todoCancel()]);
  note.focus();
}

/** My day: the hours in a day, how many quick checks a day, and every quick check with its next date. */
function todoDayWindow() {
  const s = todoUi.data.settings;
  const hours = todoSelect('Hours in my day', Array.from({ length: 25 }, (_, i) => 4 + i / 2).map(h => [h, `${h} h`]), s.dayHours);
  const per = todoSelect('Quick checks a day', [[1, '1 a day'], [2, '2 a day']], s.checksPerDay);
  const fmt = d => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const rows = (todoUi.data.checks ?? []).map(c => el('li', { class: 'todo-check-row' },
    el('span', {}, el('b', { text: c.name }), ` · every ${c.every} · `, c.due ? el('span', { class: 'todo-due', text: 'due now' }) : `next ${fmt(c.next)}`),
    el('button', { class: 'btn quiet', type: 'button', text: 'Off', title: `Stop the quick checks for ${c.name}`, onclick: async () => { await todoCall('/api/todo/check', { project: c.project, every: 'off' }); todoDayWindow(); } })));
  const save = el('button', { class: 'btn primary', type: 'button', text: 'Save', onclick: () => { todoDlg.close(); todoCall('/api/todo/settings', { dayHours: Number(hours.value), checksPerDay: Number(per.value) }); } });
  todoWindow('My day', [
    el('div', { class: 'todo-dlg-row' }, todoField('Hours in my day', hours), todoField('Quick checks into Today', per)),
    el('p', { class: 'hint', text: 'Today adds up the sizes of its rows against your day, and says so when it goes over. Nothing is refused.' }),
    el('h3', { text: 'Quick checks' }),
    rows.length ? el('ul', { class: 'todo-checks' }, ...rows) : el('p', { class: 'hint', text: 'None yet. Add one from + Add, or a row\'s ⋯ menu.' }),
  ], [save, todoCancel()]);
}

/** A row: the tick, the project (and its note), its size, and ⋯ (open, move, note, quick check, remove). */
function todoRow(it, zone, open) {
  const tick = el('input', { type: 'checkbox', checked: it.done, 'aria-label': `Done: ${it.name}`, onchange: e => todoCall('/api/todo/done', { item: it.id, done: e.target.checked }) });
  const size = todoSizes(it.size, `How long: ${it.name}`, true);
  size.addEventListener('change', () => todoCall('/api/todo/set', { item: it.id, size: Number(size.value) }));
  const item = (text, fn, extra = {}) => el('button', { class: 'btn quiet', type: 'button', text, onclick: e => { e.currentTarget.closest('details').open = false; fn(); }, ...extra });
  const every = todoCheckOf(it.project);
  const setEvery = (v, text) => item(text, () => todoCall('/api/todo/check', { project: it.project, every: v }), { 'aria-pressed': String(every === v) });
  const id = it.project.slice(it.project.indexOf(':') + 1);
  const menu = it.done ? null : el('details', { class: 'todo-menu', open: open.has(it.id) },
    el('summary', { class: 'btn quiet', title: `More for ${it.name}`, 'aria-label': `More for ${it.name}`, text: '⋯' }),
    el('div', { class: 'todo-menu-list', role: 'menu' },
      it.type === 'job' && !it.gone ? item('Open in Jobs', () => app.openJob?.(id)) : null,
      it.type === 'folder' && !it.gone ? item('Open the Projects page', () => { location.href = '/bridge/'; }) : null,
      ...['today', 'week', 'month'].filter(z => z !== zone).map(z => item(`Move to ${todoZoneName(z)}`, () => todoCall('/api/todo/move', { item: it.id, zone: z }))),
      item(it.note ? 'Edit note…' : 'Add a note…', () => todoNoteWindow(it)),
      setEvery('week', 'Quick check every week'), setEvery('month', 'Quick check every month'), every !== 'off' ? setEvery('off', 'No quick check') : null,
      item('Remove', () => todoCall('/api/todo/remove', { item: it.id }))));
  const day = it.done && it.doneAt && it.doneAt !== todoUi.data.today ? new Date(`${it.doneAt}T12:00:00`).toLocaleDateString([], { weekday: 'short' }) : '';
  const label = el('span', { class: 'todo-text', title: it.note ? `${it.name}: ${it.note}` : it.name },
    it.kind === 'check' ? el('span', { class: 'hint', text: 'Quick check: ' }) : null,
    el('b', { text: it.name }),
    el('span', { class: `todo-kind ${it.type}`, text: it.type === 'job' ? 'TOMLIN' : 'folder' }),
    it.gone ? el('span', { class: 'hint', text: ' (not there any more)' }) : null,
    it.note ? el('span', { class: 'todo-note', text: it.note }) : null,
    it.from ? el('span', { class: 'todo-from', text: `from ${it.from}` }) : null,
    day ? el('span', { class: 'hint', text: ` · ${day}` }) : null);
  return el('li', { class: `todo-row${it.done ? ' is-done' : ''}${it.kind === 'check' ? ' is-check' : ''}`, draggable: it.done ? null : 'true', 'data-item': it.id },
    tick, label, it.done ? el('span', { class: 'hint', text: it.sizeText }) : size, menu);
}

/** The whole tab, and the count on it (Today's open rows). */
function drawTodo() {
  const box = $('#home-todo');
  const d = todoUi.data;
  const count = $('#home-todo-count');
  count.hidden = !d?.open;
  count.textContent = d?.open ? String(d.open) : '';
  if (!d) return;
  // Not drawn again under the pointer while a ⋯ menu is open or a size is being picked; the next read draws it.
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
  const open = new Set([...box.querySelectorAll('details.todo-menu[open]')].map(m => m.closest('[data-item]')?.dataset.item));
  const t = d.total;
  const meter = el('div', { class: 'todo-meter', role: 'img', 'aria-label': t.text });
  const done = el('i', { class: 'todo-meter-done' });
  const left = el('i', { class: 'todo-meter-left' });
  done.style.width = `${Math.min(100, (t.doneMin / Math.max(t.dayMin, t.todayMin)) * 100)}%`;
  left.style.width = `${Math.min(100, (t.leftMin / Math.max(t.dayMin, t.todayMin)) * 100)}%`;
  meter.append(done, left);
  const head = el('div', { class: 'todo-head' },
    el('b', { class: t.todayMin > t.dayMin ? 'todo-over' : '', text: t.text }),
    el('button', { class: 'btn quiet', type: 'button', text: `My day: ${d.settings.dayHours} h`, title: 'The hours in your day, and your quick checks', onclick: todoDayWindow }));
  const zones = d.zones.map(z => el('section', { class: 'todo-zone', 'data-zone': z.zone, 'aria-label': z.name },
    el('div', { class: 'todo-zone-head' }, el('h3', { text: z.name }),
      el('button', { class: 'btn quiet', type: 'button', text: '+ Add', title: `Put a project in ${z.name}`, onclick: () => todoAddWindow(null, z.zone) })),
    z.items.length ? el('ul', { class: 'todo-list' }, ...z.items.map(it => todoRow(it, z.zone, open)))
      : el('p', { class: 'todo-drop', text: z.zone === 'today' ? 'Nothing for today yet. + Add, or drag a recent project here.' : '+ Add, or drag a project or a row here.' })));
  const doneToday = d.doneToday.length ? el('section', { class: 'todo-zone todo-done-today', 'aria-label': 'Done today' },
    el('div', { class: 'todo-zone-head' }, el('h3', { text: `Done today (${d.doneToday.length})` })),
    el('ul', { class: 'todo-list' }, ...d.doneToday.map(it => todoRow(it, null, open)))) : null;
  const e = d.doneEarlier;
  const show = todoSelect('Show rows done before today', [['week', 'This week'], ['month', 'This month'], ['hide', 'Hide']], e.show);
  show.addEventListener('change', () => todoCall('/api/todo/settings', { doneShow: show.value }));
  const earlier = e.items.length ? el('details', { class: 'todo-earlier-list', open: box.querySelector('details.todo-earlier-list')?.open ?? false },
    el('summary', { text: `${e.name} (${e.items.length})` }), el('ul', { class: 'todo-list' }, ...e.items.map(it => todoRow(it, null, open))))
    : el('span', { class: 'hint', text: e.show === 'hide' ? `Earlier done rows are hidden${e.hidden ? ` (${e.hidden} this week)` : ''}.` : `${e.name}: none.` });
  box.replaceChildren(head, meter, ...zones, doneToday ?? '', el('div', { class: 'todo-earlier' }, earlier, el('label', { class: 'hint todo-show' }, 'Show earlier ', show)),
    el('p', { class: 'hint todo-hint', text: 'Nothing drops off: a row stays until you tick it. A project folder goes on from the Projects page too (its ⋯ › Add to To Do…).' }));
}

// ---- Dragging: a recent project's card (Home) or a row, onto a part. Over the To Do tab, it opens. ----
document.addEventListener('dragstart', e => {
  const p = e.target.closest?.('[data-todo-project]');
  const r = e.target.closest?.('.todo-row[data-item]');
  if (r) {
    e.dataTransfer.setData(TODO_ITEM, r.dataset.item);
    e.dataTransfer.effectAllowed = 'move';
    r.classList.add('is-dragging');
  } else if (p) {
    e.dataTransfer.setData(TODO_PROJECT, p.dataset.todoProject);
    e.dataTransfer.setData('text/plain', p.dataset.todoName ?? '');
    e.dataTransfer.effectAllowed = 'copy';
  }
});
document.addEventListener('dragend', () => {
  for (const n of document.querySelectorAll('.is-dragging, .todo-zone.is-over')) n.classList.remove('is-dragging', 'is-over');
});
const todoOurs = e => e.dataTransfer && (e.dataTransfer.types.includes(TODO_ITEM) || e.dataTransfer.types.includes(TODO_PROJECT));
$('#tab-home-todo').addEventListener('dragenter', e => { if (todoOurs(e)) app.homeTab?.('tab-home-todo'); });
$('#tab-home-todo').addEventListener('dragover', e => { if (todoOurs(e)) e.preventDefault(); });
{
  const pane = $('#home-panel-todo');
  pane.addEventListener('dragover', e => {
    const z = e.target.closest('.todo-zone[data-zone]');
    if (!z || !todoOurs(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(TODO_ITEM) ? 'move' : 'copy';
    for (const o of pane.querySelectorAll('.todo-zone.is-over')) if (o !== z) o.classList.remove('is-over');
    z.classList.add('is-over');
  });
  pane.addEventListener('drop', e => {
    const z = e.target.closest('.todo-zone[data-zone]');
    if (!z || !todoOurs(e)) return;
    e.preventDefault();
    z.classList.remove('is-over');
    const item = e.dataTransfer.getData(TODO_ITEM);
    const project = e.dataTransfer.getData(TODO_PROJECT);
    if (item) {
      const before = e.target.closest('.todo-row[data-item]')?.dataset.item;
      todoCall('/api/todo/move', { item, zone: z.dataset.zone, ...(before && before !== item ? { before } : {}) });
    } else if (project) {
      todoCall('/api/todo/add', { project, zone: z.dataset.zone, size: 60 });
    }
  });
}
