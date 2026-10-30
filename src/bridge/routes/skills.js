// Audits › Check a skill: a skill, plugin or agent folder checked before it is installed (lib/agents.js). Read only:
// the folder, zip or pasted text is read on this PC and nothing in it is run, fetched or kept.
'use strict';
const { checkSkill } = require('../agents');

const get = {};
const post = {
  '/api/skill-check': ({ body }) => {
    if (typeof body.text === 'string' && body.text.trim()) return checkSkill({ text: body.text, name: body.name });
    if (typeof body.path === 'string' && body.path.trim()) return checkSkill({ path: body.path.trim().replace(/^"(.*)"$/, '$1') });
    return { error: 'Paste the skill\'s text, or choose its folder or zip.' };
  },
};
// A pasted SKILL.md can be long (up to 200,000 characters, sent as JSON).
const BODY_LIMIT = 400000;

module.exports = { get, post, BODY_LIMIT };
