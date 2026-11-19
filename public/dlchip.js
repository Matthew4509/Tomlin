// The top bar's downloads chip, beside the models loaded: while anything is downloading or being copied (here, or to and
// from a linked PC), "3 downloads · 1 of 3 · 56%". It runs on the server, so it carries on with this window closed;
// opened again later, the chip says how far it got. A press opens where it is followed: Models on my other PCs for a
// transfer, the Models page for a download to this PC.
'use strict';

const dlChip = $('#dl-chip');
let dlWhere = 'net';

async function dlRead() {
  const [net, here] = await Promise.all([api('/api/network/transfers').catch(() => null), api('/api/chatmodels/get').catch(() => null)]);
  const going = (net?.transfers ?? []).filter(t => t.state === 'working');
  const local = here?.state === 'downloading' ? [{ done: here.got, bytes: here.bytes, queued: false, what: here.name }] : [];
  const all = [...local, ...going];
  dlChip.hidden = !all.length;
  if (!all.length) return;
  // The one being moved now (not waiting its turn), and how far it is.
  const now = all.find(t => !t.queued) ?? all[0];
  const pct = now.bytes ? `${Math.floor((now.done / now.bytes) * 100)}%` : 'starting';
  dlChip.textContent = all.length === 1 ? `Downloading · ${pct}` : `${all.length} downloads · 1 of ${all.length} · ${pct}`;
  dlChip.title = `${all.map(t => t.what || 'A model').join(', ')}. Press to see each one.`;
  dlWhere = going.length ? 'net' : 'models';
}

dlChip.addEventListener('click', () => (dlWhere === 'net' ? app.openNet?.() : app.openModels?.()));
dlRead();
setInterval(() => {
  if (!document.hidden) dlRead();
}, 4000);
