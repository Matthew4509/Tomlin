// What a chat model can take in or do, for the labels and the filter on the Models page: reads pictures (a vision add-on, or a
// picture-and-text task), has a place for tools in its chat format (the web tools, files and the rest are all tool calls), or
// neither (General). A label is a statement about the file or its Hugging Face entry, never a test: a small model can have the
// tools format and still ignore it. The plain functions are tested in test/capabilities.test.ts.
import { readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readHeader } from './gguf.ts';

/** What one model can do. */
export interface Caps {
  /** It can read pictures (with its vision add-on): a picture added to a chat is sent to it when the add-on is beside it on this PC. */
  images: boolean;
  /** Its chat format has a place for tools (web search, reading pages, files). */
  tools: boolean;
}

/** The three filter words: General is a model with neither. */
export type CapKind = 'images' | 'tools' | 'general';
export const CAP_KINDS: readonly CapKind[] = ['images', 'tools', 'general'];

/** The kinds ticked, as sent by the page: only known words, each once. */
export function cleanKinds(v: unknown): CapKind[] {
  return Array.isArray(v) ? CAP_KINDS.filter(k => v.includes(k)) : [];
}

/**
 * Whether a model with `caps` passes the kinds ticked: any one ticked kind is enough (none ticked: every model passes).
 * A model whose capabilities are not known yet passes none of the ticked kinds.
 */
export function capsPass(caps: Caps | null | undefined, kinds: readonly CapKind[]): boolean {
  if (!kinds.length) return true;
  if (!caps) return false;
  return kinds.some(k => (k === 'images' ? caps.images : k === 'tools' ? caps.tools : !caps.images && !caps.tools));
}

/**
 * Whether a chat template has a place for tools: it uses the tools list or tool calls (Qwen, Llama 3.1, gpt-oss and Hermes
 * formats), a tool role (the answer of a tool), or one of the special words Mistral and Llama use. A plain format
 * (Llama 2, Gemma 2, Phi 2) has none of these.
 */
export function templateHasTools(template: unknown): boolean {
  if (typeof template !== 'string' || !template) return false;
  return /\btools\b|\btool_calls?\b|\[AVAILABLE_TOOLS\]|<tool_call>|<\|python_tag\|>|\bfunction_call\b|role\s*==\s*['"]tool['"]/i.test(template);
}

/** Hugging Face's task for a model that takes pictures with text. */
export const VISION_TASK = 'image-text-to-text';

/** Whether a list of file names holds a vision add-on (mmproj). */
export const hasVisionFile = (names: readonly string[]): boolean => names.some(n => /(?:^|\/)[^/]*mmproj[^/]*\.gguf$/i.test(n));

/** A Hugging Face repo's capabilities from its task, its file names and its GGUF header's chat template. */
export function capsFromHf(meta: { pipeline_tag?: unknown; files?: readonly string[]; chat_template?: unknown }): Caps {
  return {
    images: meta.pipeline_tag === VISION_TASK || hasVisionFile(meta.files ?? []),
    tools: templateHasTools(meta.chat_template),
  };
}

// ---- A model file on this PC ----

/** Architectures (the header's general.architecture) of models that take pictures. */
const VISION_ARCH = /vl$|^qwen\d*vl|llava|mllama|pixtral|minicpmv|internvl|smolvlm|idefics|paligemma|glm4v|lfm2vl/i;
/** A model whose own name says it takes pictures ("Qwen2.5-VL-7B", "Llama-3.2-11B-Vision"). */
const VISION_NAME = /(?:^|[-_. ])(?:vl|vision|llava|pixtral|smolvlm|paligemma)(?:[-_. \d]|$)/i;

const quantOf = /[-_.](?:UD[-_])?(?:I?Q\d[\w]*|F16|BF16|F32|MXFP4\w*|NVFP4\w*)$/i;
/** A vision file's name without "mmproj", its ending and its number type: "mmproj-Qwen3.5-9B-F16.gguf" -> "qwen3.5-9b". */
const mmprojCore = (file: string) => file.replace(/\.gguf$/i, '').replace(/mmproj/i, '').replace(quantOf, '').replace(/^[-_.]+|[-_.]+$/g, '').toLowerCase();

/**
 * The file beside a model that is its vision add-on: an mmproj named for it, or one with a general name
 * ("mmproj-F16.gguf") when the folder holds no other model. With several, F16 first, then Q8_0, BF16, the rest, and F32
 * last (the largest). Null when there is none.
 */
export function visionFileOf(modelFile: string, folder: readonly string[]): string | null {
  const mine = basename(modelFile).replace(/\.gguf$/i, '').toLowerCase();
  const projs = folder.filter(n => /mmproj/i.test(n) && /\.gguf$/i.test(n));
  if (!projs.length) return null;
  const models = folder.filter(n => /\.gguf$/i.test(n) && !/mmproj/i.test(n) && !/^mtp[-_]/i.test(n));
  const fits = projs.filter(p => {
    const core = mmprojCore(p);
    return core ? mine.includes(core) || core.includes(mine.replace(quantOf, '')) : models.length <= 1;
  });
  const rank = (n: string) => [/[-_.]F16\.gguf$/i, /[-_.]Q8_0\.gguf$/i, /[-_.]BF16\.gguf$/i, /[-_.]F32\.gguf$/i].findIndex(r => r.test(n));
  const order = (n: string) => (rank(n) === 3 ? 9 : rank(n) < 0 ? 5 : rank(n));
  return fits.sort((a, b) => order(a) - order(b) || a.localeCompare(b))[0] ?? null;
}

/** Whether one of the files beside a model is its vision add-on (visionFileOf finds one). */
export function visionFileFor(modelFile: string, folder: readonly string[]): boolean {
  return visionFileOf(modelFile, folder) !== null;
}

/** The full path of the vision add-on beside a model file on this PC, or null (none, or its folder cannot be read). */
export function visionPathFor(modelPath: string): string | null {
  let folder: string[];
  try {
    folder = readdirSync(dirname(modelPath));
  } catch {
    return null;
  }
  const found = visionFileOf(modelPath, folder);
  return found ? join(dirname(modelPath), found) : null;
}

const cache = new Map<string, Promise<Caps | null>>();

/** A model file's capabilities, read from its header once per file (by path, size and time). Null when it cannot be read. */
export async function modelCaps(path: string): Promise<Caps | null> {
  const s = await stat(path).catch(() => null);
  if (!s) return null;
  const key = `${path}|${s.size}|${s.mtimeMs}`;
  if (!cache.has(key)) {
    cache.set(key, readHeader(path, k => k === 'general.architecture' || k === 'tokenizer.chat_template').then(h => {
      const arch = String(h.get('general.architecture') ?? '');
      let folder: string[] = [];
      try {
        folder = readdirSync(dirname(path));
      } catch {
        // its folder cannot be read: the header and the name still say
      }
      const images = VISION_ARCH.test(arch) || VISION_NAME.test(basename(path)) || visionFileFor(path, folder);
      return { images, tools: templateHasTools(h.get('tokenizer.chat_template')) };
    }).catch(() => null));
  }
  return cache.get(key)!;
}
