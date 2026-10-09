// Answers a linked PC still owes this PC's chats (src/outbox.ts): kept in data/owed.json from the moment one is asked
// for until it is in its chat. Collected at Reconnect (the button under the answer), at every start, and once a minute
// while any are owed. The node keeps each finished answer until it is collected (three days at most).
import { cleanOwed, settle, withOwedLine, type Owed } from '../outbox.ts';
import { cleanAnswer, isPlain } from '../staff.ts';
import { takeSuggestion } from '../memory.ts';
import type { ChatInfo } from '../chats.ts';
import { type Routes, byStaff, chats, json, ledger, staff, staffId, store } from './core.ts';
import { cleanUsed, staffOfWho } from '../meter.ts';
import { jobRoutes } from './jobs.ts';

const FILE = 'owed.json';

/**
 * A collected answer tidied as one that came in live is (src/server/chat.ts): a hire's answer is cleaned (a Default
 * hire's is kept as it came), and a "REMEMBER: ..." suggestion comes off (it was for Save / No, which is gone now).
 */
function tidyFor(c: ChatInfo, text: string): string {
  const member = staffId(c.who) ? staff.get(c.who.slice(6)) : undefined;
  return takeSuggestion(member && !isPlain(member) ? cleanAnswer(text) : text).answer;
}

export async function owedList(): Promise<Owed[]> {
  return cleanOwed(await store.readJson<unknown>(FILE, []));
}

/**
 * Answers still coming in live on this PC: owed on the disk (in case this PC stops), but not collected while their
 * own chat turn is still following them (it would put the answer in twice).
 */
const live = new Set<string>();

/** An answer asked for now: owed until it is in its chat, and followed live until it comes in or the connection is lost. */
export async function addOwed(o: Owed): Promise<void> {
  live.add(o.rid);
  await store.updateJson<unknown>(FILE, [], now => [...cleanOwed(now).filter(x => x.rid !== o.rid), o]);
}

/** The connection was lost and did not come back: from now on it is collected (Reconnect, every start, each minute). */
export const notLive = (rid: string) => void live.delete(rid);

export async function dropOwed(rid: string): Promise<void> {
  live.delete(rid);
  await store.updateJson<unknown>(FILE, [], now => {
    const list = cleanOwed(now);
    return list.some(x => x.rid === rid) ? list.filter(x => x.rid !== rid) : undefined;
  });
}

/** One collection at a time: Reconnect pressed during the minute's round waits for it, so nothing is put in twice. */
let round: Promise<unknown> = Promise.resolve();

/**
 * Asks the linked PCs for the answers owed to `chatId` (every chat when none is given) and puts each one that came
 * into its chat. A chat whose stand-in line is missing (this PC stopped before it could write one) gets it first.
 * Says what happened: how many came in, how many are still being written, and which PCs did not answer.
 */
export function collect(chatId?: string): Promise<{ got: number; working: number; off: string[]; gone: number }> {
  const next = round.then(() => collectNow(chatId), () => collectNow(chatId));
  round = next.catch(() => undefined);
  return next;
}

async function collectNow(chatId?: string): Promise<{ got: number; working: number; off: string[]; gone: number }> {
  const out = { got: 0, working: 0, off: [] as string[], gone: 0 };
  const owed = (await owedList()).filter(o => (!chatId || o.chatId === chatId) && !live.has(o.rid));
  if (!owed.length) return out;
  const remotes = (await store.settings()).remotes;
  for (const o of owed) {
    const c = await chats.get(o.chatId);
    const r = remotes.find(x => x.id === o.pc);
    // The chat was deleted, or that PC unlinked: nothing to put it into, or nobody to ask.
    if (!c) {
      await dropOwed(o.rid);
      if (r) await jobRoutes.owedTaken(r, [o.rid]);
      continue;
    }
    const file = chats.file(c.id);
    await store.changeChat(file, lines => withOwedLine(lines, o));
    if (!r) {
      await store.changeChat(file, lines => settle(lines, o.rid, { state: 'gone', why: `${o.name} is no longer linked to this PC, so this answer cannot be collected. Send your message again.` }));
      await dropOwed(o.rid);
      out.gone++;
      continue;
    }
    const said = await jobRoutes.owedNow(r, o.rid);
    if (!said) {
      if (!out.off.includes(r.name)) out.off.push(r.name);
      continue;
    }
    const tidy = said.state === 'gone' ? said : { ...said, text: tidyFor(c, said.text) };
    await store.changeChat(file, lines => settle(lines, o.rid, tidy));
    if (said.state === 'working') {
      out.working++;
      continue;
    }
    await dropOwed(o.rid);
    if (said.state === 'gone') out.gone++;
    else {
      // What it used counts for that PC under the chat's project (its own log settles it at the next minute's read).
      const used = cleanUsed(said.done?.usage);
      if (used) {
        ledger.add(o.pc, c.project ?? '', used);
        byStaff.add(staffOfWho(c.who), used);
      }
      out.got++;
      await jobRoutes.owedTaken(r, [o.rid]);
    }
  }
  return out;
}

/** Collected once the jobs have started (each start), then once a minute while any answer is owed. */
export function startOwed(): void {
  setTimeout(() => void collect().catch(() => undefined), 8000).unref();
  setInterval(() => void owedList().then(l => (l.length ? collect() : null)).catch(() => undefined), 60_000).unref();
}

/** Reconnect's words: what came in, what is still being written, and who did not answer. */
export function reconnectSaid(r: { got: number; working: number; off: string[]; gone: number }): string {
  const parts: string[] = [];
  if (r.got) parts.push(r.got === 1 ? 'The answer came in.' : `${r.got} answers came in.`);
  if (r.working) parts.push(`${r.working === 1 ? 'It is' : `${r.working} are`} still being written: press Reconnect again in a while (it is also collected by itself once a minute).`);
  if (r.off.length) parts.push(`${r.off.map(n => `"${n}"`).join(' and ')} did not answer: check that PC is on and TOMLIN is open there, then press Reconnect again.`);
  if (r.gone && !r.got) parts.push('It could not be collected: see the note under it.');
  return parts.join(' ') || 'Nothing is owed to this chat any more.';
}

export const owedPost: Routes = {
  '/api/chat/reconnect': async ({ res, b }) => {
    // {chatId}: Reconnect under an answer a linked PC was still writing when the connection was lost.
    const c = await chats.get(b.chatId);
    if (!c) return json(res, 404, { error: 'That chat is not there any more.' });
    const r = await collect(c.id);
    return json(res, 200, { ...r, said: reconnectSaid(r), lines: await chats.lines(c.id) });
  },
};
