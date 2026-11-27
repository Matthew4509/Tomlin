// A pretend video runner (the clip flow's own; test/fakevideo.ts is the runner phase's) for the tests and for seeing the clip flow in a browser without a graphics card
// (TOMLIN_FAKE_VIDEO=1, src/server/clips.ts). It counts frames on a timer and hands back a copy of a tiny real clip
// (test/fixtures/fake-clip.webm, two seconds of a sun crossing a sky), or ends with the fault it was told to.
// TOMLIN_FAKE_VIDEO=<fault kind> (for example out-of-memory) makes every clip end with that fault part way.
import { copyFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoFault, type VideoFaultKind, type VideoJob, type VideoProgress, type VideoRunner } from '../src/videotypes.ts';

export const FAKE_CLIP = join(import.meta.dirname, 'fixtures', 'fake-clip.webm');

export interface FakeOptions {
  installed?: boolean;
  /** Milliseconds the pretend model takes to load, and each frame. */
  loadMs?: number;
  frameMs?: number;
  /** Frames each second of clip. */
  fps?: number;
  /** Ends with this fault once this many frames are made. */
  fail?: VideoFaultKind;
  failAt?: number;
  /** Says no time left, so the clip job works it out itself. */
  noEta?: boolean;
  /** Milliseconds the clip file takes to write, and the time left said once as it starts (as the real runner does). */
  joinMs?: number;
  joinLeft?: number | null;
}

export class FakeVideoRunner implements VideoRunner {
  readonly made: VideoJob[] = [];
  private o: FakeOptions;

  constructor(o: FakeOptions = {}) {
    this.o = o;
  }

  async installed(): Promise<boolean> {
    return this.o.installed !== false;
  }

  async make(job: VideoJob, onProgress: (p: VideoProgress) => void, signal: AbortSignal): Promise<{ file: string; mime: 'video/webm'; bytes: number; seconds: number; width: number; height: number; model: string; tookMs: number }> {
    const start = Date.now();
    this.made.push(job);
    const total = job.seconds * (this.o.fps ?? 4);
    const frameMs = this.o.frameMs ?? 0;
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new VideoFault('stopped', 'Stopped: no clip was made.'));
      const t = setTimeout(() => {
        signal.removeEventListener('abort', off);
        resolve();
      }, ms);
      const off = () => {
        clearTimeout(t);
        reject(new VideoFault('stopped', 'Stopped: no clip was made.'));
      };
      signal.addEventListener('abort', off, { once: true });
    });
    onProgress({ stage: 'loading', done: 0, total, secondsLeft: null });
    await wait(this.o.loadMs ?? 0);
    for (let done = 0; done <= total; done++) {
      if (this.o.fail && done >= (this.o.failAt ?? 0)) throw new VideoFault(this.o.fail, '');
      onProgress({ stage: 'making', done, total, secondsLeft: this.o.noEta ? null : Math.round(((total - done) * frameMs) / 1000) });
      if (done < total) await wait(frameMs);
    }
    onProgress({ stage: 'joining', done: total, total, secondsLeft: this.o.joinLeft === undefined ? 0 : this.o.joinLeft });
    if (this.o.joinMs) await wait(this.o.joinMs);
    const dir = await mkdtemp(join(tmpdir(), 'fake-clip-'));
    const file = join(dir, 'clip.webm');
    await copyFile(FAKE_CLIP, file);
    return { file, mime: 'video/webm', bytes: (await stat(file)).size, seconds: job.seconds, width: job.width, height: job.height, model: job.model, tookMs: Date.now() - start };
  }
}

const KINDS: VideoFaultKind[] = ['not-installed', 'missing-model', 'out-of-memory', 'low-disk', 'crashed', 'stopped', 'busy', 'pc-off'];

/** The dev switch's runner: slow enough to watch (about 4 s a clip second), or failing with the kind named. */
export function devRunner(setting: string): FakeVideoRunner {
  const fail = KINDS.find(k => k === setting);
  if (fail === 'not-installed') return new FakeVideoRunner({ installed: false });
  return new FakeVideoRunner({ loadMs: 1500, frameMs: 500, fps: 8, joinMs: 6000, joinLeft: 3, ...(fail ? { fail, failAt: 6 } : {}) });
}
