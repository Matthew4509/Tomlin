// AI agent files: what Claude Code, Codex, Cursor and the like read as instructions (SKILL.md, CLAUDE.md, AGENTS.md,
// commands), the settings that let them act on their own (hooks, permissions, MCP servers), and the scripts a skill
// runs. A fault here is an attack on the person using the agent, not on the site's visitors: an instruction hidden
// where the agent reads it and the person does not (prompt injection), keys or files sent away, a download run as a
// program, a change that outlives the session.
// Two ways in: agentAudit(dir) inside a project audit (lib/audit.js), and checkSkill() for a skill before it is
// installed (a folder, a zip or .skill file, or pasted text). Read only: nothing found here is ever run or fetched.
// It finds the known shapes of these attacks. A skill it passes can still do harm in a way no rule here knows, so a
// skill that runs code is never called safe, only "no known attack found", with what it runs listed.
'use strict';
const fs = require('fs');
const path = require('path');
const { decodeText, readZip } = require('./disclosure');
const { siteOf } = require('./live');
const { fingerprint } = require('./judged');

const RULE = {
  'AGENT-001': { sev: 'Critical', title: 'A hidden instruction the agent reads but you never see', fix: 'Do not install or run it. Open the file in a plain text editor to see the hidden part; if it is your own file, delete the hidden text.' },
  'AGENT-002': { sev: 'Critical', title: 'Text hidden in invisible Unicode characters (the agent reads it, you see nothing)', fix: 'Do not install or run it. The hidden text is shown above; if it is your own file, retype the line in a plain editor.' },
  'AGENT-003': { sev: 'High', title: 'Invisible or direction-flipping characters in an instruction file', fix: 'Retype the line in a plain editor. These characters can make text read differently to the agent than it looks to you.' },
  'AGENT-004': { sev: 'High', title: 'Tells the agent to ignore its other instructions, or to keep something from you', fix: 'A skill has no reason to say this. Do not install it; if it is your own file, take the line out.' },
  'AGENT-005': { sev: 'High', title: 'Tells the agent to send keys, files or the conversation to an outside address', fix: 'Do not install it. Nothing you install should send your keys or files away.' },
  'AGENT-006': { sev: 'Critical', title: 'Downloads a program from the internet and runs it straight away', fix: 'Do not install it. What it downloads can change at any time after you checked it.' },
  'AGENT-007': { sev: 'Critical', title: 'Runs code that is hidden in an encoded string', fix: 'Do not install it. Code that hides what it does is the usual sign of malware.' },
  'AGENT-008': { sev: 'High', title: 'Reads your private keys, saved passwords or browser data', fix: 'Do not install it unless that is its whole job and you trust its maker. Nothing else needs these files.' },
  'AGENT-009': { sev: 'Critical', title: 'Collects every environment variable (all the keys on this PC) and talks to the internet', fix: 'Do not install it. A skill needs one named key at most, never all of them.' },
  'AGENT-010': { sev: 'High', title: 'Sends data to a drop box (a chat webhook, a paste site, a tunnel or a bare IP address)', fix: 'Do not install it. These addresses are where stolen data is usually collected.' },
  'AGENT-011': { sev: 'High', title: 'Uses your keys and talks to a service the skill never names', fix: 'Read the script: find where it sends your key. Install it only if that service is one you chose.' },
  'AGENT-012': { sev: 'High', title: 'Sets itself up to run again later (shell profile, startup, scheduled task, git hooks, the agent\'s own settings)', fix: 'Do not install it. A skill runs when you ask; it has no reason to start on its own later.' },
  'AGENT-013': { sev: 'High', title: 'Switches off the agent\'s permission checks', fix: 'Take it out. With the checks off, any instruction the agent reads (from a web page, an issue, a file) runs without asking you.' },
  'AGENT-014': { sev: 'Medium', title: 'Lets the agent run any command without asking', fix: 'Allow the commands you use (Bash(npm test:*), Bash(git status:*)), not every command.' },
  'AGENT-015': { sev: 'Medium', title: 'An MCP server is downloaded at whatever version is newest, each time it starts', fix: 'Pin a version (package@1.2.3): a new version, or a stolen maker account, then cannot change what runs without you knowing.' },
  'AGENT-016': { sev: 'Medium', title: 'A long encoded block in an instruction file (the agent can decode it; you cannot read it)', fix: 'Decode it before you trust the file, or ask its maker what it is.' },
  'AGENT-017': { sev: 'Medium', title: 'Every MCP server a project names is switched on without asking', fix: 'Set enableAllProjectMcpServers to false, so a project you download cannot start servers of its own.' },
  'AGENT-018': { sev: 'High', title: 'Uploads a file to a service the skill never names', fix: 'Do not install it until you know where that file goes and why. If it is your own skill, name the service in its text so a reader can judge it.' },
  'AGENT-019': { sev: 'Medium', title: 'An MCP server at a remote address nothing here names', fix: 'Find out who runs that address before the agent uses it: it sees what the agent sends and can feed the agent instructions. If you trust it, name it in the skill or the project notes.' },
  'AGENT-020': { sev: 'High', title: 'Settings send the agent\'s traffic through another address, or load code when it starts', fix: 'Take it out unless you set it yourself. With it in place, what the agent sends (your code, your keys) can go through someone else\'s machine, or their code runs in every program it starts.' },
  'AGENT-021': { sev: 'Medium', title: 'Settings let the agent work in folders outside the project', fix: 'Take the folder out of additionalDirectories unless you added it yourself: a project you download has no reason to reach the rest of your PC.' },
  'AGENT-022': { sev: 'High', title: 'Settings add a plugin source and switch on a plugin from it', fix: 'Take both out unless you know the source. A plugin can run its own code each time a session starts.' },
};

// The same line in a doc (the agent is told about it; a person may be too) is a warning to read first, with its own way out.
const DOC_FIX = {
  'AGENT-006': 'Before you (or the agent) run it, check the address belongs to the program\'s real maker, and that the skill needs it.',
  'AGENT-007': 'Read why it is here. A page about attacks may show one as a sample; nothing should tell you or the agent to run it.',
  'AGENT-008': 'Read what the skill asks the agent to do with that file. Only a setup guide for keys should name it, and never to send it anywhere.',
  'AGENT-010': 'The skill says it uses this service. Read what it sends there, and check the address is one you set up.',
  'AGENT-012': 'Read what the skill asks the agent to add there. A skill rarely needs to change how your PC or terminal starts.',
  'AGENT-013': 'Read why it is named here. If the skill leads you or the agent to switch the checks off, take that out or do not install it.',
  'AGENT-018': 'Read what the skill asks the agent to send there, and check the address belongs to a service you chose.',
};

// ---- which files ----
// Folders the agents keep their settings, skills and commands in.
const AGENT_DIRS = new Set(['.claude', '.agents', '.codex', '.cursor', '.windsurf', '.gemini', '.claude-plugin', '.clinerules', '.roo', '.kiro']);
// Inside them, folders that hold the agent's own logs and copies, not instructions (a worktree is a whole copy of the
// project, scanned already as the project itself).
const AGENT_SKIP = new Set(['worktrees', 'projects', 'todos', 'shell-snapshots', 'statsig', 'ide', 'logs', 'cache', 'tmp', 'node_modules', 'file-history', 'plans', 'debug']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv', 'coverage',
  '_build', '_dist', '_release', '_releases', 'releases', '_backups', '.next', '.nuxt', '.output', '.svelte-kit']);
const INSTRUCTION_FILE = /(^|\/)(SKILL|CLAUDE|CLAUDE\.local|AGENTS|GEMINI)\.md$|(^|\/)\.(cursorrules|windsurfrules|clinerules|roorules|roomodes)(-[\w-]+)?$|(^|\/)copilot-instructions\.md$|(^|\/)\.github\/(instructions|prompts|agents|chatmodes)\/.+\.md$|\.mdc$/i;
const SCRIPT = /\.(m?js|cjs|ts|mts|cts|py|sh|bash|zsh|fish|ksh|command|ps1|psm1|cmd|bat|rb|pl|php|lua|vbs|vbe|jse|wsf|wsh|hta)$/i;
// Folders whose agent reads every file in them as a rule, whatever its extension.
const RULE_FOLDER = /(^|\/)(\.clinerules|\.roo\/rules[^/]*|\.kiro\/steering|\.cursor\/rules|\.windsurf\/rules)\//i;
// Plain text an agent only reads when a doc tells it to: read as a doc when one names it (or its folder), else left alone.
const NAMED_TEXT = /\.(txt|text|rst|prompt|ya?ml)$/i;
// Data an agent can also be told to read: read as a doc only when a doc names the file itself. A project's folder of
// JSON is not instructions because a doc mentions the folder.
const DATA_TEXT = /\.(csv|tsv|json|xml|ini|cfg|conf|html?|log)$/i;
// Nothing here can look inside these: said, so a pass is not taken to cover them.
const SEALED = /\.(exe|dll|so|dylib|msi|scr|com|jar|war|class|pyc|pyd|wasm|node|bin|dmg|pkg|deb|rpm|zip|7z|rar|tar|gz|tgz|bz2|xz|whl|egg|skill|plugin|lnk)$/i;
const VSCODE_MCP = /(^|\/)\.vscode\/mcp\.json$/i;
// Config files that start a command by themselves: on install, on opening the folder, on building a dev container.
const AUTORUN = /(^|\/)(package\.json|\.vscode\/tasks\.json|\.devcontainer\.json|\.devcontainer\/(?:[^/]+\/)?devcontainer\.json)$/i;
const MAKEFILE = /^(GNUmakefile|makefile)$|\.mk$/i;
const MAX_FILES = 3000;
const MAX_BYTES = 400 * 1024;
const MAX_NAMED = 500;  // text files looked at for a doc naming them
const MAX_NAMED_HOSTS = 200;  // hosts checked against a skill's text: each one reads all of it

// ---- the patterns ----
// Said to the agent: ignore the rest, keep it from the person, a new "system" voice.
const OVERRIDE = /\b(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|every\s+)?(of\s+)?(the\s+|your\s+|my\s+)?(previous|prior|above|earlier|preceding|original|system|other|existing|safety|security)\s+(instructions?|rules?|prompts?|guidelines?|directions?|guardrails?|restrictions?|policies)\b/i;
// "Do not tell the user to restart" is advice about what to say, and "Don't mention tool names" is a rule of presentation:
// these are about an action the agent took (a step, a change, a file, "this", "it"), since a hit here means Do not install.
const CONCEAL = /\b(do\s+not|don['’]t|never|without)\s+(tell(ing)?|inform(ing)?|mention(ing)?\s+(it\s+|this\s+)?to|reveal(ing)?(\s+this|\s+it)?\s+to|alert(ing)?|notify(ing)?)\s+(the\s+|your\s+)?(user|human|owner|operator|person)\b(?!\s+(?:to|how\s+to|what\s+to|what\s+is|whether\s+to|about\s+each|the\s+answer|they\s+(?:need|should|must|have\s+to))\b)|\b(?:do\s+not|don['’]t|never|avoid)\s+(?:mention(?:ing)?|report(?:ing)?|disclos(?:e|ing)|reveal(?:ing)?)\s+(?:(?:this|that|these|those)\s+(?:\w+\s+)?(?:step|change|action|command|cleanup|edit|deletion|operation|upload|download|file)s?|the\s+(?:step|change|action|command|cleanup|edit|deletion|operation|upload|download|file)s?|this|that|it)\s+(?:to|in|from)\s+(?:the\s+|your\s+)?(?:user|human|owner|operator|person|(?:final\s+)?(?:summary|report|reply|response|output))\b|\b(?:do\s+not|don['’]t|never)\s+let\s+(?:the\s+|your\s+)?(?:user|human|owner|operator|person|them)\s+(?:know|find\s+out|notice|realize|realise)\b(?:\s+(?:that|about))?\s+(?:you|it|this|what|how|these|those)\b|\bwithout\s+(?:telling|informing|notifying|alerting)\s+(?:them|him|her)\b(?=[ \t]*(?:[.,;:!)\n]|$))|\b(keep|hide)\s+(this|it)\s+(secret\s+)?from\s+(the\s+)?(user|human|owner)\b|\b(silently|secretly|covertly)\s+(run|execute|send|upload|install|copy|post|exfiltrate|download)\b/i;
const ROLE = /<\/?(?:system(?:\s+[\w:-]+\s*=[^>\n]{0,40})?|(?:system_prompt|im_start|im_end)\b[^>\n]{0,40})>|<\|im_start\|>\s*(?:system|user|assistant|developer)\b|^[ \t]*<\|im_(?:start|end)\|>|\[\/?INST\]|^[ \t]*(#+[ \t]*)?(new|updated|real|actual)[ \t]+(system[ \t]+)?instructions[ \t]*:|\byou\s+are\s+now\s+(in\s+)?(developer|dan|god|admin|jailbreak|unrestricted)\b/im;
// A gap may hold a dot inside a word (.env, example.com), not the end of a sentence.
const EXFIL = /\b(send|post|upload|forward|e-?mail(?!\s+(?:and|or|address|field)\b)|transmit|exfiltrate|leak|submit)\b(?:[^.\n]|\.(?=\w)){0,80}?(?:\b|(?=\.env\b))(api[\s_-]?keys?|tokens?|secrets?|passwords?|credentials?|\.env\b|environment\s+variables?|env\s+vars?|ssh\s+keys?|id_rsa|cookies|conversation|chat\s+history|transcripts?|private\s+keys?)\b(?:[^.\n]|\.(?=\w)){0,80}?\b(to|into|via|at)\s+(https?:\/\/|[\w.+-]+@[\w-]+\.\w|a\s+webhook|(the|this|our|my)\s+(following\s+)?(url|endpoint|server|webhook|address))/i;
const EXFIL_ALL = new RegExp(EXFIL.source, 'gi');
// Sent out through what the agent writes, with no request of its own: showing an image fetches its address, so a key or
// the conversation in its query has left. A link needs a click, so it takes a token that names a secret; a placeholder
// in a link ("?title=<title>") is how a guide says "fill this in".
const SHOWN_URL = /(!?)\[[^\[\]\n]{0,200}\]\(\s*<?(https?:\/\/[^\s?#)]{1,300})\?((?:<[^>\n]{0,300}>|[^)\n]){0,800})|<(img)\b[^<>\n]{0,300}?\bsrc\s*=\s*["']?(https?:\/\/[^\s?#"'>]{1,300})\?([^"'\n]{0,800})|^[ \t]*\[[^\[\]\n]{1,100}\]:\s*<?(https?:\/\/[^\s?#>]{1,300})\?([^\n]{0,800})/gim;
const TEMPLATE_TOKEN = /\$\{?[A-Za-z_]\w{0,100}|\$\(|\{\{[^}\n]{1,200}\}\}|\{[A-Za-z_][\w .-]{0,60}\}|<[^>\n]{1,300}>/g;
const SECRET_WORD = /key|token|secret|pass|cred|cookie|auth|conversation|chat|transcript|history|session/i;
const MADE_UP_URL = /^https?:\/\/(?:[\w-]+\.)*(?:example\.(?:com|org|net)|[\w-]+\.(?:example|invalid|localhost))(?=[:\/]|$)/i;
// The same said in words: put a secret in the reply. The second form reads it first, then puts "its contents" there.
const LEAK_VERB = /\b(?:append(?:s|ing)?|include|includes|including|embed(?:s|ding)?|put(?:s|ting)?|paste|pastes|pasting|add(?:s|ing)?|render(?:s|ing)?|print(?:s|ing)?|output(?:s|ting)?|echo(?:es|ing)?|dump(?:s|ing)?|reveal(?:s|ing)?|insert(?:s|ing)?|attach(?:es|ing)?)\b/.source;
// Not design tokens, or a count of tokens used; not the transcript a meeting skill exists to write, only this session's.
const LEAK_TARGET = /(?:(?<![\w-])\.env\b(?!\.(?:example|sample|template))|\b(?:api|ssh|private|secret|access)[\s_-]?keys?\b|\byour\s+keys\b|(?<!\b(?:design|css|color|colour|theme|style|spacing|input|output|prompt|completion|max)\s)\btokens?\b(?!\s+(?:counts?|usage|used|costs?|limits?|budget|spent|per)\b)|\bsecrets?\b|\bcredentials?\b|\bpasswords?\b|\benv(?:ironment)?\s+var(?:iable)?s?\b|\b(?:full|entire|whole|complete|raw|previous|prior)\s+(?:\w+\s+)?conversation\b|\bconversation\s+(?:history|so\s+far|log)\b|\bchat\s+history\b|\b(?:chat|conversation|session|full|entire|whole|complete)\s+transcripts?\b|\bcookies\b|\bid_rsa\b)/.source;
// "The response" alone is left out: "include the token in the response" is how an API is described.
const LEAK_PLACE = /\b(?:to|in|into|within|inside|at|on)\b(?:[^.\n]|\.(?=\w)){0,40}?\b(?:(?:your|each|every|any|final)\s+(?:\w+\s+)?(?:reply|response|answer|summary|output|comment|message)|(?:the|a|an)\s+(?:\w+\s+)?(?:reply|answer|summary|output|comment))s?\b(?!\s+(?:headers?|body|object|json|payload|dir|directory|folder|files?|paths?|formats?|streams?)\b)/.source;
const LEAK_GAP = /(?:[^.\n]|\.(?=\w))/.source;
const OUTPUT_LEAK = new RegExp(LEAK_VERB + LEAK_GAP + '{0,80}?' + LEAK_TARGET + LEAK_GAP + '{0,80}?' + LEAK_PLACE
  + '|' + /\b(?:read|open|cat|load|get|fetch)\b/.source + LEAK_GAP + '{0,60}?' + LEAK_TARGET + LEAK_GAP + '{0,60}?' + LEAK_VERB + LEAK_GAP + '{0,40}?' + /\b(?:(?:its|their|the|that|those)\s+(?:\w+\s+)?(?:contents?|values?|text)|it|them)\b/.source + LEAK_GAP + '{0,60}?' + LEAK_PLACE, 'gi');
// A rule against it ("Never include API keys in your output"), or something that is not the secret itself.
const LEAK_REFUSED = /\b(?:never|not|don['’]t|doesn['’]t|avoid|avoiding|without|refrain|shouldn['’]t|mustn['’]t|won['’]t|can['’]t|cannot|instead\s+of|rather\s+than|no|prevent|stop)\b[^.,;:!?\n]{0,60}$/i;
const LEAK_NOT_SECRET = /\b(?:required|needed|necessary|missing|names?\s+of|list\s+of|number\s+of|count\s+of|how\s+many|how\s+to|which|masked|redacted|placeholder|fake|dummy|sample|summary\s+of)\b/i;
// The line of the first such thing, or 0. fenced: code blocks blanked; shown: inline code and comments blanked too, the
// same length. A command in backticks can still be what is meant, so it is judged, but a match that starts inside
// backticks or a comment is an example being shown, or hidden text with its own rule.
function outputLeakLine(fenced, shown) {
  const isShown = i => shown[i] !== ' ' || fenced[i] === ' ';
  for (const m of fenced.matchAll(SHOWN_URL)) {
    if (!isShown(m.index)) continue;
    const url = m[2] || m[5] || m[7], query = m[3] || m[6] || m[8] || '';
    if (LOCAL_URL.test(url) || MADE_UP_URL.test(url)) continue;
    const tokens = query.match(TEMPLATE_TOKEN);
    if (!tokens) continue;
    if (m[1] === '!' || m[4] || tokens.some(t => SECRET_WORD.test(t))) return lineAt(fenced, m.index);
  }
  for (const re of [EXFIL_ALL, OUTPUT_LEAK]) {
    for (const m of fenced.matchAll(re)) {
      if (!isShown(m.index)) continue;
      if (re === OUTPUT_LEAK && (LEAK_NOT_SECRET.test(m[0]) || LEAK_REFUSED.test(fenced.slice(Math.max(0, m.index - 80), m.index)))) continue;
      return lineAt(fenced, m.index);
    }
  }
  return 0;
}
// Hidden text is judged by the same words, and also by a command or a key sent away in it. A plain note or a link in
// a comment ("<!-- see https://... -->", "<!-- keep this short -->") is left alone.
const HIDDEN_ACTS = /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|iex|bash\s+-c|sh\s+-c|powershell\s+-\w+|base64\s+(-d|--decode))\b|\|\s*(ba)?sh\b|\b(send|upload|post|e-?mail(?!\s+(?:and|or|address|field)\b)|exfiltrate|forward)\b[^.\n]{0,60}(\.env\b|\.ssh|id_rsa|credentials|api[_ -]?keys?|tokens?|passwords?|secrets?)/i;

const DOWNLOAD_RUN = /\b(curl|wget)\b[^\n|;]{0,300}\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(curl|wget)\b[^\n|;]{0,300}\|\s*(python3?|node|perl|ruby)\b|\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b[^\n]{0,300}\|\s*(iex|Invoke-Expression)\b|\b(iex|Invoke-Expression)\b\s*\(?\s*\(?\s*(New-Object\s+(System\.)?Net\.WebClient|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b|\b(ba)?sh\s+<\(\s*(curl|wget)\b|\bcertutil(\.exe)?\b[^\n]{0,80}-urlcache\b|\bbitsadmin(\.exe)?\b[^\n]{0,80}\/transfer\b|\bmshta(\.exe)?\s+["']?https?:/i;
const ENCODED_EXEC = /\b(eval|exec|Function|execSync|spawnSync)\s*\(\s*(atob|base64\.b64decode|b64decode|bytes\.fromhex|codecs\.decode|zlib\.decompress|marshal\.loads|unescape)\s*\(|\b(eval|Function)\s*\(\s*Buffer\.from\([^)]{0,2000}['"](base64|hex)['"]|\bexec\s*\(\s*compile\s*\(\s*(base64|zlib)|FromBase64String[^\n]{0,300}\b(iex|Invoke-Expression)\b|\b(iex|Invoke-Expression)\b[^\n]{0,300}FromBase64String|\bpowershell(\.exe)?\b[^\n]{0,200}\s-(e|ec|en|enc|enco|encod|encode|encodedcommand)\s+[A-Za-z0-9+/=]{16,}|\becho\s+["']?[A-Za-z0-9+/=]{40,}["']?\s*\|\s*base64\s+(-d|--decode)\b[^\n]{0,40}\|\s*(ba)?sh\b/i;
// A whole folder of keys or tokens (~/.ssh, ~/.claude), with nothing after it naming one harmless file in it. The
// agent's folder needs the home prefix: ".claude" alone is the project's own, and ~/.claude/settings.json is everywhere.
const SECRET_FILE = /\.ssh[\\/]+(id_(rsa|dsa|ecdsa|ed25519)\b(?!\.pub)|authorized_keys|config)\b|\bid_(rsa|dsa|ecdsa|ed25519)\b(?!\.pub)|\.aws[\\/]+credentials|\.azure[\\/]+(accessTokens|msal_token_cache)|\.kube[\\/]+config|\.docker[\\/]+config\.json|\.git-credentials\b|[\\/]\.netrc\b|[\\/]\.npmrc\b|[\\/]\.pypirc\b|(?<=[\\/"'])(?:Login|Web) Data\b|cookies\.sqlite|\blogins\.json\b|\bkey4\.db\b|\bwallet\.dat\b|\bsecurity\s+find-(generic|internet)-password\b|\bcmdkey\s+\/list\b|\bvaultcmd\b|\.claude[\\/]+\.credentials\.json|\.config[\\/]+gh[\\/]+hosts\.yml|Local Storage[\\/]+leveldb|\\AppData\\Roaming\\(Exodus|Electrum|Ethereum|atomic)\b|[\\/]\.claude\.json\b|\.codex[\\/]+auth\.json\b|(?<![\w.-])\.ssh(?:[\\/]+\*{0,2})?(?![\w\\/*-]|\.\w)|(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|%HOME%|\$env:USERPROFILE|\$env:HOME)[\\/]+\.claude(?:(?:[\\/]+\*{0,2})?(?![\w\\/*$-]|\.\w|\}[\\/]\w)|[\\/]+(?:projects|history\.jsonl)\b)|homedir\(\)\s*,\s*['"]\.claude['"]\s*\)|homedir\(\)\s*\+\s*['"`][\\/]\.claude['"`]|Path\.home\(\)\s*\/\s*['"]\.claude['"](?!\s*\/)/i;
// A line that holds a search pattern, not a path being opened.
const PATTERN_LINE = /\(\?:|\bre\.(?:compile|search|match|sub|findall)\(|\bnew RegExp\(|["']regex["']\s*:|(?:^|[\s(,=])\/\^|\/\\b|\br["']\^/;
// A deny list or a rule: a glob, a permission line, a citation of one transcript line, a list named for what it refuses.
// Harmless unless the same line reads what it finds.
const NAMING_LINE = /\*\*\/|\b(?:Read|Edit|Write)\(|\.jsonl#L|#L%|\b[A-Z_]*(?:HINT|DENY|BLOCK|SENSITIVE|PROTECT|FORBID|PATTERN|IGNORE|SECRET)[A-Z_]*\s*=\s*[\[({][^/~\n]*$/;
// A line holding nothing but names, in a list with no folders. Soft only where the file never mentions home.
const BARE_NAMES = /^\s*(?:["'][^"'/\\~\n]{1,40}["']\s*,?\s*)+[)\]]?,?\s*$/;
const READS_IT =/\b(?:open|read\w*|cat|type|copy|cp|scp|rsync|tar|zip|base64|curl|wget|glob\w*|Get-Content|make_archive|copytree|walk|readdir\w*)\b/i;
// The agent's folder or its config named on its own (a default, a state folder): only a reading of it is a reading.
const AGENT_FOLDER_ONLY = /^(?:[\\/]\.claude\.json|.*\.claude['"]?\s*\)?)$/i;
// A project's own package settings, not the ones in this person's home.
const HOME_MARK = /~|\$\{?HOME\b|%USERPROFILE%|%HOME%|\$env:(?:USERPROFILE|HOME)|homedir\(\)|expanduser|Path\.home\(\)/i;
// Looking under the agent's folder for one of the skill's own scripts.
const FIND_OWN_SCRIPT = /\bfind\b[^\n|;]{0,200}?\s-(?:path|name|iname)\s+['"]?[^\s'"]*\.(?:sh|py|js|mjs|ts|md)\b['"]?/g;
// The first line naming a key file. soft: the line only names it (a pattern, a deny list, a default folder), so the
// skill is to be read first and the internet does not raise it.
function secretHit(text) {
  if (!SECRET_FILE.test(text)) return null;
  let soft = 0;
  const lines = text.split('\n');
  const homeUsed = HOME_MARK.test(text);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].length > 4000 ? lines[i].slice(0, 4000) : lines[i];
    const m = SECRET_FILE.exec(l.includes('find') ? l.replace(FIND_OWN_SCRIPT, ' ') : l);
    if (!m) continue;
    const dotfile = /^[\\/]\.(?:npmrc|pypirc)$/i.test(m[0]);
    const reads = READS_IT.test(l.replace(/\b(?:Read|Edit|Write)\(/g, ' '));
    const named = PATTERN_LINE.test(l) || /\b(?:blocked|denied|refused)\s+(?:on|from|for)\b/i.test(l) || (!reads &&(NAMING_LINE.test(l) || (!homeUsed && BARE_NAMES.test(l)) || AGENT_FOLDER_ONLY.test(m[0]))) || (dotfile && !HOME_MARK.test(l));
    if (!named) return { line: i + 1, soft: false };
    if (!soft) soft = i + 1;
  }
  // Nothing on one line, or only the skill's own scripts looked for: the whole text is what matched.
  if (soft) return { line: soft, soft: true };
  return SECRET_FILE.test(text.replace(FIND_OWN_SCRIPT, ' ')) ? { line: firstLine(SECRET_FILE, text), soft: false } : null;
}
const NETWORK = /\b(fetch|axios|XMLHttpRequest|WebSocket|requests\.(get|post|put|request|Session)|httpx|urllib|urlopen|aiohttp|smtplib|nodemailer|curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Net\.WebClient|UploadString|UploadFile|ncat|scp)\b|\bhttps?\.(get|request)\s*\(|\bsocket\.(socket|connect|create_connection)\b|\bnc\s+-|\bnet\.connect\s*\(|\bMSXML2\.\w{0,20}XMLHTTP\b/i;
const DROPBOX = /https?:\/\/(?:[\w-]+\.)*(discord(app)?\.com\/api\/webhooks|hooks\.slack\.com\/services|api\.telegram\.org\/bot|pastebin\.com|paste\.ee|hastebin\.com|transfer\.sh|file\.io|0x0\.st|ngrok(-free)?\.(io|app|dev)|webhook\.site|requestbin\.\w+|pipedream\.net|beeceptor\.com|burpcollaborator\.net|oast\.(pro|live|site|online|fun|me)|interact\.sh|trycloudflare\.com|serveo\.net|localtunnel\.me|loca\.lt)\b|https?:\/\/(?!(127|10|0)\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}(\.\d{1,3}){3}\b/i;
// An address that holds nothing real: an example path, or one too short to be a webhook. A name or a variable still
// counts, since a real one is often built that way. Slack: T.../B.../secret. Discord: a long number.
const DROP_ALL = new RegExp(DROPBOX.source, 'gi');
const DROP_BRAND = /slack|discord|telegram/i;
function dropHit(text) {
  for (const m of text.matchAll(DROP_ALL)) {
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 120).split(/[\s"'`)\]]/)[0];
    const host = m[0].replace(/^https?:\/\//i, '');
    if (/^(?:abc\d*|your|xxx|my-?\w*|example)[.-]/i.test(host)) continue;
    if (/^\/?(?:\.\.\.|<|\{\{|YOUR\b|X{3,}|x{3,})/.test(tail) || /X{4,}|0{7,}/.test(tail)) continue;
    if (/slack/i.test(host) && /^\/[\w-]/.test(tail) && !/^\/T\w{6,}\/B\w{6,}\/\w/.test(tail)) continue;
    if (/discord/i.test(host) && /^\/[A-Za-z]/.test(tail)) continue;
    const brand = DROP_BRAND.exec(host);
    return { line: lineAt(text, m.index), brand: brand ? brand[0].toLowerCase() : '' };
  }
  return null;
}
// The whole environment collected, or passed whole as what is sent. Handed to a child process (env: process.env,
// {...process.env}, env=dict(os.environ)) is the common honest shape and is not here; a copy kept in a name is judged
// by where that name goes (envDumpAt).
const ENV_DUMP = /JSON\.stringify\(\s*process\.env\s*[,)]|Object\.(entries|keys|values)\(\s*process\.env\s*\)|(?<!\benv\s{0,4}=\s{0,4}|\belse\s{1,4})\bdict\(\s*os\.environ\s*\)|\bos\.environ\.items\(\)(?!\s+if\b)|json\.dumps\(\s*(dict\()?\s*os\.environ|\bfor\s+\w+(\s*,\s*\w+)?\s+in\s+os\.environ\b(?!\.items\(\)\s+if\b)|\bprintenv\b(?!["']?\s*[:,])|(?<![|\-.:\\/_$\w])(?<!\w\()env\s*(?:\|(?!\||\s*grep\s+-\w*q)|>)|\$\(\s*env\s*\)|Get-ChildItem\s+(-Path\s+)?env:|\b(gci|ls|dir)\s+env:|\[(System\.)?Environment\]::GetEnvironmentVariables\(\s*\)|\b(?:body|data|json|params|payload|content|form)\s*[:=]\s*(?:\{\s*(?:\.\.\.|\*\*)\s*)?(?:process\.env\b|os\.environ\b(?:\.copy\(\))?)(?!\s*[.\[])|\.(?:post|put|patch|send|write|request|emit)\s*\([^\n]{0,200}?[(,\s](?:process\.env|os\.environ(?:\.copy\(\))?)\s*[,)]|\.(?:post|put|patch|send|write|request|emit)\s*\([^\n]{0,200}?\bos\.environ\.items\(\)/i;
function envDumpAt(code) {
  const m = ENV_DUMP.exec(code);
  if (m) return m.index;
  let n = 0;
  for (const a of code.matchAll(/\b(\w{1,40})\s*=\s*(?:os\.environ\.copy\(\)|os\.environ\b(?!\s*[.\[])|process\.env\b(?!\s*[.\[])|\{\s*\.\.\.process\.env\b|dict\(\s*os\.environ\b|\{\s*\*\*os\.environ\b|\{[^}\n]{0,80}\bos\.environ\.items\(\)\s+if\b)/g)) {
    if (++n > 20) break;
    const sent = new RegExp('\\b(?:body|data|json|params|payload|content|form)\\s*[:=]\\s*(?:JSON\\.stringify\\(\\s*)?' + a[1] + '\\b|(?:JSON\\.stringify|json\\.dumps)\\(\\s*' + a[1] + '\\b|\\.(?:post|put|patch|send|write)\\s*\\([^\\n]{0,200}?[(,\\s]' + a[1] + '\\s*[,)]').exec(code);
    if (sent) return sent.index;
  }
  return -1;
}
// The name of a key read from the environment (one capture group per way of reading it).
const KEY_ENV = /process\.env\.([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|CREDENTIALS?)[A-Za-z0-9_]*)|process\.env\[\s*['"]([^'"]*(?:KEY|TOKEN|SECRET|PASS)[^'"]*)['"]|os\.(?:environ\.get|getenv)\(\s*['"]([^'"]*(?:KEY|TOKEN|SECRET|PASS)[^'"]*)['"]|os\.environ\[\s*['"]([^'"]*(?:KEY|TOKEN|SECRET|PASS)[^'"]*)['"]|\$env:([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASS)[A-Za-z0-9_]*)|\$\{?([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\b/;
const PERSIST_TARGET = /\.bashrc\b|\.zshrc\b|\.bash_profile\b|\.zprofile\b|[\\/]\.profile\b|config\.fish\b|PowerShell_profile\.ps1\b|\$PROFILE\b|Start Menu[\\/]+Programs[\\/]+Startup|[\\/]Startup[\\/]|\.git[\\/]+hooks[\\/]|\.claude[\\/]+settings(\.local)?\.json|\.claude[\\/]+CLAUDE\.md|LaunchAgents[\\/]/i;
const WRITES = /(^|[\s\d])>>?\s*["']?[~$\w%\\/.-]|\b(Add-Content|Set-Content|Out-File|New-Item|Copy-Item|appendFile(Sync)?|writeFile(Sync)?|copyFile(Sync)?|symlink(Sync)?|tee)\b|\bopen\([^)]{0,300}['"](a|w|a\+|w\+)['"]|\bcp\s|\bcopy\s|\bln\s+-s\b/i;
const PERSIST_CMD = /\bschtasks(\.exe)?\s+\/create\b|\bRegister-ScheduledTask\b|\breg(\.exe)?\s+add\s+[^\n]{0,200}\\(Run|RunOnce)\b|\bNew-ItemProperty\b[^\n]{0,200}\\(Run|RunOnce)\b|(?<!\$)\(crontab\s+-l|\bcrontab\s+-\s*$|\bcrontab\s+\S+\.(txt|cron)\b|\blaunchctl\s+(load|bootstrap)\b|\bsystemctl\s+(--user\s+)?enable\b|\bgit\s+config\s+--global\s+core\.hooksPath\b/im;
// A write to a start-up place: output thrown away is no write, and a copy writes only to its last name.
function persistWrite(l) {
  if (!PERSIST_TARGET.test(l)) return false;
  const c = l.trimEnd().replace(/\d?>\s*\/dev\/null\b/g, ' ').replace(/\d?>&\d/g, ' ');
  if (!WRITES.test(c)) return false;
  const cp = /^\s*(?:sudo\s+)?(?:cp|copy)\s+(.+)$/i.exec(c);
  return !cp || /[>|;&]|\s-t\b/.test(cp[1]) || PERSIST_TARGET.test(cp[1].trim().split(/\s+/).pop());
}
const BYPASS = /--dangerously-skip-permissions\b|["']?defaultMode["']?\s*:\s*["']bypassPermissions["']|--permission-mode[\s=]+bypassPermissions\b|--dangerously-bypass-approvals-and-sandbox\b|\bapproval[_-]policy\s*=\s*["']?never\b|["']?permissionMode["']?\s*:\s*["']?bypassPermissions\b|\bsandbox[_-]mode\s*=\s*["']?danger-full-access\b/i;
const WIDE_ALLOW = /^(Bash|PowerShell|Shell)(\(\s*:?\s*\*+\s*(:\s*\*+)?\s*\))?$/;
// A data: picture is a long base64 block too, and one the reader sees as a picture.
const B64_BLOCK = /(?<![A-Za-z0-9+/=]|base64,)[A-Za-z0-9+/]{240,}={0,2}(?![A-Za-z0-9+/=])/;

// File uploads. curl's flags are case-sensitive (-F is a form, -f is "fail quietly"), and -XPOST ends in T without being
// -T: only flags that take no value of their own may sit in front of the one looked for. Read one command at a time.
const CURL_LONE = 'sSfLkiIvgGnNOqRjJlaBp46';
const UPLOAD_CURL = new RegExp('(?:^|\\s)(?:-[' + CURL_LONE + ']*[FT](?=[\\s=\\w"\'@])|--form(?:-string)?\\b|--upload-file\\b|(?:-[' + CURL_LONE + ']*d\\s*|--data(?:-binary|-ascii|-urlencode)?[\\s=]+|--json[\\s=]+)["\']?[\\w-]*@)');
const UPLOAD_PS = /\s-(?:InFile|Form)\b/i;
const UPLOAD_CODE = /\bFormData\s*\(|\b(?:requests|httpx|session|sess|client)\.(?:post|put|patch|request)\s*\([\s\S]{0,400}?\bfiles\s*=|\bdata\s*=\s*open\(|\bbody\s*:\s*(?:fs\.)?(?:readFileSync|createReadStream)\(|\.Upload(?:File|Data)(?:Async)?\s*\(/;
const SECRET_NAME = /(^|[\s@"'\/\\=])\.env\b(?!\.(?:example|sample|template))/;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:\/?#"'\s]|$)/i;
// One line's worth of a command: its own pipeline and sequence marks end it.
const COMMANDS_ON_LINE = /;|\|\||&&|\|/;

// Saved to a file, then run. Which file a download saves to, per tool.
const DOWNLOADER = /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadFile|Start-BitsTransfer|urlretrieve)\b/i;
const CURL_OUT = new RegExp('(?:^|\\s)(?:-[' + CURL_LONE + ']*o\\s*|--output[\\s=]+)["\']?([^\\s"\']{1,300})');
const CURL_REMOTE = new RegExp('(?:^|\\s)(?:-[' + CURL_LONE + ']*O\\b|--remote-name\\b)');
const WGET_OUT = /(?:^|\s)(?:-[qcnv]*O\s*|--output-document[\s=]+)["']?([^\s"']{1,300})/;
const URL_TAIL = /https?:\/\/[^\s"']{1,1000}\/([^\s"'\/?#]{1,300})/;
const REDIRECT_OUT = />\s*["']?([^\s"'>]{1,300})/;
const PS_OUT = /\s-(?:o\w{0,8}|Destination)\s+["']?([^\s"')]{1,300})/i;
const WEBCLIENT_OUT = /DownloadFile\([^,\n]{0,500},\s*["']([^"']{1,300})/i;
const RETRIEVE_OUT = /\b(?:urlretrieve|wget\.download)\s{0,4}\([^,\n]{0,500},\s{0,4}(?:(?:filename|out)\s{0,4}=\s{0,4})?(?:["']([^"'\n]{1,300})["']|([A-Za-z_]\w{0,60})\s{0,4}[,)])/;
// What a line runs: a program given the file, or the file itself where a command goes.
const RUNS_FILE = /(?:^|[\s;&|('"])(?:(?:ba|z|da|k|c|fi)?sh|source|\.|python[\d.]{0,5}|py|node|deno|bun|perl|ruby|php|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?|exec|call|(?<!&)&|Start-Process|start|cscript|wscript|mshta|rundll32|regsvr32|msiexec)(?:\s+(?:-{1,2}[\w-]{1,40}(?:\s+(?:Bypass|Unrestricted|RemoteSigned|Hidden))?|\/[a-z])){0,5}\s+["']?([^\s"';&|)]{1,300})|(?:^\s*|[;&|(]\s*)["']?((?:\.{0,2}[\\/]|~[\\/]|\$\{?\w{1,40}\}?[\\/])[^\s"';&|)]{1,300})|(?:^\s*|[;&|(]\s*)["']?([\w.-]{1,200}\.(?:bat|cmd|exe|ps1|vbs|com|scr))\b/gi;
// The same run written as code: a list of arguments, a call given the variable that holds the name, code loaded from
// the file.
const RUN_PROGRAM = '(?:python[\\d.]{0,5}|py|node|deno|bun|(?:ba|z|da|k|c|fi)?sh|perl|ruby|php|pwsh|powershell)';
const RUN_ARGS = new RegExp('["\']' + RUN_PROGRAM + '["\']\\s{0,4},\\s{0,4}\\[?\\s{0,4}(?:["\']-[\\w-]{1,40}["\']\\s{0,4},\\s{0,4}){0,5}["\']([^"\'\\n]{1,300})["\']|\\[\\s{0,4}["\'](\\.{0,2}[\\\\/][^"\'\\n]{1,300})["\']', 'gi');
const RUN_VAR = new RegExp('(?<![\\w-])' + RUN_PROGRAM + '\\s{0,4}["\'`]?\\s{0,4}(?:,|\\+|\\$?\\{)\\s{0,4}\\[?\\s{0,4}([A-Za-z_$][\\w$]{0,60})|(?<![\\w.$])(?:subprocess\\.\\w{1,20}|os\\.system|os\\.popen|os\\.startfile|execSync|execFileSync|execFile|spawnSync|spawn|exec)\\s{0,4}\\(\\s{0,4}\\[?\\s{0,4}([A-Za-z_$][\\w$]{0,60})(?=\\s{0,4}[,\\])])', 'gi');
const RUN_LOAD = /(?<![\w.$])(?:exec\s{0,4}\(\s{0,4}open\s{0,4}\(|runpy\.run_path\s{0,4}\(|require\s{0,4}\(|import\s{0,4}\()\s{0,4}["'`]([^"'`\n]{1,300})["'`]/g;
// A language's own web client, and the calls that run a string as code or as a command.
const WEB_CLIENT = /(?:(?<![\w.$])(?:requests\.(?:get|post|put|request|Session)|httpx\.(?:get|post|request|stream|Client|AsyncClient)|(?:(?:window|globalThis)\.)?fetch|axios(?:\.(?:get|post|request))?|got(?:\.(?:get|post))?|https?\.(?:get|request)|Net::HTTP\.(?:get|post|get_response|start)|URI\.open)|\b(?:urlopen|file_get_contents|curl_exec))\s{0,4}\(/;
const RUNS_CODE = /(?<![\w.$])(?:exec|eval|Function|execSync|vm\.(?:runIn\w{0,10}Context|Script)|os\.(?:system|popen)|subprocess\.(?:run|call|Popen|check_output|check_call))\s{0,4}\(/;
const RUNS_CODE_ALL = new RegExp(RUNS_CODE.source, 'g');
// Run the moment it arrives: the web client's call inside the running call's brackets, or a response's text there. No
// quote or closing bracket may come first: a client named inside a string only fetches, and one after the bracket has
// closed is not what was run.
const WEB_CODE_RUN = new RegExp(RUNS_CODE.source + '(?:[^\\n;)"\'`]{0,120}?' + WEB_CLIENT.source + '|\\s{0,4}(?:await\\s{1,4})?(?:res|resp|response)\\.(?:text|json|arrayBuffer)\\s{0,4}\\()');
// A web client's file saved with its name in quotes or in a variable.
const FILE_ARG = '(?:["\'`]([^"\'`\\n]{1,300})["\'`]|([A-Za-z_$][\\w$]{0,60}))';
const PY_OPEN = new RegExp('(?<![\\w.$])open\\s{0,4}\\(\\s{0,4}' + FILE_ARG + '\\s{0,4},\\s{0,4}(?:mode\\s{0,4}=\\s{0,4})?["\'][wax]b?\\+?t?["\']');
const OTHER_WRITE = new RegExp('(?:(?<![\\w$])(?:writeFile(?:Sync)?|appendFile(?:Sync)?|writeTextFile(?:Sync)?|Bun\\.write)\\s{0,4}\\(\\s{0,4}' + FILE_ARG + '\\s{0,4},|(?<![\\w.$])Path\\s{0,4}\\(\\s{0,4}' + FILE_ARG + '\\s{0,4}\\)\\.write_(?:text|bytes)\\s{0,4}\\()');
const STREAM_OUT = new RegExp('\\bcreateWriteStream\\s{0,4}\\(\\s{0,4}' + FILE_ARG);
const HANDLE_WRITE = /(?<![\w.$])([A-Za-z_$][\w$]{0,60})\.write(?:lines)?\s{0,4}\(/;
const HANDLE_COPY = /\bcopyfileobj\s{0,4}\(\s{0,4}([^,\n]{1,200}),\s{0,4}([A-Za-z_]\w{0,60})/;
const ASSIGN = /^\s{0,200}(?:(?:const|let|var)\s{1,4})?(?:([A-Za-z_$][\w$]{0,60})|\{\s{0,4}([A-Za-z_$][\w$]{0,60})\s{0,4}\})\s{0,4}=(?![=>])/;
const FOR_EACH = /^\s{0,200}(?:async\s{1,4})?for\s{1,4}([A-Za-z_]\w{0,60})\s{1,4}in\s/;
const THEN_ARG = /\.then\s{0,4}\(\s{0,4}(?:async\s{1,4})?(?:function\s{0,4})?\(?\s{0,4}([A-Za-z_$][\w$]{0,60})/g;
const THEN_RUN = /\.then\s{0,4}\(\s{0,4}(?:eval|Function)\s{0,4}\)/;
const CHECKED_HASH = /\b(sha256sum|sha512sum|shasum|Get-FileHash|minisign|cosign\s+verify|gpg\s+--verify|hashlib\.sha(256|512)|createHash)\b/i;

// ---- reading helpers ----
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
// Lines a backslash continues are read as one command. The mark keeps the count of lines they came from.
const JOIN_MARK = String.fromCharCode(1);
const JOIN_LINES = new RegExp('[\\n' + JOIN_MARK + ']');
const flatLineAt = (flat, index) => flat.slice(0, index).split(JOIN_LINES).length;
function joinContinued(text, lang) {
  const re = lang === 'ps' ? /`\r?\n/g : lang === 'cmd' ? /\^\r?\n/g : /\\\r?\n/g;
  return text.replace(re, JOIN_MARK + ' ');
}
// Code blocks and inline code blanked, line breaks kept: an example in backticks is shown, not said. The commands
// in a code block are still read by the script checks (a skill's code block is what the agent runs).
const fencesOff = text => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, m => m.replace(/[^\n]/g, ' '));
function proseOf(text) {
  return fencesOff(text).replace(/`[^`\n]+`/g, m => ' '.repeat(m.length));
}
// Which comments a script's language has. A /* in a shell glob, a # in a JS string and a line a shell runs that reads
// as // in another language are not comments, so each language is read by its own rules. With no extension the first
// line says what runs it; a command with neither is read as a shell reads it.
function langOf(rel, raw) {
  const ext = (/\.(\w+)$/.exec(path.posix.basename(rel)) || [])[1];
  if (ext) {
    const e = ext.toLowerCase();
    if (/^(m?js|cjs|ts|mts|cts|jse|php)$/.test(e)) return 'c';
    if (e === 'py') return 'py';
    if (/^(ps1|psm1)$/.test(e)) return 'ps';
    if (/^(cmd|bat)$/.test(e)) return 'cmd';
    if (/^(vbs|vbe)$/.test(e)) return 'vb';
    if (/^(sh|bash|zsh|fish|ksh|command|rb|pl|mk)$/.test(e)) return 'hash';
    return 'none';
  }
  const first = (/^\uFEFF?#!([^\n]{0,200})/.exec(raw) || [])[1] || '';
  if (/\b(node|deno|bun|tsx|ts-node)\b/.test(first)) return 'c';
  if (/\bpython/.test(first)) return 'py';
  if (/\b(pwsh|powershell)\b/.test(first)) return 'ps';
  return 'hash';
}
const blankOut = s => s.replace(/[^\n]/g, ' ');
// A slash can start a regular expression after one of these, and only divides after anything else.
const BEFORE_REGEX = /[(,=:[!&|?{};+\-*%<>~^]/;
const WORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do)\s*$/;
// The spans of C-like, Python and PowerShell text that are comments, found in one pass that knows about strings: each
// closing mark is looked for once, and once one is missing it is not looked for again, so unclosed ones cost nothing.
function commentSpans(raw, lang) {
  const spans = [];
  const n = raw.length;
  const isC = lang === 'c', isPs = lang === 'ps', isPy = lang === 'py';
  const open = isC ? '/*' : '<#', shut = isC ? '*/' : '#>';
  const missing = new Set();
  const find = (mark, from) => {
    if (missing.has(mark)) return -1;
    const at = raw.indexOf(mark, from);
    if (at < 0) missing.add(mark);
    return at;
  };
  let i = 0, lineFresh = true, prev = '', noRegexBefore = 0;
  while (i < n) {
    const ch = raw[i];
    if (ch === '\n') { lineFresh = true; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    // A comment that fills its line. One after code on the same line is left in: the line is code either way.
    if (lineFresh && (isC ? raw.startsWith('//', i) : ch === '#' && raw[i + 1] !== '!')) {
      const e = raw.indexOf('\n', i);
      const end = e < 0 ? n : e;
      spans.push([i, end]);
      i = end;
      continue;
    }
    if ((isC || isPs) && raw.startsWith(open, i) && raw[i - 1] !== '\\') {
      const e = find(shut, i + 2);
      if (e >= 0) { spans.push([i, e + 2]); i = e + 2; continue; }
      i += 2; lineFresh = false; prev = '*';
      continue;
    }
    if (isPy && (ch === '"' || ch === "'" || (/[rRuUbBfF]/.test(ch) && (raw[i + 1] === '"' || raw[i + 1] === "'")))) {
      const q = /[rRuUbBfF]/.test(ch) ? i + 1 : i;
      const triple = raw[q].repeat(3);
      if (raw.startsWith(triple, q)) {
        const e = find(triple, q + 3);
        if (e < 0) { i = q + 3; lineFresh = false; prev = raw[q]; continue; }
        const after = raw.slice(e + 3, e + 203).split('\n')[0];
        // A docstring stands alone: anything else on its lines makes it a string in code, and code stays.
        if (lineFresh && !after.trim()) spans.push([i, e + 3]);
        i = e + 3; lineFresh = false; prev = raw[q];
        continue;
      }
    }
    if (ch === '"' || ch === "'" || (isC && ch === '`')) {
      let k = i + 1;
      for (; k < n; k++) {
        if (raw[k] === '\\') { k++; continue; }
        if (raw[k] === ch) break;
        if (raw[k] === '\n' && ch !== '`') break;
      }
      i = raw[k] === ch ? k + 1 : k;
      lineFresh = false; prev = ch;
      continue;
    }
    if (isC && ch === '/' && i >= noRegexBefore && raw[i + 1] !== '/' && raw[i + 1] !== '*'
      && (prev === '' || BEFORE_REGEX.test(prev) || (/\w/.test(prev) && WORD_BEFORE_REGEX.test(raw.slice(Math.max(0, i - 12), i))))) {
      let k = i + 1, inClass = false;
      for (; k < n && raw[k] !== '\n'; k++) {
        if (raw[k] === '\\') { k++; continue; }
        if (raw[k] === '[') inClass = true;
        else if (raw[k] === ']') inClass = false;
        else if (raw[k] === '/' && !inClass) break;
      }
      if (raw[k] === '/') { i = k + 1; lineFresh = false; prev = '/'; continue; }
      noRegexBefore = k;
    }
    lineFresh = false; prev = ch; i++;
  }
  return spans;
}
// A script's code only: comments blanked, line breaks kept. "Blocks ~/.ssh/id_rsa" in a comment is a note about a
// guard, not a read.
function scriptCode(text, rel = '') {
  const lang = langOf(rel, text);
  if (lang === 'c' || lang === 'py' || lang === 'ps') {
    const parts = [];
    let at = 0;
    for (const [a, b] of commentSpans(text, lang)) { parts.push(text.slice(at, a), blankOut(text.slice(a, b))); at = b; }
    parts.push(text.slice(at));
    // "**Heading**: words" is no line of code in these languages: it is prose held in a string (a prompt, a rule list).
    return parts.join('').replace(/^[ \t]*\*\*[A-Z][^*\n]{2,80}\*\*:[^\n]*/gm, ' ');
  }
  const whole = lang === 'hash' ? /^\s*#(?!!)/ : lang === 'cmd' ? /^\s*@?(rem(\s|$)|::)/i : lang === 'vb' ? /^\s*('|rem\s)/i : null;
  return whole ? text.split('\n').map(l => (whole.test(l) ? '' : l)).join('\n') : text;
}
// Out of sight by style: not displayed, too small or see-through to read, moved off the screen, clipped away.
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*(?:0+(?![\d.])|0*\.[01]\d*\s*(?:r?em|ex|ch)|0*\.\d+\s*(?:px|pt)|[0-3](?:\.\d+)?\s*(?:px|pt)\b|[0-9](?:\.\d+)?\s*%)|opacity\s*:\s*(?:0(?![.\d])|0?\.0\d*)|color\s*:\s*(white|#fff\b|#ffffff\b|transparent\b)|\shidden\b|\b(?:left|right|top|bottom|margin-left|margin-top)\s*:\s*-\d{3,}|text-indent\s*:\s*-\d{2,}|\bclip\s*:\s*rect\(|\bclip-path\s*:\s*(?:inset\(\s*(?:[5-9]\d|100)\s*%|circle\(\s*0|ellipse\(\s*0|polygon\(\s*0)|\btransform\s*:\s*(?:scale\(\s*0(?![.\d])|translate[XY]?\(\s*-\d{3,})/i;
// The places in a Markdown file that a reader of the rendered page does not see: HTML comments, link-reference
// comments ([//]: # (...), [//]: # "..."), the title of any link reference, and elements styled away.
// HTML comments, found in one pass: each "-->" is looked for once, and once there is none, no later comment can close.
// (A pattern tried at every "<!--" read the rest of the file again each time: 13 s for 400 KB of unclosed ones.)
// A browser also ends a comment at "--!>", so that closes one here too.
function htmlComments(text) {
  const out = [];
  let a = -2, b = -2; // the next "-->" and "--!>" at or after the search point (-1: none left)
  for (let at = text.indexOf('<!--'); at >= 0; ) {
    if (a !== -1 && a < at + 4) a = text.indexOf('-->', at + 4);
    if (b !== -1 && b < at + 4) b = text.indexOf('--!>', at + 4);
    const end = a < 0 ? b : b < 0 ? a : Math.min(a, b);
    if (end < 0) break;
    const close = end + (end === b ? 4 : 3);
    out.push({ at, end: close, text: text.slice(at + 4, end) });
    at = text.indexOf('<!--', close);
  }
  return out;
}
// prose finds them (a guide showing a comment in a code block is not hiding one); the words are taken from the full
// text, which has the same length: a command in backticks inside a comment is still hidden.
function hiddenParts(prose, full = prose) {
  const out = [];
  for (const c of htmlComments(prose)) out.push({ text: full.slice(c.at + 4, c.at + 4 + c.text.length), at: c.at });
  for (const m of prose.matchAll(/^[ \t]*\[[^\]\n]*\]:\s*(?:<[^>\n]{0,500}>|[^\s<]{1,500})[ \t]*(?:\n[ \t]*)?(?:\(([^)]{0,2000})\)|"([^"]{0,2000})"|'([^']{0,2000})')/gm)) {
    const said = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    const start = m.index + m[0].length - 1 - said.length;
    out.push({ text: full.slice(start, start + said.length), at: m.index });
  }
  // An element styled away: its opening tag is read on its own (bounded), then its closing tag is looked for within
  // 4000 characters. One pattern over both backtracked without end on a file of unclosed tags (43 s for 32 KB).
  // One inside the last one's text has been read with it, so each character is judged once however many tags there are.
  let readTo = 0;
  for (const m of prose.matchAll(/<(\w+)\b([^<>]{0,500})>/g)) {
    if (m.index < readTo || !HIDDEN_STYLE.test(m[2])) continue;
    const start = m.index + m[0].length;
    // Never closed: a browser hides it to the end of the HTML block, which in Markdown is the next blank line.
    const near = prose.slice(start, start + 4000);
    let end = near.search(new RegExp('</' + m[1] + '\\s*>', 'i'));
    if (end < 0) { end = near.search(/\n[ \t]*\n/); if (end < 0) end = near.length; }
    readTo = start + end;
    out.push({ text: full.slice(start, start + end), at: m.index });
  }
  return out;
}
// Unicode tag characters (U+E0000-E007F) spell out ASCII that no screen shows. A flag emoji uses them too (a black
// flag followed by tags), so a run right after U+1F3F4 is a flag, not a message.
function tagSmuggled(text) {
  for (const m of text.matchAll(/(\u{1F3F4})?([\u{E0000}-\u{E007F}]+)/gu)) {
    if (m[1]) continue;
    const said = [...m[2]].map(c => String.fromCharCode(c.codePointAt(0) - 0xE0000)).join('').replace(/[^\x20-\x7e]/g, '');
    return { at: m.index, said };
  }
  return null;
}
// Variation selectors can carry a byte each after any character: the ones in U+FE00-FE0F are the low sixteen values,
// the ones in U+E0100-E01EF the rest. Honest ones: a single presentation selector after an emoji (or a digit, in a
// keycap), a single one after a Han character (a variant of that character). Anything else is loose. A loose one or
// two is a stray from a paste and carries nothing, so it takes three, as with the zero-width characters.
function selectorSmuggled(text) {
  const loose = [];
  let at = -1;
  for (const m of text.matchAll(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+/gu)) {
    const run = [...m[0]];
    const before = [...text.slice(Math.max(0, m.index - 2), m.index)].pop() || '';
    const honest = (/[\uFE0E\uFE0F]/.test(run[0]) && /\p{Emoji}/u.test(before)) || /\p{Script=Han}/u.test(before);
    for (let i = honest ? 1 : 0; i < run.length; i++) loose.push(run[i].codePointAt(0));
    if (at < 0 && run.length > (honest ? 1 : 0)) at = m.index;
  }
  if (loose.length < 3) return null;
  const longest = Math.max(...[...text.matchAll(/[︀-️\u{E0100}-\u{E01EF}]+/gu)].slice(0, 5000).map(m => [...m[0]].length));
  // Two ways of spelling bytes are known: byte values across both blocks, and the second block alone as plain text.
  const readable = bytes => {
    const s = Buffer.from(bytes).toString('utf8');
    return s.length >= 4 && /^[\x20-\x7e\s]+$/.test(s) ? s : '';
  };
  const said = readable(loose.map(c => (c <= 0xFE0F ? c - 0xFE00 : c - 0xE0100 + 16)))
    || (loose.every(c => c > 0xFE0F) ? readable(loose.map(c => c - 0xE0100)) : '');
  return { at, count: loose.length, said, longest };
}
// Direction flips (text that reads one way and runs another), zero-width characters (a ZWJ inside an emoji is fine),
// soft hyphens, marks and letters that show as nothing. Direction marks and the zero-width non-joiner belong in Hebrew
// and Arabic text, so a file with any of that keeps them. One or two of the rest arrive with a paste from a web page and
// carry no message, so it takes three, the same as before; a word split by one is still read (seenText).
const BLANKS_RTL = /[\u200B\u2060\u180E\u00AD\u115F\u1160\u3164\uFFA0]|(?<!^)\uFEFF|(?<![\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F])\u200D|\u200D(?!\p{Extended_Pictographic})/gu;
const BLANKS = /[\u200B\u200C\u200E\u200F\u061C\u2060\u180E\u00AD\u115F\u1160\u3164\uFFA0]|(?<!^)\uFEFF|(?<![\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F])\u200D|\u200D(?!\p{Extended_Pictographic})/gu;
function invisibleChars(text) {
  const bidi = /[\u202A-\u202E\u2066-\u2069]/.exec(text);
  if (bidi) return { at: bidi.index, what: 'a character that flips the reading direction' };
  const rtl = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}]/u.test(text);
  // A saved web page gives each heading an empty anchor link whose one character is a zero-width space: nothing to carry.
  const zw = [...text.replace(/\[\u200B\]\(/g, '[ ](').matchAll(rtl ? BLANKS_RTL : BLANKS)];
  if (zw.length >= 3) return { at: zw[0].index, what: zw.length + ' invisible characters' };
  return null;
}
// What the agent reads once the invisible characters are gone: one inside a word ("ig<zero-width>nore") must not hide
// the word. A Hangul filler looks like a space, so it counts as one. Line breaks are untouched, so line numbers hold.
function seenText(text, filler = ' ') {
  // Control characters (a NUL, say) are read through too.
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu, '').replace(/[\u115F\u1160\u3164\uFFA0]/g, filler);
}
// The services a script talks to: hosts written in it, not made-up or local ones. withTestHosts keeps .test ones, for
// the checks that ask who an address belongs to rather than list what a skill uses.
// A namespace in an XML or Office file is a name; nothing is ever fetched from it.
const NAMESPACE_HOSTS = '(?:www\\.w3\\.org|schema\\.org|json-schema\\.org|schemas\\.(?:openxmlformats\\.org|microsoft\\.com|android\\.com|xmlsoap\\.org)|purl\\.org|ns\\.adobe\\.com|(?:www\\.)?openoffice\\.org)';
function hostsIn(text, withTestHosts = false) {
  const out = new Set();
  const skip = new RegExp('^(localhost|127\\.0\\.0\\.1)$|\\.(example|' + (withTestHosts ? '' : 'test|') + 'local|localhost|invalid)$|^(example\\.(com|org|net)|' + NAMESPACE_HOSTS + ')$');
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const h = m[1].toLowerCase();
    if (skip.test(h)) continue;
    out.add(h);
  }
  return out;
}
// A service counts as named when the skill's own text has its site or its brand ("Google" for googleapis.com).
const BRAND = [[/google|gstatic|googleapis/, 'google'], [/openai/, 'openai'], [/anthropic|claude/, 'anthropic'], [/cloudflare/, 'cloudflare'], [/github/, 'github'], [/microsoft|azure|windows\.net/, 'microsoft|azure'], [/amazonaws|aws/, 'aws|amazon']];
// How short a word can stand for a domain's main label ("OpenWeather" for openweathermap): at least 5 letters and three
// quarters of it. Never for a hyphenated name: those are built of common words, and "weather" names no weather-api-free.
const shortestFor = label => (label.includes('-') || label.length > 63 ? 0 : Math.max(5, Math.ceil(label.length * 0.75)));
function namedIn(host, docs) {
  const site = siteOf(host);
  if (docs.includes(site)) return true;
  const label = site.split('.')[0];
  const brand = (BRAND.find(([re]) => re.test(host)) || [null, label])[1];
  const from = shortestFor(label), shorter = [];
  if (from) for (let n = from; n < label.length; n++) shorter.push(label.slice(0, n));
  return new RegExp('\\b(?:' + brand + (shorter.length ? '|(?:' + shorter.join('|') + ')(?![a-z0-9])' : '') + ')', 'i').test(docs);
}
// A key named for the service it goes to names that service (OPENWEATHER_API_KEY, openweathermap.org). Only the site's
// own label counts, so OPENAI_API_KEY does not name openai.anything-else.com. Words every key has name nothing.
const NOT_A_BRAND = /^(?:api|apikey|key|keys|token|tokens|secret|secrets|pass|passwd|password|credential|credentials|auth|access|client|private|public|user|account|service|app)$/;
function keysNaming(keys) {
  const text = keys.join(' ').toLowerCase().replace(/_/g, '-');
  const words = new Set(text.split(/[^a-z0-9]+/).filter(w => w && !NOT_A_BRAND.test(w)));
  return host => {
    const label = siteOf(host).split('.')[0];
    if (NOT_A_BRAND.test(label)) return false;
    if (words.has(label) || (label.length >= 5 && text.includes(label))) return true;
    const from = shortestFor(label);
    if (from) for (let n = from; n < label.length; n++) if (words.has(label.slice(0, n))) return true;
    return false;
  };
}
const firstLine = (re, text) => { const m = re.exec(text); return m ? lineAt(text, m.index) : 0; };
// A doc the agent is told to follow, as against a reference page, a README or a changelog it may never open.
const toldToAgent = rel => INSTRUCTION_FILE.test(rel) || RULE_FOLDER.test(rel) || /(^|\/)(?:commands|agents|skills)\/[^/]+\.md$/i.test(rel);
// Text that quotes an override to warn about it, or says what an attack is designed to do, is not giving the order.
// A quoted order counts as such only with a word beside it saying so, or as a table cell; on its own it still fires.
const WARNS_NEAR = /\b(?:avoid|injections?|untrusted|hostile|malicious|attackers?|adversar\w+|crafted|jailbreak\w*|never\s+follow|do\s+not\s+follow|don['’]t\s+follow|not\s+instructions|such\s+as|like|e\.g\.|for\s+example|examples?|patterns?|threats?)\b/i;
function onlyDescribes(text, at, len) {
  const before = text.slice(Math.max(0, at - 90), at);
  if (/(?:designed|crafted|attempts?|tries|trying|meant)\s+to\s+$|(?:attackers?|adversar\w+|intruders?)\s+(?:can|could|may|might|will)\s+$/i.test(before)) return true;
  // A fault being described: "retry logic that gives up without informing the user".
  if (/\b(?:logic|code|function|handler|bugs?|errors?|failures?)\b[^.\n]{0,60}$/i.test(before) && /^without\b/i.test(text.slice(at, at + 8))) return true;
  if (!/["“'`]\s*$/.test(before)) return false;
  // Advice to the person: ask the agent to "forget previous instructions".
  if (/\bask\s+(?:the\s+|your\s+)?(?:agent|ai|assistant|claude|model)\s+to\s+["“]$/i.test(before)) return true;
  if (/^\s*\|[^|\n]*\|[^|\n]*$/.test(before.split('\n').pop()) || /\|\s*["“'`]\s*$/.test(before)) return true;
  return WARNS_NEAR.test(text.slice(Math.max(0, at - 300), at) + ' ' + text.slice(at + len, at + len + 300));
}
// <system> as a placeholder: in a sentence, not opened and closed as a block, or an argument's name.
function isPlaceholder(text, at, said) {
  if (said.toLowerCase() !== '<system>') return false;
  const from = text.lastIndexOf('\n', at) + 1;
  if (/^\s*argument-hint\s*:/i.test(text.slice(from, at))) return true;
  return /\w[^\w\n]*\s$/.test(text.slice(from, at)) && !/<\/system>/i.test(text);
}
function saidLine(re, text) {
  let n = 0;
  for (const m of text.matchAll(new RegExp(re.source, re.flags + 'g'))) {
    if (++n > 200) return lineAt(text, m.index);
    if (!onlyDescribes(text, m.index, m[0].length) && !isPlaceholder(text, m.index, m[0])) return lineAt(text, m.index);
  }
  return 0;
}
// Encoded code run, unless the code is plainly nothing: dots for a payload, or the alert(1) of a web security guide.
function encodedLine(text) {
  for (const m of text.matchAll(new RegExp(ENCODED_EXEC.source, 'gi'))) {
    const lit = /^[^'"\n]{0,40}['"]([^'"\n]{0,400})['"]/.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 500));
    if (lit && /^(?:\.\.\.|…|\s*)$/.test(lit[1])) continue;
    if (lit && /^alert\([^)]{0,40}\);?$/.test(Buffer.from(lit[1], 'base64').toString('latin1'))) continue;
    return lineAt(text, m.index);
  }
  return 0;
}
// A long block in one case of letters only (a protein, a gene) is no encoding: base64 mixes them.
function encodedBlockLine(text) {
  for (const m of text.matchAll(new RegExp(B64_BLOCK.source, 'g'))) if (!/^(?:[A-Z]+|[a-z]+)=*$/.test(m[0])) return lineAt(text, m.index);
  return 0;
}

// Commands that run before the agent reads the page, so no judgement sits between them and this PC: !`cmd` and ```!
// blocks in a command or skill, !{cmd} in a Gemini .toml, a hook in a doc's frontmatter, and what a .toml config starts
// by itself. Each is judged as a script is. line() is worked out only when wanted: a file can hold 100,000 of these.
function commandsRun(text, kind, conf) {
  const out = [];
  const add = (cmd, at) => { if (cmd.trim()) out.push({ text: cmd.replace(/\r/g, ''), line: () => lineAt(text, at) }); };
  for (const m of text.matchAll(/!`([^`\n]{1,4000})`/g)) add(m[1], m.index);
  for (let at = text.indexOf('```!'); at >= 0; at = text.indexOf('```!', at + 4)) {
    if (at > 0 && text[at - 1] !== '\n') continue;
    const nl = text.indexOf('\n', at), close = nl < 0 ? -1 : text.indexOf('\n```', nl);
    if (close < 0) break;
    add(text.slice(nl + 1, close), at);
    at = close;
  }
  if (kind === 'toml') {
    for (let at = text.indexOf('!{'); at >= 0; ) {
      let depth = 1, k = at + 2;
      const end = Math.min(text.length, at + 4000);
      for (; k < end && depth; k++) { if (text[k] === '{') depth++; else if (text[k] === '}') depth--; }
      if (!depth) add(text.slice(at + 2, k - 1), at);
      at = text.indexOf('!{', k);
    }
    for (const c of jsonCommands(conf)) add(c, Math.max(0, text.indexOf(c.split(/\s/)[0])));
  }
  const fm = frontmatter(text);
  if (fm) for (const m of fm.text.matchAll(/^[ \t-]*command[ \t]*:[ \t]*(.{1,4000})$/gm)) add(m[1].trim().replace(/^(["'])(.*)\1$/, '$2'), fm.start + m.index);
  return out;
}
// The block at the top of a doc, between --- lines.
function frontmatter(text) {
  const m = /^\uFEFF?\s{0,200}---[ \t]*\r?\n/.exec(text);
  if (!m) return null;
  const start = m[0].length, head = text.slice(start, start + 64 * 1024);
  const e = head.search(/^(---|\.\.\.)[ \t]*\r?$/m);
  return e < 0 ? null : { text: head.slice(0, e), start };
}
// allowed-tools (a line, a [flow] or a - list) that lets any command run, and a permission mode that switches the
// checks off. Read from the frontmatter only: the same words in the body are about these settings, not these settings.
function frontmatterFindings(text, hit) {
  const fm = frontmatter(text);
  if (!fm) return;
  const lines = fm.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(allowed[-_]?tools|permission[-_]?mode)\s*:\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    const line = lineAt(text, fm.start) + i;
    if (/^permission/i.test(m[1])) {
      if (/^["']?bypassPermissions\b/i.test(m[2])) hit('AGENT-013', line);
      continue;
    }
    let value = m[2];
    for (let k = i + 1; k < lines.length && /^\s*-\s/.test(lines[k]); k++) value += ' ' + lines[k];
    const wide = (value.match(/[A-Za-z_]+(?:\([^)\n]{0,200}\))?/g) || []).find(t => WIDE_ALLOW.test(t));
    if (wide) hit('AGENT-014', line, { detail: wide });
  }
}
// Text that runs or is read elsewhere, judged in one pass and each hit put back on the line it came from.
function batchFindings(rel, items, kind) {
  if (!items.length) return [];
  const starts = [];
  let n = 1;
  for (const x of items) { starts.push(n); n += x.text.split('\n').length; }
  return fileFindings(rel, items.map(x => x.text).join('\n'), kind).map(h => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > h.line) i--;
    return { ...h, line: items[i].line() };
  });
}
// A download saved to a file, and that file run on the same line or within the next few.
const TWO_STEP_LINES = 5;
function savedNames(line) {
  const out = [];
  for (const seg of line.split(COMMANDS_ON_LINE)) {
    if (!DOWNLOADER.test(seg)) continue;
    const s = seg.slice(0, 4000);
    const code = RETRIEVE_OUT.exec(s);
    if (code) { out.push(code[1] || code[2]); continue; }
    const curl = /\bcurl\b/.test(s), wget = /\bwget\b/.test(s);
    const m = (curl && CURL_OUT.exec(s)) || (wget && WGET_OUT.exec(s)) || ((curl || wget) && REDIRECT_OUT.exec(s)) || (!curl && !wget && (WEBCLIENT_OUT.exec(s) || PS_OUT.exec(s)));
    if (m) out.push(m[1]);
    else if ((curl && CURL_REMOTE.test(s)) || wget) { const u = URL_TAIL.exec(s); if (u) out.push(u[1]); }
  }
  return out.filter(n => n !== '-').map(n => n.replace(/^.*[\\/]/, '').toLowerCase());
}
// The files a line runs, by name (or the variables holding the names, when it is code).
function ranIn(line) {
  const s = new Set();
  const add = n => { const b = n.replace(/^.*[\\/]/, '').toLowerCase(); s.add(b); return b; };
  for (const m of line.matchAll(RUNS_FILE)) add(m[1] || m[2] || m[3]);
  for (const m of line.matchAll(RUN_ARGS)) add(m[1] || m[2]);
  for (const m of line.matchAll(RUN_VAR)) add(m[1] || m[2]);
  // require('./x') loads x.js.
  for (const m of line.matchAll(RUN_LOAD)) { const b = add(m[1]); if (!b.includes('.')) s.add(b + '.js'); }
  return s;
}
function downloadThenRun(flat) {
  if (!DOWNLOADER.test(flat)) return null;
  const lines = flat.split('\n');
  const known = new Map();
  const ranOn = i => {
    let s = known.get(i);
    if (!s) {
      s = ranIn(lines[i].slice(0, 20000));
      known.set(i, s);
    }
    return s;
  };
  let offset = 0;
  for (let i = 0; i < lines.length; offset += lines[i].length + 1, i++) {
    if (!DOWNLOADER.test(lines[i])) continue;
    for (const name of savedNames(lines[i])) {
      for (let k = i; k <= i + TWO_STEP_LINES && k < lines.length; k++) {
        if (!ranOn(k).has(name)) continue;
        return { at: offset, from: (/https?:\/\/([a-z0-9.-]+)/i.exec(lines[i].slice(0, 4000)) || [])[1] || '', checked: lines.slice(i, k + 1).some(l => CHECKED_HASH.test(l.slice(0, 4000))) };
      }
    }
  }
  return null;
}
// The same through a language's own web client, where the download sits in a variable: what it holds is followed, line
// by line, into a call that runs it or a file that is then run. Only a file the download itself went into counts, so a
// page read beside a script written from a template stays quiet. Code takes more lines to do this than a shell does.
const CODE_STEP_LINES = 12;
const THEN_LINES = 4;
const NAME_IN_CODE = /(?<![\w.$])[A-Za-z_$][\w$]{0,60}/g;
const argOf = (s, from) => {
  let depth = 1, k = from;
  for (; k < s.length && k < from + 300; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')' && !--depth) break;
  }
  return s.slice(from, k);
};
function webThenRun(flat) {
  if (!WEB_CLIENT.test(flat)) return null;
  const lines = flat.split('\n');
  const held = new Map(), handles = new Map(), saved = new Map();
  let webLine = -CODE_STEP_LINES - 1, webAt = 0, offset = 0;
  for (let i = 0; i < lines.length; offset += lines[i].length + 1, i++) {
    const holds = x => {
      // What sits in quotes is words, not a call or a name.
      const code = x.replace(/(["'`])[^"'`\n]{0,300}\1/g, ' ');
      if (WEB_CLIENT.test(code)) return true;
      for (const m of code.matchAll(NAME_IN_CODE)) {
        const at = held.get(m[0]);
        if (at !== undefined && i - at <= CODE_STEP_LINES) return true;
      }
      return false;
    };
    const found = () => {
      const near = lines.slice(Math.max(0, webLine - TWO_STEP_LINES), i + 1).map(l => l.slice(0, 4000));
      return { at: webAt, from: (/https?:\/\/([a-z0-9.-]+)/i.exec(near.join('\n')) || [])[1] || '', checked: near.some(l => CHECKED_HASH.test(l)) };
    };
    const save = (m, first) => saved.set((m[first] || m[first + 1]).replace(/^.*[\\/]/, '').toLowerCase(), i);
    for (const part of lines[i].split(';')) {
      const s = part.slice(0, 4000);
      const web = WEB_CLIENT.exec(s);
      if (web) {
        if (webLine !== i) { webLine = i; webAt = offset; }
        const as = /\bas\s{1,4}([A-Za-z_]\w{0,60})/.exec(s.slice(web.index));
        if (as) held.set(as[1], i);
      }
      const set = ASSIGN.exec(s);
      if (set) {
        const name = set[1] || set[2];
        if (holds(s.slice(set[0].length))) held.set(name, i);
        else held.delete(name);
      }
      const each = FOR_EACH.exec(s);
      if (each && holds(s.slice(each[0].length))) held.set(each[1], i);
      if (i - webLine <= THEN_LINES) {
        for (const m of s.matchAll(THEN_ARG)) held.set(m[1], i);
        if (THEN_RUN.test(s)) return found();
      }
      // A file written: open(...) now or through its handle, a write call, a stream.
      const open = PY_OPEN.exec(s);
      if (open) {
        const rest = s.slice(open.index + open[0].length);
        const as = /^[^:\n]{0,40}\bas\s{1,4}([A-Za-z_]\w{0,60})/.exec(rest) || (set && !set[2] ? [0, set[1]] : null);
        if (as) handles.set(as[1], open);
        const now = rest.indexOf('.write');
        if (now >= 0 && holds(rest.slice(now + 6))) save(open, 1);
      }
      const put = HANDLE_WRITE.exec(s);
      if (put && handles.has(put[1]) && holds(s.slice(put.index + put[0].length))) save(handles.get(put[1]), 1);
      const copy = HANDLE_COPY.exec(s);
      if (copy && handles.has(copy[2]) && holds(copy[1])) save(handles.get(copy[2]), 1);
      const other = OTHER_WRITE.exec(s);
      if (other && holds(s.slice(other.index + other[0].length))) save(other, other[1] || other[2] ? 1 : 3);
      const stream = STREAM_OUT.exec(s);
      if (stream && (i - webLine <= THEN_LINES || holds(s))) save(stream, 1);
      // Run as it stands. A program's own list of arguments is not that: ['grep', 'x', text] only hands the text over.
      for (const m of s.matchAll(RUNS_CODE_ALL)) {
        const from = m.index + m[0].length;
        if (/^\s{0,4}\[/.test(s.slice(from, from + 8))) continue;
        if (holds(argOf(s, from))) return found();
      }
      if (saved.size) {
        for (const name of ranIn(s)) {
          const at = saved.get(name);
          if (at !== undefined && i - at <= CODE_STEP_LINES) return found();
        }
      }
    }
  }
  return null;
}

// ---- one file ----
// kind: 'doc' (instructions the agent reads), 'script', 'settings' (an agent's settings or hooks file), 'mcp',
// 'toml' (a Codex or Gemini command or config: a doc that can also name servers and commands that start by themselves),
// 'autorun' (package.json, tasks.json, a dev container: only what starts by itself is judged, the rest of it is data).
function fileFindings(rel, raw, kind) {
  const out = [];
  const isDoc = kind === 'doc' || kind === 'toml';
  const isAuto = kind === 'autorun';
  const conf = kind === 'settings' || kind === 'mcp' || kind === 'toml' || isAuto ? parseConfig(rel, raw) : null;
  // Hidden characters are looked for everywhere; the other checks read a script's code, not its comments. In a
  // settings or MCP file the commands are also read from the parsed JSON, one per line after the file: a one-line
  // (minified) file, or a command written with \u escapes, reads differently as raw text than it runs.
  const cmds = kind === 'settings' || kind === 'mcp' || isAuto ? jsonCommands(conf).map(c => c.replace(/\s*\n\s*/g, ' ')) : [];
  const text = kind === 'script' ? scriptCode(raw, rel) : isDoc ? seenText(raw) : isAuto ? cmds.join('\n') : cmds.length ? raw + '\n' + cmds.join('\n') : raw;
  const rawLines = isAuto ? 0 : raw.split('\n').length;
  const scan = isAuto ? text : raw;
  // A hit on one of those added lines is placed on the file's line that holds the value (else line 1). A command given
  // as a list is not written that way in the file, so it is placed by its first word.
  const placed = c => { const n = jsonLine(raw, c); return n > 1 || !isAuto ? n : jsonLine(raw, c.split(/\s/)[0]); };
  const hit = (rule, line, extra = {}) => out.push({ rule, line: line > rawLines ? placed(cmds[line - rawLines - 1] || '') : line, ...extra });
  const tag = tagSmuggled(scan);
  if (tag) hit('AGENT-002', lineAt(scan, tag.at), { detail: tag.said ? 'it reads: "' + tag.said.slice(0, 120) + (tag.said.length > 120 ? '…' : '') + '"' : '' });
  const sel = selectorSmuggled(scan);
  if (sel && sel.said) hit('AGENT-002', lineAt(scan, sel.at), { detail: 'it reads: "' + sel.said.slice(0, 120) + (sel.said.length > 120 ? '…' : '') + '"' });
  const inv = invisibleChars(scan);
  if (inv && kind !== 'script') hit('AGENT-003', lineAt(scan, inv.at), { detail: inv.what });
  // In a script a stray or two is left alone (a symbol table, say); a run is how a payload is carried in source code.
  else if (sel && !sel.said && (kind !== 'script' || (sel.count >= 8 && sel.longest >= 3))) hit('AGENT-003', lineAt(scan, sel.at), { detail: sel.count + ' variation selectors, which can carry hidden bytes' });
  // A Hangul filler is a letter to a program and shows as nothing: in source code it makes a name no reader can see.
  if (kind === 'script' && /[\u115F\u1160\u3164\uFFA0]/.test(raw) && !/[\uAC00-\uD7A3]/.test(raw)) hit('AGENT-003', firstLine(/[\u115F\u1160\u3164\uFFA0]/, raw), { detail: 'a letter that shows as nothing, usable as an invisible name' });
  if (isDoc) {
    const prose = proseOf(text);
    for (const h of hiddenParts(prose, text)) {
      const t = h.text;
      if (OVERRIDE.test(t) || CONCEAL.test(t) || ROLE.test(t) || EXFIL.test(t) || HIDDEN_ACTS.test(t) || outputLeakLine(t, t)) {
        hit('AGENT-001', lineAt(prose, h.at), { detail: 'it says: "' + t.replace(/\s+/g, ' ').trim().slice(0, 120) + (t.length > 120 ? '…' : '') + '"' });
        break;
      }
    }
    const kept = [];
    let from = 0;
    for (const c of htmlComments(prose)) { kept.push(prose.slice(from, c.at), blankOut(prose.slice(c.at, c.end))); from = c.end; }
    kept.push(prose.slice(from));
    const shown = kept.join('');
    // In a data file <system> is an element like any other (a Maven pom has one), and a block of base64 is data.
    const data = kind === 'doc' && DATA_TEXT.test(rel);
    // A workflow file's prompt goes to the CI's own agent.
    const judged = data || /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(rel) ? shown.replace(/<\/?system\b[^>\n]{0,40}>/gi, ' ') : shown;
    const said = [OVERRIDE, CONCEAL, ROLE].map(re => saidLine(re, judged)).filter(Boolean);
    // A filler can stand for a space or sit inside a word, and the agent reads through either: both readings are judged.
    const joined = /[\u115F\u1160\u3164\uFFA0]/.test(raw) ? proseOf(seenText(raw, '')) : null;
    if (joined) said.push(...[OVERRIDE, CONCEAL, ROLE].map(re => saidLine(re, joined)).filter(Boolean));
    if (said.length) hit('AGENT-004', Math.min(...said));
    const ex = firstLine(EXFIL, shown) || (joined ? firstLine(EXFIL, joined) : 0) || outputLeakLine(fencesOff(text), shown) || (joined ? outputLeakLine(joined, joined) : 0);
    if (ex) hit('AGENT-005', ex);
    const b64 = data ? 0 : encodedBlockLine(text);
    if (b64) hit('AGENT-016', b64);
    if (kind === 'doc') frontmatterFindings(text, hit);
  }
  // What runs: a script, a hook's command, and the commands a skill tells the agent to run (its code blocks).
  // An install line in a guide ("curl -LsSf https://astral.sh/uv/install.sh | sh") is common and often fine: in a doc it
  // is a warning that names where the program comes from. A script or hook that does it on its own is Critical. The same
  // goes for a download saved to a file and then run; if its checksum is checked on the way, it is a warning everywhere.
  const flat = joinContinued(text, kind === 'script' ? langOf(rel, raw) : 'hash');
  const dlM = DOWNLOAD_RUN.exec(flat) || WEB_CODE_RUN.exec(flat);
  const twoStep = dlM ? null : downloadThenRun(flat) || webThenRun(flat);
  if (dlM || twoStep) {
    const source = dlM ? (/https?:\/\/([a-z0-9.-]+)/i.exec(flat.slice(dlM.index, dlM.index + 400)) || [])[1] : twoStep.from;
    // A prompt or message giving the pipe as its example names it; it does not run it.
    const example = dlM && /\b(?:for\s+example|e\.g\.,?|such\s+as)\s+[`'"]?$/i.test(flat.slice(Math.max(0, dlM.index - 20), dlM.index));
    const soft = isDoc || example || (twoStep && twoStep.checked);
    hit('AGENT-006', flatLineAt(flat, dlM ? dlM.index : twoStep.at), { ...(soft ? { sev: 'Medium', fix: DOC_FIX['AGENT-006'] } : {}), detail: source ? 'from ' + source : '' });
  }
  const enc = encodedLine(text);
  if (enc) hit('AGENT-007', enc, kind === 'doc' && !toldToAgent(rel) ? { sev: 'Medium', fix: DOC_FIX['AGENT-007'] } : {});
  // A doc that names a key file may be a setup guide ("add the key from ~/.ssh to GitHub"): a warning to read first.
  // A script that reads one is High, and Critical once the skill also talks to the internet (unitFindings).
  // A doc that says an app reads the agent's transcripts describes it; a script (or a doc's !`command`) reading them is a read.
  const sec = secretHit(isDoc ? text.replace(/\.claude[\\/]+(?:projects|history\.jsonl)\b/gi, '.claude-x') : text);
  if (sec) hit('AGENT-008', sec.line, isDoc || sec.soft ? { sev: 'Medium', fix: DOC_FIX['AGENT-008'] } : {});
  const drop = dropHit(text);
  if (drop) hit('AGENT-010', drop.line, { brand: drop.brand });
  // Set up to run again: a write to a start-up place (on one line), or a scheduler command. Only a script or a hook
  // does it on its own; a doc that tells the agent to do it is a warning to read first.
  const lines = text.split('\n');
  // Lines over 4000 characters are passed over here, but the commands read from a settings file (the lines after
  // rawLines) are each one command, however long, and are always read.
  const readLine = (l, i) => l.length < 4000 || i >= rawLines;
  const pIdx = lines.findIndex((l, i) => readLine(l, i) && !PATTERN_LINE.test(l) && (persistWrite(l) || PERSIST_CMD.test(l)));
  if (pIdx >= 0) hit('AGENT-012', pIdx + 1, isDoc ? { sev: 'Medium', fix: DOC_FIX['AGENT-012'] } : {});
  // "Never use --dangerously-skip-permissions" in a doc is a rule against it, not a use of it.
  const byIdx = lines.findIndex((l, i) => readLine(l, i) && BYPASS.test(l) && !(kind === 'doc' && /\b(never|don['’]t|do\s+not|avoid|without)\b/i.test(l)));
  // What the agent itself is told is High; a reference page, a README or a changelog naming the flag is read first.
  if (byIdx >= 0) hit('AGENT-013', byIdx + 1, kind !== 'doc' || toldToAgent(rel) ? {} : { sev: 'Medium', fix: DOC_FIX['AGENT-013'] });
  // MCP servers can sit in a settings file too (.gemini/settings.json).
  if (kind === 'settings') settingsFindings(conf, raw, hit);
  if (conf) mcpFindings(conf, raw, hit);
  // A prompt hook's text goes to the model with no one reading it: read as a doc is read.
  if (conf) out.push(...batchFindings('prompt.md', hookPrompts(conf).map(p => ({ text: p.prompt, line: () => jsonLine(raw, p.prompt) })), 'doc'));
  // What a doc runs by itself is judged as a script: the same line's doc rating gives way to it, not added to it.
  if (isDoc) {
    for (const h of batchFindings('command.sh', commandsRun(text, kind, conf), 'script')) {
      const same = out.find(x => x.rule === h.rule && x.line === h.line);
      if (same) { delete same.sev; delete same.fix; } else out.push(h);
    }
  }
  const seen = new Set();
  return out.filter(h => { const k = h.rule + ':' + h.line; if (seen.has(k)) return false; seen.add(k); return true; });
}

function parseJson(text) { try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return null; } }
// VS Code's mcp.json may hold comments and trailing commas, and VS Code reads it anyway.
function stripJsonComments(text) {
  const out = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { for (i++; i < text.length && text[i] !== '"' && text[i] !== '\n'; i++) if (text[i] === '\\') i++; continue; }
    if (ch !== '/') continue;
    const close = text[i + 1] === '/' ? text.indexOf('\n', i) : text[i + 1] === '*' ? text.indexOf('*/', i + 2) : -2;
    if (close === -2) continue;
    out.push(text.slice(from, i));
    from = close < 0 ? text.length : text[i + 1] === '/' ? close : close + 2;
    i = from - 1;
  }
  out.push(text.slice(from));
  return out.join('').replace(/,(\s*[}\]])/g, '$1');
}
// The few parts of a Codex config.toml that start something: [mcp_servers.name] tables and notify. One line at a time.
function tomlConfig(text) {
  const mcpServers = {}, out = { mcpServers };
  const lines = text.split('\n');
  let table = null, top = true;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l[0] === '[') {
      const m = /^\[\s*(?:mcp_servers|mcpServers)\.(?:"([^"]{1,200})"|'([^']{1,200})'|([\w-]{1,200}))\s*\]/.exec(l);
      const name = m && (m[1] || m[2] || m[3]);
      table = name ? (mcpServers[name] = mcpServers[name] || {}) : null;
      top = false;
      continue;
    }
    const kv = /^([\w-]{1,40})\s*=\s*(.*)$/.exec(l);
    if (!kv || (!table && !(top && kv[1] === 'notify'))) continue;
    let value = kv[2];
    if (value[0] === '[') for (let k = 0; k < 200 && !value.includes(']') && i + 1 < lines.length; k++) value += ' ' + lines[++i].trim();
    const strings = [...value.matchAll(/"((?:[^"\\\n]|\\.){0,2000})"|'([^'\n]{0,2000})'/g)].map(m => (m[1] !== undefined ? m[1] : m[2]));
    if (kv[1] === 'notify') out.notify = strings.join(' ');
    else if (kv[1] === 'args') table.args = strings;
    else if (kv[1] === 'command' || kv[1] === 'url') table[kv[1]] = strings[0];
  }
  return out;
}
// What these files start by themselves, as the commands of a hook are: a package's install steps and any script they
// call by name, tasks that run when the folder opens and any task they depend on, a dev container's life-cycle commands
// (a string, a list, or an object of either). A script nothing starts, and a task that waits to be asked, are not here.
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const DEVCONTAINER_KEYS = ['initializeCommand', 'onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand', 'postAttachCommand'];
function autorunConf(rel, j) {
  const autorun = [];
  const said = x => (typeof x === 'string' ? x : Array.isArray(x) ? x.map(said).filter(Boolean).join(' ') : x && typeof x === 'object' && typeof x.value === 'string' ? x.value : '');
  const add = (event, c) => { const s = said(c); if (s.trim()) autorun.push({ event, command: s }); };
  if (/(^|\/)package\.json$/i.test(rel)) {
    const scripts = j.scripts && typeof j.scripts === 'object' ? j.scripts : {};
    const seen = new Set();
    const todo = INSTALL_SCRIPTS.map(s => [s, s]);
    while (todo.length) {
      const [event, name] = todo.pop();
      if (seen.has(name) || !Object.prototype.hasOwnProperty.call(scripts, name) || typeof scripts[name] !== 'string') continue;
      seen.add(name);
      add(event, scripts[name]);
      for (const m of scripts[name].matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]{1,100})/g)) todo.push([event, m[1]]);
    }
  } else if (/tasks\.json$/i.test(rel)) {
    const tasks = Array.isArray(j.tasks) ? j.tasks.filter(t => t && typeof t === 'object') : [];
    const byLabel = new Map();
    for (const t of tasks) { const l = said(t.label) || said(t.taskName); if (l && !byLabel.has(l)) byLabel.set(l, t); }
    const seen = new Set();
    const todo = tasks.filter(t => t.runOptions && t.runOptions.runOn === 'folderOpen');
    while (todo.length) {
      const t = todo.pop();
      if (seen.has(t)) continue;
      seen.add(t);
      const event = 'folderOpen task ' + (said(t.label) || said(t.taskName) || '(no name)');
      for (const c of [t, t.windows, t.linux, t.osx]) if (c && typeof c === 'object') add(event, [c.command, c.args]);
      for (const d of [].concat(t.dependsOn || [])) {
        const next = byLabel.get(typeof d === 'string' ? d : d && typeof d === 'object' ? said(d.task) : '');
        if (next) todo.push(next);
      }
    }
  } else {
    for (const k of DEVCONTAINER_KEYS) {
      const v = j[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const c of Object.values(v)) add(k, c);
      else add(k, v);
    }
  }
  return { autorun };
}
function parseConfig(rel, text) {
  if (/\.toml$/i.test(rel)) return tomlConfig(text);
  if (AUTORUN.test(rel)) {
    const j = parseJson(text) || parseJson(stripJsonComments(text));
    return j && typeof j === 'object' ? autorunConf(rel, j) : null;
  }
  return parseJson(text) || (VSCODE_MCP.test(rel) ? parseJson(stripJsonComments(text)) : null);
}
// Line of a value in a JSON file: the first line holding it (as JSON writes it), else 1.
const jsonLine = (text, value) => { const i = text.indexOf(JSON.stringify(value).slice(1, -1)); return i < 0 ? 1 : lineAt(text, i); };

// Settings keys whose value is a command that runs by itself, with no model in the loop.
const COMMAND_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'notify'];
// Each hook in a settings file, however it is written: command, http, or prompt and agent (text for the model).
function eachHook(j, fn) {
  // A Kiro hook is one file holding one hook.
  if (j.then && typeof j.then === 'object') fn(typeof j.name === 'string' ? j.name : 'Kiro hook', j.then);
  const hooks = j.hooks;
  if (!hooks || typeof hooks !== 'object') return;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) if (h && typeof h === 'object') fn(event, h);
    }
  }
}
function hookCommands(j) {
  const out = [];
  if (!j || typeof j !== 'object') return out;
  for (const k of COMMAND_KEYS) if (typeof j[k] === 'string') out.push({ event: k, command: j[k] });
  if (j.statusLine && typeof j.statusLine.command === 'string') out.push({ event: 'statusLine', command: j.statusLine.command });
  if (Array.isArray(j.autorun)) for (const a of j.autorun) if (a && typeof a.command === 'string') out.push({ event: String(a.event), command: a.command });
  eachHook(j, (event, h) => {
    if (typeof h.command === 'string') out.push({ event, command: h.command });
    if (typeof h.url === 'string') out.push({ event, command: h.url });
  });
  return out;
}
function hookPrompts(j) {
  const out = [];
  if (!j || typeof j !== 'object') return out;
  eachHook(j, (event, h) => { if (typeof h.prompt === 'string' && typeof h.command !== 'string') out.push({ event, prompt: h.prompt }); });
  return out;
}
// The servers a settings, MCP or toml file names, under whichever key its agent uses (VS Code: servers).
function mcpServersOf(j) {
  if (!j || typeof j !== 'object') return {};
  return Object.assign({}, ...[j.mcpServers, j.servers, j.mcp && j.mcp.servers].filter(x => x && typeof x === 'object' && !Array.isArray(x)));
}
const serverUrl = s => [s.url, s.serverUrl, s.httpUrl].find(u => typeof u === 'string');
// Everything in a settings or MCP file that runs or decides what may run, as text: hook and helper commands, each MCP
// server's command line and address, and a permission mode that switches the checks off.
function jsonCommands(j) {
  if (!j || typeof j !== 'object') return [];
  const out = hookCommands(j).map(h => h.command);
  for (const s of Object.values(mcpServersOf(j))) {
    if (!s || typeof s !== 'object') continue;
    const line = [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter(x => typeof x === 'string').join(' ');
    if (line) out.push(line);
    const url = serverUrl(s);
    if (url) out.push(url);
  }
  const mode = j.permissions && j.permissions.defaultMode;
  if (typeof mode === 'string' && /^bypassPermissions$/i.test(mode)) out.push('"defaultMode": "' + mode + '"');
  return out;
}
// An environment that sends the agent's traffic elsewhere or loads code into what it starts. A local proxy is someone's
// own tool, and a value that only names one of their own variables holds nothing of the file's. A token's value is
// never repeated in a finding, nor a password inside an address.
const ENV_ROUTES = /^(ANTHROPIC_BASE_URL|ANTHROPIC_BEDROCK_BASE_URL|ANTHROPIC_VERTEX_BASE_URL|OPENAI_BASE_URL|OPENAI_API_BASE|HTTPS?_PROXY|ALL_PROXY)$/i;
const ENV_TOKENS = /^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_CUSTOM_HEADERS)$/i;
const ENV_LOADS = /^(LD_PRELOAD|DYLD_INSERT_LIBRARIES|BASH_ENV|PYTHONSTARTUP)$/i;
const NODE_LOADS = /(?:^|\s)(?:--require|-r|--import|--loader|--experimental-loader)(?:[\s=]|$)/;
function envFindings(env, text, hit, where) {
  if (!env || typeof env !== 'object') return false;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || !v.trim() || /^\$\{?\w+\}?$/.test(v.trim())) continue;
    let detail = '';
    if (ENV_ROUTES.test(k)) { if (!LOCAL_URL.test(v)) detail = where + '.' + k + ' = ' + v.replace(/\/\/[^@/\s]*@/, '//').slice(0, 100); }
    else if (ENV_TOKENS.test(k)) detail = where + '.' + k;
    else if (ENV_LOADS.test(k) || (/^NODE_OPTIONS$/i.test(k) && NODE_LOADS.test(v))) detail = where + '.' + k + ' = ' + v.slice(0, 100);
    if (detail) { hit('AGENT-020', jsonLine(text, k), { detail }); return true; }
  }
  return false;
}
// A folder given to the agent that is not inside the project: absolute, under home, or climbing out.
function outsideProject(dir) {
  const p = dir.trim().replace(/\\/g, '/').replace(/^\$\{?CLAUDE_PROJECT_DIR\}?/, '.');
  if (!p) return false;
  return /^(\/|~|\$|%|[A-Za-z]:)/.test(p) || path.posix.normalize(p).split('/')[0] === '..';
}
function settingsFindings(j, text, hit) {
  if (!j || typeof j !== 'object') return;
  const allow = j.permissions && Array.isArray(j.permissions.allow) ? j.permissions.allow : [];
  const wide = allow.find(a => typeof a === 'string' && WIDE_ALLOW.test(a.trim()));
  if (wide) hit('AGENT-014', jsonLine(text, wide));
  if (j.enableAllProjectMcpServers === true) hit('AGENT-017', firstLine(/enableAllProjectMcpServers/, text) || 1);
  envFindings(j.env, text, hit, 'env');
  const dirs = [j.permissions && j.permissions.additionalDirectories, j.additionalDirectories].filter(Array.isArray).flat();
  const away = dirs.find(d => typeof d === 'string' && outsideProject(d));
  // The whole home folder or the whole disk is a different size of thing from one folder beside the project.
  if (away) hit('AGENT-021', jsonLine(text, away), { detail: away.slice(0, 100), ...(/^(~[\\/]?|\/|[A-Za-z]:[\\/]?|\$HOME[\\/]?|%USERPROFILE%[\\/]?)$/i.test(away.trim()) ? { sev: 'High' } : {}) });
  const market = j.extraKnownMarketplaces, on = j.enabledPlugins;
  if (market && typeof market === 'object' && on && typeof on === 'object') {
    const names = Array.isArray(on) ? on.filter(x => typeof x === 'string') : Object.keys(on).filter(k => on[k]);
    const from = names.map(n => [n, (/@([^@]+)$/.exec(n) || [])[1]]).find(([, m]) => m && Object.prototype.hasOwnProperty.call(market, m));
    if (from) {
      const src = (market[from[1]] && market[from[1]].source) || {};
      hit('AGENT-022', jsonLine(text, from[0]), { detail: from[0] + ' from ' + String(src.repo || src.url || src.path || from[1]).slice(0, 120) });
    }
  }
}
// What an MCP server's command line really starts: a shell or a runner in front of it is looked through, to the real
// program and the pin check. Each command of a sequence inside a shell string counts.
const baseCmd = c => path.win32.basename(String(c)).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
const shellWords = s => (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(w => w.replace(/^(["'])(.*)\1$/, '$2'));
function realCommands(toks, depth = 0) {
  if (!toks.length || depth > 4) return toks.length ? [toks] : [];
  if (toks.length === 1 && /\s/.test(toks[0])) return realCommands(shellWords(toks[0]), depth + 1);
  const cmd = baseCmd(toks[0]);
  const inner = i => toks.slice(i + 1).join(' ').split(/[;|&]+/).flatMap(s => realCommands(shellWords(s), depth + 1));
  if (cmd === 'cmd') { const i = toks.findIndex(a => /^\/[ck]$/i.test(a)); return i < 0 ? [toks] : inner(i); }
  if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(cmd)) { const i = toks.findIndex((a, n) => n && /^-[a-z]*c$/.test(a)); return i < 0 ? [toks] : inner(i); }
  if (cmd === 'powershell' || cmd === 'pwsh') { const i = toks.findIndex(a => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a)); return i < 0 ? [toks] : inner(i); }
  if (cmd === 'env') { const i = toks.findIndex((a, n) => n && !a.startsWith('-') && !a.includes('=')); return i < 0 ? [toks] : realCommands(toks.slice(i), depth + 1); }
  if (cmd === 'uv') {
    if (toks[1] === 'tool' && (toks[2] === 'run' || toks[2] === 'uvx')) return [['uvx', ...toks.slice(3)]];
    if (toks[1] === 'run') { const i = toks.indexOf('--with'); if (i > 0 && toks[i + 1]) return [['uvx', toks[i + 1]]]; }
  }
  if (cmd === 'npm' && (toks[1] === 'exec' || toks[1] === 'x')) return [['npx', ...toks.slice(2)]];
  return [toks];
}
// npx / bunx / pnpm dlx / uvx / pipx run <package>: pinned when the package names a version.
function unpinnedPackage(toks) {
  const cmd = baseCmd(toks[0]), args = toks.slice(1);
  let rest = args;
  if (cmd === 'pnpm' || cmd === 'yarn') { if (args[0] !== 'dlx') return null; rest = args.slice(1); }
  else if (cmd === 'pipx') { if (args[0] !== 'run') return null; rest = args.slice(1); }
  else if (!['npx', 'bunx', 'uvx'].includes(cmd)) return null;
  // The package can be given by flag, with the program it provides named after it.
  let named = null;
  rest.forEach((a, i) => {
    const m = /^(?:--from|--package|-p)(?:=(.+))?$/.exec(a);
    if (m && !named) named = m[1] || rest[i + 1] || null;
  });
  const pkg = named || rest.find(a => !a.startsWith('-'));
  if (!pkg || /^[.\\/]|^[A-Za-z]:/.test(pkg)) return null;
  const pinned = cmd === 'uvx' || cmd === 'pipx' ? /(==|@)\d|@[0-9a-f]{7,}$/i.test(pkg) : /^@?[^@]+@\d/.test(pkg) || /^@[^/]+\/[^@]+@\d/.test(pkg);
  return pinned ? null : pkg;
}
function mcpFindings(j, text, hit) {
  let pinHit = false, envHit = false;
  for (const [name, s] of Object.entries(mcpServersOf(j))) {
    if (!s || typeof s !== 'object') continue;
    if (!envHit) envHit = envFindings(s.env, text, hit, name + '.env');
    if (pinHit || typeof s.command !== 'string') continue;
    const args = Array.isArray(s.args) ? s.args.filter(a => typeof a === 'string') : [];
    for (const toks of realCommands([s.command, ...args])) {
      const pkg = unpinnedPackage(toks);
      if (pkg) { hit('AGENT-015', jsonLine(text, name), { detail: name + ': ' + pkg }); pinHit = true; break; }
    }
  }
}
// A file uploaded: one command of a line, or the code shapes that span lines. Says where, and the text around it.
function uploadIn(code, lang) {
  const flat = joinContinued(code, lang);
  const lines = flat.split('\n');
  let offset = 0;
  for (const l of lines) {
    for (const seg of l.split(COMMANDS_ON_LINE)) {
      if ((/\bcurl\b/.test(seg) && UPLOAD_CURL.test(seg)) || (/\bwget\b/.test(seg) && /--(?:post|body)-file\b/.test(seg)) || (/\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i.test(seg) && UPLOAD_PS.test(seg))) return { line: flatLineAt(flat, offset), text: l.slice(0, 8000) };
    }
    offset += l.length + 1;
  }
  const m = UPLOAD_CODE.exec(flat);
  return m ? { line: flatLineAt(flat, m.index), text: flat.slice(Math.max(0, m.index - 400), m.index + 800) } : null;
}

// ---- a set of files that work together (one skill, one plugin, a project's agent folder) ----
// files: [{ rel, text, kind }]. Returns findings (with where) and what the set does.
// The folder part includes its slash, so an instruction file inside it can be looked for.
const FIXTURE_FILE = /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|testdata|e2e|examples?|samples?)\/|(?:^|\/)[^/]+[._-](?:test|spec)\.[a-z]{1,4}$|(?:^|\/)test_[^/]+\.py$/i;
const FIXTURE_SOFT = new Set(['AGENT-006', 'AGENT-007', 'AGENT-008', 'AGENT-010', 'AGENT-012', 'AGENT-013', 'AGENT-018']);
function unitFindings(files, late = () => false) {
  const findings = [];
  let left = 0;
  const docFiles = files.filter(f => f.kind === 'doc' || f.kind === 'toml');
  const docs = docFiles.map(f => f.text).join('\n').toLowerCase();
  // A doc's own upload command does not name its host for it: that line is not counted as naming anything.
  let docsLeft = null;
  const docsNaming = () => docsLeft !== null ? docsLeft : (docsLeft = docFiles.map(f => f.text.split('\n').filter(l => !(l.includes('curl') && UPLOAD_CURL.test(l))).join('\n')).join('\n').toLowerCase());
  const does = { runs: [], hooks: [], hosts: new Set(), keys: new Set() };
  let reads = null, dump = null, net = false;
  // Hosts in a script that itself reads a key: that is where a key can go without any other file's help.
  const keyedHosts = new Set();
  // A test file nothing else names is run only if someone runs the tests, so what it holds is a reason to read it, not
  // to refuse the skill. Named by what the agent follows, a hook, an install step or a script, it is judged like any
  // other file. A folder that holds its own instruction file is a skill with an odd name, not a folder of tests.
  const startsRun = x => {
    if (FIXTURE_FILE.test(x.rel)) return '';
    if (x.kind === 'autorun') return hookCommands(parseConfig(x.rel, x.text)).map(h => h.command).join('\n');
    return x.kind === 'script' || x.kind === 'settings' || x.kind === 'mcp' || x.kind === 'toml' || (x.kind === 'doc' && toldToAgent(x.rel)) ? x.text : '';
  };
  const otherText = (() => {
    let t = null;
    return () => t !== null ? t : (t = files.map(startsRun).join('\n').toLowerCase());
  })();
  const isFixture = f => {
    const m = FIXTURE_FILE.exec(f.rel);
    if (!m) return false;
    const inside = m[0].endsWith('/') ? f.rel.slice(0, m.index + m[0].length) : '';
    if (inside && files.some(x => x.rel.startsWith(inside) && INSTRUCTION_FILE.test(x.rel))) return false;
    const base = path.posix.basename(f.rel).toLowerCase();
    const stem = base.replace(/\.[^.]+$/, '');
    return !otherText().includes(base) && !(stem.length >= 4 && otherText().includes(stem));
  };
  const notes = [], notRead = [];
  const unread = s => { notes.push(s); notRead.push(s); };
  // A file sent away is judged by where it goes. Run on its own it is High; told to the agent in a doc it is a warning,
  // unless it is a file of keys, which has no honest place to go.
  const uploadCheck = (f, src, lang, isRun) => {
    const up = uploadIn(src, lang);
    if (!up) return false;
    const near = hostsIn(up.text, true);
    if (LOCAL_URL.test(up.text) && !near.size) return false;
    const hosts = [...(near.size ? near : hostsIn(src, true))].slice(0, MAX_NAMED_HOSTS);
    const secret = SECRET_NAME.test(up.text) || SECRET_FILE.test(up.text);
    const unnamed = hosts.filter(h => !namedIn(h, docsNaming()));
    if (!secret && !unnamed.length) return false;
    const r = RULE['AGENT-018'];
    const soft = !isRun && !secret;
    findings.push({ rule: 'AGENT-018', sev: soft ? 'Medium' : r.sev, area: 'AI agent files', title: (secret ? 'Uploads a file of keys or passwords' + (hosts.length ? ' to ' + hosts.slice(0, 4).join(', ') : '') : r.title + ': ' + unnamed.slice(0, 4).join(', ')), where: f.rel + ':' + up.line, fix: soft ? DOC_FIX['AGENT-018'] : r.fix, fp: fingerprint('AGENT-018|' + up.text.slice(0, 400)) });
    return true;
  };
  for (const f of files) {
    if (left || late()) { left++; continue; }
    const isAuto = f.kind === 'autorun';
    const isConfig = f.kind === 'settings' || f.kind === 'mcp' || f.kind === 'toml' || isAuto;
    const conf = isConfig ? parseConfig(f.rel, f.text) : null;
    // A settings or MCP file that is not JSON (comments, a trailing comma, damage) is checked as plain text only.
    if ((f.kind === 'settings' || f.kind === 'mcp') && f.text.trim() && !conf) unread(f.rel + ' could not be read as JSON, so it was checked as plain text only (its hooks and servers may be missed). Claude Code may refuse it too; fix or remove it.');
    if (isAuto && f.text.trim() && !conf) unread(f.rel + ' could not be read as JSON, even with comments allowed, so what it starts by itself was not checked. Fix it, or read it by hand.');
    const fixture = f.kind === 'script' && isFixture(f);
    const before = findings.length;
    for (const h of fileFindings(f.rel, f.text, f.kind)) {
      const r = RULE[h.rule];
      // A chat service the skill says it uses is what it says, to be read; the same address unannounced is a drop box.
      if (h.rule === 'AGENT-010' && h.brand && docs.includes(h.brand)) { h.sev = 'Medium'; h.fix = DOC_FIX['AGENT-010']; }
      findings.push({ rule: h.rule, sev: h.sev || r.sev, area: 'AI agent files', title: r.title + (h.detail ? ': ' + h.detail : ''), where: f.rel + ':' + h.line, fix: h.fix || r.fix, fp: fingerprint(h.rule + '|' + (f.text.split('\n')[h.line - 1] || '')) });
    }
    // A remote MCP server nothing here names. A drop box or a bare IP has its own, stronger rule. The server's own key
    // counts as naming its brand ("linear" for mcp.linear.app), since that is how people write them.
    let urls = 0;
    for (const [name, s] of Object.entries(mcpServersOf(conf))) {
      const url = s && typeof s === 'object' && serverUrl(s);
      if (!url || DROPBOX.test(url) || ++urls > 50) continue;
      const host = [...hostsIn(url, true)][0];
      if (!host || namedIn(host, docs + '\n' + name.toLowerCase())) continue;
      const r = RULE['AGENT-019'];
      findings.push({ rule: 'AGENT-019', sev: r.sev, area: 'AI agent files', title: r.title + ': ' + host, where: f.rel + ':' + jsonLine(f.text, name), fix: r.fix, fp: fingerprint('AGENT-019|' + host) });
      break;
    }
    const isDoc = f.kind === 'doc' || f.kind === 'toml';
    const seen = isDoc ? seenText(f.text) : '';
    const autos = isDoc ? commandsRun(seen, f.kind, conf) : [];
    const lang = f.kind === 'script' ? langOf(f.rel, f.text) : 'hash';
    const code = f.kind === 'script' ? scriptCode(f.text, f.rel) : f.kind === 'settings' || isAuto ? hookCommands(conf).map(h => h.command).join('\n') : autos.map(a => a.text).join('\n');
    if (f.kind === 'script') does.runs.push(f.rel);
    if (f.kind === 'settings' || isAuto) {
      for (const h of hookCommands(conf)) does.hooks.push(h.event + ': ' + h.command.slice(0, 160));
      for (const p of hookPrompts(conf)) does.hooks.push(p.event + ': ' + p.prompt.replace(/\s+/g, ' ').slice(0, 160));
    }
    for (const a of autos.slice(0, 20)) does.hooks.push(f.rel + ': ' + a.text.replace(/\s+/g, ' ').slice(0, 160));
    const ranUpload = code ? uploadCheck(f, code, lang, true) : false;
    if (isDoc && !ranUpload) uploadCheck(f, seen, 'hash', false);
    if (fixture) {
      for (const x of findings.slice(before)) {
        if (!FIXTURE_SOFT.has(x.rule) || x.sev === 'Medium') continue;
        x.sev = 'Medium';
        x.title += ' (in a test file nothing here runs)';
        x.fix = 'Read the test file. It runs only if someone runs the tests, and is often a sample of what the skill guards against.';
      }
      continue;
    }
    if (!code) continue;
    if (NETWORK.test(code)) net = true;
    // A referer header says where a call came from; it is not where it goes.
    const called = hostsIn(code.replace(/["'](?:HTTP-)?Referer["']\s*:\s*f?["'][^"'\n]*["']/gi, ' '));
    for (const h of called) does.hosts.add(h);
    let keyed = false;
    for (const m of code.matchAll(new RegExp(KEY_ENV.source, 'g'))) {
      const k = m.slice(1).find(Boolean);
      if (k) { does.keys.add(k); keyed = true; }
    }
    // A key's name kept in a constant and read with it (ENV_KEY = "OPENROUTER_API_KEY"; os.environ.get(ENV_KEY)).
    if (/\bos\.(environ|getenv)\b|process\.env\b|\$env:|Environment\]::GetEnvironmentVariable/.test(code)) {
      for (const m of code.matchAll(/['"]([A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD))['"]/g)) { does.keys.add(m[1]); keyed = true; }
    }
    if (keyed) for (const h of called) keyedHosts.add(h);
    if (!dump) { const at = envDumpAt(code); if (at >= 0) dump = f.rel + ':' + (f.kind === 'script' ? lineAt(code, at) : autos.length ? autos[0].line() : 1); }
    if (!reads) { const s = secretHit(code); if (s && !s.soft) reads = f; }
  }
  // Read alone is High; read and sent (the same set talks to the internet) is Critical.
  if (reads && net) for (const x of findings) if (x.rule === 'AGENT-008' && x.where.startsWith(reads.rel + ':')) { x.sev = 'Critical'; x.title += ', and the skill talks to the internet'; }
  if (dump && net) { const r = RULE['AGENT-009']; findings.push({ rule: 'AGENT-009', sev: r.sev, area: 'AI agent files', title: r.title, where: dump, fix: r.fix }); }
  if (does.keys.size && net) {
    const byKey = keysNaming([...does.keys]);
    const unnamed = [...does.hosts].slice(0, MAX_NAMED_HOSTS).filter(h => !namedIn(h, docs) && !byKey(h));
    if (does.hosts.size > MAX_NAMED_HOSTS) unread('This skill names more than ' + MAX_NAMED_HOSTS + ' addresses; only the first ' + MAX_NAMED_HOSTS + ' were checked against what it says it uses.');
    if (unnamed.length) {
      const f = files.find(x => x.kind === 'script' && unnamed.some(h => x.text.toLowerCase().includes(h))) || files[0];
      const r = RULE['AGENT-011'];
      // The key in one file and the address in another may have nothing to do with each other: read to find out.
      const sev = unnamed.some(h => keyedHosts.has(h)) ? r.sev : 'Medium';
      findings.push({ rule: 'AGENT-011', sev, area: 'AI agent files', title: r.title + ': ' + unnamed.slice(0, 4).join(', '), where: f.rel + ':' + Math.max(1, firstLine(new RegExp(unnamed[0].replace(/\./g, '\\.'), 'i'), f.text)), fix: r.fix });
    }
  }
  return { findings, notes, notRead, left, does: { runs: does.runs, hooks: does.hooks, hosts: [...does.hosts].sort(), keys: [...does.keys].sort() } };
}

// null: not an agent's file. 'named': plain text, read when a doc names it. 'data': read when a doc names the file itself.
// 'sniff': no extension: a script if its first line says so, else the same as plain text. package.json and the other
// configs that are JSON keep their own kinds, above 'data'.
const kindOf = rel => {
  const name = path.posix.basename(rel);
  if (AUTORUN.test(rel)) return 'autorun';
  if (/^\.mcp\.json$|^mcp\.json$/i.test(name)) return 'mcp';
  if (/^settings(\.local)?\.json$|^hooks\.json$|\.kiro\.hook$/i.test(name)) return 'settings';
  if (/\.toml$/i.test(name)) return 'toml';
  if (/\.(md|mdc)$/i.test(name) || INSTRUCTION_FILE.test(rel)) return 'doc';
  if (SCRIPT.test(name) || MAKEFILE.test(name)) return 'script';
  const plain = NAMED_TEXT.test(name), bare = !path.posix.extname(name);
  if ((plain || bare) && RULE_FOLDER.test(rel)) return 'doc';
  if (DATA_TEXT.test(name)) return 'data';
  return plain ? 'named' : bare ? 'sniff' : null;
};
const waitsToBeNamed = k => k === 'named' || k === 'data';
const isReadKind = k => k && !waitsToBeNamed(k) && k !== 'sniff';
// One file on its own (pasted, or picked by name): the person chose it, so it is read whatever it is called.
const kindOfOne = (name, text) => {
  const k = kindOf(name);
  if (k === 'sniff') return /^\uFEFF?#!/.test(text) ? 'script' : 'doc';
  return k && !waitsToBeNamed(k) ? k : 'doc';
};
// Whether a file starts with #! , read without reading the file.
function hasShebang(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(5);
    const n = fs.readSync(fd, b, 0, 5, 0);
    const at = b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? 3 : 0;
    return n >= at + 2 && b[at] === 0x23 && b[at + 1] === 0x21;
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// A file an agent reads or runs, as text. A NUL does not stop an agent reading on, so it must not stop this check: the
// bytes are read as text with the NULs dropped, and odd says so, for the person to be told as well.
function agentText(buf) {
  let text = decodeText(buf), odd = text == null;
  if (odd) text = buf.toString('utf8');
  if (text.includes('\0')) { text = text.split('\0').join(''); odd = true; }
  return { text, odd };
}
const oddNote = rel => rel + ' holds bytes that are not text (a NUL, say). It was judged with those dropped, but check it by hand: what a program does with them is not known here.';
function readAgent(p) {
  let st; try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  try { return agentText(fs.readFileSync(p)); } catch { return null; }
}
// Plain text asked for by name is judged the same way. A file with no extension or some other kind that is not text is
// most likely a program, whose bytes say nothing as instructions: said, not read.
const namedReads = rel => /\.(md|mdc)$/i.test(rel) || NAMED_TEXT.test(rel) || DATA_TEXT.test(rel);
const listNames = a => a.slice(0, 5).join(', ') + (a.length > 5 ? '…' : '');
const sealedNote = a => a.length + ' file' + (a.length === 1 ? ' here is a program or an archive' : 's here are programs or archives') + ', so what is inside was not read: ' + listNames(a) + '. Only install it if you trust its maker.';
// Plain text a doc tells the agent to read, by its name or its folder's (a data file by its own name only): read as a
// doc, and a file so read can name another. Words are collected once, so the cost does not grow with the number of
// files. Plain text goes first, so a folder of data cannot push it past the limit.
function readNamedFiles(files, candidates, read, onFail) {
  const said = new Set();
  const isData = c => DATA_TEXT.test(c.rel);
  const left = new Set([...candidates.filter(c => !isData(c)), ...candidates.filter(isData)].slice(0, MAX_NAMED));
  let fresh = files.filter(f => f.kind === 'doc' || f.kind === 'toml');
  for (let round = 0; round < 3 && fresh.length && left.size; round++) {
    for (const f of fresh) for (const m of f.text.matchAll(/[\w.-]{1,200}/g)) said.add(m[0].replace(/\.+$/, '').toLowerCase());
    fresh = [];
    for (const c of left) {
      const parts = c.rel.toLowerCase().split('/');
      const base = parts[parts.length - 1], folder = parts[parts.length - 2];
      if (!said.has(base) && !(folder && !isData(c) && said.has(folder))) continue;
      left.delete(c);
      const text = read(c);
      if (text == null) { onFail(c.rel); continue; }
      const f = { rel: c.rel, text, kind: 'doc', abs: c.abs };
      files.push(f);
      fresh.push(f);
    }
  }
}

// ---- in a project audit ----
// Every agent folder (.claude, .agents ...), every instruction file (CLAUDE.md, AGENTS.md, SKILL.md) anywhere in the
// project, each skill's own scripts, and .mcp.json. Units: each skill folder on its own, the rest of the agent files
// together.
function agentFiles(dir, skip = new Set()) {
  const out = [];
  const skillDirs = new Set();
  // What could not be read is said, never passed over: too big or unreadable, a link (not followed), past the limit.
  const unread = [], links = [], sealed = [], closedDirs = [], deep = [], oddFiles = [];
  const candidates = [];
  // A named file's text, or null when it cannot be read or is not text at all.
  const readNamed = (abs, rel) => {
    const r = readAgent(abs);
    if (!r || (r.odd && !namedReads(rel))) return null;
    if (r.odd) oddFiles.push(rel);
    return r.text;
  };
  let full = false;
  let root = dir; try { root = fs.realpathSync(dir); } catch {}
  const staysInside = real => { const r = path.relative(root, real); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
  const followed = new Set(), readOnce = new Set();
  const walk = (d, depth, inAgent) => {
    if (out.length >= MAX_FILES) { full = true; return; }
    // Past the depth limit only an agent's own folder is said: an ordinary project goes that deep and no agent reads it.
    if (depth > 10) { if (inAgent) deep.push(path.relative(dir, d).replace(/\\/g, '/')); return; }
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { closedDirs.push(path.relative(dir, d).replace(/\\/g, '/') || '.'); return; }
    if (ents.some(e => e.isFile() && e.name === 'SKILL.md')) skillDirs.add(d);
    for (const e of ents) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      // A link (or Windows junction) out of the project is not followed: noted when it leads to a folder (it may hold a
      // skill under any name), or to a file of a kind read here. One that stays inside is read as if it were here, since
      // .claude/commands can be a link to a folder no agent rule would read otherwise; each thing is read once. A broken
      // link has nothing behind it.
      if (e.isSymbolicLink()) {
        if (inAgent ? AGENT_SKIP.has(e.name) : SKIP_DIRS.has(e.name)) continue;
        let real = null; try { real = fs.realpathSync(p); } catch {}
        if (!real) continue;
        let toDir = false; try { toDir = fs.statSync(p).isDirectory(); } catch {}
        if (!staysInside(real)) {
          if (toDir || inAgent || isReadKind(kindOf(rel))) links.push(rel + (toDir ? '/' : ''));
          continue;
        }
        if (toDir) {
          if (!skip.has(rel.toLowerCase()) && !followed.has(real)) { followed.add(real); walk(p, depth + 1, inAgent || AGENT_DIRS.has(e.name)); }
          continue;
        }
      }
      if (e.isDirectory()) {
        if (skip.has(rel.toLowerCase())) continue;
        if (inAgent ? AGENT_SKIP.has(e.name) : SKIP_DIRS.has(e.name)) continue;
        walk(p, depth + 1, inAgent || AGENT_DIRS.has(e.name));
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const inSkill = [...skillDirs].some(s => p.startsWith(s + path.sep));
      const inside = inAgent || inSkill;
      if (inside && SEALED.test(e.name)) { sealed.push(rel); continue; }
      let kind = kindOf(rel);
      if (!kind) continue;
      if (kind === 'sniff' && inside && hasShebang(p)) kind = 'script';
      if (kind === 'sniff' || waitsToBeNamed(kind)) { if (inside) candidates.push({ rel, abs: p }); continue; }
      // A package.json further down belongs to a package no one here is installing; the rest apply where they sit.
      const wanted = inside || INSTRUCTION_FILE.test(rel) || (kind === 'mcp' && (depth === 0 || VSCODE_MCP.test(rel))) || (kind === 'autorun' && (depth === 0 || !/(^|\/)package\.json$/i.test(rel)));
      if (!wanted) continue;
      if (out.length >= MAX_FILES) { full = true; return; }
      let real = p; try { real = fs.realpathSync(p); } catch {}
      if (readOnce.has(real)) continue;
      readOnce.add(real);
      const r = readAgent(p);
      if (r) { out.push({ rel, text: r.text, kind, abs: p }); if (r.odd) oddFiles.push(rel); }
      else unread.push(rel);
    }
  };
  walk(dir, 0, false);
  // Scripts a hook runs from the project (node .claude/hooks/x.mjs, ./hook.mjs) are read with the hooks.
  for (const f of out.filter(x => x.kind === 'settings' || x.kind === 'autorun')) {
    for (const h of hookCommands(parseConfig(f.rel, f.text))) {
      for (const m of h.command.matchAll(/(?:^|[\s"'])((?:\$CLAUDE_PROJECT_DIR\/|\.\/)?[\w.\/-]+\.(?:m?js|cjs|ts|py|sh|ps1|cmd|bat))\b/g)) {
        const rel = m[1].replace(/^\$CLAUDE_PROJECT_DIR\/|^\.\//, '');
        const abs = path.join(dir, rel);
        if (path.relative(dir, abs).startsWith('..') || out.some(x => x.abs === abs)) continue;
        if (!fs.existsSync(abs)) continue;
        const hooked = path.relative(dir, abs).replace(/\\/g, '/');
        const r = readAgent(abs);
        if (r) { out.push({ rel: hooked, text: r.text, kind: 'script', abs }); if (r.odd) oddFiles.push(hooked); }
        else unread.push(hooked);
      }
    }
  }
  // Plain text the agent is told to read: anywhere in a skill or agent folder by its name or folder's name, and anywhere
  // in the project by its path, or by a CLAUDE.md import (@path).
  readNamedFiles(out, candidates, c => readNamed(c.abs, c.rel), rel => unread.push(rel));
  let looked = 0;
  for (const f of out.slice()) {
    if (f.kind !== 'doc') continue;
    for (const m of f.text.matchAll(/(?:^|[\s"'(`])@?([\w.\/\\-]{1,200}\.(?:txt|text|rst|prompt|ya?ml))\b|(?:^|\s)@([\w.\/\\-]{1,200})|(?:^|[\s"'(`])([\w.\/\\-]{1,200}\.(?:csv|tsv|json|xml|ini|cfg|conf|html?|log))\b/gm)) {
      if (out.length >= MAX_FILES || ++looked > 200) break;
      const named = (m[1] || m[2] || m[3]).replace(/\\/g, '/');
      for (const base of [path.dirname(f.abs), dir]) {
        const abs = path.join(base, named);
        const rel = path.relative(dir, abs).replace(/\\/g, '/');
        if (rel.startsWith('..') || path.isAbsolute(rel) || out.some(x => x.abs === abs)) continue;
        // Named in passing, a config keeps its own kind (a package.json further down belongs to its own package).
        if (m[3] && kindOf(rel) !== 'data') continue;
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (!st.isFile()) continue;
        const text = readNamed(abs, rel);
        if (text == null) unread.push(rel);
        else out.push({ rel, text, kind: 'doc', abs });
        break;
      }
    }
  }
  const notes = [], notRead = [];
  const say = s => { notes.push(s); notRead.push(s); };
  if (unread.length) say(unread.length + ' AI agent file' + (unread.length === 1 ? '' : 's') + ' could not be checked (over ' + (MAX_BYTES >> 10) + ' KB, or could not be opened): ' + listNames(unread) + '. Read ' + (unread.length === 1 ? 'it' : 'them') + ' by hand before you trust ' + (unread.length === 1 ? 'it' : 'them') + '.');
  if (oddFiles.length) say(oddFiles.length + ' AI agent file' + (oddFiles.length === 1 ? ' holds' : 's hold') + ' bytes that are not text (a NUL, say): ' + listNames(oddFiles) + '. ' + (oddFiles.length === 1 ? 'It was' : 'They were') + ' judged with those dropped, but check by hand: what a program does with them is not known here.');
  if (links.length) say(links.length + ' AI agent file' + (links.length === 1 ? ' or folder is a link' : 's or folders are links') + ' to somewhere else, not followed: ' + listNames(links) + '. Check what ' + (links.length === 1 ? 'it points' : 'they point') + ' to.');
  if (sealed.length) say(sealedNote(sealed));
  if (closedDirs.length) say(closedDirs.length + ' folder' + (closedDirs.length === 1 ? '' : 's') + ' could not be opened, so nothing in ' + (closedDirs.length === 1 ? 'it' : 'them') + ' was read: ' + listNames(closedDirs) + '.');
  if (deep.length) say(deep.length + ' AI agent folder' + (deep.length === 1 ? ' is' : 's are') + ' more than 10 levels down, so ' + (deep.length === 1 ? 'it was' : 'they were') + ' not read: ' + listNames(deep) + '.');
  if (candidates.length > MAX_NAMED) say('More than ' + MAX_NAMED + ' plain text files sit in the AI agent folders; only the first ' + MAX_NAMED + ' were checked against what the instruction files name.');
  if (full) say('The AI agent files check stopped at ' + MAX_FILES + ' files; the rest were not read.');
  return { files: out, notes, notRead, skillDirs: [...skillDirs].map(s => path.relative(dir, s).replace(/\\/g, '/')) };
}

// opts.softAt, opts.budgetMs: the time limit (lib/audit-part.js). Past it no more files are judged.
function agentAudit(dir, skipList = [], opts = {}) {
  const skip = new Set(skipList.map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()));
  const { files, notes, notRead, skillDirs } = agentFiles(dir, skip);
  const units = new Map();
  for (const f of files) {
    const skill = skillDirs.filter(s => s && (f.rel === s || f.rel.startsWith(s + '/'))).sort((a, b) => b.length - a.length)[0];
    const k = skill || (skillDirs.includes('') ? '' : '*');
    if (!units.has(k)) units.set(k, []);
    units.get(k).push(f);
  }
  const findings = [];
  const late = () => !!opts.softAt && Date.now() > opts.softAt;
  let left = 0;
  for (const unit of units.values()) { const u = unitFindings(unit, late); findings.push(...u.findings); notes.push(...u.notes); notRead.push(...u.notRead); left += u.left; }
  return { findings, notes, notRead, filesRead: files.length, ...(left ? { stopped: { ms: Date.now() - (opts.softAt - opts.budgetMs), left: left + ' AI agent file' + (left === 1 ? '' : 's') } } : {}) };
}

// ---- a skill before it is installed ----
// input: { path } (a skill or plugin folder, a .zip / .skill file, or one .md file) or { text, name } (pasted).
const MAX_UNPACK = 50 * 1024 * 1024;
function skillFromZip(buf) {
  const files = [], notes = [], notRead = [], candidates = [], sealed = [];
  const say = s => { notes.push(s); notRead.push(s); };
  let total = 0;
  const entries = readZip(buf, MAX_FILES + 1);
  if (entries.length > MAX_FILES) say('The zip lists more than ' + MAX_FILES + ' files; only the first ' + MAX_FILES + ' were read.');
  const unpack = (e, rel) => {
    if (e.size > MAX_BYTES || total + e.size > MAX_UNPACK) { say(rel + ' is too big to read here (' + Math.round(e.size / 1024) + ' KB); check it by hand.'); return null; }
    try { const r = agentText(e.read(MAX_BYTES)); total += e.size; return r; } catch (err) { say(rel + ' could not be unpacked (' + err.message + ').'); return null; }
  };
  for (const e of entries.slice(0, MAX_FILES)) {
    const rel = e.name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (rel.endsWith('/')) continue;
    if (SEALED.test(rel)) { sealed.push(rel); continue; }
    let kind = kindOf(rel);
    if (!kind) continue;
    if (e.encrypted) { say(rel + ' is locked with a password, so it was not read.'); continue; }
    if (waitsToBeNamed(kind)) { candidates.push({ rel, e }); continue; }
    const got = unpack(e, rel);
    if (!got) continue;
    if (kind === 'sniff') {
      if (got.text.startsWith('#!')) kind = 'script';
      else { candidates.push({ rel, got }); continue; }
    }
    if (got.odd) say(oddNote(rel));
    files.push({ rel, text: got.text, kind });
  }
  const readCandidate = c => {
    const r = c.got || unpack(c.e, c.rel);
    if (!r || (r.odd && !namedReads(c.rel))) return null;
    if (r.odd) say(oddNote(c.rel));
    return r.text;
  };
  readNamedFiles(files, candidates, readCandidate, rel => { if (!notRead.some(n => n.startsWith(rel + ' '))) say(rel + ' could not be read as text, and the skill names it; check it by hand.'); });
  if (candidates.length > MAX_NAMED) say('More than ' + MAX_NAMED + ' plain text files are in the zip; only the first ' + MAX_NAMED + ' were checked against what the skill names.');
  if (sealed.length) say(sealedNote(sealed));
  return { files, notes, notRead };
}
function skillFromFolder(dir) {
  const files = [], notes = [], notRead = [], candidates = [], sealed = [];
  const say = s => { notes.push(s); notRead.push(s); };
  let seen = 0, full = false;
  const walk = (d, depth) => {
    if (files.length >= MAX_FILES) { full = true; return; }
    if (depth > 10) { say(path.relative(dir, d).replace(/\\/g, '/') + ' is more than 10 folders down, so nothing in it was read. Check it by hand.'); return; }
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { say((path.relative(dir, d).replace(/\\/g, '/') || 'The folder') + ' could not be opened, so nothing in it was read.'); return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      // Links are not followed (they can point anywhere on this PC); each one is named so the person can look.
      if (e.isSymbolicLink()) { say(rel + ' is a link to somewhere else, so it was not read. Check what it points to before you install this.'); continue; }
      if (e.isDirectory()) { if (!['node_modules', '.git', '__pycache__'].includes(e.name)) walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      seen++;
      if (SEALED.test(e.name)) { sealed.push(rel); continue; }
      let kind = kindOf(rel);
      if (!kind) continue;
      if (kind === 'sniff' && hasShebang(p)) kind = 'script';
      if (kind === 'sniff' || waitsToBeNamed(kind)) { candidates.push({ rel, abs: p }); continue; }
      const r = readAgent(p);
      if (!r) { say(rel + ' could not be read (too big, or could not be opened); check it by hand.'); continue; }
      if (r.odd) say(oddNote(rel));
      files.push({ rel, text: r.text, kind });
    }
  };
  walk(dir, 0);
  const readCandidate = c => {
    const r = readAgent(c.abs);
    if (!r || (r.odd && !namedReads(c.rel))) return null;
    if (r.odd) say(oddNote(c.rel));
    return r.text;
  };
  readNamedFiles(files, candidates, readCandidate, rel => say(rel + ' could not be read as text (too big or not text), and the skill names it; check it by hand.'));
  if (candidates.length > MAX_NAMED) say('More than ' + MAX_NAMED + ' plain text files are here; only the first ' + MAX_NAMED + ' were checked against what the skill names.');
  if (sealed.length) say(sealedNote(sealed));
  if (full || files.length >= MAX_FILES) say('Only the first ' + MAX_FILES + ' files were read.');
  return { files, notes, notRead, seen };
}

function checkSkill(input = {}) {
  let got;
  if (typeof input.text === 'string') {
    const name = String(input.name || 'SKILL.md').replace(/[\\/]/g, '_');
    const clean = input.text.split('\0').join('');
    const odd = clean.length !== input.text.length ? [oddNote(name)] : [];
    got = { files: [{ rel: name, text: clean, kind: kindOfOne(name, clean) }], notes: ['Only the text you pasted was checked. A skill is often a folder with scripts as well: check the whole folder or zip for those.', ...odd], notRead: odd };
  } else if (typeof input.path === 'string' && input.path) {
    const p = path.resolve(input.path);
    let st; try { st = fs.statSync(p); } catch { return { error: 'Nothing was found at that path.' }; }
    if (st.isDirectory()) got = skillFromFolder(p);
    else if (/\.(zip|skill|plugin)$/i.test(p)) {
      // A zip is read whole into memory, so a big file picked by mistake is refused first, not read.
      if (st.size > MAX_UNPACK) return { error: 'That file is ' + Math.round(st.size / 1048576) + ' MB: too big for a skill (the check reads up to ' + (MAX_UNPACK >> 20) + ' MB). Unzip it and check the folder instead.' };
      try { got = skillFromZip(fs.readFileSync(p)); } catch (e) { return { error: 'That file could not be read as a zip (' + e.message + ').' }; }
    } else {
      const r = readAgent(p);
      if (!r) return { error: 'That file is too big (over ' + (MAX_BYTES >> 10) + ' KB) or could not be opened. Read it by hand, or check its folder.' };
      const odd = r.odd ? [oddNote(path.basename(p))] : [];
      got = { files: [{ rel: path.basename(p), text: r.text, kind: kindOfOne(path.basename(p), r.text) }], notes: odd, notRead: odd };
    }
  } else return { error: 'Give a folder, a zip, or the text of a skill.' };
  if (!got.files.length) return { error: 'No skill files were found there (SKILL.md, scripts, settings or hooks).' + (got.notRead.length ? ' Not read: ' + got.notRead.join(' ') : '') };
  const { findings, does, notes: unitNotes, notRead: unitUnread } = unitFindings(got.files);
  const ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
  findings.sort((a, b) => ORDER[a.sev] - ORDER[b.sev]);
  const count = s => findings.filter(f => f.sev === s).length;
  const counts = { Critical: count('Critical'), High: count('High'), Medium: count('Medium') };
  const runsCode = does.runs.length > 0 || does.hooks.length > 0;
  const notRead = [...got.notRead, ...unitUnread];
  // Partly checked is its own verdict: what was read shows nothing, and what was not read is not covered by that.
  const verdict = counts.Critical + counts.High ? 'do-not-install' : counts.Medium ? 'read-first' : notRead.length ? 'partly-checked' : 'no-known-attack';
  const notes = [...got.notes, ...unitNotes];
  if ((verdict === 'no-known-attack' || verdict === 'partly-checked') && runsCode) notes.push('No known attack was found, but this skill runs code. No scan can prove code is safe: read what it runs (listed above) before you install it, or install only skills from makers you trust.');
  return {
    verdict,
    headline: verdict === 'do-not-install' ? 'Do not install' : verdict === 'read-first' ? 'Read these first' : verdict === 'partly-checked' ? 'No known attack found, partly checked' : 'No known attack found',
    counts, findings, does, notes, notRead,
    filesRead: got.files.map(f => f.rel),
    rules: Object.keys(RULE).length,
  };
}

module.exports = { agentAudit, checkSkill, RULE, proseOf, hiddenParts, tagSmuggled };
