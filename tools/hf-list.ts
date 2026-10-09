// Makes registry/hf-list.json.gz: the list of Hugging Face's GGUF chat models that ships with TOMLIN, read until a
// PC rescans its own (src/hflist.ts). Run it before a bake, so a new PC starts with a recent list:
//   npm run hf-list                      scans Hugging Face now (about 80 s and 70 MB on 5 Oct 2026)
//   npm run hf-list -- <hf-list.json>    ships a list a copy of TOMLIN already scanned (its data/hf-list.json)
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { HfList, type HfListFile } from '../src/hflist.ts';

const OUT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'registry', 'hf-list.json.gz');

async function scanNow(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hf-list-'));
  try {
    const list = new HfList(join(dir, 'hf-list.json'));
    list.scan();
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await list.status();
      if (s.scanning) {
        process.stdout.write(`\rScanning Hugging Face: ${s.scanning.read.toLocaleString()} read, ${s.scanning.kept.toLocaleString()} chat models kept`);
        continue;
      }
      process.stdout.write('\n');
      if (s.error) throw new Error(s.error);
      return await readFile(join(dir, 'hf-list.json'), 'utf8');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const from = process.argv[2];
const f = JSON.parse(from ? await readFile(from, 'utf8') : await scanNow()) as HfListFile;
if (!Array.isArray(f?.models) || !f.models.length || typeof f.scannedAt !== 'string') throw new Error(`${from ?? 'The scan'} is not a Hugging Face list: no models in it.`);
await writeFile(OUT, gzipSync(JSON.stringify(f), { level: 9 }));
console.log(`registry/hf-list.json.gz: ${f.models.length.toLocaleString()} chat models, scanned ${f.scannedAt}, ${((await stat(OUT)).size / 1e6).toFixed(1)} MB.`);
