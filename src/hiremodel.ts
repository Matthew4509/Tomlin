// The model a hire would use now, and whether it is here: one answer for every screen that names it (All staff, Edit
// staff, New chat, the chat's head, the left panel), so no two screens can disagree. Plain parts: test/hiremodel.test.ts.
import { parseRef } from './brains.ts';

/**
 * here: a model on this PC. pc: a model on a linked PC (or whatever it has loaded). connected: no model given, so the
 * model loaded here answers. none: no model given and none is loaded here. missing: the model given is not here any
 * more (not on this PC, or no longer lent by its PC, or its PC is no longer linked).
 */
export type HireModelState = 'here' | 'pc' | 'connected' | 'none' | 'missing';

export interface HireModel {
  state: HireModelState;
  /** The model's short name ('' when there is none to name). */
  name: string;
  /** The PC it is on, by name ('this PC' for this one). */
  pc: string;
  /** The model in a sentence, for a staff row or a picker card ("Fakemodel-7B", "Fakemodel-7B, no longer on this PC"). */
  text: string;
  /** True when the hire cannot answer on it as it is: the row offers "Pick a model" and First choice is warned. */
  pick: boolean;
}

export interface HireModelFacts {
  /** A picture hire (picture models), else a chat hire. */
  picture?: boolean;
  /** A Videographer (video models, src/videomodels.ts): said as "video model". */
  video?: boolean;
  /** Models of that kind that can be downloaded here but are not (the video list): one of them is "not downloaded yet". */
  known?: { id: string; name: string }[];
  /** This PC's models of that kind, by id, with their short names. */
  here: { id: string; name: string }[];
  /** The linked PCs: the models of that kind each lends (null: not known yet), and what it has loaded. */
  pcs: { id: string; name: string; models: { id: string; name: string }[] | null; loaded?: string | null; backupsOnly?: boolean }[];
  /** The short name of the model of that kind loaded here now, or null when none is. */
  connected: string | null;
}

/** A model id's file name without its folder or ".gguf" (an id from another drive starts "*\/"). */
export const fileStem = (id: string) => (id.split(/[\\/]/).pop() ?? id).replace(/\.gguf$/i, '');

/** What model a hire with `ref` as their first choice uses, and whether it is here. */
export function hireModel(ref: unknown, f: HireModelFacts): HireModel {
  const kind = f.video ? 'video model' : f.picture ? 'picture model' : 'model';
  const b = parseRef(ref);
  if (b.kind === 'none') {
    return f.connected
      ? { state: 'connected', name: f.connected, pc: 'this PC', text: `the ${kind} loaded here (${f.connected})`, pick: false }
      : { state: 'none', name: '', pc: 'this PC', text: `no ${kind} given, and none is loaded here`, pick: true };
  }
  if (b.kind === 'remote') {
    const pc = f.pcs.find(p => p.id === b.pc);
    const stem = b.model ? fileStem(b.model) : '';
    if (!pc) return { state: 'missing', name: stem, pc: 'a PC no longer linked', text: `${stem || `a ${kind}`} on a PC no longer linked`, pick: true };
    if (pc.backupsOnly) return { state: 'missing', name: stem, pc: pc.name, text: `${stem || `a ${kind}`} on "${pc.name}", which is set to Backups only`, pick: true };
    if (!b.model) {
      const name = pc.loaded || '';
      return { state: 'pc', name, pc: pc.name, text: name ? `${name} on "${pc.name}"` : `what "${pc.name}" has loaded`, pick: false };
    }
    const lent = pc.models?.find(x => x.id === b.model);
    if (pc.models && !lent) return { state: 'missing', name: stem, pc: pc.name, text: `${stem}, no longer lent by "${pc.name}"`, pick: true };
    const name = lent?.name || stem;
    return { state: 'pc', name, pc: pc.name, text: `${name} on "${pc.name}"`, pick: false };
  }
  const m = f.here.find(x => x.id === b.id);
  const listed = m ? undefined : f.known?.find(x => x.id === b.id);
  if (listed) return { state: 'missing', name: listed.name, pc: 'this PC', text: `${listed.name}, not downloaded on this PC yet`, pick: true };
  if (!m) return { state: 'missing', name: fileStem(b.id), pc: 'this PC', text: `${fileStem(b.id)}, no longer on this PC`, pick: true };
  return { state: 'here', name: m.name, pc: 'this PC', text: m.name, pick: false };
}

/** A few words for a narrow row (the left panel): the name, or what is wrong. */
export function hireModelShort(h: HireModel): string {
  if (h.state === 'none') return 'no model given';
  if (h.state === 'missing') return 'its model is no longer here';
  if (h.state === 'connected') return `the model loaded here`;
  return h.name || h.text;
}
