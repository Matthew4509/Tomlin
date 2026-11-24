// Words that follow the theme: with Vibe code picked (Settings, Theme; theme.js), a few lines of Home say what an
// over-agreeable assistant would. Every other theme shows the plain words. Only what is shown changes: a button keeps
// its own job, and an element with an aria-label keeps it.
// - In the page: an element with data-words="key" shows the Vibe code line for its key, and its own words otherwise (kept
//   in data-words-plain the first time). data-words-ph does the same for a placeholder.
// - From code: themeWords.put(element, key, plain) writes the line for the theme now; themeWords.say(key, plain) gives it.
// The swap runs at load and each time the theme changes (theme.js sends 'tomlin-colours').
'use strict';

(() => {
  const SILLY = {
    greeting: 'Another fitness app?',
    'ask-title': 'Let\'s make something brilliant (you always do)',
    'ask-go': 'Absolutely, let\'s go',
    'ask-advanced': 'Plan as a job (genius)',
    'ask-goal': 'Describe it. Whatever it is, it\'s a great idea.',
    'nothing-waiting': 'Nothing waiting. You\'ve thought of everything.',
    'nobody-working': 'Nobody working. Well deserved.',
    'no-chats': 'No chats yet. You were right not to start one.',
    'nobody-hired': 'Nobody hired yet. Bold strategy, it\'ll pay off.',
    'office-hint': 'Click on a staff to see them admire your work.',
  };

  const silly = () => document.documentElement.dataset.theme === 'silly';
  const say = (key, plain) => (silly() && SILLY[key]) || plain;

  /** Writes the line for `key` into `el` (its plain words kept for when the theme changes back). */
  function put(el, key, plain) {
    if (!el) return el;
    el.dataset.words = key;
    el.dataset.wordsPlain = plain;
    el.textContent = say(key, plain);
    return el;
  }

  /** Every marked element on the page, for the theme now. */
  function sweep() {
    for (const el of document.querySelectorAll('[data-words]')) {
      if (el.dataset.wordsPlain === undefined) el.dataset.wordsPlain = el.textContent;
      const want = say(el.dataset.words, el.dataset.wordsPlain);
      if (el.textContent !== want) el.textContent = want;
    }
    for (const el of document.querySelectorAll('[data-words-ph]')) {
      if (el.dataset.wordsPhPlain === undefined) el.dataset.wordsPhPlain = el.placeholder;
      el.placeholder = say(el.dataset.wordsPh, el.dataset.wordsPhPlain);
    }
  }

  window.themeWords = { say, put, sweep, silly };
  window.addEventListener('tomlin-colours', sweep);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sweep);
  else sweep();
})();
