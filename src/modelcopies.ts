// Where else a model is held, said before it is deleted or moved (Models on this PC and on a linked PC, and Free up space).
// Pure: the server (src/jobrun/copies.ts copiesOn) hands over what TOMLIN already knows of each linked PC (its model list from
// its last hello, or as last seen when it is off) and this says what that means. A place that cannot be read is "not
// checked", with the reason; it is never counted as "no copy". A copy is "the same model" the way TOMLIN already means it
// (src/carry.ts modelKey: a chat model by its file name, a picture model by its id) with the same size. It is not a hash.
import { modelKey, type NetPc } from './carry.ts';

export interface Subject {
  kind: 'chat' | 'image';
  id: string;
  bytes: number;
}

/** What is known of one place: has it, has a file of that name with another size, has not, or could not be read. */
export interface Place {
  pc: string;
  name: string;
  state: 'has' | 'different' | 'none' | 'unknown';
  /** A Backups only PC (the place kept for backups). */
  backup: boolean;
  /** Its list is from the last time it answered; it is off now. */
  lastSeen: boolean;
  /** Why it was not checked (state 'unknown'), in plain words. */
  why: string;
}

export interface Copies {
  places: Place[];
  /** Nothing else holds it and every place was read: safe to call "the only copy". */
  only: boolean;
  /** At least one place could not be read. */
  unchecked: boolean;
  /** Places that hold it. */
  held: number;
  words: string;
}

/** This PC's own models, when the model asked about is on a linked PC (this PC is then a place too). */
export interface HereModels {
  name: string;
  models: { kind: 'chat' | 'image'; id: string; bytes: number }[];
}

const sameSize = (a: number, b: number) => !(a > 0 && b > 0) || a === b;

/** What one linked PC holds of `m`, from what is known of it. `skip`: the PC the model is on (not a place). */
export function placeOf(m: Subject, pc: NetPc): Place {
  const base = { pc: pc.id, name: pc.name, backup: pc.backupsOnly === true, lastSeen: !pc.ok };
  const unknown = (why: string): Place => ({ ...base, state: 'unknown', why });
  // A Backups only PC lends no model, so its list is kept apart (held); it can be read only while it answers.
  if (pc.backupsOnly) {
    if (!pc.ok) return unknown('it is a Backups only PC and it is off');
    if (!pc.can.includes('models') || !pc.held) return unknown('it runs a TOMLIN that does not say which models it holds');
  } else if (pc.ok && !pc.can.includes('models')) return unknown('it runs an older TOMLIN that does not say which models it holds');
  const list = pc.backupsOnly ? pc.held ?? [] : pc.models;
  const key = modelKey(m.kind, m.id);
  const same = list.filter(x => modelKey(x.kind, x.id) === key);
  if (same.some(x => sameSize(m.bytes, x.bytes))) return { ...base, state: 'has', why: '' };
  if (same.length) return { ...base, state: 'different', why: '' };
  // Off, and its last list does not have it: it may have changed since, so this is not "none".
  if (!pc.ok) return unknown(list.length ? 'it is off (its list from the last time it answered did not have this model)' : 'it is off and has not told this PC which models it holds');
  return { ...base, state: 'none', why: '' };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "Z820", "Z820 and HP 800", "Z820, HP 800 and Study laptop"; four or more: the first two and "2 other PCs". */
function listWords(items: string[]): string {
  if (items.length <= 3) return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return `${items.slice(0, 2).join(', ')} and ${items.length - 2} other PCs`;
}

/** The label of a place that holds the model: a backup PC says so; an off PC says its list is from earlier. */
const heldLabel = (p: Place) => `${p.backup ? 'backup ' : ''}${p.name}${p.lastSeen ? ' (off now, as last seen)' : ''}`;

/**
 * Where else `m` is held. `pcs`: every linked PC as known now; `skip`: the PC the model is on, when it is on a linked PC
 * (left out of the places); `here`: this PC's models, given when the model is on a linked PC.
 */
export function copiesOf(m: Subject, pcs: NetPc[], o: { skip?: string; here?: HereModels | null } = {}): Copies {
  const places = pcs.filter(pc => pc.id !== o.skip).map(pc => placeOf(m, pc));
  if (o.here) {
    const key = modelKey(m.kind, m.id);
    const same = o.here.models.filter(x => x.kind === m.kind && modelKey(x.kind, x.id) === key);
    places.unshift({ pc: 'here', name: o.here.name, state: same.some(x => sameSize(m.bytes, x.bytes)) ? 'has' : same.length ? 'different' : 'none', backup: false, lastSeen: false, why: '' });
  }
  const has = places.filter(p => p.state === 'has');
  const diff = places.filter(p => p.state === 'different');
  const unknown = places.filter(p => p.state === 'unknown');
  const only = !has.length && !unknown.length;
  const out: string[] = [];
  if (has.length) out.push(`Other copies: on ${listWords(has.map(heldLabel))}.`);
  else if (!places.length) out.push('This is the only copy: no other PC is linked to this one.');
  else if (only) out.push('This is the only copy TOMLIN found.');
  else out.push('No other copy found.');
  if (diff.length) out.push(`${listWords(diff.map(p => p.name))} ${plural(diff.length, 'has', 'have')} a file of the same name with another size: not counted as a copy.`);
  if (unknown.length) out.push(`Not checked: ${unknown.map(p => `${p.name} (${p.why})`).join('; ')}.`);
  return { places, only, unchecked: unknown.length > 0, held: has.length, words: out.join(' ') };
}

/**
 * The lines for the confirm question of a delete: the copies sentence, and what the delete means for it. `canMove`: the
 * model is on this PC, so Move is offered (a model on a linked PC is deleted there or left).
 */
export function deleteWords(c: Copies, canMove: boolean): string {
  if (c.held) return c.words;
  const lose = c.only ? 'Deleting it removes it for good.' : 'Deleting it may remove the last copy.';
  return `${c.words} ${lose}${canMove ? ' Move it to another PC instead to keep one.' : ''}`;
}
