// An agent's standing job, a "recipe": what to do, when, with which tools, where the results go and when to stop. A
// recipe is data, never code: TOMLIN runs it with its own tools (src/agenttools.ts) and nothing in it is ever run as a
// script. It is written as short "Field: value" lines a person can read (or as the same thing in JSON), so a person can
// ask any chatbot to write one and paste it in. Reading and checking it is code: every field is checked, what could not
// be read is named, and the form shows the result before anything is kept. Pure parts, tested in test/recipe.test.ts.
//
// Example:
//   Name:        Morning price check
//   Agent:       Robin
//   Runs on:     This PC
//   When:        Every weekday at 07:00
//   Task:        Open these five product pages, note any price change since last run, write a short summary.
//   Pages:       https://example.com/a, https://example.com/b
//   Tools:       web pages, working notes, calculate
//   Results:     folder "price-check"; keep 30 runs
//   Stop after:  20 rounds, 15 minutes, 40,000 words read
//   Wait at most: 60 minutes
//   Memory:      may propose lines (Inbox)
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterMatches, cleanFolderName, cleanTrigger, parseTrigger, triggerWords, type Trigger } from './agenttriggers.ts';
import { looksSecret } from './rules.ts';
import { scanText } from './promptscan.ts';
import { normalUrl } from './webtools.ts';
import { WATCH_PAGES, watchWords } from './pagewatch.ts';

const live = createRequire(import.meta.url)('./bridge/live.js') as { isPrivateIp: (a: string) => boolean };

/** The tools an agent can be given. Each is a fixed tool TOMLIN runs itself, behind the checks of src/agenttools.ts. */
export type AgentTool = 'pages' | 'search' | 'files' | 'save' | 'notes' | 'calculate' | 'memory' | 'reports' | 'calendar';

export const AGENT_TOOLS: Array<{ id: AgentTool; name: string; what: string; words: RegExp }> = [
  { id: 'pages', name: 'Web pages', what: 'open the pages listed in the recipe, and links on pages it read this run', words: /^(web|web ?pages?|pages?|open pages?|read pages?|the pages?( above)?|open_page)$/ },
  { id: 'search', name: 'Web search', what: 'search the web, and open the pages it finds', words: /^(web ?search|search( the web)?|searching|web_search)$/ },
  { id: 'files', name: 'Read files', what: 'list and read files in the agent\'s results folder', words: /^(files?|read files?|read( the)? folder|list files?|read_file|list_files)$/ },
  { id: 'save', name: 'Save files', what: 'save files into this run\'s own folder (nothing is ever deleted or written over)', words: /^(save|save files?|write files?|save_file)$/ },
  { id: 'notes', name: 'Working notes', what: 'keep short notes for itself during the run (they go in the report)', words: /^(notes?|save notes?|working notes?|keep notes?|keep_note)$/ },
  { id: 'calculate', name: 'Calculate', what: 'work out sums and dates exactly', words: /^(calc|calculate|calculator|sums?|maths?|math)$/ },
  { id: 'memory', name: 'Propose memory', what: 'suggest up to 3 lines for its memory, which wait in its Inbox for you', words: /^(memory|propose memory|propose lines?|suggest memory|remember)$/ },
  { id: 'calendar', name: 'Calendar', what: 'read your calendar\'s events for today and up to 7 days ahead (read-only: it never adds, changes or answers anything)', words: /^(calendar|my calendar|read( my)? calendar|calendar events|events|read_calendar)$/ },
  { id: 'reports', name: 'Read reports', what: 'read the last report (from the last 24 hours) of each job named in its "Reads" line', words: /^(reports?|read reports?|other reports?|agents'? reports?|read_report)$/ },
];

/**
 * What an agent is never given, whatever a recipe says: these are code rules (there is no such tool), listed so a recipe
 * that asks for one is refused with the reason, and so the approval card can say so.
 */
export const NEVER: Array<{ name: string; words: RegExp }> = [
  { name: 'a free shell or running commands', words: /\b(shell|powershell|cmd|terminal|command line|run commands?|run_command|execute|scripts?)\b/ },
  { name: 'deleting files', words: /\b(delete|remove|erase|wipe)\b/ },
  { name: 'sending a message or an email', words: /\b(e-?mail|send|message|sms|telegram|discord|slack|whatsapp|post to)\b/ },
  { name: 'paying or buying', words: /\b(pay|payment|buy|purchase|order|checkout|card)\b/ },
  { name: 'changing settings', words: /\b(settings?|config|registry|permissions?)\b/ },
  { name: 'clicking, typing or looking at the screen', words: /\b(click|type|keyboard|mouse|screen|window)\b/ },
  { name: 'opening a page on this PC or the home network', words: /\b(localhost|home network|intranet|router)\b/ },
];

/** Hard ceilings in code, whatever a recipe asks. */
export const CEILING = { rounds: 60, minutes: 120, words: 200_000, keep: 365, waitMinutes: 24 * 60, pages: 40 };
export const DEFAULTS = { rounds: 20, minutes: 15, words: 40_000, keep: 30, waitMinutes: 60 };
export const TASK_MAX = 4000;

export interface Recipe {
  name: string;
  /** The Agent who runs it: a hire's id once checked (as typed before). */
  agent: string;
  /** Where it runs: '' for this PC (the PC that keeps the agent), or a linked PC's name. */
  runsOn: string;
  when: Trigger[];
  task: string;
  pages: string[];
  tools: AgentTool[];
  results: { folder: string; keep: number };
  stop: { rounds: number; minutes: number; words: number };
  /** Minutes a run waits for its PC to be free before it is skipped. */
  waitMinutes: number;
  /** May propose memory lines (they wait in the agent's Inbox). */
  memory: boolean;
  /** A page watch's words: a changed line must hold one of them to start a run (unset: any change). */
  watchFor?: string[];
  /** The jobs whose last reports it may read with Read reports ("Robin's price check"; unset: none). */
  reads?: string[];
}

export const EMPTY: Recipe = { name: '', agent: '', runsOn: '', when: [{ kind: 'hand' }], task: '', pages: [], tools: ['notes', 'calculate'], results: { folder: '', keep: DEFAULTS.keep }, stop: { rounds: DEFAULTS.rounds, minutes: DEFAULTS.minutes, words: DEFAULTS.words }, waitMinutes: DEFAULTS.waitMinutes, memory: false };

const FIELDS: Record<string, string> = {
  name: 'name', title: 'name', agent: 'agent', who: 'agent', 'runs on': 'runsOn', 'run on': 'runsOn', pc: 'runsOn', computer: 'runsOn',
  when: 'when', schedule: 'when', trigger: 'when', triggers: 'when', task: 'task', job: 'task', what: 'task', instructions: 'task',
  pages: 'pages', sites: 'pages', urls: 'pages', addresses: 'pages', tools: 'tools', 'must hold': 'hold', hold: 'hold',
  results: 'results', output: 'results', 'stop after': 'stop', stop: 'stop', limits: 'stop', budget: 'stop', memory: 'memory',
  'wait at most': 'wait', wait: 'wait', 'watch for': 'watchFor', reads: 'reads', 'reads reports of': 'reads',
};

/** A slug for a folder name ("Morning price check" -> "morning-price-check"). */
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';

const num = (s: string): number | null => {
  const m = /(\d[\d,]*)/.exec(s);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};

export interface Read {
  recipe: Recipe;
  /** What stops it being kept, in plain words. */
  problems: string[];
  /** What was changed or left out on the way (cut to a ceiling, a line not understood). */
  notes: string[];
}

/** The pages in a text: addresses split on commas, spaces and new lines. */
function pagesOf(text: string): string[] {
  return text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
}

/** The tools named in "web (only the pages above), save notes, calculate": ids, and the words not understood. */
export function toolsOf(text: string): { tools: AgentTool[]; unknown: string[]; never: string[] } {
  const tools: AgentTool[] = [];
  const unknown: string[] = [];
  const never: string[] = [];
  const plain = text.toLowerCase().replace(/\([^)]*\)/g, ' ');
  for (const raw of plain.split(/\s*(?:,|;|\band\b|\n|\+)\s*/)) {
    const w = raw.trim().replace(/^(may |can |to )/, '').replace(/[.]$/, '');
    if (!w) continue;
    const hit = AGENT_TOOLS.find(t => t.words.test(w));
    if (hit) {
      if (!tools.includes(hit.id)) tools.push(hit.id);
      continue;
    }
    const bad = NEVER.find(n => n.words.test(w));
    if (bad) never.push(`${w} (${bad.name})`);
    else unknown.push(w);
  }
  return { tools, unknown, never };
}

/**
 * A recipe from pasted text (Field: value lines; a line without a known field carries on the field above it) or JSON.
 * Never throws: what could not be read is in `problems` or `notes`.
 */
export function readRecipe(input: string): Read {
  const text = String(input ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (text.startsWith('{')) {
    try {
      return cleanRecipe(JSON.parse(text));
    } catch {
      return { recipe: { ...EMPTY }, problems: ['It starts like JSON but is not valid JSON. Paste it again, or write it as Field: value lines.'], notes: [] };
    }
  }
  const got: Record<string, string> = {};
  const notes: string[] = [];
  let field = '';
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z][A-Za-z ]{0,20}?)\s*:\s*(.*)$/.exec(line);
    const key = m ? FIELDS[m[1].trim().toLowerCase()] : undefined;
    if (m && key) {
      field = key;
      got[field] = got[field] ? `${got[field]}\n${m[2]}` : m[2];
    } else if (field && line.trim()) {
      got[field] += `\n${line.trim()}`;
    } else if (line.trim() && !/^```/.test(line.trim())) {
      notes.push(`Not read: "${line.trim().slice(0, 80)}"`);
    }
  }
  const raw: Record<string, unknown> = {
    name: got.name, agent: got.agent, runsOn: got.runsOn, task: got.task,
    when: got.when ? got.when.split(/\n|;/).map(s => s.trim()).filter(Boolean) : undefined,
    pages: got.pages ? pagesOf(got.pages) : undefined,
    tools: got.tools,
    memory: got.memory,
    ...(got.watchFor !== undefined ? { watchFor: got.watchFor } : {}),
    ...(got.reads !== undefined ? { reads: got.reads } : {}),
  };
  if (got.results) {
    const folder = /folder\s+["“]?([^"”;,\n]+?)["”]?(?:[;,\n]|\s+in\b|$)/i.exec(got.results)?.[1] ?? /^["“]?([^"”;,\n]+?)["”]?(?:[;,\n]|$)/.exec(got.results.trim())?.[1];
    const keep = /keep\s+(?:the\s+)?(?:last\s+)?(\d[\d,]*)/i.exec(got.results)?.[1];
    raw.results = { folder: folder?.replace(/^folder\s+/i, '').trim() ?? '', keep: keep ? Number(keep.replace(/,/g, '')) : undefined };
  }
  if (got.stop) {
    const s = got.stop;
    raw.stop = {
      rounds: num(/(\d[\d,]*)\s*rounds?/i.exec(s)?.[0] ?? ''),
      minutes: (() => { const m = /(\d[\d,]*)\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(s); return m ? Number(m[1].replace(/,/g, '')) * (/^h/i.test(m[2]) ? 60 : 1) : null; })(),
      words: num(/(\d[\d,]*)\s*(?:words?|k words?)/i.exec(s)?.[0] ?? ''),
    };
  }
  if (got.wait) {
    const m = /(\d[\d,]*)\s*(minutes?|mins?|hours?|hrs?)?/i.exec(got.wait);
    raw.waitMinutes = m ? Number(m[1].replace(/,/g, '')) * (m[2] && /^h/i.test(m[2]) ? 60 : 1) : undefined;
  }
  if (got.hold) notes.push('"Must hold" is how TOMLIN works anyway: anything outside the tools listed is held, never asked.');
  const r = cleanRecipe(raw);
  return { ...r, notes: [...notes, ...r.notes] };
}

/** A recipe as given (JSON, the form, or read from text), checked field by field. Never throws. */
export function cleanRecipe(raw: unknown): Read {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const notes: string[] = [];
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '');
  const name = str(o.name, 80).replace(/\s+/g, ' ');
  if (!name) problems.push('Give the job a name.');
  const agent = str(o.agent, 60);
  if (!agent) problems.push('Name the Agent who runs it.');
  const runsOn = str(o.runsOn, 80).replace(/^(this pc|here|the agent'?s pc|the agents pc|its own pc|local)$/i, '').replace(/\s*\(.*\)$/, '');
  // When: words or triggers.
  const when: Trigger[] = [];
  for (const w of Array.isArray(o.when) ? o.when : typeof o.when === 'string' ? o.when.split(/\n|;/) : []) {
    if (typeof w === 'string') {
      if (!w.trim()) continue;
      const t = parseTrigger(w);
      if ('error' in t) problems.push(t.error);
      else when.push(t);
    } else {
      const t = cleanTrigger(w);
      if (t) when.push(t);
      else problems.push('A "When" was not one TOMLIN can read.');
    }
  }
  if (!when.length) {
    when.push({ kind: 'hand' });
    if (o.when !== undefined) notes.push('No "When" could be read: it runs only when you press Run now.');
  }
  if (when.length > 6) {
    problems.push('At most 6 "When" lines for one job.');
    when.length = 6;
  }
  const task = typeof o.task === 'string' ? o.task.replace(/\r/g, '').trim() : '';
  if (!task) problems.push('Write the task: what the agent should do each run.');
  if (task.length > TASK_MAX) problems.push(`The task is ${task.length.toLocaleString('en-GB')} characters: ${TASK_MAX.toLocaleString('en-GB')} is the most. Shorten it, or keep the long part in the agent's memory.`);
  // Pages: web addresses only, never this PC or the home network (as the web tools refuse them).
  const pages: string[] = [];
  for (const p of (Array.isArray(o.pages) ? o.pages : typeof o.pages === 'string' ? pagesOf(o.pages) : []).filter((x): x is string => typeof x === 'string')) {
    const why = pageWhy(p);
    if (why) problems.push(why);
    else {
      const n = normalUrl(/^https?:\/\//i.test(p) ? p : `https://${p}`)!;
      if (!pages.includes(n)) pages.push(n);
    }
  }
  if (pages.length > CEILING.pages) problems.push(`${pages.length} pages listed: ${CEILING.pages} is the most for one job.`);
  // Tools: ids, or words.
  let tools: AgentTool[] = [];
  if (Array.isArray(o.tools) && o.tools.every(t => typeof t === 'string' && AGENT_TOOLS.some(a => a.id === t))) tools = [...new Set(o.tools as AgentTool[])];
  else {
    const words = Array.isArray(o.tools) ? o.tools.filter(t => typeof t === 'string').join(', ') : typeof o.tools === 'string' ? o.tools : '';
    if (o.tools === undefined) tools = [...EMPTY.tools];
    else {
      const t = toolsOf(words);
      tools = t.tools;
      for (const n of t.never) problems.push(`Never given to an agent: ${n}. Take it out of Tools.`);
      for (const u of t.unknown) problems.push(`"${u}" is not a tool TOMLIN has for agents. The tools are: ${AGENT_TOOLS.map(a => a.name.toLowerCase()).join(', ')}.`);
    }
  }
  const watching = when.some(t => t.kind === 'page');
  if (watching && !pages.length) problems.push('"When a page changes" watches the recipe\'s Pages: list the pages to watch (at most 5).');
  if (watching && pages.length > WATCH_PAGES) problems.push(`A page watch looks at ${WATCH_PAGES} pages at most: ${pages.length} are listed.`);
  const watchFor = watchWords(o.watchFor);
  if (watchFor.length && !watching) notes.push('"Watch for" is only used with "When a page changes": it does nothing here.');
  const readsRaw = Array.isArray(o.reads) ? o.reads.filter((x): x is string => typeof x === 'string') : typeof o.reads === 'string' ? o.reads.split(/[,;\n]/) : [];
  const reads = [...new Set(readsRaw.map(x => x.trim().replace(/\s+/g, ' ').slice(0, 80)).filter(Boolean))].slice(0, 10);
  if (reads.length && !tools.includes('reports')) problems.push('"Reads" names jobs, but the agent has no "read reports" tool: add it to Tools, or take Reads out.');
  if (tools.includes('reports') && !reads.length) problems.push('"Read reports" is on, but no job is named: write the jobs in "Reads", such as Reads: Robin\'s price check, Website check.');
  if (pages.length && !tools.includes('pages') && !tools.includes('search')) problems.push('Pages are listed but the agent has no web tool: add "web pages" to Tools, or take the pages out.');
  if (tools.includes('pages') && !pages.length && !tools.includes('search')) notes.push('"Web pages" is on, but no pages are listed: it can only open pages given in its task.');
  // Memory: a yes in words or true.
  const mem = o.memory;
  const memory = mem === true || (typeof mem === 'string' && /\b(yes|may|can|propose|suggest|inbox|on)\b/i.test(mem) && !/\b(no|never|off|not)\b/i.test(mem));
  if (memory && !tools.includes('memory')) tools.push('memory');
  if (!memory && tools.includes('memory')) tools = tools.filter(t => t !== 'memory');
  // Results, stop and wait, kept within the ceilings.
  const r = (o.results && typeof o.results === 'object' ? o.results : {}) as Record<string, unknown>;
  const folder = cleanFolderName(typeof r.folder === 'string' ? r.folder : '') || (name ? slug(name) : '');
  if (typeof r.folder === 'string' && r.folder.trim() && !cleanFolderName(r.folder)) problems.push(`"${r.folder}" cannot be a folder name: plain words, no \\ / : * ? " < > |.`);
  const within = (v: unknown, lo: number, hi: number, d: number, what: string) => {
    if (v === undefined || v === null || v === '') return d;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < lo) {
      notes.push(`${what}: ${String(v)} is not a number TOMLIN can use, so ${d.toLocaleString('en-GB')}.`);
      return d;
    }
    if (n > hi) {
      notes.push(`${what}: cut to ${hi.toLocaleString('en-GB')}, the most.`);
      return hi;
    }
    return n;
  };
  const keep = within(r.keep, 1, CEILING.keep, DEFAULTS.keep, 'Runs kept');
  const s = (o.stop && typeof o.stop === 'object' ? o.stop : {}) as Record<string, unknown>;
  const stop = { rounds: within(s.rounds, 1, CEILING.rounds, DEFAULTS.rounds, 'Rounds'), minutes: within(s.minutes, 1, CEILING.minutes, DEFAULTS.minutes, 'Minutes'), words: within(s.words, 100, CEILING.words, DEFAULTS.words, 'Words read') };
  const waitMinutes = within(o.waitMinutes, 0, CEILING.waitMinutes, DEFAULTS.waitMinutes, 'Wait at most');
  // The task is sent to a model on every run: a key in it is refused (as a save is), and orders for an AI are warned of.
  if (looksSecret(task)) problems.push('The task looks like it holds a password, key or token. Take it out: an agent never handles those.');
  return { recipe: { name, agent, runsOn, when, task, pages, tools, results: { folder, keep }, stop, waitMinutes, memory, ...(watchFor.length ? { watchFor } : {}), ...(reads.length ? { reads } : {}) }, problems, notes };
}

/** Why a page cannot be in a recipe ('' when it can): not a web address, or this PC or the home network. */
export function pageWhy(raw: string): string {
  const t = raw.trim();
  const n = normalUrl(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  if (!n || /^[a-z]+:/i.test(t) && !/^https?:/i.test(t)) return `"${t.slice(0, 80)}" is not a web address.`;
  const host = new URL(n).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.internal') || host.endsWith('.home.arpa') || !host.includes('.') && !host.includes(':');
  if (local || ((/^[\d.]+$/.test(host) || host.includes(':')) && live.isPrivateIp(host))) return `${host} is this PC or the home network: an agent never opens those.`;
  return '';
}

/**
 * Other people's checks, once the hires and PCs are known: the agent must be a hire with the Agent role, and the PC one
 * that is linked. `agents`: hires with the Agent role.
 */
export function checkAgainst(r: Recipe, o: { agents: { id: string; name: string }[]; pcs: string[]; jobs?: { name: string; agentName: string }[] }): { recipe: Recipe; problems: string[] } {
  const problems: string[] = [];
  // Reads: each must name a standing job on this PC (or one whose reports are collected here), never itself.
  if (o.jobs) for (const n of r.reads ?? []) {
    const hits = o.jobs.filter(j => afterMatches(n, j));
    if (!hits.length) problems.push(`"${n}" in Reads is not a standing job here${o.jobs.length ? ` (the jobs are: ${[...new Set(o.jobs.map(j => j.name))].slice(0, 8).join(', ')})` : ''}.`);
    else if (hits.every(j => j.name === r.name)) problems.push(`"${n}" in Reads is this job itself.`);
  }
  const want = r.agent.trim().toLowerCase();
  const a = o.agents.find(x => x.id === r.agent) ?? o.agents.find(x => x.name.toLowerCase() === want) ?? o.agents.find(x => x.name.toLowerCase().split(/\s+/)[0] === want);
  if (!a) problems.push(o.agents.length ? `"${r.agent}" is not one of your Agents (${o.agents.map(x => x.name).join(', ')}). Hire an Agent in Hire staff, or name one of them.` : 'You have no Agent yet: hire one in Hire staff (role Agent), then name them here.');
  const pc = r.runsOn ? o.pcs.find(p => p.toLowerCase() === r.runsOn.toLowerCase()) : '';
  if (r.runsOn && pc === undefined) problems.push(`"${r.runsOn}" is not a linked PC. Leave "Runs on" as This PC, or name a linked PC.`);
  return { recipe: { ...r, agent: a?.id ?? r.agent, runsOn: pc ?? r.runsOn }, problems };
}

/** The prompt-scan's warning for a task that reads like orders for an AI (a recipe copied from the internet), or ''. */
export function taskWarning(task: string): string {
  const s = scanText(task, { long: false });
  return s.suspect ? `The task holds what looks like orders for an AI (${s.reasons.slice(0, 2).join('; ')}). Read it before you approve it: a recipe copied from the internet may try to make the agent do something you did not mean.` : '';
}

/** The recipe as text, in the order and words a person writes it (Copy recipe). `agentName`: the hire's name for the id. */
export function recipeText(r: Recipe, agentName = r.agent): string {
  const toolNames = r.tools.filter(t => t !== 'memory').map(t => AGENT_TOOLS.find(a => a.id === t)!.name.toLowerCase());
  const lines = [
    ['Name', r.name],
    ['Agent', agentName],
    ['Runs on', r.runsOn || 'This PC'],
    ['When', r.when.map(triggerWords).join('; ')],
    ['Task', r.task.replace(/\n/g, '\n  ')],
    ...(r.pages.length ? [['Pages', r.pages.join(', ')]] : []),
    ...(r.watchFor?.length ? [['Watch for', r.watchFor.join(', ')]] : []),
    ...(r.reads?.length ? [['Reads', r.reads.join(', ')]] : []),
    ['Tools', toolNames.join(', ') || 'none'],
    ['Results', `folder "${r.results.folder}"; keep ${r.results.keep} runs`],
    ['Stop after', `${r.stop.rounds} rounds, ${r.stop.minutes} minutes, ${r.stop.words.toLocaleString('en-GB')} words read`],
    ['Wait at most', `${r.waitMinutes} minutes`],
    ['Memory', r.memory ? 'may propose lines (Inbox)' : 'no'],
  ];
  return lines.map(([k, v]) => `${`${k}:`.padEnd(14)}${v}`).join('\n');
}

/**
 * The recipe's fingerprint: approval is for this exact recipe. A recipe changed after it was approved (here, by hand
 * in the file, or over the link) needs approving again before it runs.
 */
export function recipeHash(r: Recipe): string {
  const plain = { ...r, tools: [...r.tools].sort(), pages: [...r.pages].sort() };
  return createHash('sha256').update(JSON.stringify(plain)).digest('hex').slice(0, 16);
}

/** What the approval card lists: every tool the recipe gives, with what it lets the agent do, and the Never list. */
export function approvalLines(r: Recipe): { tools: string[]; never: string[]; pages: string[]; leak?: string } {
  // Its memory is sent to every run, so web search alone can be led to search for it; read files adds the files.
  const files = r.tools.includes('files');
  return {
    tools: r.tools.map(t => { const a = AGENT_TOOLS.find(x => x.id === t)!; return `${a.name}: ${a.what}`; }),
    never: NEVER.map(n => n.name),
    pages: r.pages,
    ...(r.tools.includes('search') ? { leak: `This agent can search the web${files ? ' and read your files' : ''}, and it is sent its memory. A web page could try to make it search for what is in ${files ? 'your files or its memory' : 'its memory'}: TOMLIN holds a search that repeats them, but give it web search only if it needs it.` } : {}),
  };
}

/** What a person gives Claude (or another chatbot) so it writes a recipe TOMLIN can read. */
export const CHATBOT_PROMPT = [
  'Write me a TOMLIN agent recipe. TOMLIN is an app on my PC that runs a staff member called an Agent on a timer. A recipe is plain text, one "Field: value" per line, exactly these fields:',
  'Name: a short name for the job',
  'Agent: the name of my Agent (I will fill it in if you do not know it)',
  'Runs on: This PC',
  'When: one or more of: Every day at 07:00; Every weekday at 07:00; Every Monday and Thursday at 09:00; Every 6 hours; Once on 2026-12-01 at 08:00; When a file lands in inbox; When a page changes (every 2 hours); After <another job name>; By hand (separate several with ;)',
  'Task: what to do each run, in plain sentences (several lines are fine; at most 4,000 characters)',
  'Pages: the web addresses it may open, separated by commas (public sites only; at most 5 for "When a page changes", which are the pages watched)',
  'Watch for: (only with "When a page changes", and optional) words a changed line must hold to count, separated by commas, such as: price, in stock',
  `Tools: any of: ${AGENT_TOOLS.filter(t => t.id !== 'memory').map(t => t.name.toLowerCase()).join(', ')}. Nothing else exists: no shell, no deleting, no sending messages or email, no paying, no settings, no screen.`,
  'Reads: (only with the "read reports" tool, and optional) the names of my other agent jobs whose last report it reads, separated by commas',
  'Results: folder "<a folder name>"; keep <number> runs',
  'Stop after: <rounds> rounds, <minutes> minutes, <number> words read (at most 60 rounds and 120 minutes)',
  'Wait at most: <minutes> minutes (how long it may wait for the PC to be free)',
  'Memory: may propose lines (Inbox), or no',
  'Give only the recipe, in a code block, and nothing in it that is a password or a key.',
  'What I want it to do:',
].join('\n');

/** Starter recipes (the Agents page's library): each opens as a filled form to change. Pages are examples to replace. */
export const STARTERS: Array<{ id: string; name: string; about: string; text: string }> = [
  {
    id: 'mybrief', name: 'Morning brief', about: 'One page each weekday morning from your other agents\' reports: what changed, what needs you today, what failed.',
    text: ['Name: Morning brief', 'Agent: ', 'When: Every weekday at 07:00', 'Task: Read the last report of each job named in Reads, and today\'s events in my calendar if one is set. Write one short page in three parts: what changed since yesterday, what needs me today, and which jobs failed or had no report. Name the job for each line. If nothing changed and nothing failed, say so in one line.', 'Reads: ', 'Tools: read reports, calendar, working notes', 'Results: folder "morning-brief"; keep 30 runs', 'Stop after: 15 rounds, 10 minutes, 40,000 words read', 'Memory: no'].join('\n'),
  },
  {
    id: 'brief', name: 'News brief', about: 'News on topics you name, from sites you name, in five lines.',
    text: ['Name: News brief', 'Agent: ', 'When: Every weekday at 07:00', 'Task: Read the front pages listed below. Pick the five stories that matter most for these topics: (write your topics here). Write each as one line with its page address. Say which pages did not open.', 'Pages: https://www.abc.net.au/news, https://www.bbc.com/news', 'Tools: web pages, working notes', 'Results: folder "news-brief"; keep 30 runs', 'Stop after: 15 rounds, 10 minutes, 30,000 words read', 'Memory: no'].join('\n'),
  },
  {
    id: 'prices', name: 'Price or stock watch', about: 'Notes any price or stock change on pages you name since the last run.',
    text: ['Name: Price watch', 'Agent: ', 'When: Every day at 08:00', 'Task: Open each page below and note the product\'s name, its price and whether it is in stock. Compare with the last run\'s report and list only what changed. Use calculate for any difference in price. If nothing changed, say so in one line.', 'Pages: https://example.com/product-a, https://example.com/product-b', 'Tools: web pages, working notes, calculate', 'Results: folder "price-watch"; keep 60 runs', 'Stop after: 20 rounds, 15 minutes, 40,000 words read', 'Memory: may propose lines (Inbox)'].join('\n'),
  },
  {
    id: 'folder', name: 'Folder report', about: 'What files came into a folder this week, with a short summary of each.',
    text: ['Name: Folder report', 'Agent: ', 'When: Every Friday at 16:00; When a file lands in inbox', 'Task: List the files in the inbox folder that are new since the last run\'s report. Read each one and write two lines about it: what it is and anything that needs me. Say which files could not be read.', 'Tools: read files, working notes', 'Results: folder "folder-report"; keep 20 runs', 'Stop after: 30 rounds, 20 minutes, 80,000 words read', 'Memory: no'].join('\n'),
  },
  {
    id: 'site', name: 'Website check', about: 'Your own site: pages that do not open and what changed since last time.',
    text: ['Name: Website check', 'Agent: ', 'When: Every Monday at 06:00', 'Task: Open my site\'s home page below and the pages it links to on the same site (at most 15). List any page that did not open, any link that goes nowhere, and any page whose words changed since the last run\'s report. Do not follow links to other sites.', 'Pages: https://example.com/', 'Tools: web pages, working notes', 'Results: folder "website-check"; keep 12 runs', 'Stop after: 30 rounds, 20 minutes, 60,000 words read', 'Memory: may propose lines (Inbox)'].join('\n'),
  },
  {
    id: 'status', name: 'Weekly project status', about: 'What came into a project\'s folder this week, as a short status note.',
    text: ['Name: Weekly project status', 'Agent: ', 'When: Every Friday at 17:00', 'Task: Read the files in the status folder (copies of this week\'s notes and reports). Write a status note: what was done, what is waiting, and what looks stuck. Keep it under 200 words and name the files you read.', 'Tools: read files, working notes', 'Results: folder "status"; keep 26 runs', 'Stop after: 25 rounds, 15 minutes, 60,000 words read', 'Memory: no'].join('\n'),
  },
];
