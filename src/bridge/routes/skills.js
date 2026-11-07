// Audits › Check a skill: a skill, plugin or agent folder checked before it is installed (lib/agents.js). Read only:
// the folder, zip or pasted text is read on this PC and nothing in it is run, fetched or kept.
'use strict';
const { runAlone } = require('../audit');

// The check runs on a thread of its own with a time limit (lib/audit-part.js), like the parts of an audit: a slow pattern
// ends in a plain answer, never a frozen Bridge, and an answer cut short is never taken for a clean one.
const BUDGET_MS = 30000;
async function checkTimed(input, o = {}) {
  const r = await runAlone('skill', { input }, { budgetMs: BUDGET_MS, ...o });
  if (r.state === 'done') return r.result;
  if (r.state === 'stopped') return { error: 'The check stopped after ' + Math.round(r.ms / 100) / 10 + ' s, so nothing was concluded about this skill: this is not a pass. It may be very big, or a rule may be too slow for one of its files. Check a smaller part of it, or read it yourself before you install it.' };
  return { error: 'The check crashed (' + String(r.error).slice(0, 200) + '), so nothing was concluded about this skill: this is not a pass. Try again; if it repeats, read it yourself before you install it.' };
}

const get = {};
const post = {
  '/api/skill-check': ({ body }) => {
    if (typeof body.text === 'string' && body.text.trim()) return checkTimed({ text: body.text, name: body.name });
    if (typeof body.path === 'string' && body.path.trim()) return checkTimed({ path: body.path.trim().replace(/^"(.*)"$/, '$1') });
    return { error: 'Paste the skill\'s text, or choose its folder or zip.' };
  },
};
// A pasted SKILL.md can be long (up to 200,000 characters, sent as JSON).
const BODY_LIMIT = 400000;

module.exports = { get, post, BODY_LIMIT, checkTimed };
