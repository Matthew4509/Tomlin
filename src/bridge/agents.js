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
};

// The same line in a doc (the agent is told about it; a person may be too) is a warning to read first, with its own way out.
const DOC_FIX = {
  'AGENT-006': 'Before you (or the agent) run it, check the address belongs to the program\'s real maker, and that the skill needs it.',
  'AGENT-008': 'Read what the skill asks the agent to do with that file. Only a setup guide for keys should name it, and never to send it anywhere.',
  'AGENT-012': 'Read what the skill asks the agent to add there. A skill rarely needs to change how your PC or terminal starts.',
};

// ---- which files ----
// Folders the agents keep their settings, skills and commands in.
const AGENT_DIRS = new Set(['.claude', '.agents', '.codex', '.cursor', '.windsurf', '.gemini', '.claude-plugin']);
// Inside them, folders that hold the agent's own logs and copies, not instructions (a worktree is a whole copy of the
// project, scanned already as the project itself).
const AGENT_SKIP = new Set(['worktrees', 'projects', 'todos', 'shell-snapshots', 'statsig', 'ide', 'logs', 'cache', 'tmp', 'node_modules', 'file-history', 'plans', 'debug']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv', 'coverage',
  '_build', '_dist', '_release', '_releases', 'releases', '_backups', '.next', '.nuxt', '.output', '.svelte-kit']);
const INSTRUCTION_FILE = /(^|\/)(SKILL|CLAUDE|CLAUDE\.local|AGENTS|GEMINI)\.md$|(^|\/)\.(cursorrules|windsurfrules)$|(^|\/)copilot-instructions\.md$|\.mdc$/i;
const SCRIPT = /\.(m?js|cjs|ts|py|sh|bash|zsh|ps1|psm1|cmd|bat|rb|pl)$/i;
const MAX_FILES = 3000;
const MAX_BYTES = 400 * 1024;

// ---- the patterns ----
// Said to the agent: ignore the rest, keep it from the person, a new "system" voice.
const OVERRIDE = /\b(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|every\s+)?(of\s+)?(the\s+|your\s+|my\s+)?(previous|prior|above|earlier|preceding|original|system|other|existing|safety|security)\s+(instructions?|rules?|prompts?|guidelines?|directions?|guardrails?|restrictions?|policies)\b/i;
const CONCEAL = /\b(do\s+not|don['’]t|never|without)\s+(tell(ing)?|inform(ing)?|mention(ing)?\s+(it\s+|this\s+)?to|reveal(ing)?(\s+this|\s+it)?\s+to|alert(ing)?|notify(ing)?)\s+(the\s+|your\s+)?(user|human|owner|operator|person)\b|\b(keep|hide)\s+(this|it)\s+(secret\s+)?from\s+(the\s+)?(user|human|owner)\b|\b(silently|secretly|covertly)\s+(run|execute|send|upload|install|copy|post|exfiltrate|download)\b/i;
const ROLE = /<\/?(system|system_prompt|im_start|im_end)\b[^>\n]{0,40}>|<\|im_(start|end)\|>|\[\/?INST\]|^[ \t]*(#+[ \t]*)?(new|updated|real|actual)[ \t]+(system[ \t]+)?instructions[ \t]*:|\byou\s+are\s+now\s+(in\s+)?(developer|dan|god|admin|jailbreak|unrestricted)\b/im;
// A gap may hold a dot inside a word (.env, example.com), not the end of a sentence.
const EXFIL = /\b(send|post|upload|forward|e-?mail|transmit|exfiltrate|leak|submit)\b(?:[^.\n]|\.(?=\w)){0,80}?\b(api[\s_-]?keys?|tokens?|secrets?|passwords?|credentials?|\.env\b|environment\s+variables?|env\s+vars?|ssh\s+keys?|id_rsa|cookies|conversation|chat\s+history|transcripts?|private\s+keys?)\b(?:[^.\n]|\.(?=\w)){0,80}?\b(to|into|via|at)\s+(https?:\/\/|[\w.+-]+@[\w-]+\.\w|a\s+webhook|(the|this|our|my)\s+(following\s+)?(url|endpoint|server|webhook|address))/i;
// Hidden text is judged by the same words, and also by a command or a key sent away in it. A plain note or a link in
// a comment ("<!-- see https://... -->", "<!-- keep this short -->") is left alone.
const HIDDEN_ACTS = /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|iex|bash\s+-c|sh\s+-c|powershell\s+-\w+|base64\s+(-d|--decode))\b|\|\s*(ba)?sh\b|\b(send|upload|post|e-?mail|exfiltrate|forward)\b[^.\n]{0,60}(\.env\b|\.ssh|id_rsa|credentials|api[_ -]?keys?|tokens?|passwords?|secrets?)/i;

const DOWNLOAD_RUN = /\b(curl|wget)\b[^\n|;]{0,300}\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(curl|wget)\b[^\n|;]{0,300}\|\s*(python3?|node|perl|ruby)\b|\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b[^\n]{0,300}\|\s*(iex|Invoke-Expression)\b|\b(iex|Invoke-Expression)\b\s*\(?\s*\(?\s*(New-Object\s+(System\.)?Net\.WebClient|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b|\b(ba)?sh\s+<\(\s*(curl|wget)\b|\bcertutil(\.exe)?\b[^\n]{0,80}-urlcache\b|\bbitsadmin(\.exe)?\b[^\n]{0,80}\/transfer\b|\bmshta(\.exe)?\s+["']?https?:/i;
const ENCODED_EXEC = /\b(eval|exec|Function|execSync|spawnSync)\s*\(\s*(atob|base64\.b64decode|b64decode|bytes\.fromhex|codecs\.decode|zlib\.decompress|marshal\.loads|unescape)\s*\(|\b(eval|Function)\s*\(\s*Buffer\.from\([^)]{0,2000}['"](base64|hex)['"]|\bexec\s*\(\s*compile\s*\(\s*(base64|zlib)|FromBase64String[^\n]{0,300}\b(iex|Invoke-Expression)\b|\b(iex|Invoke-Expression)\b[^\n]{0,300}FromBase64String|\bpowershell(\.exe)?\b[^\n]{0,200}\s-(e|ec|en|enc|enco|encod|encode|encodedcommand)\s+[A-Za-z0-9+/=]{16,}|\becho\s+["']?[A-Za-z0-9+/=]{40,}["']?\s*\|\s*base64\s+(-d|--decode)\b[^\n]{0,40}\|\s*(ba)?sh\b/i;
const SECRET_FILE = /\.ssh[\\/]+(id_(rsa|dsa|ecdsa|ed25519)\b(?!\.pub)|authorized_keys|config)\b|\bid_(rsa|dsa|ecdsa|ed25519)\b(?!\.pub)|\.aws[\\/]+credentials|\.azure[\\/]+(accessTokens|msal_token_cache)|\.kube[\\/]+config|\.docker[\\/]+config\.json|\.git-credentials\b|[\\/]\.netrc\b|[\\/]\.npmrc\b|[\\/]\.pypirc\b|\bLogin Data\b|\bWeb Data\b|cookies\.sqlite|\blogins\.json\b|\bkey4\.db\b|\bwallet\.dat\b|\bsecurity\s+find-(generic|internet)-password\b|\bcmdkey\s+\/list\b|\bvaultcmd\b|\.claude[\\/]+\.credentials\.json|\.config[\\/]+gh[\\/]+hosts\.yml|Local Storage[\\/]+leveldb|\\AppData\\Roaming\\(Exodus|Electrum|Ethereum|atomic)\b/i;
const NETWORK = /\b(fetch|axios|XMLHttpRequest|WebSocket|requests\.(get|post|put|request|Session)|httpx|urllib|urlopen|aiohttp|smtplib|nodemailer|curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Net\.WebClient|UploadString|UploadFile|ncat|scp)\b|\bhttps?\.(get|request)\s*\(|\bsocket\.(socket|connect|create_connection)\b|\bnc\s+-|\bnet\.connect\s*\(/i;
const DROPBOX = /https?:\/\/(?:[\w-]+\.)*(discord(app)?\.com\/api\/webhooks|hooks\.slack\.com\/services|api\.telegram\.org\/bot|pastebin\.com|paste\.ee|hastebin\.com|transfer\.sh|file\.io|0x0\.st|ngrok(-free)?\.(io|app|dev)|webhook\.site|requestbin\.\w+|pipedream\.net|beeceptor\.com|burpcollaborator\.net|oast\.(pro|live|site|online|fun|me)|interact\.sh|trycloudflare\.com|serveo\.net|localtunnel\.me|loca\.lt)\b|https?:\/\/(?!(127|10|0)\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}(\.\d{1,3}){3}\b/i;
const ENV_DUMP = /JSON\.stringify\(\s*process\.env\s*[,)]|Object\.(entries|keys|values)\(\s*process\.env\s*\)|\bdict\(\s*os\.environ\s*\)|\bos\.environ\.(copy|items)\(\)|json\.dumps\(\s*(dict\()?\s*os\.environ|\bfor\s+\w+(\s*,\s*\w+)?\s+in\s+os\.environ\b|\bprintenv\b|\benv\s*(\||>)|Get-ChildItem\s+(-Path\s+)?env:|\b(gci|ls|dir)\s+env:|\[(System\.)?Environment\]::GetEnvironmentVariables\(\s*\)/i;
// The name of a key read from the environment (one capture group per way of reading it).
const KEY_ENV = /process\.env\.([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|CREDENTIALS?)[A-Za-z0-9_]*)|process\.env\[\s*['"]([^'"]*(?:KEY|TOKEN|SECRET|PASS)[^'"]*)['"]|os\.(?:environ\.get|getenv)\(\s*['"]([^'"]*(?:KEY|TOKEN|SECRET|PASS)[^'"]*)['"]|os\.environ\[\s*['"]([^'"]*(?:KEY|TOKEN|SECRET|PASS)[^'"]*)['"]|\$env:([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASS)[A-Za-z0-9_]*)|\$\{?([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\b/;
const PERSIST_TARGET = /\.bashrc\b|\.zshrc\b|\.bash_profile\b|\.zprofile\b|[\\/]\.profile\b|config\.fish\b|PowerShell_profile\.ps1\b|\$PROFILE\b|Start Menu[\\/]+Programs[\\/]+Startup|[\\/]Startup[\\/]|\.git[\\/]+hooks[\\/]|\.claude[\\/]+settings(\.local)?\.json|\.claude[\\/]+CLAUDE\.md|LaunchAgents[\\/]/i;
const WRITES = /(^|[\s\d])>>?\s*["']?[~$\w%\\/.-]|\b(Add-Content|Set-Content|Out-File|New-Item|Copy-Item|appendFile(Sync)?|writeFile(Sync)?|copyFile(Sync)?|symlink(Sync)?|tee)\b|\bopen\([^)]{0,300}['"](a|w|a\+|w\+)['"]|\bcp\s|\bcopy\s|\bln\s+-s\b/i;
const PERSIST_CMD = /\bschtasks(\.exe)?\s+\/create\b|\bRegister-ScheduledTask\b|\breg(\.exe)?\s+add\s+[^\n]{0,200}\\(Run|RunOnce)\b|\bNew-ItemProperty\b[^\n]{0,200}\\(Run|RunOnce)\b|\(crontab\s+-l|\bcrontab\s+-\s*$|\bcrontab\s+\S+\.(txt|cron)\b|\blaunchctl\s+(load|bootstrap)\b|\bsystemctl\s+(--user\s+)?enable\b|\bgit\s+config\s+--global\s+core\.hooksPath\b/im;
const BYPASS = /--dangerously-skip-permissions\b|["']?defaultMode["']?\s*:\s*["']bypassPermissions["']|--permission-mode[\s=]+bypassPermissions\b|--dangerously-bypass-approvals-and-sandbox\b|\bapproval[_-]policy\s*=\s*["']?never\b/i;
const WIDE_ALLOW = /^(Bash|PowerShell|Shell)(\(\s*\*+\s*(:\s*\*+)?\s*\))?$/;
// A data: picture is a long base64 block too, and one the reader sees as a picture.
const B64_BLOCK = /(?<![A-Za-z0-9+/=]|base64,)[A-Za-z0-9+/]{240,}={0,2}(?![A-Za-z0-9+/=])/;

// ---- reading helpers ----
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
// Code blocks and inline code blanked, line breaks kept: an example in backticks is shown, not said. The commands
// in a code block are still read by the script checks (a skill's code block is what the agent runs).
function proseOf(text) {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, m => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]+`/g, m => ' '.repeat(m.length));
}
// A script's code only: comment lines, /* */ blocks and Python docstrings blanked, line breaks kept. "Blocks
// ~/.ssh/id_rsa" in a comment is a note about a guard, not a read.
function scriptCode(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|^[ \t]*[rRuUbB]?("""|''')[\s\S]*?\1/gm, m => m.replace(/[^\n]/g, ' '))
    .split('\n').map(l => (/^\s*(#(?!!)|\/\/|rem\s|::|<#)/i.test(l) ? '' : l)).join('\n');
}
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?![.\d])|color\s*:\s*(white|#fff\b|#ffffff\b)|\shidden\b/i;
// The places in a Markdown file that a reader of the rendered page does not see: HTML comments, link-reference
// comments ([//]: # (...)), and elements styled away (display:none, hidden, zero-size or white text).
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
function hiddenParts(prose) {
  const out = [];
  for (const c of htmlComments(prose)) out.push({ text: c.text, at: c.at });
  for (const m of prose.matchAll(/^[ \t]*\[[^\]\n]*\]:\s*(#|<>)\s*\(([^)\n]*)\)/gm)) out.push({ text: m[2], at: m.index });
  // An element styled away: its opening tag is read on its own (bounded), then its closing tag is looked for within
  // 4000 characters. One pattern over both backtracked without end on a file of unclosed tags (43 s for 32 KB).
  for (const m of prose.matchAll(/<(\w+)\b([^<>]{0,500})>/g)) {
    if (!HIDDEN_STYLE.test(m[2])) continue;
    const start = m.index + m[0].length;
    // Never closed: a browser hides it to the end of the HTML block, which in Markdown is the next blank line.
    const near = prose.slice(start, start + 4000);
    let end = near.search(new RegExp('</' + m[1] + '\\s*>', 'i'));
    if (end < 0) { end = near.search(/\n[ \t]*\n/); if (end < 0) end = near.length; }
    out.push({ text: prose.slice(start, start + end), at: m.index });
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
// Direction flips (text that reads one way and runs another) and zero-width characters (a ZWJ inside an emoji is fine).
function invisibleChars(text) {
  const bidi = /[\u202A-\u202E\u2066-\u2069]/.exec(text);
  if (bidi) return { at: bidi.index, what: 'a character that flips the reading direction' };
  const zw = [...text.matchAll(/[\u200B\u200C\u2060\u180E]|(?<!^)\uFEFF|(?<![\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F])\u200D|\u200D(?!\p{Extended_Pictographic})/gu)];
  if (zw.length >= 3) return { at: zw[0].index, what: zw.length + ' zero-width characters' };
  return null;
}
// The services a script talks to: hosts written in it, not made-up or local ones.
function hostsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const h = m[1].toLowerCase();
    if (/^(localhost|127\.0\.0\.1)$|\.(example|test|local|localhost|invalid)$|^(example\.(com|org|net)|www\.w3\.org|schema\.org|json-schema\.org)$/.test(h)) continue;
    out.add(h);
  }
  return out;
}
// A service counts as named when the skill's own text has its site or its brand ("Google" for googleapis.com).
const BRAND = [[/google|gstatic|googleapis/, 'google'], [/openai/, 'openai'], [/anthropic|claude/, 'anthropic'], [/cloudflare/, 'cloudflare'], [/github/, 'github'], [/microsoft|azure|windows\.net/, 'microsoft|azure'], [/amazonaws|aws/, 'aws|amazon']];
function namedIn(host, docs) {
  const site = siteOf(host);
  if (docs.includes(site)) return true;
  const brand = (BRAND.find(([re]) => re.test(host)) || [null, site.split('.')[0]])[1];
  return new RegExp('\\b(' + brand + ')', 'i').test(docs);
}
const firstLine = (re, text) => { const m = re.exec(text); return m ? lineAt(text, m.index) : 0; };

// ---- one file ----
// kind: 'doc' (instructions the agent reads), 'script', 'settings' (an agent's settings or hooks file), 'mcp'.
function fileFindings(rel, raw, kind) {
  const out = [];
  // Hidden characters are looked for everywhere; the other checks read a script's code, not its comments. In a
  // settings or MCP file the commands are also read from the parsed JSON, one per line after the file: a one-line
  // (minified) file, or a command written with \u escapes, reads differently as raw text than it runs.
  const cmds = kind === 'settings' || kind === 'mcp' ? jsonCommands(parseJson(raw)).map(c => c.replace(/\s*\n\s*/g, ' ')) : [];
  const text = kind === 'script' ? scriptCode(raw) : cmds.length ? raw + '\n' + cmds.join('\n') : raw;
  const rawLines = raw.split('\n').length;
  // A hit on one of those added lines is placed on the file's line that holds the value (else line 1).
  const hit = (rule, line, extra = {}) => out.push({ rule, line: line > rawLines ? jsonLine(raw, cmds[line - rawLines - 1] || '') : line, ...extra });
  const tag = tagSmuggled(raw);
  if (tag) hit('AGENT-002', lineAt(raw, tag.at), { detail: tag.said ? 'it reads: "' + tag.said.slice(0, 120) + (tag.said.length > 120 ? '…' : '') + '"' : '' });
  const inv = invisibleChars(raw);
  if (inv && kind !== 'script') hit('AGENT-003', lineAt(raw, inv.at), { detail: inv.what });
  if (kind === 'doc') {
    const prose = proseOf(text);
    for (const h of hiddenParts(prose)) {
      const t = h.text;
      if (OVERRIDE.test(t) || CONCEAL.test(t) || ROLE.test(t) || EXFIL.test(t) || HIDDEN_ACTS.test(t)) {
        hit('AGENT-001', lineAt(prose, h.at), { detail: 'it says: "' + t.replace(/\s+/g, ' ').trim().slice(0, 120) + (t.length > 120 ? '…' : '') + '"' });
        break;
      }
    }
    let shown = prose;
    for (const c of htmlComments(prose)) shown = shown.slice(0, c.at) + shown.slice(c.at, c.end).replace(/[^\n]/g, ' ') + shown.slice(c.end);
    const said = [OVERRIDE, CONCEAL, ROLE].map(re => firstLine(re, shown)).filter(Boolean);
    if (said.length) hit('AGENT-004', Math.min(...said));
    const ex = firstLine(EXFIL, shown);
    if (ex) hit('AGENT-005', ex);
    const b64 = firstLine(B64_BLOCK, text);
    if (b64) hit('AGENT-016', b64);
  }
  // What runs: a script, a hook's command, and the commands a skill tells the agent to run (its code blocks).
  // An install line in a guide ("curl -LsSf https://astral.sh/uv/install.sh | sh") is common and often fine: in a doc it
  // is a warning that names where the program comes from. A script or hook that does it on its own is Critical.
  const dlM = DOWNLOAD_RUN.exec(text);
  if (dlM) {
    const from = (/https?:\/\/([a-z0-9.-]+)/i.exec(text.slice(dlM.index, dlM.index + 400)) || [])[1];
    hit('AGENT-006', lineAt(text, dlM.index), { ...(kind === 'doc' ? { sev: 'Medium', fix: DOC_FIX['AGENT-006'] } : {}), detail: from ? 'from ' + from : '' });
  }
  const enc = firstLine(ENCODED_EXEC, text);
  if (enc) hit('AGENT-007', enc);
  // A doc that names a key file may be a setup guide ("add the key from ~/.ssh to GitHub"): a warning to read first.
  // A script that reads one is High, and Critical once the skill also talks to the internet (unitFindings).
  const sec = firstLine(SECRET_FILE, text);
  if (sec) hit('AGENT-008', sec, kind === 'doc' ? { sev: 'Medium', fix: DOC_FIX['AGENT-008'] } : {});
  const drop = firstLine(DROPBOX, text);
  if (drop) hit('AGENT-010', drop);
  // Set up to run again: a write to a start-up place (on one line), or a scheduler command. Only a script or a hook
  // does it on its own; a doc that tells the agent to do it is a warning to read first.
  const lines = text.split('\n');
  // Lines over 4000 characters are passed over here, but the commands read from a settings file (the lines after
  // rawLines) are each one command, however long, and are always read.
  const readLine = (l, i) => l.length < 4000 || i >= rawLines;
  const pIdx = lines.findIndex((l, i) => readLine(l, i) && ((PERSIST_TARGET.test(l) && WRITES.test(l)) || PERSIST_CMD.test(l)));
  if (pIdx >= 0) hit('AGENT-012', pIdx + 1, kind === 'doc' ? { sev: 'Medium', fix: DOC_FIX['AGENT-012'] } : {});
  // "Never use --dangerously-skip-permissions" in a doc is a rule against it, not a use of it.
  const byIdx = lines.findIndex((l, i) => readLine(l, i) && BYPASS.test(l) && !(kind === 'doc' && /\b(never|don['’]t|do\s+not|avoid|without)\b/i.test(l)));
  if (byIdx >= 0) hit('AGENT-013', byIdx + 1);
  // MCP servers can sit in a settings file too (.gemini/settings.json).
  if (kind === 'settings') settingsFindings(raw, hit);
  if (kind === 'settings' || kind === 'mcp') mcpFindings(raw, hit);
  return out;
}

function parseJson(text) { try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return null; } }
// Line of a value in a JSON file: the first line holding it (as JSON writes it), else 1.
const jsonLine = (text, value) => { const i = text.indexOf(JSON.stringify(value).slice(1, -1)); return i < 0 ? 1 : lineAt(text, i); };

// Settings keys whose value is a command Claude Code runs by itself, with no model in the loop.
const COMMAND_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];
function hookCommands(j) {
  const out = [];
  if (!j || typeof j !== 'object') return out;
  for (const k of COMMAND_KEYS) if (typeof j[k] === 'string') out.push({ event: k, command: j[k] });
  if (j.statusLine && typeof j.statusLine.command === 'string') out.push({ event: 'statusLine', command: j.statusLine.command });
  const hooks = j.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) if (h && typeof h.command === 'string') out.push({ event, command: h.command });
    }
  }
  return out;
}
// Everything in a settings or MCP file that runs or decides what may run, as text: hook and helper commands, each MCP
// server's command line and address, and a permission mode that switches the checks off.
function jsonCommands(j) {
  if (!j || typeof j !== 'object') return [];
  const out = hookCommands(j).map(h => h.command);
  const servers = j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
  for (const s of Object.values(servers)) {
    if (!s || typeof s !== 'object') continue;
    const line = [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter(x => typeof x === 'string').join(' ');
    if (line) out.push(line);
    if (typeof s.url === 'string') out.push(s.url);
  }
  const mode = j.permissions && j.permissions.defaultMode;
  if (typeof mode === 'string' && /^bypassPermissions$/i.test(mode)) out.push('"defaultMode": "' + mode + '"');
  return out;
}
function settingsFindings(text, hit) {
  const j = parseJson(text);
  if (!j || typeof j !== 'object') return;
  const allow = j.permissions && Array.isArray(j.permissions.allow) ? j.permissions.allow : [];
  const wide = allow.find(a => typeof a === 'string' && WIDE_ALLOW.test(a.trim()));
  if (wide) hit('AGENT-014', jsonLine(text, wide));
  if (j.enableAllProjectMcpServers === true) hit('AGENT-017', firstLine(/enableAllProjectMcpServers/, text) || 1);
}
// npx / bunx / pnpm dlx / uvx / pipx run <package>: pinned when the package names a version.
function mcpFindings(text, hit) {
  const j = parseJson(text);
  const servers = j && typeof j === 'object' && j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s.command !== 'string') continue;
    const args = Array.isArray(s.args) ? s.args.filter(a => typeof a === 'string') : [];
    const cmd = path.basename(s.command).replace(/\.(cmd|exe)$/i, '').toLowerCase();
    let rest = args;
    if (cmd === 'pnpm' || cmd === 'yarn') { if (args[0] !== 'dlx') continue; rest = args.slice(1); }
    else if (cmd === 'pipx') { if (args[0] !== 'run') continue; rest = args.slice(1); }
    else if (!['npx', 'bunx', 'uvx'].includes(cmd)) continue;
    const pkg = rest.find(a => !a.startsWith('-'));
    if (!pkg || /^[.\\/]|^[A-Za-z]:/.test(pkg)) continue;
    const pinned = cmd === 'uvx' || cmd === 'pipx' ? /(==|@)\d/.test(pkg) || rest.some(a => /^--from$/.test(a)) : /^@?[^@]+@\d/.test(pkg) || /^@[^/]+\/[^@]+@\d/.test(pkg);
    if (!pinned) { hit('AGENT-015', jsonLine(text, name), { detail: name + ': ' + pkg }); return; }
  }
}

// ---- a set of files that work together (one skill, one plugin, a project's agent folder) ----
// files: [{ rel, text, kind }]. Returns findings (with where) and what the set does.
function unitFindings(files) {
  const findings = [];
  const docs = files.filter(f => f.kind === 'doc').map(f => f.text).join('\n').toLowerCase();
  const does = { runs: [], hooks: [], hosts: new Set(), keys: new Set() };
  let reads = null, dump = null, net = false;
  const notes = [];
  for (const f of files) {
    // A settings or MCP file that is not JSON (comments, a trailing comma, damage) is checked as plain text only.
    if ((f.kind === 'settings' || f.kind === 'mcp') && f.text.trim() && !parseJson(f.text)) notes.push(f.rel + ' could not be read as JSON, so it was checked as plain text only (its hooks and servers may be missed). Claude Code may refuse it too; fix or remove it.');
    for (const h of fileFindings(f.rel, f.text, f.kind)) {
      const r = RULE[h.rule];
      findings.push({ rule: h.rule, sev: h.sev || r.sev, area: 'AI agent files', title: r.title + (h.detail ? ': ' + h.detail : ''), where: f.rel + ':' + h.line, fix: h.fix || r.fix, fp: fingerprint(h.rule + '|' + (f.text.split('\n')[h.line - 1] || '')) });
    }
    const code = f.kind === 'script' ? scriptCode(f.text) : f.kind === 'settings' ? hookCommands(parseJson(f.text)).map(h => h.command).join('\n') : '';
    if (f.kind === 'script') does.runs.push(f.rel);
    if (f.kind === 'settings') for (const h of hookCommands(parseJson(f.text))) does.hooks.push(h.event + ': ' + h.command.slice(0, 160));
    if (!code) continue;
    if (NETWORK.test(code)) net = true;
    for (const h of hostsIn(code)) does.hosts.add(h);
    for (const m of code.matchAll(new RegExp(KEY_ENV.source, 'g'))) {
      const k = m.slice(1).find(Boolean);
      if (k) does.keys.add(k);
    }
    // A key's name kept in a constant and read with it (ENV_KEY = "OPENROUTER_API_KEY"; os.environ.get(ENV_KEY)).
    if (/\bos\.(environ|getenv)\b|process\.env\b|\$env:|Environment\]::GetEnvironmentVariable/.test(code)) {
      for (const m of code.matchAll(/['"]([A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD))['"]/g)) does.keys.add(m[1]);
    }
    if (!dump && ENV_DUMP.test(code)) dump = f.rel + ':' + firstLine(ENV_DUMP, code);
    if (!reads && SECRET_FILE.test(code)) reads = f;
  }
  // Read alone is High; read and sent (the same set talks to the internet) is Critical.
  if (reads && net) for (const x of findings) if (x.rule === 'AGENT-008' && x.where.startsWith(reads.rel + ':')) { x.sev = 'Critical'; x.title += ', and the skill talks to the internet'; }
  if (dump && net) { const r = RULE['AGENT-009']; findings.push({ rule: 'AGENT-009', sev: r.sev, area: 'AI agent files', title: r.title, where: dump, fix: r.fix }); }
  if (does.keys.size && net) {
    const unnamed = [...does.hosts].filter(h => !namedIn(h, docs));
    if (unnamed.length) {
      const f = files.find(x => x.kind === 'script' && unnamed.some(h => x.text.toLowerCase().includes(h))) || files[0];
      const r = RULE['AGENT-011'];
      findings.push({ rule: 'AGENT-011', sev: r.sev, area: 'AI agent files', title: r.title + ': ' + unnamed.slice(0, 4).join(', '), where: f.rel + ':' + Math.max(1, firstLine(new RegExp(unnamed[0].replace(/\./g, '\\.'), 'i'), f.text)), fix: r.fix });
    }
  }
  return { findings, notes, does: { runs: does.runs, hooks: does.hooks, hosts: [...does.hosts].sort(), keys: [...does.keys].sort() } };
}

const kindOf = rel => {
  const name = path.posix.basename(rel);
  if (/^\.mcp\.json$|^mcp\.json$/i.test(name)) return 'mcp';
  if (/^settings(\.local)?\.json$|^hooks\.json$/i.test(name)) return 'settings';
  if (/\.(md|mdc)$/i.test(name) || INSTRUCTION_FILE.test(rel)) return 'doc';
  if (SCRIPT.test(name)) return 'script';
  return null;
};

function readText(p) {
  let st; try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  try { return decodeText(fs.readFileSync(p)); } catch { return null; }
}

// ---- in a project audit ----
// Every agent folder (.claude, .agents ...), every instruction file (CLAUDE.md, AGENTS.md, SKILL.md) anywhere in the
// project, each skill's own scripts, and .mcp.json. Units: each skill folder on its own, the rest of the agent files
// together.
function agentFiles(dir, skip = new Set()) {
  const out = [];
  const skillDirs = new Set();
  // What could not be read is said, never passed over: too big or unreadable, a link (not followed), past the limit.
  const unread = [], links = [];
  let full = false;
  const walk = (d, depth, inAgent) => {
    if (out.length >= MAX_FILES || depth > 10) { full = full || out.length >= MAX_FILES; return; }
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.isFile() && e.name === 'SKILL.md')) skillDirs.add(d);
    for (const e of ents) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      // A link (or Windows junction) is never followed: noted when it leads to a folder (it may hold a skill under any
      // name), or to a file of a kind read here.
      if (e.isSymbolicLink()) {
        if (inAgent ? AGENT_SKIP.has(e.name) : SKIP_DIRS.has(e.name)) continue;
        let toDir = false; try { toDir = fs.statSync(p).isDirectory(); } catch {}
        if (toDir || inAgent || kindOf(rel)) links.push(rel + (toDir ? '/' : ''));
        continue;
      }
      if (e.isDirectory()) {
        if (skip.has(rel.toLowerCase())) continue;
        if (inAgent ? AGENT_SKIP.has(e.name) : SKIP_DIRS.has(e.name)) continue;
        walk(p, depth + 1, inAgent || AGENT_DIRS.has(e.name));
        continue;
      }
      if (!e.isFile()) continue;
      const inSkill = [...skillDirs].some(s => p.startsWith(s + path.sep));
      const kind = kindOf(rel);
      if (!kind) continue;
      const wanted = inAgent || inSkill || INSTRUCTION_FILE.test(rel) || (kind === 'mcp' && depth === 0);
      if (!wanted) continue;
      if (out.length >= MAX_FILES) { full = true; return; }
      const text = readText(p);
      if (text != null) out.push({ rel, text, kind, abs: p });
      else unread.push(rel);
    }
  };
  walk(dir, 0, false);
  // Scripts a hook runs from the project (node .claude/hooks/x.mjs, ./hook.mjs) are read with the hooks.
  for (const f of out.filter(x => x.kind === 'settings')) {
    for (const h of hookCommands(parseJson(f.text))) {
      for (const m of h.command.matchAll(/(?:^|[\s"'])((?:\$CLAUDE_PROJECT_DIR\/|\.\/)?[\w.\/-]+\.(?:m?js|cjs|ts|py|sh|ps1|cmd|bat))\b/g)) {
        const rel = m[1].replace(/^\$CLAUDE_PROJECT_DIR\/|^\.\//, '');
        const abs = path.join(dir, rel);
        if (path.relative(dir, abs).startsWith('..') || out.some(x => x.abs === abs)) continue;
        if (!fs.existsSync(abs)) continue;
        const text = readText(abs);
        if (text != null) out.push({ rel: path.relative(dir, abs).replace(/\\/g, '/'), text, kind: 'script', abs });
        else unread.push(path.relative(dir, abs).replace(/\\/g, '/'));
      }
    }
  }
  const list = a => a.slice(0, 5).join(', ') + (a.length > 5 ? '…' : '');
  const notes = [];
  if (unread.length) notes.push(unread.length + ' AI agent file' + (unread.length === 1 ? '' : 's') + ' could not be checked (over ' + (MAX_BYTES >> 10) + ' KB, or could not be opened): ' + list(unread) + '. Read ' + (unread.length === 1 ? 'it' : 'them') + ' by hand before you trust ' + (unread.length === 1 ? 'it' : 'them') + '.');
  if (links.length) notes.push(links.length + ' AI agent file' + (links.length === 1 ? ' or folder is a link' : 's or folders are links') + ' to somewhere else, not followed: ' + list(links) + '. Check what ' + (links.length === 1 ? 'it points' : 'they point') + ' to.');
  if (full) notes.push('The AI agent files check stopped at ' + MAX_FILES + ' files; the rest were not read.');
  return { files: out, notes, skillDirs: [...skillDirs].map(s => path.relative(dir, s).replace(/\\/g, '/')) };
}

function agentAudit(dir, skipList = []) {
  const skip = new Set(skipList.map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()));
  const { files, notes, skillDirs } = agentFiles(dir, skip);
  const units = new Map();
  for (const f of files) {
    const skill = skillDirs.filter(s => s && (f.rel === s || f.rel.startsWith(s + '/'))).sort((a, b) => b.length - a.length)[0];
    const k = skill || (skillDirs.includes('') ? '' : '*');
    if (!units.has(k)) units.set(k, []);
    units.get(k).push(f);
  }
  const findings = [];
  for (const unit of units.values()) { const u = unitFindings(unit); findings.push(...u.findings); notes.push(...u.notes); }
  return { findings, notes, filesRead: files.length };
}

// ---- a skill before it is installed ----
// input: { path } (a skill or plugin folder, a .zip / .skill file, or one .md file) or { text, name } (pasted).
const MAX_UNPACK = 50 * 1024 * 1024;
function skillFromZip(buf) {
  const files = [], notes = [];
  let total = 0;
  const entries = readZip(buf, MAX_FILES + 1);
  if (entries.length > MAX_FILES) notes.push('The zip lists more than ' + MAX_FILES + ' files; only the first ' + MAX_FILES + ' were read.');
  for (const e of entries.slice(0, MAX_FILES)) {
    const rel = e.name.replace(/\\/g, '/').replace(/^\/+/, '');
    const kind = kindOf(rel);
    if (!kind) continue;
    if (e.encrypted) { notes.push(rel + ' is locked with a password, so it was not read.'); continue; }
    if (e.size > MAX_BYTES || total + e.size > MAX_UNPACK) { notes.push(rel + ' is too big to read here (' + Math.round(e.size / 1024) + ' KB); check it by hand.'); continue; }
    let text = null;
    try { text = decodeText(e.read(MAX_BYTES)); } catch (err) { notes.push(rel + ' could not be unpacked (' + err.message + ').'); continue; }
    total += e.size;
    if (text != null) files.push({ rel, text, kind });
  }
  return { files, notes };
}
function skillFromFolder(dir) {
  const files = [], notes = [];
  let seen = 0;
  const walk = (d, depth) => {
    if (files.length >= MAX_FILES || depth > 10) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      // Links are not followed (they can point anywhere on this PC); each one is named so the person can look.
      if (e.isSymbolicLink()) { notes.push(rel + ' is a link to somewhere else, so it was not read. Check what it points to before you install this.'); continue; }
      if (e.isDirectory()) { if (!['node_modules', '.git', '__pycache__'].includes(e.name)) walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      seen++;
      const kind = kindOf(rel);
      if (!kind) continue;
      const text = readText(p);
      if (text == null) { notes.push(rel + ' could not be read as text (too big or not text); check it by hand.'); continue; }
      files.push({ rel, text, kind });
    }
  };
  walk(dir, 0);
  if (files.length >= MAX_FILES) notes.push('Only the first ' + MAX_FILES + ' files were read.');
  return { files, notes, seen };
}

function checkSkill(input = {}) {
  let got;
  if (typeof input.text === 'string') {
    const name = String(input.name || 'SKILL.md').replace(/[\\/]/g, '_');
    got = { files: [{ rel: name, text: input.text, kind: kindOf(name) || 'doc' }], notes: ['Only the text you pasted was checked. A skill is often a folder with scripts as well: check the whole folder or zip for those.'] };
  } else if (typeof input.path === 'string' && input.path) {
    const p = path.resolve(input.path);
    let st; try { st = fs.statSync(p); } catch { return { error: 'Nothing was found at that path.' }; }
    if (st.isDirectory()) got = skillFromFolder(p);
    else if (/\.(zip|skill|plugin)$/i.test(p)) {
      // A zip is read whole into memory, so a big file picked by mistake is refused first, not read.
      if (st.size > MAX_UNPACK) return { error: 'That file is ' + Math.round(st.size / 1048576) + ' MB: too big for a skill (the check reads up to ' + (MAX_UNPACK >> 20) + ' MB). Unzip it and check the folder instead.' };
      try { got = skillFromZip(fs.readFileSync(p)); } catch (e) { return { error: 'That file could not be read as a zip (' + e.message + ').' }; }
    } else {
      const text = readText(p);
      if (text == null) return { error: 'That file is too big or is not text.' };
      got = { files: [{ rel: path.basename(p), text, kind: kindOf(path.basename(p)) || 'doc' }], notes: [] };
    }
  } else return { error: 'Give a folder, a zip, or the text of a skill.' };
  if (!got.files.length) return { error: 'No skill files were found there (SKILL.md, scripts, settings or hooks).' };
  const { findings, does, notes: unitNotes } = unitFindings(got.files);
  const ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
  findings.sort((a, b) => ORDER[a.sev] - ORDER[b.sev]);
  const count = s => findings.filter(f => f.sev === s).length;
  const counts = { Critical: count('Critical'), High: count('High'), Medium: count('Medium') };
  const runsCode = does.runs.length > 0 || does.hooks.length > 0;
  const verdict = counts.Critical + counts.High ? 'do-not-install' : counts.Medium ? 'read-first' : 'no-known-attack';
  const notes = [...got.notes, ...unitNotes];
  if (verdict === 'no-known-attack' && runsCode) notes.push('No known attack was found, but this skill runs code. No scan can prove code is safe: read what it runs (listed above) before you install it, or install only skills from makers you trust.');
  return {
    verdict,
    headline: verdict === 'do-not-install' ? 'Do not install' : verdict === 'read-first' ? 'Read these first' : 'No known attack found',
    counts, findings, does, notes,
    filesRead: got.files.map(f => f.rel),
    rules: Object.keys(RULE).length,
  };
}

module.exports = { agentAudit, checkSkill, RULE, proseOf, hiddenParts, tagSmuggled };
