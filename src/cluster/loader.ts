// The cluster with this PC left out (the "This PC takes part" switch off): this PC only connects to the cluster and sends
// the chat, as text, the way it sends a chat to a staff member on a linked PC. One member, the loader, starts the model
// from its own disk and borrows the other members' cards and RAM itself (its own Max mode, src/jobrun/maxhost.ts, run
// there). For that the loader needs links of its own to the other members: made on the loader, with each member's setup
// code, as any PC links another. TOMLIN cannot make those links from this PC yet (that is the introduction in
// docs/PLAN-2026-11-17-NODE-TO-NODE.md, section 3), so this file only checks for them and says plainly what is missing.
// Pure: tested in test/clusterloader.test.ts; src/jobrun/linking.ts and src/jobrun.ts use it.
// Why and what it costs: docs/PLAN-2026-11-18-HOST-CONNECTS-TO-CLUSTER.md.

/** What a member says about the cluster in its hello (admin links only; a guest is told nothing). */
export interface ClusterHello {
  /** The linked PCs (their own ids) it would borrow from now for a model too big for it, as it sees them. */
  borrows: string[];
  /** The name of its network adapter that this PC's request came in on ("Ethernet", "Wi-Fi"), '' when not known. */
  via: string;
}

/** A hello's cluster part read back: null when it sent none (a TOMLIN from before this) or it is not in the expected form. */
export function cleanClusterHello(raw: unknown): ClusterHello | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { borrows?: unknown; via?: unknown };
  if (!Array.isArray(o.borrows)) return null;
  const borrows = [...new Set(o.borrows.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{8}$/.test(x)))].slice(0, 64);
  const via = typeof o.via === 'string' ? o.via.replace(/[^\w .()#-]/g, '').trim().slice(0, 60) : '';
  return { borrows, via };
}

/** How a member reaches the network, read from its adapter's name: Windows calls a wireless one "Wi-Fi" or "Wireless". */
export function wireOf(via: string): 'wired' | 'wifi' | 'unknown' {
  if (/wi-?fi|wireless|wlan|802\.11/i.test(via)) return 'wifi';
  if (/ethernet|\blan\b|gigabit|gbe/i.test(via)) return 'wired';
  return 'unknown';
}

/** A member as the loader choice sees it (from this PC's link to it and its last hello). */
export interface LoaderFacts {
  /** Its id (the PC's own id, the same one every PC that links it knows it by). */
  id: string;
  name: string;
  /** It answered its last hello. */
  answering: boolean;
  /** Someone at it pressed "I need to use the pc". */
  away: boolean;
  /** This PC is only a guest there (a pass): no cluster. */
  guest: boolean;
  /** Set to Backups only here. */
  backupsOnly: boolean;
  /** Its card memory and RAM in all (bytes; 0 when not known). */
  card: number;
  ram: number;
  /** What its hello said about the cluster; null from a TOMLIN that does not say. */
  cluster: ClusterHello | null;
}

/** Strongest first: the most card memory, then the most RAM; a wired PC before one whose network is not known. */
export function strongestFirst<T extends Pick<LoaderFacts, 'card' | 'ram'> & { cluster?: ClusterHello | null }>(list: T[]): T[] {
  const wired = (m: T) => (m.cluster && wireOf(m.cluster.via) === 'wired' ? 1 : 0);
  return [...list].sort((a, b) => b.card - a.card || b.ram - a.ram || wired(b) - wired(a));
}

const quoted = (names: string[]) => names.map(n => `"${n}"`).join(' and ');

/** Why member `m` cannot load the model for the others (plain words, one a reason); empty when it can. */
export function loaderWhy(m: LoaderFacts, members: LoaderFacts[]): string[] {
  if (m.backupsOnly) return ['it is set to Backups only here'];
  if (m.guest) return ['this PC is only a guest there (a guest pass), and a guest cannot run a cluster'];
  if (!m.answering) return ['it is not answering (off, asleep, or TOMLIN is not running there)'];
  if (m.away) return ['someone is using it (they pressed "I need to use the pc" there)'];
  if (!m.cluster) return ['its TOMLIN does not say which PCs it can borrow from: update TOMLIN there'];
  const why: string[] = [];
  if (wireOf(m.cluster.via) === 'wifi') why.push(`it is on Wi-Fi ("${m.cluster.via}"), and the loader sends each member its part of the model, so it must be on a wired network`);
  const others = members.filter(x => x.id !== m.id);
  const missing = others.filter(x => !m.cluster!.borrows.includes(x.id)).map(x => x.name);
  if (missing.length) why.push(`it would not borrow from ${quoted(missing)}: on "${m.name}" itself, ${missing.length === 1 ? 'that PC' : 'each of them'} must be linked under Network with ${missing.length === 1 ? 'its' : 'its own'} setup code, ticked "Allow to be used as part of a cluster" there, and in "${m.name}"'s own cluster if it has one switched on`);
  return why;
}

/** The loader for the set, or why no member can be it (one line a member, strongest first). */
export function chooseLoader(members: LoaderFacts[]): { loader: LoaderFacts; notes: string[] } | { why: string } {
  if (members.length < 2) return { why: 'a cluster that this PC stays out of needs at least two PCs in it: one loads the model and borrows from the others' };
  const ranked = strongestFirst(members);
  const reasons = ranked.map(m => ({ m, why: loaderWhy(m, members) }));
  const ok = reasons.find(x => !x.why.length);
  if (!ok) return { why: `no PC in the cluster can load the model for the others. ${reasons.map(x => `"${x.m.name}": ${x.why.join('; ')}.`).join(' ')}` };
  const notes: string[] = [];
  if (ok.m !== ranked[0]) notes.push(`"${ranked[0].name}" is the strongest but cannot load the model (${reasons[0].why.join('; ')}), so "${ok.m.name}" loads it.`);
  if (wireOf(ok.m.cluster!.via) === 'unknown') notes.push(`Whether "${ok.m.name}" is wired could not be told from its network adapter's name ("${ok.m.cluster!.via || 'not given'}"): it should be on a wired network.`);
  return { loader: ok.m, notes };
}

/**
 * Why the loader cannot answer for the cluster now ('' when it can): the same checks as the choice, for a loader already
 * chosen. Read again at every look, so a loader that went off or lost a link is said at once.
 */
export function loaderGaps(loader: LoaderFacts | undefined, members: LoaderFacts[]): string[] {
  if (!loader) return ['The PC chosen to load the model is no longer in the cluster.'];
  if (members.length < 2) return [`"${loader.name}" is the only PC in the cluster, so it has no PC to borrow from: put another PC in the cluster, or let this PC take part again.`];
  return loaderWhy(loader, members).map(w => `"${loader.name}", which loads the model for the cluster, cannot now: ${w}.`);
}

/** Why a chat model cannot run on the loader ('' when it can): it must be on the loader's own disk. */
export function loaderModelWhy(loaderName: string, models: { id: string; kind?: string }[], model?: string): string {
  const chats = models.filter(m => (m.kind ?? 'chat') === 'chat');
  if (!chats.length) return `No chat model is on "${loaderName}" yet. The model loads from the loader's own disk: send one there first (Models, Send to).`;
  if (model && !chats.some(m => m.id === model)) return `That model is not on "${loaderName}". The model loads from the loader's own disk: send it there first (Models, Send to).`;
  return '';
}
