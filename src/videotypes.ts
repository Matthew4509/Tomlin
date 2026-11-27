// The shared shape of a video clip job. Phase 2 (src/video.ts) implements VideoRunner; the hire screens,
// the chat and the linked-PC route use only these types, so the engine behind them can change.

export type VideoQuality = 'draft' | 'normal' | 'best';

export interface VideoJob {
  prompt: string;
  /** Clip length in seconds, 1 to MAX_CLIP_SECONDS. */
  seconds: number;
  width: number;
  height: number;
  quality: VideoQuality;
  /** Video model id, as listed by src/videomodels.ts. */
  model: string;
  seed?: number;
  /**
   * A PNG the clip starts from (image to video), as a file path on the PC that makes the clip, already fitted to
   * width by height. Only models with `startPicture` take one (src/videomodels.ts).
   */
  startPicture?: string;
  /** Words to leave out of the clip (the negative prompt). */
  negative?: string;
  /** Sampling steps, when not the quality's own. */
  steps?: number;
  /**
   * The id a linked PC makes the clip under (32 hex characters), kept on this PC only: asked again with it after a
   * restart here, the linked PC hands over the clip it is making or made. None: a new id. Never sent as part of the job.
   */
  linkId?: string;
}

export interface VideoProgress {
  /** 'loading' while the model loads, 'making' while frames are made, 'joining' while the file is written. */
  stage: 'loading' | 'making' | 'joining';
  done: number;
  total: number;
  /** Seconds left, or null while unknown. */
  secondsLeft: number | null;
}

export interface VideoClip {
  /** Absolute path of the finished file. */
  file: string;
  mime: 'video/mp4' | 'video/webm';
  bytes: number;
  seconds: number;
  width: number;
  height: number;
  model: string;
  /** Wall time to make it, in milliseconds. */
  tookMs: number;
}

export type VideoFaultKind =
  | 'not-installed'   // the video runner is not installed on this PC
  | 'missing-model'   // the chosen model is not downloaded on this PC
  | 'out-of-memory'   // the graphics card ran out of memory
  | 'low-disk'        // under LOW_DISK_BYTES free where the clip is written
  | 'crashed'         // the runner stopped by itself
  | 'stopped'         // the user pressed Stop
  | 'busy'            // the PC is locked by its owner or already making a clip
  | 'pc-off';         // a linked PC did not answer

export class VideoFault extends Error {
  readonly kind: VideoFaultKind;
  constructor(kind: VideoFaultKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'VideoFault';
  }
}

export interface VideoRunner {
  /** True when the runner is installed on this PC. */
  installed(): Promise<boolean>;
  /** Makes one clip. Rejects with a VideoFault whose message is a plain sentence for the user. */
  make(job: VideoJob, onProgress: (p: VideoProgress) => void, signal: AbortSignal): Promise<VideoClip>;
}

export const MAX_CLIP_SECONDS = 5;
/** The largest start picture a clip takes (a PNG fitted to the clip's size is well under 2 MB). */
export const MAX_START_BYTES = 6 * 2 ** 20;
/** PNG's first eight bytes. */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const isPng = (b: Buffer): boolean => b.length > PNG_SIG.length && b.subarray(0, PNG_SIG.length).equals(PNG_SIG);
export const LOW_DISK_BYTES = 2 * 1024 * 1024 * 1024;
