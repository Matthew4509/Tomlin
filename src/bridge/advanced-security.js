// Bounded, offline authorization/configuration heuristics. These report review candidates,
// not proven exploitable access paths. No requests, credential validation or code execution.
'use strict';
const cache = new WeakMap();

// Preserve offsets and line numbers while distinguishing comments/quoted examples from code.
// This is a lightweight lexer, not a language parser or interprocedural dataflow engine.
function views(text, dialect = 'js') {
  const shown = text.split(''), code = text.split('');
  const blank = (a, from, to) => { for (let k = from; k < to; k++) if (a[k] !== '\n' && a[k] !== '\r') a[k] = ' '; };
  for (let i = 0; i < text.length;) {
    if (text.startsWith('//', i) || (dialect === 'sql' && text.startsWith('--', i)) || (dialect === 'php' && text[i] === '#')) {
      const end = text.indexOf('\n', i); const j = end < 0 ? text.length : end;
      blank(shown, i, j); blank(code, i, j); i = j; continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2); const j = end < 0 ? text.length : end + 2;
      blank(shown, i, j); blank(code, i, j); i = j; continue;
    }
    if ('\'"`'.includes(text[i])) {
      const start = i, q = text[i++];
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === q) { if (text[i] === q && q !== '`') { i++; continue; } break; }
      }
      blank(code, start, Math.min(i, text.length)); continue;
    }
    i++;
  }
  return { shown: shown.join(''), code: code.join('') };
}
function lineMatches(ctx, regex) {
  let memo = cache.get(ctx);
  if (!memo) { const dialect = /\.sql$/i.test(ctx.rel) ? 'sql' : /\.php$/i.test(ctx.rel) ? 'php' : 'js'; memo = { ...views(ctx.text, dialect), hits: new Map() }; cache.set(ctx, memo); }
  const key = regex.source;
  if (!memo.hits.has(key)) {
    const hits = new Set();
    let previous = 0, line = 0;
    for (const m of memo.shown.matchAll(regex)) {
      for (; previous < m.index; previous++) if (memo.shown[previous] === '\n') line++;
      if (/\S/.test(memo.code[m.index] || '')) hits.add(line);
    }
    memo.hits.set(key, hits);
  }
  return memo.hits.get(key);
}
const source = String.raw`(?:\b(?:req|request)\s*\.\s*(?:body|query)\b|\$_(?:POST|GET|REQUEST)\s*\[)`;
const field = String.raw`(?:role|is_admin|isAdmin|permissions|admin)`;
const patterns = {
  direct: new RegExp(String.raw`(?:\b\w+\s*\.\s*${field}\s*=\s*|\b${field}\s*:\s*|\$_SESSION\s*\[\s*['"]${field}['"]\s*\]\s*=\s*)${source}`, 'g'),
  mass: /\b(?:User|Users|Account|Accounts|user|users|account|accounts)\s*(?:\.|->)\s*(?:create|update|fill|updateOne|findByIdAndUpdate)\s*\(\s*(?:(?:req|request)\s*\.\s*(?:body|query)|\$_(?:POST|GET|REQUEST))\s*(?=[,)])/g,
  jwt: /\b(?:req|request)\s*\.\s*(?:user|auth)\s*=\s*(?:jwt\s*\.\s*decode|jwtDecode|decodeJwt)\s*\(/g,
  absent: /\bif\s*\(\s*(user|req\.user|session\.user)\s*&&\s*\1\.role\s*!==?\s*['"]admin['"]\s*\)\s*\{?\s*(?:throw\b|return\s+(?:deny|forbidden)\s*\(|return\s+(?:res|response)\.status\(\s*403\s*\))/g,
  rls: /\bALTER\s+TABLE\s+[\w."\s]{1,180}?\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY\b/gi,
  policy: /\bCREATE\s+POLICY\s+[^;]{1,220}?\bFOR\s+(?:ALL|INSERT|UPDATE)\s+TO\s+"?(?:anon|public|authenticated)"?(?![\w"])[^;]{0,220}?\bWITH\s+CHECK\s*\(\s*true\s*\)/gi,
};
function rule(id, title, re, pattern, fix, file) {
  return { id, sev: 'High', confidence: 'review-required', area: 'authorization', title, re, ...(file ? {file} : {}),
    test: (_line, ctx, _lines, i) => lineMatches(ctx, pattern).has(i), fix };
}
const SERVER = /\.(?:php|m?js|cjs|ts|tsx)$/i;
const ADVANCED_RULES = [
  rule('AZ-001', 'Request data is assigned directly to a privilege field: review who may grant it', /role|admin|permissions/, patterns.direct,
    'Derive privileges on the server from an explicit authorization decision; allow-list editable fields and test ordinary-user requests against admin changes.', SERVER),
  rule('AZ-002', 'An account write receives a whole request object: review privilege-field mass assignment', /User|user|Account|account/, patterns.mass,
    'Build an explicit input object with server-owned role/admin fields. Verify ordinary users cannot add privilege fields, including through nested data.', SERVER),
  rule('AZ-003', 'Decoded JWT is assigned as request identity: verify signature and claim validation', /req|request/, patterns.jwt,
    'Use a trusted verification path with algorithm, issuer, audience and expiry checks before using claims for authorization. Decoding alone does not verify a token.', SERVER),
  rule('AZ-004', 'Admin rejection depends on a user existing: review the unauthenticated path', /\bif\b/, patterns.absent,
    'Reject missing identity as well as insufficient role. Verify unauthenticated, ordinary-user and admin requests separately; inspect upstream middleware before concluding exploitability.', SERVER),
  rule('DBSEC-001', 'Row-level security is disabled: review which clients can reach this table', /\bALTER\b/i, patterns.rls,
    'Review table grants and intended access, enable appropriate RLS, and test each role against cross-owner records. A migration statement alone does not prove public reachability.', /\.sql$/i),
  rule('DBSEC-002', 'A write policy has an unconditional row check for a broad role', /\bCREATE\b/i, patterns.policy,
    'Require the intended owner/tenant condition and review USING plus WITH CHECK and other permissive policies. Verify ordinary and anonymous clients cannot write another owner\'s rows.', /\.sql$/i),
];
module.exports = { ADVANCED_RULES, views };
