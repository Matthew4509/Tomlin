// Small stand-ins for a CUDA runner release (two zips: the runner, and the CUDA DLLs), made with Windows' own tar as
// the real ones are unpacked, and a runtimes.json that pins them. For test/runnerinstall.test.ts and
// test/runnerpush.test.ts.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

export interface RunnerZips {
  parts: { name: string; data: Buffer; path: string; sha256: string }[];
  /** A runtimes.json pinning these zips at `base` (and a CPU runner, which is never sent between PCs). */
  pinsFile: (base: string) => { runtimes: Record<string, unknown> };
}

/** Makes the two zips in `dir`. `big`: the CUDA DLLs zip holds this many random bytes (more than one 16 MB piece). */
export function makeRunnerZips(dir: string, big = 64 * 1024): RunnerZips {
  const make = (name: string, files: Record<string, Buffer | string>) => {
    const src = join(dir, `${name}-files`);
    mkdirSync(src, { recursive: true });
    for (const [f, data] of Object.entries(files)) writeFileSync(join(src, f), data);
    const path = join(dir, name);
    execFileSync(tar, ['-a', '-c', '-f', path, '-C', src, ...Object.keys(files)], { windowsHide: true });
    const data = readFileSync(path);
    return { name, data, path, sha256: createHash('sha256').update(data).digest('hex') };
  };
  const parts = [
    make('llama-test-bin-win-cuda-12.4-x64.zip', { 'llama-server.exe': 'a stand-in runner', 'ggml-cuda.dll': 'cuda part' }),
    make('cudart-llama-test-cuda-12.4-x64.zip', { 'cudart64_12.dll': randomBytes(big) }),
  ];
  return {
    parts,
    pinsFile: base => ({
      runtimes: {
        'llama-cpu': { engine: 'llama', device: 'cpu', name: 'llama.cpp test, CPU', licence: 'MIT', parts: [{ url: `${base}/llama-test-cpu.zip`, bytes: 1, sha256: '0'.repeat(64) }] },
        'llama-cuda': { engine: 'llama', device: 'cuda', name: 'llama.cpp test, CUDA 12.4 (NVIDIA)', licence: 'MIT', parts: parts.map(p => ({ url: `${base}/${p.name}`, bytes: p.data.length, sha256: p.sha256 })) },
      },
    }),
  };
}
