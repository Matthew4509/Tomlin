// Audits › Check a skill: a Claude Code skill, plugin or agent folder checked before it is installed (lib/agents.js).
// Paste its SKILL.md, or choose its folder or zip. The server reads it on this PC and runs nothing in it; the answer
// is a verdict, the findings, and what the skill does (the scripts and hooks it runs, the services and keys it uses).
'use strict';

$('cmd-skill').addEventListener('click', () => skillDialog());

function skillDialog(pasted = '', where = '') {
  const text = h('textarea', { class: 'prompt-text skill-text', rows: '8', placeholder: 'Paste the SKILL.md (or CLAUDE.md, AGENTS.md, a command) here', 'aria-label': 'Skill text', spellcheck: 'false' });
  text.value = pasted;
  const input = h('input', { type: 'text', placeholder: 'or the folder or .zip / .skill file, e.g. C:\\Users\\you\\Downloads\\some-skill', 'aria-label': 'Skill folder or zip', spellcheck: 'false' });
  input.value = where;
  const err = h('div', { class: 'err', role: 'alert' });
  const browse = h('button', { class: 'btn', type: 'button', onclick: async () => {
    browse.disabled = true; err.textContent = '';
    try {
      const r = await api('/api/pick-folder', { purpose: 'skill' });
      if (r.path) input.value = r.path;
      else if (r.error) err.textContent = r.error;
      else if (r.dryRun) err.textContent = 'Dry run: ' + r.dryRun + ' (type a path instead).';
    } catch (e) { err.textContent = e.message; }
    browse.disabled = false; input.focus();
  } }, icon(0xE838), 'Browse…');
  const ok = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
    const body = text.value.trim() ? { text: text.value } : input.value.trim() ? { path: input.value.trim() } : null;
    if (!body) { err.textContent = 'Paste the skill\'s text, or choose its folder or zip.'; return text.focus(); }
    ok.disabled = true; err.textContent = '';
    try {
      const r = await api('/api/skill-check', body);
      if (r.error) { err.textContent = r.error; ok.disabled = false; return; }
      skillResult(r, text.value, input.value);
    } catch (e) { err.textContent = e.message; ok.disabled = false; }
  } }, 'Check');
  dialog('Check a skill', [
    h('p', null, 'Before you install a skill, plugin or agent file from someone else, check it here for the known attacks: instructions hidden where the agent reads them and you do not, keys or files sent away, a program downloaded and run, a change that starts it again later.'),
    h('p', { class: 'muted' }, 'Read on this PC only. Nothing in it is run, and nothing is sent anywhere.'),
    h('div', { class: 'field' }, text),
    h('div', { class: 'field skill-path' }, input, browse),
    err],
    [ok, cancelBtn()], 'wide');
}

function skillResult(r, pasted, where) {
  const cls = r.verdict === 'do-not-install' ? 'a-bad' : r.verdict === 'read-first' ? 'a-warn' : 'a-ok';
  const item = f => h('div', { class: 'check' }, h('span', { class: 'sev ' + (SEV[f.sev] || SEV.Medium).cls }, (SEV[f.sev] || SEV.Medium).mark),
    h('span', { class: 'what' }, f.title, h('span', { class: 'where' }, f.where + ' · ' + f.rule + ' · ' + f.fix)));
  const d = r.does || {};
  const doesRows = [
    d.runs && d.runs.length ? ['Scripts it runs', d.runs] : null,
    d.hooks && d.hooks.length ? ['Runs on its own (hooks)', d.hooks] : null,
    d.hosts && d.hosts.length ? ['Services it talks to', d.hosts] : null,
    d.keys && d.keys.length ? ['Keys it reads', d.keys] : null,
  ].filter(Boolean);
  dialog('Check a skill: ' + r.headline, [
    h('p', null, h('b', { class: cls }, r.headline), ' · ' + r.counts.Critical + ' critical, ' + r.counts.High + ' high, ' + r.counts.Medium + ' to read first · ' + r.rules + ' checks over ' + r.filesRead.length + ' file' + (r.filesRead.length === 1 ? '' : 's') + '.'),
    ...r.findings.slice(0, 60).map(item),
    doesRows.length ? h('details', { class: 'notes', open: true }, h('summary', null, 'What it does'),
      ...doesRows.map(([k, v]) => h('div', { class: 'check' }, h('span', { class: 'sev' }, k), h('span', { class: 'what' }, v.slice(0, 20).join(', ') + (v.length > 20 ? '…' : ''))))) : null,
    ...(r.notes || []).map(n => h('p', { class: 'muted' }, n)),
    h('p', { class: 'muted' }, 'This check knows the common shapes of these attacks, not every one. A skill it passes can still do harm: install skills from makers you trust, and read what a skill runs.')],
    [h('button', { class: 'btn', type: 'button', onclick: () => skillDialog(pasted, where) }, 'Check another'), cancelBtn('Close')], 'wide');
}
