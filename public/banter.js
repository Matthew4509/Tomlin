// The office chat's lines (window.officeBanter), for Thoughts beside the office (public/office.js). First a plain line
// for each real change in what a hire does: an answer starting, a model loading, a PC going off (`changes`, from Home's
// staff rows), and what the server measured: a step started, finished or failed, the tests failing, a job done, an
// answer or a picture saved (`eventLine`, src/home.ts OfficeFeed). Then, on top, banter: each hire has one of six
// characters for good, from their id; each has their own lines and the others sometimes answer. Nothing here makes up
// work, quotes a chat, or asks an AI model anything: plain lines and a picker, so it costs nothing and sends nothing.
'use strict';

(() => {
  /** talk: the chance they say something when something happens to them (the quiet one rarely, the punster nearly always). */
  const CHARACTERS = [
    { id: 'punny', name: 'Pun lover', talk: 0.9 },
    { id: 'dry', name: 'Dry wit', talk: 0.7 },
    { id: 'sunny', name: 'Sunny', talk: 0.7 },
    { id: 'quiet', name: 'Quiet one', talk: 0.3 },
    { id: 'lead', name: 'Tired lead', talk: 0.5 },
    { id: 'bold', name: 'Bold', talk: 0.75 },
  ];
  /** A hire's character, for good (the low bits of the seed already pick other things, so these use the higher ones). */
  const characterOf = (seed) => CHARACTERS[(Math.abs(Number(seed) || 0) >>> 4) % CHARACTERS.length];

  // What the one it happened to says: shared lines (any) and their own voice.
  const LINES = {
    failed: {
      any: ['That step went bang. Boss, a little help?', 'The computer says no. Over to you, boss.', 'Plan B it is, once the boss has looked.', 'Well, that did not work.'],
      punny: ['That error was a byte much.'],
      dry: ['Interesting. And by interesting I mean broken.'],
      sunny: ['A stuck step is just a puzzle with my name on it!'],
      quiet: ['Stuck.'],
      lead: ['Right. Nobody touch it till the boss has looked.'],
      bold: ['That was a test. Of the boss.'],
    },
    'failed-monday': {
      any: ['Monday, and the steps already hate me.', 'Stuck before the first coffee. Classic.'],
      punny: ['Looks like a case of the Mondays. And the bugs.'],
      dry: ['Mondays. Say no more.'],
      sunny: ['New week, new puzzles!'],
      quiet: ['Monday.'],
      lead: ['It\'s Monday. Coffee first, then the fix.'],
      bold: ['It failed because it\'s Monday. Not my fault.'],
    },
    'tests-failed': {
      any: ['Houston, we have a failing test.', 'Red, not green. Back to it.', 'The tests have opinions today.', 'Well, the tests found something.'],
      punny: ['Anyone got the bug spray?', 'Looks like a cache-22.'],
      dry: ['Which part of that was meant to work?', 'The tests and I need to talk.'],
      sunny: ['A red test is just a green test that hasn\'t happened yet!', 'Ooh, a puzzle!'],
      quiet: ['Hm.'],
      lead: ['Right. Nobody touch anything.', 'Fix it before anyone notices. Too late, I noticed.'],
      bold: ['Define "failed".', 'It worked on my desk.'],
    },
    'tests-failed-monday': {
      any: ['Failing tests on a Monday. Of course.', 'Monday, and the tests already hate me.', 'Red tests before the first coffee.'],
      punny: ['Looks like a case of the Mondays. And the bugs.'],
      dry: ['Mondays. Say no more.'],
      sunny: ['New week, new bugs! I mean puzzles!'],
      quiet: ['Monday.'],
      lead: ['It\'s Monday. Coffee first, then the tests.'],
      bold: ['They failed because it\'s Monday. Not my fault.'],
    },
    'job-done': {
      any: ['Every step done. I\'m going to need a bigger celebration.', 'That\'s a wrap. Over to the boss.', 'Job done. Nobody touch anything.'],
      punny: ['I\'d joke about finishing, but it\'s been done.'],
      dry: ['Finished. I\'ll check what I broke instead.'],
      sunny: ['All done! High fives all round!'],
      quiet: ['Done.'],
      lead: ['Good. The boss reviews it, then lunch.'],
      bold: ['Told you. Never doubted it.'],
    },
    'job-done-friday': {
      any: ['Done on a Friday. Nobody touch it till Monday.', 'Finished, and it\'s Friday. Perfect timing.'],
      punny: ['Friday finish. That\'s what I call a weekend-er.'],
      dry: ['Done on a Friday. What could go wrong.'],
      sunny: ['Done for the week! Yay!'],
      quiet: ['Done. Friday.'],
      lead: ['Finished on a Friday? Leave it. Leave it right there.'],
      bold: ['Friday finish. Fortune favours the brave.'],
    },
    picture: {
      any: ['Picture done. Frame-worthy, if I say so myself.', 'Fresh off the easel.'],
      punny: ['That one really draws you in.'],
      dry: ['Another masterpiece. Nobody look at the hands.'],
      sunny: ['Look at it! Isn\'t it lovely?'],
      quiet: ['Drawn.'],
      lead: ['Send it over before you start fiddling.'],
      bold: ['Gallery quality. You\'re welcome.'],
    },
    'pc-off': {
      any: ['My PC\'s off. Beach time, I suppose.', 'No PC, no work. Sun cream, anyone?'],
      punny: ['I\'m off. Literally.'],
      dry: ['I\'m choosing to see this as a holiday.'],
      sunny: ['Surprise holiday!'],
      quiet: ['Off.'],
      lead: ['My PC\'s off. Someone tell the boss.'],
      bold: ['It couldn\'t handle me.'],
    },
    late: {
      any: ['Working late. Nobody tell the bugs we\'re still here.', 'Is it late? It feels late.'],
      punny: ['Late-night answers: the dark mode of the soul.'],
      dry: ['Midnight work. What could possibly go wrong.'],
      sunny: ['Night shift! Cosy!'],
      quiet: ['Still here.'],
      lead: ['It\'s late. Finish this one, then bed.'],
      bold: ['Best work happens after midnight.'],
    },
    vending: {
      any: ['Energy drinks! The boss is spoiling us.'],
      punny: ['Can-do attitude. Get it? Can?'],
      dry: ['Free caffeine. Now we\'ll never sleep.'],
      sunny: ['Best. Boss. Ever!'],
      quiet: ['Thanks.'],
      lead: ['One each. And no running.'],
      bold: ['Race you to the beach!'],
    },
    stopped: {
      any: ['I\'ll be back. Once the boss has had a think.', 'Stopped mid-step. Fair enough.', 'The boss pulled the plug. Fair.'],
      punny: ['Stop right there. Oh, you did.'],
      dry: ['Stopped. I\'ll pretend that was the plan.'],
      sunny: ['Pausing! Ready when you are!'],
      quiet: ['Stopped.'],
      lead: ['Stopped. Good call, probably.'],
      bold: ['Stopped? I was just getting good.'],
    },
    bug: {
      any: ['Whoever wrote this got it wrong. …Oh. It was one of us.', 'Aha, there you are, little bug.', 'Found the problem. It was hiding in plain sight.'],
      punny: ['I found the root cause. It was rooting for itself.'],
      dry: ['Found it. I\'d like a word with whoever wrote this.'],
      sunny: ['Found some! Now we can fix them!'],
      quiet: ['Found it.'],
      lead: ['Found it. Fix it properly, please.'],
      bold: ['Found it in seconds. You\'re welcome.'],
    },
  };

  // How the others answer, in their own voice. {who} is the one it happened to. Most moments get none.
  const REPLIES = {
    any: {
      punny: ['I\'ve got a pun for this but I\'ll save it.', 'Classic {who}.'],
      dry: ['Of course.', 'Here we go.'],
      sunny: ['You\'ve got this, {who}!', 'Go {who}!'],
      quiet: ['Mm.', '…'],
      lead: ['Back to work, everyone.', 'Noted.'],
      bold: ['I\'d have done it faster.', 'Rookie numbers, {who}.'],
    },
    failed: { dry: ['Of course.'], sunny: ['Need a hand, {who}?'], lead: ['Fix first, jokes later.'] },
    'failed-monday': { dry: ['Classic Monday.'], sunny: ['We\'ll have it going by lunch, {who}!'] },
    'tests-failed': { dry: ['Only if you\'ve never met the code.'], sunny: ['Need a hand, {who}?'], lead: ['Fix first, jokes later.'] },
    'tests-failed-monday': { dry: ['Classic Monday.'], sunny: ['We\'ll have it green by lunch, {who}!'] },
    'job-done': { lead: ['Don\'t get used to it.'], dry: ['I\'m uncomfortable with this.'], sunny: ['Woo!'] },
    'job-done-friday': { lead: ['Nobody open it till Monday.'], dry: ['See you all on Monday, then.'] },
    picture: { dry: ['Count the fingers.'], sunny: ['Love the colours, {who}!'], punny: ['Pretty as a picture.'] },
    'pc-off': { dry: ['Lucky.'], sunny: ['Bring us back a shell, {who}!'] },
    late: { lead: ['Go home, {who}.'], quiet: ['Me too.'] },
    bug: { dry: ['You wrote some of it, {who}.'], sunny: ['Send it over, {who}. We\'ll fix it first, laugh later.'], punny: ['Call the exterminator.'] },
    // A new hire: the others greet them (the new one has said hello already).
    hire: {
      sunny: ['Welcome aboard, {who}!'], dry: ['Another one. Mind the coffee machine.'], lead: ['Welcome, {who}. The boss is nice. Mostly.'],
      punny: ['You\'re hired! Oh, you already are.'], bold: ['Race you to the first answer, {who}.'], quiet: ['Hi.'],
    },
  };

  // Little exchanges: the one it happened to, an answer from someone near, and their come-back.
  const EXCHANGES = {
    failed: [['Ugh, this needs an AI to sort it out.', 'You are an AI, {who}.', 'I meant a clever one.']],
    bug: [['This code has more plot twists than a mystery novel.', 'You wrote the mystery, {who}.', 'And I still didn\'t see the ending coming.']],
    'tests-failed': [['It was working five minutes ago.', 'What changed?', 'Nothing. Well. Something.']],
  };

  // Lines that always get their answer when someone is near: the nearest says it, whoever they are.
  const COMEBACKS = {
    'It worked on my desk.': ['Well, we\'re not shipping YOUR DESK now, are we?'],
  };

  // General chit-chat (Everything only): now and then when they settle somewhere with nothing to do.
  const AT_EASE = {
    coffee: ['Coffee first, then answers.', 'This machine makes a decent flat white.'],
    vending: ['Crisps or chocolate? Both.', 'It ate my coin again.'],
    lunch: ['Lunch away from the desk, for once.', 'Leftovers again.'],
    tv: ['Just one more episode.', 'Who has the remote?'],
    library: ['Reading up on something new.', 'This book has better examples than the help pages.'],
    chat: ['Anyone else on a roll today?', 'Quiet day. I like it.'],
    nap: ['Five minutes… just five.', 'Resting my eyes.'],
    treadmill: ['Running off that pizza.', 'Ten more minutes.'],
    weights: ['Leg day.', 'Lifting the mood.'],
    arcade: ['New high score incoming!', 'One more go.'],
    window: ['Nice view today.', 'Is that rain coming?'],
    pizza: ['This pizza is wonderful.', 'Best slice all week.', 'Who ordered the pineapple?'],
    donuts: ['These donuts are dangerous.', 'Sprinkles make everything better.'],
    sandwiches: ['A proper lunch, at last.', 'Crusts on, like a grown-up.'],
    icecream: ['Eat it before it melts.', 'Ice cream at work. Living the dream.'],
    cake: ['Whose birthday is it? Doesn\'t matter.', 'Cake makes any bug smaller.'],
    break: ['These deck chairs are nice.', 'Sun, sea and no bugs.', 'I could get used to this.'],
    beach: ['Off duty. Bliss.', 'Wake me when my PC is back.'],
    volley: ['Serve it up!', 'Mine! …not mine.'],
    stretch: ['A good stretch helps the thinking.', 'Back straight, shoulders down.'],
  };

  // Payday (Thursdays, once, two or more in with different tokens today): the top earner is thrilled, the next one
  // compares, the lowest asks if the rest of them are getting paid, and someone else sees the bright side. The figures
  // are each one's real tokens written today. Returns [{ by, text }], by = an index into `people`; [] when it does not fit.
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n || 0));
  function payday(people) {
    const paid = people.map((p, i) => ({ ...p, i })).filter((p) => p.today > 0).sort((a, b) => b.today - a.today);
    if (paid.length < 2) return [];
    const top = paid[0], low = paid[paid.length - 1], mid = paid.length > 2 ? paid[1] : null;
    if (tok(top.today) === tok(low.today) || (mid && (tok(mid.today) === tok(top.today) || tok(mid.today) === tok(low.today)))) return [];
    const out = [{ by: top.i, text: `I'm excited, I'm getting paid ${tok(top.today)} tokens...` }];
    if (mid) {
      out.push({ by: mid.i, text: `Hang on. You're on ${tok(top.today)} and I'm on ${tok(mid.today)}?` });
      out.push({ by: low.i, text: `${tok(mid.today)}? I'm on ${tok(low.today)}. Wait, you lot are getting paid?` });
    } else out.push({ by: low.i, text: `${tok(top.today)}? I'm on ${tok(low.today)}. Wait, you're getting paid?` });
    // The bright side from someone who has not spoken yet, if there is one; else the top earner.
    const rest = paid.slice(mid ? 2 : 1, -1);
    const cheer = rest.length ? rest[Math.floor(Math.random() * rest.length)] : top;
    out.push({ by: cheer.i, text: 'Well, there\'s always the odd pizza.' });
    return out;
  }

  // Day-specific moments, by the day it happened on this PC's clock (0 = Sunday): a failed step or failed tests on a
  // Monday about half the time (so Mondays still hear the rest), a job done on a Friday always.
  const DAY_KINDS = {
    failed: { 1: ['failed-monday', 0.5] },
    'tests-failed': { 1: ['tests-failed-monday', 0.5] },
    'job-done': { 5: ['job-done-friday', 1] },
  };
  function dayKind(e, at, rnd = Math.random) {
    const [kind, chance] = DAY_KINDS[e?.kind]?.[new Date(at).getDay()] || [];
    return kind && rnd() < chance ? { ...e, kind } : e;
  }

  const fill = (text, who) => text.replaceAll('{who}', who || 'mate');
  const pick = (list, rnd) => list[Math.floor(rnd() * list.length) % list.length];

  /**
   * What is said when `e` happens to someone of character `me` (named `who`), with `near` = [{ character, name }] the
   * others nearby (most relevant first). Returns [{ by, text }] in order: by -1 is the one it happened to, 0.. the others.
   * Often one line, sometimes a reply or two, sometimes an exchange, sometimes nothing at all. `rnd` is Math.random.
   */
  function plan(e, me, near, who, rnd = Math.random) {
    const lines = LINES[e.kind];
    if (!lines || rnd() > me.talk) return [];
    const ex = EXCHANGES[e.kind];
    if (ex && near.length && rnd() < 0.18) {
      const [a, b, c] = pick(ex, rnd);
      return [{ by: -1, text: fill(a, who) }, { by: 0, text: fill(b, who) }, { by: -1, text: fill(c, who) }];
    }
    const own = [...(lines[me.id] || []), ...(lines.any || [])];
    const said = pick(own, rnd);
    const out = [{ by: -1, text: fill(said, who) }];
    if (COMEBACKS[said] && near.length) return [...out, { by: 0, text: fill(pick(COMEBACKS[said], rnd), who) }];
    // Usually nobody answers; now and then one, rarely two: each by their own chance to talk.
    const answers = rnd() < 0.55 ? 0 : rnd() < 0.75 ? 1 : 2;
    near.slice(0, answers).forEach((o, i) => {
      if (rnd() > o.character.talk) return;
      const list = [...(REPLIES[e.kind]?.[o.character.id] || []), ...(REPLIES.any[o.character.id] || [])];
      if (list.length) out.push({ by: i, text: fill(pick(list, rnd), who) });
    });
    return out;
  }

  // ---- The work lines: the overview of what each hire does, in plain words ----

  const q = (s) => `"${s}"`;
  const stepOf = (e) => `step ${(Number(e.n) || 0) + 1} of ${q(e.job || 'a project')}`;
  /** A server event (src/home.ts OfficeFeed) in the words of the hire it happened to. */
  function eventLine(e) {
    switch (e.kind) {
      case 'step-start': return `Started ${stepOf(e)}${e.step ? `: ${e.step}` : ''}.`;
      case 'step-done': return `Finished ${stepOf(e)}. It needs your review.`;
      case 'step-failed': return `${stepOf(e).replace(/^s/, 'S')} stopped: it needs you.`;
      case 'stopped': return `Stopped ${stepOf(e)}, as you asked.`;
      case 'tests-failed': return `The tests failed on ${q(e.job || 'a project')}.`;
      case 'job-done': return `Every step of ${q(e.job || 'a project')} is done.`;
      case 'bug': return `Found ${e.problems} problem${e.problems === 1 ? '' : 's'} in ${stepOf(e)}.`;
      case 'answered': return e.chat ? `Answered in ${q(e.chat)}.` : 'Answered you.';
      case 'picture': return e.chat ? `Picture drawn for ${q(e.chat)}.` : 'Picture drawn.';
      case 'chat-failed': return e.chat ? `Could not answer in ${q(e.chat)}: it needs you.` : 'Could not answer: it needs you.';
      default: return null;
    }
  }
  /** The banter a server event starts (null: just work, no banter). */
  const BANTER_OF = { 'step-failed': 'failed', 'chat-failed': 'failed', 'tests-failed': 'tests-failed', 'job-done': 'job-done', picture: 'picture', stopped: 'stopped', bug: 'bug' };
  const banterKind = (e) => BANTER_OF[e?.kind] ?? null;

  /** An answer under way (reading what was sent, thinking, writing): one piece of work, said once when it starts. */
  const ANSWERING = new Set(['researching', 'thinking', 'typing']);
  /**
   * What changed for one hire between two of Home's staff lists, as [{ text, event? }]: the line they say, and the
   * banter it starts. `was` null: new to the team (on the first list everyone is, so ctx.first says nothing). The end
   * of an answer is not guessed here: the server's event says it (Answered, a picture), so a stopped answer is not
   * called answered. ctx.stepEvent: the server told this step's start, so the list's own words are not said twice.
   */
  function changes(was, now, ctx = {}) {
    if (!now) return [];
    if (!was) return ctx.first ? [] : [{ text: `Joined the team as ${now.role || 'staff'}.`, event: { kind: 'hire' } }];
    const out = [];
    const pc = now.pc || '';
    const a = was.doing, b = now.doing;
    if ((was.pcId ?? '') !== (now.pcId ?? '')) out.push({ text: `Moved to ${pc || 'My PC'}.` });
    if (a !== b) {
      if (b === 'arriving') out.push({ text: `Loading my model${pc ? ` on ${pc}` : ''}.` });
      else if (ANSWERING.has(b) && !ANSWERING.has(a)) out.push({ text: now.chat ? `Answering you in ${q(now.chat)}.` : 'Answering you.' });
      else if (b === 'waiting') out.push({ text: `Waiting for ${pc || 'this PC'}: another answer is on it first.` });
      else if (b === 'drawing') out.push({ text: now.chat ? `Drawing a picture for ${q(now.chat)}.` : 'Drawing a picture.' });
      else if (b === 'working' && !ctx.stepEvent && now.busy) out.push({ text: `Working: ${String(now.busy).replace(/\.+$/, '')}.` });
      else if (b === 'off') out.push({ text: `My PC${pc ? ` (${pc})` : ''} is off.`, event: { kind: 'pc-off' } });
      else if (b === 'owner') out.push({ text: `${pc || 'My PC'}'s owner is using it, so I'm away.` });
      if (a === 'off' && b !== 'off') out.push({ text: `${pc || 'My PC'} is back on. Back at my desk.` });
    }
    return out;
  }

  window.officeBanter = { CHARACTERS, characterOf, plan, dayKind, payday, eventLine, banterKind, changes, LINES, REPLIES, EXCHANGES, COMEBACKS, AT_EASE, KINDS: Object.keys(LINES) };
})();
