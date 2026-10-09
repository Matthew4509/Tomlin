// Models already installed by Ollama (what Open WebUI usually runs on), used where they are. Ollama keeps each model
// as a GGUF file named by its SHA-256 (models/blobs/sha256-...), with no .gguf ending, and an index of names in
// models/manifests/<registry>/<namespace>/<model>/<tag>. llama.cpp reads those blobs as they are.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Ollama's models folder: OLLAMA_MODELS when set (Ollama's own setting), else its default. Null when there is none. */
export function ollamaDir(): string | null {
  const dir = process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models');
  return existsSync(join(dir, 'manifests')) ? dir : null;
}

export interface OllamaModel {
  /** As Ollama names it: qwen3:4b, or host/namespace/model:tag for one not from Ollama's own library. */
  name: string;
  blob: string;
  bytes: number;
}

/** Every model in Ollama's index whose model file is there. Vision add-ons and broken entries are left out. */
export function listOllama(dir: string): OllamaModel[] {
  const out: OllamaModel[] = [];
  const kids = (d: string) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };
  const root = join(dir, 'manifests');
  for (const host of kids(root)) {
    for (const ns of kids(join(root, host))) {
      for (const model of kids(join(root, host, ns))) {
        for (const tag of kids(join(root, host, ns, model))) {
          try {
            const manifest = JSON.parse(readFileSync(join(root, host, ns, model, tag), 'utf8')) as { layers?: Array<{ mediaType?: string; digest?: string }> };
            const layer = manifest.layers?.find(l => l.mediaType === 'application/vnd.ollama.image.model');
            if (!layer?.digest || !/^sha256:[a-f0-9]{64}$/.test(layer.digest)) continue;
            const blob = join(dir, 'blobs', layer.digest.replace(':', '-'));
            const st = statSync(blob);
            const name = host === 'registry.ollama.ai' && ns === 'library' ? `${model}:${tag}` : `${host}/${ns}/${model}:${tag}`;
            out.push({ name, blob, bytes: st.size });
          } catch {
            // not a manifest, or its model file is missing
          }
        }
      }
    }
  }
  return out;
}
