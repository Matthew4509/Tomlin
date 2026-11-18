// A comment line sent now and then on a stream the host keeps open for its client (the page, or a program on this PC):
// while a linked PC loads a model or reads a long prompt nothing else is written, and the client's own fetch gives up
// on a body that stays silent for 300 s with just "terminated" (4 Nov, benchmark runs against a linked PC).

/** How often the comment goes out. */
export const BEAT_MS = 15_000;

type Writer = { destroyed: boolean; writableEnded: boolean; write: (s: string) => unknown };

/** Writes ": still working" to every open stream `targets` gives, each `ms`; returns the stop. */
export function beatTo(targets: () => Iterable<Writer>, ms = BEAT_MS): () => void {
  const t = setInterval(() => {
    for (const r of targets()) if (!r.destroyed && !r.writableEnded) r.write(': still working\n\n');
  }, ms);
  t.unref();
  return () => clearInterval(t);
}
