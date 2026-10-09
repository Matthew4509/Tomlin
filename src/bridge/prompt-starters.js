// The categories and prompts a Bridge starts with: nine kinds of expert, five prompts each. Words in [brackets] are for
// the person to fill in before pasting. Written once into <data>/prompts.json the first time it is read; after that
// they are the person's own to rename, edit or delete, and a deleted starter never comes back.
'use strict';

const STARTERS = [
  ['seo', 'SEO specialist', [
    ['Content brief for a keyword', 'Act as an SEO strategist. Build a content brief for the keyword "[keyword]": the search intent, 5 related keywords, the angle competitors miss, an H1 and H2 outline, and the word count to aim for.'],
    ['Title tags and meta descriptions', 'Write 5 title tags (under 60 characters) and 5 meta descriptions (under 155 characters) for a page about [topic]. Put the main keyword near the front and give a reason to click.'],
    ['On-page SEO audit', 'Here is my page:\n\n[paste the page]\n\nAudit it for on-page SEO: headings, keyword use, internal-link chances and thin sections. Rank the fixes by impact.'],
    ['Group keywords by intent', 'Group these keywords by search intent (informational, commercial, transactional) and suggest one page for each group:\n\n[list of keywords]'],
    ['FAQ section people search for', 'Write an FAQ section (6 questions) for [topic], using the questions people really search for. Answer each in 40 to 60 words.'],
  ]],
  ['writer', 'Writer and editor', [
    ['Tighten my writing', 'You are a sharp editor. Make this tighter and clearer without changing my voice. Show the edited version, then list the 5 biggest changes and why:\n\n[text]'],
    ['Write a piece to a brief', 'Write a [blog post / email / story] about [topic] for [reader]. Tone: [warm, plain, witty]. Length: [number] words. Avoid clichés, filler intros and the words [words to avoid].'],
    ['Headline options', 'Give me 10 headline options for [piece], mixing curiosity, benefit and how-to styles. Mark your top 3.'],
    ['Ask me first', 'Before you write anything, ask me up to 5 questions you need answered to do this well:\n\n[task]'],
    ['Rewrite for a reader', 'Rewrite this for [a 12-year-old / an executive / a technical reader], keeping every fact:\n\n[text]'],
  ]],
  ['code', 'Programmer', [
    ['Write a function', 'You are a senior [language] developer. Write a function that [does what]. Inputs: [inputs]. Outputs: [outputs]. Handle these edge cases: [edge cases]. No external libraries. Include tests.'],
    ['Find the cause of an error', 'This code throws [error]. Explain the root cause in plain words first, then give the smallest fix:\n\n[code]'],
    ['Review my code', 'Review this code for bugs, security holes and readability. Rank the findings by severity and show the fixed lines:\n\n[code]'],
    ['Explain this code', 'Explain what this code does line by line, as if I am new to [language]:\n\n[code]'],
    ['Plan before coding', 'I want to build [feature]. Before writing code, propose 2 approaches with their trade-offs, recommend one, and list the files you would touch.'],
  ]],
  ['marketing', 'Marketer and copywriter', [
    ['Positioning and value', 'Write a positioning statement and 3 value propositions for [product], aimed at [customer], against the competitors [competitors].'],
    ['Homepage hero copy', 'Write homepage hero copy for [product]: a headline, a subheading, a call-to-action button and 3 benefit bullets. Benefits, not features.'],
    ['Cold emails', 'Write 5 cold emails, each under 120 words, to [audience] about [offer], each with a different hook.'],
    ['Post to social posts', 'Turn this post into 5 social posts for [platform], each one standing on its own:\n\n[text]'],
    ['Answer the objections', 'List the 10 objections a [customer] would have to buying [product], with a one-line answer to each.'],
  ]],
  ['business', 'Business strategist', [
    ['SWOT analysis', 'Do a SWOT analysis for [business] in [market]. Be specific and skip generic points.'],
    ['What my numbers say', 'Here are my numbers:\n\n[data]\n\nWhat stands out? Give 3 insights and 3 actions, each with the number behind it.'],
    ["Devil's advocate", "Play devil's advocate on this plan. What are the 5 most likely ways it fails?\n\n[plan]"],
    ['Compare two options', 'Compare [option A] and [option B] for [goal] in a table: cost, time, risk and upside. Then recommend one.'],
    ['90-day plan', 'Break [goal] into a 90-day plan with weekly milestones and one measurable target per month.'],
  ]],
  ['teacher', 'Teacher and tutor', [
    ['Explain it three ways', 'Explain [concept] three ways: a simple analogy, a plain definition and a worked example.'],
    ['Quiz me', 'Quiz me on [topic], one question at a time. Wait for my answer, then correct me and explain.'],
    ['Study plan', 'Make a 4-week study plan for [skill] at [beginner / intermediate / advanced] level, 30 minutes a day.'],
    ['Common misunderstandings', 'What are the 5 most common misunderstandings about [topic], and the correct version of each?'],
    ['Summary and check', 'Summarise this in 5 bullet points, then give 3 questions to check I understood it:\n\n[text]'],
  ]],
  ['research', 'Researcher', [
    ['Overview of a topic', 'Give me an overview of [topic]: the key facts, the main debates, and what is still uncertain. Keep established facts apart from opinion.'],
    ['Pick a document apart', 'Summarise this document: its main claim, the evidence, the weaknesses, and what it leaves out:\n\n[text]'],
    ['The other side', 'What would a strong opponent of [position] argue? Give their best 3 points, fairly.'],
    ['Key terms', 'List the key terms I need to understand [field], with a one-line definition of each.'],
    ['Questions I have missed', 'What questions should I be asking about [topic] that I have not thought of?'],
  ]],
  ['design', 'Designer (UX)', [
    ['Usability review', 'Review this screen for usability: hierarchy, clarity and accessibility. Rank the issues by severity:\n\n[describe or attach the screen]'],
    ['Microcopy for a flow', 'Write the microcopy for [flow]: buttons, empty states and error messages (what went wrong, why, and what to do next).'],
    ['Three layouts', 'Suggest 3 layout options for a [page type] for [user], with the pros and cons of each.'],
    ['Colours and fonts', 'Give me a colour palette and a font pairing for a [mood] brand in [industry], with a reason for each choice.'],
    ['First-time user walk-through', 'Walk through [task] as a first-time user and list every point where I would get confused.'],
  ]],
  ['photo', 'Photographer', [
    ['Critique my photo', 'Act as a professional photographer. Critique this photo for composition, light, focus and story. Name the 3 changes that would improve it most:\n\n[attach the photo]'],
    ['Plan a shoot', 'Plan a [portrait / product / landscape / event] shoot of [subject] at [place, time of day]: the shot list, the gear, camera settings to start from, and a backup plan for bad light or weather.'],
    ['Settings for a situation', 'I shoot with [camera and lens]. What settings (mode, aperture, shutter speed, ISO, focus mode) should I start with for [situation], and why?'],
    ['Editing steps', 'Give me step-by-step [Lightroom / Photoshop / phone app] edits to make this photo look [mood or style], in the order to do them:\n\n[attach or describe the photo]'],
    ['Image-generator prompt', 'Write a detailed prompt for an AI image generator: [subject], shot on a [lens] at [aperture], [lighting], [mood], [composition], [colour grade]. Then give 2 variations.'],
  ]],
];

// Fixed ids, so reading the file twice before anything is saved gives the same list.
function starters(now) {
  const categories = [], prompts = [];
  for (const [id, name, list] of STARTERS) {
    categories.push({ id: 'starter-' + id, name, created: now });
    list.forEach(([title, text], i) => prompts.push({ id: 'starter-' + id + '-' + (i + 1), category: 'starter-' + id, title, text, created: now, updated: now }));
  }
  return { categories, prompts };
}

module.exports = { starters };
