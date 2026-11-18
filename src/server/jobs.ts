// The jobs, the linking of PCs and this PC's worker door (src/jobrun.ts), given the server's parts.
import { askText } from '../share.ts';
import { runnerTesting } from '../faults.ts';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { toneOf } from '../persona.ts';
import { staffSystem } from '../staff.ts';
import { createJobs } from '../jobrun.ts';
import * as keep from '../keep.ts';
import * as carry from '../carry.ts';
import { pinWhy } from '../runtimes.ts';
import { BUILD, GB, HOME, ROOT, SECURITY_HEADERS, restartInto, STARTED_AT, VERSION, body, chatModels, hidden, lastUsed, byModel, byStaff, hardware, json, ledger, meter, notebooks, notifier, runtimes, sampler, speeds, staff, startupOf, store, uptime, workspaceDir } from './core.ts';
import { scope } from '../meter.ts';
import { appLock, appLockOn, appPinCheck, hostPinDoor, hostPinDrop, hostPinHeld, recoveryHashes, sameAsLock, updatePinCheck, whenCodesChange } from './locks.ts';
import { chat, chatCardBytes, chatList, chatPlace, connectChat, contextBytes, fit, images, loadShapes, main, rpcBuilds, rpcProgram, runOf, runOn, runnerFor, runnerOptions, runnerUsed, runners } from './panes.ts';
import * as panesSlots from './panes.ts';
import { checkBusy, checkState, checkTesting, checkTuneDoor, unsafeWhy } from './runnercheck.ts';
import { answeringBusy, stepAnswers, stopOn } from './answering.ts';
import { drawForPc, loadImage, pictureModels, swapImage } from './pictures.ts';
import { tellJob } from './notices.ts';
import { cpuHere, memoryNow } from './thispc.ts';
import { fetchHere } from './hf.ts';
import { finderBusy, finderTesting, tuneDoor } from './finder.ts';
import { SPEED_FILE, benchBeside, ramPass, runFor, useSpeedTest, type BenchModel, type Figures } from '../speedtest.ts';
import { modelShape, quantFamily, wordBytes } from '../gguf.ts';
import { shareState } from '../jobrun/node.ts';
import { lentTo } from '../jobrun/maxnode.ts';
import { maxPcs } from '../jobrun/maxhost.ts';

// ---- Jobs (src/jobrun.ts) ----

/** Made by startJobs once every part of the server is in place; unset until then. */
export let jobRoutes: ReturnType<typeof createJobs>;

export function startJobs(): void {
  jobRoutes = createJobs({
    store,
    speeds,
    notebooks,
    chat,
    staff,
    version: VERSION,
    build: () => BUILD,
    headers: SECURITY_HEADERS,
    json,
    body,
    workspaceDir,
    chatList,
    connectChat,
    runnerFor,
    runOn,
    place: chatPlace,
    loadedChats: () => runners.filter(p => p.view.state === 'connected' && p.view.model).map(p => p.view.model!),
    runNow: () => runOn(main()),
    runOf,
    fit: (id, run) => fit((chatModels.list().find(m => m.id === id)?.bytes ?? 0) + contextBytes(id, run), 'chat'),
    claim: (ac, pane) => {
      const p = pane ?? main();
      // One slot: the answer there makes way, as always. A runner started with more (At once, src/slots.ts): beside it.
      if ((panesSlots.runnerSlots.get(p) ?? 1) <= 1) stopOn(p);
      stepAnswers.set(ac, p);
    },
    release: ac => {
      stepAnswers.delete(ac);
    },
    busy: pane => answeringBusy(pane),
    touch: p => {
      runnerUsed.set(p ?? main(), Date.now());
    },
    memory: () => memoryNow(),
    cpu: () => cpuHere(),
    meter: () => meter.view(),
    startedAt: STARTED_AT,
    // A linked PC's answer for work here: counted for that PC, under the project it was for (src/meter.ts).
    usage: (pc, u, model) => {
      ledger.add(pc, scope.getStore()?.project ?? '', u);
      byStaff.add(scope.getStore()?.staff, u);
      if (model) byModel.add(pc, model, u);
    },
    uptimeMark: (pc, ok) => uptime.mark(pc, ok),
    ledgerRows: key => ledger.forPc(key),
    usageTake: (pc, rows) => ledger.takeFrom(pc, rows),
    stats: () => {
      const h = sampler.latest;
      return { at: h.at, cpu: h.cpu.percent, ram: h.ram, gpu: h.gpu ? { name: h.gpu.name, busy: h.gpu.busy, used: h.gpu.used, total: h.gpu.total, shared: h.gpu.shared } : null };
    },
    imagePane: images.pane,
    pictureModels,
    isHidden: id => hidden.has(id),
    removeModel: async (kind, id) => (await import('./thispc.ts')).deleteModelHere(kind, id),
    removeBlock: async (kind, id) => (await import('./thispc.ts')).removeBlock(kind, id),
    usedAt: id => lastUsed.get(id),
    pictureFit: id => images.list().find(m => m.id === id)?.fit.level ?? 'ok',
    pictureRoom: id => images.cardRoom(id, chatCardBytes()),
    draw: drawForPc,
    swapImage,
    loadImage,
    imageBusy: () => images.busy(),
    connectImage: async id => {
      const a = (await store.settings()).image;
      return !('error' in (await images.connect(id, a.asked, a.threads)));
    },
    hireSystem: async m => staffSystem(m, toneOf(m.tone ?? (await store.settings()).tone).prompt),
    recipeOf: id => images.recipe?.(id) ?? null,
    onEvent: (id, e) => void tellJob(id, e),
    appLockOn,
    appLocked: () => appLockOn() && !appLock.isOpen(),
    appPinCheck,
    updatePinCheck,
    hostPinDoor,
    hostPinHeld,
    hostPinDrop,
    unloadAll: async (still = () => true) => {
      for (const p of [...runners]) if (still() && (p.view.state === 'connected' || p.view.state === 'loading')) await p.disconnect();
      if (still() && (images.pane.view.state === 'connected' || images.pane.view.state === 'loading')) await images.pane.disconnect();
    },
    onNodeAway: name => void notifier.tell('stuck', `${name}: I need to log off for now. Its work goes to other PCs.`, 'nodes:').catch(() => undefined),
    slotsOf: id => panesSlots.slotsOf(id),
    slotNote: id => panesSlots.slotNotes.get(id) ?? '',
    onPassAsk: (pc, guest) => void notifier.tell('question', `"${guest}" asks for more time with its guest pass${pc ? ` on "${pc}"` : ''}. Answer it on the Network page (Guest passes).`, 'nodes:').catch(() => undefined),
    onNodeAsk: (name, hours) => void notifier.tell('stuck', `${name}: ${askText(hours)}. Answer it on Home.`, 'nodes:').catch(() => undefined),
    onClaim: (name, pc) => void notifier.tell('question', `${name} wants their backups on a new PC (${pc}). Allow or Don't allow it on the Network page.`, 'nodes:').catch(() => undefined),
    onLinked: (name, dropped, guest) => void notifier.tell('question', guest
      ? `"${name}" linked to this PC with the guest pass "${guest}". To stop it, remove the pass on the Network page (Guest passes).${dropped ? ` Its oldest link with that pass, "${dropped}", was removed (3 at most).` : ''}`
      : `"${name}" linked to this PC. Not you? Remove it on the Network page (PCs linked to this one). The setup code is a new one now.${dropped ? ` The oldest link, "${dropped}", was removed (10 at most).` : ''}`, 'nodes:').catch(() => undefined),
    sameAsLock,
    recoveryHashes,
    autostart: startupOf,
    fetch: fetchHere,
    // Test now (one model on one runner, the crash notice): loaded when first asked, so the faults module stays out of this one's imports.
    tune: (action, b, by) => (action.startsWith('runner-test-') ? import('./faults.ts').then(m => m.testTuneDoor(action.slice('runner-test-'.length), b, by)) : action.startsWith('runner-check-') ? checkTuneDoor(action.slice('runner-check-'.length), by) : tuneDoor(action, b, by)),
    tuneBusy: () => finderBusy() || checkBusy() || runnerTesting.busy(),
    finderTesting: () => finderTesting() ?? checkTesting(),
    rpcProgram,
    rpcBuilds,
    carry: {
      // A chat model's files: its first part and the parts beside it. Ollama keeps its own (named by Ollama): not sent.
      chatFiles: id => {
        const path = id.startsWith('ollama:') ? null : chatModels.path(id);
        if (!path) return null;
        const dir = dirname(path);
        let names: string[] = [];
        try {
          names = readdirSync(dir);
        } catch {
          return null;
        }
        try {
          return carry.modelParts(basename(path), names).map(name => ({ name, path: join(dir, name), bytes: statSync(join(dir, name)).size }));
        } catch {
          return null;
        }
      },
      // Read each time: the folder models are kept in can be changed while TOMLIN runs (src/server/modelhome.ts).
      get chatDir() { return chatModels.own; },
      chatHas: name => chatModels.has(name),
      pictureFiles: id => {
        const m = images.registry.get(id);
        if (!m || m.kind !== 'image' || !images.registry.installed(m)) return null;
        return m.files.map(f => ({ name: images.registry.fileName(f), path: images.registry.filePath(m, f), bytes: f.bytes }));
      },
      pictureDest: id => {
        const m = images.registry.get(id);
        if (!m || m.kind !== 'image') return null;
        return m.files.map(f => {
          let have = false;
          try {
            have = statSync(images.registry.filePath(m, f)).size === f.bytes;
          } catch {
            // not here
          }
          return { name: images.registry.fileName(f), path: images.registry.ownPath(m, f), bytes: f.bytes, have, sha256: f.sha256 };
        });
      },
      keptRoot: join(HOME.home, 'backups from other PCs'),
      backupsDir: HOME.backups,
      makeBackup: (label, o) => keep.backup(HOME, label, o),
      onInstalled: () => void loadShapes().catch(() => undefined),
    },
    update: {
      root: ROOT,
      restarts: process.env.TOMLIN_LOOP === '1',
      switchTo: restartInto,
    },
    runner: {
      runtimes,
      nvidia: () => hardware.gpus.some(g => g.vendor === 'nvidia' && !g.integrated),
      driver: () => hardware.nvidiaDriver ?? null,
      why: (id, pc) => pinWhy(runtimes.pins[id], hardware.gpus, hardware.nvidiaDriver ?? null, pc, Object.values(runtimes.pins)) || unsafeWhy(id, pc),
      options: runnerOptions,
      check: () => checkState().word,
      // A model running (or loading) on that device holds its runner's files open.
      inUse: device => [...runners, images.pane].some(p => p.view.device === device && (p.view.state === 'connected' || p.view.state === 'loading')),
    },
  });
  // A3: a new set of recovery codes, or one used, goes on (as hashes) to the PCs that keep this PC's backup name.
  whenCodesChange(() => void jobRoutes.resendCodes().catch(() => undefined));
  startSpeedTest();
}

/** What the speed test reads of each chat model file (its kind, bytes read a word), kept by path and size: read once. */
const benchFacts = new Map<string, BenchModel>();
async function benchModel(path: string, bytes: number, moe: boolean): Promise<BenchModel> {
  const key = `${path}|${bytes}`;
  const had = benchFacts.get(key);
  if (had) return had;
  const kind = await quantFamily(path);
  // What a word reads: the chosen experts only, and one row of the token table (src/gguf.ts wordBytes).
  const shape = moe ? await modelShape(path) : null;
  if (moe && !(shape?.experts && shape.expertsUsed)) return remember(key, { path, bytes, kind, read: 0 });
  const read = (await wordBytes(path, moe ? { experts: shape!.experts, used: shape!.expertsUsed! } : null)) ?? 0;
  return remember(key, { path, bytes, kind, read });
}
const remember = (key: string, m: BenchModel): BenchModel => (benchFacts.set(key, m), m);

/** Max mode's speed test (src/speedtest.ts): this PC's model work per kind of quantisation, for the layer split by speed. */
function startSpeedTest(): void {
  const cardName = () => hardware.gpus.find(g => !g.integrated)?.name ?? '';
  void useSpeedTest({
    read: () => store.readJson<Figures | null>(SPEED_FILE, null),
    write: f => store.writeJson(SPEED_FILE, f),
    busy: () => {
      const to = lentTo();
      if (to) return `lending to "${to}" now`;
      if ([...runners, images.pane].some(p => p.view.state === 'connected' || p.view.state === 'loading')) return 'a model is loaded here';
      if (finderBusy() || checkBusy() || runnerTesting.busy()) return 'a runner test is going';
      return '';
    },
    // It lends to the cluster here, or borrows from a linked PC that does.
    wanted: () => shareState.allow?.lend === true || maxPcs().length > 0,
    hw: () => ({ cpu: hardware.cpuName, cardName: cardName() }),
    models: async () => {
      const out: BenchModel[] = [];
      for (const m of chatList()) {
        const path = m.id.startsWith('ollama:') ? null : chatModels.path(m.id);
        // Only files a test could run (16 GB at most): the others are not read.
        if (path && m.bytes <= 16 * GB) out.push(await benchModel(path, m.bytes, m.moe));
      }
      return out;
    },
    deps: models => {
      const prog = rpcProgram();
      const gpu = sampler.latest.gpu;
      return {
        bench: benchBeside(prog?.exe),
        models,
        card: !!prog && prog.device !== 'cpu' && !!cardName(),
        cardFree: gpu && gpu.total ? Math.max(0, gpu.total - gpu.used) : 0,
        cpu: hardware.cpuName,
        cardName: cardName(),
        run: (exe, args) => runFor(exe, args),
        pass: () => ramPass(),
      };
    },
  }).catch(() => undefined);
}
