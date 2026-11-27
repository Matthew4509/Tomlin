// Pictures in a chat: a picture sent with a message goes to a model on this PC started with its vision add-on (an mmproj
// file beside it), as an image_url part of that message; a model without the add-on, or one on a linked PC, is said, not
// sent to. Fake pictures, temp folders and a fake runner only; no model is loaded. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AskPics, dataUrlOf, noVisionWords, pictureKind, pictureSize, PICTURES_HERE_ONLY, PIC_MAX_BYTES, readPicture, withPictures } from '../src/askpics.ts';
import { visionFileOf, visionPathFor } from '../src/capabilities.ts';
import { chatArgs, VISION_FAULT } from '../src/llama.ts';
import { streamChat } from '../src/engine.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest of a jpeg')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const url = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

test('a picture from the page: PNG and JPEG taken, by their bytes; WebP, a wrong type, junk and an oversize one said in words', () => {
  assert.equal(readPicture(undefined), null);
  assert.equal(readPicture(''), null);
  const png = readPicture(url('image/png', PNG));
  assert.ok(png && !('error' in png));
  assert.equal(png.mime, 'image/png');
  assert.deepEqual(png.data, PNG);
  const jpeg = readPicture(url('image/jpeg', JPEG));
  assert.ok(jpeg && !('error' in jpeg) && jpeg.mime === 'image/jpeg');
  assert.equal(pictureKind(WEBP), 'image/webp');
  // The model runner cannot read WebP: the page makes it a PNG first, and one sent as it is, is not taken.
  assert.ok(readPicture(url('image/webp', WEBP)) && 'error' in readPicture(url('image/webp', WEBP))!);
  // A type that is not what its bytes are.
  assert.match((readPicture(url('image/png', JPEG)) as { error: string }).error, /not the picture it says it is/);
  assert.match((readPicture('data:text/html;base64,PGI+') as { error: string }).error, /PNG, JPEG or WebP/);
  assert.match((readPicture(42) as { error: string }).error, /could not be read/);
  const big = Buffer.concat([PNG, Buffer.alloc(PIC_MAX_BYTES + 10)]);
  assert.match((readPicture(url('image/png', big)) as { error: string }).error, /too large/);
});

test('the turns sent: each picture on the person\'s message it came with, before its words; one folded away is left out', () => {
  const turns = [
    { role: 'system', content: 'You are TOMLIN.' },
    { role: 'user', content: 'What is in this picture?' },
    { role: 'assistant', content: 'A red bicycle.' },
    { role: 'user', content: 'What colour is the seat?' },
  ];
  assert.equal(withPictures(turns, []), turns);
  const sent = withPictures(turns, [{ text: 'What is in this picture?', url: 'data:image/png;base64,AAA' }, { text: 'an old message no longer sent', url: 'data:image/png;base64,BBB' }]);
  assert.deepEqual(sent[1], { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }, { type: 'text', text: 'What is in this picture?' }] });
  assert.deepEqual([sent[0], sent[2], sent[3]], [turns[0], turns[2], turns[3]]);
  assert.equal(JSON.stringify(sent).includes('BBB'), false);
  // Two messages with the same words: the latest one takes it (the one just sent).
  const twice = withPictures([{ role: 'user', content: 'Look' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'Look' }], [{ text: 'Look', url: 'u' }]);
  assert.equal(typeof twice[0].content, 'string');
  assert.ok(Array.isArray(twice[2].content));
  // A system line joined into the first message (some models' templates): found inside it.
  const joined = withPictures([{ role: 'user', content: 'You are TOMLIN.\n\nWhat is this?' }], [{ text: 'What is this?', url: 'u' }]);
  assert.deepEqual(joined[0].content, [{ type: 'image_url', image_url: { url: 'u' } }, { type: 'text', text: 'You are TOMLIN.\n\nWhat is this?' }]);
});

test('kept beside the chat: saved, read back by its name only, gone with the chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-askpics-'));
  try {
    const pics = new AskPics(dir);
    const chat = 'abcdef012345';
    const name = await pics.save(chat, { mime: 'image/png', data: PNG });
    assert.match(name, /^[a-f0-9]{12}\.png$/);
    assert.deepEqual(await pics.read(chat, name), { mime: 'image/png', data: PNG });
    assert.equal(dataUrlOf({ mime: 'image/png', data: PNG }), url('image/png', PNG));
    // Only a name save gives, in a real chat's folder: no path can reach outside it.
    assert.equal(await pics.read(chat, '../../secret.png'), null);
    assert.equal(await pics.read('..', name), null);
    assert.equal(await pics.read(chat, 'aaaaaaaaaaaa.png'), null);
    await assert.rejects(pics.save('../x', { mime: 'image/png', data: PNG }));
    await pics.drop(chat);
    assert.equal(await pics.read(chat, name), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the words: the model is named and the vision add-on said; a linked PC says pictures go only to a model here', () => {
  assert.match(noVisionWords('Llama-3.2-3B-Q4_K_M'), /^Llama-3\.2-3B-Q4_K_M cannot look at pictures: it needs a vision add-on \(an mmproj file in the same folder as the model\)/);
  assert.match(noVisionWords('Gemma-3-4B', true), /would not start with its vision add-on/);
  assert.match(noVisionWords(''), /^This model/);
  assert.match(PICTURES_HERE_ONLY, /^Pictures go only to a model on this PC for now\./);
});

test('the vision add-on beside a model: found by its name (F16 before F32), a general one when the folder holds one model', async () => {
  assert.equal(visionFileOf('Qwen2.5-VL-7B-Q4_K_M.gguf', ['Qwen2.5-VL-7B-Q4_K_M.gguf', 'mmproj-Qwen2.5-VL-7B-F32.gguf', 'mmproj-Qwen2.5-VL-7B-F16.gguf']), 'mmproj-Qwen2.5-VL-7B-F16.gguf');
  assert.equal(visionFileOf('gemma-3-4b-it-Q4_K_M.gguf', ['gemma-3-4b-it-Q4_K_M.gguf', 'mmproj-F16.gguf']), 'mmproj-F16.gguf');
  assert.equal(visionFileOf('a-Q4_K_M.gguf', ['a-Q4_K_M.gguf', 'b-Q4_K_M.gguf', 'mmproj-F16.gguf']), null);
  assert.equal(visionFileOf('m.gguf', ['m.gguf', 'mmproj.txt']), null);
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-vision-'));
  try {
    await writeFile(join(dir, 'gemma-3-4b-it-Q4_K_M.gguf'), 'x');
    assert.equal(visionPathFor(join(dir, 'gemma-3-4b-it-Q4_K_M.gguf')), null);
    await writeFile(join(dir, 'mmproj-F16.gguf'), 'x');
    assert.equal(visionPathFor(join(dir, 'gemma-3-4b-it-Q4_K_M.gguf')), join(dir, 'mmproj-F16.gguf'));
    assert.equal(visionPathFor(join(dir, 'gone', 'm.gguf')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the runner: started with --mmproj only when the model has its add-on; a start that fails on it is known', () => {
  const run = { ctx: 8192, cache: 'f16' as const, place: 'auto' as const };
  const plain = chatArgs('m.gguf', 9000, 'cpu', 4, false, run);
  assert.equal(plain.includes('--mmproj'), false);
  const seeing = chatArgs('m.gguf', 9000, 'cpu', 4, false, { ...run, mmproj: 'C:\\models\\mmproj-F16.gguf' });
  assert.deepEqual(seeing.slice(seeing.indexOf('--mmproj'), seeing.indexOf('--mmproj') + 2), ['--mmproj', 'C:\\models\\mmproj-F16.gguf']);
  // Everything else as before.
  assert.deepEqual(seeing.filter(a => a !== '--mmproj' && a !== 'C:\\models\\mmproj-F16.gguf'), plain);
  assert.ok(VISION_FAULT.test('srv    load_model: failed to load multimodal model, \'mmproj-F16.gguf\''));
  assert.equal(VISION_FAULT.test('llama_model_load: error loading model: failed to read tensor info'), false);
});

test('the stream client: pictures go to llama-server as image_url parts of the message; none, and the body is as before', async () => {
  const asked: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      asked.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A bicycle.' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const pic = url('image/png', PNG);
    const r = await streamChat(base, 'gemma-3-4b-it-Q4_K_M.gguf', [{ role: 'user', content: 'What is in this picture?' }], () => undefined, new AbortController().signal, 64, { pictures: [{ text: 'What is in this picture?', url: pic }] });
    assert.equal(r.text, 'A bicycle.');
    assert.deepEqual(asked[0].messages.at(-1), { role: 'user', content: [{ type: 'image_url', image_url: { url: pic } }, { type: 'text', text: 'What is in this picture?' }] });
    await streamChat(base, 'gemma-3-4b-it-Q4_K_M.gguf', [{ role: 'user', content: 'hi' }], () => undefined, new AbortController().signal, 64);
    assert.equal(asked[1].messages.at(-1)!.content, 'hi');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('the server: the add-on started with the model, a bad one dropped, pictures checked here and never sent to a linked PC', async () => {
  const panes = await readFile(new URL('../src/server/panes.ts', import.meta.url), 'utf8');
  assert.match(panes, /const mmproj = visionPathFor\(path\);/);
  assert.match(panes, /\.\.\.\(mmproj \? \{ mmproj \} : \{\}\)/);
  assert.match(panes, /started\.mmproj && VISION_FAULT\.test\(tail\) && !TEMPLATE_FAULT\.test\(tail\)/);
  assert.match(panes, /runnerSees\.set\(runner, !!r\.mmproj\)/);
  const chat = await readFile(new URL('../src/server/chat.ts', import.meta.url), 'utf8');
  assert.match(chat, /const pic = readPicture\(b\.picture\);/);
  assert.match(chat, /'\/api\/chat\/sees'/);
  assert.match(chat, /'\/api\/chat\/pic'/);
  assert.match(chat, /const why = target && !target\.here \? PICTURES_HERE_ONLY : seesPictures\(runner\)/);
  assert.match(chat, /const pictures = \(!target \|\| target\.here\) && mode !== 'handoff' && seesPictures\(runner\)/);
  // Only the call to the runner here carries them: the linked PC's brain never does.
  assert.equal((chat.match(/\.\.\.\(pictures\.length \? \{ pictures \} : \{\}\)/g) ?? []).length, 1);
  for (const line of chat.split('\n').filter(l => l.includes('target.brain.chat('))) assert.equal(line.includes('pictures'), false);
  const people = await readFile(new URL('../src/server/people.ts', import.meta.url), 'utf8');
  assert.match(people, /await askPics\.drop\(c\.id\);/);
});

test('the page: a picture button, paste and drop, the reason shown instead of sending, and Ask about this picture in the gallery', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="pic-add"[^>]*aria-label="Add a picture"/);
  assert.match(html, /id="pic-file" accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(html, /id="chat-pic" role="status" hidden/);
  const view = await readFile(new URL('../public/chatview.js', import.meta.url), 'utf8');
  assert.match(view, /api\('\/api\/chat\/sees'/);
  assert.match(view, /input\.addEventListener\('paste'/);
  assert.match(view, /const PIC_SIDE = 1024;/);
  assert.match(view, /canvas\.toDataURL\('image\/png'\)/);
  assert.match(view, /if \(pendingPic\) return void sendWithPicture\(message, card, who, remember\);/);
  assert.match(view, /if \(why\) \{\r?\n    pic\.why = why;\r?\n    drawPic\(\);\r?\n    return app\.chatNote\(why\);/);
  assert.match(view, /\.\.\.\(picture \? \{ picture \} : \{\}\)/);
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const pic = files\.find\(f => app\.isPictureFile\?\.\(f\)\);/);
  assert.match(app, /l\.attached && chat\?\.id \? sentPic\(sentPicUrl\(chat\.id, l\.attached\.file\)\)/);
  const images = await readFile(new URL('../public/images.js', import.meta.url), 'utf8');
  assert.equal((images.match(/app\.askAboutPicture\?\.\(fileUrl\(p\.output\), p\.prompt\)/g) ?? []).length, 2);
  const chats = await readFile(new URL('../public/chats.js', import.meta.url), 'utf8');
  assert.match(chats, /app\.askAboutPicture = async/);
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-pic-pending \{[^}]*font-size: var\(--fs-sm\)/);
});

test('a JPEG whose frame header claims 60,000 x 60,000 is refused in words; a usual size is taken', () => {
  const sof = (w: number, h: number) => Buffer.from([0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, ...Array(9).fill(0)]);
  const jpeg = (w: number, h: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), sof(w, h), Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(pictureSize(jpeg(1024, 768)), { width: 1024, height: 768 });
  const ok = readPicture(url('image/jpeg', jpeg(1024, 768)));
  assert.ok(ok && !('error' in ok));
  const huge = readPicture(url('image/jpeg', jpeg(60_000, 60_000)));
  assert.ok(huge && 'error' in huge && /too large to look at/.test(huge.error));
});
