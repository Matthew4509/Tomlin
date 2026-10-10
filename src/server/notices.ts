// Notifications (person and event, never content), Mute, and the scratch pad and snippets.
import type { ChatLine } from '../store.ts';
import { whoFor, type JobEvent } from '../home.ts';
import * as mute from '../mute.ts';
import * as notes from '../notes.ts';
import * as notify from '../notify.ts';
import { type Routes, chats, json, mutes, noteStore, notifier, staff } from './core.ts';
import { chatPeople } from './people.ts';

// ---- Notifications (src/notify.ts): person and event, never content; Mute decides first ----

const personKey = (who: string) => (who.startsWith('staff:') || who.startsWith('node:') ? who : 'manager');

export async function tellJob(id: string, e: JobEvent): Promise<void> {
  try {
    const people = staff.list().map(m => ({ id: m.id, name: m.name, role: m.role }));
    const told = notify.jobTold(e, role => whoFor(role, people).name);
    if (!told) return;
    const hire = told.role ? whoFor(told.role, people).id : null;
    if (!mute.shouldTell(await mutes.get(), [`room:${id}`, hire ? `staff:${hire}` : null], told.event)) return;
    await notifier.tell(told.event, told.text, `room:${id}`);
  } catch {
    // A notification is never worth a fault.
  }
}

/** The answer just written to a chat file, when it is new: "Rosa answered." */
const chatToldAt = new Map<string, string>();
export async function tellChat(file: string, lines: ChatLine[]): Promise<void> {
  try {
    const id = /^chats\/([a-f0-9]{12})\.json$/.exec(file)?.[1];
    const last = lines[lines.length - 1];
    if (!id || last?.role !== 'assistant' || Date.now() - Date.parse(last.at) > 15_000 || chatToldAt.get(id) === last.at) return;
    chatToldAt.set(id, last.at);
    const c = await chats.get(id);
    if (!c) return;
    if (!mute.shouldTell(await mutes.get(), [`chat:${id}`, personKey(c.who)], 'finished')) return;
    await notifier.tell('finished', notify.chatTold(chatPeople().find(p => p.who === c.who)?.name ?? 'TOMLIN'), `chat:${id}`);
  } catch {
    // A notification is never worth a fault.
  }
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const noticesGet: Routes = {
  '/api/mute': async ({ res }) => json(res, 200, mute.view(await mutes.get())),
  '/api/notes': async ({ res }) => json(res, 200, await noteStore.get()),
};

/** POST requests answered here, by path (the body is read already). */
export const noticesPost: Routes = {
  '/api/mute': async ({ res, b }) => {
    // Mute or unmute one chat, staff member or job room, or all of them; or the "stuck still tells me" tick.
    let m = await mutes.get();
    if ('stuckTells' in b) m = { ...m, stuckTells: b.stuckTells !== false };
    if ('key' in b) {
      const key = b.key === 'all' ? 'all' : mute.isKey(b.key) ? b.key : null;
      const length = b.for === 'off' ? 'off' : mute.isLength(b.for) ? b.for : null;
      if (!key) return json(res, 400, { error: 'Mute what? That chat, person or job room is not known here.' });
      if (!length) return json(res, 400, { error: 'Mute for how long? Pick 1 hour, until tomorrow morning or until you unmute.' });
      m = mute.set(m, key, length);
    }
    return json(res, 200, mute.view(await mutes.save(m)));
  },
  '/api/notes': async ({ res, b }) => {
    // {scratch}: the scratch pad's words; {add, subject?}: a new snippet; {remove: id}; {restore: snippet, at}: Undo of a delete.
    const n = await noteStore.get();
    const r = 'scratch' in b ? notes.setScratch(n, b.scratch, b.was) : 'add' in b ? notes.addSnippet(n, b.add, new Date(), b.subject) : 'remove' in b ? notes.removeSnippet(n, b.remove) : 'restore' in b ? notes.restoreSnippet(n, b.restore, b.at) : null;
    if (!r) return json(res, 400, { error: 'Unknown notes action: reload the page (it may be older than TOMLIN) and try again.' });
    // A clash (another window saved the scratch pad meanwhile) sends back what is saved, for the window to offer.
    if (!r.ok) return json(res, r.clash ? 409 : 400, { error: r.error, ...(r.clash ? { notes: n } : {}) });
    return json(res, 200, { ...(await noteStore.save(r.notes)), id: r.id ?? null });
  },
  '/api/notify': async ({ res, b }) => json(res, 200, await notifier.save(b as Partial<notify.NotifySettings>)),
  '/api/notify/test': async ({ res }) => {
    notifier.test();
    return json(res, 200, { ok: true });
  },
};
