// Pages and navigation. Setup, shortcuts and Start with Windows are TOMLIN's own (its Settings), not here.
'use strict';

// ---- pages ----
// A page can carry one more part after a slash: #prompts/<category> opens that category.
function show(page) {
  let [base, sub] = String(page).split('/');
  if (!document.getElementById('page-' + base)) { base = 'projects'; sub = ''; }
  page = sub ? base + '/' + sub : base;
  for (const s of document.querySelectorAll('.page')) s.hidden = s.id !== 'page-' + base;
  for (const b of document.querySelectorAll('.nav-item')) b.setAttribute('aria-current', b.dataset.page === base ? 'page' : 'false');
  if (location.hash !== '#' + page) history.replaceState(null, '', '#' + page);
  closeMenu();
  if (base === 'folders') loadFolders();
  if (base === 'audits') renderAudits();
  if (base === 'prompts') { let cat = ''; try { cat = sub ? decodeURIComponent(sub) : ''; } catch {} loadPrompts(cat); } // a mistyped %-escape opens the tiles
  if (base === 'about') { loadGitProgram(); loadImport(); }
}

for (const b of document.querySelectorAll('.nav-item[data-page]')) b.addEventListener('click', () => show(b.dataset.page));
// The name at the top is the way home: Projects, scrolled to the top, even when Projects is already showing.
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); show('projects'); document.querySelector('main').scrollTop = 0; });
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
