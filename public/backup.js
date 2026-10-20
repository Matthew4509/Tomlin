// Backup when a PC is off (PLAN phases 4+5): when neither of a hire's brains can answer, the chat asks what to do
// instead. Send the last message to someone else who is online (the Send to window, to read it first), or pick another
// model for them: PC | Model rows (same model first; a smaller one answers as an intern, drafts only), filtered by All,
// Fits this PC, Fits a chosen PC, Fits their level. The message is sent again once a backup is picked: just this time,
// until their PC is back (the default), or always (it becomes their fallback).
'use strict';

const backupDlg = $('#backup-dlg');

app.openBackup = (data, message) => {
  const first = data.name.split(/\s+/)[0];
  const fault = el('div', { class: 'fault', role: 'alert', hidden: true });
  let pick = data.choices[0]?.ref ?? '';
  // The filter: 'all', 'here' (fits this PC), 'pc' (fits the PC chosen beside it) or 'level' (fits their level).
  let show = 'all';
  const pcs = [...new Map(data.choices.filter(c => c.pcId && c.pcId !== 'here').map(c => [c.pcId, c.pc])).entries()];
  let pcPick = pcs[0]?.[0] ?? '';
  const fits = c => c.fit !== 'no';
  const shown = () => data.choices.filter(c => show === 'all' || (show === 'here' ? c.pcId === 'here' && fits(c) : show === 'pc' ? c.pcId === pcPick && fits(c) : c.level !== 'below'));

  // ---- Someone else who is online: the last message goes to them (Send to opens with it, to read before it goes) ----
  const others = (homeUi.data?.staff ?? []).filter(s => s.kind !== 'image' && s.id !== data.hire && s.activity !== 'offline' && s.activity !== 'owner');
  const sendTo = el('div', { class: 'backup-send' },
    el('h3', { text: 'Send your last message to' }),
    others.length
      ? el('div', { class: 'team-actions' }, ...others.map(s => el('button', { class: 'btn', type: 'button', text: s.name, title: `Opens Send to with your message and ${s.name} picked: read it, then send`, onclick: () => {
        backupDlg.close();
        app.openSend({ text: message, who: `staff:${s.id}` });
      } })))
      : el('p', { class: 'hint', text: 'Nobody else on the team is online now.' }));

  // ---- Or another model for them: the filters, then PC | Model ----
  const list = el('div', { class: 'backup-list', role: 'radiogroup', 'aria-label': `Models ${first} can use now` });
  const chips = el('div', { class: 'g-shelves backup-filter', role: 'group', 'aria-label': 'Which models to show' });
  const pcSel = pcs.length ? el('select', { 'aria-label': 'The PC to fit' }, ...pcs.map(([id, name]) => el('option', { value: id, text: name }))) : null;
  pcSel?.addEventListener('change', () => {
    pcPick = pcSel.value;
    show = 'pc';
    draw();
  });
  const chip = (id, text) => el('button', { class: 'g-shelf', type: 'button', 'data-show': id, text, onclick: () => { show = id; draw(); } });
  chips.append(chip('all', 'All'), chip('here', 'Fits this PC'), ...(pcSel ? [chip('pc', 'Fits'), pcSel] : []), chip('level', `Fits ${first}'s level`));
  const tagsOf = c => [c.same ? 'same model' : c.intern ? 'smaller: answers as an intern, drafts only' : 'another model', c.ready ? 'answers now' : 'loads first', c.fit === 'tight' ? 'tight on memory' : c.fit === 'no' ? 'may not fit that PC' : ''].filter(Boolean).join(' · ');
  function draw() {
    for (const b of chips.querySelectorAll('[data-show]')) b.setAttribute('aria-pressed', String(b.dataset.show === show));
    const rows = shown();
    if (!rows.some(c => c.ref === pick)) pick = rows[0]?.ref ?? '';
    list.replaceChildren(el('div', { class: 'backup-head', 'aria-hidden': 'true' }, el('span', {}), el('span', { text: 'PC' }), el('span', { text: 'Model' })),
      ...(rows.length ? rows.map(c => {
        const radio = el('input', { type: 'radio', name: 'backup-pick', value: c.ref, 'aria-label': `${c.pc}, ${c.model}` });
        radio.checked = c.ref === pick;
        radio.addEventListener('change', () => { pick = c.ref; goBtns(); });
        return el('label', { class: 'backup-row' }, radio, el('span', { class: 'backup-pc', text: c.pc }),
          el('span', {}, el('strong', { text: c.model }), el('br'), el('span', { class: 'hint', text: tagsOf(c) })));
      }) : [el('p', { class: 'hint', text: 'None of them fits that. Press All to see every one.' })]));
    goBtns();
  }

  const go = how => el('button', { class: `btn${how === 'back' ? ' primary' : ''}`, type: 'button', 'data-go': how, text: how === 'once' ? 'Just this time' : how === 'back' ? `Until ${first}'s PC is back` : `Use this for ${first} from now on`, onclick: async e => {
    e.target.disabled = true;
    try {
      await api('/api/staff/backup', { id: data.hire, ref: pick, for: how });
      backupDlg.close();
      input.value = message;
      $('#chat-form').requestSubmit();
    } catch (err) {
      e.target.disabled = false;
      fault.textContent = err.message;
      fault.hidden = false;
    }
  } });
  const buttons = data.choices.length ? [go('once'), go('back'), go('always')] : [];
  // Nothing picked (a filter shows none): the three wait.
  const goBtns = () => { for (const b of buttons) b.disabled = !pick; };

  backupDlg.replaceChildren(el('div', { class: 'help-body' },
    el('h2', { id: 'backup-title', text: data.off ? `${first}'s PC is offline.` : `${first}'s own model cannot answer now.` }),
    data.why ? el('p', { class: 'hint', text: `Why: ${data.why}.` }) : null,
    sendTo,
    el('h3', { text: `Or use another model for ${first}` }),
    ...(data.choices.length ? [chips, list] : [el('p', { text: `No PC that is on has a chat model that fits. Connect one on another PC, or wait for ${first}'s PC.` })]),
    ...(data.others ?? []).map(o => el('p', { class: 'hint', text: `${o.pc}: ${o.why}.` })),
    el('p', { class: 'hint', text: `${first} stays ${first}: the chat and memory stay on this PC; the backup only lends its model.${data.choices.some(c => c.intern) ? ' A smaller model answers as an intern: check what it writes, and in a job it takes no step across several files.' : ''}` }),
    fault,
    el('div', { class: 'team-actions backup-go' }, ...buttons,
      el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => backupDlg.close() }))));
  if (data.choices.length) draw();
  backupDlg.showModal();
};
