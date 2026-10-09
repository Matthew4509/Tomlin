// Prints each chat model's shape and what a context costs, from its header: node tools/shape-check.ts <folder>
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cacheBytes, modelShape } from '../src/gguf.ts';

const dir = process.argv[2];
for (const f of readdirSync(dir).filter(n => n.endsWith('.gguf') && !/mmproj/i.test(n))) {
  const t0 = Date.now();
  const s = await modelShape(join(dir, f));
  const gb = (n: number) => `${(n / 2 ** 30).toFixed(2)} GB`;
  console.log(f, `${Date.now() - t0} ms`, s ? JSON.stringify(s) : 'UNREADABLE', s ? `8k ${gb(cacheBytes(s, 8192))}, 32k ${gb(cacheBytes(s, 32768))}, 32k q8 ${gb(cacheBytes(s, 32768, 'q8_0'))}` : '');
}
