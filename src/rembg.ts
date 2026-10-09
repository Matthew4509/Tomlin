// Background removal for Icon mode: the U2-Net small model (u2netp.onnx, the one rembg uses), run on the CPU with
// ONNX Runtime. It returns a mask: 255 where the subject is, 0 where the background was. Loaded on first use and
// dropped again after a minute idle, so it holds no memory between icons.
import sharp from 'sharp';
import type { Size } from './sizes.ts';
import { VCRT_URL, vcrtMissing } from './vcrt.ts';

const SIDE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

type Ort = typeof import('onnxruntime-node');
let session: { run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>>; inputNames: readonly string[]; outputNames: readonly string[]; release?: () => Promise<void> } | null = null;
let ort: Ort | null = null;
let idle: NodeJS.Timeout | null = null;

async function open(modelPath: string) {
  if (!ort) {
    try {
      ort = await import('onnxruntime-node');
    } catch (e) {
      // ONNX Runtime needs the Visual C++ Runtime too (src/vcrt.ts): say that rather than "module could not be found".
      if (vcrtMissing().length) throw new Error(`Background removal could not start: this PC does not have the Microsoft Visual C++ Runtime. Install it from Microsoft (${VCRT_URL}), then try again.`);
      throw e;
    }
  }
  if (!session) session = (await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })) as never;
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    void session?.release?.();
    session = null;
  }, 60_000);
  idle.unref();
  return { ort, session: session! };
}

/** The subject mask of `png`, at the picture's own size. */
export async function subjectMask(modelPath: string, png: Buffer): Promise<{ mask: Buffer; size: Size }> {
  const meta = await sharp(png).metadata();
  const size = { width: meta.width ?? SIDE, height: meta.height ?? SIDE };
  const { ort: o, session: s } = await open(modelPath);
  const rgb = await sharp(png).removeAlpha().resize(SIDE, SIDE, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  // rembg's normalising: divide by the brightest value, then the ImageNet mean and spread, channels first.
  let max = 1;
  for (const v of rgb) if (v > max) max = v;
  const input = new Float32Array(3 * SIDE * SIDE);
  for (let i = 0; i < SIDE * SIDE; i++) {
    for (let c = 0; c < 3; c++) input[c * SIDE * SIDE + i] = (rgb[i * 3 + c] / max - MEAN[c]) / STD[c];
  }
  const out = await s.run({ [s.inputNames[0]]: new o.Tensor('float32', input, [1, 3, SIDE, SIDE]) });
  const pred = out[s.outputNames[0]].data;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of pred) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const small = Buffer.alloc(SIDE * SIDE);
  for (let i = 0; i < SIDE * SIDE; i++) small[i] = Math.round(((pred[i] - lo) / (hi - lo || 1)) * 255);
  const mask = await sharp(small, { raw: { width: SIDE, height: SIDE, channels: 1 } }).resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' }).extractChannel(0).raw().toBuffer();
  // Firm up the edge a little: near-background goes fully clear, near-subject fully solid.
  for (let i = 0; i < mask.length; i++) mask[i] = mask[i] < 30 ? 0 : mask[i] > 225 ? 255 : mask[i];
  return { mask, size };
}
