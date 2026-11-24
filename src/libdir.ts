// Linux (a Bootable USB node): a runner finds its .so files in its own folder, whether or not its build says so (its
// RPATH). A Windows runner finds its DLLs there anyway, so nothing changes there.
import { dirname } from 'node:path';

/** The environment a runner at `exe` starts with; `env` undefined stands for this PC's own settings. */
export function libDirEnv(exe: string, env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv | undefined {
  if (platform !== 'linux') return env;
  const base = env ?? process.env;
  const dir = dirname(exe);
  return { ...base, LD_LIBRARY_PATH: base.LD_LIBRARY_PATH ? `${dir}:${base.LD_LIBRARY_PATH}` : dir };
}
