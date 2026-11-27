// The newer tools' server side (src/toolkit.ts): what a chat's answer is handed (the real screen, the linked
// helpers, the action log), the helpers this PC is linked to (data/helpers.json; their keys never go to the page),
// and the findings a model suggested, which are kept only when the person presses Save.
import { join } from 'node:path';
import { readData, updateData } from '../atomic.ts';
import { logAction } from '../actionlog.ts';
import { cleanHelpers, helperView, linkHelper, type HelperLink } from '../camhelper.ts';
import { keepFinding, sourcesOf, type Finding } from '../notetools.ts';
import type { Gate, Permissions } from '../permits.ts';
import { makeKit, type Kit, type KitOpts } from '../toolkit.ts';
import { winScreen } from '../winscreen.ts';
import type { ToolUse } from '../webtools.ts';
import { DATA_DIR, type Routes, chats, json, modelSaved } from './core.ts';
import { appLock, appLockOn } from './locks.ts';
import { chatFilesRoot } from './places.ts';

const HELPERS_FILE = join(DATA_DIR, 'helpers.json');
const ACTION_DIR = join(DATA_DIR, 'action-log');

export const helpers = async (): Promise<HelperLink[]> => cleanHelpers(await readData<unknown>(HELPERS_FILE, []));

/** This PC's id on a helper's link: made once, kept with the helpers. */
async function myId(): Promise<string> {
  const file = join(DATA_DIR, 'helper-id.json');
  const got = await updateData<{ id?: string }>(file, {}, now => (typeof now.id === 'string' && /^[0-9a-f]{16}$/.test(now.id) ? undefined : { id: [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('') }));
  return String(got.id);
}

/** The newer tools for one answer here, or null when this chat is offered none of them. */
export async function kitFor(o: { perms: Permissions; gate: Gate; perCall: number; root: string | null; web: boolean; webUses: () => ToolUse[]; page?: KitOpts['page']; second?: KitOpts['second']; canQueue?: boolean; saved?: () => string[] }): Promise<Kit | null> {
  const linked = await helpers();
  return makeKit({
    perms: o.perms,
    gate: o.gate,
    perCall: o.perCall,
    platform: process.platform,
    screen: winScreen,
    locked: () => appLockOn() && !appLock.isOpen(),
    helpers: linked,
    me: linked.length ? await myId() : '',
    root: o.root,
    dataDir: DATA_DIR,
    web: o.web,
    sources: () => sourcesOf(o.webUses()),
    page: o.page,
    second: o.second,
    canQueue: o.canQueue,
    saved: o.saved,
    since: modelSaved,
    log: a => logAction(ACTION_DIR, a),
  });
}

/** The findings each chat's last answer suggested: in memory only, until the person presses Save on one. */
const suggested = new Map<string, Finding[]>();
export function holdFindings(chatId: string, list: Finding[]): void {
  if (list.length) suggested.set(chatId, list);
  else suggested.delete(chatId);
  if (suggested.size > 200) suggested.delete(suggested.keys().next().value!);
}

export const toolsGet: Routes = {
  '/api/helpers': async ({ res }) => json(res, 200, { helpers: (await helpers()).map(helperView) }),
};

export const toolsPost: Routes = {
  '/api/helpers': async ({ res, b }) => {
    // {action: 'link', address, code} or {action: 'remove', id}: the laptop helpers this PC is linked to.
    if (b.action === 'remove') {
      await updateData<unknown>(HELPERS_FILE, [], now => cleanHelpers(now).filter(h => h.id !== b.id));
      return json(res, 200, { helpers: (await helpers()).map(helperView) });
    }
    if (b.action !== 'link') return json(res, 400, { error: 'Link a helper, or remove one.' });
    const made = await linkHelper(b.address, b.code, { id: await myId(), name: 'TOMLIN' });
    if ('error' in made) return json(res, 400, { error: made.error });
    await updateData<unknown>(HELPERS_FILE, [], now => [...cleanHelpers(now).filter(h => h.id !== made.id && h.url !== made.url), made]);
    return json(res, 200, { helpers: (await helpers()).map(helperView) });
  },
  '/api/chat/finding': async ({ res, b }) => {
    // {chatId, id}: Save, pressed on a finding the last answer suggested. Only one that was really suggested is kept.
    const chatId = String(b.chatId ?? '');
    const f = suggested.get(chatId)?.find(x => x.id === b.id);
    if (!f) return json(res, 404, { error: 'That finding is not waiting any more. Ask for it again.' });
    const info = (await chats.list()).find(c => c.id === chatId);
    if (!info) return json(res, 404, { error: 'That chat is not there any more.' });
    const kept = await keepFinding(await chatFilesRoot(info.project), f);
    if ('error' in kept) return json(res, 400, { error: kept.error });
    suggested.set(chatId, (suggested.get(chatId) ?? []).filter(x => x.id !== f.id));
    return json(res, 200, { path: kept.path });
  },
};
