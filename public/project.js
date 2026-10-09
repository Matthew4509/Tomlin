// Start project: who / what / when / where / why / how in two short rounds (the recommended answer already picked; Skip
// keeps it as Assumed), the idea said back in one line, the look picked from four libraries with a live preview, and
// who could do each kind of work (only suggested). The server writes the Scope card and the design brief into the job
// folder; "Make a plan" hands them to the planner in Jobs. Everything shown here comes from /api/projects/*.
// Uses app.js's helpers ($, el, api, app).
'use strict';

const projectDlg = $('#project');
const pj = { setup: null, step: 0, answers: {}, assumed: new Set(), statement: '', wish: null, design: {}, saved: null };
const STEPS = ['The idea', 'When, where and how', 'The type', 'Colours and layout', 'Who does the work'];

function projectFault(text) {
  $('#project-fault').hidden = !text;
  $('#project-fault').textContent = text ?? '';
}

// ---- Round 1 and 2: the questions ----

function questionBox(q) {
  const box = el('fieldset', { class: 'pj-q', 'data-q': q.id });
  const head = el('legend', {}, el('b', { text: q.ask }), ' ', el('span', { class: 'hint', text: q.hint }));
  box.append(head);
  const assumed = el('p', { class: 'pj-assumed hint', hidden: !pj.assumed.has(q.id) });
  const showAssumed = () => {
    assumed.hidden = !pj.assumed.has(q.id);
    box.classList.toggle('is-assumed', pj.assumed.has(q.id));
    const name = q.choices?.find(c => c.id === q.recommended)?.name ?? q.recommended;
    assumed.textContent = `Skipped: kept as Assumed (${name}). Pick or type an answer to change it.`;
  };
  const answered = () => {
    pj.assumed.delete(q.id);
    showAssumed();
  };
  if (q.kind === 'text') {
    const input = el('input', { type: 'text', maxlength: '120', placeholder: q.placeholder ?? '', value: pj.answers[q.id] ?? '', 'aria-label': q.ask, required: true });
    input.addEventListener('input', () => { pj.answers[q.id] = input.value; answered(); });
    box.append(input);
  } else if (q.kind === 'lines') {
    const list = el('div', { class: 'pj-lines' });
    const lines = pj.answers.must ?? [];
    for (let i = 0; i < 5; i++) {
      const input = el('input', { type: 'text', maxlength: '100', placeholder: i === 0 ? q.placeholder : '', value: lines[i] ?? '', 'aria-label': `F${i + 1}` });
      input.addEventListener('input', () => {
        pj.answers.must = [...list.querySelectorAll('input')].map(x => x.value);
        answered();
      });
      list.append(el('label', { class: 'pj-line' }, el('span', { class: 'pj-f', text: `F${i + 1}` }), input));
    }
    box.append(list);
  } else {
    const row = el('div', { class: 'level-pills' });
    const now = pj.answers[q.id] ?? q.recommended;
    for (const c of q.choices) {
      const input = el('input', { type: 'radio', name: `pj-${q.id}`, value: c.id, checked: c.id === now });
      input.addEventListener('change', () => { pj.answers[q.id] = c.id; answered(); });
      row.append(el('label', { class: 'pick-card' }, input, el('span', { text: c.name }), c.hint ? el('span', { class: 'hint', text: c.hint }) : null,
        c.id === q.recommended ? el('span', { class: 'hint', text: 'Recommended' }) : null));
    }
    box.append(row);
  }
  if (q.skip) {
    box.append(el('div', { class: 'pj-skip' }, el('button', { class: 'link', type: 'button', text: 'Skip', onclick: () => skip(q, box) }), assumed));
    showAssumed();
  }
  return box;
}

/** Skipping keeps the recommended answer and marks it Assumed (the Scope card lists it). */
function skip(q, box) {
  pj.assumed.add(q.id);
  if (q.kind === 'lines') {
    pj.answers.must = [];
    for (const i of box.querySelectorAll('input')) i.value = '';
  } else if (q.kind === 'choice') {
    pj.answers[q.id] = q.recommended;
    for (const i of box.querySelectorAll('input')) i.checked = i.value === q.recommended;
  }
  box.querySelector('.pj-assumed').hidden = false;
  box.classList.add('is-assumed');
  const name = q.choices?.find(c => c.id === q.recommended)?.name ?? q.recommended;
  box.querySelector('.pj-assumed').textContent = `Skipped: kept as Assumed (${name}). Pick or type an answer to change it.`;
}

function round(n) {
  const qs = pj.setup.questions.filter(q => q.round === n);
  const out = [];
  if (n === 2) {
    if (pj.wish) out.push(el('p', { class: 'pj-wish', text: pj.wish }));
    const say = el('textarea', { rows: '2', maxlength: '200', id: 'pj-statement', 'aria-label': 'The idea in one line' });
    say.value = pj.statement;
    say.addEventListener('input', () => (pj.statement = say.value));
    out.push(el('label', { class: 'field pj-say' }, el('span', { text: 'So the idea is (change it if it is not right):' }), say));
  }
  out.push(...qs.map(questionBox));
  return out;
}

// ---- Round 3 and 4: the look, with one preview that follows every pick ----

const pickOf = (key, list) => list.find(x => x.id === pj.design[key]) ?? list[0];

function preview() {
  const L = pj.setup.look;
  const t = pickOf('type', L.type), s = pickOf('size', L.sizes), p = pickOf('palette', L.palettes), l = pickOf('layout', L.layouts);
  const weight = Number(pj.design.weight);
  const box = el('div', { class: 'pj-preview', 'aria-label': 'Preview of the look' });
  Object.assign(box.style, { background: p.page, color: p.ink, fontFamily: t.previewBody, fontSize: `${Math.max(12, Math.round(s.body * 0.9))}px` });
  const card = el('div', { class: 'pj-pcard' });
  Object.assign(card.style, { background: p.card, borderColor: p.muted });
  const h = el('div', { class: 'pj-ph', text: 'A heading in this style' });
  Object.assign(h.style, { fontFamily: t.previewHeading, fontWeight: String(weight), fontSize: `${Math.round(s.h1 * 0.45)}px` });
  const sub = el('div', { text: 'A sub-heading' });
  Object.assign(sub.style, { fontFamily: t.previewHeading, fontWeight: String(weight), fontSize: `${Math.round(s.h3 * 0.8)}px` });
  const body = el('p', { text: 'Body text reads like this. The muted line under it is for dates and notes.' });
  const muted = el('p', { text: 'Muted text · 4 October' });
  muted.style.color = p.muted;
  muted.style.fontSize = `${Math.max(12, Math.round(s.small * 0.9))}px`;
  const btn = el('span', { class: 'pj-pbtn', text: 'A button' });
  Object.assign(btn.style, { background: p.brand, color: p.onBrand });
  const link = el('span', { class: 'pj-plink', text: 'An accent link' });
  link.style.color = p.accent;
  card.append(h, sub, body, muted, el('div', { class: 'pj-prow' }, btn, link));
  const grid = el('div', { class: 'pj-layout', 'aria-label': `Layout: ${l.name}` });
  for (const [label, cols] of l.parts) {
    const part = el('div', { class: 'pj-part', text: label });
    Object.assign(part.style, { gridColumn: `span ${cols}`, background: p.card, borderColor: p.muted, color: p.muted });
    grid.append(part);
  }
  box.append(card, grid);
  return el('div', { class: 'pj-preview-wrap' }, el('span', { class: 'hint', text: `Preview (look-alike fonts on this PC; the built page uses ${t.heading}${t.body !== t.heading ? ` and ${t.body}` : ''})` }), box);
}

function redrawPreview() {
  $('#project-body .pj-preview-wrap')?.replaceWith(preview());
}

function pickSet(legend, key, list, card) {
  const set = el('fieldset', { class: 'pick-set' }, el('legend', { text: legend }));
  const wrap = el('div', { class: key === 'weight' || key === 'size' ? 'level-pills' : 'pj-cards' });
  for (const x of list) {
    const input = el('input', { type: 'radio', name: `pj-${key}`, value: x.id, checked: pj.design[key] === x.id });
    input.addEventListener('change', () => { pj.design[key] = x.id; redrawPreview(); });
    wrap.append(el('label', { class: 'pick-card' }, input, ...card(x), x.id === pj.setup.look.defaults[key] ? el('span', { class: 'hint', text: 'Default' }) : null));
  }
  set.append(wrap);
  return set;
}

const look = (sets) => [el('div', { class: 'pj-look' }, el('div', { class: 'pj-picks' }, ...sets), preview())];

function typeRound() {
  const L = pj.setup.look;
  return look([
    pickSet('Font family (type style)', 'type', L.type, t => {
      const name = el('b', { text: t.name });
      name.style.fontFamily = t.previewHeading;
      return [el('span', { class: 'pj-cardtext' }, name, el('span', { class: 'hint', text: `${t.feels}. Suits ${t.suits}.` }))];
    }),
    pickSet('Heading weight', 'weight', L.weights, w => [el('span', { text: w.name })]),
    pickSet('Font size and scale', 'size', L.sizes, s => [el('span', { text: s.name }), el('span', { class: 'hint', text: `body ${s.body}px · h1 ${s.h1}px` })]),
  ]);
}

function colourRound() {
  const L = pj.setup.look;
  const groups = [...new Set(L.layouts.map(l => l.group))];
  return look([
    pickSet('Colour palette', 'palette', L.palettes, p => {
      const sw = el('span', { class: 'pj-swatches', 'aria-hidden': 'true' });
      for (const c of [p.page, p.card, p.ink, p.brand, p.accent]) {
        const dot = el('span', { class: 'pj-sw' });
        dot.style.background = c;
        sw.append(dot);
      }
      return [el('span', { class: 'pj-cardtext' }, el('b', { text: p.name }), el('span', { class: 'hint', text: p.base === 'dark' ? 'Dark' : 'Light' })), sw];
    }),
    ...groups.map(g => pickSet(`Layout: ${g}`, 'layout', L.layouts.filter(l => l.group === g), l => [el('span', { class: 'pj-cardtext' }, el('b', { text: l.name }), el('span', { class: 'hint', text: l.parts.map(x => x[0]).join(' · ') }))])),
  ]);
}

// ---- Round 5: suggested hires (only suggested) ----

function hiresRound() {
  const rows = pj.setup.suggestions.map(s => el('div', { class: 'pj-hire' },
    el('b', { text: s.label }),
    s.who ? el('span', { text: `${s.who}${s.where && s.where !== 'This PC' ? ` · on "${s.where}"` : ' · this PC'}` })
      : el('span', {}, 'Nobody yet ', el('button', { class: 'link', type: 'button', text: 'Hire one', onclick: () => app.openHire() })),
    el('span', { class: 'hint', text: s.reason })));
  return [
    el('p', { class: 'hint', text: 'Who could do each kind of work, from the staff you have. Only suggestions: nothing is assigned here. Hire one opens Staff (your answers stay); who does each kind of step is set in the job\'s Overview, under Roles.' }),
    el('div', { class: 'pj-hires' }, ...rows),
    el('p', { class: 'hint', text: 'Next saves the Scope card and the design brief in the job folder.' }),
  ];
}

// ---- After saving: the two cards, and Make a plan ----

function savedView(r) {
  pj.open = false;
  $('#project-step').textContent = 'Saved';
  const fits = r.chars <= 2400 ? 'an 8K model can read both' : 'longer than planned: shorten the answers';
  // The copy icon copies a card; the pencil changes it in place (Cancel or Save), and the planner reads it as saved.
  $('#project-body').replaceChildren(
    el('p', { text: `Saved in the workspace folder under ${r.folder}: scope.md and design.md (${r.chars.toLocaleString()} characters together; ${fits}).` }),
    ...app.projectCards(r.id, { scope: r.scope, design: r.design }));
  $('#project-back').hidden = true;
  $('#project-skip-rest').hidden = true;
  const next = $('#project-next');
  next.textContent = 'Make the plan for this project';
  next.onclick = async () => {
    projectDlg.close();
    await app.planProject(r.id, r.statement ?? pj.statement);
  };
}

// ---- Moving between screens ----

function draw() {
  projectFault(null);
  $('#project-step').textContent = `Step ${pj.step + 1} of ${STEPS.length}: ${STEPS[pj.step]}`;
  const body = [() => round(1), () => round(2), typeRound, colourRound, hiresRound][pj.step]();
  $('#project-body').replaceChildren(...body);
  $('#project-back').hidden = pj.step === 0;
  $('#project-skip-rest').hidden = pj.step > 1;
  const next = $('#project-next');
  next.textContent = pj.step === STEPS.length - 1 ? 'Save project' : 'Next';
  next.onclick = goNext;
  $('#project-body').querySelector('input:not([type=radio]), textarea')?.focus();
  projectDlg.querySelector('.help-body').scrollTop = 0;
}

function answersBody() {
  return { ...pj.answers, must: (pj.answers.must ?? []).filter(x => x.trim()), assumed: [...pj.assumed], statement: pj.statement };
}

async function goNext() {
  projectFault(null);
  const next = $('#project-next');
  next.disabled = true;
  try {
    if (pj.step === 0) {
      if (!(pj.answers.what ?? '').trim()) {
        projectFault('Say what it is first, in one line (for example "a tip calculator").');
        $('#project-body input')?.focus();
        return;
      }
      // Code says the idea back in one line and spots a wish nobody can promise.
      const r = await api('/api/projects/check', { answers: answersBody() });
      pj.statement = r.statement;
      pj.wish = r.wish;
    }
    if (pj.step === STEPS.length - 1) {
      // The name, folder and project manager from Home's "Lets create a project" go with it.
      const home = { name: $('#home-name').value, folder: '', pm: $('#home-staff').value };
      const r = await api('/api/projects/save', { answers: answersBody(), design: pj.design, home });
      savedView({ ...r, statement: pj.statement });
      return;
    }
    pj.step++;
    draw();
  } catch (e) {
    projectFault(e.message);
  } finally {
    next.disabled = false;
  }
}

$('#project-back').addEventListener('click', () => {
  if (pj.step > 0) pj.step--;
  draw();
});
$('#project-skip-rest').addEventListener('click', async () => {
  for (const q of pj.setup.questions.filter(q => q.round === pj.step + 1 && q.skip)) {
    const touched = q.kind === 'lines' ? (pj.answers.must ?? []).some(x => x.trim()) : q.id in pj.answers;
    if (!touched) pj.assumed.add(q.id);
  }
  if (pj.step === 1) {
    pj.step++;
    draw();
  } else await goNext();
});

async function openProject() {
  try {
    pj.setup = await api('/api/projects/setup');
  } catch (e) {
    sayHere($('#home-ask-say'), `Advanced project setup could not open: ${e.message}`);
    return;
  }
  const goal = $('#home-goal').value.trim().slice(0, 120);
  const carry = pj.open && (pj.answers.what ?? '').trim() && (!goal || goal === pj.answers.what);
  if (!carry) Object.assign(pj, { step: 0, answers: goal ? { what: goal } : {}, assumed: new Set(), statement: '', wish: null, design: { ...pj.setup.look.defaults } });
  pj.open = true;
  draw();
  if (carry) {
    $('#project-body').prepend(el('p', { class: 'hint pj-carry' }, `Carried on where you left "${pj.answers.what}". `, el('button', { class: 'link', type: 'button', text: 'Start again', onclick: () => {
      pj.open = false;
      openProject();
    } })));
  }
  // Projects saved earlier without a plan: carry on with one.
  if (pj.setup.saved.length) {
    const list = el('details', { class: 'sub pj-saved' }, el('summary', { text: `Saved projects without a plan (${pj.setup.saved.length})` }),
      ...pj.setup.saved.slice(0, 8).map(s => el('div', { class: 'pj-hire' }, el('span', { text: s.statement || s.id }),
        el('button', { class: 'btn', type: 'button', text: 'Open', onclick: async () => {
          try {
            savedView(await api(`/api/projects/get?id=${encodeURIComponent(s.id)}`));
          } catch (e) {
            projectFault(e.message);
          }
        } }))));
    $('#project-body').prepend(list);
  }
  if (!projectDlg.open) projectDlg.showModal();
}
projectDlg.addEventListener('close', () => {
  $('#project-back').hidden = false;
});
$('#project-open').addEventListener('click', openProject);
app.startProject = openProject;
