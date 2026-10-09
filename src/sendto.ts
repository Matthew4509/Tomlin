// "Send to…": a prompt shown before it is handed on (read it, change it, copy it, or send it to someone, who answers or
// draws at once). This file holds the parts with no server state: the fixed instruction for "Write it as a prompt for…"
// (chosen by code from the role of the person it is for, never by a model), and the two lines the app writes so both
// chats say what happened: "Sent from …" on the message that arrived, "Sent to …" under the answer it came from.
import type { ChatLine } from './store.ts';

/** What a model is asked when it turns some words into a prompt for someone, by that person's role. */
export const PROMPT_FOR: Record<string, { label: string; system: string; tokens: number; oneLine: boolean }> = {
  artist: {
    label: 'a picture prompt',
    system: 'You write a prompt for an image model. From the text below, write one prompt that says what the picture shows: the subject, the setting, the light, the style. One line, under 40 words, plain words, no quotes, no names of real people, no preface. Answer with the prompt only.',
    tokens: 120,
    oneLine: true,
  },
  designer: {
    label: 'an icon prompt',
    system: 'You write a prompt for an image model that draws flat icons. From the text below, write one prompt for a single simple icon: the one object it shows, flat colours, a plain background, no text. One line, under 30 words, no quotes, no preface. Answer with the prompt only.',
    tokens: 100,
    oneLine: true,
  },
  coder: {
    label: 'a brief for the coder',
    system: 'Turn the text below into a short, clear brief for a programmer: what to build or change, what goes in and what should come out, and any limits that are named. Short plain sentences or a short list, at most 150 words. Only what the text says: invent nothing, and end with one question if something needed is missing. Answer with the brief only.',
    tokens: 320,
    oneLine: false,
  },
  writer: {
    label: 'a brief for the writer',
    system: 'Turn the text below into a short, clear brief for a writer: what to write, who it is for, about how long, the tone, and the facts it must include. Short plain sentences or a short list, at most 120 words. Only what the text says: invent nothing. Answer with the brief only.',
    tokens: 280,
    oneLine: false,
  },
  pm: {
    label: 'a goal to plan',
    system: 'Turn the text below into a goal for a project manager to plan: what should exist when it is finished, what is already decided, and any limits (time, tools, budget) that are named. Short plain sentences, at most 120 words. Only what the text says: invent nothing. Answer with the goal only.',
    tokens: 280,
    oneLine: false,
  },
  ask: {
    label: 'a clear request',
    system: 'Turn the text below into one clear request to send to a colleague: what is wanted, and the facts they need to do it. Plain words, at most 120 words. Only what the text says: invent nothing. Answer with the request only.',
    tokens: 280,
    oneLine: false,
  },
};

/** The instruction for a role (the host, a Default hire and any role not listed get a plain clear request). */
export function promptFor(role: string | null | undefined) {
  return PROMPT_FOR[role ?? ''] ?? PROMPT_FOR.ask;
}

/** The model's answer as the prompt: one clean line for a picture model, else the text with any preface taken off. */
export function cleanWritten(raw: string, oneLine: boolean): string {
  const text = raw.replace(/^\s*(?:here(?:'s| is) (?:the|a|your) [\w ]{0,30}:|(?:(?:image|picture|photo|icon)\s+)?(?:prompt|brief|request|goal)\s*:)\s*/i, '').trim();
  if (!oneLine) return text.slice(0, 4000).trim();
  const line = text.split('\n').map(s => s.trim()).find(Boolean) ?? '';
  return line.replace(/^["'“*_\s]+|["'”*_\s]+$/g, '').replace(/[<>{}*_`#]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 60).join(' ');
}

/** Where a message came from, as the page sends it ("Sam's chat", "the blog writer"): short, one line, or nothing. */
export function cleanFrom(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

/**
 * The answer something was sent from, marked "Sent to …": the newest assistant line that starts with the words sent
 * (a part picked from an answer is found inside it). Lines come back unchanged when no answer holds the words.
 */
export function markSent(lines: ChatLine[], words: string, to: string): { lines: ChatLine[]; marked: boolean } {
  const sample = words.trim().slice(0, 200);
  const label = cleanFrom(to);
  if (!sample || !label) return { lines, marked: false };
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.role !== 'assistant' || !l.content.includes(sample)) continue;
    const sent = [...(l.sent ?? []).filter(x => x !== label), label].slice(-5);
    const out = lines.slice();
    out[i] = { ...l, sent };
    return { lines: out, marked: true };
  }
  return { lines, marked: false };
}
