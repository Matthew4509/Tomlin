// Your data and updates (src/keep.ts): the one-time "Import" question when this copy's home folder is empty and an
// older copy has data, the note after an import, restore or update, and the "Your data and updates" part of the bell
// window (the folder, Back up now, the backups with Put back).
'use strict';

const keepDlg = $('#keep-dlg');
const keepMb = n => (n >= GB ? gb(n) : n >= 2 ** 20 ? `${Math.round(n / 2 ** 20)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const keepWhen = at => new Date(at).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Waits for TOMLIN to come back after it started again (a different start time), then reloads the page. */
function waitForRestart(before) {
  const tick = async () => {
    try {
      const r = await fetch('/api/keep', { cache: 'no-store' });
      // Locked after the restart (the app lock): the reload shows the lock screen.
      if (r.status === 423) return location.reload();
      if (r.ok && (await r.json()).startedAt !== before) return location.reload();
    } catch {
      // not back yet
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

function keepSaid(lines, after) {
  keepDlg.replaceChildren(el('div', { class: 'help-body' },
    el('h2', { id: 'keep-title', text: lines.title }),
    ...lines.text.map(t => el('p', { text: t })),
    after ?? el('div', { class: 'team-actions' }, el('button', { class: 'btn primary', type: 'button', text: 'OK', onclick: () => keepDlg.close() }))));
  if (!keepDlg.open) keepDlg.showModal();
}

/** After [Import] or [Put back]: TOMLIN starts again (or says to start it again by hand). */
function afterPlanned(r, title, before) {
  if (r.restarting) {
    keepSaid({ title, text: [r.said] }, el('p', { class: 'hint', role: 'status', text: 'The page opens again by itself.' }));
    keepDlg.addEventListener('cancel', e => e.preventDefault(), { once: true });
    waitForRestart(before);
  } else {
    keepSaid({ title, text: [r.said] });
  }
}

function askBringIn(k) {
  let pick = k.offer[0].dir;
  const fault = el('div', { class: 'fault', role: 'alert', hidden: true });
  const rows = k.offer.map((s, i) => {
    const radio = el('input', { type: 'radio', name: 'keep-from', value: s.dir });
    radio.checked = i === 0;
    radio.addEventListener('change', () => (pick = s.dir));
    const what = [`${s.chats} chat${s.chats === 1 ? '' : 's'}`, `last used ${keepWhen(s.at)}`, s.modelBytes ? `${keepMb(s.modelBytes)} of models to move` : 'no models to move'].join(' · ');
    return el('label', { class: 'check keep-src' }, radio, el('span', {},
      el('strong', { text: s.here ? `This folder (TOMLIN ${s.version})` : `TOMLIN ${s.version}` }),
      el('span', { class: 'hint keep-path', text: ` ${s.dir}` }),
      el('br'), el('span', { class: 'hint', text: what })));
  });
  const go = el('button', { class: 'btn primary', type: 'button', text: 'Import', onclick: async () => {
    go.disabled = true;
    keepDlg.oncancel = null;
    try {
      afterPlanned(await api('/api/keep', { do: 'bring-in', from: pick }), 'Importing your data', k.startedAt);
    } catch (err) {
      go.disabled = false;
      fault.textContent = err.message;
      fault.hidden = false;
    }
  } });
  const empty = el('button', { class: 'btn', type: 'button', text: 'Start empty', onclick: async () => {
    keepDlg.oncancel = null;
    try {
      await api('/api/keep', { do: 'start-empty' });
      keepDlg.close();
    } catch (err) {
      fault.textContent = err.message;
      fault.hidden = false;
    }
  } });
  keepDlg.replaceChildren(el('div', { class: 'help-body' },
    el('h2', { id: 'keep-title', text: 'Import your chats?' }),
    el('p', { text: `TOMLIN now keeps your chats, staff, pictures and models in one folder outside the app: ${k.home}. Updates find it on their own. It is empty, and ${k.offer.length === 1 ? 'an older copy has' : 'older copies have'} data:` }),
    ...rows,
    el('p', { class: 'hint', text: 'Chats, staff, pictures, memory, settings and PC links are copied (the old folder keeps its own). Models and the parts that run them on a graphics card are moved, so nothing downloads again. TOMLIN starts again to do it.' }),
    el('p', { class: 'hint', text: 'Start empty is for good: this question is not asked again. Not sure yet? Decide later asks again the next time TOMLIN starts.' }),
    fault,
    el('div', { class: 'team-actions' }, go, empty, el('button', { class: 'btn quiet', type: 'button', text: 'Decide later', onclick: () => later() }))));
  // Decide later, or Escape: the question comes back the next time TOMLIN starts, not at the next page load.
  const later = () => {
    keepDlg.oncancel = null;
    api('/api/keep', { do: 'later' }).catch(() => undefined);
    keepDlg.close();
  };
  keepDlg.oncancel = e => {
    e.preventDefault();
    later();
  };
  keepDlg.showModal();
}

async function keepStart() {
  let k;
  try {
    k = await api('/api/keep');
  } catch {
    return;
  }
  if (k.offer?.length) return askBringIn(k);
  if (k.note) {
    keepSaid({ title: k.noteTitle || 'Your data', text: k.note.split('\n') });
    api('/api/keep', { do: 'note-shown' }).catch(() => undefined);
  }
}

/** A backup's file name ("2026-10-05 105600 by hand.zip") as a date to read: "5 Oct 2026, 10:56 (by hand)". */
function keepName(file) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})(\d{2}) (.*)\.zip$/.exec(file);
  if (!m) return file.replace(/\.zip$/, '');
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return `${at.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })} (${m[7]})`;
}

/** The "Your data and updates" part of the Settings page. */
app.keepBox = () => {
  const note = el('p', { class: 'hint', role: 'status', text: 'Reading…' });
  const box = el('div', { class: 'notify-box' }, el('h3', { text: 'Your data and updates' }), note);
  const ask = el('div', { hidden: true });
  const draw = k => {
    const list = k.backups.length
      ? el('ul', { class: 'keep-backups' }, ...k.backups.map(x => el('li', {},
        el('span', { text: `${keepName(x.name)} · ${keepMb(x.bytes)} `, title: x.name }),
        el('button', { class: 'link', type: 'button', text: 'Put back', onclick: async () => {
          if (!(await askHere(ask, `Put back the backup from ${keepName(x.name)}? Your data as it is now is backed up first, then TOMLIN starts again.`, 'Put it back', 'Not now', false))) return;
          try {
            afterPlanned(await api('/api/keep', { do: 'restore', name: x.name }), 'Putting a backup back', k.startedAt);
          } catch (err) {
            note.textContent = err.message;
          }
        } }))))
      : el('p', { class: 'hint', text: 'No backups yet. One is made by itself before a new version first uses your data.' });
    box.replaceChildren(
      el('h3', { text: 'Your data and updates' }),
      el('p', { class: 'hint', text: `Kept in ${k.home} (${keepMb(k.dataBytes)} of chats, pictures and settings, plus your downloaded models). To update: unzip the new version into its own folder and start it. It finds this folder, backs your data up first and downloads nothing again.` }),
      el('div', { class: 'team-actions' },
        el('button', { class: 'btn quiet', type: 'button', text: 'Open the folder', onclick: () => api('/api/keep', { do: 'open' }).catch(err => (note.textContent = err.message)) }),
        el('button', { class: 'btn quiet', type: 'button', text: 'Back up now', onclick: async () => {
          note.textContent = 'Backing up…';
          try {
            const r = await api('/api/keep', { do: 'backup' });
            draw(r);
            note.textContent = r.said;
          } catch (err) {
            note.textContent = err.message;
          }
        } })),
      el('p', { class: 'hint', text: 'Backups (the last 5 are kept; models are not in them). To keep one on a linked PC too: Nodes and memory, My local LLMs.' }),
      list,
      ask,
      note);
    note.textContent = '';
  };
  api('/api/keep').then(draw, err => (note.textContent = err.message));
  return box;
};

keepStart();
