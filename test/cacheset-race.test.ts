// The cache door (/worker/run-set with a cache, src/jobrun/node.ts cacheSetHere) while a load of that model is under
// way: the load read the old setting, so the saved one must not wait for the load after. Stand-in parts only: nothing
// starts TOMLIN or a runner.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useDeps } from '../src/jobrun/shared.ts';
import { cacheAfterLoad, cacheSetHere, cacheWatch } from '../src/jobrun/node.ts';

type Run = { ctx: number; cache: 'f16' | 'q8_0' | 'q4_0'; kvRam?: boolean };
const ID = 'qwen.gguf';

interface World {
  run: Record<string, Run>;
  pane: { view: { model: string; modelName: string; state: string }; disconnect: () => Promise<void>; loadedWith: Run | null } | null;
  finder: string | null;
  busy: boolean;
  letGo: number;
}
let w: World;

/** A load as the runner does it: the settings are read when it starts, and it holds them until it is let go. */
function startLoad() {
  const pane = {
    view: { model: ID, modelName: 'Qwen3.5-35B', state: 'loading' },
    loadedWith: { ...w.run[ID]! } as Run | null,
    disconnect: async () => {
      pane.view.state = 'disconnected';
      w.letGo++;
    },
  };
  w.pane = pane;
  return pane;
}

beforeEach(() => {
  cacheWatch.stepMs = 5;
  cacheWatch.graceMs = 60;
  cacheWatch.watchMs = 2_000;
  w = { run: { [ID]: { ctx: 32768, cache: 'f16' } }, pane: null, finder: null, busy: false, letGo: 0 };
  useDeps({
    chatList: () => [{ id: ID, name: 'Qwen3.5-35B', bytes: 20e9 }],
    store: {
      settings: async () => ({ run: structuredClone(w.run) }),
      saveSettings: async (p: { run?: Record<string, Run> }) => {
        Object.assign(w.run, p.run ?? {});
      },
    },
    runOf: (s: { run: Record<string, Run> }, id: string) => ({ ...s.run[id]! }),
    runOn: () => w.pane?.loadedWith ?? { ctx: 32768, cache: 'f16' },
    runnerFor: (id: string) => (w.pane && w.pane.view.model === id && (w.pane.view.state === 'connected' || w.pane.view.state === 'loading') ? w.pane : null),
    busy: () => w.busy,
    finderTesting: () => w.finder,
  } as never);
});

const until = async (ok: () => boolean) => {
  for (let t = 0; t < 400 && !ok(); t++) await new Promise(r => setTimeout(r, 5));
};

test('a cache set while that model is loading is not lost: the load with the old cache is let go once it is done', async () => {
  const pane = startLoad(); // the speed finder's Apply reloads it, reading f16
  const a = await cacheSetHere({ model: ID, cache: 'q8_0' }, 'Host');
  assert.equal(a.status, 200);
  assert.equal(w.run[ID]!.cache, 'q8_0');
  assert.equal(a.json.letGo, false);
  assert.equal(a.json.loading, true);
  assert.match(String(a.json.said), /loading there now with the setting it had: once that load is done, and it is not answering, it is let go/);
  // Not let go while it loads (that would cut the load short).
  await new Promise(r => setTimeout(r, 30));
  assert.equal(w.letGo, 0);
  pane.view.state = 'connected';
  await until(() => w.letGo > 0);
  assert.equal(w.letGo, 1, 'the load that carried the old f16 cache is let go, so the next answer starts with q8_0');
});

test('the speed finder\'s reload, between letting go and loading again, counts as a load under way', async () => {
  w.finder = ID; // whileReloading: nothing shows as loaded for a moment
  const a = await cacheSetHere({ model: ID, kvRam: true }, 'Host');
  assert.equal(a.json.loading, true);
  await new Promise(r => setTimeout(r, 120)); // longer than the grace: the finder still holds it
  // The reload had read the settings before the save: it loads with the card cache.
  const pane = startLoad();
  pane.loadedWith = { ctx: 32768, cache: 'f16' };
  w.finder = null;
  pane.view.state = 'connected';
  await until(() => w.letGo > 0);
  assert.equal(w.letGo, 1);
});

test('the watch on its own: a load that shows only after the save, within the grace, is still caught', async () => {
  const done = cacheAfterLoad(ID);
  const pane = startLoad();
  w.run[ID] = { ctx: 32768, cache: 'q4_0' };
  pane.view.state = 'connected';
  assert.equal(await done, true);
});

test('a load that already read the new setting is left loaded', async () => {
  startLoad();
  w.run[ID] = { ctx: 32768, cache: 'q4_0' };
  w.pane!.loadedWith = { ctx: 32768, cache: 'q4_0' };
  const a = await cacheSetHere({ model: ID, cache: 'q4_0' }, 'Host');
  assert.equal(a.json.loading, true);
  w.pane!.view.state = 'connected';
  await new Promise(r => setTimeout(r, 120));
  assert.equal(w.letGo, 0);
});

test('a model answering as soon as its load is done is left to answer (it uses the setting from its next load)', async () => {
  const pane = startLoad();
  await cacheSetHere({ model: ID, cache: 'q8_0' }, 'Host');
  w.busy = true;
  pane.view.state = 'connected';
  await new Promise(r => setTimeout(r, 120));
  assert.equal(w.letGo, 0);
});

test('the normal answers are unchanged: loaded and idle is let go at once; nothing loaded uses it from its next load', async () => {
  const pane = startLoad();
  pane.view.state = 'connected';
  const a = await cacheSetHere({ model: ID, cache: 'q8_0' }, 'Host');
  assert.equal(a.json.letGo, true);
  assert.equal(a.json.loading, undefined);
  assert.match(String(a.json.said), /It was loaded there and not answering, so it was let go: its next answer starts it with this\.$/);
  assert.equal(w.letGo, 1);
  w.pane = null;
  const b = await cacheSetHere({ model: ID, cache: 'q4_0' }, 'Host');
  assert.equal(b.json.letGo, false);
  assert.match(String(b.json.said), /: q4_0 cache on the card\. It uses this from its next load\.$/);
  w.busy = true;
  const busy = startLoad();
  busy.view.state = 'connected';
  const c = await cacheSetHere({ model: ID, cache: 'f16' }, 'Host');
  assert.match(String(c.json.said), /It is answering there now: it uses this from its next load\.$/);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(w.letGo, 1);
});
