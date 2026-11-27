// Someone who left the team, as their kept chats show them: "Name (left the team)" with their initials and role, so the
// chats of different leavers can be told apart. Plain parts: test/leavers.test.ts.
import { roleOf, type Leaver } from './staff.ts';

/** A name from a hire's id, for someone who left before leavers were kept by name ("cy-holt" → "Cy Holt"). */
export function nameFromId(id: string): string {
  const words = id.split(/-+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1));
  return words.length ? words.join(' ') : 'Someone';
}

/** Up to two capitals from a name, as the staff rows show them. */
export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';

/** How a chat with leaver `id` names them: kept details when there are any, else a name made from the id. */
export function leftPerson(id: string, kept?: Leaver): { name: string; avatar: string; role: string; roleId?: string } {
  const name = kept?.name || nameFromId(id);
  return { name: `${name} (left the team)`, avatar: initialsOf(name), role: kept ? `${roleOf(kept.role).name} · left the team` : 'Left the team', ...(kept ? { roleId: roleOf(kept.role).id } : {}) };
}
