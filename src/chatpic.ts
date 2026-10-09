// Pictures asked for in a chat: which messages ask for one (the app then says which artist draws), and the prompt
// line cleaned from a model's answer. The plain functions are tested in test/chatpic.test.ts.

export interface PictureAsk {
  /** self: "send me a selfie" (a picture of the one asked); thing: anything else. */
  kind: 'self' | 'thing';
  /** What was asked for, without the asking words. */
  subject: string;
}

const SELF = /\b(?:selfies?|(?:a\s+)?(?:pic|picture|photo|pict|snap)\s+of\s+(?:you|yourself)|see\s+(?:you|what\s+you\s+look\s+like)|show\s+(?:me\s+)?(?:you|yourself)|what\s+you\s+look\s+like)\b/i;
const MAKE = /^\s*(?:please\s+)?(?:(?:can|could|will|would)\s+you\s+)?(?:please\s+)?(?:(?:make|draw|create|generate|paint|render|show|send|give|take|snap)(?:\s+(?:me|us))?|i\s+(?:want|need|would\s+like)|let\s+me\s+see)\s+(?:an?\s+|the\s+|some\s+|one\s+)?(?:(?:new|quick|little|nice|good|cute)\s+)?(?:(?:cartoon|anime|comic|manga|chibi)\s+)?(?:profile\s+)?(?:image|picture|pic|photo|photograph|illustration|drawing|artwork|selfie|snap|avatar|headshot|cartoon|portrait)s?\b/i;
const OF = /^\s*(?:of|showing|with|for)\s+/i;

/**
 * Whether a chat message asks for a picture. Needs a clear request: "can you draw a lighthouse", "send me a selfie",
 * "show me a picture of your kitchen", "/image ..." is handled elsewhere. Plain talk about pictures does not count.
 */
export function pictureAsk(message: string): PictureAsk | null {
  const text = message.trim();
  if (!text || text.length > 600) return null;
  const make = MAKE.exec(text);
  if (!make && !/^\s*(?:please\s+)?(?:send|show)\s+(?:me\s+)?(?:a\s+)?selfie\b/i.test(text)) return null;
  const rest = make ? text.slice(make[0].length).replace(OF, '').trim() : '';
  if (SELF.test(text)) return { kind: 'self', subject: rest };
  if (!rest) return null;
  return { kind: 'thing', subject: rest.replace(/[?!.\s]+$/, '') };
}

/** The model's answer as one clean prompt line; empty when it wrote nothing usable. */
export function cleanPrompt(raw: string): string {
  const line = raw.split('\n').map(s => s.trim()).find(Boolean) ?? '';
  const s = line.replace(/^(?:(?:image|picture|photo)\s+)?(?:prompt|picture|image)\s*:\s*/i, '').replace(/^["'“*_\s]+|["'”*_\s]+$/g, '').replace(/[<>{}*_`#]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').slice(0, 60).join(' ');
}
