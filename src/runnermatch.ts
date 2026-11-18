// Max mode needs one llama.cpp build on the host and on every PC that lends to it (b11284 here and b12250 there failed at
// the handshake, "RPC server version mismatch", 12 Nov 2026). Each PC says which builds it can run SAFELY (its hello's
// runner.can: not a build it has no code for, not one known to crash on its card, not one its own test failed), and this
// picks one build that suits all of them, so nobody pushes runners by hand. The rules are here and tested in
// test/runnermatch.test.ts; src/jobrun/maxhost.ts asks, src/server/panes.ts says what this PC can do.
import type { Device } from './runtimes.ts';

/** One way a PC can run the chat runner: a build on a device, and whether it is unpacked there. */
export interface Option {
  /** The llama.cpp build ("b12250"). */
  build: string;
  device: Device;
  /** The pinned runner (runtimes.json id) this is. */
  pin: string;
  /** Unpacked there now (a lender: its RPC server too). Not: it could be installed. */
  have: boolean;
  /** Tried on hardware like this PC's, or passed this PC's own test. */
  tested: boolean;
}

/** A PC in the set. `options`: best first (its own Auto order); null when it did not say (an older TOMLIN). */
export interface Member {
  /** The linked PC's id (not the host's). */
  id?: string;
  name: string;
  host: boolean;
  options: Option[] | null;
  /** Why a build is not among its options, in plain words (for the line about a PC left out). */
  no?: Record<string, string>;
}

export interface Need {
  id?: string;
  name: string;
  host: boolean;
  pin: string;
  device: Device;
  build: string;
}

export interface Chosen {
  /** The build every kept PC runs; null when nothing is borrowed (no lender fits). */
  build: string | null;
  /** The lenders kept, by name (the ones that said nothing are kept too), and by id. */
  lenders: string[];
  lenderIds: string[];
  /** The lenders that cannot share a build with the rest, and why. */
  left: { name: string; why: string }[];
  /** Kept PCs that do not have the build unpacked yet: installing it is asked first, never done by itself. */
  needs: Need[];
  /** Lenders that did not say which builds they run (an older TOMLIN). */
  unknown: string[];
  /** What to tell the person, in plain words ('' when nothing needs saying). */
  line: string;
}

const num = (b: string) => Number(b.replace(/\D/g, '')) || 0;
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
const quoted = (names: string[]) => names.map(n => `"${n}"`).join(' and ');

/** The builds in a PC's options, in its own order, each once. */
export const buildsOf = (options: Option[]): string[] => [...new Set(options.map(o => o.build))];

/** The groups of `n` items by size, biggest first, each in the order given. */
function* subsets(n: number): Generator<number[]> {
  const from = (start: number, left: number): number[][] => (left === 0 ? [[]] : Array.from({ length: n - start }, (_, k) => start + k).flatMap(i => from(i + 1, left - 1).map(rest => [i, ...rest])));
  for (let size = n; size >= 0; size--) yield* from(0, size);
}

/** The best build among `candidates` for these PCs: fewest still to install, fewest untested, best average place, newest. */
function best(candidates: string[], who: Member[]): string {
  const score = (b: string) => {
    const mine = who.filter(m => m.options);
    const installs = mine.filter(m => !m.options!.some(o => o.build === b && o.have)).length;
    const untested = mine.filter(m => !m.options!.some(o => o.build === b && o.tested)).length;
    const places = mine.reduce((n, m) => n + buildsOf(m.options!).indexOf(b), 0);
    return [installs, untested, places, -num(b)];
  };
  return [...candidates].sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  })[0];
}

/**
 * The one build for a Max mode set: the host and the lenders. Builds every PC that said anything can run are the choices.
 * With none, the biggest group of lenders that does share one is kept and each lender left out is named, with why; the
 * host is never left out. A PC that did not say anything (an older TOMLIN) is not counted.
 */
export function pickBuild(members: Member[]): Chosen {
  const host = members.find(m => m.host);
  const lenders = members.filter(m => !m.host);
  const unknown = lenders.filter(m => !m.options).map(m => m.name);
  if (!host?.options?.length) return { build: null, lenders: [], lenderIds: [], left: [], needs: [], unknown, line: lenders.length ? 'This PC has no llama.cpp runner it can use safely, so nothing is borrowed.' : '' };
  // A lender that says it can run nothing safely is left out at once.
  const none = lenders.filter(m => m.options && !m.options.length);
  const sure = lenders.filter(m => m.options?.length);
  const hostBuilds = buildsOf(host.options);
  let picked: { keep: Member[]; build: string } | null = null;
  // Every size of group, the biggest first; the first group that shares a build wins (the lenders in the order given).
  for (const idx of sure.length > 10 ? [sure.map((_, i) => i)] : subsets(sure.length)) {
    const keep = idx.map(i => sure[i]);
    const common = hostBuilds.filter(b => keep.every(m => m.options!.some(o => o.build === b)));
    if (common.length && (keep.length > 0 || unknown.length > 0)) {
      picked = { keep, build: best(common, [host, ...keep]) };
      break;
    }
  }
  if (!picked) {
    const left = [...none.map(m => ({ name: m.name, why: 'it has no runner it can lend with safely' })), ...sure.map(m => ({ name: m.name, why: reason(m, hostBuilds, host) }))];
    return { build: null, lenders: [], lenderIds: [], left, needs: [], unknown, line: left.length ? `No single llama.cpp build runs safely on this PC and ${quoted(left.map(l => l.name))}, so nothing is borrowed from ${left.length === 1 ? 'it' : 'them'}. ${left.map(l => l.why).join(' ')}` : '' };
  }
  const keptNames = new Set(picked.keep.map(m => m.name));
  const shared = hostBuilds.filter(b => picked!.keep.every(k => k.options!.some(o => o.build === b)));
  const left = [...none, ...sure.filter(m => !keptNames.has(m.name))].map(m => ({ name: m.name, why: m.options!.length ? reason(m, shared, host) : `"${m.name}" has no runner it can lend with safely.` }));
  const kept = [host, ...picked.keep];
  const needs: Need[] = kept.filter(m => !m.options!.some(o => o.build === picked!.build && o.have)).map(m => {
    const o = m.options!.find(x => x.build === picked!.build)!;
    return { ...(m.id ? { id: m.id } : {}), name: m.name, host: m.host, pin: o.pin, device: o.device, build: picked!.build };
  });
  const lines: string[] = [];
  if (left.length) lines.push(`No single llama.cpp build runs safely on all of them. ${left.map(l => l.why).join(' ')} Left out: ${quoted(left.map(l => l.name))}. Using ${picked.build} on the rest.`);
  if (needs.length) lines.push(`${picked.build} is not installed on ${quoted(needs.map(n => (n.host ? `${n.name} (this PC)` : n.name)))} yet: installing it is asked first, and nothing is borrowed until it is there.`);
  if (unknown.length) lines.push(`${quoted(unknown)} did not say which llama.cpp builds ${unknown.length === 1 ? 'it runs' : 'they run'} (an older TOMLIN): update ${unknown.length === 1 ? 'it' : 'them'} so the builds can be matched.`);
  const kept2 = [...picked.keep, ...lenders.filter(m => !m.options)];
  return { build: picked.build, lenders: kept2.map(m => m.name), lenderIds: kept2.map(m => m.id ?? ''), left, needs, unknown, line: lines.join(' ') };
}

/** Why a lender cannot share a build with the others, naming it as the PC that blocks. */
function reason(m: Member, shared: string[], host: Member): string {
  const mine = buildsOf(m.options ?? []);
  const why = shared.map(b => m.no?.[b]).find(Boolean);
  return `"${m.name}" blocks it: it can only run ${list(mine)}${shared.length && why ? ` (${why})` : ''}, and ${host.name === m.name ? 'the others' : 'this PC and the PCs kept'} can run ${shared.length ? list(shared) : list(buildsOf(host.options ?? []))}.`;
}
