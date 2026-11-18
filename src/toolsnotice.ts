// Said, never done: the wrong-model-for-tools notice (Web is on, or the chat's tools were offered, and the model that
// answered has no Tools mark), the words when Web is off but the message plainly asks for the web, and the words for a
// permit card nobody answered in time. Nothing here swaps a model or switches Web on: the person chooses. Pure; the chat
// sends them (src/server/chat.ts) and the page draws them (public/crash.js). Tested in test/toolsnotice.test.ts.

/** A chat model that could take the tools instead. */
export interface ToolsOffer {
  id: string;
  name: string;
  /** Loaded now (no wait to start it). */
  loaded: boolean;
}

export interface ToolsNotice {
  pc: string;
  model: string;
  text: string;
  offers: ToolsOffer[];
  /** Where to switch, in words. */
  how: string;
}

/**
 * The notice: names the PC and the model, says what it could not do, and offers models with the Tools mark (loaded ones
 * first, at most `max`). `offers` are this PC's models with the mark; a model on another PC is chosen there.
 */
export function toolsNotice(o: { pc: string; model: string; offers: ToolsOffer[]; max?: number }): ToolsNotice {
  const offers = [...o.offers].filter(x => x.name !== o.model).sort((a, b) => Number(b.loaded) - Number(a.loaded)).slice(0, o.max ?? 6);
  const where = o.pc === 'This PC' || o.pc === 'this PC' ? 'on this PC' : `on "${o.pc}"`;
  return {
    pc: o.pc,
    model: o.model,
    text: `${o.model} ${where} has no Tools mark: its chat format has no place for tools, so it could not search the web or use the chat's tools, and it answered from what it knows.`,
    offers,
    how: offers.length
      ? 'A model with the Tools mark can. To use one, pick it at the top of this chat (or in the hire\'s card) and send again: TOMLIN does not change the model in the middle of a chat.'
      : 'No chat model on this PC has the Tools mark. Models such as Qwen 3 and 3.5 have it: Models, tick Tools to see them.',
  };
}

/**
 * A bare web address typed without http or www ("mysite.com.au", "some-site.org/page"). Only well-known endings count, so
 * "llama.cpp", "package.json" and "index.html" are not taken for sites, and an email address is not one either.
 */
// Case matters on purpose: a site is typed in lower case ("shop.com.au"), while "ASP.NET", "the end.Co" and "it.Com" are
// not. Endings that are also file, code or word endings (io, co, app, dev, au, ca) count only after com, net, org, edu or gov.
const BARE_ADDRESS = /(?<![@\w./-])(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+(?:com|net|org|edu|gov)(?:\.(?:au|uk|nz|za|jp|in)(?![A-Za-z0-9-]))?(?![A-Za-z0-9@(_-])(?:\/[^\s<>"')]*)?/;

const PLACEHOLDER_SITE = /^(?:https?:\/\/)?(?:www\.)?(?:example\.(?:com|org|net)|localhost)(?:[:/?#]|$)/i;

/** A message that plainly asks for the web: a link, a web address, or words such as "search the web" or "look it up online". */
export function asksForWeb(message: string): string {
  const found = /\bhttps?:\/\/[^\s<>"')]+/i.exec(message)?.[0] ?? /\bwww\.[a-z0-9-]+\.[a-z.]{2,}[^\s<>"')]*/i.exec(message)?.[0] ?? BARE_ADDRESS.exec(message)?.[0];
  // An address that only stands for "a site" in an example (example.com, localhost) is not a request to open anything.
  const cleaned = found?.replace(/[.,;:!?]+$/, '');
  const link = cleaned && !PLACEHOLDER_SITE.test(cleaned) ? cleaned : undefined;
  if (link) return link;
  return /\b(search|look (it |this |that )?up|check|google|browse)\b[^.?!]{0,30}\b(web|internet|online|google)\b|\b(on|from) the (web|internet)\b|\bonline\b.{0,20}\b(price|news|latest)\b|\blatest news\b/i.test(message) ? 'the web' : '';
}

/** Said under the answer when Web is off and the message asked for it ('' when it did not). */
export function webOffWords(message: string): string {
  const asked = asksForWeb(message);
  if (!asked) return '';
  return `Web is off in this chat, so ${asked === 'the web' ? 'nothing was looked up on the web' : `${asked} was not opened`}: this answer is from what the model already knows. Switch Web on (under the message box) and send again to use it.`;
}

/** How long a permit card waits for an answer before the answer goes on without it. */
export const PERMIT_WAIT_MS = 5 * 60_000;

const KIND_WORDS: Record<string, string> = { files: 'your files', web: 'the web', screen: 'the screen', machine: 'the laptop helper', git: 'git', notes: 'notes', subagent: 'a subagent', focus: 'bringing a window to the front', input: 'clicking or typing', run: 'running a command', edit: 'editing a file', download: 'downloading a file' };

/** Said on the card and under the answer when nobody answered the card in time. */
export function permitTimedOut(kind: string, ms = PERMIT_WAIT_MS): string {
  const min = Math.round(ms / 60_000);
  return `No answer came to the question about ${KIND_WORDS[kind] ?? kind} within ${min} minute${min === 1 ? '' : 's'}, so it was taken as a no and the answer went on without it. Send again when you are here to answer.`;
}
