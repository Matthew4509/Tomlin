// The "start line" prompt: text the person pastes into Claude, ChatGPT or any AI once, so that AI saves a project's
// start command in the project's own project.json and keeps it up to date. Shown on the empty project list, on a
// project with no start command, and as a starter prompt. The example in the text is built from EXAMPLE, which the tests read through
// the same code that reads a real project.json, so the prompt cannot describe a shape the Bridge does not take.
'use strict';

const EXAMPLE = { start: { name: 'site', exe: 'npm', args: ['run', 'dev'], port: 3000, cwd: 'frontend', env: { PORT: '3000' } } };

const TEXT = [
  'Please remember this for every project you help me with on this computer.',
  '',
  'I start my projects with TOMLIN. Each project folder should have a file called project.json at its top level, with one "start" entry saying how to run the project here:',
  '',
  JSON.stringify(EXAMPLE, null, 2),
  '',
  '- exe: the program (node, npm, npx, python, php...). args: its arguments, as a list.',
  '- port: the port the site answers on.',
  '- cwd (optional): the sub-folder it runs in, relative to the project folder.',
  '- env (optional): settings it needs, as text values.',
  '',
  'Keep it to the one main way to run the project. If project.json already exists, add or update "start" and leave the rest alone. Whenever you change how the project runs (new port, folder or command), update this entry in the same change. Never put passwords or keys in it. If you cannot write files, give me the file\'s text to save.',
].join('\n');

module.exports = { START_LINE_EXAMPLE: EXAMPLE, START_LINE_PROMPT: TEXT, START_LINE_TITLE: 'Teach your AI to save a start line' };
