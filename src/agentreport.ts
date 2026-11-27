// An agent run's report (B5): written by code around the model's own words, as report.md in the run's folder
// (agents/<agent>/<results folder>/<date and time>/ in the workspace, beside any files the run saved). It says what the
// run did, what changed since the last run, what it was not allowed to do (held), what the check found and what it read.
// Only the last N runs are kept (the recipe's "keep"). Reports from a linked PC are collected into this PC's workspace
// under agents/from <PC>/..., so two PCs with an agent of the same name never mix. Pure parts, tested in
// test/agentreport.test.ts.
import type { RunResult } from './agentrun.ts';
import type { Held } from './agenttools.ts';

export interface RunMeta {
  job: string;
  agentName: string;
  pc: string;
  by: string;
  started: string;
  ended: string;
  model: string;
}

const ENDED: Record<RunResult['state'], string> = {
  done: 'Done.',
  held: 'Done, with things it was not allowed to do (held, below).',
  budget: 'It used up its budget before it finished: what is left is in the report.',
  failed: 'Failed.',
  stopped: 'Stopped by you.',
};

const minutes = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));

/** The words for a held item, with how to allow it. */
export const heldWords = (h: Held): string => (h.never ? `Wanted to ${h.what}.` : `Wanted to ${h.what}.${h.tool ? ' Allow next time on the Agents page.' : ''}`);

/** report.md for one run. */
export function reportMarkdown(m: RunMeta, r: RunResult): string {
  const when = new Date(m.started);
  const head = `${m.job}: ${Number.isNaN(when.getTime()) ? m.started : when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;
  const sources = [...new Set(r.uses.filter(u => u.ok && (u.name === 'open_page' || u.name === 'read_file')).map(u => u.input))];
  const out = [
    `# ${head}`,
    '',
    `Agent: ${m.agentName} · Ran on: ${m.pc} · Model: ${m.model || 'not known'} · Started by: ${m.by}`,
    `Took ${minutes(m.started, m.ended)} min · ${r.uses.length} tool call${r.uses.length === 1 ? '' : 's'} · ${r.wordsRead.toLocaleString('en-GB')} words read`,
    '',
    `Ended: ${ENDED[r.state]}${r.state === 'budget' ? ` (${r.spent === 'words' ? 'words read' : 'minutes'})` : ''}${r.error ? ` ${r.error[0].toUpperCase()}${r.error.slice(1)}.` : ''}`,
    '',
    '## Report',
    '',
    r.report || '(No report was written.)',
  ];
  if (r.held.length) out.push('', '## Held (not done)', '', ...r.held.map(h => `- ${heldWords(h)}`));
  if (r.flagged) out.push('', `A page, file, report or calendar event held what looked like orders for an AI (${r.flagged}). It was not obeyed, and the web was stopped for the rest of the run.`);
  out.push('', '## Quotes checked', '', r.check.quotes ? `${r.check.quotes} quoted passage${r.check.quotes === 1 ? '' : 's'} looked for in what it read: ${r.check.missing.length ? `${r.check.missing.length} not found${r.check.mended ? ' even after it was asked to mend them' : ''}:` : 'all found.'}` : 'The report quotes nothing word for word, so there was nothing to look for.');
  for (const q of r.check.missing) out.push(`- "${q}" (not checked)`);
  out.push('', 'Only words in quote marks are looked for: figures and claims written without them are not checked.');
  if (sources.length) out.push('', '## Read', '', ...sources.map(s => `- ${s}`));
  if (r.saved.length) out.push('', '## Saved in this folder', '', ...r.saved.map(s => `- ${s}`));
  if (r.proposals.length) out.push('', `## Proposed for memory (waiting in ${m.agentName}'s Inbox)`, '', ...r.proposals.map(p => `- ${p.replace(/\n/g, ' ')}`));
  if (r.plan) out.push('', '## Plan', '', r.plan);
  if (r.notes.length) out.push('', '## Working notes', '', ...r.notes.map(n => `- ${n}`));
  return `${out.join('\n')}\n`;
}

/** The run folders to remove so only the newest `keep` stay (names are "YYYY-MM-DD-HHMM", sorted as dates). */
export function toPrune(runs: string[], keep: number): string[] {
  const dated = runs.filter(r => /^\d{4}-\d{2}-\d{2}-\d{4}( \d+)?$/.test(r)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return dated.slice(0, Math.max(0, dated.length - Math.max(1, keep)));
}

/** A run as Home's line says it: "Robin's price check: 2 prices changed." */
export function homeText(agentName: string, job: string, state: string, line: string): string {
  const first = agentName.split(/\s+/)[0];
  // "Price check" reads "Robin's price check"; a name that starts with a word in capitals ("SEO check") stays as it is.
  const lead = `${first}'s ${/^[A-Z][a-z]/.test(job) ? job[0].toLowerCase() + job.slice(1) : job}`;
  const said = state === 'failed' ? line.replace(/^Failed:\s*/, 'did not finish: ') : state === 'skipped' ? line : line.replace(/^Summary:\s*/i, '');
  return `${lead}: ${said.replace(/\.$/, '')}.`;
}

/**
 * Collecting from a linked PC: which of its runs are new here. `there`: its runs (id and report path); `have`: the run
 * ids already collected from that PC. Oldest first, at most `most` at a time (the rest next time).
 */
export function toCollect(there: { id: string; started: string }[], have: Set<string>, most = 20): string[] {
  return there.filter(r => !have.has(r.id)).sort((a, b) => a.started.localeCompare(b.started)).slice(0, most).map(r => r.id);
}

/** A PC's name as a folder name ("Z820 (upstairs)" -> "Z820 upstairs"). */
export const pcFolder = (name: string): string => `from ${name.replace(/[\\/:*?"<>|()]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || 'a linked PC'}`;

/** Where a report from a linked PC goes here (relative to the workspace). */
export const collectedPath = (pc: string, report: string): string => `agents/${pcFolder(pc)}/${report.replace(/^agents\//, '')}`;
