// A linked PC's processor as its hello tells it (src/jobrun/node.ts): its name, physical cores and threads, for the
// host's Cluster page (each node's tile, and the cores in the pool). An older TOMLIN, or a link that is a guest there,
// sends none: null, and the page says "not known". Tested in test/nodecpu.test.ts.

export interface NodeCpu {
  name: string;
  cores: number;
  threads: number;
}

/** The processor from a hello, checked: whole numbers in a sane range and a plain name, or null. */
export function cleanCpu(v: unknown): NodeCpu | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  const cores = typeof x.cores === 'number' ? x.cores : NaN;
  const threads = typeof x.threads === 'number' ? x.threads : NaN;
  if (!Number.isInteger(cores) || cores < 1 || cores > 1024) return null;
  const name = typeof x.name === 'string' ? x.name.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  return { name, cores, threads: Number.isInteger(threads) && threads >= cores && threads <= 4096 ? threads : cores };
}
