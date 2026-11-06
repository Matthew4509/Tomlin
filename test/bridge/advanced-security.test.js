'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runAudit } = require('../../src/bridge/audit');
const runPart = async (_p, d) => { const a = await runAudit(d.dir, null, { skip: d.skip }); return { findings: a.findings, notes: a.notes }; };
const BASE = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bridge-advanced-'));
// Fixture parent is dedicated to this test; use unique directories and leave them for review.
fs.mkdirSync(BASE, { recursive: true });
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(BASE, 'case-'));
  for (const [name, text] of Object.entries(files)) { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  return dir;
}
const pairs = [
  ['AZ-001', 'api/promote.js', 'account.role =\n req.body.role;', 'account.role = checkedRole(req.body.role);'],
  ['AZ-001', 'api/promote.php', "<?php $_SESSION['is_admin'] = $_POST['is_admin'];", "<?php $_SESSION['is_admin'] = false;"],
  ['AZ-002', 'api/signup.js', 'await User.create(\nreq.body\n);', 'await User.create({name: req.body.name, role: "member"});'],
  ['AZ-003', 'api/auth.js', 'req.user = jwt.decode(token);', 'req.user = jwt.verify(token, serverKey);'],
  ['AZ-004', 'api/admin.js', 'if (user && user.role !== "admin") return deny();', 'if (!user || user.role !== "admin") return deny();'],
  ['DBSEC-001', 'migrations/access.sql', 'ALTER TABLE accounts\nDISABLE ROW LEVEL SECURITY;', 'ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;'],
  ['DBSEC-002', 'migrations/access.sql', 'CREATE POLICY open_write ON accounts FOR ALL TO anon USING (true) WITH CHECK (true);', 'CREATE POLICY owner_write ON accounts FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());'],
];
for (const [id, file, bad, good] of pairs) {
  test(id + ' catches ' + file + ' and keeps guarded counterpart quiet', async () => {
    const a = await runPart('code', {dir:fixture({[file]:bad}),skip:[]});
    const b = await runPart('code', {dir:fixture({[file]:good}),skip:[]});
    assert.ok(a.findings.some(f=>f.rule===id), 'missed '+id);
    assert.equal(a.findings.find(f=>f.rule===id).confidence, 'review-required');
    assert.ok(!b.findings.some(f=>f.rule===id), 'false positive '+id);
  });
}
test('comments and a quoted example cannot act as executable authorization statements', async () => {
 const code='// account.role = req.body.role;\n/* req.user = jwt.decode(token); */\nconst docs = "account.role = req.body.role;";';
 const r=await runPart('code',{dir:fixture({'api/doc.js':code}),skip:[]});
 assert.equal(r.findings.filter(f=>/^(AZ|DBSEC)-/.test(f.rule)).length,0);
});
test('a guard in another function does not silence a direct privilege assignment', async () => {
 const r=await runPart('code',{dir:fixture({'api/role.js':'function safe(req) { return checkedRole(req.body.role); }\nfunction unsafe(req, account) { account.role = req.body.role; }'}),skip:[]});
 assert.ok(r.findings.some(f=>f.rule==='AZ-001'));
});
test('public read policies are not described as unrestricted writes',async()=>{
 const r=await runPart('code',{dir:fixture({'schema.sql':'CREATE POLICY public_read ON articles FOR SELECT TO anon USING (true);'}),skip:[]});
 assert.ok(!r.findings.some(f=>f.rule==='DBSEC-002'));
});

test('individual request properties are not whole-object mass assignment', async()=>{
 const r=await runPart('code',{dir:fixture({'api/signup.js':'User.create(req.body.name);\nUser.create(req.body.profile);\nUser.create(req.body["name"]);'}),skip:[]});
 assert.ok(!r.findings.some(f=>f.rule==='AZ-002'));
});

test('a UI condition and mismatched identities are not an admin rejection',async()=>{
 const r=await runPart('code',{dir:fixture({'api/admin.js':'if (user && user.role !== "admin") showMenu();\nif (user && req.user.role !== "admin") return deny();'}),skip:[]});
 assert.ok(!r.findings.some(f=>f.rule==='AZ-004'));
});

test('SQL comments and quoted documentation do not disable RLS',async()=>{
 const r=await runPart('code',{dir:fixture({'schema.sql':"-- ALTER TABLE users DISABLE ROW LEVEL SECURITY;\nSELECT 'ALTER TABLE users DISABLE ROW LEVEL SECURITY;';"}),skip:[]});
 assert.ok(!r.findings.some(f=>f.rule==='DBSEC-001'));
});

test('a large comment does not hide active code or cause an unbounded scan',async()=>{
 const start=Date.now();
 const r=await runPart('code',{dir:fixture({'api/bulk.js':'/*'+ ' role '.repeat(24000)+'*/\naccount.role = req.body.role;'}),skip:[]});
 assert.ok(r.findings.some(f=>f.rule==='AZ-001'));
 assert.ok(Date.now()-start<15000,'bounded fixture scan exceeded 15 seconds');
});

test('removed modern service key in a committed env file is reported without disclosure',async()=>{
 const value='sb_secret_'+'FixtureOnlyInvalid0123456789Abcdef';
 const dir=fixture({'.env':'SUPABASE_SERVICE_ROLE_KEY='+value});
 const git=args=>execFileSync('git',['-C',dir,...args],{windowsHide:true,stdio:'pipe'});
 git(['init','-q']);git(['add','-f','.env']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']);
 fs.writeFileSync(path.join(dir,'.env'),'SUPABASE_SERVICE_ROLE_KEY=');
 git(['add','-f','.env']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','remove fixture']);
 const r=await runAudit(dir,null,{root:false,disclosure:true,context:{details:[],others:[],own:[]}});
 assert.ok(r.findings.some(f=>f.rule==='SEC-012'&&/service.role/i.test(f.title)));
 assert.ok(!JSON.stringify(r).includes(value));
});
test('removed privileged JWT is found in git history without retaining the credential in results',async()=>{
 const b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const value=[b64({alg:'HS256',typ:'JWT'}),b64({iss:'supabase',role:'service_role'}),'madeUpSignatureNotARealOne_0123456789'].join('.');
 const dir=fixture({'client.js':'const credential = "'+value+'";'});
 const git=args=>execFileSync('git',['-C',dir,...args],{windowsHide:true,stdio:'pipe'});
 git(['init','-q']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']);
 fs.writeFileSync(path.join(dir,'client.js'),'const credential = process.env.SERVER_KEY;');
 git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','remove fixture credential']);
 const r=await runAudit(dir,null,{root:false,disclosure:true,context:{details:[],others:[],own:[]}});
 assert.ok(r.findings.some(f=>f.rule==='SEC-012'&&/service.role/i.test(f.title)),'removed service key not found');
 assert.ok(!JSON.stringify(r).includes(value),'credential leaked into report');
});
