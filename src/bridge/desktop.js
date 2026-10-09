// Browsers, terminals and folders the Bridge part opens on the desktop. This is the one place that decides
// whether to really do it: a dry run (tests) reports what it would have done, and a demo only pretends.
'use strict';
const path = require('path');
const cfg = require('./config');
const os = require('./platform');

function openBrowser(url) {
  if (cfg.DRY) return { dryRun: 'browser ' + url };
  os.openUrl(url);
  return {};
}

const PICK_TITLES = { working: 'Choose a working folder (a folder that holds projects)', project: 'Choose a project folder to add', bridge: 'Choose your Myia Bridge folder (the one with start-bridge.cmd in it)' };
function pickFolder(purpose) {
  const title = PICK_TITLES[purpose] || PICK_TITLES.project;
  if (cfg.DRY) return Promise.resolve({ dryRun: 'folder picker: ' + title });
  return os.pickFolder(title);
}

// A plain terminal in the project folder. The Bridge starts no AI tool: Copy prompt gives the person a line to paste
// into the AI of their choice.
function openTerminal(dir) {
  if (cfg.DRY) return { dryRun: os.terminalCommand(dir) };
  os.openTerminal(dir);
  return {};
}

function openFolder(dir) {
  if (cfg.DRY) return { dryRun: 'explorer ' + dir };
  os.openFolder(dir);
  return {};
}
function revealFile(file) {
  if (cfg.DRY || cfg.DEMO) return { dryRun: 'explorer /select,' + file };
  os.revealFile(file);
  return {};
}

module.exports = { openBrowser, pickFolder, openTerminal, openFolder, revealFile };
