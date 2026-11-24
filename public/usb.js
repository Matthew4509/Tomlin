// Settings, Bootable USB: run TOMLIN on a diskless node. Four yellow steps (get Rufus; get the ISO and the parts; image
// the stick with Rufus; pick it and Mint), the admin key above them, the list of sticks minted here with when each was last seen, and the kinds of hardware the linked PCs have
// with the best run settings found for each. The server does the work (src/server/usb.ts); this page draws what it
// says and asks again every second while a download or Mint runs. Uses app.js's helpers (el, api, $) and mute.js's
// showSettingsPage.

const usbUi = { view: null, timer: 0, drive: '', said: '', kinds: null, kindsSaid: '' };

const usbMb = n => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`);
const usbStep = (n, title, ...body) => el('section', { class: 'set-part usb-step', 'aria-label': `Step ${n}: ${title}` },
  el('h3', {}, el('span', { class: 'hs-step', 'aria-hidden': 'true', text: String(n) }), title),
  el('div', { class: 'set-card usb-card' }, ...body));

async function usbDo(body, after) {
  try {
    const r = await api('/api/usb', body);
    usbUi.said = '';
    if (r.key !== undefined) usbUi.view = r;
    after?.(r);
  } catch (e) {
    usbUi.said = e.message;
  }
  await usbLoad();
}

async function usbLoad() {
  try {
    usbUi.view = await api('/api/usb');
  } catch (e) {
    usbUi.said = e.message;
  }
  usbDraw();
  clearTimeout(usbUi.timer);
  // While a download or Mint runs, its lines are asked for every second; the drive list every 5 s while the page is open.
  if (homeUi.view === 'usb') usbUi.timer = setTimeout(usbLoad, usbUi.view?.task && !usbUi.view.task.done ? 1000 : 5000);
}

/** The admin key: made once here, and never shown or written to a stick. */
function usbKeyCard(v) {
  const again = el('details', { class: 'usb-other' }, el('summary', { text: 'Lost this PC\'s key, or moving to a new admin PC?' }),
    el('p', { class: 'hint', text: 'A new admin key cannot link any stick minted with this one. Every stick has to be minted again here, and the list below starts empty.' }),
    el('div', { class: 'usb-row' }, el('button', { class: 'btn', type: 'button', text: 'Make a new admin key', onclick: () => { if (confirm('Make a new admin key? Every stick minted with the old one must be minted again before this PC can link it.')) usbDo({ action: 'key-make', again: true }); } })));
  return el('section', { class: 'set-part', 'aria-labelledby': 'usb-key-title' },
    el('h3', { id: 'usb-key-title', text: 'Admin key' }),
    el('div', { class: 'set-card usb-card' },
      v.key
        ? el('p', {}, `This PC holds the admin key (tag ${v.tag}). It never leaves this PC and is never written to a stick. Each stick gets an identity of its own at Mint, so a stick links only to this PC, this PC links only to the sticks on its list below, and a lost or copied stick is no use to anyone else.`)
        : el('p', {}, 'An admin key ties the USB to your admin account, and allows you, and only you, to send work to the machine'),
      v.key ? again : el('div', { class: 'usb-row' }, el('button', { class: 'btn primary', type: 'button', text: 'Make the admin key', onclick: () => usbDo({ action: 'key-make' }) }))));
}

/** "5 minutes ago" for a time, or "never". */
function usbAgo(at) {
  if (!at) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago (${new Date(at).toLocaleDateString()})`;
}

/** Every stick minted here: which PC it is, when last seen, and Mark lost (or Found). */
function usbSticksPart(v) {
  const list = v.sticks ?? [];
  if (!list.length) return null;
  const row = s => el('tr', { 'data-stick': s.id, class: s.lost ? 'usb-lost' : '' },
    el('td', {}, el('strong', { text: s.name }), el('span', { class: 'hint', text: ` ${s.shown}` })),
    el('td', { text: `${new Date(s.at).toLocaleDateString()}${s.drive ? `, ${s.drive}` : ''}` }),
    el('td', { text: s.lost ? 'Marked lost' : s.pcName ? `${s.pcName}${s.on ? ' (answering now)' : ''}` : s.pc ? 'Linked, not answering now' : 'Not linked yet' }),
    el('td', { text: usbAgo(s.lastSeen) }),
    el('td', {}, s.lost
      ? el('button', { class: 'btn', type: 'button', text: 'Found', title: 'It may link again', onclick: () => usbDo({ action: 'stick-found', id: s.id }) })
      : el('button', { class: 'btn', type: 'button', text: 'Mark lost', title: 'Never linked again, and its link here is removed', onclick: () => { if (confirm(`Mark "${s.name}" (${s.shown}) lost? This PC removes its link and will not link it again until you press Found.`)) usbDo({ action: 'stick-lost', id: s.id }); } })));
  return el('section', { class: 'set-part', 'aria-labelledby': 'usb-sticks-title' },
    el('h3', { id: 'usb-sticks-title', text: `Sticks minted here (${list.length})` }),
    el('div', { class: 'set-card usb-card' },
      el('p', { class: 'hint', text: 'Last seen is when this PC last heard from the PC started from the stick, linked or found by a scan. Mark a stick lost if it goes missing: a copy of it then reaches nothing.' }),
      el('table', { class: 'set-table usb-sticks' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Stick' }), el('th', { text: 'Minted' }), el('th', { text: 'PC' }), el('th', { text: 'Last seen' }), el('th', {}))),
        el('tbody', {}, ...list.map(row)))));
}

/** The download or Mint running now (or the last one): a bar and its lines. */
function usbTaskBox(t) {
  if (!t) return null;
  const pct = t.of ? Math.min(100, Math.round((t.got / t.of) * 100)) : null;
  return el('div', { class: 'usb-task', role: 'status', 'aria-live': 'polite' },
    el('p', {}, el('strong', { text: t.what }), t.done ? (t.error ? ': stopped.' : ': done.') : pct !== null ? `: ${pct}% (${usbMb(t.got)} of ${usbMb(t.of)})` : ': working…'),
    pct !== null && !t.done ? el('progress', { max: '100', value: String(pct), 'aria-label': `${t.what}, ${pct}%` }) : null,
    t.error ? el('p', { class: 'fault-line', role: 'alert', text: t.error }) : null,
    t.lines.length ? el('pre', { class: 'usb-lines', text: t.lines.join('\n') }) : null);
}

function usbDraw() {
  const box = $('#usb-page');
  const v = usbUi.view;
  if (!box) return;
  if (!v) return void box.replaceChildren(el('p', { class: 'fault-line', text: usbUi.said || 'Reading…' }));
  const busy = !!(v.task && !v.task.done);
  const keep = document.activeElement?.closest?.('#usb-page') ? document.activeElement.id : '';

  // 1. Rufus.
  const one = usbStep(1, 'Get Rufus',
    el('p', {}, 'Download Rufus (it\'s free) from ', el('a', { href: 'https://rufus.ie/', target: '_blank', rel: 'noopener noreferrer', text: 'rufus.ie' }), '. Rufus is needed to image the usb drive.'),
    el('div', { class: 'usb-row' }, el('a', { class: 'btn', href: 'https://rufus.ie/', target: '_blank', rel: 'noopener noreferrer', text: 'Open rufus.ie' })));

  // 2. The ISO, and the parts Mint puts on the stick.
  const partsMissing = v.parts.filter(p => !p.here);
  const cudaBox = el('input', { type: 'checkbox', id: 'usb-cuda' });
  cudaBox.checked = v.cudaParts.every(p => p.here) && v.cudaParts.length > 0;
  const two = usbStep(2, 'Download the Linux ISO',
    el('p', {}, `Download Debian Live ISO, make sure it is the smaller file that has no GUI, such as: ${v.iso.file} (${usbMb(v.iso.bytes)}), SHA-256 (${v.iso.sha256.slice(0, 16)}…).`),
    el('p', { class: v.iso.here ? 'hint ok' : 'hint', text: v.iso.here ? `In your Downloads folder: ${v.iso.path}` : 'Not downloaded yet.' }),
    el('div', { class: 'usb-row' },
      el('button', { class: v.iso.here ? 'btn' : 'btn primary', type: 'button', text: v.iso.here ? 'Check it again' : `Get the ISO (${usbMb(v.iso.bytes)})`, disabled: busy, onclick: () => usbDo({ action: v.iso.here ? 'iso-check' : 'iso' }) })),
    el('p', {}, `What Mint puts beside it: Node.js and llama.cpp for Linux (the same build, b11284, as this PC's runners), and the picture tools' Linux part. ${partsMissing.length ? `${usbMb(partsMissing.reduce((s, p) => s + p.bytes, 0))} to download.` : 'All here and checked.'}`),
    el('label', { class: 'check' }, cudaBox, `Also the CUDA build for NVIDIA cards, RTX 20 series and newer (${usbMb(v.cudaParts.reduce((s, p) => s + p.bytes, 0))} more). Older NVIDIA cards, AMD and Intel use Vulkan.`),
    el('div', { class: 'usb-row' },
      el('button', { class: partsMissing.length ? 'btn primary' : 'btn', type: 'button', text: partsMissing.length ? 'Get the parts' : 'Check the parts again', disabled: busy, onclick: () => usbDo({ action: 'parts', cuda: $('#usb-cuda').checked }) })));

  // 3. Rufus images the stick. 4. The stick is picked and minted.
  const drives = v.drives ?? [];
  if (!drives.some(d => d.root === usbUi.drive)) usbUi.drive = drives.find(d => !d.why)?.root ?? drives[0]?.root ?? '';
  const pick = el('select', { id: 'usb-drive', 'aria-label': 'The stick to mint' }, ...(drives.length ? drives.map(d => el('option', { value: d.root, text: `${d.root} ${d.why ? '(not a Debian live stick yet)' : d.minted ? `(minted${d.tag && d.tag !== v.tag ? ' by another admin' : d.tag ? ' by this PC' : ''})` : '(ready to mint)'}${d.free !== null ? `, ${usbMb(d.free)} free` : ''}` })) : [el('option', { value: '', text: 'No USB stick plugged in' })]));
  pick.value = usbUi.drive;
  pick.addEventListener('change', () => { usbUi.drive = pick.value; usbDraw(); });
  const chosen = drives.find(d => d.root === usbUi.drive);
  const name = el('input', { type: 'text', id: 'usb-name', maxlength: '40', autocomplete: 'off', value: $('#usb-name')?.value || 'USB node' });
  const tick = (id, text, on) => {
    const t = el('input', { type: 'checkbox', id });
    t.checked = $(`#${id}`) ? $(`#${id}`).checked : on;
    return el('label', { class: 'check' }, t, text);
  };
  const three = usbStep(3, 'Use Rufus to image the USB drive',
    el('ol', { class: 'usb-howto' },
      el('li', {}, 'In Rufus: Go to Device, Choose the stick. Boot selection, SELECT, then the ISO from step 2.'),
      el('li', {}, 'Persistent partition size: about a third of the stick (8 to 12 GB on a 32 GB stick). It keeps the node\'s settings and the models sent to it.'),
      el('li', {}, 'Press START. When Rufus asks, pick "Write in ISO Image mode (Recommended)". DD mode makes a stick TOMLIN cannot be added to.'),
      el('li', {}, 'When Rufus says READY, leave the stick in and come back here')));
  const four = usbStep(4, 'Select the stick and Mint',
    el('div', { class: 'usb-row' },
      el('label', { class: 'field' }, el('span', { text: 'The stick' }), pick),
      el('button', { class: 'btn', type: 'button', text: 'Look again', onclick: () => usbLoad() })),
    chosen?.why ? el('p', { class: 'hint', text: chosen.why }) : null,
    el('label', { class: 'field' }, el('span', { text: 'Name the PCs started from it take at first (you can rename each one later)' }), name),
    tick('usb-lend', 'Allow to be used as part of a cluster', v.allow.lend),
    tick('usb-plain', 'Allow unencrypted cluster links (faster; anything on the home network could read them)', false),
    chosen?.minted && chosen.tag && chosen.tag !== v.tag ? tick('usb-take', 'Mint over another admin\'s stick (the PCs started from it become yours)', false) : null,
    el('div', { class: 'usb-row' },
      el('button', { class: 'btn primary', type: 'button', text: 'Mint', disabled: busy || !v.key || !chosen || !!chosen.why || partsMissing.length > 0, title: 'Writes TOMLIN and a new identity for this stick onto it (never the admin key), and puts "TOMLIN node" first in its boot menu', onclick: () => usbDo({ action: 'mint', drive: usbUi.drive, name: $('#usb-name').value, cuda: $('#usb-cuda').checked, plainLinks: $('#usb-plain').checked, allow: { lend: $('#usb-lend').checked }, takeOver: $('#usb-take')?.checked === true }) }),
      chosen?.minted ? el('button', { class: 'btn', type: 'button', text: 'Remove from stick', disabled: busy, onclick: () => usbDo({ action: 'remove', drive: usbUi.drive }) }) : null),
    !v.key ? el('p', { class: 'hint', text: 'Make the admin key first (above).' }) : partsMissing.length ? el('p', { class: 'hint', text: 'Get the parts first (step 2).' }) : null,
    usbTaskBox(v.task),
    el('h4', { text: 'Then' }),
    el('ol', { class: 'usb-howto' },
      el('li', {}, 'Take the stick out, put it in the PC that is to be a node, with a network cable, and start that PC from it (F9, F12 or Esc for its boot menu; "TOMLIN node" starts by itself after 5 seconds). The first start takes a few minutes. Its screen shows its address.'),
      el('li', {}, 'NVIDIA card: start the entry "TOMLIN node (install NVIDIA driver once, needs a network)" once, with Secure Boot off. Without it the card is not used and the PC lends its processor and memory.'),
      el('li', {}, 'Here: Add another PC finds it on your network. A PC started from a stick minted here says "Made with your admin key": press Add.')),
    el('div', { class: 'usb-row' }, el('button', { class: 'btn primary', type: 'button', text: 'Add another PC', title: 'Opens Add another PC and scans your network', onclick: () => { app.openAddPc?.(); $('#node-scan')?.click(); } })));

  const minted = usbSticksPart(v);

  box.replaceChildren(...[usbUi.said ? el('p', { class: 'fault-line', role: 'alert', text: usbUi.said }) : null, usbKeyCard(v), one, two, three, four, minted, usbKindsPart()].filter(Boolean));
  if (keep) $(`#${keep}`)?.focus();
}

// ---- Best settings per kind of hardware ----

function usbKindsPart() {
  const k = usbUi.kinds;
  const body = !k ? [el('p', { class: 'hint', text: 'Press Read to list every linked PC by its kind of hardware.' })]
    : !k.length ? [el('p', { class: 'hint', text: 'No PC read yet.' })]
      : k.map(kind => el('article', { class: 'usb-kind' },
        el('h4', { text: kind.label }),
        el('p', { class: 'hint', text: `${kind.pcs.length} PC${kind.pcs.length === 1 ? '' : 's'}: ${kind.pcs.map(p => `${p.name}${p.usb ? ' (USB stick)' : ''}${p.on ? '' : ' (off)'}`).join(', ')}` }),
        kind.models.length ? el('table', { class: 'usb-best' },
          el('thead', {}, el('tr', {}, el('th', { text: 'Model' }), el('th', { text: 'Best' }), el('th', { text: 'Settings' }), el('th', { text: 'Each PC now' }), el('th', { text: '' }))),
          el('tbody', {}, ...kind.models.map(m => el('tr', {},
            el('td', { text: m.model }),
            el('td', { text: `${m.best.tps} tok/s on ${m.best.pcName}` }),
            el('td', { text: usbSettingsWords(m.best.settings) }),
            el('td', {}, ...m.each.map(x => el('div', { class: x.slow ? 'usb-slow' : '' }, `${x.name}: ${x.tps} tok/s`, x.slow ? ': under 85% of its twin: check its RAM, cooling and driver' : ''))),
            el('td', {}, kind.pcs.length > 1 ? el('button', { class: 'btn', type: 'button', text: 'Use on its twins', title: 'Sets these run settings for this model on every other PC of this kind', onclick: () => usbTwins(kind.kind, m.model) }) : null)))))
          : el('p', { class: 'hint', text: 'No speed known yet on this kind: run a speed test on one of its PCs (Network, the PC, its model, Test speed).' })));
  return el('section', { class: 'set-part', 'aria-labelledby': 'usb-kinds-title' },
    el('div', { class: 'set-head' }, el('h3', { id: 'usb-kinds-title', text: 'Best settings per kind of hardware' }),
      el('button', { class: 'btn', type: 'button', text: k ? 'Read again' : 'Read', onclick: usbKinds })),
    el('p', { class: 'hint', text: 'PCs with the same processor, memory and cards are one kind: the best settings found on one suit its twins. A twin much slower than the best usually has bad RAM, a hot card or the wrong driver.' }),
    el('div', { class: 'set-card usb-card' }, ...body, usbUi.kindsSaid ? el('pre', { class: 'usb-lines', text: usbUi.kindsSaid }) : null));
}

const usbSettingsWords = s => [s.cache ? `context cache ${s.cache}` : '', s.kvRam === true ? 'context in RAM' : s.kvRam === false ? 'context on the card' : '', s.draft ? `guessing model ${s.draft}` : '', s.ctx ? `context ${Math.round(s.ctx / 1024)}k` : ''].filter(Boolean).join(', ') || 'the usual settings';

async function usbKinds() {
  try {
    usbUi.kinds = (await api('/api/usb/kinds')).kinds;
  } catch (e) {
    usbUi.kindsSaid = e.message;
  }
  usbDraw();
}

async function usbTwins(kind, model) {
  try {
    const r = await api('/api/usb', { action: 'twins', kind, model });
    usbUi.kindsSaid = r.said.join('\n');
  } catch (e) {
    usbUi.kindsSaid = e.message;
  }
  usbDraw();
}

app.openUsb = () => {
  showSettingsPage('usb', '#settings-usb');
  usbDraw();
  void usbLoad();
};
