// The shot list (src/shots.ts): shots made in order on the hire's PC through src/clips.ts, Make 3 and Keep this one,
// a failed shot tried once more then passed, the busy fault holding the list, Pause, Stop, Start at, the Draft pass and
// the kept ones at Normal from the same seed, carry on from the shot before, the list saved and carried on after a
// restart, and the time left from the PC's own measured speed. Uses the pretend runner in test/fakeclip.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Clips, progressLine } from '../src/clips.ts';
import { ClipShelf } from '../src/gallery.ts';
import { HELD_MS, Shots, TRIES, WAIT_PAGE, cleanShot, durationWords, listWords, type ShotList, type StartPictures } from '../src/shots.ts';
import { VideoFault, type VideoJob, type VideoProgress, type VideoRunner } from '../src/videotypes.ts';
import { FakeVideoRunner } from './fakeclip.ts';

const GB = 2 ** 30;
const hire: Pick<ShotList, 'who' | 'name' | 'pc' | 'pcName' | 'model'> = { who: 'staff:v1', name: 'Vic', pc: 'here', pcName: 'Worker PC', model: 'wan-1.3b' };

async function rig(runner: VideoRunner, o: { now?: () => number; starts?: StartPictures; dir?: string } = {}) {
  const dir = o.dir ?? await mkdtemp(join(tmpdir(), 'tomlin-shots-'));
  const shelf = new ClipShelf(join(dir, 'videos'));
  const clips = new Clips({ runner: () => runner, shelf, free: async () => 50 * GB, saveLine: async () => undefined, now: o.now });
  let seed = 100;
  const make = () => Shots.load({ file: join(dir, 'shots.json'), clips, now: o.now, starts: o.starts ?? { give: async ask => ({ ask }) }, seed: () => ++seed });
  const shots = await make();
  return { dir, clips, shots, make, done: () => rm(dir, { recursive: true, force: true }) };
}

/** Turns the list until `ok` holds. */
async function until(shots: Shots, ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1500; i++) {
    shots.turn();
    await shots.settled();
    if (ok()) return;
    await new Promise(r => setTimeout(r, 4));
  }
  throw new Error(`never: ${what}`);
}

const add = async (shots: Shots, prompt: string, extra: Record<string, unknown> = {}) => {
  const s = await shots.add('c1', hire, { prompt, seconds: 2, size: 'wide', quality: 'normal', ...extra });
  assert.ok(!('refused' in s), 'the shot was added');
  return s as Exclude<typeof s, { refused: string }>;
};
const list = (shots: Shots) => shots.get('c1')!;

test('a shot is made safe: words, 1 to 5 seconds, a size, a quality, a start', () => {
  assert.deepEqual(cleanShot({ prompt: ' a  fox ', seconds: 9, size: 'tall', quality: 'best', start: { kind: 'last' } }), { prompt: 'a fox', seconds: 5, size: 'tall', quality: 'best', start: { kind: 'last' } });
  assert.deepEqual(cleanShot({ prompt: 'a fox', size: 'huge', quality: 'ultra', start: { kind: 'lots' } }), { prompt: 'a fox', seconds: 3, size: 'wide', quality: 'normal', start: { kind: 'none' } });
  assert.match((cleanShot({ prompt: '  ' }) as { refused: string }).refused, /what the shot should show/);
  assert.match((cleanShot({ prompt: 'x'.repeat(1001) }) as { refused: string }).refused, /too long/);
});

test('durations and lists in words', () => {
  assert.equal(durationWords(20), 'under a minute');
  assert.equal(durationWords(45 * 60), '45 min');
  assert.equal(durationWords(3 * 3600 + 20 * 60), '3 h 20 min');
  assert.equal(durationWords(2 * 3600), '2 h');
  assert.equal(durationWords(9 * 86_400 + 2 * 3600), '9 days 2 h');
  assert.equal(durationWords(86_400), '1 day');
  assert.equal(listWords(['4']), '4');
  assert.equal(listWords(['4', '9']), '4 and 9');
  assert.equal(listWords(['2', '4', '9']), '2, 4 and 9');
});

test('shots are made in order, one at a time, then the list says it is done; the time comes from the measured speed', async () => {
  const runner = new FakeVideoRunner({ fps: 2, frameMs: 3 });
  const r = await rig(runner);
  try {
    await add(r.shots, 'one');
    await add(r.shots, 'two', { seconds: 1 });
    await add(r.shots, 'three');
    let v = r.shots.view('c1', progressLine)!;
    assert.equal(v.top, '3 shots · 5 s of video · time not known yet on Worker PC');
    assert.equal(v.left, null);
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).run === 'idle', 'the list ended');
    assert.deepEqual(runner.made.map(j => j.prompt), ['one', 'two', 'three']);
    assert.deepEqual(runner.made.map(j => j.seed), [101, 102, 103], 'each take has its own seed');
    assert.ok(list(r.shots).shots.every(s => s.state === 'done' && s.takes.length === 1));
    assert.equal(list(r.shots).said, 'Done: 3 of 3 shots made.');
    // After clips are made the PC's speed is known: a new shot has a time.
    await add(r.shots, 'four', { seconds: 3 });
    v = r.shots.view('c1', progressLine)!;
    assert.match(v.top, /^4 shots · 8 s of video · (under a minute|about \d+ min) on Worker PC$/);
    assert.notEqual(v.left, null);
    // The list is saved whole, with the rolling speed.
    const saved = JSON.parse(await readFile(join(r.dir, 'shots.json'), 'utf8'));
    assert.equal(saved.lists.c1.shots.length, 4);
    assert.equal(saved.speeds['here|wan-1.3b'].perStepSecond.length, 3);
  } finally {
    await r.done();
  }
});

test('the time left is the measured seconds per step times the steps and the seconds of each shot', async () => {
  let t = 0;
  // A runner whose clips take 660 s for a 3 s clip of 20 steps (11 min, as measured on an RTX 3060).
  const slow: VideoRunner = {
    installed: async () => true,
    make: async (job: VideoJob, on: (p: VideoProgress) => void) => {
      const steps = { draft: 12, normal: 20, best: 30 }[job.quality];
      on({ stage: 'making', done: steps, total: steps, secondsLeft: 0 });
      const f = new FakeVideoRunner();
      const c = await f.make({ ...job, seconds: 1 }, () => undefined, new AbortController().signal);
      return { ...c, seconds: job.seconds, tookMs: 660_000 * (job.seconds / 3) * (steps / 20) };
    },
  };
  const r = await rig(slow, { now: () => t });
  try {
    await add(r.shots, 'first', { seconds: 3 });
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).run === 'idle', 'the first shot made');
    for (let i = 0; i < 18; i++) await add(r.shots, `shot ${i}`, { seconds: 3 });
    const v = r.shots.view('c1', progressLine)!;
    assert.equal(v.left, 18 * 660);
    assert.equal(v.top, '19 shots · 57 s of video · about 3 h 20 min on Worker PC');
    // At Draft (12 steps) the same shots take 12/20 of that.
    list(r.shots).draft = true;
    assert.equal(r.shots.view('c1', progressLine)!.left, Math.round(18 * 660 * 12 / 20));
  } finally {
    await r.done();
  }
});

test('Make 3 makes three takes with new seeds; Keep this one picks one; Redo makes one again', async () => {
  const runner = new FakeVideoRunner({ fps: 2 });
  const r = await rig(runner);
  try {
    const s = await add(r.shots, 'a fox');
    await r.shots.redo('c1', s.id, 3);
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).run === 'idle', 'three takes made');
    const shot = list(r.shots).shots[0];
    assert.equal(shot.takes.length, 3);
    assert.equal(new Set(shot.takes.map(t => t.seed)).size, 3);
    assert.equal(shot.kept, null);
    assert.ok('refused' in (await r.shots.keep('c1', s.id, 'nope')));
    await r.shots.keep('c1', s.id, shot.takes[1].clip);
    assert.equal(list(r.shots).shots[0].kept, shot.takes[1].clip);
    await r.shots.redo('c1', s.id);
    assert.equal(list(r.shots).shots[0].takes.length, 0, 'the old takes stay on the Videos shelf only');
    assert.equal(list(r.shots).shots[0].state, 'waiting');
  } finally {
    await r.done();
  }
});

test('a failed shot is tried once more, then the list moves on and says which failed', async () => {
  let calls = 0;
  const inner = new FakeVideoRunner({ fps: 2 });
  const flaky: VideoRunner = {
    installed: async () => true,
    make: async (job, on, signal) => {
      calls++;
      if (job.prompt === 'bad') throw new VideoFault('out-of-memory', '');
      return inner.make(job, on, signal);
    },
  };
  const r = await rig(flaky);
  try {
    await add(r.shots, 'good');
    await add(r.shots, 'bad');
    await add(r.shots, 'last');
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).run === 'idle', 'the list ended');
    const [a, b, c] = list(r.shots).shots;
    assert.equal(a.state, 'done');
    assert.equal(b.state, 'failed');
    assert.equal(b.tries, TRIES);
    assert.match(b.error ?? '', /ran out of memory/);
    assert.equal(c.state, 'done');
    assert.equal(calls, 4, 'the bad shot was asked twice');
    assert.equal(list(r.shots).said, 'Done: 2 of 3 shots made. Shot 2 failed: see its line, then press Redo.');
  } finally {
    await r.done();
  }
});

test('the PC\'s owner using it (the busy fault) holds the list, without counting a try, and it carries on after', async () => {
  let t = 1_000_000;
  let busy = true;
  const inner = new FakeVideoRunner({ fps: 2 });
  const owned: VideoRunner = {
    installed: async () => true,
    make: async (job, on, signal) => {
      if (busy) throw new VideoFault('busy', 'The owner of Worker PC is using it.');
      return inner.make(job, on, signal);
    },
  };
  const r = await rig(owned, { now: () => t });
  try {
    await add(r.shots, 'one');
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).run === 'held', 'held for the owner');
    assert.equal(list(r.shots).shots[0].state, 'waiting');
    assert.equal(list(r.shots).shots[0].tries, 0);
    assert.match(list(r.shots).said, /Worker PC is being used by its owner/);
    // Still held before the wait is over; once over, it looks again and makes the shot.
    busy = false;
    t += HELD_MS - 1000;
    r.shots.turn();
    await r.shots.settled();
    assert.equal(list(r.shots).run, 'held');
    t += 2000;
    await until(r.shots, () => list(r.shots).run === 'idle', 'made after the owner was done');
    assert.equal(list(r.shots).shots[0].state, 'done');
  } finally {
    await r.done();
  }
});

test('Pause lets the shot being made finish; Stop stops it and it waits again; Start at waits for its time', async () => {
  let t = 5_000_000;
  const runner = new FakeVideoRunner({ fps: 2, frameMs: 15 });
  const r = await rig(runner, { now: () => t });
  try {
    await add(r.shots, 'one');
    await add(r.shots, 'two');
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).shots[0].state === 'making', 'the first shot started');
    await r.shots.pause('c1');
    assert.equal(list(r.shots).run, 'pausing');
    await until(r.shots, () => list(r.shots).run === 'paused', 'paused');
    assert.deepEqual(list(r.shots).shots.map(s => s.state), ['done', 'waiting']);
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).shots[1].state === 'making', 'the second shot started');
    await r.shots.stop('c1');
    assert.equal(list(r.shots).run, 'idle');
    assert.equal(list(r.shots).shots[1].state, 'waiting');
    await until(r.shots, () => runner.made.length === 2 && r.clips.running().length === 0, 'the clip stopped');
    // Start at: nothing until its time.
    await r.shots.start('c1', hire, { at: new Date(t + 3_600_000).toISOString() });
    assert.equal(list(r.shots).run, 'scheduled');
    // The PC is kept awake until then: asleep at its start time, it would never start (audit LF-09).
    assert.equal(r.shots.anyRunning(), true, 'a scheduled list keeps the PC awake');
    r.shots.turn();
    await r.shots.settled();
    assert.equal(list(r.shots).shots[1].state, 'waiting');
    t += 3_600_001;
    await until(r.shots, () => list(r.shots).run === 'idle', 'made at its time');
    assert.equal(list(r.shots).shots[1].state, 'done');
    assert.equal(r.shots.anyRunning(), false, 'an ended list lets the PC sleep');
  } finally {
    await r.done();
  }
});

test('Make all as Draft first, then the kept ones at Normal from the same seeds', async () => {
  const runner = new FakeVideoRunner({ fps: 2 });
  const r = await rig(runner);
  try {
    const a = await add(r.shots, 'one');
    const b = await add(r.shots, 'two', { quality: 'best' });
    await r.shots.redo('c1', b.id, 3);
    await r.shots.start('c1', hire, { draft: true });
    await until(r.shots, () => list(r.shots).run === 'idle', 'the draft pass ended');
    assert.ok(runner.made.every(j => j.quality === 'draft'));
    assert.equal(r.shots.view('c1', progressLine)!.upgradable, 2);
    // Shot 2 has three takes and none kept: it is left until one is picked.
    const first = await r.shots.upgrade('c1', hire);
    assert.ok(!('refused' in first));
    await until(r.shots, () => list(r.shots).run === 'idle', 'shot 1 at Normal');
    assert.match(list(r.shots).said, /Done/);
    const one = list(r.shots).shots[0];
    assert.equal(runner.made.at(-1)!.quality, 'normal');
    assert.equal(runner.made.at(-1)!.seed, one.takes[0].seed, 'the same seed as the draft');
    assert.equal(one.kept, one.takes[1].clip, 'the Normal take is the one kept');
    assert.equal(list(r.shots).shots[1].state, 'done');
    // Pick shot 2's second take: it is made at Best (what it asked), from that seed.
    const two = list(r.shots).shots[1];
    await r.shots.keep('c1', b.id, two.takes[1].clip);
    await r.shots.upgrade('c1', hire);
    await until(r.shots, () => list(r.shots).run === 'idle', 'shot 2 at Best');
    assert.equal(runner.made.at(-1)!.quality, 'best');
    assert.equal(runner.made.at(-1)!.seed, two.takes[1].seed);
    assert.ok('refused' in (await r.shots.upgrade('c1', hire)), 'nothing left at Draft');
    void a;
  } finally {
    await r.done();
  }
});

test('carry on: the list waits for the page to read the last frame of the shot before, then starts from it', async () => {
  const runner = new FakeVideoRunner({ fps: 2 });
  const given: unknown[] = [];
  const starts: StartPictures = { async give(ask, from) { given.push(from); return { ask: { ...ask, startPicture: join(tmpdir(), 'no-such-start.png') } }; } };
  const r = await rig(runner, { starts });
  try {
    const a = await add(r.shots, 'first');
    const b = await add(r.shots, 'second', { start: { kind: 'last' } });
    await add(r.shots, 'third', { start: { kind: 'picture', from: { gallery: 'g1' }, name: 'a red door', src: '/api/images/file/2026-11/a.png' } });
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).said === WAIT_PAGE, 'waiting for the page');
    // It waits: still running, nothing more made, and it names the frame the page should read.
    for (let i = 0; i < 5; i++) {
      r.shots.turn();
      await r.shots.settled();
    }
    assert.equal(list(r.shots).run, 'running');
    assert.equal(runner.made.length, 1);
    const take = list(r.shots).shots[0].takes[0];
    assert.deepEqual(r.shots.needFrames(), [{ chat: 'c1', shot: b.id, clip: take.clip, file: take.file }]);
    // A frame of another clip is refused; the right one lets the list carry on from it.
    assert.ok('refused' in (await r.shots.setFrame('c1', b.id, 'other', 'aaaaaaaaaaaaaaaa.png')));
    assert.ok('refused' in (await r.shots.setFrame('c1', a.id, take.clip, 'aaaaaaaaaaaaaaaa.png')), 'the first shot does not carry on');
    assert.deepEqual(await r.shots.setFrame('c1', b.id, take.clip, '0123456789abcdef.png'), { old: [] });
    await until(r.shots, () => list(r.shots).run === 'idle', 'the list ended');
    assert.deepEqual(list(r.shots).shots.map(s => s.state), ['done', 'done', 'done']);
    assert.deepEqual(given, [{ kept: '0123456789abcdef.png', name: 'first last frame' }, { from: { gallery: 'g1' }, name: 'a red door' }]);
    assert.equal(runner.made[1].startPicture, join(tmpdir(), 'no-such-start.png'), 'the clip is asked with its start picture');
    assert.equal(runner.made[0].startPicture, undefined);
    assert.deepEqual(r.shots.needFrames(), []);
    // Shot 1 made again: shot 2's frame is of the old take, so a new one is asked for.
    await r.shots.redo('c1', a.id);
    await r.shots.redo('c1', b.id);
    await r.shots.start('c1', hire);
    await until(r.shots, () => r.shots.needFrames().length === 1, 'a new frame asked for');
    assert.notEqual(r.shots.needFrames()[0].clip, take.clip);
    // The frame read is saved with the list.
    const saved = JSON.parse(await readFile(join(r.dir, 'shots.json'), 'utf8'));
    assert.deepEqual(saved.lists.c1.shots[1].frame, { clip: take.clip, file: '0123456789abcdef.png' });
    await r.shots.stop('c1');
  } finally {
    await r.done();
  }
});

test('a clip that really ends on a blank frame (a fade out) fails the next shot with what to do, never waits for ever', async () => {
  const r = await rig(new FakeVideoRunner({ fps: 2 }));
  try {
    await add(r.shots, 'first');
    const b = await add(r.shots, 'second', { start: { kind: 'last' } });
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).said === WAIT_PAGE, 'waiting for the last frame');
    const take = list(r.shots).shots[0].takes[0];
    // A clip that is not the one before changes nothing.
    await r.shots.blankEnd('c1', b.id, 'other-clip', 2);
    assert.equal(list(r.shots).shots[1].state, 'waiting');
    await r.shots.blankEnd('c1', b.id, take.clip, 2);
    assert.equal(list(r.shots).shots[1].state, 'failed');
    assert.match(String(list(r.shots).shots[1].error), /^Shot 1 ends on a blank frame .* Press Redo on shot 1, or give shot 2 another start\.$/);
    await until(r.shots, () => list(r.shots).run === 'idle', 'the list ended');
    assert.deepEqual(r.shots.needFrames(), []);
  } finally {
    await r.done();
  }
});

test('a shot carrying on with no clip before, or a start picture refused, fails plainly and the list moves on', async () => {
  const runner = new FakeVideoRunner({ fps: 2 });
  const starts: StartPictures = { async give() { return { refused: 'Wan 2.1 makes clips from words only.' }; } };
  const r = await rig(runner, { starts });
  try {
    await add(r.shots, 'first', { start: { kind: 'last' } });
    await add(r.shots, 'second', { start: { kind: 'picture', file: '0123456789abcdef.png', name: 'door' } });
    await add(r.shots, 'third');
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).run === 'idle', 'the list ended');
    const [a, b, c] = list(r.shots).shots;
    assert.equal(a.state, 'failed');
    assert.match(a.error ?? '', /it is the first shot/);
    assert.equal(b.state, 'failed');
    assert.equal(b.error, 'Wan 2.1 makes clips from words only.');
    assert.equal(b.tries, TRIES, 'not tried again');
    assert.equal(c.state, 'done');
    assert.deepEqual(runner.made.map(j => j.prompt), ['third']);
    assert.equal(list(r.shots).said, 'Done: 1 of 3 shots made. Shot 1 and 2 failed: see their lines, then press Redo.');
  } finally {
    await r.done();
  }
});

test('a start picture is one kept for the list, or one in the gallery or a project; anything else is refused', () => {
  assert.deepEqual((cleanShot({ prompt: 'a', start: { kind: 'picture', file: '0123456789abcdef.png', name: ' a  door ', src: '/api/shots/picture?f=0123456789abcdef.png' } }) as { start: unknown }).start, { kind: 'picture', file: '0123456789abcdef.png', name: 'a door', src: '/api/shots/picture?f=0123456789abcdef.png' });
  assert.deepEqual((cleanShot({ prompt: 'a', start: { kind: 'picture', from: { project: 'site/specialists/images/x.png' }, name: 'x', src: 'javascript:alert(1)' } }) as { start: unknown }).start, { kind: 'picture', from: { project: 'site/specialists/images/x.png' }, name: 'x' });
  assert.match((cleanShot({ prompt: 'a', start: { kind: 'picture', file: '../../shots.json' } }) as { refused: string }).refused, /not on this PC/);
  assert.match((cleanShot({ prompt: 'a', start: { kind: 'picture', from: { project: 'notes.txt' } } }) as { refused: string }).refused, /not on this PC/);
});

test('edit, move, skip and delete; a shot being made cannot be edited or skipped', async () => {
  const runner = new FakeVideoRunner({ fps: 2, frameMs: 20 });
  const r = await rig(runner);
  try {
    const a = await add(r.shots, 'one');
    const b = await add(r.shots, 'two');
    const c = await add(r.shots, 'three');
    await r.shots.move('c1', c.id, 0);
    assert.deepEqual(list(r.shots).shots.map(s => s.prompt), ['three', 'one', 'two']);
    await r.shots.move('c1', c.id, 99);
    assert.deepEqual(list(r.shots).shots.map(s => s.prompt), ['one', 'two', 'three']);
    const e = await r.shots.edit('c1', b.id, { prompt: 'two again', seconds: 4, size: 'tall' });
    assert.ok(!('refused' in e));
    assert.equal(list(r.shots).shots[1].prompt, 'two again');
    assert.equal(list(r.shots).shots[1].size, 'tall');
    assert.ok('refused' in (await r.shots.edit('c1', b.id, { prompt: '' })));
    await r.shots.skip('c1', b.id);
    assert.equal(list(r.shots).shots[1].state, 'skipped');
    assert.match(r.shots.view('c1', progressLine)!.top, /^2 shots · 4 s of video/);
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).shots[0].state === 'making', 'making');
    assert.ok('refused' in (await r.shots.edit('c1', a.id, { prompt: 'x' })));
    assert.ok('refused' in (await r.shots.skip('c1', a.id)));
    assert.ok(await r.shots.remove('c1', a.id), 'the one being made can be deleted: its clip stops');
    await until(r.shots, () => list(r.shots).run === 'idle', 'the list ended');
    assert.deepEqual(list(r.shots).shots.map(s => [s.prompt, s.state]), [['two again', 'skipped'], ['three', 'done']]);
    assert.ok('refused' in (await r.shots.skip('c1', 'gone')));
    // Skip again puts it back.
    await r.shots.skip('c1', b.id);
    assert.equal(list(r.shots).shots[0].state, 'waiting');
    assert.equal(runner.made.filter(j => j.prompt === 'one').length, 1);
  } finally {
    await r.done();
  }
});

test('the list is saved and carries on after TOMLIN restarts, from the shot it was on', async () => {
  const slow = new FakeVideoRunner({ fps: 2, frameMs: 40 });
  const r = await rig(slow);
  try {
    await add(r.shots, 'one');
    await add(r.shots, 'two');
    await r.shots.start('c1', hire);
    await until(r.shots, () => list(r.shots).shots[1].state === 'making', 'the second shot started');
    await new Promise(res => setTimeout(res, 30));
    // TOMLIN closes: a new process reads the file with a new clip queue that knows nothing of the old clip.
    const quick = new FakeVideoRunner({ fps: 2 });
    const r2 = await rig(quick, { dir: r.dir });
    const back = r2.shots.get('c1')!;
    assert.equal(back.run, 'running');
    assert.deepEqual(back.shots.map(s => s.state), ['done', 'waiting']);
    await until(r2.shots, () => r2.shots.get('c1')!.run === 'idle', 'carried on');
    assert.deepEqual(quick.made.map(j => j.prompt), ['two']);
    assert.equal(quick.made[0].seed, slow.made[1].seed, 'made again from the same seed');
    // Asked under the same link id, so a linked PC still making it hands it over (src/videolink.ts); each take's own.
    assert.match(String(slow.made[1].linkId), /^[0-9a-f]{32}$/);
    assert.equal(quick.made[0].linkId, slow.made[1].linkId);
    assert.notEqual(slow.made[0].linkId, slow.made[1].linkId);
    assert.equal(r2.shots.get('c1')!.shots[1].resume, undefined, 'used once');
    r.clips.stopAll();
  } finally {
    await r.done();
  }
});

test('Start with nothing to make says so; a full list says so', async () => {
  const r = await rig(new FakeVideoRunner());
  try {
    assert.match((await r.shots.start('c1', hire) as { refused: string }).refused, /Add a shot first/);
    assert.equal(r.shots.view('nope', progressLine), null);
  } finally {
    await r.done();
  }
});

test('the page and server parts are wired: routes, the panel and the prompt box button', async () => {
  const read = (f: string) => readFile(new URL(`../${f}`, import.meta.url), 'utf8');
  const server = await read('src/server.ts');
  assert.match(server, /shotsGet/);
  assert.match(server, /shotsPost/);
  const html = await read('public/index.html');
  for (const id of ['shot-list', 'shot-add', 'shot-top', 'shot-cards', 'clip-more']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<script src="shots\.js/);
  const js = await read('public/shots.js');
  for (const bit of ['/api/shots/add', '/api/shots/edit', '/api/shots/move', '/api/shots/skip', '/api/shots/redo', '/api/shots/keep', '/api/shots/delete', '/api/shots/run', 'Move up', 'Move down', 'Keep this one', 'Make 3', 'Start at', 'Make all as Draft first', 'Make the kept ones at Normal']) assert.ok(js.includes(bit), bit);
  assert.doesNotMatch(js + html, /Join into one video/);
  // Start pictures: the clip's three-tab picker, and the last frame read on the page for any list waiting on one.
  for (const bit of ['/api/shots/frames', '/api/shots/frame', 'app.lastFrameOf', 'app.pickStartPicture', 'app.clipStartPick', '/api/shots/picture']) assert.ok(js.includes(bit), bit);
  const clipsJs = await read('public/clips.js');
  assert.match(clipsJs, /app\.pickStartPicture = onPick => pickStart\(onPick\)/);
  assert.match(clipsJs, /app\.lastFrameOf = lastFrameOf/);
  // The shot list never runs a clip itself or imports the engine.
  for (const f of ['src/shots.ts', 'src/server/shots.ts']) assert.doesNotMatch(await read(f), /from ['"][./]+video(?:link)?\.ts['"]/, f);
});

test('the 720p sizes are for a model made for 720p; a 720p shot\'s time is scaled from the PC\'s speed by its pixels', async () => {
  const steps = { draft: 20, normal: 30, best: 50 };
  // Wan 2.2 5B on a card: 900 s for a 3 s Wide clip at Normal (30 steps), so 10 s a step for each clip second.
  const slow: VideoRunner = {
    installed: async () => true,
    make: async (job: VideoJob, on: (p: VideoProgress) => void) => {
      on({ stage: 'making', done: steps[job.quality], total: steps[job.quality], secondsLeft: 0 });
      const c = await new FakeVideoRunner().make({ ...job, seconds: 1 }, () => undefined, new AbortController().signal);
      return { ...c, seconds: job.seconds, width: job.width, height: job.height, tookMs: 900_000 * (job.seconds / 3) * ((job.width * job.height) / (832 * 480)) * (steps[job.quality] / 30) };
    },
  };
  const r = await rig(slow);
  const hd = { ...hire, model: 'wan22-ti2v-5b-q8' };
  try {
    const no = await r.shots.add('c2', hire, { prompt: 'big', seconds: 3, size: 'wide720', quality: 'normal' });
    assert.match((no as { refused: string }).refused, /Wide 720p is for a video model made for 720p/);
    assert.equal(r.shots.get('c2'), null, 'no list was made for it');
    const one = await r.shots.add('c1', hd, { prompt: 'first', seconds: 3, size: 'wide', quality: 'normal' });
    assert.ok(!('refused' in one));
    await r.shots.start('c1', hd);
    await until(r.shots, () => list(r.shots).run === 'idle', 'the first shot made');
    assert.ok(!('refused' in (await r.shots.add('c1', hd, { prompt: 'wide again', seconds: 3, size: 'wide', quality: 'normal' }))));
    assert.ok(!('refused' in (await r.shots.add('c1', hd, { prompt: 'big', seconds: 3, size: 'wide720', quality: 'normal' }))));
    const v = r.shots.view('c1', progressLine)!;
    assert.deepEqual(v.shots.slice(1).map(s => Math.round(s.left!)), [900, Math.round((900 * (1280 * 704)) / (832 * 480))]);
    // At Best the model's own 50 steps are counted (not a count learned before its steps changed).
    list(r.shots).shots[1].next.quality = 'best';
    assert.equal(Math.round(r.shots.view('c1', progressLine)!.shots[1].left!), 1500);
    list(r.shots).shots[1].next.quality = 'normal';
    // The hire's model changed to one made for 480p: the 720p shot fails with the line, the list carries on.
    const small = { ...hd, model: 'wan21-t2v-1.3b' };
    await r.shots.start('c1', small);
    await until(r.shots, () => list(r.shots).run === 'idle', 'the list ended');
    const big = list(r.shots).shots[2];
    assert.equal(big.state, 'failed');
    assert.match(big.error!, /^Shot 3: Wide 720p is for a video model made for 720p/);
    assert.equal(list(r.shots).shots[1].state, 'done');
  } finally {
    await r.done();
  }
});

test('Keep the colours of the first shot: on by default, its reference from shot 1\'s picture or the first frame, off when turned off', async () => {
  const r = await rig(new FakeVideoRunner({ fps: 2 }));
  try {
    await add(r.shots, 'from nothing');
    let c = r.shots.colourOf('c1')!;
    assert.equal(r.shots.view('c1', progressLine)!.colour, true, 'on for a new list');
    assert.deepEqual([c.ref, c.source.key, c.source.picture, c.source.width, c.source.height], [null, 'frame', null, 832, 480]);
    const ref = { mean: [1, 2, 3] as [number, number, number], std: [4, 5, 6] as [number, number, number], from: 'frame' as const, key: 'frame', at: 'x' };
    await r.shots.setRef('c1', ref);
    assert.deepEqual(r.shots.colourOf('c1')!.ref, ref, 'written into the list: the same for every shot');
    // Shot 1 now starts from a picture: the reference is that picture, and the old one no longer belongs.
    const first = list(r.shots).shots[0];
    await r.shots.edit('c1', first.id, { prompt: 'from a picture', seconds: 2, size: 'tall', quality: 'normal', start: { kind: 'picture', file: '0123456789abcdef.png', name: 'a fox' } });
    c = r.shots.colourOf('c1')!;
    assert.equal(c.ref, null);
    assert.deepEqual(c.source.picture, { kept: '0123456789abcdef.png', name: 'a fox' });
    assert.deepEqual([c.source.width, c.source.height], [480, 832]);
    await r.shots.setColour('c1', hire, false);
    assert.equal(r.shots.colourOf('c1'), null, 'off: frames are used as they are');
    assert.equal(r.shots.view('c1', progressLine)!.colour, false);
    const saved = JSON.parse(await readFile(join(r.dir, 'shots.json'), 'utf8'));
    assert.equal(saved.lists.c1.colour, false);
    assert.deepEqual(saved.lists.c1.ref, ref);
  } finally {
    await r.done();
  }
});
