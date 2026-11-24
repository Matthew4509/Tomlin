// Settings, Bootable USB: run TOMLIN on a diskless node. The admin key, the parts a stick carries (downloaded once and
// checked), the Debian ISO, the sticks plugged in, Mint and Remove, and the kinds of hardware the linked PCs have with
// the best run settings found for each (src/usbadmin.ts). Long steps (downloads, Mint) run here in the background; the
// page asks for their lines.
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import * as adminkey from '../adminkey.ts';
import * as usbadmin from '../usbadmin.ts';
import { fetchPin, inspect, mintStick, partsHere, readPins, removeFromStick, sha256File, wanted, type StickLook } from '../usbmint.ts';
import { STICK_ALLOW } from '../usbnode.ts';
import { cleanAllow } from '../carry.ts';
import { pcKey, hereKey } from '../speed.ts';
import { HOME, VERSION, type Routes, json, speeds, store } from './core.ts';
import { jobRoutes } from './jobs.ts';
import { cpuHere, memoryNow } from './thispc.ts';
import { chatList } from './panes.ts';
import { runSetOn } from '../jobrun/copies.ts';
import { shareState } from '../jobrun/node.ts';

/** Where the stick's parts are kept once downloaded (not runtime/_downloads, which is swept of unpinned files). */
export const PARTS_DIR = join(HOME.home, 'usb-parts');
/** The ISO goes to the Downloads folder, where Rufus's file picker opens. */
export const ISO_DIR = join(homedir(), 'Downloads');

async function records(): Promise<usbadmin.UsbRecords> {
  return usbadmin.cleanRecords(await store.readJson<unknown>(usbadmin.FILE, {}).catch(() => ({})));
}
async function saveRecords(r: usbadmin.UsbRecords): Promise<void> {
  await store.writeJson(usbadmin.FILE, r);
}

/** This PC's name as the stick's screen shows it ("Waiting for ..."). */
const adminName = () => (shareState.name && shareState.name !== 'Worker PC' ? shareState.name : hostname()).replace(/[^\w .'-]/g, '').slice(0, 40) || 'the admin PC';

// ---- The one long step at a time (a download or Mint): its lines and how far along ----

interface Task { kind: 'parts' | 'iso' | 'mint' | 'remove'; lines: string[]; got: number; of: number; done: boolean; error: string; at: number }
let task: Task | null = null;
function begin(kind: Task['kind'], run: (t: Task) => Promise<void>): { status: number; body: unknown } {
  if (task && !task.done) return { status: 409, body: { error: `Wait for "${taskWords(task.kind)}" to finish first.` } };
  const t: Task = { kind, lines: [], got: 0, of: 0, done: false, error: '', at: Date.now() };
  task = t;
  void run(t).catch(e => {
    t.error = (e as Error).message;
  }).finally(() => {
    t.done = true;
  });
  return { status: 200, body: { started: kind } };
}
const taskWords = (k: Task['kind']) => (k === 'parts' ? 'Get the parts' : k === 'iso' ? 'Get the ISO' : k === 'mint' ? 'Mint' : 'Remove from stick');

// ---- The sticks plugged in ----

/** Windows' removable drives (a stick made by Rufus is one), each looked at. */
function removable(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise(ok => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" | % { $_.DeviceID }'], { windowsHide: true, timeout: 15_000 }, (e, out) => ok(e ? [] : String(out).split(/\r?\n/).map(l => l.trim()).filter(l => /^[D-Z]:$/i.test(l)).map(l => `${l.toUpperCase()}\\`))));
}

/** A drive as the page may use it: only one Windows lists as removable now (a typed path is never written to). */
async function stickRoot(raw: unknown): Promise<string | null> {
  const want = String(raw ?? '').toUpperCase().replace(/[\\/]*$/, '');
  return (await removable()).find(r => r.replace(/\\$/, '') === want) ?? null;
}

// ---- Hardware kinds: every PC here, by kind, with the best speed per model and its run settings ----

interface PcFacts { id: string; name: string; facts: usbadmin.KindFacts; models: { id: string; name: string; settings: Record<string, unknown> }[]; usb: boolean }

/** The facts a kind is made of, from a hello's processor and memory (or this PC's own). */
function factsOf(cpu: unknown, memory: unknown): usbadmin.KindFacts {
  const c = (cpu && typeof cpu === 'object' ? cpu : {}) as { name?: string; cores?: number; sockets?: number };
  const m = (memory && typeof memory === 'object' ? memory : {}) as { ram?: { total?: number }; gpu?: { name?: string; total?: number } | null; cards?: { list?: { name?: string; total?: number }[] } };
  const list = m.cards?.list?.length ? m.cards.list : m.gpu?.name ? [m.gpu] : [];
  return { cpu: { name: c.name, cores: c.cores, sockets: c.sockets }, ramBytes: Number(m.ram?.total) || 0, cards: list.map(g => ({ name: g.name, vram: Number(g.total) || 0 })) };
}

async function pcsNow(): Promise<PcFacts[]> {
  const here: PcFacts = {
    id: 'here', name: 'This PC', usb: false, facts: factsOf(cpuHere(), memoryNow()),
    models: chatList().map(m => ({ id: m.id, name: m.name, settings: {} })),
  };
  const others = (await jobRoutes.remoteStatus({ known: true })).filter(r => r.ok && 'memory' in r).map(r => {
    const x = r as { id: string; name: string; cpu?: unknown; memory?: unknown; models?: { id: string; name: string; kind?: string; ctx?: number; draft?: string; cache?: string; kvRam?: boolean }[] };
    return {
      id: x.id, name: x.name, usb: jobRoutes.lastHello(x.id)?.usb === true, facts: factsOf(x.cpu, x.memory),
      models: (x.models ?? []).filter(m => m.kind !== 'image').map(m => ({ id: m.id, name: m.name, settings: { ...(m.cache ? { cache: m.cache } : {}), ...(typeof m.kvRam === 'boolean' ? { kvRam: m.kvRam } : {}), ...(m.draft ? { draft: m.draft } : {}), ...(m.ctx ? { ctx: m.ctx } : {}) } })),
    };
  });
  return [here, ...others];
}

/**
 * The kinds now: each PC counted under its kind, and each model's speed there (TOMLIN's own speed record: real answers,
 * else the last speed test) kept as that kind's best when it beats it. Saved, so a best found once is kept when its PC
 * is off. Each PC's own speed is shown beside the best, a twin under 85% of it flagged.
 */
async function kindsView() {
  let r = await records();
  const pcs = await pcsNow();
  const rows: { pc: string; name: string; kind: string; model: string; tps: number; settings: Record<string, unknown> }[] = [];
  for (const pc of pcs) {
    r = usbadmin.notePc(r, pc.id, pc.facts);
    for (const m of pc.models) {
      const s = speeds.get(pc.id === 'here' ? hereKey(m.id) : pcKey(pc.id, m.id)) ?? speeds.get(pc.id === 'here' ? hereKey(m.name) : pcKey(pc.id, m.name));
      const tps = s?.expect ?? 0;
      if (!tps) continue;
      rows.push({ pc: pc.id, name: pc.name, kind: usbadmin.hardwareKind(pc.facts).kind, model: m.name, tps, settings: m.settings });
      r = usbadmin.noteBest(r, pc.facts, m.name, { pc: pc.id, at: new Date().toISOString(), tps, settings: m.settings }).records;
    }
  }
  await saveRecords(r);
  const names = new Map(pcs.map(p => [p.id, p.name]));
  return r.kinds.map(k => ({
    kind: k.kind, label: k.label,
    pcs: k.pcs.map(id => ({ id, name: names.get(id) ?? 'a PC not answering now', on: names.has(id), usb: pcs.find(p => p.id === id)?.usb === true })),
    models: Object.entries(k.best).map(([model, b]) => ({
      model, best: { ...b, pcName: names.get(b.pc) ?? 'a PC not answering now' },
      each: rows.filter(x => x.kind === k.kind && x.model === model).map(x => ({ pc: x.pc, name: x.name, tps: x.tps, slow: usbadmin.twinSlow(b.tps, x.tps) })),
    })),
  }));
}

/** The best settings of a kind's model put on each of its twins that has the model and lets this PC change it. */
async function useOnTwins(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const r = await records();
  const k = r.kinds.find(x => x.kind === b.kind);
  const best = k?.best[String(b.model ?? '')];
  if (!k || !best) return { status: 404, body: { error: 'No best settings are kept for that model on that kind of PC yet: run a speed test on one of them first.' } };
  const pcs = await pcsNow();
  const said: string[] = [];
  for (const id of k.pcs.filter(p => p !== best.pc && p !== 'here')) {
    const pc = pcs.find(p => p.id === id);
    const m = pc?.models.find(x => x.name === b.model);
    if (!pc || !m) {
      said.push(`${pc?.name ?? 'A PC'}: ${pc ? 'does not have that model' : 'not answering now'}.`);
      continue;
    }
    const set = best.settings;
    if (set.cache || typeof set.kvRam === 'boolean') {
      const a = await runSetOn({ pc: id, model: m.id, ...(set.cache ? { cache: set.cache } : {}), ...(typeof set.kvRam === 'boolean' ? { kvRam: set.kvRam } : {}) });
      said.push(`${pc.name}: ${a.status === 200 ? String((a.body as { said?: string }).said ?? 'set.') : String((a.body as { error?: string }).error ?? 'refused.')}`);
    }
    if (typeof set.draft === 'string') {
      const a = await runSetOn({ pc: id, model: m.id, draft: set.draft });
      said.push(`${pc.name} (guessing model): ${a.status === 200 ? String((a.body as { said?: string }).said ?? 'set.') : String((a.body as { error?: string }).error ?? 'refused.')}`);
    }
    if (!set.cache && typeof set.kvRam !== 'boolean' && typeof set.draft !== 'string') said.push(`${pc.name}: the best was measured with the usual settings, so nothing needed changing.`);
  }
  return { status: 200, body: { said: said.length ? said : ['There is no other PC of this kind yet.'] } };
}

// ---- The page ----

/**
 * The minted sticks for the page: each linked one that answers now is seen now (kept as its last seen); the PC's name
 * and whether it answers come from the linked PCs' list.
 */
async function sticksView(): Promise<unknown[]> {
  let r = await records();
  const status = await jobRoutes.remoteStatus({ known: true }).catch(() => []);
  const now = new Date().toISOString();
  let changed = false;
  for (const s of r.sticks) {
    const pc = s.pc ? status.find(x => x.id === s.pc) : undefined;
    const at = s.pc ? Number(jobRoutes.lastHello(s.pc)?.at) : NaN;
    const heard = Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : undefined;
    const seen = pc?.ok ? now : heard && (!s.lastSeen || heard > s.lastSeen) ? heard : '';
    if (seen && seen !== s.lastSeen) {
      r = usbadmin.withStick(r, s.id, { lastSeen: seen });
      changed = true;
    }
  }
  if (changed) await saveRecords(r);
  return r.sticks.slice().reverse().map(s => {
    const pc = s.pc ? status.find(x => x.id === s.pc) : undefined;
    return { id: s.id, shown: adminkey.showId(s.id), at: s.at, drive: s.drive, name: s.name, pc: s.pc ?? null, pcName: pc?.name ?? null, on: pc?.ok === true, lastSeen: s.lastSeen ?? null, lost: s.lost === true };
  });
}

async function view() {
  const r = await records();
  const pins = readPins();
  const iso = join(ISO_DIR, pins.debianIso.file);
  const drives: StickLook[] = (await removable()).map(d => inspect(d));
  return {
    key: !!r.key, tag: r.key ? adminkey.keyTag(r.key.pub) : '', made: r.made, pcsPerKey: adminkey.KEY_PCS,
    admin: adminName(), version: VERSION,
    parts: partsHere(PARTS_DIR, false, pins), cudaParts: partsHere(PARTS_DIR, true, pins).filter(p => p.optional),
    iso: { file: pins.debianIso.file, url: pins.debianIso.url, bytes: pins.debianIso.bytes, sha256: pins.debianIso.sha256, path: iso, here: existsSync(iso) && statSync(iso).size === pins.debianIso.bytes },
    drives, sticks: await sticksView(),
    task: task ? { kind: task.kind, what: taskWords(task.kind), lines: task.lines.slice(-40), got: task.got, of: task.of, done: task.done, error: task.error } : null,
    allow: STICK_ALLOW,
  };
}

export const usbGet: Routes = {
  '/api/usb': async ({ res }) => json(res, 200, await view()),
  '/api/usb/kinds': async ({ res }) => json(res, 200, { kinds: await kindsView() }),
};

export const usbPost: Routes = {
  '/api/usb': async ({ res, b }) => {
    const out = await usbAction(b);
    return json(res, out.status, out.body);
  },
};

export async function usbAction(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const r = await records();
  if (b.action === 'key-make') {
    // A new key ends the old one: every stick minted with it must be minted again, so the list starts empty.
    if (r.key && b.again !== true) return { status: 409, body: { error: 'This PC already has an admin key. A new one cannot link the sticks minted with this one: each would have to be minted again.' } };
    await saveRecords({ ...r, key: adminkey.newAdminKey(), made: new Date().toISOString(), sticks: [] });
    return { status: 200, body: await view() };
  }
  if (b.action === 'stick-lost' || b.action === 'stick-found') {
    // Lost: never linked again, and its link here removed, so a copy of it reaches nothing. Found: it may link again.
    const id = adminkey.cleanStickId(b.id);
    const s = r.sticks.find(x => x.id === id);
    if (!s) return { status: 404, body: { error: 'That stick is not on this PC\'s list.' } };
    const lost = b.action === 'stick-lost';
    await saveRecords(usbadmin.withStick(r, id, { lost, ...(lost ? { pc: undefined } : {}) }));
    if (lost && s.pc) {
      const remotes = (await store.settings()).remotes;
      if (remotes.some(x => x.id === s.pc)) await store.saveSettings({ remotes: remotes.filter(x => x.id !== s.pc) });
    }
    return { status: 200, body: await view() };
  }
  if (b.action === 'parts') {
    const cuda = b.cuda === true;
    return begin('parts', async t => {
      const list = wanted(readPins(), cuda);
      t.of = list.reduce((s, p) => s + p.bytes, 0);
      let before = 0;
      for (const p of list) {
        await fetchPin(p, PARTS_DIR, { say: l => t.lines.push(l), progress: got => (t.got = before + got) });
        before += p.bytes;
        t.got = before;
      }
      t.lines.push('Every part is here and checked.');
    });
  }
  if (b.action === 'iso') {
    return begin('iso', async t => {
      const pin = readPins().debianIso;
      t.of = pin.bytes;
      const path = await fetchPin(pin, ISO_DIR, { say: l => t.lines.push(l), progress: got => (t.got = got) });
      t.got = pin.bytes;
      t.lines.push(`Saved and checked: ${path}. In Rufus, press SELECT and pick it.`);
    });
  }
  if (b.action === 'iso-check') {
    // An ISO already downloaded by hand: checked against its SHA-256 before Rufus writes it.
    const pin = readPins().debianIso;
    const path = join(ISO_DIR, pin.file);
    if (!existsSync(path)) return { status: 404, body: { error: `${pin.file} is not in your Downloads folder.` } };
    return begin('iso', async t => {
      t.of = statSync(path).size;
      const sum = await sha256File(path, n => (t.got += n));
      if (sum !== pin.sha256) throw new Error(`${pin.file} is not the right file (its SHA-256 differs). Delete it and press "Get the ISO".`);
      t.lines.push(`${pin.file} is the right file (SHA-256 checked).`);
    });
  }
  if (b.action === 'mint') {
    if (!r.key) return { status: 409, body: { error: 'Make the admin key first (above Mint).' } };
    const root = await stickRoot(b.drive);
    if (!root) return { status: 400, body: { error: 'Pick a stick from the list: only a drive Windows shows as removable now can be minted.' } };
    const look = inspect(root);
    if (look.why) return { status: 400, body: { error: look.why } };
    const key = r.key;
    if (look.minted && look.tag && look.tag !== adminkey.keyTag(key.pub) && b.takeOver !== true) return { status: 409, body: { error: `${root} was minted by another admin (tag ${look.tag}). Tick "Mint over another admin's stick" to make it yours.`, other: true } };
    if (r.sticks.length >= adminkey.KEY_PCS) return { status: 409, body: { error: `This PC has minted ${adminkey.KEY_PCS} sticks, the most one admin keeps on its list.` } };
    const name = String(b.name ?? '').replace(/[^\w .'-]/g, '').trim().slice(0, 40) || 'USB node';
    const allow = cleanAllow({ ...STICK_ALLOW, ...(b.allow && typeof b.allow === 'object' ? b.allow : {}) });
    // Every Mint gives the stick a new identity of its own, even minting the same stick again.
    const stick = adminkey.newStick();
    return begin('mint', async t => {
      await mintStick(root, { adminPub: key.pub, stick, admin: adminName(), name, allow, plainLinks: b.plainLinks === true, version: VERSION, cuda: b.cuda === true, cache: PARTS_DIR, say: l => t.lines.push(l) });
      const now = await records();
      await saveRecords({ ...now, sticks: [...now.sticks, { id: stick.id, pub: stick.pub, at: new Date().toISOString(), drive: root, name }] });
    });
  }
  if (b.action === 'remove') {
    const root = await stickRoot(b.drive);
    if (!root) return { status: 400, body: { error: 'Pick a stick from the list.' } };
    return begin('remove', async t => {
      for (const l of removeFromStick(root)) t.lines.push(l);
    });
  }
  if (b.action === 'twins') return useOnTwins(b);
  return { status: 400, body: { error: 'Unknown action.' } };
}

/** For tests: forget the task. */
export const resetTask = () => {
  task = null;
};
