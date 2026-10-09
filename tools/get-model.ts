// Downloads a model from the registry from the command line (the page's Models list does the same).
//   npm run get-model -- sd15-realistic-lcm
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '../src/registry.ts';
import { resolveHome } from '../src/keep.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Downloads go to the home folder (src/keep.ts), where every version of TOMLIN finds them.
const registry = new Registry(join(ROOT, 'registry'), resolveHome().models);
registry.copies = () => [join(ROOT, 'models')];
const ids = process.argv.slice(2);
if (!ids.length) {
  for (const m of registry.models) console.log(`${m.id.padEnd(22)} ${(registry.bytes(m) / 2 ** 30).toFixed(1)} GB  ${registry.installed(m) ? 'here' : 'not here'}  ${m.name}`);
  process.exit(0);
}
for (const id of ids) {
  const st = await registry.start(id);
  let shown = -1;
  while (!st.done && !st.error) {
    await new Promise(r => setTimeout(r, 1000));
    const pc = Math.floor((st.got / st.bytes) * 100);
    if (pc !== shown && pc % 5 === 0) console.log(`${id}: ${st.checking ? 'checking' : `${pc}%`}`);
    shown = pc;
  }
  console.log(st.error ? `${id}: ${st.error}` : `${id}: ready.`);
}
