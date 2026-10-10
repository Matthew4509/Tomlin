// The jobs, the linking of PCs and this PC's worker door (src/jobrun.ts), given the server's parts.
import { writeFile } from 'node:fs/promises';
import { askText } from '../share.ts';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { toneOf } from '../persona.ts';
import { staffSystem } from '../staff.ts';
import { createJobs } from '../jobrun.ts';
import { autostart } from '../autostart.ts';
import * as keep from '../keep.ts';
import * as carry from '../carry.ts';
import * as update from '../update.ts';
import { BUILD, HOME, ROOT, SECURITY_HEADERS, STARTED_AT, VERSION, body, chatModels, hidden, byModel, byStaff, json, ledger, meter, notebooks, notifier, sampler, speeds, staff, startupOf, store, uptime, workspaceDir } from './core.ts';
import { scope } from '../meter.ts';
import { appLockOn, appPinCheck } from './locks.ts';
import { chat, chatList, chatPlace, connectChat, contextBytes, fit, images, loadShapes, main, runOf, runOn, runnerFor, runnerUsed, runners } from './panes.ts';
import { answeringBusy, stepAnswers, stopOn } from './answering.ts';
import { drawForPc, loadImage, pictureModels, swapImage } from './pictures.ts';
import { tellJob } from './notices.ts';
import { memoryNow } from './thispc.ts';

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
      stopOn(p);
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
    pictureFit: id => images.list().find(m => m.id === id)?.fit.level ?? 'ok',
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
    appPinCheck,
    unloadAll: async (still = () => true) => {
      for (const p of [...runners]) if (still() && (p.view.state === 'connected' || p.view.state === 'loading')) await p.disconnect();
      if (still() && (images.pane.view.state === 'connected' || images.pane.view.state === 'loading')) await images.pane.disconnect();
    },
    onNodeAway: name => void notifier.tell('stuck', `${name}: I need to log off for now. Its work goes to other PCs.`, 'nodes:').catch(() => undefined),
    onNodeAsk: (name, hours) => void notifier.tell('stuck', `${name}: ${askText(hours)}. Answer it on Home.`, 'nodes:').catch(() => undefined),
    autostart: startupOf,
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
      chatDir: chatModels.own,
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
          return { name: images.registry.fileName(f), path: images.registry.ownPath(m, f), bytes: f.bytes, have };
        });
      },
      keptRoot: join(HOME.home, 'backups from other PCs'),
      backupsDir: HOME.backups,
      makeBackup: label => keep.backup(HOME, label),
      onInstalled: () => void loadShapes().catch(() => undefined),
    },
    update: {
      root: ROOT,
      restarts: process.env.TOMLIN_LOOP === '1',
      switchTo: async dir => {
        // "Start with Windows" meant the app, not the folder: it now starts the new copy.
        if (await startupOf.on().catch(() => false)) await autostart(dir).set(true).catch(() => undefined);
        await writeFile(join(ROOT, update.NEXT_COPY_FILE), dir);
        // Ended a moment later, so the answer reaches the linked PC; Start TOMLIN.cmd then starts the new copy.
        setTimeout(() => process.exit(update.RESTART_INTO), 1500).unref();
      },
    },
  });
}
