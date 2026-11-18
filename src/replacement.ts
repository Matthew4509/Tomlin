// A hire whose model is gone: what to say, and what to suggest in its place. Pure: src/jobrun/who.ts (hireBrain) gathers what
// TOMLIN already knows (the models on this PC and on the linked PCs from their last hello, the network list, the free room)
// and this words it. It only suggests: nothing is downloaded, sent or switched here; every action named is a button the
// owner presses (Pick a backup in the chat, Get a copy under Network, Copy to <PC> in Hire staff).
import { sameModel, type BackupChoice } from './brains.ts';
import { roomWhy, type NetRow } from './carry.ts';

const GB = 2 ** 30;
const gb = (n: number) => `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;

export interface ReplaceInput {
  /** The hire's first name. */
  first: string;
  /** The model that is gone, by name. */
  goneName: string;
  /** Where it was: 'this PC' or the linked PC's name (null for this PC). */
  wasOn: string | null;
  /** This PC's and the linked PCs' models a hire could use (src/jobrun/who.ts backupChoices). */
  choices: BackupChoice[];
  /** The models the linked PCs share, with where each can be copied from (src/carry.ts networkList). */
  rows: NetRow[];
  /** This PC's chat models. */
  mine: { name: string; bytes: number }[];
  /** The linked PCs: whether this PC can send a model to each now ('' when it can). Their room for models is not told, so that PC checks it before anything is sent. */
  pcs: { name: string; send: string }[];
  /** Free room on this PC's models drive (null: not known). */
  freeHere: number | null;
}

/** Why a hire's model is gone, in one plain clause. */
export const goneWords = (name: string, wasOn: string | null) => (wasOn ? `${name} is no longer on "${wasOn}" (it was deleted or moved there)` : `${name} is no longer on this PC (it was deleted or moved)`);

/** Up to three suggestions, best first. Empty when TOMLIN knows of nothing close. */
export function replacementLines(i: ReplaceInput): string[] {
  const out: string[] = [];
  const same = i.choices.filter(c => c.same);
  // 1. The same model is on a linked PC: use it there, or copy it here.
  const there = same.find(c => c.pcId && c.pcId !== 'here');
  if (there) {
    const row = i.rows.find(r => !r.here && sameModel(r.name, i.goneName) && r.on.some(o => o.pcName === there.pc && o.copy));
    let copy = '';
    if (row) {
      const short = i.freeHere === null ? null : roomWhy(row.bytes, i.freeHere, 'this PC');
      copy = `, or copy it to this PC (Network, Models on my other PCs, Get a copy from "${there.pc}"; ${gb(row.bytes)} needed${i.freeHere === null ? '' : `, ${gb(i.freeHere)} free here`}${short ? ': Free up space on this PC first' : ''})`;
    }
    out.push(`The same model, ${there.model}, is on "${there.pc}": pick it as ${i.first}'s backup in this chat to use it there${copy}.`);
  }
  // 2. The same model is on this PC: use it here; if it was on a linked PC, a copy can go back.
  const here = same.find(c => c.pcId === 'here');
  if (here) {
    const mine = i.mine.find(m => sameModel(m.name, here.model));
    const back = i.wasOn ? i.pcs.find(p => p.name === i.wasOn) : undefined;
    let send = '';
    if (back && mine && !back.send) send = `, or send a copy back to "${back.name}" so ${i.first} uses it there again (Hire staff, All models, Copy to ${back.name}; ${gb(mine.bytes)}, and "${back.name}" checks it has room before anything is sent)`;
    out.push(`The same model, ${here.model}, is on this PC: pick it as ${i.first}'s first choice in Team${send}.`);
  }
  // 3. Nothing the same: the nearest in size, as the backup list already orders them.
  if (!out.length) {
    const near = i.choices.find(c => !c.intern && c.fit !== 'no' && (c.level === 'match' || c.level === 'any'));
    if (near) out.push(`Nearest in size: ${near.model} on ${near.pc === 'This PC' ? 'this PC' : `"${near.pc}"`}: pick it as ${i.first}'s ${near.pc === 'This PC' ? 'first choice in Team' : 'backup in this chat'}.`);
  }
  return out.slice(0, 3);
}

/** The line said when a backup answered because the first choice is gone. */
export const backupAnsweredWords = (first: string, gone: string, backup: string, backupOn: string) => `${first}'s model is gone: ${gone}. ${first}'s backup, ${backup} on ${backupOn}, answered instead. Pick a new first choice in Team.`;

/** The message when nothing can answer and a model is gone: what happened, why, what to do (one pass of the owner's own buttons). */
export function goneMessage(i: ReplaceInput, others: string[]): string {
  const lines = replacementLines(i);
  const rest = others.length ? ` ${others.join('; ')}.` : '';
  const how = lines.length ? ` ${lines.join(' ')} Nothing is copied, sent or changed until you press it.` : ` TOMLIN knows of no close match: pick another model for ${i.first} in Team.`;
  return `${i.first}'s model is gone: ${goneWords(i.goneName, i.wasOn)}.${rest}${how}`;
}
