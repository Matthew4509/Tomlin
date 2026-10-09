// Saved prompts: text only, kept, shown and copied; never sent anywhere or run.
'use strict';
const cfg = require('../config');
const Prompts = require('../prompts');

const get = {
  '/api/prompts': () => Prompts.load(cfg.PROMPTS_FILE),
};
const post = {
  '/api/prompts/save': ({ body }) => Prompts.upsert(cfg.PROMPTS_FILE, body),
  '/api/prompts/remove': ({ body }) => Prompts.remove(cfg.PROMPTS_FILE, String(body.id || '')),
  '/api/prompts/category/save': ({ body }) => Prompts.saveCategory(cfg.PROMPTS_FILE, body),
  '/api/prompts/category/remove': ({ body }) => Prompts.removeCategory(cfg.PROMPTS_FILE, String(body.id || '')),
};
// A saved prompt can be long (up to 20,000 characters, sent as JSON), so these routes take a bigger body.
const BODY_LIMIT = 200000;

module.exports = { get, post, BODY_LIMIT };
