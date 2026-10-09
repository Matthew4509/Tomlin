// The Microsoft Visual C++ Runtime: the model runners (llama-server, sd-server) and ONNX Runtime (background removal)
// are built with Microsoft's C++ compiler and need its runtime files in Windows' System32. Most PCs have them (many
// programs install them), but a clean Windows does not: the runners then end at once with no words of their own
// (Windows' "DLL not found", 0xC0000135). The installer checks for them and offers Microsoft's own installer; the
// panes say so in plain words when a runner ends that way. Tested in test/vcrt.test.ts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The files the shipped runners import from System32 (read from their import tables, 2.0.43). */
export const VCRT_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'vcomp140.dll'];

/** Microsoft's own link to the latest Visual C++ Redistributable (x64); about 19 MB. */
export const VCRT_URL = 'https://aka.ms/vc14/vc_redist.x64.exe';

/** Windows' exit code for a program that could not start because a DLL it needs is missing (0xC0000135). */
export function dllNotFound(code: number | null): boolean {
  return code === 0xc0000135 || code === -1073741515;
}

/** Where Windows keeps them; TOMLIN_VCRT_DIR moves it for tests. */
export function systemDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TOMLIN_VCRT_DIR ?? join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32');
}

/** The runtime files this PC lacks (none on other systems). */
export function vcrtMissing(dir = systemDir(), platform = process.platform): string[] {
  if (platform !== 'win32') return [];
  return VCRT_DLLS.filter(f => !existsSync(join(dir, f)));
}

/** The line a runner's log gets when it ended for want of the runtime: the panes' reasons look for it. */
export const VCRT_LINE = 'Windows could not start the runner: a Microsoft Visual C++ Runtime file it needs is missing on this PC.';

/** The panes' words for it: what failed, why, and the way out. */
export const VCRT_HELP = `The model runner could not start: this PC does not have the Microsoft Visual C++ Runtime, which it needs (a clean Windows does not come with it). Install it from Microsoft (${VCRT_URL}, free, about 19 MB), or run "Install TOMLIN.cmd" again and answer Yes when it offers it. Then press Connect again.`;

/** True when a runner's last lines say it ended for want of the runtime. */
export const vcrtFault = (tail: string) => tail.includes(VCRT_LINE);

/** The same Windows fault with the runtime present: one of the runner's own files beside it is missing (a damaged copy). */
export const RUNNER_FILE_LINE = 'Windows could not start the runner: a file it needs is missing from its own folder.';
export const RUNNER_FILE_HELP = 'The model runner could not start: a file it needs is missing from its folder (the copy is damaged, or a security program took it away). Run "Install TOMLIN.cmd" again (it repairs the copy), then press Connect again.';

/** The line for a runner Windows could not start for want of a DLL: the runtime when it is missing, else its own files. */
export const dllLine = (dir = systemDir()) => (vcrtMissing(dir).length ? VCRT_LINE : RUNNER_FILE_LINE);

/** Runners built with Visual Studio 17.10 or later crash on an older msvcp140.dll (14.3x and before): 14.40 at least. */
export const VCRT_MIN = [14, 40];

/** True when a msvcp140.dll file version ("14.38.33135.0") is older than the runners need. */
export function vcrtTooOld(version: string): boolean {
  if (!/^\d+(\.\d+)+$/.test(version.trim())) return false;
  const v = version.trim().split('.').map(Number);
  return (v[0] ?? 0) < VCRT_MIN[0] || ((v[0] ?? 0) === VCRT_MIN[0] && (v[1] ?? 0) < VCRT_MIN[1]);
}
