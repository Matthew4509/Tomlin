// The newer tools of one answer, put together: the screen tools (src/screentools.ts), the laptop helper's
// (src/machinetools.ts), the coding tools (src/codetools.ts) and the research notes (src/notetools.ts), each behind
// its own permission tier (src/permits.ts). This is where "which tools is this chat offered" and "when is the person
// asked" are decided, in one place, with everything from outside handed in, so it is tested in
// test/toolkit.test.ts without a screen, a laptop or a server.
// - A kind at Never is not offered at all. Nor is a kind with nowhere to work: no window on the list, no helper
//   linked, a folder not on the coding list, the research role off. So a PC where nothing was set up is offered
//   exactly the tools it had before.
// - Look only asks once an answer; Ask each time asks for every call; Allowed does not ask. The guards inside each
//   tool apply after the yes, whatever the tier.
import type { ToolDef } from './webtools.ts';
import { deniedWords, tierOf, type CardExtra, type Gate, type Permissions } from './permits.ts';
import { INPUT_LINE, SCREEN_LINE, SCREEN_ROUNDS, ScreenTurn, isScreenTool, parsePattern, screenCallWords, screenDefs, screenKind, timingLine, type ScreenBackend } from './screentools.ts';
import { MACHINE_LINE, isHelperTool, machineCallWords, type HelperLink } from './camhelper.ts';
import { MachineTurn } from './machinetools.ts';
import { CODE_LINE, CodeTurn, RUN_LINE, codeCallWords, codingFolder, isCodeTool, type Exec } from './codetools.ts';
import { NOTES_LINE, NOTE_TOOLS, NoteTurn, isNoteTool, noteCallWords, type Finding, type Source } from './notetools.ts';
import { RESEARCH_LINE, ResearchTurn, foldToolTurns, isResearchTool, researchCallWords, researchDefs, researchFree, researchReadsFile, type PageSeen } from './researchtools.ts';
import type { Action } from './actionlog.ts';

export interface KitOpts {
  perms: Permissions;
  gate: Gate;
  /** Characters one call may give the model. */
  perCall: number;
  /** 'win32' for the screen tools. */
  platform: string;
  /** The Windows side of the screen tools. None: no screen tools. */
  screen?: ScreenBackend;
  locked?: () => boolean;
  /** The helpers linked to this PC, and this PC's id on those links. */
  helpers?: HelperLink[];
  me?: string;
  /** The chat's folder (the file tools' folder), when it has one. */
  root?: string | null;
  /** Files a model saved in folders across answers (src/modelsaved.ts): a run asks while its folder holds any. */
  since?: { pending(folder: string): string[]; clear(folder: string): void };
  /** TOMLIN's own data folder: never a coding folder. */
  dataDir?: string;
  /** Web is on in this chat: the research notes go with it. */
  web?: boolean;
  /** The pages this answer has opened so far. */
  sources?: () => Source[];
  /** A page this answer opened, by its address: the research tools look in its text. */
  page?: (url: string) => PageSeen | null;
  /** A second model's reading of a draft against the kept quotes; null when there is none to ask. */
  second?: (system: string, user: string, signal?: AbortSignal) => Promise<{ text: string; by: string } | null>;
  /** With no node free, the subagent's check may be queued to run on this PC after the answer (Kit.after). */
  canQueue?: boolean;
  log?: (a: Action) => void;
  /** The files this answer saved in the chat's folder (src/filetools.ts FileTurn.saved): a run after one is asked. */
  saved?: () => string[];
  exec?: Exec;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** The words on the Subagent card, after "<who> asks:". */
export const SUBAGENT_ASK = 'allow a subagent? This will run on an available node, and/or queue and run on this node after the first agent is completed';

export interface KitUse { name: string; input: string; ok: boolean; said: string; ms?: number; captureMs?: number; ocrMs?: number }

export interface Kit {
  defs: ToolDef[];
  /** Lines for the system turn. */
  lines: string[];
  rounds: number;
  has(name: string): boolean;
  run(name: string, args: string, signal?: AbortSignal): Promise<string>;
  words(name: string, args: string): string;
  uses(): KitUse[];
  /** The screen steps' times, for the line under the answer. */
  note(): string;
  findings(): Finding[];
  saved(): string[];
  /** A long answer's tool turns made smaller, the working notes handed back (src/researchtools.ts). None: left as they are. */
  fold?(turns: Record<string, unknown>[]): Record<string, unknown>[];
  /** A subagent's check queued for the finished answer (no node was free): what to ask this PC's model, once. Else null. */
  after?(final: string): { system: string; user: string } | null;
}

/** Why a run at Allowed is still asked on a card ('' when it is not): text that looked like orders, or files saved this answer. */
export function runAskWhy(held: string, saved: string[]): string {
  const n = new Set(saved).size;
  return [held ? 'this answer read text that looked like orders for an AI' : '', n ? `this answer saved ${n} file${n === 1 ? '' : 's'} in the folder, which the command may run` : ''].filter(Boolean).join('; ');
}

/** The kit for one answer, or null when this chat is offered none of the newer tools. */
export function makeKit(o: KitOpts): Kit | null {
  const p = o.perms;
  const tier = { screen: tierOf(p, 'screen'), machine: tierOf(p, 'machine'), git: tierOf(p, 'git'), notes: tierOf(p, 'notes'), focus: tierOf(p, 'focus'), input: tierOf(p, 'input'), run: tierOf(p, 'run'), subagent: tierOf(p, 'subagent') };
  const confirm = (kind: 'focus' | 'input' | 'run') => (what: string, extra?: CardExtra) => o.gate.each(kind, what, extra);

  const screen = o.platform === 'win32' && o.screen && tier.screen !== 'never' && p.windows.some(w => parsePattern(w))
    ? new ScreenTurn({ windows: p.windows, backend: o.screen, perCall: o.perCall, focus: tier.focus, input: tier.input, confirm: (kind, what, extra) => confirm(kind)(what, extra), locked: o.locked, log: o.log })
    : null;
  const helper = tier.machine !== 'never' ? (o.helpers ?? []).find(h => h.tools.length) : undefined;
  const machine = helper && o.me ? new MachineTurn({ helper, me: o.me, perCall: o.perCall, get: o.fetch }) : null;
  const code = p.coding && o.root && tier.git !== 'never' && codingFolder(o.root, p.folders, o.dataDir)
    ? new CodeTurn({ root: o.root, perCall: o.perCall, run: tier.run, extra: p.commands, confirm: confirm('run'), mustAsk: () => runAskWhy(o.gate.held, o.saved?.() ?? []), since: o.since, exec: o.exec, log: o.log })
    : null;
  const notes = p.research && o.web && o.root && tier.notes !== 'never' ? new NoteTurn({ root: o.root, sources: o.sources ?? (() => []) }) : null;
  // The research tools go with the research role: with Web on (pages to look in) or a folder (files to read).
  const research = p.research && (o.web || o.root) && tier.notes !== 'never' ? new ResearchTurn({ root: o.root ?? null, perCall: o.perCall, page: o.page, ...(tier.subagent !== 'never' ? { second: o.second, canQueue: o.canQueue === true, allowSecond: () => o.gate.byTier(tier.subagent, 'subagent', SUBAGENT_ASK) } : {}) }) : null;
  if (!screen && !machine && !code && !notes && !research) return null;

  const defs = [
    ...(screen ? screenDefs({ focus: tier.focus !== 'never', input: tier.input !== 'never' }) : []),
    ...(machine ? machine.defs : []),
    ...(code ? code.defs : []),
    ...(notes ? NOTE_TOOLS : []),
    ...(research ? researchDefs({ folder: !!o.root }) : []),
  ];
  const names = new Set(defs.map(d => d.function.name));
  const lines = [
    ...(screen ? [SCREEN_LINE, ...(tier.input !== 'never' ? [INPUT_LINE] : [])] : []),
    ...(machine ? [MACHINE_LINE] : []),
    ...(code ? [CODE_LINE, ...(tier.run !== 'never' ? [RUN_LINE] : [])] : []),
    ...(notes ? [NOTES_LINE] : []),
    ...(research ? [RESEARCH_LINE] : []),
  ];
  const words = (name: string, args: string) => (isScreenTool(name) ? screenCallWords(name, args) : isHelperTool(name) ? machineCallWords(name) : isCodeTool(name) ? codeCallWords(name, args) : isResearchTool(name) ? researchCallWords(name, args) : noteCallWords(name));
  const plain = (name: string, args: string) => words(name, args).replace(/…$/, '');

  return {
    defs,
    lines,
    rounds: SCREEN_ROUNDS,
    has: name => names.has(name),
    words,
    async run(name, args, signal) {
      if (!names.has(name)) return `There is no tool called "${name}".`;
      if (o.locked?.()) return 'Not done: TOMLIN is locked. Nothing is looked at, read or run while it is locked.';
      if (screen && isScreenTool(name)) {
        // The two that read are asked by the screen's tier; the three that act ask for themselves, every time.
        if (screenKind(name) === 'screen' && !(await o.gate.byTier(tier.screen, 'screen', plain(name, args)))) return deniedWords('screen');
        return screen.run(name, args);
      }
      if (machine && isHelperTool(name)) {
        if (!(await o.gate.byTier(tier.machine, 'machine', `read the laptop helper (${name})`))) return deniedWords('machine');
        return machine.run(name, args, signal);
      }
      if (code && isCodeTool(name)) {
        if (name === 'git_read' && !(await o.gate.byTier(tier.git, 'git', plain(name, args)))) return deniedWords('git');
        return code.run(name, args);
      }
      if (notes && isNoteTool(name)) {
        if (!(await o.gate.byTier(tier.notes, 'notes', name === 'save_note' ? 'save a research note in the chat\'s folder' : 'suggest a finding for you to save'))) return deniedWords('notes');
        return notes.run(name, args);
      }
      if (research && isResearchTool(name)) {
        // Reading a file in the folder is asked as Files is; keeping a note or a quote, and looking in a page, by the
        // notes' tier; a sum, and reading back what this answer kept, need no card.
        if (researchReadsFile(name, args) && !(await o.gate.permitted('files', plain(name, args)))) return deniedWords('files');
        if (!researchFree(name) && !(await o.gate.byTier(tier.notes, 'notes', name === 'keep_quote' ? 'keep a checked quote in the chat\'s folder' : name === 'keep_note' ? 'keep working notes in the chat\'s folder' : plain(name, args)))) return deniedWords('notes');
        return research.run(name, args, signal);
      }
      return `There is no tool called "${name}".`;
    },
    uses: () => [...[...(screen?.uses ?? []), ...(machine?.uses ?? []), ...(code?.uses ?? []), ...(notes?.uses ?? [])].map(u => ({ name: u.name, input: u.input, ok: u.ok, said: u.said, ...('ms' in u ? { ms: u.ms } : {}), ...('captureMs' in u && u.captureMs !== undefined ? { captureMs: u.captureMs, ocrMs: u.ocrMs } : {}) })), ...(research?.uses ?? [])],
    note: () => timingLine(screen?.uses ?? []),
    findings: () => notes?.findings ?? [],
    saved: () => [...(notes?.saved ?? []), ...(research?.saved ?? [])],
    ...(research ? { fold: (turns: Record<string, unknown>[]) => foldToolTurns(turns, research.notesBlock()), after: (final: string) => research.afterAnswer(final) } : {}),
  };
}
