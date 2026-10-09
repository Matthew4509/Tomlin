// Jobs: the plan, one step at a time or LETS GO!!! (the rest), checks, the auditor, tests, the end-of-job report, and
// worker PCs. The left column has All jobs, then the open job's Overview, its steps and See all; the Overview holds the
// Scope card and the design brief, who leads it and the roles. Uses app.js's helpers ($, el, api, gb).
'use strict';

const jobsDlg = $('#jobs');
const jobUi = { job: null, view: null, setup: null, running: null, result: null, edited: false, show: 'overview' };
const JOB_ROLES = [['coder', 'Coder'], ['writer', 'Writer'], ['artist', 'Artist (picture)'], ['designer', 'Designer (icon, logo)']];
const PICTURE_ROLES = new Set(['artist', 'designer']);
const STATUS_TEXT = { todo: 'to do', done: 'done', skipped: 'skipped' };
/** The roles of a job's team, each with its three choices: assigned, not assigned, default. */
const ROLE_SEATS = [['coder', 'Coder'], ['writer', 'Writer'], ['audit', 'Auditing']];

function jobFault(message) {
  const f = $('#jobs-fault');
  f.textContent = message ?? '';
  f.hidden = !message;
  if (message) f.scrollIntoView({ block: 'nearest' });
}

function stage(text) {
  const s = $('#job-stage');
  s.textContent = text ?? '';
  s.hidden = !text;
}

/** Posts and reads the server's event stream. `on` has a handler per event; error and refused throw. Resolves on done/finished/stopped or the end. */
async function jobStream(path, body, on = {}) {
  const ac = new AbortController();
  jobUi.running = ac;
  $('#job-stop').hidden = false;
  // A plan being made has no job open yet: its own Stop sits under the live text.
  $('#job-stop-row').hidden = !$('#job-view').hidden;
  drawFoot();
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('event-stream')) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error ?? `TOMLIN answered ${res.status}.`), { data });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let last = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: ([\w-]+)/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
        if (ev === 'error' || ev === 'refused') throw new Error(data.text);
        if (ev === 'stage') stage(data.text);
        // A step too big for its worker was split into parts while it ran: the plan is shown as it is now.
        if (ev === 'resized') showJob(data);
        on[ev]?.(data);
        if (ev === 'done' || ev === 'finished' || ev === 'stopped') last = { ev, data };
      }
    }
    if (!last) throw new Error('The answer stopped before it finished. Try again.');
    return last;
  } catch (e) {
    if (ac.signal.aborted) throw new Error('Stopped. Nothing from the unfinished step was saved.');
    throw e;
  } finally {
    jobUi.running = null;
    $('#job-stop').hidden = true;
    $('#job-stop-row').hidden = true;
    drawFoot();
  }
}

$('#job-stop').addEventListener('click', () => jobUi.running?.abort());
$('#job-stop-plan').addEventListener('click', () => jobUi.running?.abort());

/** What each code check is, in words (its tool's name kept in brackets). */
const CHECK_WORDS = {
  'node --check': 'the code reads as JavaScript (node --check)',
  'TypeScript strip + node --check': 'the code reads as TypeScript (node --check)',
  'php -l': 'the code reads as PHP (php -l)',
  'python -m py_compile': 'the code reads as Python (py_compile)',
  JSON: 'the file reads as JSON',
  'CSS brackets': 'every { has its }',
};

async function loadSetup() {
  jobUi.setup = await api('/api/jobs/setup');
  $('#job-test-cmd').replaceChildren(...jobUi.setup.tests.map(t => el('option', { value: t.id, text: t.label })));
}

// ---- Picking staff: Default, then one round icon per hire (Choose a Project manager, an assigned role, Home's Staff) ----

/**
 * A row of staff to pick from, as radio buttons drawn as chips: `first` (e.g. Default) when given, then each hire with
 * their photo or initials. `onPick(value)` is called when one is picked.
 */
function staffPick(box, name, value, staff, first, onPick) {
  const chip = (val, label, title, face) => {
    const input = el('input', { type: 'radio', name, value: val, checked: val === value });
    input.addEventListener('change', () => input.checked && onPick(val));
    return el('label', { class: 'staff-chip', title }, input, face, el('span', { text: label }));
  };
  const short = n => n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  box.replaceChildren(
    ...(first ? [chip(first.value, first.label, first.title, null)] : []),
    ...staff.map(s => chip(s.id, s.name, `${s.name} (${s.role})`, app.avatar ? app.avatar(`staff:${s.id}`, short(s.name)) : el('span', { class: 'rail-avatar', 'aria-hidden': 'true', text: short(s.name) }))));
}
app.staffPick = staffPick;

// ---- The Scope card and the design brief: copy icon and pencil, the pencil opening an editor in place ----

/** One card with its heading, a copy icon and a pencil; Save sends the text to `save(text)` and shows what came back. */
function cardBox(title, text, save) {
  const box = el('section', { class: 'card-box' });
  const show = now => {
    const pencil = el('button', { class: 'msg-copy card-edit', type: 'button', title: `Change the ${title.toLowerCase()}`, 'aria-label': `Change the ${title.toLowerCase()}` }, app.pencilIcon?.() ?? '✎');
    pencil.addEventListener('click', () => edit(now));
    box.replaceChildren(
      el('div', { class: 'card-head' }, el('h3', { text: title }), app.copyButton(now, `Copy the ${title.toLowerCase()}`, 'msg-copy card-copy'), pencil),
      el('pre', { class: 'pj-card', text: now }));
  };
  const edit = now => {
    const area = el('textarea', { class: 'card-text', rows: String(Math.min(18, Math.max(6, now.split('\n').length + 1))), maxlength: '6000', spellcheck: 'true', 'aria-label': title });
    area.value = now;
    const said = el('p', { class: 'fault', role: 'alert', hidden: true });
    const saveBtn = el('button', { class: 'btn primary', type: 'button', text: 'Save' });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      said.hidden = true;
      try {
        show(await save(area.value));
      } catch (e) {
        said.textContent = e.message;
        said.hidden = false;
        saveBtn.disabled = false;
      }
    });
    box.replaceChildren(el('div', { class: 'card-head' }, el('h3', { text: title })), area, said,
      el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => show(now) }), saveBtn));
    area.focus();
  };
  show(text);
  return box;
}
app.cardBox = cardBox;

/** The two cards of a project, each saved back into its job folder by the pencil. `after` runs once one is saved. */
function projectCards(id, cards, after) {
  const save = which => async text => {
    const r = await api('/api/projects/card', { id, which, text });
    await after?.();
    return r.text;
  };
  return [cardBox('Scope card', cards.scope, save('scope')), cardBox('Design brief', cards.design, save('design'))];
}
app.projectCards = projectCards;

// ---- The list ----

async function loadJobs() {
  const list = (await api('/api/jobs')).jobs;
  const box = $('#job-list');
  box.replaceChildren();
  const shown = list.filter(j => !j.hidden);
  const hidden = list.filter(j => j.hidden);
  if (!shown.length) box.append(el('p', { class: 'hint', text: hidden.length ? 'No jobs in the list: the ones you hid are below.' : 'No jobs yet.' }));
  const item = j => {
    const name = j.name || j.goal;
    const b = el('button', { class: `file-item${jobUi.job?.id === j.id ? ' current' : ''}`, type: 'button', title: `Last changed ${new Date(j.updated).toLocaleString()}` },
      el('span', { text: name.length > 90 ? `${name.slice(0, 90)}…` : name }), el('span', { class: 'hint', text: `${j.done} of ${j.steps} steps${j.folder ? ` · folder ${j.folder}` : ''}` }));
    b.addEventListener('click', () => openJob(j.id));
    return b;
  };
  box.append(...shown.map(item));
  // Hidden jobs stay in the workspace: open one to see it, or show it in the lists again.
  if (hidden.length) box.append(el('details', { class: 'sub' }, el('summary', { text: `Hidden jobs (${hidden.length})` }), ...hidden.map(item)));
  // Projects saved with no plan yet are found here too, not only inside Start project.
  const saved = (await api('/api/projects/setup').catch(() => null))?.saved ?? [];
  if (saved.length) box.append(el('p', { class: 'hint' }, `${saved.length} project${saved.length > 1 ? 's' : ''} saved without a plan. `, el('button', { class: 'link', type: 'button', text: 'Open Advanced project setup', onclick: () => {
    $('#jobs').close();
    app.startProject?.();
  } }), ' lists them, to make the plan.'));
}

/** Hide this job from the lists (Jobs and Home), or show it again: nothing is deleted. */
async function hideJob() {
  const job = jobUi.job;
  if (!job) return;
  const hide = !job.hidden;
  jobFault(null);
  try {
    showJob(await api('/api/jobs/change', { id: job.id, action: 'hide', hidden: hide }));
    $('#job-note').textContent = hide ? 'Hidden from the lists. Its folder and files stay in the workspace; it is under Hidden jobs in All jobs, where Show it again puts it back.' : 'Shown in the lists again.';
    await loadJobs();
    if (typeof refresh === 'function') refresh();
  } catch (e) {
    jobFault(e.message);
  }
}
$('#job-hide').addEventListener('click', hideJob);

/** Delete this job for good: its plan, notes and report go; files its steps wrote stay in the project folder. */
$('#job-delete').addEventListener('click', async () => {
  const job = jobUi.job;
  if (!job) return;
  if (!(await askHere($('#job-delete-ask'), `Delete "${job.name || job.goal}" for good? Its plan, notes and report are deleted. Files its steps wrote stay${job.folder ? ` in ${job.folder}` : ' in the workspace'}.`, 'Delete it', 'Keep it'))) return;
  jobFault(null);
  try {
    await api('/api/jobs/change', { id: job.id, action: 'delete' });
    Object.assign(jobUi, { job: null, view: null, result: null, edited: false });
    showPart('list');
    await loadJobs();
    if (typeof refresh === 'function') refresh();
  } catch (e) {
    jobFault(e.message);
  }
});

async function openJob(id, show = 'overview') {
  if (jobUi.edited && !(await askHere($('#jobs-ask'), 'This plan has changes you have not saved. Open another job and lose them?', 'Open it, lose the changes', 'Stay on this plan'))) return;
  jobFault(null);
  try {
    const view = await api(`/api/jobs/get?id=${encodeURIComponent(id)}`);
    jobUi.show = show;
    showJob(view);
    // A step that came back earlier and was neither saved nor discarded is kept on disk: show it again, on its step.
    jobUi.result = null;
    $('#job-result').hidden = true;
    const w = view.waiting;
    if (w && view.job.steps[w.n]?.status === 'todo') {
      showPart(w.n);
      showResult(view.job.steps[w.n], w.n, w.result, 0);
    }
    $('#job-log').hidden = true;
    $('#job-log').replaceChildren();
    await loadJobs();
  } catch (e) {
    jobFault(e.message);
  }
}

// ---- Which part is on the right: All jobs, the Overview, one step, or See all ----

/** `part`: 'list', 'overview', 'all', or a step's index. */
function showPart(part) {
  const list = part === 'list' || !jobUi.job;
  jobUi.show = list ? jobUi.show : part;
  $('#job-list-view').hidden = !list;
  $('#job-view').hidden = list;
  $('#job-overview').hidden = list || part !== 'overview';
  $('#job-steps-view').hidden = list || part === 'overview';
  for (const li of $('#job-steps').children) li.hidden = typeof part === 'number' && Number(li.dataset.n) !== part;
  const current = b => b.setAttribute('aria-current', 'page');
  for (const b of $('#job-nav').querySelectorAll('button')) b.removeAttribute('aria-current');
  if (list) current($('#job-nav-list'));
  else if (part === 'overview') current($('#job-nav-overview'));
  else if (part === 'all') current($('#job-nav-all'));
  else $(`#job-nav-steps button[data-n="${part}"]`)?.setAttribute('aria-current', 'page');
  $('#job-nav-job').hidden = !jobUi.job;
  drawFoot();
  jobsDlg.querySelector('.help-body').scrollTop = 0;
}
$('#job-nav-list').addEventListener('click', () => showPart('list'));
$('#job-nav-overview').addEventListener('click', () => showPart('overview'));
$('#job-nav-all').addEventListener('click', () => showPart('all'));

/** The left column's steps: Step 1, Step 2 … with how each stands. */
function drawNav(job) {
  $('#job-nav-name').textContent = job.name || job.goal;
  $('#job-nav-name').title = job.goal;
  $('#job-nav-steps').replaceChildren(...job.steps.map((s, i) => {
    const b = el('button', { class: `job-nav-item s-${s.status}`, type: 'button', 'data-n': String(i), title: s.title },
      el('span', { text: `Step ${i + 1}` }), el('span', { class: 'job-nav-mark', text: s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : '', 'aria-label': STATUS_TEXT[s.status] }));
    b.addEventListener('click', () => showPart(i));
    return el('li', {}, b);
  }));
}

// ---- The footer: LETS GO!!! ----

/** LETS GO!!! shows while a job is open: it runs the rest of the steps, saving each one that passes its checks. */
function drawFoot() {
  const job = jobUi.job;
  const foot = $('#job-foot');
  foot.hidden = !job || $('#job-view').hidden;
  if (foot.hidden) return;
  const next = job.steps.findIndex(s => s.status === 'todo');
  const picture = next >= 0 && PICTURE_ROLES.has(job.steps[next].role);
  const go = $('#job-go');
  go.disabled = next < 0 || picture || !!jobUi.running || jobUi.edited || !!jobUi.result;
  // The queue draws a picture step by itself (the artist on their PC), so it is open for one.
  $('#job-queue').disabled = next < 0 || !!jobUi.running || jobUi.edited || !!jobUi.result;
  $('#job-foot-line').textContent = jobUi.running ? 'Working…'
    : next < 0 ? 'All steps finished.'
    : picture ? `Step ${next + 1} is a picture: draw it in an artist's chat, then Mark done, or Add to the queue (the artist draws it by itself).`
    : jobUi.edited ? 'Save the plan changes first.'
    : jobUi.result ? `What came back for step ${(jobUi.result.n ?? 0) + 1} is waiting: save it or throw it away first.`
    : `${job.steps.filter(s => s.status === 'todo').length} step${job.steps.filter(s => s.status === 'todo').length > 1 ? 's' : ''} to go, from step ${next + 1}.`;
}

// ---- The Overview: the cards, who leads it and the roles ----

/** Saves the team as it is on screen, with `change` applied (a seat or the expectations). */
async function saveTeam(change) {
  const job = jobUi.job;
  if (!job) return;
  const said = $('#job-team-said');
  said.textContent = 'Saving…';
  try {
    const view = await api('/api/jobs/change', { id: job.id, action: 'team', team: { ...jobUi.view.team, ...change } });
    showJob(view);
    said.textContent = 'Saved.';
  } catch (e) {
    said.textContent = '';
    jobFault(e.message);
  }
}

function drawTeam(view) {
  const staff = jobUi.setup?.staff ?? [];
  const team = view.team;
  staffPick($('#job-pm'), 'job-pm', team.pm, staff, { value: '', label: 'Default', title: 'The strongest worker available' }, v => saveTeam({ pm: v }));
  $('#job-pm-line').textContent = `Plans it: ${view.doers?.pm ?? ''}${staff.length ? '' : ' Hire staff (Settings, Set up, Staff) to pick who leads it.'}`;
  const rows = ROLE_SEATS.map(([seat, label]) => {
    const now = team[seat];
    const assigned = now !== 'default' && now !== 'none';
    const pick = el('div', { class: 'staff-pick job-role-pick', role: 'radiogroup', 'aria-label': `${label}: who is assigned`, hidden: !assigned });
    staffPick(pick, `job-${seat}-who`, now, staff, null, v => saveTeam({ [seat]: v }));
    if (!staff.length) pick.replaceChildren(el('span', { class: 'hint' }, 'Nobody hired yet. ', el('button', { class: 'link', type: 'button', text: 'Hire one', onclick: () => app.openHire() })));
    const choice = (value, text) => {
      const input = el('input', { type: 'radio', name: `job-${seat}`, value, checked: value === 'assigned' ? assigned : value === now });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        // Assigned waits for a hire to be picked; the other two are saved at once.
        if (value === 'assigned') {
          pick.hidden = false;
          return;
        }
        pick.hidden = true;
        saveTeam({ [seat]: value });
      });
      return el('label', { class: 'check' }, input, ` ${text}`);
    };
    return el('div', { class: 'job-role' },
      el('div', { class: 'job-role-line' }, el('strong', { text: `${label}:` }), el('div', { class: 'job-role-choices', role: 'radiogroup', 'aria-label': label }, choice('assigned', 'assigned'), choice('none', 'not assigned'), choice('default', 'default'))),
      pick,
      el('p', { class: 'hint job-doer', text: `Does it now: ${view.doers?.[seat] ?? ''}` }));
  });
  $('#job-roles').replaceChildren(...rows);
  const expect = $('#job-expect');
  if (document.activeElement !== expect) expect.value = team.expect ?? '';
  // Nobody audits: no reviewer, no end-of-job report, and no expectations to give.
  const audits = team.audit !== 'none';
  $('#job-expect-row').hidden = !audits;
  $('#job-final-box').hidden = !audits;
  $('#job-review-each-row').hidden = !audits;
  $('#job-ask-review').hidden = !audits;
  if (!audits) $('#job-review-each').checked = false;
}
$('#job-expect').addEventListener('change', () => saveTeam({ expect: $('#job-expect').value }));

// ---- The steps ----

function markEdited() {
  jobUi.edited = true;
  $('#job-save').disabled = false;
  $('#job-run').disabled = true;
  $('#job-note').textContent = 'Save the plan changes before running a step.';
  drawFoot();
}

/** Mark done (did it myself): a line under the step asks what was done, for the later steps; nothing is saved until Mark done. */
function markDone(li, i) {
  li.querySelector('.job-done-ask')?.remove();
  const what = el('input', { type: 'text', maxlength: '400', placeholder: 'e.g. added the logo by hand' });
  const ask = el('form', { class: 'job-done-ask' },
    el('label', { class: 'field' }, el('span', { text: 'What was done? One line for the later steps (optional)' }), what),
    el('div', { class: 'team-actions' }, el('button', { class: 'btn primary', type: 'submit', text: 'Mark done' }), el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => ask.remove() })));
  ask.addEventListener('submit', e => {
    e.preventDefault();
    change({ action: 'mark', n: i, status: 'done', summary: what.value });
  });
  li.append(ask);
  what.focus();
}

/** One step: finished steps read-only with their summary; waiting steps as small forms. */
function stepItem(s, i) {
  const li = el('li', { class: `job-step ${s.status}`, 'data-n': String(i) });
  li.append(el('div', { class: 'job-step-head' }, el('strong', { text: `Step ${i + 1}` }), el('span', { class: `job-badge ${s.status}`, text: STATUS_TEXT[s.status] })));
  if (s.status !== 'todo') {
    li.append(el('p', { text: s.title }), el('p', { class: 'hint', text: [s.summary, s.wrote?.length ? `Wrote ${s.wrote.join(', ')}.` : ''].filter(Boolean).join(' ') || 'No summary.' }));
    li.append(el('div', { class: 'team-actions' }, el('button', { class: 'link', type: 'button', text: 'Put back to do again', onclick: () => change({ action: 'mark', n: i, status: 'todo' }) })));
    return li;
  }
  const role = el('select', { class: 'job-role', 'aria-label': `Step ${i + 1} role` }, ...JOB_ROLES.map(([id, name]) => el('option', { value: id, text: name })));
  role.value = s.role;
  li.append(
    el('label', { class: 'field' }, el('span', { text: 'Title' }), el('input', { class: 'job-title', type: 'text', maxlength: '100', value: s.title })),
    el('div', { class: 'team-pick' },
      el('label', { class: 'field' }, el('span', { text: 'Who does it' }), role),
      el('label', { class: 'field' }, el('span', { text: 'Files it may change (commas, at most 4)' }), el('input', { class: 'job-files', type: 'text', value: s.files.join(', '), placeholder: 'e.g. index.html, app.js' }))),
    el('label', { class: 'field' }, el('span', { text: 'Instructions for this step (the worker sees only these, the files above and the names used in other files)' }), el('textarea', { class: 'job-brief', rows: '5', maxlength: '1600' }, s.brief)),
    el('label', { class: 'field' }, el('span', { text: 'How to check it worked' }), el('input', { class: 'job-check', type: 'text', maxlength: '200', value: s.check })),
    el('div', { class: 'team-actions' },
      el('button', { class: 'link', type: 'button', text: 'Mark done (did it myself)', onclick: () => markDone(li, i) }),
      el('button', { class: 'link', type: 'button', text: 'Skip', onclick: () => change({ action: 'mark', n: i, status: 'skipped' }) }),
      el('button', { class: 'link', type: 'button', text: 'Remove', onclick: () => { li.remove(); markEdited(); } })),
  );
  li.querySelectorAll('input, select, textarea').forEach(x => x.addEventListener('input', markEdited));
  return li;
}

// ---- Live preview (PLAN F10 G7): the workspace's page beside the steps, reloaded when a file changes ----
const livePreview = { open: false, key: '', stamp: '', timer: 0 };

/** The page to show first: an .html file the job's steps name (index.html first; in its project folder), else index.html, else the newest. */
function previewPick(pages) {
  const dir = jobUi.job?.folder ? `${jobUi.job.folder}/` : '';
  const named = (jobUi.job?.steps ?? []).flatMap(st => st.files).map(f => dir + f).filter(f => pages.includes(f));
  return named.find(f => /(^|\/)index\.html?$/i.test(f)) ?? named[0] ?? pages.find(f => f === `${dir}index.html`) ?? pages.find(f => /^index\.html?$/i.test(f)) ?? pages[0] ?? '';
}

function previewSrc(page) {
  return `/preview/${livePreview.key}/${page.split('/').map(encodeURIComponent).join('/')}?t=${encodeURIComponent(livePreview.stamp)}`;
}

async function previewPoll(force = false) {
  let v;
  try {
    v = await api('/api/preview');
  } catch {
    return;
  }
  const pick = $('#preview-page');
  const was = pick.value;
  $('#preview-open').hidden = !v.pages.length;
  pick.replaceChildren(...v.pages.map(f => el('option', { value: f, text: f })));
  pick.value = v.pages.includes(was) ? was : previewPick(v.pages);
  if (!livePreview.open) return;
  if (!v.pages.length) {
    $('#preview-line').textContent = 'There is no page (.html file) in the workspace yet: it shows here once a step saves one.';
    return;
  }
  const changed = v.stamp !== livePreview.stamp || v.key !== livePreview.key;
  livePreview.key = v.key;
  livePreview.stamp = v.stamp;
  if (force || changed || pick.value !== was) {
    $('#preview-frame').src = previewSrc(pick.value);
    if (changed && !force) $('#preview-line').textContent = `Reloaded at ${new Date().toLocaleTimeString()}: a file in the workspace changed. On this PC only; it cannot reach the internet or TOMLIN.`;
  }
}

function previewShow(on) {
  livePreview.open = on;
  $('#job-preview').hidden = !on;
  $('#job-split').classList.toggle('previewing', on);
  jobsDlg.classList.toggle('previewing', on);
  $('#preview-open').textContent = on ? 'Hide the preview' : 'Live preview';
  clearInterval(livePreview.timer);
  if (on) {
    livePreview.stamp = '';
    previewPoll(true);
    livePreview.timer = setInterval(() => (jobsDlg.open ? previewPoll() : previewShow(false)), 2000);
  }
}
$('#preview-open').addEventListener('click', () => previewShow(!livePreview.open));
$('#preview-close').addEventListener('click', () => previewShow(false));
$('#preview-reload').addEventListener('click', () => previewPoll(true));
$('#preview-page').addEventListener('change', () => previewPoll(true));
jobsDlg.addEventListener('close', () => previewShow(false));

/** Draws a job from the server's view: {job, team, doers, cards, swaps, swapSeconds, names, scopeChecks}. */
function showJob(view) {
  const job = view.job;
  const same = jobUi.job?.id === job.id;
  jobUi.view = view;
  jobUi.job = job;
  jobUi.edited = false;
  $('#job-goal-line').textContent = job.name || job.goal;
  const done = job.steps.filter(s => s.status !== 'todo').length;
  const next = job.steps.findIndex(s => s.status === 'todo');
  $('#job-progress').textContent = [job.name ? `Goal: ${job.goal}` : '', `${done} of ${job.steps.length} steps finished.`, job.folder ? `Its files are in the project folder ${job.folder} (in the workspace folder).` : '', `The plan is saved as jobs/${job.id}/plan.json in the workspace.`].filter(Boolean).join(' ');
  // The plan against the project's Scope card (F1, F2, …), checked by code.
  const sc = view.scopeChecks ?? [];
  $('#job-scope-checks').hidden = !sc.length;
  $('#job-scope-checks').replaceChildren(el('p', { text: 'The plan against the Scope card (checked by code):' }), el('ul', {}, ...sc.map(t => el('li', { text: t }))));
  // An editor open on a card stays open while the rest is drawn again (the team saving, a step finishing).
  if (!same || !$('#job-cards .card-text')) $('#job-cards').replaceChildren(...(view.cards ? projectCards(job.id, view.cards, async () => showJob(await api(`/api/jobs/get?id=${encodeURIComponent(job.id)}`))) : []));
  drawTeam(view);
  drawJobChats(job);
  drawJobHanded(job);
  drawJobUsage(job);
  drawNav(job);
  $('#job-steps').replaceChildren(...job.steps.map(stepItem));
  $('#job-save').disabled = true;
  const run = $('#job-run');
  const picture = next >= 0 && PICTURE_ROLES.has(job.steps[next].role);
  run.disabled = next < 0 || picture || !!jobUi.result;
  run.textContent = next < 0 ? 'All steps finished' : picture ? `Step ${next + 1} is a picture` : `Run step ${next + 1}`;
  $('#job-note').textContent = picture ? `Step ${next + 1} is a picture: draw it in an artist's chat from its brief, then press Mark done.` : '';
  if (picture) pictureStepButton(job.steps[next], next);
  drawTests(job.tests);
  $('#job-hide').textContent = job.hidden ? 'Show it again' : 'Hide this job';
  // A step shown alone that is no longer in the plan (removed, or the plan was split) goes back to the Overview.
  const part = typeof jobUi.show === 'number' && jobUi.show >= job.steps.length ? 'overview' : jobUi.show;
  showPart(same || part !== 'list' ? part : 'overview');
  previewPoll();
}

/** The chats whose work belongs to this project (picked under Project in a chat's head), each with Open. */
function drawJobChats(job) {
  const list = (typeof chatUi === 'undefined' ? [] : chatUi.list).filter(c => c.project === job.id);
  $('#job-chats').replaceChildren(...(list.length ? list.map(c => el('div', { class: 'job-chat' },
    el('span', {}, el('strong', { text: c.title }), el('span', { class: 'hint', text: ` · with ${c.name} · ${c.messages} message${c.messages === 1 ? '' : 's'}` })),
    el('button', { class: 'btn quiet', type: 'button', text: 'Open', onclick: async () => {
      jobsDlg.close();
      await app.openChat(c.id);
    } })))
    : [el('p', { class: 'hint', text: 'No chats in this project yet. In a chat, pick this project under Project (beside the chat\'s name): its code is then saved in this project\'s folder.' })]));
}

/** The work the project's specialists handed in (specialists\writer, specialists\images), newest first. */
let handedRead = { id: '', at: 0 };
async function drawJobHanded(job) {
  const box = $('#job-handed');
  // Read when the project opens, and again at most every 20 s while it is drawn again (a step running redraws often).
  if (handedRead.id === job.id && Date.now() - handedRead.at < 20_000) return;
  handedRead = { id: job.id, at: Date.now() };
  const r = await api(`/api/project/handed?id=${encodeURIComponent(job.id)}`).catch(() => null);
  if (jobUi.job?.id !== job.id) return;
  const list = r?.handed ?? [];
  const seen = new Set();
  box.replaceChildren(...(list.length ? list.slice(0, 30).map(h => {
    const newest = !seen.has(h.folder);
    seen.add(h.folder);
    return el('div', { class: 'job-chat' }, el('span', {}, el('strong', { text: h.path.split('/').pop() }), el('span', { class: 'hint', text: ` · ${h.folder}${newest ? ' · the newest' : ''}` })));
  }) : [el('p', { class: 'hint', text: 'Nothing handed in yet. What the writer writes goes in specialists\\writer, and pictures kept in this project\'s chats in specialists\\images, each named with the date and time, so the newest is easy to find.' })]));
}

/**
 * The project's final tally: every PC that worked on it (this one, and each linked PC from its own log), its tokens,
 * its power at its own watts and price, and the same tokens on each API (src/server/costs.ts).
 */
let usageRead = { id: '', at: 0 };
async function drawJobUsage(job) {
  if (usageRead.id === job.id && Date.now() - usageRead.at < 20_000) return;
  usageRead = { id: job.id, at: Date.now() };
  const r = await api(`/api/project/usage?id=${encodeURIComponent(job.id)}`).catch(() => null);
  if (jobUi.job?.id !== job.id) return;
  const box = $('#job-usage');
  if (!r?.rows?.length) return box.replaceChildren(el('p', { class: 'hint', text: 'Nothing counted for this project yet. Every answer for it from now on is (its chats, and its steps), on this PC and on linked PCs.' }));
  const line = (name, x) => {
    const c = x.costs;
    return el('div', { class: 'job-chat' }, el('span', {}, el('strong', { text: name }), el('span', { class: 'hint', text: ` · ${app.readWritten(x.tally)} tokens · ${x.tally.ms ? app.span(x.tally.ms / 1000) : 'no time'} working · power ${c.power === null ? 'not set' : app.money(c.power)} · ${c.apis.map(a => `${a.name} ${app.money(a.cost)}`).join(' · ')}` })));
  };
  box.replaceChildren(...r.rows.map(x => line(x.name, x)), ...(r.rows.length > 1 ? [line('All PCs', r.total)] : []),
    el('p', { class: 'hint', text: `Tokens: read (cached) / written. Power at each PC's own watts and price (set in its window: press it in the left panel). API prices checked ${r.checked}.` }));
}

/** A picture step: one press opens the artist's chat with the step's brief in the box (it is drawn as typed there). */
function pictureStepButton(step, n) {
  const people = typeof chatUi === 'undefined' ? [] : chatUi.people.filter(p => p.kind === 'image');
  const artist = people.find(p => (step.role === 'designer' ? /designer/i : /artist/i).test(p.role)) ?? people[0];
  const note = $('#job-note');
  if (!artist) return note.append(' Nobody draws yet: hire an artist under Settings, Set up, Staff.');
  note.append(' ', el('button', { class: 'btn', type: 'button', text: `Draw it in ${artist.name}'s chat`, onclick: async () => {
    try {
      $('#jobs').close();
      await app.openArtist(artist.who);
      $('#img-prompt').value = step.brief;
      $('#img-prompt').dispatchEvent(new Event('input'));
      $('#img-prompt').focus();
      app.imageNote?.(`Step ${n + 1} of the job, "${step.title}": its brief is in the box. Press Draw (connect the picture model first if it is not loaded). When it is drawn, open Jobs and press Mark done on step ${n + 1}.`);
    } catch (e) {
      jobFault(e.message);
    }
  } }));
}

/** The waiting steps as the person left them. */
function editedSteps() {
  return [...$('#job-steps').querySelectorAll('li.todo')].map(li => ({
    title: $('.job-title', li).value, role: $('.job-role', li).value, files: $('.job-files', li).value, brief: $('.job-brief', li).value, check: $('.job-check', li).value,
  }));
}

async function change(body) {
  jobFault(null);
  if (body.action !== 'edit' && jobUi.edited && !(await askHere($('#job-plan-ask'), 'This plan has changes you have not saved. Carry on and lose them?', 'Carry on, lose the changes', 'Stop: I will save them first'))) return;
  try {
    showJob(await api('/api/jobs/change', { id: jobUi.job.id, ...body }));
    await loadJobs();
  } catch (e) {
    jobFault(e.message);
  }
}

$('#job-save').addEventListener('click', () => change({ action: 'edit', steps: editedSteps() }));

$('#job-add').addEventListener('click', () => {
  const list = $('#job-steps');
  const n = list.children.length;
  list.append(stepItem({ title: 'New step', role: 'coder', files: [], brief: '', check: '', status: 'todo' }, n));
  showPart('all');
  markEdited();
  list.lastElementChild.querySelector('.job-title').select();
});

$('#job-new-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (jobUi.edited && !(await askHere($('#jobs-ask'), 'The plan below has changes you have not saved. Make a new plan and lose them?', 'Make a new plan, lose the changes', 'Stay on this plan'))) return;
  jobFault(null);
  const go = $('#job-plan-go');
  const out = $('#job-stream');
  showPart('list');
  progressAt('plan');
  go.disabled = true;
  out.hidden = false;
  out.textContent = 'Planning…';
  try {
    const r = await jobStream('/api/jobs/plan', { goal: $('#job-goal').value, project: jobUi.project }, { text: d => (out.textContent = d.text) });
    jobUi.project = null;
    $('#job-goal').value = '';
    jobUi.show = 'overview';
    showJob(r.data);
    $('#job-team-said').textContent = `Here is the plan from ${r.data.planner}: ${r.data.job.steps.length} steps, listed on the left. Press a step to read or change it, or LETS GO!!! to run them all.`;
    await loadJobs();
  } catch (err) {
    jobFault(err.message);
  } finally {
    out.hidden = true;
    stage(null);
    go.disabled = false;
  }
});

// ---- One step, and its result ----

function busyButtons(on) {
  for (const id of ['#job-run', '#job-go', '#job-queue', '#job-retry', '#job-accept', '#job-ask-review', '#job-test-run', '#job-final', '#job-plan-go']) $(id).disabled = on;
  // Nothing else changes the job while it runs: the steps, Add a step, Discard, Hide, the team, and opening another job.
  for (const x of document.querySelectorAll('#job-steps button, #job-steps input, #job-steps select, #job-steps textarea, #job-list button, #job-add, #job-discard, #job-hide, #job-delete, #job-team input, #job-team textarea, #job-team button, #job-nav-list')) x.disabled = on;
  if (on) progressAt('job');
}

/** The live lines (what is happening, the words coming in) go under the buttons that started them, not at the top. */
function progressAt(where) {
  const parts = [$('#job-stage'), $('#job-stream')];
  const anchor = where === 'job' && !$('#job-view').hidden ? $('#job-run').closest('.team-actions') : $('#job-new-form');
  if (anchor.nextElementSibling !== parts[0]) anchor.after(...parts);
}

async function runStep() {
  const job = jobUi.job;
  const n = job.steps.findIndex(s => s.status === 'todo');
  if (n < 0) return;
  jobFault(null);
  showPart(n);
  const out = $('#job-stream');
  busyButtons(true);
  $('#job-result').hidden = true;
  out.hidden = false;
  out.textContent = `Step ${n + 1}: working…`;
  const t0 = performance.now();
  try {
    const r = await jobStream('/api/jobs/step', { id: job.id, n }, { text: d => (out.textContent = d.text) });
    showResult(jobUi.job.steps[n], n, r.data, Math.round((performance.now() - t0) / 1000));
  } catch (err) {
    jobFault(err.message);
  } finally {
    out.hidden = true;
    stage(null);
    busyButtons(false);
    showJob(jobUi.view);
  }
}
$('#job-run').addEventListener('click', runStep);
$('#job-retry').addEventListener('click', runStep);

function checkList(r) {
  const box = el('div', { class: 'job-checks' });
  const rows = [];
  for (const c of r.checks ?? []) rows.push(el('li', { class: c.ok ? 'ok' : 'bad', text: `${c.ok ? '✓' : '✗'} ${c.path}: ${CHECK_WORDS[c.tool] ?? c.tool}${c.ok ? ' passed' : ` failed: ${c.message}`}` }));
  for (const p of (r.problems ?? []).filter(p => !/\): /.test(p))) rows.push(el('li', { class: 'bad', text: `✗ ${p}` }));
  if (rows.length) box.append(el('ul', { class: 'job-check-list' }, ...rows));
  const meta = [`Written by ${r.worker}`, r.tries > 1 ? `${r.tries} tries (a check failed and the answer went back to be fixed)` : 'first try'];
  box.append(el('p', { class: 'hint', text: `${meta.join(' · ')}.` }));
  if (r.warnings?.length) box.append(el('div', { class: 'job-warn', role: 'note' }, el('strong', { text: 'Check before saving: the files would not fit together' }), el('ul', {}, ...r.warnings.map(w => el('li', { text: w }))), el('p', { class: 'hint', text: 'Fix it in the text below, run the step again, or save and fix it in a later step.' })));
  if (r.dropped?.length) box.append(el('p', { class: 'hint', text: `Left out, because this step may not write them: ${r.dropped.join(', ')}.` }));
  return box;
}

function showReview(rv) {
  const out = $('#job-review-out');
  if (!rv) return out.replaceChildren();
  const head = rv.ok === true ? '✓ The reviewer found no problems.' : rv.ok === false ? '✗ The reviewer found problems:' : 'The reviewer did not give a clear answer:';
  out.replaceChildren(el('div', { class: rv.ok === true ? 'job-ok' : 'job-warn' }, el('strong', { text: head }), rv.problems.length ? el('ul', {}, ...rv.problems.map(p => el('li', { text: p }))) : null, el('p', { class: 'hint', text: 'A model\'s opinion, not a test: it can miss things and raise false alarms.' })));
}

function showResult(step, n, r, seconds) {
  jobUi.result = { n, ...r };
  $('#job-result').hidden = false;
  $('#job-result-title').textContent = `Step ${n + 1}, ${step.title}: what came back${seconds ? ` (${seconds} s)` : ''}`;
  $('#job-result-checks').replaceChildren(checkList(r));
  const box = $('#job-result-files');
  box.replaceChildren();
  if (!r.files.length) box.append(el('p', { class: 'hint', text: step.files.length ? 'No file came back in the agreed form, so there is nothing to save. The answer is below. Run the step again, or make the brief plainer.' : 'This step has no files. The answer is below; save the summary to mark it done.' }), el('pre', { class: 'team-answer', text: r.raw ?? '' }));
  for (const f of r.files) box.append(el('label', { class: 'field' }, el('span', { text: `${f.path} (${r.exists[f.path] ? `changed: the old version is kept beside it as ${f.path}.bak` : 'new file'})` }), el('textarea', { class: 'job-file-text', rows: '12', spellcheck: 'false', 'data-path': f.path }, f.text)));
  $('#job-summary').value = r.summary;
  $('#job-accept').disabled = step.files.length > 0 && !r.files.length;
  $('#job-accept').textContent = r.files.length ? 'Save these files and mark the step done' : 'Mark the step done';
  showReview(r.review);
  // Running a step now would throw away what came back (and any edits made to it): save it or throw it away first.
  $('#job-run').disabled = true;
  $('#job-note').textContent = `What came back for step ${n + 1} is waiting below: save it, or throw it away, before running a step.`;
  drawFoot();
  $('#job-result').scrollIntoView({ block: 'nearest' });
}

const resultFiles = () => [...$('#job-result-files').querySelectorAll('.job-file-text')].map(t => ({ path: t.dataset.path, text: t.value }));

$('#job-accept').addEventListener('click', async () => {
  const r = jobUi.result;
  if (!r) return;
  const failing = (r.problems ?? []).length;
  if (failing && !(await askHere($('#job-accept-ask'), `${failing} check${failing > 1 ? 's' : ''} failed on this answer (listed above). Save it anyway?`, 'Save it anyway', 'Do not save'))) return;
  await change({ action: 'accept', n: r.n, files: resultFiles(), summary: $('#job-summary').value });
  if (!$('#jobs-fault').hidden) return;
  jobUi.result = null;
  $('#job-result').hidden = true;
  // Said where the press was: what was saved, and what comes next.
  const saved = (r.files ?? []).map(f => f.path);
  const next = jobUi.job?.steps.findIndex(s => s.status === 'todo') ?? -1;
  showJob(jobUi.view);
  $('#job-note').textContent = `Saved${saved.length ? ` ${saved.join(', ')}` : ''}: step ${r.n + 1} is done.${next >= 0 ? ` Step ${next + 1} is next.` : ' Every step is done.'}`;
  if (typeof loadFiles === 'function') loadFiles().catch(() => undefined);
});

$('#job-ask-review').addEventListener('click', async () => {
  const r = jobUi.result;
  if (!r) return;
  jobFault(null);
  busyButtons(true);
  const out = $('#job-review-out');
  out.replaceChildren(el('pre', { class: 'team-answer', text: 'Asking the reviewer…' }));
  try {
    const v = await jobStream('/api/jobs/review', { id: jobUi.job.id, n: r.n, files: resultFiles() }, { 'review-text': d => (out.firstChild.textContent = d.text) });
    showReview(v.data);
  } catch (e) {
    out.replaceChildren();
    jobFault(e.message);
  } finally {
    stage(null);
    busyButtons(false);
    showJob(jobUi.view);
  }
});

$('#job-discard').addEventListener('click', async () => {
  const had = jobUi.result;
  jobUi.result = null;
  $('#job-result').hidden = true;
  if (had && jobUi.job) await api('/api/jobs/change', { id: jobUi.job.id, action: 'discard' }).catch(e => jobFault(e.message));
  // The step can run again now; the note says what happened.
  if (jobUi.view) showJob(jobUi.view);
  if (had) $('#job-note').textContent = `Thrown away. Run step ${had.n + 1} again when you are ready.`;
});

// ---- LETS GO!!!: the rest of the steps, one after another ----

function logLine(text, cls = '') {
  const log = $('#job-log');
  log.hidden = false;
  log.append(el('li', { class: cls, text }));
  return log.lastElementChild;
}

$('#job-go').addEventListener('click', async () => {
  const job = jobUi.job;
  if (!job) return;
  jobFault(null);
  // The steps are where the work shows: every step, with the log and the live words under the buttons.
  showPart('all');
  $('#job-result').hidden = true;
  $('#job-log').replaceChildren();
  busyButtons(true);
  const out = $('#job-stream');
  let current = null;
  try {
    const r = await jobStream('/api/jobs/run', { id: job.id, review: $('#job-review-each').checked }, {
      step: d => {
        current = logLine(`Step ${d.n + 1}, ${d.title}: working…`);
        out.hidden = false;
        out.textContent = '';
        // The log is under every step: it is brought into sight as each step starts.
        current.scrollIntoView({ block: 'nearest' });
      },
      text: d => (out.textContent = d.text),
      saved: d => {
        current.textContent = `✓ Step ${d.n + 1}, ${d.title}: saved ${d.files.join(', ') || '(no files)'}${d.tries > 1 ? ` after ${d.tries} tries` : ''} (${d.worker}).`;
        current.className = 'ok';
        showJob(d);
        loadJobs().catch(() => undefined);
      },
    });
    out.hidden = true;
    if (r.ev === 'finished') {
      logLine('All steps are finished. Run the tests, then write the report (in the Overview).', 'ok');
      showJob(r.data);
    } else if (r.ev === 'stopped') {
      if (current) current.className = 'bad';
      logLine(r.data.reason, 'bad');
      showJob(r.data);
      if (r.data.result) showResult(r.data.job.steps[r.data.n], r.data.n, r.data.result, 0);
    }
  } catch (err) {
    if (current) current.className = 'bad';
    // Another project is working: "busy: add to the queue".
    if (err.data?.queue && (await askHere($('#jobs-ask'), err.message, 'Add to the queue', 'Not now', false))) await app.queueJob?.(job, (text, bad) => (bad ? jobFault(text) : logLine(text, 'ok')));
    else jobFault(err.message);
  } finally {
    out.hidden = true;
    stage(null);
    busyButtons(false);
    if (jobUi.job) showJob(await api(`/api/jobs/get?id=${encodeURIComponent(jobUi.job.id)}`).catch(() => jobUi.view));
    loadJobs().catch(() => undefined);
  }
});

$('#job-queue').addEventListener('click', async () => {
  const job = jobUi.job;
  if (!job) return;
  jobFault(null);
  await app.queueJob?.(job, (text, bad) => (bad ? jobFault(text) : ($('#job-foot-line').textContent = text)));
});

// ---- Tests and the report ----

function drawTests(t) {
  const box = $('#job-test-out');
  box.replaceChildren();
  if (!t) return;
  box.append(el('div', { class: t.ok ? 'job-ok' : 'job-warn' },
    el('strong', { text: `${t.ok ? '✓ Passed' : '✗ Failed'}: ${t.label} (${t.seconds} s, ${new Date(t.at).toLocaleString()})` }),
    el('pre', { class: 'team-answer job-test-text', text: t.output || '(no output)' }),
    t.ok ? null : el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Add a step to fix it', onclick: () => change({ action: 'addfix' }) }))));
}

$('#job-test-run').addEventListener('click', async () => {
  const label = $('#job-test-cmd').selectedOptions[0]?.text ?? '';
  if (!(await askHere($('#job-test-ask'), `Run "${label}" in the project folder? This runs the code the models wrote.`, 'Run the tests', 'Not now', false))) return;
  jobFault(null);
  busyButtons(true);
  $('#job-test-out').replaceChildren(el('p', { class: 'hint', text: `Running ${label}…` }));
  try {
    const r = await api('/api/jobs/test', { id: jobUi.job.id, test: $('#job-test-cmd').value });
    showJob(r);
  } catch (e) {
    $('#job-test-out').replaceChildren();
    jobFault(e.message);
  } finally {
    busyButtons(false);
    showJob(jobUi.view);
  }
});

$('#job-final').addEventListener('click', async () => {
  jobFault(null);
  busyButtons(true);
  const out = $('#job-final-out');
  const pre = el('pre', { class: 'team-answer', text: 'Gathering the checks…' });
  out.replaceChildren(pre);
  try {
    const r = await jobStream('/api/jobs/final', { id: jobUi.job.id }, { text: d => (pre.textContent = d.text) });
    out.replaceChildren(pre, el('p', { class: 'hint', text: `Saved as ${r.data.path} in the workspace, with the checks made by code listed under it. A model wrote the report: check it against the files.` }));
    pre.textContent = r.data.text;
  } catch (e) {
    out.replaceChildren();
    jobFault(e.message);
  } finally {
    stage(null);
    busyButtons(false);
    showJob(jobUi.view);
  }
});

async function openJobs() {
  jobFault(null);
  try {
    await Promise.all([loadJobs(), loadSetup()]);
  } catch (e) {
    jobFault(e.message);
  }
  if (!jobUi.job) showPart('list');
  if (!jobsDlg.open) jobsDlg.showModal();
}
$('#jobs-open').addEventListener('click', openJobs);

// For Home: open a job (with a step waiting, if any), start a plan from a goal or a project, or go to Other PCs.
app.openJob = async id => {
  await openJobs();
  await openJob(id);
};
// A project (Start project, or "Lets create a project" on Home): the planner reads its Scope card and design brief
// first; the plan keeps its id, name, folder and team. Typing a different goal plans that goal instead.
$('#job-goal').addEventListener('input', () => (jobUi.project = null));
app.planProject = async (id, statement) => {
  await openJobs();
  jobUi.project = id;
  $('#job-goal').value = statement;
  $('#job-new-form').requestSubmit();
};
app.planJob = async goal => {
  await openJobs();
  // A goal from Home is that goal: not a project an earlier try left behind.
  jobUi.project = null;
  $('#job-goal').value = goal;
  $('#job-new-form').requestSubmit();
};
// Linking other PCs lives in Nodes and memory (home.js opens it).
$('#job-pcs-link').addEventListener('click', () => {
  $('#jobs').close();
  app.openPcs();
});
