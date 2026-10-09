// Audits › Private details: the list the audit's disclosure pass looks for in every project (your email, phone,
// street, full name ...). The server keeps the values in its data folder and only ever sends back labels and lengths,
// so a value is typed in here and never shown again: a saved one is kept until it is replaced or removed.
'use strict';

$('cmd-private').addEventListener('click', async () => {
  let s;
  try { s = await api('/api/private-details'); } catch (e) { return info(e.message, true); }
  const list = h('div', { class: 'pd-list' });
  const row = d => {
    const label = h('input', { type: 'text', class: 'pd-label', maxlength: '80', value: d ? d.label : '', placeholder: 'Label, e.g. my phone', 'aria-label': 'Label', spellcheck: 'false', autocomplete: 'off' });
    const value = h('input', { type: 'text', class: 'pd-value', maxlength: '300', placeholder: d ? 'Saved (' + d.length + ' characters). Type to replace it' : 'The detail itself', 'aria-label': 'Detail', spellcheck: 'false', autocomplete: 'off' });
    const el = h('div', { class: 'pd-row', 'data-id': d ? d.id : '' }, h('div', { class: 'field' }, label), h('div', { class: 'field' }, value),
      h('button', { class: 'btn', type: 'button', title: 'Remove', 'aria-label': 'Remove ' + (d ? d.label : 'this detail'), onclick: () => el.remove() }, 'Remove'));
    return el;
  };
  list.append(...s.details.map(row));
  if (!s.details.length) list.append(row(null));
  const err = h('div', { class: 'err', role: 'alert' });
  const ok = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
    const details = [...list.querySelectorAll('.pd-row')].map(r => ({ id: r.dataset.id || undefined, label: r.querySelector('.pd-label').value, value: r.querySelector('.pd-value').value }))
      .filter(d => d.id || d.label.trim() || d.value.trim());
    ok.disabled = true;
    try {
      const r = await api('/api/private-details', { details });
      if (!r.ok) { err.textContent = r.error; ok.disabled = false; return; }
      closeDialog();
      info(r.details.length ? 'Saved ' + r.details.length + ' private detail' + (r.details.length > 1 ? 's' : '') + '. The next scan of each project looks for them.' : 'No private details saved; the scan still looks for this PC\'s own.');
    } catch (e) { err.textContent = e.message; ok.disabled = false; }
  } }, 'Save');
  dialog('Private details', [
    h('p', null, 'What should never appear in a project you publish: your email, phone, street, full name, a customer\'s name. Every scan looks for them in the files git would publish, the git history, commit emails and release zips.'),
    h('p', { class: 'muted' }, 'Kept on this PC only, in the Bridge\'s data folder. A finding shows the label, never the detail, so a report is safe to paste into an AI. Once saved, a detail is not shown again.'),
    list,
    h('button', { class: 'btn', type: 'button', onclick: () => { const r = row(null); list.append(r); r.querySelector('input').focus(); } }, 'Add detail'),
    err,
    h('p', { class: 'muted', style: 'font-size:13px' }, 'Also looked for, read from this PC each time: ' + s.auto.join(', ') + '; and the names of your other projects.')],
    [ok, cancelBtn()], 'wide');
});
