// A short name for a model, for the name box in Hire staff: "Qwen3.6-35B-A3B-Q4_K_M.gguf" -> "Qwen", "gemma-3-1b-it" ->
// "Gemma", "Gemini wwqwaetqwe" -> "Gemini". The first word of the model's name that is a name, spelled as its makers
// spell it. Uploaders' and makers' names in front ("bartowski_", "google_", "Huihui-") and words that only describe
// the file (GGUF, abliterated, uncensored) are passed over. A word the list does not know is used as it is, first
// letter made capital. The lists come from the Hugging Face list (registry/hf-list.json.gz, 188,112 models on
// 5 Oct 2026): the first words that cover most of its downloads. Tested in test/nicknames.test.ts.

/** Names spelled as their makers spell them, by the word in lower case. Families first, then the better-known fine-tunes. */
const SPELLED: Record<string, string> = {
  qwen: 'Qwen', qwq: 'QwQ', qwopus: 'Qwopus', qwythos: 'Qwythos', gemma: 'Gemma', gemini: 'Gemini', llama: 'Llama',
  codellama: 'CodeLlama', tinyllama: 'TinyLlama', deepseek: 'DeepSeek', glm: 'GLM', chatglm: 'ChatGLM', lfm: 'LFM',
  mistral: 'Mistral', ministral: 'Ministral', mixtral: 'Mixtral', devstral: 'Devstral', magistral: 'Magistral',
  codestral: 'Codestral', mathstral: 'Mathstral', pixtral: 'Pixtral', nemo: 'Nemo', gpt: 'GPT', granite: 'Granite',
  minimax: 'MiniMax', minicpm: 'MiniCPM', phi: 'Phi', nemotron: 'Nemotron', kimi: 'Kimi', yi: 'Yi', smollm: 'SmolLM',
  smolvlm: 'SmolVLM', olmo: 'OLMo', falcon: 'Falcon', internlm: 'InternLM', internvl: 'InternVL', exaone: 'Exaone',
  aya: 'Aya', command: 'Command', solar: 'Solar', starcoder: 'StarCoder', hunyuan: 'Hunyuan', ernie: 'Ernie',
  baichuan: 'Baichuan', mimo: 'MiMo', kat: 'KAT', rwkv: 'RWKV', hermes: 'Hermes', openhermes: 'Hermes',
  dolphin: 'Dolphin', zephyr: 'Zephyr', openchat: 'OpenChat', wizardlm: 'WizardLM', airoboros: 'Airoboros',
  magnum: 'Magnum', cydonia: 'Cydonia', stheno: 'Stheno', euryale: 'Euryale', rocinante: 'Rocinante',
  mythomax: 'MythoMax', orca: 'Orca', tulu: 'Tulu', vicuna: 'Vicuna', grok: 'Grok', ornith: 'Ornith', bonsai: 'Bonsai',
  laguna: 'Laguna', tiel: 'Tiel', inkling: 'Inkling', muse: 'Muse', yue: 'YuE', ling: 'Ling', seed: 'Seed',
  apertus: 'Apertus', bielik: 'Bielik', nanbeige: 'Nanbeige', jirackultra: 'JiRack', jirackdeltanet: 'JiRack',
  hyperclovax: 'Clova',
  // Picture models.
  dreamshaper: 'DreamShaper', juggernaut: 'Juggernaut', realvisxl: 'RealVis', sdxl: 'SDXL', flux: 'Flux',
};

/** Short words that stand for a family in a model's name ("MN-12B" is Mistral Nemo, "MS-24B" Mistral Small). */
const SHORT: Record<string, string> = { mn: 'Nemo', ms: 'Mistral', hy: 'Hunyuan', yi: 'Yi' };

/**
 * Words that are never the name: uploaders and makers written in front, and words that only say what was done to the
 * file or how big it is. The word after them is the name.
 */
const PASS = new Set([
  'the', 'a', 'an', 'my', 'new', 'meta', 'google', 'microsoft', 'mistralai', 'nvidia', 'ibm', 'zai', 'org', 'allenai',
  'tiiuae', 'huggingfacetb', 'liquidai', 'openai', 'cohereforai', 'coherelabs', 'cognitivecomputations', 'nousresearch',
  'nous', 'teknium', 'bartowski', 'unsloth', 'mradermacher', 'lmstudio', 'community', 'ggml', 'huihui', 'ai', 'davidau',
  'hauhaucs', 'thedrummer', 'arliai', 'mlabonne', 'nbeerbower', 'ryanyr', 'mlfoundations', 'thudm', 'tencent', 'amd',
  'baai', 'tokyotech', 'kwaipilot', 'xyzailab', 'arcee', 'helpingai', 'thomsonreuters', 'deepseekai', 'qwenlm',
  'abliterated', 'obliterated', 'uncensored', 'heretic', 'ablation', 'merged', 'mergekit', 'model', 'models', 'gguf',
  'ggml', 'mlx', 'test', 'final', 'moved', 'distill', 'distilled', 'cyber', 'dark', 'ternary', 'experiment', 'reasoning',
  'creative', 'dirty', 'open', 'router', 'agents', 'audio', 'stories', 'security', 'zero', 'forgotten', 'instruct',
  'chat', 'it', 'base', 'hf', 'lm', 'llm', 'q', 'k', 'm', 's', 'b', 'e', 'a', 'v', 'x', 'xl', 'xxl', 'jp', 'nl', 'mt',
  'ui', 'tpn', 'umt', 'fp', 'bf', 'moe', 'mtp', 'qat', 'imatrix', 'imat', 'gptq', 'awq', 'exl', 'thinking', 'think', 'mini',
  'small', 'tiny', 'dev', 'encoder', 'cpp', 'cand', 'coder', 'flash', 'next', 'turbo', 'preview', 'lite',
]);

/** The words of a model's name, letters only ("Qwen3.6-35B-A3B" -> Qwen, B, A, B); its folder and file ending dropped. */
function wordsOf(name: string): string[] {
  const base = String(name ?? '').split(/[\\/]/).pop()!.replace(/\.(gguf|safetensors|ckpt|bin|onnx)$/i, '');
  return base.match(/[A-Za-z]+/g) ?? [];
}

/** "POCKET" -> "Pocket", "hermes" -> "Hermes", "MiMo" stays: a word as a name. */
function asName(w: string): string {
  if (w === w.toLowerCase() || (w === w.toUpperCase() && w.length > 3)) return w[0].toUpperCase() + w.slice(1).toLowerCase();
  return w[0].toUpperCase() + w.slice(1);
}

/** The short name for a model, or '' when its name holds no word that could be one. */
export function nickname(name: string): string {
  for (const w of wordsOf(name)) {
    const low = w.toLowerCase();
    if (SPELLED[low]) return SPELLED[low];
    // A family inside a longer word: "embeddinggemma", "medgemma", "Qwen" in "QwenLong", "TinyGemma".
    const inside = ['qwen', 'gemma', 'llama', 'mistral', 'deepseek'].find(f => low.includes(f));
    if (inside && low.length > inside.length) return SPELLED[inside];
    if (low.length <= 2) {
      if (SHORT[low]) return SHORT[low];
      continue;
    }
    if (PASS.has(low)) continue;
    return asName(w).slice(0, 20);
  }
  return '';
}

/** The nickname, made different from the names already on the team: "Qwen", then "Qwen 2", "Qwen 3". */
export function freeNickname(name: string, taken: Iterable<string>): string {
  const nick = nickname(name);
  if (!nick) return '';
  const used = new Set([...taken].map(t => t.trim().toLowerCase()));
  if (!used.has(nick.toLowerCase())) return nick;
  for (let n = 2; ; n++) if (!used.has(`${nick} ${n}`.toLowerCase())) return `${nick} ${n}`;
}
