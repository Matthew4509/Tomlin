// Which hires work on a model, and as what, said before the model is deleted or moved (the Models lists, Free up space, and
// the bin on a linked PC's list). Pure: the server gives the hires and the model's ref (a model id on this PC, or
// remote:<pc>:<id> for a linked PC's model). A hire's first choice is `model`, their backup is `fallback` (or the `cover`
// picked while their PC was off), and "on it now" is the model a switch put them on (src/staff.ts nowModel).
import { nowModel } from './staff.ts';

export interface Hire {
  name: string;
  model?: string | null;
  fallback?: string | null;
  cover?: { ref: string } | null;
  group?: string[];
  active?: string | null;
}

export type As = 'first choice' | 'backup' | 'on it now';

/** One hire on one model. `spare`: as a first choice, they have another brain to fall back on (so they would still answer). */
export interface Assigned {
  name: string;
  as: As[];
  spare: boolean;
}

/** The hires on `ref`, in the order of the staff list. */
export function assignedTo(hires: Hire[], ref: string): Assigned[] {
  const out: Assigned[] = [];
  for (const h of hires) {
    const as: As[] = [];
    if (h.model === ref) as.push('first choice');
    else if (nowModel(h) === ref) as.push('on it now');
    if (h.fallback === ref || h.cover?.ref === ref) as.push('backup');
    if (!as.length) continue;
    const other = [h.fallback, h.cover?.ref].some(x => !!x && x !== ref);
    out.push({ name: h.name, as, spare: other });
  }
  return out;
}

const names = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? ''));

/**
 * "In use by staff Ann and Bo." ('' when nobody): short, names only (what deleting it does to them is said in the confirm,
 * assignedWarning). `where` adds " on "Z820"" for a linked PC's own hires.
 */
export function assignedWords(list: Assigned[], where = ''): string {
  return list.length ? `In use by staff ${names(list.map(a => a.name))}${where ? ` on ${where}` : ''}.` : '';
}

/** What deleting it does to them, for the confirm: no model, a backup answering, or a lost backup ('' when nobody). */
export function assignedWarning(list: Assigned[], where = ''): string {
  const bare = list.filter(a => (a.as.includes('first choice') || a.as.includes('on it now')) && !a.spare).map(a => a.name);
  const covered = list.filter(a => (a.as.includes('first choice') || a.as.includes('on it now')) && a.spare).map(a => a.name);
  const lost = list.filter(a => !a.as.includes('first choice') && !a.as.includes('on it now')).map(a => a.name);
  const parts = [
    bare.length ? `${names(bare)} would have no model until you give them another` : '',
    covered.length ? `${names(covered)} would answer on ${covered.length > 1 ? 'their backups' : 'their backup'}` : '',
    lost.length ? `${names(lost)} would lose ${lost.length > 1 ? 'their backups' : 'their backup'}` : '',
  ].filter(Boolean);
  return parts.length ? `Deleting it affects staff${where ? ` on ${where}` : ''}: ${parts.join('; ')}.` : '';
}

/**
 * The staff lines for one model: `mine` are this PC's hires on it; `theirs` the linked PC's own hires on its model (undefined:
 * the model is on this PC; null: that PC is an older TOMLIN that does not say, which is said, not guessed).
 */
export function staffLines(o: { mine: Assigned[]; theirs?: Assigned[] | null; pcName?: string }): { note: string; warning: string } {
  const where = `"${o.pcName ?? 'that PC'}"`;
  const note = [assignedWords(o.mine), o.theirs === undefined ? '' : o.theirs === null ? `Staff on ${where}: not checked (it runs an older TOMLIN that does not say).` : assignedWords(o.theirs, where)].filter(Boolean).join(' ');
  const warning = [assignedWarning(o.mine), o.theirs?.length ? assignedWarning(o.theirs, where) : ''].filter(Boolean).join(' ');
  return { note, warning };
}
