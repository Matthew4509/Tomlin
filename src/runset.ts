// Run settings a linked PC may change on a node (2.0.56): the Guessing model of one of the node's chat models. The
// node's owner ticks "Allow host to test and change model run settings" there first (off until ticked). The host sends
// model ids from the node's own list, never flags or file paths; the node checks them against its own models and keeps
// the setting in its own settings, as if set at its own screen. The doors are in src/jobrun/node.ts (/worker/run-set)
// and src/jobrun/copies.ts (runSetOn); tested in test/runset.test.ts and test/runseton.test.ts.

export const TUNE_TICK = 'Allow host to test and change model run settings';

export interface Listed {
  id: string;
  name: string;
  bytes: number;
}

const OLLAMA = 'ollama:';
/** A model's family from its name ("Qwen3.5-35B-A3B-Q4_K_M" is qwen3.5): llama.cpp refuses a guesser whose words list differs. */
const family = (name: string) => name.toLowerCase().split('-')[0];

/**
 * The models that may guess for `m`: another chat model of the same family on that PC, at most half its size, in the
 * list's order. Ollama's models are run by Ollama, not by this PC's runner: they neither guess nor have a guesser.
 */
export function guessersFor(m: Listed, list: Listed[]): string[] {
  if (m.id.startsWith(OLLAMA)) return [];
  return list.filter(x => x.id !== m.id && !x.id.startsWith(OLLAMA) && family(x.name) === family(m.name) && x.bytes < m.bytes / 2).map(x => x.id);
}

/** What a host asked, checked against this PC's chat models: the model and its guessing model ('' = none), or why not. */
export function runSetAsk(b: Record<string, unknown>, list: Listed[]): { model: Listed; draft: string } | { status: number; error: string } {
  if (typeof b.model !== 'string' || !b.model || typeof b.draft !== 'string') return { status: 400, error: 'Say which model and which guessing model (or none).' };
  const model = list.find(m => m.id === b.model);
  if (!model) return { status: 404, error: `${b.model.slice(0, 120)} is not on this PC (deleted or moved?).` };
  if (model.id.startsWith(OLLAMA)) return { status: 400, error: `${model.name} is run by Ollama here, so it cannot have a guessing model.` };
  if (b.draft && !guessersFor(model, list).includes(b.draft)) return { status: 400, error: `A guessing model for ${model.name} must be a smaller model of the same family on this PC (at most half its size).` };
  return { model, draft: b.draft };
}

/** The node's answer when its owner has not ticked it: where to tick it. */
export const tuneRefused = (pcName: string) => `"${pcName}" does not let linked PCs change how its models run. Its owner can tick "${TUNE_TICK}" there, under Network: connect PCs, Sharing permissions.`;

/**
 * Why this PC cannot ask that linked PC now ('' when it can). The tick is not checked here: the node checks its own and
 * says why in its own words.
 */
export function tuneWhy(pc: { name: string; ok: boolean; away: string | null; can: string[] }): string {
  if (!pc.ok) return `"${pc.name}" is off or not answering now`;
  if (pc.away) return `"${pc.name}" is being used by its owner for now`;
  if (!pc.can.includes('tune')) return `"${pc.name}" runs an older TOMLIN that cannot change how its models run from here: update it there first`;
  return '';
}
