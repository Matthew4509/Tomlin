// Settings, Manage: one press each for the linked PCs as a whole. Update all (the same run as Network's Update all
// linked PCs, home.js updateAllLinked), Scan for hardware changes (this PC and every linked PC read their hardware again,
// src/jobrun/hwscan.ts), and Shut down all linked PCs (each asks its own PIN unless it holds this admin PC's key; this PC stays on).
// The work is done where it always was; this page only gathers it. Uses app.js's helpers (el, api, $, askHere, sayHere)
// and home.js's (updateAllLinked, powerOffWithPin, askHostPin, canTurnOff, refreshPcs).
'use strict';

{
  const mg = { pcs: [], read: false };

  /** One tile (three across): a drawn mark, its name and what it does, the line it reports on, and its button at the foot. */
  function row(key, icon, name, about, button, said) {
    return el('div', { class: 'manage-tile', 'data-manage': key },
      el('span', { class: 'set-tile', 'aria-hidden': 'true' }, icon),
      el('b', { text: name }),
      el('span', { class: 'set-about', text: about }),
      said,
      el('span', { class: 'manage-go' }, button));
  }
  // Drawn large (40 px in a 64 px square). Each path is one stroke; one with class "wave" pulses (style.css), unless the
  // person asked for less motion.
  const mark = paths => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 40, height: 40, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', focusable: 'false' })) svg.setAttribute(k, String(v));
    for (const one of [].concat(paths)) {
      const p = document.createElementNS(ns, 'path');
      const [d, cls] = typeof one === 'string' ? [one, ''] : one;
      p.setAttribute('d', d);
      if (cls) p.setAttribute('class', cls);
      svg.append(p);
    }
    return svg;
  };
  const ICON_UPDATE = 'M12 3v12M7 10l5 5 5-5M5 21h14';
  // A radar dish on its stand, sending waves out from its feed (the scan reads every PC again).
  const ICON_SCAN = ['M3.5 10.5a9 9 0 0 0 10 10z', 'M8.5 15.5 13 11', 'M13 11h.01', 'M7 19.5 5.5 22h5', ['M14.5 7.5a3.5 3.5 0 0 1 2 2', 'wave wave-1'], ['M15 4.5a6.5 6.5 0 0 1 4.5 4.5', 'wave wave-2'], ['M15.5 1.5a9.5 9.5 0 0 1 7 7', 'wave wave-3']];
  const ICON_OFF = 'M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0';
  // The same three marks, smaller, on a linked PC's own window (pcs.js), in the same order: Update, Scan, Shut down.
  app.manageIcon = (which, size = 16) => {
    const svg = mark({ update: ICON_UPDATE, scan: ICON_SCAN, off: ICON_OFF }[which]);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  };

  async function load() {
    try {
      mg.pcs = (await api('/api/nodes/others')).pcs ?? [];
    } catch {
      mg.pcs = [];
    }
    mg.read = true;
    draw();
  }

  function draw() {
    const box = $('#manage-body');
    if (!box) return;
    const pcs = mg.pcs;
    const canUpdate = pcs.filter(p => p.ok && p.update && !p.update.why && !p.updating);
    const canOff = pcs.filter(p => typeof canTurnOff === 'function' && canTurnOff(p));
    const none = mg.read && !pcs.length;

    const upSaid = el('span', { class: 'set-said', role: 'status' });
    const up = el('button', { class: canUpdate.length ? 'btn primary' : 'btn', type: 'button', 'data-key': 'manage-update', disabled: !canUpdate.length,
      text: canUpdate.length ? `Update all (${canUpdate.length})` : 'Update all',
      onclick: async () => {
        up.disabled = true;
        // While it runs: Updating… after a spinning ring, as Scan now does.
        up.replaceChildren(el('span', { class: 'net-spin', 'aria-hidden': 'true' }), 'Updating…');
        upSaid.replaceChildren(el('span', { class: 'net-spin', 'aria-hidden': 'true' }), 'Updating the linked PCs that are behind this one…');
        await updateAllLinked();
        upSaid.textContent = '';
        await load();
      } });

    const scanSaid = el('span', { class: 'set-said', role: 'status' });
    const scan = el('button', { class: 'btn', type: 'button', 'data-key': 'manage-scan', onclick: async () => {
      scan.disabled = true;
      // While it runs: the button says Scanning…, and a spinning ring sits before the line.
      scan.textContent = 'Scanning…';
      scanSaid.replaceChildren(el('span', { class: 'net-spin', 'aria-hidden': 'true' }), 'Reading the hardware of this PC and each linked PC…');
      try {
        scanSaid.textContent = (await api('/api/network/hardware-scan', {})).said;
      } catch (e) {
        scanSaid.textContent = e.message;
      }
      scan.textContent = 'Scan now';
      scan.disabled = false;
      await load();
      // The left panel's PC cards read their new figures again.
      if (typeof refreshPcs === 'function') refreshPcs();
    } }, 'Scan now');

    const offSaid = el('span', { class: 'set-said', role: 'status' });
    const ask = el('div', { hidden: true });
    const off = el('button', { class: 'btn', type: 'button', 'data-key': 'manage-off', disabled: !canOff.length, text: canOff.length ? `Shut down all (${canOff.length})` : 'Shut down all',
      onclick: async () => {
        if (!(await askHere(ask, `Shut down ${canOff.map(p => `"${p.name}"`).join(', ')}? Each turns off about 15 seconds after it answers and stays off until someone switches it on again. This PC stays on.`, 'Shut them down', 'Keep them on'))) return;
        off.disabled = true;
        const said = [];
        // A PC that holds this PC's admin key asks nothing; one that does not asks its own PIN once.
        for (const p of canOff) {
          try {
            const r = await powerOffWithPin(p);
            said.push(r ? r.said : `"${p.name}": not shut down (no PIN given).`);
          } catch (e) {
            said.push(`"${p.name}": ${e.message}`);
          }
          offSaid.textContent = said.join(' ');
        }
        off.disabled = false;
        await load();
      } });
    const cannotOff = pcs.filter(p => !canOff.includes(p));

    // Only what is there: a missing part left in would be written out as the word "null".
    box.replaceChildren(...[
      none ? el('p', { class: 'hint', text: 'No PC is linked to this one yet. Link one under Network, then its tools are here.' }) : null,
      el('div', { class: 'manage-tiles' },
        row('update', mark(ICON_UPDATE), 'Update all',
          !mg.read ? 'Asking the linked PCs…' : canUpdate.length ? `${canUpdate.length} linked PC${canUpdate.length === 1 ? ' is' : 's are'} behind this one. One that does not hold this PC's admin key asks for its own PIN once.` : 'Every linked PC that answers is up to date with this one.',
          up, upSaid),
        row('scan', mark(ICON_SCAN), 'Scan for hardware changes',
          'Reads the processor, RAM and graphics cards of this PC and every linked PC again, and says what changed. TOMLIN otherwise reads them only when it starts.',
          scan, scanSaid),
        row('off', mark(ICON_OFF), 'Shut down all linked PCs',
          !mg.read ? 'Asking the linked PCs…' : canOff.length ? `Turns off ${canOff.length} linked PC${canOff.length === 1 ? '' : 's'}, one after the other. This PC stays on.${cannotOff.length ? ` Not ${cannotOff.map(p => `"${p.name}"`).join(', ')}: off, in use by its owner, or not allowing it (its owner ticks "Allow host to turn this PC off").` : ''}` : 'No linked PC can be shut down from here now: each is off, in use by its owner, or does not allow it (its owner ticks "Allow host to turn this PC off").',
          off, offSaid)),
      ask].filter(Boolean));
  }

  app.openManage = () => {
    mg.read = false;
    draw();
    showSettingsPage('manage', '#settings-manage');
    void load();
  };
}
