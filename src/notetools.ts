// Research notes for a chat with Web on (Settings, Permissions, Research): save_note writes a note into the
// research/ folder of the chat's folder, with a Sources block that the CODE builds from the pages this answer really
// opened (not from what the model says it read), and suggest_finding puts a finding in front of the person, which is
// NOT kept until they press Save. Everything goes through src/workspace.ts, so nothing outside the folder is touched,
// and through checkSave, so a note holding a key or a password is refused. A note never overwrites a different note:
// it gets a new name (-2, -3). Plain parts, tested in test/notetools.test.ts.
import type { ToolDef } from './webtools.ts';
import * as ws from './workspace.ts';
import { checkSave } from './rules.ts';

export const NOTE_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Save a research note as a file in the research folder of the folder you work in. Give a short title and the note\'s text. The list of sources is added for you from the pages you opened in this answer: do not write one yourself.',
      parameters: { type: 'object', properties: { title: { type: 'string', description: 'A short title, a few words.' }, text: { type: 'string', description: 'The note, in plain words or Markdown.' } }, required: ['title', 'text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_finding',
      description: 'Suggest one finding worth keeping: a sentence or two, and the address of the page it came from. It is shown to the person, who decides whether to save it. It is not saved by this call.',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'The finding, in a sentence or two.' }, source: { type: 'string', description: 'The address of the page it came from, exactly as you opened it.' } }, required: ['text'] },
    },
  },
];

export const isNoteTool = (name: string) => name === 'save_note' || name === 'suggest_finding';
export const NOTES_LINE = 'You can keep what you find: save_note saves a note in the research folder (its sources are added for you), suggest_finding shows the person a finding to save if they wish. A suggested finding is not saved until they press Save: never say it was saved.';
export const RESEARCH_DIR = 'research';
export const NOTE_MAX = 60_000;
export const FINDING_MAX = 600;
export const FINDINGS_MOST = 8;

/** The larger room a research answer gets: more pages and more rounds, the pace on each site kept as it is. */
export const RESEARCH_BUDGET = { pagesPerAnswer: 60, rounds: 20 };

export function noteCallWords(name: string): string {
  return name === 'save_note' ? 'Saving a note…' : 'Suggesting a finding…';
}

/** A page this answer opened: its address and its title, in the order they were read. */
export interface Source { url: string; title: string }

/** The pages really opened, from the answer's web uses (src/webtools.ts): each address once, in order, failures left out. */
export function sourcesOf(uses: Array<{ name: string; input: string; ok: boolean; said: string }>): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const u of uses) {
    if (u.name !== 'open_page' || !u.ok || seen.has(u.input)) continue;
    seen.add(u.input);
    out.push({ url: u.input, title: u.said.replace(/(,\s*part \d+ of \d+)?,\s*[\d,]+ words.*$/, '').trim().slice(0, 160) });
  }
  return out;
}

/** The Sources block at the end of a note or an answer, built by code. '' when no page was opened. */
export function sourcesBlock(sources: Source[]): string {
  if (!sources.length) return '';
  return `## Sources\n\n${sources.map((s, i) => `${i + 1}. ${s.title ? `${s.title.replace(/[\r\n[\]]/g, ' ')} - ` : ''}${s.url}`).join('\n')}\n`;
}

/** A file name from a title: plain letters, digits and dashes. */
export function noteSlug(title: unknown): string {
  return String(title ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'note';
}

export interface Finding { id: string; text: string; source: string }
export interface NoteUse { name: 'save_note' | 'suggest_finding'; input: string; ok: boolean; said: string }

export interface NoteTurnOpts {
  root: string;
  /** The pages this answer has opened so far, asked when a note is saved. */
  sources: () => Source[];
  /** The addresses this answer may name as a finding's source (the pages opened). */
  today?: () => Date;
}

/** One answer's notes: the notes saved, and the findings suggested (none of them kept here). */
export class NoteTurn {
  readonly saved: string[] = [];
  readonly findings: Finding[] = [];
  readonly uses: NoteUse[] = [];
  private readonly o: NoteTurnOpts;

  constructor(o: NoteTurnOpts) {
    this.o = o;
  }

  async run(name: string, rawArgs: string): Promise<string> {
    let a: Record<string, unknown>;
    try {
      a = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
      if (!a || typeof a !== 'object') throw new Error('not an object');
    } catch {
      return 'The call could not be read: its arguments are not JSON.';
    }
    const done = (tool: NoteUse['name'], ok: boolean, input: string, said: string, result: string) => {
      this.uses.push({ name: tool, input: input.slice(0, 200), ok, said: said.slice(0, 200) });
      return result;
    };
    if (name === 'save_note') {
      const title = String(a.title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
      const text = typeof a.text === 'string' ? a.text.trim() : '';
      if (!title || !text) return done('save_note', false, title, 'no title or text', 'Not saved: a note needs a title and a text.');
      if (text.length > NOTE_MAX) return done('save_note', false, title, 'too long', `Not saved: a note is at most ${NOTE_MAX.toLocaleString('en-GB')} characters. Save it in parts.`);
      const d = (this.o.today ?? (() => new Date()))();
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const block = sourcesBlock(this.o.sources());
      const whole = `# ${title}\n\nSaved ${day}.\n\n${text}\n${block ? `\n${block}` : ''}`;
      const refused = checkSave(null, whole);
      if (refused) return done('save_note', false, title, 'refused', refused);
      const slug = noteSlug(title);
      for (let n = 1; n <= 50; n++) {
        const path = `${RESEARCH_DIR}/${slug}${n > 1 ? `-${n}` : ''}.md`;
        const was = await ws.read(this.o.root, path);
        if (!('error' in was)) {
          // The same note again (a model that repeats a call) is not a second file; a different one is never written over.
          if (was.text === whole) return done('save_note', true, title, path, `That note is already saved as ${path}.`);
          continue;
        }
        const r = await ws.save(this.o.root, path, whole, true, true);
        if ('error' in r) return done('save_note', false, title, 'not saved', r.error);
        this.saved.push(r.path);
        return done('save_note', true, title, r.path, `Saved the note as ${r.path}${block ? `, with ${this.o.sources().length} source${this.o.sources().length === 1 ? '' : 's'} listed` : ' (no page was opened in this answer, so it lists no sources)'}.`);
      }
      return done('save_note', false, title, 'too many with that name', 'Not saved: there are already 50 notes with that title. Give it another title.');
    }
    if (name === 'suggest_finding') {
      const text = typeof a.text === 'string' ? a.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) return done('suggest_finding', false, '', 'no text', 'Not suggested: say the finding in a sentence or two.');
      if (text.length > FINDING_MAX) return done('suggest_finding', false, text, 'too long', `Not suggested: a finding is at most ${FINDING_MAX} characters.`);
      if (this.findings.length >= FINDINGS_MOST) return done('suggest_finding', false, text, 'too many', `Not suggested: ${FINDINGS_MOST} findings is the most in one answer.`);
      if (checkSave(null, text)) return done('suggest_finding', false, 'a finding', 'refused', 'Not suggested: the text looks like it holds a password, key or token.');
      // The source must be a page this answer really opened; anything else is shown without one.
      const given = typeof a.source === 'string' ? a.source.trim() : '';
      const source = this.o.sources().find(s => s.url === given || s.url.replace(/\/$/, '') === given.replace(/\/$/, ''))?.url ?? '';
      this.findings.push({ id: `f${this.findings.length + 1}`, text, source });
      return done('suggest_finding', true, text, 'shown to the person', `Shown to the person, who decides whether to save it${given && !source ? ' (the source you gave is not a page you opened in this answer, so it is shown without one)' : ''}. It is NOT saved yet: do not say it was saved.`);
    }
    return `There is no tool called "${name}".`;
  }
}

/** The person pressed Save on a finding: added to research/findings.md in the chat's folder (the older file kept as .bak). */
export async function keepFinding(root: string, f: { text: unknown; source: unknown }, today = new Date()): Promise<{ path: string } | { error: string }> {
  const text = typeof f.text === 'string' ? f.text.replace(/\s+/g, ' ').trim().slice(0, FINDING_MAX) : '';
  if (!text) return { error: 'There is no finding to save.' };
  const source = typeof f.source === 'string' && /^https?:\/\/\S{1,2000}$/.test(f.source) ? f.source : '';
  const path = `${RESEARCH_DIR}/findings.md`;
  const was = await ws.read(root, path);
  const old = 'error' in was ? '# Findings\n' : was.text.replace(/\s*$/, '\n');
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const whole = `${old}\n- ${day}: ${text}${source ? ` (${source})` : ''}\n`;
  const refused = checkSave('error' in was ? null : was.text, whole);
  if (refused) return { error: refused };
  const r = await ws.save(root, path, whole, true, true);
  return 'error' in r ? r : { path: r.path };
}
