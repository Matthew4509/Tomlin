// The blog writer: the instructions for a post, the file name and the finished markdown file. The plain functions are
// tested in test/blog.test.ts.

export interface BlogAsk {
  topic: string;
  /** Who it is for (one short phrase), optional. */
  audience: string;
  /** Rough length in words. */
  words: number;
}

/** The ask from the form, with sane limits. Null when there is no topic. */
export function blogAsk(b: Record<string, unknown>): BlogAsk | null {
  const topic = String(b.topic ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!topic) return null;
  const words = Math.max(150, Math.min(1200, Math.round(Number(b.words) || 400)));
  return { topic, audience: String(b.audience ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), words };
}

/** What the writer is told. Warm and plain, facts in prose, any limit said once, no filler. */
export function blogSystem(ask: BlogAsk, tone = ''): string {
  return [
    'You are a writer for a small business blog. Write one blog post.',
    `Start with a title on the first line as "# Title", then the post as plain paragraphs. About ${ask.words} words.`,
    'Voice: warm and direct, like a knowledgeable person talking to a customer. Put facts in sentences, not bullet lists. If there is a limit or a caveat, say it once, plainly, and move on. No filler openings, no "in conclusion", no hype, no hedging on every line.',
    'Do not invent statistics, prices, quotes or names. If you do not know a fact, leave it out.',
    ask.audience ? `It is written for: ${ask.audience}.` : '',
    tone ? `When asked to write a letter, article, post or message, ${tone[0].toLowerCase()}${tone.slice(1)}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Title and body from the model's text: the first "# " line is the title; with none, the first short line is. */
export function splitPost(text: string): { title: string; body: string } {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  let i = lines.findIndex(l => l.trim());
  if (i < 0) return { title: '', body: '' };
  const first = lines[i].trim();
  const title = first.replace(/^#+\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1').replace(/^["“]|["”]$/g, '').trim().slice(0, 120);
  const heading = /^#\s/.test(first);
  if (!heading && first.length > 90) return { title: '', body: lines.join('\n').trim() };
  return { title, body: lines.slice(i + 1).join('\n').trim() };
}

/** A file name from the title: lower case, hyphens, at most six words. */
export function blogSlug(title: string): string {
  const words = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  return words.slice(0, 6).join('-') || 'post';
}

/** The markdown file: front matter, title, the picture when there is one, then the post. */
export function blogFile(title: string, body: string, opts: { picture?: string; alt?: string; date?: Date } = {}): string {
  const date = (opts.date ?? new Date()).toISOString().slice(0, 10);
  const q = (s: string) => JSON.stringify(s);
  const alt = (opts.alt ?? title).replace(/[\[\]]/g, '');
  return [
    '---',
    `title: ${q(title)}`,
    `date: ${date}`,
    ...(opts.picture ? [`image: ${q(opts.picture)}`] : []),
    '---',
    '',
    `# ${title}`,
    '',
    ...(opts.picture ? [`![${alt}](${opts.picture})`, ''] : []),
    body,
    '',
  ].join('\n');
}

/** Told to the chat model when it writes the picture prompt for a post. */
export const BLOG_PICTURE_SYSTEM = 'You write a prompt for an image model: one photo to go at the top of a blog post, from its title and opening. Show the subject of the post as a real scene or object, with no text, no logos and no people\'s faces. One line, under 40 words, plain words, no quotes, no preface. Answer with the prompt only.';
