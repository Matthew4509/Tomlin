// A loaded chat model keeps the runner it started with: a runner installed, updated or picked for the model afterwards
// is used only from its next start. The model is not freed on its own (an answer or a job step may be running on it,
// and a big model takes many minutes to load again), so the pane says plainly that it is still on the old runner.
import { statSync } from 'node:fs';

/** The program a runner was started from, and when that file was last written (a runner updated in place has a new time). */
export interface StartedWith {
  exe: string;
  runner?: string;
  device: string;
  mtimeMs: number | null;
}

/** A file's last-written time, or null when it is not there. */
export function fileTime(path: string | undefined): number | null {
  if (!path) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

const RUNNER_WORDS: Record<string, string> = { cuda: 'CUDA 12', cuda13: 'CUDA 13', vulkan: 'Vulkan' };
const DEVICE_WORDS: Record<string, string> = { cpu: 'CPU', vulkan: 'Vulkan', cuda: 'CUDA' };

const wordsOf = (runner: string | undefined, device: string) => RUNNER_WORDS[runner ?? ''] ?? DEVICE_WORDS[device] ?? device;
const samePath = (a: string, b: string) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

/**
 * '' when the model runs on the runner a start would pick now; else a line for the pane. `was`: what it started from;
 * `now`: the program a start on the same device would run now (null: none could start there now); `nowTime`: that
 * program file's last-written time now (a runner updated in place keeps its path and gets a new time).
 */
export function oldRunnerNote(was: StartedWith | null, now: { exe: string; runner?: string } | null, nowTime: number | null): string {
  if (!was) return '';
  const old = wordsOf(was.runner, was.device);
  if (!now) return `This model is still on the ${old} runner it started with, which is no longer installed. It keeps running until it is dropped.`;
  if (!samePath(was.exe, now.exe)) {
    const next = wordsOf(now.runner, was.device);
    return `This model is still on the ${old} runner it started with; it would start on ${next === old ? 'another' : `the ${next}`} runner now. Drop it and load it again to use that one.`;
  }
  if (was.mtimeMs !== null && nowTime !== null && Math.abs(was.mtimeMs - nowTime) > 1) return `This model is still on the ${old} runner as it was before the runner was updated. Drop it and load it again to use the new one.`;
  return '';
}
