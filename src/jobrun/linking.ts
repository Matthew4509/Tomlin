// This PC linking other PCs to it (they are its nodes): add one with its setup code, find TOMLIN on the home network,
// answer a node's "I need to use the pc", start it again, Backups only, remove. This PC's own node side is node.ts.
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import * as share from '../share.ts';
import * as link from '../link.ts';
import * as brains from '../brains.ts';
import * as linkhelp from '../linkhelp.ts';
import * as netfacts from '../netfacts.ts';
import { restored, whenReleased } from '../staff.ts';
import { d } from './shared.ts';
import type { Remote } from '../store.ts';
import { answersAt, hello, pullOf, seen, sendPassAsk, workerPost } from './links.ts';
import * as findagain from '../findagain.ts';
import * as guestpass from '../guestpass.ts';
import { setup } from './sizing.ts';
import { clusterGaps, labelOf, lendersInUse, membersFacts, setBorrow, setPlainLink } from './maxhost.ts';
import { addWhy, heldFor, withHere, withMembers, withOn, without } from '../cluster/members.ts';
import { chooseLoader, loaderWhy } from '../cluster/loader.ts';
import { lanAddresses, lanList, shareState } from './node.ts';

/** The link request with as many extra proofs as fit: a node reads only 4 KB of it (and an older one cuts the rest). */
function pairBody(ask: Record<string, unknown>, proofs: string[]): string {
  for (let n = proofs.length; n > 0; n--) {
    const text = JSON.stringify({ ...ask, proofs: proofs.slice(0, n) });
    if (text.length <= 3800) return text;
  }
  return JSON.stringify(ask);
}

export async function remotes(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const s = await d.store.settings();
  /** What an action says beside its answer (the page shows it). */
  let note = '';
  if (b.action === 'add') {
    // What was typed, read the way the link helper reads it (2.0.64): 192.178 for 192.168, the router's address, this
    // PC's own. The router is known only from Windows' own list, read when the address could be one of those.
    const typed = String(b.url ?? '');
    const quick = lanList().map(n => ({ alias: n.via, address: n.address, prefix: 24, gateway: null }));
    let advice = linkhelp.addressAdvice(typed, quick);
    if (advice.problem || /\.1(:\d+)?\/?$/.test(typed.trim())) advice = linkhelp.addressAdvice(typed, await ownNow());
    const url = advice.problem ? null : share.cleanWorkerUrl(typed);
    if (!url) return { status: 400, body: { error: advice.problem ?? 'That PC\'s address is not one on your home network. Press "Find PCs on my network" again, or type the address shown on that PC (for example 192.168.1.20:8741).', suggest: advice.suggest } };
    const code = share.cleanCode(b.code);
    if (code.length !== 8) return { status: 400, body: { error: 'Type that PC\'s setup code: 8 letters and numbers, shown on that PC under Network (for example ABCD-EFGH).' } };
    const pinWhy = linkhelp.pinAdvice(String(b.pin ?? ''));
    if (pinWhy) return { status: 400, body: { error: pinWhy } };
    const pin = String(b.pin ?? '').replace(/\D/g, '');
    // A name (desk.local) must point inside the home network before anything is sent to it (S6).
    const outside = await share.homeNetworkWhy(url);
    if (outside) return { status: 400, body: { error: outside } };
    const unreachable = (e: unknown) => ({ status: 502, body: { error: `Nothing answered at ${url.replace('http://', '')} (${(e as Error).message}).${advice.warn ? ` ${advice.warn}` : ''} The Link helper below tests it from here and says what is in the way.`, help: true } });
    // An older PC cannot make the encrypted link (F7 E1): said plainly, before anything is sent.
    let about: Record<string, unknown>;
    try {
      const r = await fetch(`${url}/worker/whoami`, { signal: AbortSignal.timeout(5000) });
      about = (await r.json()) as Record<string, unknown>;
    } catch (e) {
      // Answered, but not with JSON (a web page or another program): not a TOMLIN node. Any other failure (a timeout or a
      // dropped connection while reading) is "nothing answered", so the Link helper's advice applies.
      if (!(e instanceof SyntaxError)) return unreachable(e);
      about = {};
    }
    // "smart-manager": the app's name on the wire since before TOMLIN; every PC, old and new, answers with it.
    // A TOMLIN PC with node mode off does not listen on the link port at all (and its own screen is on another port),
    // so whatever answers here is not that PC's link part.
    if (about.app !== 'smart-manager') return { status: 400, body: { error: `Something answered at ${url}, but it is not TOMLIN's link part. If TOMLIN is running on that PC, tick "Enable this PC as a node" there (Settings, Network) and use the address shown there; the port is usually 8741, not the one in the browser address bar.` } };
    if (Number(about.link) !== link.LINK_VERSION) return { status: 400, body: { error: `That PC runs an older TOMLIN (${String(about.version || 'before 2.0.26').slice(0, 20)}), which cannot make the encrypted link. Update TOMLIN there, then link again.` } };
    // The setup code (and the PIN) never cross the network: both PCs prove they know them (src/link.ts).
    const key = await link.pairKey(code, pin);
    const { ask, priv } = link.hostAsk(key, shareState.id, shareState.name !== share.DEFAULT_SHARE.name ? shareState.name : 'TOMLIN', !!pin);
    // Linked before at this address with working keys: proved, so the new link takes over the old one there.
    const oldKeys = link.keysOf(s.remotes.find(r => r.url === url)?.key);
    const proof = oldKeys ? link.takeOverProof(oldKeys, ask.pub) : undefined;
    // The same PC at a new address (a router that gave it another one): this PC does not know yet which link it is, so
    // it proves each link it holds; the node takes over the one it knows (and keeps its restore points). Each proof
    // opens only with that link's own keys, so the other nodes' links are not given away.
    const proofs = s.remotes.filter(r => r.url !== url).map(r => link.keysOf(r.key)).filter((k): k is Buffer => !!k).slice(0, 16).map(k => link.takeOverProof(k, ask.pub));
    let res: Response;
    try {
      res = await fetch(`${url}/worker/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: pairBody({ ...ask, ...(proof ? { proof } : {}) }, proofs), signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return unreachable(e);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { status: res.status === 429 ? 429 : 400, body: { error: `That PC said: ${String(data.error ?? `no (${res.status})`)}`, needPin: data.needPin === true } };
    let done: ReturnType<typeof link.hostFinish>;
    try {
      done = link.hostFinish(key, ask, priv, data);
    } catch (e) {
      return { status: 502, body: { error: `That PC: ${(e as Error).message}` } };
    }
    // The node's own name, as its owner typed it there: this PC cannot rename it.
    const name = done.name.replace(/[^\w .'-]/g, '').trim().slice(0, 40) || 'Worker PC';
    // The node's own id, so linking it again (or at a new address) keeps its chats and staff.
    // The list as it is now (read again after the network work): a PC removed or renamed meanwhile stays so.
    const now = (await d.store.settings()).remotes;
    const others = now.filter(r => r.url !== url && r.id !== done.id);
    const id = /^[0-9a-f]{8}$/.test(done.id) ? done.id : randomBytes(4).toString('hex');
    // The same PC (its own id) linked again: only the address and keys are new; what this PC set for it (Backups only)
    // and its last known models stay. Another PC that took over an address starts fresh.
    const same = now.find(r => r.id === id);
    const made: Remote = { ...(same?.backupsOnly ? { backupsOnly: true } : {}), ...(same?.noBorrow ? { noBorrow: true } : {}), ...(same?.mac ? { mac: same.mac } : {}), ...(same?.models ? { models: same.models } : {}), id, name, url, token: done.token, key: link.keysText(done.keys) };
    await d.store.saveSettings({ remotes: [...others, made] });
    // A PC released for now, back: its hires go back on it.
    for (const m of d.staff.list()) {
      const back = restored(m, id);
      if (back) await d.staff.change(m.id, back);
    }
    // Asked at once, so the people who work there show straight away.
    await hello((await d.store.settings()).remotes.find(r => r.id === made.id)!, 4000).catch(() => undefined);
    // Another PC (another id) already linked under this name: linked all the same, and said, so two cards called
    // "Worker PC" are not read as one PC that is both off and on.
    const twin = others.find(r => r.name.toLowerCase() === name.toLowerCase());
    // The page asks what to call it now (its own name, and the computer's, are offered): a name given here shows in
    // every list in place of the one it gives itself, so two PCs never share one again (public/home.js linkPc).
    const computer = brains.cleanComputer((seen.get(id)?.memory as { computer?: unknown } | null | undefined)?.computer) || same?.computer || '';
    // The node told which it was: a setup code links as its admin, a pass code as a guest (its hello says so).
    const h = seen.get(id);
    const role = h?.guest ? 'guest' : 'admin';
    // A guest network with a newer TOMLIN: offered at once (never older; over a home network only when chosen).
    const p = h && role === 'guest' ? pullOf(h, name) : null;
    const pull = h && p && p.why === '' && !guestpass.guestPullWhy({ id, role: 'guest' }, (await d.store.settings()).remotes, h.version, d.version, true) ? { version: h.version, choose: !!guestpass.guestPullWhy({ id, role: 'guest' }, (await d.store.settings()).remotes, h.version, d.version, false) } : null;
    const linked = { id, name, computer, twin: twin ? twin.name : null, role, expires: h?.guest?.expires ?? null, pull };
    if (twin) return { status: 200, body: { ...(await setup()), linked, sameName: `Linked. "${twin.name}" at ${twin.url} has the same name. Give this one a name of its own below, so the two are told apart everywhere.` } };
    return { status: 200, body: { ...(await setup()), linked } };
  } else if (b.action === 'diagnose') {
    return { status: 200, body: await diagnose(b) };
  } else if (b.action === 'pass-ask') {
    // A request to the host of a guest pass that ended there (sent now, or kept here until that PC answers).
    const r = s.remotes.find(x => x.id === String(b.id ?? ''));
    if (!r) return { status: 404, body: { error: 'That PC is no longer linked.' } };
    if (r.role !== 'guest' || r.passEnd?.state !== 'expired') return { status: 400, body: { error: `This PC's pass on "${r.name}" has not expired, so there is nothing to ask for.` } };
    const text = guestpass.cleanAskText(b.text);
    if (!text) return { status: 400, body: { error: 'Write a few words for the host first.' } };
    return sendPassAsk(r, text);
  } else if (b.action === 'scan') {
    return { status: 200, body: { found: await scan(Number(b.port) || share.DEFAULT_SHARE.port), own: lanList() } };
  } else if (b.action === 'find-again') {
    // A linked PC that stopped answering, perhaps because the router gave it another address: found on the home network
    // and proved over its own link (src/findagain.ts), then only its address is saved.
    const r = s.remotes.find(x => x.id === String(b.id ?? ''));
    if (!r) return { status: 404, body: { error: 'That PC is no longer linked.' } };
    if (!link.keysOf(r.key)) return { status: 400, body: { error: `"${r.name}" was linked before links were encrypted, so it cannot be found this way. Link it again: Find PCs on my network, then its setup code.` } };
    if (await hello(r, 4000).then(() => true, () => false)) return { status: 200, body: { ...(await setup()), note: `"${r.name}" answers at its address (${r.url.replace(/^https?:\/\//, '')}): nothing to change.` } };
    let port = share.DEFAULT_SHARE.port;
    try {
      port = Number(new URL(r.url).port) || port;
    } catch {
      // A saved address that cannot be read: the usual port.
    }
    const found = await scan(port);
    // Read after the scan: every PC that answered it is now in the ARP table.
    const order = findagain.rankFound(r, found, findagain.ipForMac(await findagain.readArp(), r.mac));
    for (const url of order) {
      if (await share.homeNetworkWhy(url)) continue;
      if (!(await answersAt(r, url))) continue;
      const now = (await d.store.settings()).remotes;
      if (!now.some(x => x.id === r.id)) return { status: 404, body: { error: 'That PC is no longer linked.' } };
      await d.store.saveSettings({ remotes: now.map(x => (x.id === r.id ? { ...x, url } : x)) });
      console.log(`"${r.name}" moved from ${r.url} to ${url}: its address is saved.`);
      await hello((await d.store.settings()).remotes.find(x => x.id === r.id)!, 4000).catch(() => undefined);
      return { status: 200, body: { ...(await setup()), note: findagain.foundWords(r.name, r.url, url), moved: url } };
    }
    return { status: 404, body: { error: findagain.notFoundWords(r.name, found.length) } };
  } else if (b.action === 'answer') {
    // "I need to use the pc, please log out for N hours", from that PC's lock screen: Log out (for those hours) or Not now.
    const r = s.remotes.find(x => x.id === String(b.id ?? ''));
    if (!r) return { status: 404, body: { error: 'That PC is no longer linked.' } };
    let res: Response;
    try {
      res = await workerPost(r, '/worker/ask-answer', { at: String(b.at ?? ''), yes: b.yes === true }, AbortSignal.timeout(15_000));
    } catch (e) {
      return { status: 502, body: { error: `"${r.name}" could not be reached (${(e as Error).message}), so it was not answered. Try again when it is on.` } };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    await hello(r, 4000).catch(() => undefined);
    if (!res.ok) return { status: res.status, body: { error: `"${r.name}" said: ${String(data.error ?? `no (${res.status})`)}` } };
    return { status: 200, body: { text: String(data.text ?? 'Answered.') } };
  } else if (b.action === 'back') {
    // F7 E5: start a PC again after someone there pressed "I need to use the pc". Within the hour it asks first.
    const r = s.remotes.find(x => x.id === String(b.id ?? ''));
    if (!r) return { status: 404, body: { error: 'That PC is no longer linked.' } };
    let res: Response;
    try {
      res = await workerPost(r, '/worker/back', { confirm: b.confirm === true }, AbortSignal.timeout(15_000));
    } catch (e) {
      return { status: 502, body: { error: (e as Error).message } };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { status: res.status, body: { error: `"${r.name}" said: ${String(data.error ?? `no (${res.status})`)}`, needConfirm: data.needConfirm === true } };
    await hello(r, 4000).catch(() => undefined);
    return { status: 200, body: { text: String(data.text ?? 'Started again.') } };
  } else if (b.action === 'backups-only') {
    // "Backups only" on or off for one linked PC. On: its hires (and a job worker set to it) stop using it; asked
    // first when there are any, naming them.
    const r = s.remotes.find(x => x.id === String(b.id ?? ''));
    if (!r) return { status: 404, body: { error: 'That PC is no longer linked.' } };
    const on = b.on === true;
    const id = r.id;
    const onIt = (ref: string | null | undefined) => { const x = brains.parseRef(ref); return x.kind === 'remote' && x.pc === id; };
    const hires = on ? d.staff.list().filter(m => onIt(m.model) || onIt(m.fallback)) : [];
    if (hires.length && b.confirm !== true) {
      const names = hires.map(m => m.name);
      return { status: 409, body: { needConfirm: true, error: `${names.length === 1 ? names[0] + ' works' : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + ' work'} on "${r.name}". Backups only takes them off it: each one moves to their second model, or has no model until you pick one (Hire staff, Change).` } };
    }
    await d.store.saveSettings({ remotes: (await d.store.settings()).remotes.map(x => (x.id === id ? { ...x, backupsOnly: on || undefined } : x)) });
    // A Backups only PC cannot be in the cluster (the cluster refuses it the other way round): it leaves the set.
    if (on) await d.store.saveSettings({ cluster: without((await d.store.settings()).cluster, id) });
    if (on) {
      const jm = (await d.store.settings()).jobModels;
      if (Object.values(jm).some(v => onIt(v))) await d.store.saveSettings({ jobModels: Object.fromEntries(Object.entries(jm).map(([k, v]) => [k, onIt(v) ? '' : v])) });
      for (const m of hires) {
        if (onIt(m.model)) await d.staff.change(m.id, { model: onIt(m.fallback) ? null : m.fallback ?? null, fallback: null });
        else await d.staff.change(m.id, { fallback: null });
      }
    }
    await hello((await d.store.settings()).remotes.find(x => x.id === id)!, 4000).catch(() => undefined);
  } else if (b.action === 'borrow-max') {
    // Max mode: "Don't borrow from it" (on: false) or borrow again (on: true). A linked PC whose owner ticked "Allow to be
    // used as part of a cluster" is borrowed from with no tick here; this is only the way out. Saved on this PC; the
    // environment variable TOMLIN_MAX, when it names PCs, still overrides it.
    const next = setBorrow(s.remotes, String(b.id ?? ''), b.on === true);
    if (!next) return { status: 404, body: { error: 'That PC is no longer linked.' } };
    await d.store.saveSettings({ remotes: next });
  } else if (b.action === 'plain-link') {
    // "Unencrypted cluster link": ask that PC to lend over a stream that is not sealed. It takes effect only when that PC's
    // owner ticked "Allow unencrypted cluster links" there too, and from the next load (a running stream keeps its kind).
    const next = setPlainLink(s.remotes, String(b.id ?? ''), b.on === true);
    if (!next) return { status: 404, body: { error: 'That PC is no longer linked.' } };
    await d.store.saveSettings({ remotes: next });
  } else if (b.action === 'cluster') {
    // The cluster entry (src/cluster/members.ts): `members` rebuilds the set (ids of linked PCs), `on` switches it on or off;
    // either or both. While it is on its members are held for borrowing: their hires are taken off them (asked first, and
    // put back when it is switched off). `takesPart`: this PC loads the model itself (true, as always before) or stays out
    // and only sends the chat, with the strongest member that can loading it (false; src/cluster/loader.ts). Refused, in
    // plain words, when no member can load it now: never switched on when it could not run a model.
    const was = s.cluster;
    let next = was;
    if (Array.isArray(b.members)) next = withMembers(next, b.members, s.remotes.map(r => r.id));
    // A PC added now must answer now: one that is off, asleep or not answering cannot join (it could not load or lend).
    for (const id of next.members.filter(x => !was.members.includes(x))) {
      const r = s.remotes.find(x => x.id === id);
      if (!r) continue;
      const h = await hello(r, 4000).then(x => ({ ok: true, away: x.away }), () => ({ ok: false, away: undefined }));
      const why = addWhy(labelOf(r), { ...h, seenAt: seen.get(id)?.at ?? null });
      if (why) return { status: 400, body: { error: why } };
    }
    const loose = next.members.map(id => s.remotes.find(r => r.id === id)).filter(r => r?.backupsOnly === true);
    if (loose.length) return { status: 400, body: { error: `${loose.map(r => `"${labelOf(r!)}"`).join(' and ')} ${loose.length === 1 ? 'is' : 'are'} set to Backups only, so ${loose.length === 1 ? 'it' : 'they'} cannot be in the cluster. Untick Backups only on ${loose.length === 1 ? 'its' : 'their'} card first (Network, Linked PCs).` } };
    if (typeof b.on === 'boolean') {
      const set = withOn(next, b.on);
      if (!set) return { status: 400, body: { error: 'The cluster has no PC in it yet. Pick the PCs for it first (Network, Cluster).' } };
      next = set;
    }
    const said: string[] = [];
    // No PC in the cluster yet: "takes part" is only saved (on) or cleared (off); there is nobody to load the model instead.
    const empty = !next.members.length;
    if (empty && b.takesPart === false) next = withHere(next, true)!;
    const wantOut = !empty && (typeof b.takesPart === 'boolean' ? !b.takesPart : next.out === true);
    // Only the owner's own press makes "takes part" a saved choice; nothing else switches it on.
    if (!wantOut && (next.out || b.takesPart === true)) next = withHere(next, true, '', b.takesPart === true)!;
    if (wantOut) {
      // Each member asked now, so the choice reads what they say this moment (on, its links, its network).
      await Promise.all(s.remotes.filter(r => next.members.includes(r.id)).map(r => hello(r, 4000).catch(() => undefined)));
      const facts = membersFacts(next, (await d.store.settings()).remotes);
      // A loader already chosen stays while it still can (the set changed around it); switching out picks afresh.
      const kept = typeof b.takesPart !== 'boolean' && facts.length >= 2 ? facts.find(f => f.id === next.loader && !loaderWhy(f, facts).length) : undefined;
      const chosen = kept ? { loader: kept, notes: [] as string[] } : chooseLoader(facts);
      if ('why' in chosen) {
        if (typeof b.takesPart === 'boolean') return { status: 400, body: { error: `This PC cannot stay out of the cluster yet: ${chosen.why.replace(/\.$/, '')}.` } };
        next = withHere(next, true)!;
        said.push(`This PC takes part in the cluster again (it loads the model): ${chosen.why.replace(/\.$/, '')}.`);
      } else {
        next = withHere(next, false, chosen.loader.id)!;
        if (next.loader !== was.loader || !was.out) said.push(`This PC now connects to the cluster and sends the chat. "${chosen.loader.name}" loads the model from its own disk and borrows from the other PCs in the cluster.`, ...chosen.notes);
      }
    }
    const changed = next.on !== was.on || next.members.join() !== was.members.join() || next.loader !== was.loader;
    // A model loaded with Max mode holds the members' cards and RAM through open streams: changing the cluster under it
    // would say "Off" while they are still in use, or hold PCs the model does not use. It is unloaded first.
    const busy = changed ? lendersInUse() : [];
    if (busy.length) return { status: 409, body: { error: `A model loaded here is using ${busy.map(n => `"${n}"`).join(' and ')} through Max mode now. Unload it first, then change the cluster.` } };
    // PCs that become held now: their staff come off them first. PCs let go: their staff go back.
    const taken = next.on ? next.members.filter(id => heldFor(next, id) && !heldFor(was, id)) : [];
    const freed = was.members.filter(id => heldFor(was, id) && !heldFor(next, id));
    const refOn = (pc: string) => (ref: string | null | undefined) => { const x = brains.parseRef(ref); return x.kind === 'remote' && x.pc === pc; };
    const hires = taken.length ? d.staff.list().filter(m => taken.some(pc => refOn(pc)(m.model) || refOn(pc)(m.fallback))) : [];
    if (hires.length && b.confirm !== true) {
      const names = hires.map(m => m.name);
      const where = taken.map(id => `"${labelOf(s.remotes.find(r => r.id === id)!)}"`).join(' and ');
      return { status: 409, body: { needConfirm: true, error: `${names.length === 1 ? names[0] + ' works' : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + ' work'} on ${where}. A cluster that is on holds those PCs for big models: each one moves to their second model, or has no model until you pick one (Hire staff, Change). They go back when the cluster is switched off.` } };
    }
    // Staff first, then the set: a chat running on a PC that is about to be held has moved before the hold begins.
    for (const pc of taken) {
      const on = refOn(pc);
      if ((await d.store.settings()).jobModels && Object.values((await d.store.settings()).jobModels).some(v => on(v))) await d.store.saveSettings({ jobModels: Object.fromEntries(Object.entries((await d.store.settings()).jobModels).map(([k, v]) => [k, on(v) ? '' : v])) });
      for (const m of d.staff.list()) {
        const change = whenReleased(m, pc, on);
        if (change) await d.staff.change(m.id, change);
      }
    }
    await d.store.saveSettings({ cluster: next });
    for (const pc of freed) {
      for (const m of d.staff.list()) {
        const back = restored(m, pc);
        if (back) await d.staff.change(m.id, back);
      }
    }
    // Each PC whose state changed answers again now, so its models show or hide at once.
    const touched = new Set([...was.members, ...next.members]);
    await Promise.all((await d.store.settings()).remotes.filter(r => touched.has(r.id)).map(r => hello(r, 4000).catch(() => undefined)));
    if (next.on && !was.on && !next.out && d.chat?.view.state === 'connected') said.push('The model loaded now keeps running on this PC alone. Load it again to use the cluster.');
    if (next.on) said.push(...clusterGaps());
    if (said.length) note = said.join(' ');
  } else if (b.action === 'on-it' || b.action === 'remove') {
    const id = String(b.id ?? '');
    if (!s.remotes.some(r => r.id === id)) return { status: 404, body: { error: 'That PC is no longer linked.' } };
    const gone = (ref: string | null | undefined) => { const x = brains.parseRef(ref); return x.kind === 'remote' && x.pc === id; };
    if (b.action === 'on-it') return { status: 200, body: { hires: d.staff.list().filter(m => gone(m.model) || gone(m.fallback)).map(m => m.name) } };
    // A hire whose brain was on that PC (what it had loaded, or one of its shared models) no longer points at it. Done
    // first: a removal that fails part-way leaves the PC linked, so pressing Remove again finishes it.
    for (const m of d.staff.list()) {
      const change = whenReleased(m, id, gone, b.forGood === true);
      if (change) await d.staff.change(m.id, change);
    }
    if (Object.values(s.jobModels).includes(`remote:${id}`)) await d.store.saveSettings({ jobModels: Object.fromEntries(Object.entries(s.jobModels).map(([k, v]) => [k, v === `remote:${id}` ? '' : v])) });
    await d.store.saveSettings({ remotes: (await d.store.settings()).remotes.filter(r => r.id !== id) });
    seen.delete(id);
  } else return { status: 400, body: { error: 'Unknown worker action.' } };
  return { status: 200, body: note ? { ...(await setup()), note } : await setup() };
}

/** This PC's home connections with their routers (Windows' own list), or its addresses alone when that cannot be read. */
async function ownNow(): Promise<linkhelp.Own[]> {
  const adapters = await netfacts.readAdapters();
  return adapters ? linkhelp.homeOf(adapters) : lanList().map(n => ({ alias: n.via, address: n.address, prefix: 24, gateway: null }));
}

/**
 * The link helper, from this PC (2.0.64): the address and name typed are read, then the other PC is tested from here
 * (a ping, the node port, its hello) and Windows' list of nearby devices is read, and it all becomes one verdict
 * (src/linkhelp.ts diagnoseLink). Only home-network addresses are ever asked; nothing is changed anywhere.
 */
async function diagnose(b: Record<string, unknown>): Promise<linkhelp.Verdict> {
  const port = Number(b.port) >= 1 && Number(b.port) <= 65535 ? Math.trunc(Number(b.port)) : share.DEFAULT_SHARE.port;
  const own = await ownNow();
  const address = String(b.address ?? '').trim().slice(0, 200);
  const name = String(b.name ?? '').trim().slice(0, 63);
  const nodeOn = b.nodeOn === true ? true : b.nodeOn === false ? false : null;
  const advice = address ? linkhelp.addressAdvice(address, own, port) : null;
  const named = name ? { found: await netfacts.lookupName(name) } : null;
  let host: string | null = null;
  let at = port;
  if (advice?.url && !advice.problem) {
    const u = new URL(advice.url);
    host = u.hostname.replace(/^\[|\]$/g, '');
    at = Number(u.port) || port;
    // A name is asked only when every address it gives is on the home network (S6).
    if (!isIP(host) && (await share.homeNetworkWhy(advice.url))) host = null;
  }
  if (!host && named) host = named.found.find(ip => isIP(ip) === 4 && own.some(o => linkhelp.sameNet(o.address, ip, o.prefix))) ?? null;
  let ping: boolean | null = null;
  let probe: linkhelp.Probe | null = null;
  let whoami: linkhelp.LinkFacts['whoami'] = null;
  if (host) {
    [ping, probe] = await Promise.all([isIP(host) ? netfacts.pingHost(host) : Promise.resolve(null), netfacts.probePort(host, at)]);
    if (probe === 'open') {
      try {
        const j = (await (await fetch(`http://${isIP(host) === 6 ? `[${host}]` : host}:${at}/worker/whoami`, { signal: AbortSignal.timeout(4000) })).json()) as Record<string, unknown>;
        whoami = { tomlin: j.app === 'smart-manager', version: String(j.version ?? '').slice(0, 20), linkOk: Number(j.link) === link.LINK_VERSION };
      } catch {
        whoami = { tomlin: false, version: '', linkOk: false };
      }
    }
  }
  const v6Only = linkhelp.countV6Only(await netfacts.readNeighbors(), own);
  return linkhelp.diagnoseLink({ own, nodeOn, address, name, port: at, ping, probe, whoami, named, v6Only });
}

/**
 * "Find PCs on my network": asks every address next to this PC's own (the same /24) whether TOMLIN is there with
 * sharing on. Each answers only its name and whether it asks for a PIN; linking still needs its setup code. A PC
 * linked before is "broken" when its saved link cannot work (made before links were encrypted): it needs linking again.
 */
async function scan(port: number): Promise<{ url: string; name: string; pin: boolean; linked: boolean; broken: boolean; version: string; id: string | null; state: string; stateText: string; canAsk: boolean; ask: unknown }[]> {
  const own = new Set(lanAddresses().map(a => `http://${a}:${shareState.port}`));
  const saved = new Map((await d.store.settings()).remotes.map(r => [r.url, r]));
  const linked = new Set(saved.keys());
  const broken = (url: string) => linked.has(url) && !link.keysOf(saved.get(url)!.key);
  // Every address on the home network beside this PC's, and the PCs this one is linked to wherever they are (another
  // range or port): a network this PC is a guest on always shows what it is there.
  const targets = [...new Set([...share.scanTargets(lanAddresses()).map(ip => `http://${ip}:${port}`), ...linked])];
  const found: Awaited<ReturnType<typeof scan>> = [];
  // What this PC is to each one found: its admin, a guest (and until when), a guest whose pass expired, or nothing yet.
  const standing = (url: string) => {
    const r = saved.get(url);
    const f = guestpass.foundState(r && !broken(url) ? r : undefined);
    return { id: r?.id ?? null, state: f.state, stateText: f.text, canAsk: f.state === 'expired' && r?.passEnd?.canAsk === true && !r?.askOut, ask: r?.askOut ? { state: 'waiting', held: true } : r?.passEnd?.ask ?? null };
  };
  // 64 at a time, a short wait each: a home network of 254 addresses takes a few seconds.
  for (let i = 0; i < targets.length; i += 64) {
    await Promise.all(targets.slice(i, i + 64).map(async url => {
      if (own.has(url)) return;
      // A linked PC saved by name: checked to be on the home network first, as before every request to it.
      if (linked.has(url) && (await share.homeNetworkWhy(url))) return;
      try {
        const r = await fetch(`${url}/worker/whoami`, { signal: AbortSignal.timeout(1500) });
        const j = (await r.json()) as Record<string, unknown>;
        if (r.ok && j.app === 'smart-manager') found.push({ url, name: String(j.name ?? 'Worker PC').replace(/[^\w .'-]/g, '').slice(0, 40), pin: j.pin === true, linked: linked.has(url), broken: broken(url), version: String(j.version ?? '').slice(0, 20), ...standing(url) });
      } catch {
        // Nothing there.
      }
    }));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
