// A model on a hard disk (src/modelhome.ts driveKinds, ssdTarget): the facts its row in the PC window shows. Kept
// apart from src/server/modelhome.ts, which sets things up when it is loaded: the PC window's code loads this early.
import { driveKinds, driveOf, driveReadSpeeds, drives, drivesKnown, kindsKnown, ssdTarget } from '../modelhome.ts';
import { chatModels, modelsHome, store } from './core.ts';
import { images } from './panes.ts';

/**
 * The drives and their kinds read again (at most every 15 s and 10 min). Before the first reading the PC window's list
 * waits 1.5 s at most (Windows can take 10 s and more to say): until it comes, the rows show no mark.
 */
export function refreshDisks(): Promise<void> {
  const asked = Promise.all([drives(), driveKinds()]).then(() => undefined, () => undefined);
  // Read before: the list drawn now uses that, and the new reading is there for the next one.
  if (drivesKnown().length && Object.keys(kindsKnown()).length) return Promise.resolve();
  return Promise.race([asked, new Promise<void>(ok => setTimeout(ok, 1500))]);
}

/** The path of a model of this PC ('chat' or 'image'), or null. */
function pathOf(kind: string, id: string): string | null {
  if (kind === 'image') {
    const m = images.registry.get(id);
    return m && m.files[0] ? images.registry.filePath(m, m.files[0]) : null;
  }
  return chatModels.path(id);
}

/**
 * What the PC window's row says about the drive a model is on: `hdd` when Windows says it is a hard disk (nothing when
 * Windows does not say), `ssd` the SSD with room it can move to (null: none), `canMove` false for a model another
 * program keeps (the other folder, Ollama: moving it would take it from that program), and `loadSeconds` the time it
 * should take to load, from its own timed loads or from others on the same drive (null when neither is known).
 */
export function diskFacts(kind: string, id: string, bytes: number): { hdd: boolean; drive: string; ssd: { drive: string; newHome: boolean } | null; canMove: boolean; loadSeconds: number | null } | null {
  const path = pathOf(kind, id);
  if (!path) return null;
  const drive = driveOf(path);
  const kinds = kindsKnown();
  const hdd = kinds[drive] === 'hdd';
  const t = hdd ? ssdTarget(path, bytes, modelsHome.dir(), drivesKnown(), kinds) : null;
  const canMove = kind === 'chat' && !id.startsWith('*/') && !id.startsWith('ollama:');
  const timed = store.peek()?.loadSeconds ?? {};
  const own = timed[`${kind}:${id}`];
  let loadSeconds: number | null = own > 0 ? Math.round(own) : null;
  if (loadSeconds === null) {
    const loads = chatModels.list().flatMap(m => {
      const p = timed[`chat:${m.id}`] > 0 ? chatModels.path(m.id) : null;
      return p ? [{ drive: driveOf(p), bytes: m.bytes, seconds: timed[`chat:${m.id}`] }] : [];
    });
    const speed = driveReadSpeeds(loads)[drive];
    if (speed) loadSeconds = Math.max(1, Math.round(bytes / speed));
  }
  return { hdd, drive, ssd: t ? { drive: t.drive, newHome: t.newHome } : null, canMove, loadSeconds };
}

