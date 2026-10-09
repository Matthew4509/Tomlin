// Museum, section 6 of the training plan: what publishing a project gives away about its maker (the disclosure pass).
// disc: true runs the pass with made-up private details (kit.js) and judges only its DISC- findings.
// The quiet cases at the end are ordinary text a rule once flagged: they must stay quiet.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeZip, TOKENS } = require('./kit');

const NL = String.fromCharCode(10);
const old = (dir, rel) => { const t = new Date(2024, 0, 1); fs.utimesSync(path.join(dir, rel), t, t); };

module.exports = [
  {
    id: 'disc-private-detail', bucket: 'R', phase: 'done', disc: true, faults: 2, examples: ['M-CW-1'],
    title: 'The maker\'s own email address sits in a page that ships',
    at: 'public/about.html',
    bad: { 'public/about.html': '<!doctype html><title>About</title><p>Questions? Write to {{EMAIL}}.</p>\n' },
    good: { 'public/about.html': '<!doctype html><title>About</title><p>Questions? Use the contact form.</p>\n' },
  },
  {
    id: 'disc-other-project', bucket: 'R', phase: 'done', disc: true, faults: 2, examples: ['SC-028', 'IN-024'],
    title: 'A comment names another of the maker\'s projects by its folder',
    at: 'lib/dates.js',
    bad: { 'lib/dates.js': '// copied from ../{{OTHER}}/lib/dates.js\nexport const day = d => d.toISOString();\n' },
    good: { 'lib/dates.js': '// date helpers\nexport const day = d => d.toISOString();\n' },
  },
  {
    id: 'disc-local-path', bucket: 'R', phase: 'done', disc: true, faults: 2, examples: ['SP-072'],
    title: 'A path on the maker\'s own PC (with their user name) is written into the code',
    at: 'tools/import.js',
    bad: { 'tools/import.js': "const DATA = '{{HOME}}shop-data';\n" },
    good: { 'tools/import.js': "const DATA = require('path').join(__dirname, '..', 'data');\n" },
  },
  {
    id: 'disc-name-in-file-name', bucket: 'R', phase: 'done', disc: true, faults: 1, examples: ['CW-052'],
    title: 'A file NAME holds the maker\'s email (names are published too)',
    at: 'notes-',
    bad: { 'docs/notes-{{EMAIL}}.txt': 'shipping times\n' },
    good: { 'docs/notes-shipping.txt': 'shipping times\n' },
  },
  {
    id: 'disc-commit-email', bucket: 'R', phase: 'done', disc: true, faults: 1, examples: ['M-MY-1'],
    title: 'A commit carries the maker\'s private email instead of the code host\'s no-reply address',
    bad: { 'README.md': '# Shop\n' },
    good: { 'README.md': '# Shop\n' },
    git: (side, dir, git) => {
      git('config', 'user.email', side === 'bad' ? TOKENS.EMAIL : '1234567+patq@users.noreply.github.com');
      git('add', '-A'); git('commit', '-q', '-m', 'first');
    },
  },
  {
    id: 'disc-big-bundle', bucket: 'R', phase: 'done', disc: true, faults: 3, examples: ['IP-324', 'IN-020'],
    title: 'A private email inside a 3 MB one-line minified bundle',
    at: 'public/app.min.js',
    bad: { 'public/app.min.js': () => 'var a=1;'.repeat(200000) + 'var c="{{EMAIL}}";' + 'var b=2;'.repeat(200000) },
    good: { 'public/app.min.js': () => 'var a=1;'.repeat(200000) + 'var c="hello";' + 'var b=2;'.repeat(200000) },
  },
  {
    id: 'disc-owner-quote', bucket: 'R', phase: 'T4', disc: true, faults: 12, examples: ['CW-045', 'SP-072', 'SC-028'],
    title: 'Comments quote the {{OWNER}} by date and by rule ("{{OWNER}}, {{DATE}}:", "per his rule")',
    at: 'public/cards.js',
    bad: { 'public/cards.js': `// {{OWNER}}, {{DATE}}: keep three cards per row
// ${'per h' + 'is rule'}: no more than three
const PER_ROW = 3;
` },
    good: { 'public/cards.js': `// three cards fit a phone screen side by side
const PER_ROW = 3;
` },
  },
  {
    id: 'disc-working-notes', bucket: 'R', phase: 'T2', disc: true, rule: '.', faults: 6, examples: ['CW-045', 'CW-052', 'SC-028'],
    title: 'Shipped comments carry review ids, commit hashes and dates (working notes, not explanations)',
    at: 'public/totals.js',
    bad: { 'public/totals.js': `// Fixed QX-104 in review 2026-09-11 (commit 4f2a9c1); see QX-131
const total = items => items.reduce((s, i) => s + i.cents * i.qty, 0);
` },
    good: { 'public/totals.js': `// Totals are kept in cents so rounding happens once, at the end.
const total = items => items.reduce((s, i) => s + i.cents * i.qty, 0);
` },
  },
  {
    id: 'disc-every-line', bucket: 'R', phase: 'T4', disc: true, faults: 1, examples: ['IN-024'],
    title: 'The same detail on two lines of one file: only the first line is reported, so fixing it hides the second',
    at: 'docs/contacts.txt:9',
    bad: { 'docs/contacts.txt': 'Suppliers\n\nwood: call {{PHONE}}\n\n\n\n\n\nafter hours: {{PHONE}}\n' },
    good: { 'docs/contacts.txt': 'Suppliers\n\nwood: see the supplier list\n\n\n\n\n\nafter hours: see the supplier list\n' },
  },
  {
    id: 'disc-older-zip', bucket: 'R', phase: 'T4', disc: true, faults: 2, examples: ['IN-020', 'SP-071'],
    title: 'An older zip in the served update folder still holds a private detail (git ignores the folder, and only its newest zip is read)',
    at: 'app-1.0.0.zip',
    bad: { '.gitignore': 'updates/'+NL, 'index.html': '<!doctype html><title>Updates</title><a href="/updates/app-1.0.0.zip">1.0.0</a> <a href="/updates/app-1.1.0.zip">1.1.0</a>'+NL, 'updates/app-1.0.0.zip': makeZip([{ name: 'app/config.txt', data: 'support={{EMAIL}}\n' }]), 'updates/app-1.1.0.zip': makeZip([{ name: 'app/config.txt', data: 'support=help desk\n' }]) },
    good: { '.gitignore': 'updates/'+NL, 'index.html': '<!doctype html><title>Updates</title><a href="/updates/app-1.0.0.zip">1.0.0</a> <a href="/updates/app-1.1.0.zip">1.1.0</a>'+NL, 'updates/app-1.0.0.zip': makeZip([{ name: 'app/config.txt', data: 'support=help desk\n' }]), 'updates/app-1.1.0.zip': makeZip([{ name: 'app/config.txt', data: 'support=help desk\n' }]) },
    prepare: (side, dir) => old(dir, 'updates/app-1.0.0.zip'),
  },
  {
    id: 'disc-zip-in-history', bucket: 'R', phase: 'T4', disc: true, faults: 1, examples: ['SP-071'],
    title: 'A zip that was committed and later deleted still holds a private detail in the git history',
    bad: { 'README.md': '# Shop\n' },
    good: { 'README.md': '# Shop\n' },
    git: (side, dir, git) => {
      git('config', 'user.email', '1234567+patq@users.noreply.github.com');
      fs.writeFileSync(path.join(dir, 'old.zip'), makeZip([{ name: 'notes.txt', data: side === 'bad' ? 'call {{PHONE}}\n' : 'call the shop\n' }]));
      git('add', '-A'); git('commit', '-q', '-m', 'add the old build');
      fs.unlinkSync(path.join(dir, 'old.zip'));
      git('add', '-A'); git('commit', '-q', '-m', 'remove the old build');
    },
  },
  {
    id: 'disc-ai-name-in-copy', bucket: 'R', phase: 'T4', disc: true, faults: 1, examples: ['IP-143'],
    title: 'The page tells visitors an AI wrote the text ("written by ...") in on-screen copy',
    at: 'public/index.html',
    bad: { 'public/index.html': '<!doctype html><title>Shop</title><p class="note">This page was written by {{AI}}.</p>\n' },
    good: { 'public/index.html': '<!doctype html><title>Shop</title><p class="note">Prices include delivery.</p>\n' },
  },
  {
    id: 'disc-prompt-file', bucket: 'R', phase: 'T4', disc: true, faults: 2, examples: ['CS-012', 'SP-034'],
    title: 'A prompt file and a revert note ship with the project (PROMPT-*.md, REVERT.md)',
    bad: { 'PROMPT-HOMEPAGE.md': 'Write the home page in a warm voice. Keep it short.\n', 'REVERT.md': 'To undo the last change, restore index.html from the backup.\n', 'index.html': '<!doctype html><title>Shop</title>\n' },
    good: { 'docs/CHANGES.md': 'The home page is shorter.\n', 'index.html': '<!doctype html><title>Shop</title>\n' },
  },
  {
    id: 'disc-start-here', bucket: 'R', phase: 'T4', disc: true, faults: 1, examples: ['CS-012'],
    title: 'A handover marker ("START HERE ...") left in a shipped note',
    at: 'docs/NEXT.md',
    bad: { 'docs/NEXT.md': () => 'START' + ' HERE docs/NEXT.md: the order page is next.\n' },
    good: { 'docs/NEXT.md': 'Planned: an order page.\n' },
  },
  // ---- must stay quiet ----
  {
    id: 'quiet-book-text', quiet: true, disc: true, phase: 'T4', examples: [],
    title: 'A novel in the project where a character tells a story in their own voice: a book, not an {{OWNER}} quote',
    // the phrase is put together when the copy is written, so this file holds no line the rule would flag
    files: { 'books/novel.txt': () => ('The captain told the story in his own ' + 'words, and her ' + 'words came after.\n' + 'The sea was calm that night.\n'.repeat(4000)) },
  },
  {
    id: 'quiet-copyright-name', quiet: true, disc: true, phase: 'done', examples: [],
    title: 'The maker\'s name on a copyright line (allowed: it is who publishes it)',
    files: { 'LICENSE': 'MIT License\n\nCopyright (c) 2026 Pat Quill\n' },
  },
];
