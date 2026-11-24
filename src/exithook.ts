// What runs as TOMLIN ends: one 'exit' listener for the whole app, not one per module and per runner (eleven of
// them set off Node's MaxListenersExceededWarning at every start). Each step runs once, in the order it was added,
// and one that throws never stops the rest. The list is kept on globalThis so the bridge's require() and the app's
// import share it even if the module were loaded twice.

export type ExitStep = (code: number) => void;

interface Hooks {
  steps: ExitStep[];
  listening: boolean;
  ran: boolean;
}

const KEY = Symbol.for('tomlin.exithook');
const hooks: Hooks = ((globalThis as Record<symbol, unknown>)[KEY] as Hooks | undefined) ?? { steps: [], listening: false, ran: false };
(globalThis as Record<symbol, unknown>)[KEY] = hooks;

/** Runs every step once, in order; a step that throws is passed over. process 'exit' calls it; the tests may too. */
export function runExitSteps(code = 0): void {
  if (hooks.ran) return;
  hooks.ran = true;
  for (const step of [...hooks.steps]) {
    try {
      step(code);
    } catch {
      // One step failing must never stop the others (a log flush, the start lock, a runner left running).
    }
  }
}

function onProcessExit(code: number): void {
  runExitSteps(typeof code === 'number' ? code : 0);
}

/** Adds `step` to what runs as the process ends. Returns a function that takes it off again. */
export function onExit(step: ExitStep): () => void {
  hooks.steps.push(step);
  if (!hooks.listening) {
    hooks.listening = true;
    process.on('exit', onProcessExit);
  }
  return () => offExit(step);
}

/** Takes `step` off the list (its first copy); nothing happens when it is not there. */
export function offExit(step: ExitStep): void {
  const i = hooks.steps.indexOf(step);
  if (i >= 0) hooks.steps.splice(i, 1);
}

/** How many steps are waiting (for the tests). */
export const exitStepCount = (): number => hooks.steps.length;
