// A stand-in for the video runner (src/video.ts videoRunner), for tests of the hire screens, the chat and the linked-PC
// route: no graphics card, no process, no model files. Copy it, or import it from here. It makes a small file in `dir`
// after reporting progress the way the real runner does (loading, making each step, joining), honours Stop, and can be
// told to fail with any VideoFault kind.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VideoFault, type VideoClip, type VideoFaultKind, type VideoJob, type VideoProgress, type VideoRunner } from '../src/videotypes.ts';
import { VIDEO_WORDS } from '../src/video.ts';

export interface FakeVideoOptions {
  /** Where clips are written (a temp folder of the test's own). */
  dir: string;
  /** False: installed() says no, and make() fails with not-installed. */
  installed?: boolean;
  /** Model ids that are "downloaded"; unset: every model is. */
  models?: string[];
  /** Fail every make() with this kind (after the progress up to `failAt` steps). */
  fail?: VideoFaultKind;
  failAt?: number;
  /** Steps it reports; ms between them. */
  steps?: number;
  stepMs?: number;
}

/** The sentence the real runner gives for each kind, so a screen shows what users would see. */
const SAID: Record<VideoFaultKind, string> = {
  'not-installed': VIDEO_WORDS.notInstalled,
  'missing-model': VIDEO_WORDS.missingModel('the model'),
  'out-of-memory': VIDEO_WORDS.outOfMemory,
  'low-disk': VIDEO_WORDS.lowDisk(1.2 * 2 ** 30),
  crashed: VIDEO_WORDS.crashed('exit code 3221225477'),
  stopped: VIDEO_WORDS.stopped,
  busy: VIDEO_WORDS.busy,
  'pc-off': 'The linked PC did not answer. Check that it is on and TOMLIN is running there.',
};

export class FakeVideoRunner implements VideoRunner {
  /** Every job asked for, in order. */
  readonly jobs: VideoJob[] = [];
  private now = false;

  private readonly o: FakeVideoOptions;

  constructor(o: FakeVideoOptions) {
    this.o = o;
  }

  async installed(): Promise<boolean> {
    return this.o.installed !== false;
  }

  async make(job: VideoJob, onProgress: (p: VideoProgress) => void, signal: AbortSignal): Promise<VideoClip> {
    this.jobs.push(job);
    const fault = (kind: VideoFaultKind, said = SAID[kind]) => new VideoFault(kind, said);
    if (this.o.installed === false) throw fault('not-installed');
    if (this.o.models && !this.o.models.includes(job.model)) throw fault('missing-model', VIDEO_WORDS.missingModel(job.model));
    if (this.now) throw fault('busy');
    this.now = true;
    const t0 = Date.now();
    try {
      const total = this.o.steps ?? 4;
      onProgress({ stage: 'loading', done: 0, total, secondsLeft: null });
      for (let done = 1; done <= total; done++) {
        await new Promise(r => setTimeout(r, this.o.stepMs ?? 1));
        if (signal.aborted) throw fault('stopped');
        if (this.o.fail && done > (this.o.failAt ?? 0)) throw fault(this.o.fail);
        onProgress({ stage: 'making', done, total, secondsLeft: total - done });
      }
      onProgress({ stage: 'joining', done: total, total, secondsLeft: 0 });
      if (signal.aborted) throw fault('stopped');
      await mkdir(this.o.dir, { recursive: true });
      const file = join(this.o.dir, `fake-clip-${this.jobs.length}.webm`);
      const data = Buffer.from('fake webm clip');
      await writeFile(file, data);
      return { file, mime: 'video/webm', bytes: data.length, seconds: job.seconds, width: job.width, height: job.height, model: job.model, tookMs: Date.now() - t0 };
    } finally {
      this.now = false;
    }
  }
}
