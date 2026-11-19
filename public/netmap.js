// The Network page's map: how this PC's network connects, drawn as the same PC boxes as Cluster. The PCs this one is a
// node for (its admins) sit above it, this PC in the middle, the PCs it connects to (its nodes) below, then "Add a node".
// Each box's buttons open the part of the page that does the work (the role tabs and their sections stay as they were),
// so nothing here changes a setting by itself except "Set as node" / "Stop being a node", which is the This PC switch.
'use strict';

/** RAM, card memory and cores in one line, as the Cluster boxes say them. */
function netMapSpecs(m) {
  return [m.ram ? `${clusterGb(m.ram)} RAM` : '', m.vram ? `${clusterGb(m.vram)} card memory${m.card ? ` (${m.card})` : ''}` : m.ram ? 'no card' : '', m.cores ? `${m.cores} cores` : ''].filter(Boolean).join(' · ');
}

/** One PC box: icon, name with its tags, the specs line, how it is now, and its buttons. */
function netMapBox({ name, tags = [], specs = '', state = '', off = false, quiet = false, here = false, actions = [] }) {
  return el('div', { class: `net-pc${off ? ' is-off' : ''}${here ? ' is-here' : ''}` },
    el('span', { class: 'cluster-mark' }, clusterIcon(ICON_PC, 20)),
    el('div', { class: 'net-pc-text' },
      el('b', {}, name, ...tags.filter(Boolean).map(t => el('span', { class: 'cluster-tag', text: t }))),
      specs ? el('span', { class: 'hint', text: specs }) : null,
      state ? el('span', { class: `net-pc-state${off || quiet ? ' is-off' : ''}`, text: state }) : null),
    actions.length ? el('div', { class: 'net-pc-actions' }, ...actions) : null);
}

/** The line between two rows of boxes, with what it means; dashed when nothing is connected along it now. */
const netMapLink = (words, dashed = false) => el('div', { class: `net-link${dashed ? ' is-dashed' : ''}` }, el('span', { class: 'net-link-words', text: words }));

const netMapBtn = (text, onclick, primary = false) => el('button', { class: `btn${primary ? ' primary' : ''}`, type: 'button', text, onclick });

function drawNetMap() {
  const box = $('#net-map');
  if (!box) return;
  const sh = homeUi.nodes?.share;
  // The full list (Test network, the Linked PCs part) when it has been read; else the left panel's PCs, always there.
  const pcs = homeUi.others ?? (homeUi.pcs ?? []).map(p => ({ ...p, ok: p.state !== 'off', light: true }));
  const when = at => new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  // Above: the PCs that linked to this one (its admins), only while this PC is a node. Guests are not admins.
  const admins = sh?.on ? (sh.paired ?? []).filter(p => !p.guest) : [];
  const using = new Set((sh?.inUse ?? []).flatMap(u => u.pcs));
  const top = admins.map(a => netMapBox({
    name: a.name, tags: ['Admin'],
    state: using.has(a.name) ? 'Using this PC now' : `Linked ${when(a.at)}`,
    actions: [netMapBtn('Manage', () => app.netSection('pc'))],
  }));

  // This PC: its role from what it does now (a node, an admin with nodes, or both).
  const hw = app.status?.hardware;
  const mine = { ram: hw?.ram?.total ?? 0, vram: hw?.gpu && !hw.gpu.shared ? hw.gpu.total ?? 0 : 0, card: hw?.gpu && !hw.gpu.shared ? hw.gpu.name ?? '' : '', cores: hw?.cpu?.cores ?? 0 };
  const isNode = !!sh?.on;
  const nodes = pcs.filter(p => p.role !== 'guest');
  const roleTags = [nodes.length ? 'Admin' : null, isNode ? 'Node' : null];
  const flip = netMapBtn(isNode ? 'Stop being a node' : 'Set as node', () => $('#node-on').click(), !isNode && !nodes.length);
  const here = netMapBox({
    name: app.pcLabel('here'), tags: ['This PC', ...roleTags], specs: netMapSpecs(mine), here: true, quiet: !isNode || !admins.length,
    state: isNode ? (admins.length ? `A node for ${admins.map(a => `"${a.name}"`).join(', ')}` : 'A node: no admin has linked to it yet. Type its setup code on the admin PC.') : nodes.length ? '' : 'Not linked to any PC yet.',
    actions: [flip, isNode ? netMapBtn('Node settings', () => app.netSection('pc')) : null].filter(Boolean),
  });

  // Below: the PCs this one connects to (its nodes, and PCs it is a guest on), then Add a node.
  const below = pcs.map(p => {
    const seen = (homeUi.pcs ?? []).find(x => x.id === p.id) ?? p;
    const m = { ram: seen.memory?.ram?.total ?? homeUi.pcMem?.[p.id]?.ram ?? 0, vram: seen.memory?.cards?.total ?? seen.memory?.gpu?.total ?? homeUi.pcMem?.[p.id]?.vram ?? 0, card: seen.memory?.gpu?.name ?? '', cores: (seen.cpu ?? p.cpu)?.cores ?? 0 };
    const state = p.light ? p.text : !p.ok ? (p.relink || p.answered ? 'Not linked any more: find it again and link again' : 'Not answering now')
      : p.away ? 'Its owner is using it for now' : p.backupsOnly ? 'Keeps backups' : p.model ? `On: ${p.model}` : 'Asleep: no model loaded';
    return netMapBox({
      name: app.pcLabel?.(p.id) || p.name, tags: [p.role === 'guest' ? 'Guest here' : 'Node'], specs: netMapSpecs(m), state, off: !p.ok,
      actions: [netMapBtn('Open', () => {
        app.netSection('linked');
        openPcDetail(p.id);
      })],
    });
  });
  const add = el('button', { class: 'net-pc net-pc-add', type: 'button', onclick: () => $('#node-pass-addnode').click() },
    el('span', { class: 'net-pc-plus', 'aria-hidden': 'true', text: '+' }), el('b', { text: 'Add a node' }));

  const anyUp = pcs.some(p => p.ok);
  // Drawn again only when something shown changed (the left panel redraws every few seconds).
  const sig = JSON.stringify([admins, [...using], isNode, nodes.length, mine, pcs.map(p => [p.id, p.ok, p.text, p.model, p.away, p.name])]);
  if (sig === box.dataset.sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(...[
    top.length ? el('div', { class: 'net-map-row' }, ...top) : null,
    top.length ? netMapLink(using.size ? 'uses this PC' : 'can use this PC', !using.size) : null,
    el('div', { class: 'net-map-row' }, here),
    netMapLink(pcs.length ? 'connects to' : 'add a PC to connect to', !anyUp),
    el('div', { class: 'net-map-row' }, ...below, add)].filter(Boolean));
}
app.drawNetMap = drawNetMap;
