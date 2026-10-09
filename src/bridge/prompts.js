// Saved prompts: text the person keeps to paste into Claude, ChatGPT or any AI, grouped in categories. Kept in
// <data>/prompts.json, read fresh on every request (so an edit made outside the page shows on the next load) and
// written whole through a temp file. The Bridge never sends or runs a prompt; the page only copies it to the clipboard.
// A file from before categories (no "categories" list) is given the starter categories once, and any prompts already
// in it go into a "My prompts" category, so none is lost.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { starters } = require('./prompt-starters');

const MAX_TITLE = 120;
const MAX_TEXT = 20000;
const MAX_PROMPTS = 500;
const MAX_NAME = 60;
const MAX_CATEGORIES = 100;

const isPrompt = p => p && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.text === 'string';
const isCategory = c => c && typeof c.id === 'string' && typeof c.name === 'string';

// A file that is there but unreadable is copied aside (prompts.damaged-<time>.json) before the starters replace it.
function setAside(file) {
  try { fs.copyFileSync(file, file.replace(/\.json$/i, '') + '.damaged-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'); } catch {}
}
function read(file) {
  let s = null, exists = true;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { if (e.code === 'ENOENT') exists = false; else setAside(file); }
  if (s !== null && (typeof s !== 'object' || Array.isArray(s))) { setAside(file); s = null; }
  if (exists && !s) s = {};
  const prompts = s && Array.isArray(s.prompts) ? s.prompts.filter(isPrompt) : [];
  if (s && Array.isArray(s.categories)) {
    // one category per id, never a blank name; a prompt whose category is gone goes to My prompts, not out of sight
    const seen = new Set();
    const categories = s.categories.filter(c => isCategory(c) && !seen.has(c.id) && seen.add(c.id)).map(c => (c.name.trim() ? c : { ...c, name: 'Untitled' }));
    const lost = prompts.filter(p => !seen.has(p.category));
    if (lost.length && !seen.has('mine')) categories.unshift({ id: 'mine', name: 'My prompts', created: new Date().toISOString() });
    for (const p of lost) p.category = 'mine';
    return { categories, prompts };
  }
  const now = new Date().toISOString();
  const st = starters(now);
  if (prompts.length) {
    st.categories.unshift({ id: 'mine', name: 'My prompts', created: now });
    st.prompts.unshift(...prompts.map(p => ({ ...p, category: 'mine' })));
  }
  save(file, st);
  return st;
}
const load = file => read(file);

function save(file, st) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ categories: st.categories, prompts: st.prompts }, null, 2));
  fs.renameSync(tmp, file);
}

// Line endings are kept as \n so a copied prompt pastes the same everywhere; nothing else in the text is changed.
function clean(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '') : '';
  if (!title) return { error: 'The prompt has no name. Give it a short name, so you can find it in the list.' };
  if (title.length > MAX_TITLE) return { error: 'The name is ' + title.length + ' characters; the most is ' + MAX_TITLE + '. Shorten it and save again.' };
  if (!text.trim()) return { error: 'The prompt text is empty. Type or paste the prompt, then save.' };
  if (text.length > MAX_TEXT) return { error: 'The prompt is ' + text.length + ' characters; the most is ' + MAX_TEXT + '. Split it into two prompts.' };
  return { title, text };
}

// Add (no id) or edit (id of a saved prompt). A new prompt goes to the top of its category; an edited one keeps its
// place, and moves when its category is changed.
function upsert(file, body) {
  const c = clean(body);
  if (c.error) return { ok: false, error: c.error };
  const st = read(file), list = st.prompts;
  if (!st.categories.some(x => x.id === body.category)) return { ok: false, error: 'That category is not on the list any more (it may have been deleted in another window). Reload the page and choose another.' };
  const now = new Date().toISOString();
  if (body.id) {
    const p = list.find(x => x.id === body.id);
    if (!p) return { ok: false, error: 'That prompt is not on the list any more (it may have been removed in another window). Reload the page.' };
    Object.assign(p, { category: body.category, title: c.title, text: c.text, updated: now });
    save(file, st);
    return { ok: true, prompt: p };
  }
  if (list.length >= MAX_PROMPTS) return { ok: false, error: 'You have ' + MAX_PROMPTS + ' prompts, the most the Bridge keeps. Remove one you no longer use, then add this one.' };
  const p = { id: crypto.randomBytes(6).toString('hex'), category: body.category, title: c.title, text: c.text, created: now, updated: now };
  list.unshift(p);
  save(file, st);
  return { ok: true, prompt: p };
}

function remove(file, id) {
  const st = read(file), list = st.prompts;
  const i = list.findIndex(x => x.id === id);
  if (i < 0) return { ok: false, error: 'That prompt is not on the list any more. Reload the page.' };
  const [gone] = list.splice(i, 1);
  save(file, st);
  return { ok: true, removed: gone };
}

// ---- categories: add (no id) or rename (id); a new one goes at the end. Names are unique, ignoring case. ----
function saveCategory(file, body) {
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { ok: false, error: 'The category has no name. Give it a short name, such as Photography.' };
  if (name.length > MAX_NAME) return { ok: false, error: 'The name is ' + name.length + ' characters; the most is ' + MAX_NAME + '. Shorten it and save again.' };
  const st = read(file);
  const same = st.categories.find(x => x.name.toLowerCase() === name.toLowerCase() && x.id !== body.id);
  if (same) return { ok: false, error: 'There is already a category called "' + same.name + '". Choose another name, or add your prompts to that one.' };
  if (body.id) {
    const c = st.categories.find(x => x.id === body.id);
    if (!c) return { ok: false, error: 'That category is not on the list any more (it may have been deleted in another window). Reload the page.' };
    c.name = name;
    save(file, st);
    return { ok: true, category: c };
  }
  if (st.categories.length >= MAX_CATEGORIES) return { ok: false, error: 'You have ' + MAX_CATEGORIES + ' categories, the most the Bridge keeps. Delete one you no longer use, then add this one.' };
  const c = { id: crypto.randomBytes(6).toString('hex'), name, created: new Date().toISOString() };
  st.categories.push(c);
  save(file, st);
  return { ok: true, category: c };
}

// Deleting a category deletes the prompts in it (the page says how many before it asks).
function removeCategory(file, id) {
  const st = read(file);
  const i = st.categories.findIndex(x => x.id === id);
  if (i < 0) return { ok: false, error: 'That category is not on the list any more. Reload the page.' };
  const [gone] = st.categories.splice(i, 1);
  const before = st.prompts.length;
  st.prompts = st.prompts.filter(p => p.category !== id);
  save(file, st);
  return { ok: true, removed: gone, prompts: before - st.prompts.length };
}

module.exports = { load, upsert, remove, saveCategory, removeCategory, MAX_TITLE, MAX_TEXT, MAX_NAME };
