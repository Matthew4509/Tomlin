// Loads what a project delivered, whether it is written as CommonJS or as an ES module.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export async function load(file) {
  const m = await import(pathToFileURL(join(process.cwd(), file)).href);
  const d = m.default;
  return d && typeof d === 'object' ? { ...d, ...m } : m;
}
