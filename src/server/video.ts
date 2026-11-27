// The video test door: makes one short clip on this PC with the video runner (src/video.ts), so the engine can be tried
// before any hire uses it. GET /api/video-test says how it stands and which runner build makes clips here (or which to
// install, with its size); POST /api/video-test starts one clip of the model named; POST /api/video-test/stop stops it.
import { videoRunner, videoRunnerFacts, VideoTestDoor, VIDEO_DEVICES } from '../video.ts';
import type { Device } from '../runtimes.ts';
import { hardware, json, runtimes, type Routes } from './core.ts';
import { images } from './panes.ts';

/** The card runners this PC can use for clips: CUDA with an NVIDIA card of its own, Vulkan with any card of its own. */
const cardDevices = (): Device[] => {
  const cards = hardware.gpus.filter(g => !g.integrated);
  return VIDEO_DEVICES.filter(d => (d === 'cuda' ? cards.some(g => g.vendor === 'nvidia') : cards.length > 0));
};

/** A picture model on the card holds its memory: a test clip waits for it to be dropped. */
const busyWhy = (): string => {
  const v = images.pane.view;
  return v.device && v.device !== 'cpu' && (v.state === 'connected' || v.state === 'loading') ? `a picture model is loaded on the graphics card. Drop it (the top bar), then test` : '';
};

const door = new VideoTestDoor(videoRunner(), busyWhy);

export const videoGet: Routes = {
  '/api/video-test': ({ res }) => json(res, 200, { test: door.state(), runner: videoRunnerFacts(runtimes, cardDevices()) }),
};

export const videoPost: Routes = {
  '/api/video-test': async ({ res, b }) => {
    const r = await door.start(b);
    return json(res, r.status, r.json);
  },
  '/api/video-test/stop': ({ res }) => json(res, 200, door.stop()),
};
