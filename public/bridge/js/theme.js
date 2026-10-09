// Theme choice on the About page.
'use strict';

// ---- Theme (About): remembered in this browser, put on before the page draws by the script in <head> ----
const THEMES = ['orbital', 'default', 'light', 'dark'];
function setTheme(t) {
  if (!THEMES.includes(t)) t = 'orbital';
  if (t === 'default') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  pref.set('theme', t);
  for (const b of document.querySelectorAll('[data-theme-pick]')) b.setAttribute('aria-pressed', b.dataset.themePick === t);
}
for (const b of document.querySelectorAll('[data-theme-pick]')) b.addEventListener('click', () => setTheme(b.dataset.themePick));
