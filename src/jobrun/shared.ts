// What every part of the jobs code shares: the server's parts (`d`, given once by createJobs) and a few small helpers.
import * as home from '../home.ts';
import type { JobDeps } from '../jobrun.ts';

/** The server's parts (src/jobrun.ts JobDeps), given once by createJobs before anything here runs. */
export let d: JobDeps;
export function useDeps(deps: JobDeps): void {
  d = deps;
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type Send = (event: string, data: unknown) => void;

/** An event as written: the time is added when it is appended. */
export type NewEvent = home.JobEvent extends infer T ? (T extends unknown ? Omit<T, 'at'> : never) : never;
