// A project's pictures: who draws a picture step, the words the picture model is given, a plain picture request kept
// to one picture step, and file names a plan's briefs give that no step makes.
import { cleanStep, type Step } from './jobs.ts';

/** Words that make a request more than a picture: a page, code, text to read, a document. */
const MORE_THAN_A_PICTURE = /\b(web ?site|web ?page|site|page|landing|html|css|javascript|code|app|application|program|script|game|blog|post|article|story|chapter|essay|document|report|email|letter|copy|text for|write|writes|written|menu|form|database|api|server|plugin|function|book)\b|\.\w{2,4}\b/i;
/** Words that ask for a picture. */
const PICTURE_ASK = /\b(picture|photo|photograph|image|drawing|draw|painting|paint|illustration|illustrate|portrait|render|wallpaper|artwork|sketch|scene|poster art)\b/i;

/**
 * Whether a request is a plain picture: one line, short, asking for a picture and nothing a step would write (a page,
 * code, text, a file). Such a request is planned as one picture step, never a project of several.
 */
export function plainPictureAsk(goal: string): boolean {
  const text = goal.replace(/\r/g, '').trim();
  if (!text || text.includes('\n') || text.length > 400) return false;
  return PICTURE_ASK.test(text) && !MORE_THAN_A_PICTURE.test(text);
}

/** The plan for a plain picture request: one picture step for the artist, its brief the words to draw. */
export function pictureOnlyPlan(goal: string): Step[] {
  const words = goal.replace(/\s+/g, ' ').trim();
  const step = cleanStep({ title: 'The picture', role: 'artist', files: '', brief: words, check: 'The picture shows what was asked for.' });
  return step ? [step] : [];
}

/** A sentence of a brief that is about files, folders, where the picture goes or how it is used: not what it shows. */
const NOT_THE_PICTURE = /\b(save|saved|saving|file|files|folder|name it|named|filename|specialists\/|section|page|website|site|layout|html|css|use it|will be used|to be used|hand (it )?in|deliver|resolution|suitable for|make sure|ensure|the worker|the step)\b|\.(?:png|jpe?g|webp|gif|svg|ico)\b/i;
/** The planner's instruction in front of what is drawn: "Create a high-quality photo of" leaves "photo of". */
const ASK_FRONT = /^(?:please\s+)?(?:create|generate|draw|make|produce|design|render|paint|illustrate|provide|give)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:(?:high[- ]quality|high[- ]resolution|realistic|detailed|beautiful|striking|professional)[,\s]+)*/i;
/** Brand words a picture model cannot draw ("trustworthy", "modern"): left out of the style. */
const BRAND_WORDS = /\b(trustworthy|neutral|modern|professional|friendly|clean|engaging|on-brand|corporate|welcoming|approachable|appealing|consistent|cohesive)\b/gi;

/**
 * The words a project's picture step gives the picture model: what the picture shows, from the step's brief, without
 * the planner's instructions (file names, where it is saved, the page it goes on, "Create a high-quality …"). The title
 * when nothing of the brief is left.
 */
export function picturePrompt(title: string, brief: string): string {
  const sentences = brief.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept: string[] = [];
  const style: string[] = [];
  for (const raw of sentences) {
    const s = raw.replace(/[.!?]+$/, '').trim();
    if (!s || NOT_THE_PICTURE.test(s)) continue;
    const look = /^(?:the\s+)?(?:style|look|mood|tone)\s+(?:should be|is|must be|will be)\s+(.+)$/i.exec(s);
    if (look) {
      const words = look[1].replace(BRAND_WORDS, '').replace(/\band\b/gi, ',').split(',').map(w => w.trim()).filter(Boolean);
      style.push(...words);
      continue;
    }
    kept.push(s.replace(ASK_FRONT, ''));
  }
  const text = [...kept, ...style].filter(Boolean).join(', ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').trim();
  const out = text || title.replace(/^\d+\s*[-.:]\s*/, '').trim();
  return out.slice(0, 600);
}

/**
 * The hire who draws a project's picture step: a hire with the step's own role (artist, or designer for an icon),
 * else any hire who draws, else the Images window's "Draw as" hire. Undefined: nobody on the team draws.
 */
export function stepArtist(role: string, hires: { id: string; role: string; draws: boolean }[], drawAs: string | null | undefined): string | undefined {
  const draws = hires.filter(h => h.draws);
  return (draws.find(h => h.role === role) ?? draws.find(h => h.role === 'artist') ?? draws.find(h => h.id === drawAs) ?? draws[0])?.id;
}

/** A file name written in a brief or a check, pictures included ("helicopter.jpg", "css/style.css"). */
const NAMED_FILE = /[\w./-]*\w\.(?:md|txt|html?|css|m?js|jsx|tsx?|json|csv|xml|ya?ml|py|php|sql|toml|png|jpe?g|webp|gif|svg|ico)\b/gi;
const PICTURE_FILE = /\.(?:png|jpe?g|webp|gif|svg|ico)$/i;

/**
 * A plan must not name files no step makes. A file a brief or check names that is not in the workspace, and that no
 * step lists in its files, is taken out: a picture's name becomes "the picture from step N" when a picture step comes
 * before it (its real name is said when it is handed in), and any other sentence naming such a file is left out.
 * `fixed`: the names taken out, for the plan's event.
 */
export function tieUnmadeFiles<S extends Step>(steps: S[], existing: Set<string>): { steps: S[]; fixed: string[] } {
  const made = new Set(steps.flatMap(s => s.files));
  const there = (name: string) => /^[A-Z][A-Za-z]*\.js$/.test(name) || existing.has(name) || made.has(name) || [...existing, ...made].some(p => p.endsWith(`/${name}`) || name.endsWith(`/${p}`));
  const fixed = new Set<string>();
  const out = steps.map((s, i) => {
    const picBefore = steps.slice(0, i).map((x, n) => ({ x, n })).reverse().find(({ x }) => !x.files.length && (x.role === 'artist' || x.role === 'designer'));
    const mend = (text: string) => {
      const names = (text.match(NAMED_FILE) ?? []).filter(n => !there(n));
      if (!names.length) return text;
      let t = text;
      for (const name of names) {
        fixed.add(name);
        if (PICTURE_FILE.test(name) && picBefore) t = t.split(name).join(`the picture from step ${picBefore.n + 1} (its file name is in step ${picBefore.n + 1}'s summary once it is drawn)`);
      }
      const left = (t.match(NAMED_FILE) ?? []).filter(n => !there(n));
      if (!left.length) return t;
      const kept = t.split(/(?<=[.!?])\s+/).filter(x => !left.some(n => x.includes(n)));
      return kept.join(' ').trim();
    };
    const brief = mend(s.brief) || s.title;
    return { ...s, brief, check: mend(s.check) };
  });
  return { steps: out, fixed: [...fixed] };
}
