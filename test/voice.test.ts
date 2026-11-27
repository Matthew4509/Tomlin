// Voice-overs' plain parts (src/voice.ts, src/phonemes.ts): the WAV header, lines and sentences, numbers in words,
// the sound symbols and Kokoro's numbers for them, parts of a long sentence, the voice row picked, the model's file
// list, and the page's Voice window (public/voice.js, public/index.html). No model is run: speak() uses a pretend engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAUSE, SPEEDS, STYLE_ROWS, STYLE_SIZE, SYMBOLS_MAX, VOICES, VOICE_MODEL_ID, VOICE_RATE, cleanSpeak, linesOf, pieces, sentences, speak, speechPlan, styleOf, tokensOf, wavFile } from '../src/voice.ts';
import { numberWords, ordinalWords, phonemize, ruleSounds, sayInWords, toKokoro, withStress, wordSounds, yearWords } from '../src/phonemes.ts';
import { stamp, voicePath } from '../src/folders.ts';
import { FakeVoiceEngine } from './fakevoice.ts';

const root = join(import.meta.dirname, '..');

test('a WAV is mono 16-bit PCM at the rate given, with the samples clipped to the 16-bit range', () => {
  const w = wavFile(Float32Array.of(0, 1, -1, 0.5, 2, -3, Number.NaN), 24_000);
  assert.equal(w.length, 44 + 7 * 2);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(4), 36 + 14);
  assert.equal(w.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(w.readUInt32LE(16), 16);
  assert.equal(w.readUInt16LE(20), 1, 'PCM');
  assert.equal(w.readUInt16LE(22), 1, 'mono');
  assert.equal(w.readUInt32LE(24), 24_000);
  assert.equal(w.readUInt32LE(28), 48_000, 'bytes a second');
  assert.equal(w.readUInt16LE(32), 2);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.toString('ascii', 36, 40), 'data');
  assert.equal(w.readUInt32LE(40), 14);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(i => w.readInt16LE(44 + i * 2)), [0, 32767, -32768, 16384, 32767, -32768, 0]);
});

test('lines, then sentences: blank lines go, each sentence keeps its end mark', () => {
  assert.deepEqual(linesOf('  First line.\n\n\nSecond line  \n'), ['First line.', 'Second line']);
  assert.deepEqual(sentences('Hi there. How are you? Fine!'), ['Hi there.', 'How are you?', 'Fine!']);
  assert.deepEqual(sentences('No end mark'), ['No end mark']);
  assert.deepEqual(sentences('"Quoted." Then this… and more'), ['"Quoted."', 'Then this…', 'and more']);
  assert.deepEqual(sentences('...'), []);
});

test('numbers, money, times and short forms are said in words before the text is split', () => {
  assert.equal(numberWords(0), 'zero');
  assert.equal(numberWords(42), 'forty two');
  assert.equal(numberWords(105), 'one hundred and five');
  assert.equal(numberWords(1_250_000), 'one million two hundred and fifty thousand');
  assert.equal(yearWords(1999), 'nineteen ninety nine');
  assert.equal(yearWords(2005), 'two thousand and five');
  assert.equal(yearWords(2026), 'twenty twenty six');
  assert.equal(yearWords(1900), 'nineteen hundred');
  assert.equal(ordinalWords('twenty one'), 'twenty first');
  assert.equal(ordinalWords('forty'), 'fortieth');
  assert.equal(sayInWords('Dr. Smith paid $3.50 at 10:30.'), 'doctor Smith paid three dollars and fifty cents at ten thirty.');
  assert.equal(sayInWords('It rose 25% in 1999, on the 3rd.'), 'It rose twenty five percent in nineteen ninety nine, on the third.');
  assert.equal(sayInWords('1,200 people and 3.14 more'), 'one thousand two hundred people and three point one four more');
  assert.equal(sayInWords('Wait... now -- go'), 'Wait… now — go');
  // "Dr." no longer ends a sentence.
  assert.deepEqual(sentences(sayInWords('Dr. Who came. He left.')), ['doctor Who came.', 'He left.']);
});

test('words become Kokoro\'s symbols: listed words, endings on them, spelled capitals and the rules with stress', () => {
  assert.equal(toKokoro(['HH', 'AH0', 'L', 'OW1']), 'həlˈO');
  assert.equal(phonemize('Hello world.'), 'həlˈO wˈɜɹld.');
  assert.deepEqual(wordSounds('people\'s'), ['P', 'IY1', 'P', 'AH0', 'L', 'Z']);
  assert.deepEqual(wordSounds('looked'), ['L', 'UH1', 'K', 'T']);
  assert.deepEqual(wordSounds('TV'), ['T', 'IY1', 'V', 'IY1']);
  // A word not listed goes through the rules: one stressed vowel, a doubled letter said once.
  const apples = wordSounds('apples');
  assert.deepEqual(apples, ['AE1', 'P', 'AH0', 'L', 'Z']);
  assert.ok(!ruleSounds('little').join(' ').includes('T T'));
  // -tion takes the stress on the syllable before it.
  assert.match(toKokoro(wordSounds('nation')), /^nˈA/);
  assert.match(toKokoro(wordSounds('information')), /mˈAʃ/);
  // Every word gives at least one vowel with a stress mark.
  for (const w of ['sunset', 'lighthouse', 'mountains', 'wonderful', 'unexpected', 'remarkable', 'photography']) assert.match(toKokoro(wordSounds(w)), /ˈ/, w);
  assert.deepEqual(withStress('x', []), []);
});

test('only punctuation Kokoro knows is kept, never at the start or twice running; brackets become commas', () => {
  assert.equal(phonemize(', , hello (there) !'), 'həlˈO, ðɛɹ!');
  assert.equal(phonemize('#*~'), '');
});

test('every symbol the phoneme step makes is one of Kokoro\'s, and each has its number', () => {
  const s = phonemize(sayInWords('The quick brown fox jumps over the lazy dog; she sells sea shells, judge, measure, thing, ring, church, 1st and 2nd. Wow! Really? Yes…'));
  const t = tokensOf(s);
  assert.equal(t.length, [...s].length, 'no symbol dropped');
  assert.ok(t.every(n => Number.isInteger(n) && n > 0 && n < 178));
  assert.equal(tokensOf(' ')[0], 16);
  assert.equal(tokensOf('ˈ')[0], 156);
  assert.deepEqual(tokensOf('a#b'), [43, 44], 'an unknown symbol is left out');
});

test('a long sentence is read in parts of at most SYMBOLS_MAX, cut after a comma when there is one', () => {
  const long = Array.from({ length: 60 }, (_, i) => `wˈɜɹd${i % 10}`).join(' ');
  const parts = pieces(`${long}, ${long}`);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every(p => p.length <= SYMBOLS_MAX && p.length > 0));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), `${long}, ${long}`.replace(/\s+/g, ' '));
  assert.deepEqual(pieces(''), []);
  assert.deepEqual(pieces('short'), ['short']);
});

test('the plan pauses after each sentence and longer after each line, nothing after the last', () => {
  const plan = speechPlan('One. Two.\nThree.');
  assert.deepEqual(plan.map(p => p.pause), [PAUSE.sentence, PAUSE.line, 0]);
  assert.ok(plan.every(p => p.symbols && p.symbols.length <= SYMBOLS_MAX));
  assert.deepEqual(speechPlan('  \n \n'), []);
});

test('speak reads each part in turn with the voice and speed asked, and puts the pauses between', async () => {
  const e = new FakeVoiceEngine();
  const plan = speechPlan('Hello there.\nGoodbye.');
  const samples = await speak(plan, e, 'am_adam', 1.1);
  assert.equal(e.asked.length, 2);
  assert.ok(e.asked.every(a => a.voice === 'am_adam' && a.speed === 1.1));
  const said = e.asked.reduce((n, a) => n + Math.round((a.tokens.length * 60) / 1.1), 0);
  assert.equal(samples.length, said + Math.round(PAUSE.line * e.rate));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(speak(plan, e, 'am_adam', 1, ac.signal), /Stopped/);
});

test('the voice row is picked by the part\'s length, the last row for anything longer', () => {
  const v = new Float32Array(STYLE_ROWS * STYLE_SIZE).map((_, i) => Math.floor(i / STYLE_SIZE));
  assert.equal(styleOf(v, 0)[0], 0);
  assert.equal(styleOf(v, 12)[0], 12);
  assert.equal(styleOf(v, 12).length, STYLE_SIZE);
  assert.equal(styleOf(v, 10_000)[0], STYLE_ROWS - 1);
});

test('what Speak sends is checked: text needed and not too long; an unknown voice or speed falls back', () => {
  assert.deepEqual(cleanSpeak({ text: '  ' }), { error: 'Type a line to read first.' });
  assert.match((cleanSpeak({ text: 'x'.repeat(6000) }) as { error: string }).error, /too long/);
  assert.deepEqual(cleanSpeak({ text: ' Hi \r\n there ', voice: 'nobody', speed: 7 }), { text: 'Hi \n there', voice: VOICES[0].id, speed: 1 });
  assert.deepEqual(cleanSpeak({ text: 'Hi', voice: 'am_fenrir', speed: '1.25' }), { text: 'Hi', voice: 'am_fenrir', speed: 1.25 });
  assert.ok(SPEEDS.some(s => s.id === 1));
  assert.equal(VOICE_RATE, 24_000);
});

test('the voice model is a helper in the registry: one ONNX file and a file for each voice, pinned and checked', () => {
  const m = JSON.parse(readFileSync(join(root, 'registry', `${VOICE_MODEL_ID}.json`), 'utf8'));
  assert.equal(m.kind, 'helper');
  assert.match(m.licence, /Apache-2\.0/);
  const onnx = m.files.filter((f: { role: string }) => f.role === 'onnx');
  assert.equal(onnx.length, 1);
  for (const f of m.files) {
    assert.match(f.rev, /^[0-9a-f]{40}$/);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.bytes > 0);
    assert.ok(f.saveAs.startsWith('kokoro-'), 'never a plain name that another helper could have');
  }
  const voices = m.files.filter((f: { role: string }) => f.role === 'voice');
  assert.deepEqual(voices.map((f: { name: string }) => f.name).sort(), VOICES.map(v => v.id).sort());
  assert.ok(voices.every((f: { bytes: number }) => f.bytes === STYLE_ROWS * STYLE_SIZE * 4));
});

test('a voice-over made from a project chat goes in its specialists\\voice folder', () => {
  const at = new Date(2026, 10, 27, 9, 5);
  assert.equal(voicePath('Film', 'The waves come in slowly', '.wav', at).replace(/\\/g, '/'), `Film/specialists/voice/${stamp(at)} The waves come in slowly.wav`);
});

test('the page: a Voice window with the text, voice, speed and Speak; opened beside Videos and from the gallery\'s Voice shelf', () => {
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const js = readFileSync(join(root, 'public', 'voice.js'), 'utf8');
  for (const id of ['voice-dlg', 'voice-text', 'voice-pick', 'voice-speed', 'voice-speak', 'voice-list', 'voice-get', 'voice-open']) assert.equal(html.split(`id="${id}"`).length, 2, id);
  assert.match(html, /data-shelf="videos"[^\n]*\n\s*<button class="g-shelf" type="button" data-shelf="voice"/);
  assert.match(html, /id="clip-shelf-open"[^\n]*\n\s*<button[^>]*id="voice-open"/);
  assert.ok(html.indexOf('<script src="voice.js">') > html.indexOf('<script src="clips.js">'));
  // The player, Save a copy and the project copy go through the server; the model download is the Models page's own.
  assert.match(js, /el\('audio'/);
  assert.match(js, /download: voiceFileName/);
  assert.match(js, /\/api\/voice\/speak/);
  assert.match(js, /\/api\/downloads\/start/);
  assert.match(js, /chat: voiceChat/);
  const images = readFileSync(join(root, 'public', 'images.js'), 'utf8');
  assert.match(images, /shelf === 'voice'[\s\S]*drawVoiceShelf/);
  const css = readFileSync(join(root, 'public', 'style.css'), 'utf8');
  const voiceCss = css.split('\n').filter(l => /voice/.test(l)).join('\n');
  assert.ok(!/font-size:\s*(?:[0-9]|1[01])px/.test(voiceCss), 'no font under 12px');
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(voiceCss), 'colours by name, from the theme');
});
