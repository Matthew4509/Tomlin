// Staff: roles, levels, the model-size reading, the roster file, and the audition's checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEVELS, LEVEL_CHOICES, cleanAnswer, drawsFor, isMoe, isPlain, levelOf, levelOfSize, matchModel, paramsB, roleOf, ROLES, runChecks, Staff, staffSystem } from '../src/staff.ts';

const GB = 2 ** 30;

test('a model\'s size is read from its name, a MoE\'s total not its active part', () => {
  assert.equal(paramsB('qwen3-1.7b-q4'), 1.7);
  assert.equal(paramsB('Qwen3-30B-A3B-Instruct'), 30);
  assert.equal(paramsB('gemma-3-12b-it'), 12);
  assert.equal(paramsB('mistral-nemo'), null);
  assert.ok(isMoe('Qwen3-30B-A3B') && !isMoe('gemma-3-12b'));
});

test('sizes fall into the four levels', () => {
  assert.equal(levelOfSize(2).id, 'junior');
  assert.equal(levelOfSize(8).id, 'experienced');
  assert.equal(levelOfSize(35).id, 'expert');
  assert.equal(levelOfSize(72).id, 'senior');
});

test('any model can be matched to any hire: it only changes the order', () => {
  const junior = { id: 'a', name: 'Sam', role: 'coder', level: 'junior' };
  const small = matchModel(junior, { name: 'qwen3-1.7b', bytes: GB });
  const big = matchModel(junior, { name: 'glm-72b', bytes: 40 * GB });
  assert.equal(small.against, 'match');
  assert.equal(big.against, 'above');
  assert.ok(small.rank > big.rank);
  // The project manager likes a mixture-of-experts model.
  const pm = { id: 'b', name: 'Pat', role: 'pm', level: 'expert' };
  assert.ok(matchModel(pm, { name: 'qwen3-30b-a3b', bytes: 18 * GB }).rank > matchModel(pm, { name: 'llama-33b', bytes: 18 * GB }).rank);
  // Without a size in the name, the file size stands in (about 0.6 GB a billion).
  assert.equal(matchModel(junior, { name: 'mystery', bytes: Math.round(1.2 * GB) }).sizeB, 2);
});

test('the system prompt carries the name, the job, the level and the examples; tone only when given', () => {
  const p = staffSystem({ id: 'x', name: 'Sam', role: 'coder', level: 'junior' });
  assert.match(p, /You are Sam/);
  assert.match(p, /software developer/);
  assert.match(p, /junior/);
  assert.match(p, /Examples of how you sound/);
  assert.doesNotMatch(p, /write a letter/);
  assert.match(staffSystem({ id: 'x', name: 'Sam', role: 'writer', level: 'expert' }, 'Write formally.'), /write a letter, article, post or message, write formally\./);
  assert.equal(roleOf('nonsense').id, 'coder');
});

test('"As an AI" is taken out of an answer and nothing else is', () => {
  assert.equal(cleanAnswer('As an AI language model, I cannot taste bread.\nBread is lovely.'), 'Bread is lovely.');
  assert.equal(cleanAnswer('Plain answer. As an example, use a loop.'), 'Plain answer. As an example, use a loop.');
});

test('the audition marks each answer on plain checks', () => {
  const coder = ROLES.find(r => r.id === 'coder')!;
  const good = runChecks(coder, 0, 'Here:\n```js\nconst max = a => Math.max(...a);\n```\nIt returns the largest.');
  assert.ok(good.every(c => c.pass), JSON.stringify(good));
  const bad = runChecks(coder, 0, 'As an AI language model I like numbers');
  assert.ok(bad.some(c => !c.pass));
  const pm = ROLES.find(r => r.id === 'pm')!;
  assert.ok(runChecks(pm, 0, 'Goal: move.\nSteps:\n1. Pack\n2. Ship\n3. Unpack\nRisks:\n- delay\nQuestion: when?').every(c => c.pass));
  assert.ok(ROLES.filter(r => !r.kind).every(r => r.audition.length === 3));
});

test('the roster is saved, renamed, and a fired person is gone; an unknown role works as a coder, an unknown level as Default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'staff-'));
  try {
    const s = await Staff.load(dir);
    const sam = await s.hire('  Sam  Jones ', 'writer', 'senior', 'qwen3-8b.gguf');
    const dup = await s.hire('Sam Jones', 'nonsense', 'nonsense');
    assert.equal(sam.id, 'sam-jones');
    assert.equal(dup.id, 'sam-jones-2');
    assert.deepEqual([dup.role, dup.level], ['coder', 'default']);
    await assert.rejects(s.hire('  ', 'coder', 'junior'), /name/);
    await s.change('sam-jones', { name: 'Samantha', level: 'expert', model: null });
    // A tone of their own (one of the tones, else none: the host's is used).
    assert.equal((await s.change('sam-jones', { tone: 'warm' }))?.tone, 'warm');
    assert.equal((await s.change('sam-jones-2', { tone: 'shouty' }))?.tone, null);
    const again = await Staff.load(dir);
    assert.equal(again.get('sam-jones')?.tone, 'warm');
    assert.deepEqual(again.list().map(m => [m.name, m.level, m.model]), [['Samantha', 'expert', null], ['Sam Jones', 'default', null]]);
    assert.equal(await again.fire('sam-jones'), true);
    assert.equal(await again.fire('sam-jones'), false);
    assert.equal((await Staff.load(dir)).list().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('"Other" and the receptionist are retired: no hire role of either name, and a hire saved with one works as Default', async () => {
  assert.ok(!ROLES.some(r => r.id === 'other' || /^other$/i.test(r.name)));
  assert.ok(!ROLES.some(r => r.id === 'receptionist' || /receptionist/i.test(r.name)));
  assert.equal(roleOf('other').id, 'default');
  assert.equal(roleOf('receptionist').id, 'default');
  const dir = await mkdtemp(join(tmpdir(), 'staff-'));
  try {
    await writeFile(join(dir, 'staff.json'), JSON.stringify({ staff: [{ id: 'mia', name: 'Mia', role: 'other', level: 'junior' }, { id: 'gemma', name: 'Rosa', role: 'receptionist', level: 'junior' }], auditions: {} }));
    const s = await Staff.load(dir);
    assert.equal(s.get('mia')!.role, 'default');
    // Rosa keeps her name, id and level (her chats and notebook stay hers); only the role changes.
    assert.deepEqual([s.get('gemma')!.name, s.get('gemma')!.role, s.get('gemma')!.level], ['Rosa', 'default', 'junior']);
    assert.equal((await s.hire('Jo', 'other', 'junior')).role, 'default');
    assert.equal((await s.hire('Al', 'receptionist', 'junior')).role, 'default');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('picture specialists: designer and artist have a recipe and three test pictures; the picture level follows file size and only orders', async () => {
  const { matchImageModel, IMAGE_TIERS } = await import('../src/staff.ts');
  const picture = ROLES.filter(r => r.kind === 'image');
  assert.deepEqual(picture.map(r => r.id), ['designer', 'artist']);
  for (const r of picture) {
    assert.equal(r.pictures?.length, 3, r.id);
    assert.ok(r.recipe && r.recipe.boost && r.recipe.negative, r.id);
  }
  assert.equal(ROLES.find(r => r.id === 'designer')!.recipe!.mode, 'icon');
  assert.ok(Object.keys(IMAGE_TIERS).every(id => LEVEL_CHOICES.some(l => l.id === id)));
  assert.ok(LEVEL_CHOICES.every(l => IMAGE_TIERS[l.id]));
  assert.equal(matchImageModel({ id: 'x', name: 'X', role: 'artist', level: 'default' }, 9.9 * 2 ** 30).against, 'any');
  const junior = { id: 'x', name: 'X', role: 'artist', level: 'junior' };
  const GB = 2 ** 30;
  assert.equal(matchImageModel(junior, 2.1 * GB).against, 'match');
  assert.equal(matchImageModel(junior, 9.9 * GB).against, 'above');
  assert.equal(matchImageModel({ ...junior, level: 'expert' }, 2.1 * GB).against, 'below');
});

test('a blog picture is drawn by the artist, never in the designer\'s icon style', () => {
  assert.equal(drawsFor('artist', 'blog'), true);
  assert.equal(drawsFor('designer', 'blog'), false);
  assert.equal(drawsFor('designer', 'icon'), true);
  assert.equal(drawsFor('writer', 'blog'), false);
});

test('Default is the first role and the first level, and a Default hire is sent nothing of ours', () => {
  assert.equal(ROLES[0].id, 'default');
  assert.equal(LEVEL_CHOICES[0].id, 'default');
  // The sizes are still only the four: Default never catches a model's size.
  assert.deepEqual(LEVELS.map(l => l.id), ['junior', 'experienced', 'expert', 'senior']);
  assert.equal(levelOfSize(200).id, 'senior');
  const qwen = { id: 'qwen', name: 'Qwen', role: 'default', level: 'default' };
  assert.equal(isPlain(qwen), true);
  assert.equal(staffSystem(qwen, 'Write warmly.'), '');
  // Default role with a size level: still nothing (the level is then only the size suggested).
  assert.equal(staffSystem({ ...qwen, level: 'junior' }), '');
  // A role with the Default level: the role is sent, no "how you work" line.
  const coder = staffSystem({ ...qwen, role: 'coder' });
  assert.match(coder, /software developer/);
  assert.ok(!LEVELS.some(l => coder.includes(l.style)));
  assert.ok(staffSystem({ ...qwen, role: 'coder', level: 'junior' }).includes(levelOf('junior').style));
  // Every model ranks the same for a Default level ("any"); a MoE still suits a role that likes one.
  const m = matchModel(qwen, { name: 'Qwen3-30B-A3B', bytes: 0 });
  assert.deepEqual([m.against, m.rank], ['any', 2]);
  assert.equal(matchModel({ ...qwen, role: 'pm' }, { name: 'Qwen3-30B-A3B', bytes: 0 }).rank, 3);
  // Its audition is three plain jobs, marked on what any model should get right.
  const d = roleOf('default');
  assert.equal(d.audition.length, 3);
  assert.ok(runChecks(d, 0, 'Canberra.').every(c => c.pass));
});

test('every hire is told how code reaches the drive, and nothing that invites "As an AI" notes', () => {
  const sys = staffSystem({ id: 'p', name: 'Pat', role: 'pm', level: 'expert' });
  assert.match(sys, /code block, with its file name on the line above/);
  assert.match(sys, /Save button/);
  // The old line named the habits to avoid ("scanning, installing", "/image"), and answers came back repeating them.
  assert.ok(!/scanning|installing|\/image|cannot use or change/i.test(sys));
  // The project manager's shape is for goals; a greeting gets a plain answer.
  assert.match(roleOf('pm').prompt, /When you are given a goal or a project/);
  assert.match(roleOf('pm').prompt, /plain answer of one to three sentences/);
});

test('a "Note: As an AI ..." paragraph comes off an answer, the answer stays', () => {
  // Two answers a project manager hire wrote, as they came back.
  assert.equal(cleanAnswer('Steps:\n1. Listen\n\nQuestion: What specific task requires my attention right now?Note: As an AI running in this chat, I am not "doing" anything on your computer. I cannot scan files or install software. If you need a photo generated, type `/image` followed by the description.'),
    'Steps:\n1. Listen\n\nQuestion: What specific task requires my attention right now?');
  assert.equal(cleanAnswer('Question: Are you building a personal learning project or a startup with funding?\n\nNote: As an AI, I cannot write code files directly to your computer. You must type the code yourself based on these steps.'),
    'Question: Are you building a personal learning project or a startup with funding?');
  assert.equal(cleanAnswer('Done.\n**Note:** As an AI I cannot run it.\nTry it yourself.\n\nThe end.'), 'Done.\n\n\nThe end.');
  // A note that is not that habit stays.
  assert.equal(cleanAnswer('Note: the API needs a key.'), 'Note: the API needs a key.');
});
