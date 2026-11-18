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
  // The safe choice leads: Decide later is the highlighted button, and with several older copies none is ticked (one
  // copy is the only choice there is, so it is ticked; Import still has to be pressed).
  let pick = k.offer.length === 1 ? k.offer[0].dir : '';
  const fault = el('div', { class: 'fault', role: 'alert', hidden: true });
  const rows = k.offer.map(s => {
    const radio = el('input', { type: 'radio', name: 'keep-from', value: s.dir });
    radio.checked = s.dir === pick;
    radio.addEventListener('change', () => {
      pick = s.dir;
      fault.hidden = true;
    });
    const what = [`${s.chats} chat${s.chats === 1 ? '' : 's'}`, `last used ${keepWhen(s.at)}`, s.modelBytes ? `${keepMb(s.modelBytes)} of models to move` : 'no models to move'].join(' · ');
    return el('label', { class: 'check keep-src' }, radio, el('span', {},
      el('strong', { text: s.here ? `This folder (TOMLIN ${s.version})` : `TOMLIN ${s.version}` }),
      el('span', { class: 'hint keep-path', text: ` ${s.dir}` }),
      el('br'), el('span', { class: 'hint', text: what })));
  });
  const go = el('button', { class: 'btn', type: 'button', text: 'Import', 'aria-describedby': 'keep-moves', onclick: async () => {
    if (!pick) {
      fault.textContent = 'Tick the copy to import from first (the list above), then press Import.';
      fault.hidden = false;
      return;
    }
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
  const wait = el('button', { class: 'btn primary', type: 'button', text: 'Decide later', onclick: () => later() });
  keepDlg.replaceChildren(el('div', { class: 'help-body' },
    el('h2', { id: 'keep-title', text: 'Import your chats?' }),
    el('p', { text: `TOMLIN now keeps your chats, staff, pictures and models in one folder outside the app: ${k.home}. Updates find it on their own. It is empty, and ${k.offer.length === 1 ? 'an older copy has' : 'older copies have'} data:` }),
    ...rows,
    el('p', { class: 'hint', text: 'Chats, staff, pictures, memory, settings and PC links are copied (the old folder keeps its own). Models and the parts that run them on a graphics card are moved, so nothing downloads again. TOMLIN starts again to do it.' }),
    el('p', { class: 'hint', text: 'Start empty is for good: this question is not asked again. Not sure yet? Decide later asks again the next time TOMLIN starts.' }),
    fault,
    el('div', { class: 'team-actions keep-actions' }, wait,
      el('span', { class: 'keep-go' }, go, el('span', { id: 'keep-moves', class: 'hint', text: 'moves the model files' })),
      empty)));
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
  wait.focus();
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

/** A backup's file name as a table's two cells: when ("Nov 12, 2026, 6:51 PM") and how it was made ("before 2.0.88"). */
function backupWhen(file) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})(\d{2}) (.*)\.zip$/.exec(file);
  if (!m) return [file.replace(/\.zip$/, ''), ''];
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return [at.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }), m[7]];
}

/**
 * Your data, on Data and lock: the data folder (its size and Open the folder), then Backups: how many and the newest on
 * its row with Back up now, the list folded under it as a table, each with Put back. Update this install is on Manage
 * updates (it was here too).
 */
app.keepBox = () => {
  const note = app.setSaid();
  const ask = el('div', { hidden: true });
  const folder = app.setRow({ icon: 'data', name: 'Data folder', about: 'Reading…', side: app.setButton('Open the folder', () => api('/api/keep', { do: 'open' }).catch(err => (note.textContent = err.message))) });
  const backNow = app.setButton('Back up now', async () => {
    note.textContent = 'Backing up…';
    try {
      const r = await api('/api/keep', { do: 'backup' });
      draw(r);
      note.textContent = r.said;
    } catch (err) {
      note.textContent = err.message;
    }
  }, { main: true });
  const table = el('tbody');
  // With no backups yet the table is not shown: its headings alone read as a broken list.
  const listed = el('table', { class: 'set-table', hidden: true }, el('thead', {}, el('tr', {}, el('th', { text: 'When' }), el('th', { text: 'Made' }), el('th', { text: 'Size' }), el('th', {}))), table);
  const backups = app.setRow({ icon: 'backup', name: 'Backups', about: 'Reading…', side: backNow, inside: [
    listed,
    el('div', { class: 'set-line set-foot' },
      el('p', { class: 'set-note', text: 'Keeps the newest 5, then daily, weekly and quarterly. Models are not included.' }),
      // A4: a new PC links to the PC that kept the backups, then asks for them there by backup name and PIN.
      app.setButton('Get my backups from a linked PC', () => {
        document.querySelector('dialog.mute-dlg[open], #settings[open]')?.close();
        app.openNet?.();
      }, { title: 'On a new PC: link it to the PC that kept your backups first (Network), then use Get my backups under its name' })),
    ask,
  ] });
  const draw = k => {
    folder.about.textContent = `${k.home} · ${keepMb(k.dataBytes)}`;
    backups.about.textContent = k.backups.length ? `${k.backups.length} kept · newest ${backupWhen(k.backups[0].name)[0]}` : 'None yet: one is made by itself before a new version first uses your data';
    listed.hidden = !k.backups.length;
    table.replaceChildren(...k.backups.map(x => {
      const [when, how] = backupWhen(x.name);
      return el('tr', {}, el('td', { text: when, title: x.name }), el('td', { class: 'set-dim', text: how }), el('td', { class: 'set-dim', text: keepMb(x.bytes) }),
        el('td', { class: 'set-end' }, app.setButton('Put back', async () => {
          backups.open = true;
          if (!(await askHere(ask, `Put back the backup from ${keepName(x.name)}? Your data as it is now is backed up first, then TOMLIN starts again.`, 'Put it back', 'Not now', false))) return;
          try {
            afterPlanned(await api('/api/keep', { do: 'restore', name: x.name }), 'Putting a backup back', k.startedAt);
          } catch (err) {
            note.textContent = err.message;
          }
        })));
    }));
    note.textContent = '';
  };
  api('/api/keep').then(draw, err => (note.textContent = err.message));
  return app.setPart('Your data', app.setCard(folder, backups), note);
};

keepStart();
