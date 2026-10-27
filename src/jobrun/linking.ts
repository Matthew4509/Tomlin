// This PC linking other PCs to it (they are its nodes): add one with its setup code, find TOMLIN on the home network,
// answer a node's "I need to use the pc", start it again, Backups only, remove. This PC's own node side is node.ts.
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import * as share from '../share.ts';
import * as link from '../link.ts';
import * as brains from '../brains.ts';
import * as linkhelp from '../linkhelp.ts';
import * as netfacts from '../netfacts.ts';
import { d } from './shared.ts';
import type { Remote } from '../store.ts';
import { hello, seen, workerPost } from './links.ts';
import { setup } from './sizing.ts';
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
      about = (await (await fetch(`${url}/worker/whoami`, { signal: AbortSignal.timeout(5000) })).json()) as Record<string, unknown>;
    } catch (e) {
      return unreachable(e);
    }
    // "smart-manager": the app's name on the wire since before TOMLIN; every PC, old and new, answers with it.
    if (about.app !== 'smart-manager') return { status: 400, body: { error: `Something answered at ${url}, but it is not TOMLIN. Check the address and port.` } };
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
    const made: Remote = { ...(same?.backupsOnly ? { backupsOnly: true } : {}), ...(same?.models ? { models: same.models } : {}), id, name, url, token: done.token, key: link.keysText(done.keys) };
    await d.store.saveSettings({ remotes: [...others, made] });
    // Asked at once, so the people who work there show straight away.
    await hello((await d.store.settings()).remotes.find(r => r.id === made.id)!, 4000).catch(() => undefined);
    // Another PC (another id) already linked under this name: linked all the same, and said, so two cards called
    // "Worker PC" are not read as one PC that is both off and on.
    const twin = others.find(r => r.name.toLowerCase() === name.toLowerCase());
    if (twin) return { status: 200, body: { ...(await setup()), sameName: `Linked. "${twin.name}" at ${twin.url} has the same name, so both cards show their address. To tell them apart, press one in the left panel and give it a Name.` } };
  } else if (b.action === 'diagnose') {
    return { status: 200, body: await diagnose(b) };
  } else if (b.action === 'scan') {
    return { status: 200, body: { found: await scan(Number(b.port) || share.DEFAULT_SHARE.port), own: lanList() } };
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
    if (on) {
      const jm = (await d.store.settings()).jobModels;
      if (Object.values(jm).some(v => onIt(v))) await d.store.saveSettings({ jobModels: Object.fromEntries(Object.entries(jm).map(([k, v]) => [k, onIt(v) ? '' : v])) });
      for (const m of hires) {
        if (onIt(m.model)) await d.staff.change(m.id, { model: onIt(m.fallback) ? null : m.fallback ?? null, fallback: null });
        else await d.staff.change(m.id, { fallback: null });
      }
    }
    await hello((await d.store.settings()).remotes.find(x => x.id === id)!, 4000).catch(() => undefined);
  } else if (b.action === 'remove') {
    const id = String(b.id ?? '');
    await d.store.saveSettings({ remotes: s.remotes.filter(r => r.id !== id) });
    if (Object.values(s.jobModels).includes(`remote:${id}`)) await d.store.saveSettings({ jobModels: Object.fromEntries(Object.entries(s.jobModels).map(([k, v]) => [k, v === `remote:${id}` ? '' : v])) });
    // A hire whose brain was on that PC (what it had loaded, or one of its shared models) no longer points at it.
    const gone = (ref: string | null | undefined) => { const x = brains.parseRef(ref); return x.kind === 'remote' && x.pc === id; };
    for (const m of d.staff.list()) {
      if (gone(m.model)) await d.staff.change(m.id, { model: gone(m.fallback) ? null : m.fallback ?? null, fallback: null });
      else if (gone(m.fallback)) await d.staff.change(m.id, { fallback: null });
    }
    seen.delete(id);
  } else return { status: 400, body: { error: 'Unknown worker action.' } };
  return { status: 200, body: await setup() };
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
async function scan(port: number): Promise<{ url: string; name: string; pin: boolean; linked: boolean; broken: boolean; version: string }[]> {
  const own = new Set(lanAddresses().map(a => `http://${a}:${shareState.port}`));
  const saved = new Map((await d.store.settings()).remotes.map(r => [r.url, r]));
  const linked = new Set(saved.keys());
  const broken = (url: string) => linked.has(url) && !link.keysOf(saved.get(url)!.key);
  const targets = share.scanTargets(lanAddresses());
  const found: { url: string; name: string; pin: boolean; linked: boolean; broken: boolean; version: string }[] = [];
  // 64 at a time, a short wait each: a home network of 254 addresses takes a few seconds.
  for (let i = 0; i < targets.length; i += 64) {
    await Promise.all(targets.slice(i, i + 64).map(async ip => {
      const url = `http://${ip}:${port}`;
      if (own.has(url)) return;
      try {
        const r = await fetch(`${url}/worker/whoami`, { signal: AbortSignal.timeout(1500) });
        const j = (await r.json()) as Record<string, unknown>;
        if (r.ok && j.app === 'smart-manager') found.push({ url, name: String(j.name ?? 'Worker PC').replace(/[^\w .'-]/g, '').slice(0, 40), pin: j.pin === true, linked: linked.has(url), broken: broken(url), version: String(j.version ?? '').slice(0, 20) });
      } catch {
        // Nothing there.
      }
    }));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
