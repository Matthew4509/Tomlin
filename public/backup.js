// Backup when a PC is off (PLAN phases 4+5): when neither of a hire's brains can answer, the chat asks where they
// should answer instead. Same model first; a smaller one answers as an intern (drafts only). The message is sent again
// once a backup is picked: just this time, until their PC is back, or always (it becomes their fallback).
'use strict';

const backupDlg = $('#backup-dlg');

app.openBackup = (data, message) => {
  const first = data.name.split(/\s+/)[0];
  let pick = data.choices[0]?.ref ?? '';
  const fault = el('div', { class: 'fault', role: 'alert', hidden: true });
  const rows = data.choices.map((c, i) => {
    const radio = el('input', { type: 'radio', name: 'backup-pick', value: c.ref });
    radio.checked = i === 0;
    radio.addEventListener('change', () => (pick = c.ref));
    const tags = [c.same ? 'same model' : c.intern ? 'smaller: answers as an intern, drafts only' : 'another model', c.ready ? 'answers now' : 'loads first'];
    return el('label', { class: 'check backup-row' }, radio, el('span', {},
      el('strong', { text: `${c.pc} · ${c.model}` }), el('br'),
      el('span', { class: 'hint', text: tags.join(' · ') })));
  });
  const go = how => el('button', { class: `btn${how === 'back' ? ' primary' : ''}`, type: 'button', text: how === 'once' ? 'Just this time' : how === 'back' ? `Until ${first}'s PC is back` : `Use this for ${first} from now on`, onclick: async e => {
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
  backupDlg.replaceChildren(el('div', { class: 'help-body' },
    el('h2', { id: 'backup-title', text: data.off ? `${first}'s PC is off. Pick a backup.` : `${first}'s own model cannot answer now. Pick a backup.` }),
    data.why ? el('p', { class: 'hint', text: `Why: ${data.why}.` }) : null,
    ...(rows.length ? rows : [el('p', { text: `No PC that is on has a chat model that fits. Connect one on another PC, or wait for ${first}'s PC.` })]),
    ...(data.others ?? []).map(o => el('p', { class: 'hint', text: `${o.pc}: ${o.why}.` })),
    el('p', { class: 'hint', text: `${first} stays ${first}: the chat and memory stay on this PC; the backup only lends its model.${data.choices.some(c => c.intern) ? ' A smaller model answers as an intern: check what it writes, and in a job it takes no step across several files.' : ''}` }),
    fault,
    el('div', { class: 'team-actions' }, ...(rows.length ? [go('once'), go('back'), go('always')] : []),
      el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => backupDlg.close() }))));
  backupDlg.showModal();
};
