// Museum: the common faults of apps built quickly, often with an AI helper: admin keys in the browser, secrets behind a
// public prefix, data routes and tables open to anyone, prices taken from the visitor, unsigned payment events, leftover
// debug routes, logged tokens, CORS open with credentials. Each good copy is the honest way to write the same thing, and
// the quiet cases are honest shapes that must never be flagged.
// Key-shaped text is put together when a copy is written, so this file holds no line that looks like a real key.
// Every name and address is made up.
'use strict';

const j = (...parts) => parts.join('');
const part = o => Buffer.from(JSON.stringify(o)).toString('base64url');
// A signed token of the shape Supabase hands out, with a made-up project and signature.
const supabaseToken = role => [part({ alg: 'HS256', typ: 'JWT' }), part({ iss: 'supabase', ref: 'madeupproject', role, iat: 1700000000 }), 'madeUpSignatureNotARealOne_0123456789'].join('.');
const SK_TEST = () => j('sk_', 'test_', 'Q3x9Lm2Vb7Tn4Rk8Wd5Hj6Zp');
const PK_TEST = () => j('pk_', 'test_', 'Q3x9Lm2Vb7Tn4Rk8Wd5Hj6Zp');
const FORM_KEY = () => j('6L', 'q7Xv2Lm9Rt4Kp8Ws3Hn6Jd1Gb5Cz0Fy', 'Q3x9Lm');
const R = (id, rule, title, at, bad, good) => ({ id, bucket: 'R', phase: 'H1', faults: 1, examples: ['ai-built'], rule: '^' + rule + '$', title, at, bad, good });
const X = (id, rule, title, at, bad, good) => ({ id, bucket: 'X', phase: 'H1', faults: 1, examples: ['ai-built'], rule: '^' + rule + '$', title, at, bad, good });
const Q = (id, rule, title, files) => ({ id, quiet: true, phase: 'H1', examples: ['ai-built'], rule, title, files });

const ORDERS_ROUTE = `import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function DELETE(req: Request) {
  const { id } = await req.json();
  await prisma.order.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
`;
const AUTHED_ORDERS_ROUTE = `import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/db';

export async function DELETE(req: Request) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });
  const { id } = await req.json();
  await prisma.order.deleteMany({ where: { id, userId: session.user.id } });
  return NextResponse.json({ ok: true });
}
`;

module.exports = [
  // ---- service-role and admin credentials in front-end code ----
  R('ai-service-role-in-component', 'KEY-001', 'A client component makes a Supabase client with the service-role key',
    'AdminPanel.tsx',
    { 'components/AdminPanel.tsx': `'use client';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
export function AdminPanel() { return null; }
` },
    { 'components/AdminPanel.tsx': `'use client';
import { createBrowserClient } from '@supabase/ssr';

const db = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
export function AdminPanel() { return null; }
` }),
  R('ai-service-role-token-literal', 'KEY-002', 'A service-role token is written into a browser file; the anon token in its place is public by design',
    'src/lib/supabase.js',
    { 'src/lib/supabase.js': () => `import { createClient } from '@supabase/supabase-js';
export const db = createClient('https://madeup.supabase.test', '${supabaseToken('service_role')}');
` },
    { 'src/lib/supabase.js': () => `import { createClient } from '@supabase/supabase-js';
export const db = createClient('https://madeup.supabase.test', '${supabaseToken('anon')}');
` }),
  R('ai-firebase-admin-in-browser', 'KEY-003', 'Browser code imports firebase-admin',
    'src/components/Stats.jsx',
    { 'src/components/Stats.jsx': `import admin from 'firebase-admin';
export function Stats() { return admin.apps.length; }
` },
    { 'src/components/Stats.jsx': `import { getApp } from 'firebase/app';
export function Stats() { return getApp().name; }
` }),
  R('ai-service-account-import', 'KEY-004', 'A service account file is imported by browser code, so its private key ships to every visitor',
    'src/firebase.js',
    { 'src/firebase.js': `import key from './serviceAccountKey.json';
const VITE_NOTE = import.meta.env.VITE_APP_NAME;
export const project = key.project_id + VITE_NOTE;
` },
    { 'src/firebase.js': `import config from './firebase-web-config.json';
const VITE_NOTE = import.meta.env.VITE_APP_NAME;
export const project = config.projectId + VITE_NOTE;
` }),
  R('ai-service-account-served', 'KEY-005', 'A service account key file sits in the public folder',
    'public/firebase-key.json',
    { 'public/firebase-key.json': () => `{
  "type": "service_account",
  "project_id": "madeup-project",
  "private_key": "${'made-up-text-not-a-key-'.repeat(4)}",
  "client_email": "robot@madeup-project.test"
}
` },
    { 'public/firebase-key.json': `{
  "projectId": "madeup-project",
  "appId": "1:2:web:3",
  "authDomain": "madeup-project.test"
}
` }),
  Q('quiet-ai-service-role-on-server', '^(KEY|ENV)-', 'The service-role key used only in server code, and an anon key in the browser',
    { 'lib/server/supabase-admin.ts': `import { createClient } from '@supabase/supabase-js';
export const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
`, 'app/api/stats/route.ts': `import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
export async function GET() { return Response.json(await admin.from('stats').select('*')); }
`, 'supabase/functions/daily/index.ts': `const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const db = createClient(url, key);
`, 'server/db.js': `const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
module.exports = db;
`, 'components/Home.tsx': () => `'use client';
const anon = '${supabaseToken('anon')}';
export function Home() { return anon.length; }
`, '.env.local': `SUPABASE_SERVICE_ROLE_KEY=made-up-server-side-value
NEXT_PUBLIC_SUPABASE_ANON_KEY=made-up-public-value
` }),

  // ---- secrets behind a public prefix ----
  R('ai-public-prefix-secret-env', 'ENV-001', 'A .env file names a secret with a public prefix', '.env.local',
    { '.env.local': `NEXT_PUBLIC_SITE_URL=https://shop.test
NEXT_PUBLIC_STRIPE_SECRET_KEY=made-up-value-not-a-key
` },
    { '.env.local': `NEXT_PUBLIC_SITE_URL=https://shop.test
STRIPE_SECRET_KEY=made-up-value-not-a-key
` }),
  R('ai-public-prefix-key-value', 'ENV-001', 'A .env variable with a neutral name holds a Stripe secret key', '.env',
    { '.env': () => `VITE_PAY_KEY=${SK_TEST()}
` },
    { '.env': () => `VITE_PAY_KEY=${PK_TEST()}
` }),
  R('ai-public-prefix-in-code', 'ENV-002', 'Browser code reads an OpenAI key through VITE_', 'src/api/chat.js',
    { 'src/api/chat.js': `const key = import.meta.env.VITE_OPENAI_API_KEY;
export const ask = q => fetch('https://llm.test/v1', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: q });
` },
    { 'src/api/chat.js': `const base = import.meta.env.VITE_API_URL;
export const ask = q => fetch(base + '/chat', { method: 'POST', body: q });
` }),
  R('ai-vite-define-key', 'ENV-003', 'vite.config copies an API key into the browser code', 'vite.config.ts',
    { 'vite.config.ts': `export default defineConfig(() => ({
  define: {
    'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
  },
}));
` },
    { 'vite.config.ts': `export default defineConfig(() => ({
  define: {
    'process.env.APP_VERSION': JSON.stringify(version),
  },
}));
` }),
  Q('quiet-ai-public-values', '^(KEY|ENV)-', 'Values that are public by design, behind a public prefix',
    { '.env': () => `NEXT_PUBLIC_SITE_URL=https://shop.test
NEXT_PUBLIC_SUPABASE_URL=https://madeup.supabase.test
NEXT_PUBLIC_SUPABASE_ANON_KEY=made-up-public-value
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${PK_TEST()}
VITE_API_URL=https://api.shop.test
VITE_PRIVATE_BETA=true
NEXT_PUBLIC_PASSWORD_MIN_LENGTH=8
NEXT_PUBLIC_SECRET_SANTA_URL=https://santa.test
EXPO_PUBLIC_MAPBOX_TOKEN=made-up-public-value
` , 'src/config.js': `export const api = import.meta.env.VITE_API_URL;
export const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const site = process.env.NEXT_PUBLIC_SITE_URL;
`, '.env.example': `NEXT_PUBLIC_OPENAI_API_KEY=your_key_here
` }),

  // ---- data routes with no session check ----
  X('ai-route-open-delete', 'API-001', 'A Next.js route deletes an order with no session check', 'app/api/orders/route.ts',
    { 'app/api/orders/route.ts': ORDERS_ROUTE }, { 'app/api/orders/route.ts': AUTHED_ORDERS_ROUTE }),
  X('ai-route-open-users-list', 'API-001', 'A pages/api route returns every user; the good copy checks through a helper it imports', 'pages/api/users.ts',
    { 'pages/api/users.ts': `import { prisma } from '../../lib/db';
export default async function handler(req, res) {
  const users = await prisma.user.findMany();
  res.json(users);
}
` },
    { 'pages/api/users.ts': `import { prisma } from '../../lib/db';
import { requireUser } from '../../lib/guards';
export default async function handler(req, res) {
  const me = await requireUser(req, res);
  const users = await prisma.user.findMany({ where: { id: me.id } });
  res.json(users);
}
` }),
  X('ai-route-open-express', 'API-001', 'One Express route is left out of the check the others have', 'server/app.js',
    { 'server/app.js': `const express = require('express');
const app = express();
app.get('/api/me', requireUser, async (req, res) => {
  res.json(await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]));
});
app.get('/api/customers', async (req, res) => {
  const rows = await pool.query('SELECT * FROM customers');
  res.json(rows);
});
` },
    { 'server/app.js': `const express = require('express');
const app = express();
app.get('/api/me', requireUser, async (req, res) => {
  res.json(await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]));
});
app.get('/api/customers', requireUser, async (req, res) => {
  const rows = await pool.query('SELECT * FROM customers');
  res.json(rows);
});
` }),
  X('ai-route-open-read', 'API-002', 'A route returns rows of an unknown table with no session check: Medium, it may be public', 'app/api/widgets/route.ts',
    { 'app/api/widgets/route.ts': `import { prisma } from '@/lib/db';
export async function GET() {
  return Response.json(await prisma.widget.findMany());
}
` },
    { 'app/api/widgets/route.ts': `import { prisma } from '@/lib/db';
import { auth } from '@/auth';
export async function GET() {
  const session = await auth();
  if (!session) return Response.json({ error: 'Please sign in first.' }, { status: 401 });
  return Response.json(await prisma.widget.findMany({ where: { ownerId: session.user.id } }));
}
` }),
  X('ai-route-middleware-skips-api', 'API-001', 'The middleware that checks sessions has a matcher that leaves out /api', 'app/api/orders/route.ts',
    { 'app/api/orders/route.ts': ORDERS_ROUTE, 'middleware.ts': `import { withAuth } from 'next-auth/middleware';
export default withAuth({});
export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
` },
    { 'app/api/orders/route.ts': ORDERS_ROUTE, 'middleware.ts': `import { withAuth } from 'next-auth/middleware';
export default withAuth({});
export const config = { matcher: ['/api/:path*', '/dashboard/:path*'] };
` }),
  X('ai-route-middleware-other-paths', 'API-001', 'The matcher only names other pages, so this route is not covered', 'app/api/orders/route.ts',
    { 'app/api/orders/route.ts': ORDERS_ROUTE, 'middleware.ts': `import { auth } from './auth';
export default auth;
export const config = { matcher: ['/dashboard/:path*'] };
` },
    { 'app/api/orders/route.ts': ORDERS_ROUTE, 'middleware.ts': `import { auth } from './auth';
export default auth;
export const config = { matcher: ['/((?!_next/static|favicon.ico).*)'] };
` }),
  Q('quiet-ai-public-routes', '^(API|DEBUG)-', 'Public read-only routes and a check made through a wrapper',
    { 'app/api/health/route.ts': `import { prisma } from '@/lib/db';
export async function GET() { await prisma.user.count(); return Response.json({ ok: true }); }
`, 'app/api/blog/route.ts': `import { prisma } from '@/lib/db';
export async function GET() { return Response.json(await prisma.post.findMany({ where: { published: true } })); }
`, 'app/api/contact/route.ts': `import { prisma } from '@/lib/db';
export async function POST(req) { await prisma.enquiry.create({ data: await req.json() }); return Response.json({ ok: true }); }
`, 'app/api/notes/route.ts': `import { withAuth } from '@/lib/with-auth';
import { prisma } from '@/lib/db';
export const GET = withAuth(async user => Response.json(await prisma.note.findMany({ where: { userId: user.id } })));
`, 'app/api/mine/route.ts': `import { createClient } from '@/lib/supabase/server';
export async function GET() {
  const supabase = await createClient();
  return Response.json(await supabase.from('notes').select('*'));
}
`, 'app/api/test/route.ts': `export async function GET() { return Response.json({ hello: 'world' }); }
` }),

  // ---- Supabase tables without row-level security ----
  X('ai-table-no-rls', 'RLS-001', 'A Supabase migration creates a table and never enables row-level security', 'supabase/migrations/001_init.sql',
    { 'supabase/migrations/001_init.sql': `create table public.notes (id uuid primary key, user_id uuid, body text);
` },
    { 'supabase/migrations/001_init.sql': `create table public.notes (id uuid primary key, user_id uuid, body text);
`, 'supabase/migrations/002_lock.sql': `alter table public.notes enable row level security;
create policy "own notes" on public.notes for all using (auth.uid() = user_id);
` }),
  X('ai-table-no-rls-one-of-two', 'RLS-001', 'Row-level security on one table does not cover the other', 'supabase/migrations/001_init.sql',
    { 'supabase/migrations/001_init.sql': `-- enable row level security on everything later
create table notes (id uuid primary key);
create table payments (id uuid primary key);
alter table notes enable row level security;
` },
    { 'supabase/migrations/001_init.sql': `create table notes (id uuid primary key);
create table payments (id uuid primary key);
alter table notes enable row level security;
alter table payments enable row level security;
` }),

  // ---- payment amounts from the request, webhooks with no signature ----
  R('ai-pay-amount-from-body', 'PAY-006', 'A payment intent takes its amount from the request', 'api/pay.js',
    { 'api/pay.js': `export default async function pay(req, res) {
  const intent = await stripe.paymentIntents.create({
    amount: req.body.amount,
    currency: 'usd',
  });
  res.json({ secret: intent.client_secret });
}
` },
    { 'api/pay.js': `export default async function pay(req, res) {
  const item = await findItem(req.body.itemId);
  const intent = await stripe.paymentIntents.create({
    amount: item.priceCents,
    currency: 'usd',
  });
  res.json({ secret: intent.client_secret });
}
` }),
  R('ai-pay-unit-amount-from-json', 'PAY-006', 'A checkout session takes unit_amount from the posted JSON; the good copy looks it up by id', 'app/api/checkout/route.ts',
    { 'app/api/checkout/route.ts': `export async function POST(req) {
  const body = await req.json();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: 'usd', product_data: { name: body.name }, unit_amount: body.price } }],
  });
  return Response.json({ url: session.url });
}
` },
    { 'app/api/checkout/route.ts': `export async function POST(req) {
  const { itemId } = await req.json();
  const item = await findItem(itemId);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: 'usd', product_data: { name: item.name }, unit_amount: item.price } }],
  });
  return Response.json({ url: session.url });
}
` }),
  R('ai-pay-cart-prices-from-client', 'PAY-006', 'The cart comes from the browser with its prices, and those prices are charged', 'app/api/cart/route.ts',
    { 'app/api/cart/route.ts': `export async function POST(req) {
  const { items } = await req.json();
  const session = await stripe.checkout.sessions.create({
    line_items: items.map(item => ({
      quantity: item.qty,
      price_data: { currency: 'usd', unit_amount: item.price },
    })),
  });
  return Response.json({ url: session.url });
}
` },
    { 'app/api/cart/route.ts': `export async function POST(req) {
  const { items } = await req.json();
  const session = await stripe.checkout.sessions.create({
    line_items: items.map(item => ({
      quantity: item.qty,
      price_data: { currency: 'usd', unit_amount: PRICE_LIST[item.id] },
    })),
  });
  return Response.json({ url: session.url });
}
` }),
  X('ai-webhook-no-signature', 'PAY-007', 'A Stripe webhook acts on the posted event with no signature check; the good copy checks in a helper', 'app/api/stripe/webhook/route.ts',
    { 'app/api/stripe/webhook/route.ts': `export async function POST(req) {
  const event = await req.json();
  if (event.type === 'checkout.session.completed') await fulfil(event.data.object);
  return Response.json({ received: true });
}
` },
    { 'app/api/stripe/webhook/route.ts': `import { readSignedEvent } from '@/lib/pay-events';
export async function POST(req) {
  const event = await readSignedEvent(req);
  if (event.type === 'checkout.session.completed') await fulfil(event.data.object);
  return Response.json({ received: true });
}
`, 'lib/pay-events.ts': `export async function readSignedEvent(req) {
  const raw = await req.text();
  return stripe.webhooks.constructEvent(raw, req.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
}
` }),
  X('ai-webhook-no-signature-lemon', 'PAY-007', 'A Lemon Squeezy webhook in an Express server, with no signature check', 'server/index.js',
    { 'server/index.js': `const express = require('express');
const app = express();
app.post('/webhooks/lemonsqueezy', express.json(), async (req, res) => {
  if (req.body.meta.event_name === 'order_created') await grant(req.body.data);
  res.sendStatus(200);
});
` },
    { 'server/index.js': `const express = require('express');
const crypto = require('crypto');
const app = express();
app.post('/webhooks/lemonsqueezy', express.raw({ type: '*/*' }), async (req, res) => {
  const mine = crypto.createHmac('sha256', process.env.LEMON_SECRET).update(req.body).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(req.get('x-signature') || ''))) return res.sendStatus(400);
  await grant(JSON.parse(req.body).data);
  res.sendStatus(200);
});
` }),

  // ---- leftovers: debug routes, logged tokens, open CORS ----
  X('ai-debug-seed-route', 'DEBUG-002', 'A seed route can be called by anyone in production', 'app/api/seed/route.ts',
    { 'app/api/seed/route.ts': `import { prisma } from '@/lib/db';
export async function GET() {
  await prisma.user.deleteMany();
  await prisma.user.create({ data: { email: 'admin@shop.test', role: 'admin' } });
  return Response.json({ seeded: true });
}
` },
    { 'app/api/seed/route.ts': `import { prisma } from '@/lib/db';
export async function GET() {
  if (process.env.NODE_ENV === 'production') return new Response('Not found', { status: 404 });
  await prisma.user.deleteMany();
  await prisma.user.create({ data: { email: 'admin@shop.test', role: 'admin' } });
  return Response.json({ seeded: true });
}
` }),
  X('ai-debug-env-dump', 'DEBUG-002', 'A debug route answers with the server\'s settings', 'pages/api/debug.js',
    { 'pages/api/debug.js': `export default function handler(req, res) {
  res.json({ env: process.env });
}
` },
    { 'pages/api/debug.js': `import { getServerSession } from 'next-auth';
export default async function handler(req, res) {
  const session = await getServerSession(req, res);
  if (!session) return res.status(401).end();
  res.json({ env: process.env });
}
` }),
  X('ai-admin-reset-route', 'DEBUG-002', 'An Express /admin/reset route with no check', 'server/admin.js',
    { 'server/admin.js': `const express = require('express');
const app = express();
app.post('/admin/reset', async (req, res) => {
  await resetAll();
  res.json({ ok: true });
});
` },
    { 'server/admin.js': `const express = require('express');
const app = express();
app.post('/admin/reset', requireAdmin, async (req, res) => {
  await resetAll();
  res.json({ ok: true });
});
` }),
  R('ai-token-logged', 'LOG-001', 'A sign-in token is written to the log', 'lib/refresh.js',
    { 'lib/refresh.js': `export async function refresh(user) {
  const accessToken = await renew(user);
  console.log('new token', accessToken);
  return accessToken;
}
` },
    { 'lib/refresh.js': `export async function refresh(user) {
  const accessToken = await renew(user);
  console.log('token refreshed');
  return accessToken;
}
` }),
  R('ai-password-logged', 'LOG-001', 'A typed password is written to the log', 'routes/login.js',
    { 'routes/login.js': 'export function login(req, res) {\n  const { email, password } = req.body;\n  console.log(`login ${email} ${password}`);\n  res.end();\n}\n' },
    { 'routes/login.js': 'export function login(req, res) {\n  const { email, password } = req.body;\n  console.log(`login ${email} ${password.length}`);\n  res.end();\n}\n' }),
  R('ai-cors-open-credentials', 'CORS-003', 'cors() answers every site with credentials on', 'server/main.js',
    { 'server/main.js': `const cors = require('cors');
app.use(cors({
  origin: true,
  credentials: true,
}));
` },
    { 'server/main.js': `const cors = require('cors');
app.use(cors({
  origin: 'https://app.test',
  credentials: true,
}));
` }),
  R('ai-cors-star-fastapi', 'CORS-003', 'FastAPI CORS middleware with every origin and credentials on', 'main.py',
    { 'main.py': `from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
)
` },
    { 'main.py': `from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://app.test"],
    allow_credentials=True,
)
` }),
  R('ai-cors-star-in-a-list', 'CORS-003', 'FastAPI CORS reads its origins from a list that holds "*"', 'api.py',
    { 'api.py': `from fastapi.middleware.cors import CORSMiddleware
origins = ["*"]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True)
` },
    { 'api.py': `from fastapi.middleware.cors import CORSMiddleware
origins = ["https://app.test"]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True)
` }),
  R('ai-cors-callback-says-yes', 'CORS-003', 'A CORS origin function that says yes to every site', 'server/cors.js',
    { 'server/cors.js': `const cors = require('cors');
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
` },
    { 'server/cors.js': `const cors = require('cors');
app.use(cors({ origin: (origin, cb) => cb(null, ALLOWED.includes(origin)), credentials: true }));
` }),
  R('ai-cors-falls-back-to-star', 'CORS-003', 'CORS falls back to every site when a setting is missing', 'server/env-cors.js',
    { 'server/env-cors.js': `const cors = require('cors');
app.use(cors({ origin: process.env.CLIENT_URL || '*', credentials: true }));
` },
    { 'server/env-cors.js': `const cors = require('cors');
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
` }),
  R('ai-cors-nest', 'CORS-003', 'NestJS enableCors open to every site with credentials on', 'src/main.ts',
    { 'src/main.ts': `const app = await NestFactory.create(AppModule);
app.enableCors({ origin: true, credentials: true });
` },
    { 'src/main.ts': `const app = await NestFactory.create(AppModule);
app.enableCors({ origin: 'https://app.test', credentials: true });
` }),

  // ---- a second walk: shapes the first rules missed ----
  X('ai-route-session-setup-is-no-check', 'API-001', 'Setting up sessions checks nobody: the route after it is still open', 'server/shop.js',
    { 'server/shop.js': `const express = require('express');
const session = require('express-session');
const app = express();
app.use(session({ secret: process.env.SESSION_KEY }));
app.get('/api/customers', async (req, res) => res.json(await Customer.find({})));
` },
    { 'server/shop.js': `const express = require('express');
const session = require('express-session');
const app = express();
app.use(session({ secret: process.env.SESSION_KEY }));
app.get('/api/customers', requireUser, async (req, res) => res.json(await Customer.find({})));
` }),
  X('ai-route-auth-router-is-no-check', 'API-001', 'Mounting a router named for sign-in checks nobody', 'server/mounts.js',
    { 'server/mounts.js': `const express = require('express');
const app = express();
app.use(authRoutes);
app.get('/api/customers', async (req, res) => res.json(await Customer.find({})));
` },
    { 'server/mounts.js': `const express = require('express');
const app = express();
app.use(authRoutes);
app.get('/api/customers', requireUser, async (req, res) => res.json(await Customer.find({})));
` }),
  X('ai-server-action-open', 'API-001', 'A server action deletes an order with no check; anyone can call a server action', 'app/orders/actions.ts',
    { 'app/orders/actions.ts': `'use server';
import { prisma } from '@/lib/db';
export async function deleteOrder(id) {
  await prisma.order.delete({ where: { id } });
}
` },
    { 'app/orders/actions.ts': `'use server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
export async function deleteOrder(id) {
  const session = await auth();
  if (!session) throw new Error('Please sign in first.');
  await prisma.order.deleteMany({ where: { id, userId: session.user.id } });
}
` }),
  Q('quiet-ai-sign-ups', '^API-', 'A sign-up by REST and by server action, a router under a public mount, a quiz app\'s exam route',
    { 'app/api/users/route.ts': `import bcrypt from 'bcryptjs';
export async function POST(req) {
  const { email, password } = await req.json();
  const hash = await bcrypt.hash(password, 10);
  await prisma.user.create({ data: { email, hash } });
  return Response.json({ ok: true });
}
`, 'app/actions.ts': `'use server';
export async function signUp(formData) {
  await prisma.user.create({ data: { email: formData.get('email') } });
}
`, 'routes/hooks-in.js': `const router = require('express').Router();
router.post('/', async (req, res) => {
  await Order.updateOne({ id: req.body.id }, { paid: true });
  res.end();
});
module.exports = router;
`, 'server.js': `const express = require('express');
const app = express();
const incoming = require('./routes/hooks-in');
app.use('/api/webhooks', incoming);
` }),
  Q('quiet-ai-test-with-an-id', '^DEBUG-', 'An exam route of a quiz app is not a leftover test route',
    { 'app/api/test/[id]/route.ts': `export async function GET() { return Response.json(await prisma.exam.findMany()); }
` }),
  R('ai-pay-one-line', 'PAY-006', 'The amount and the payment on one line', 'api/fast-pay.js',
    { 'api/fast-pay.js': `const { amount } = await req.json(); const intent = await stripe.paymentIntents.create({ amount, currency: 'usd' });
` },
    { 'api/fast-pay.js': `const { itemId } = await req.json(); const intent = await stripe.paymentIntents.create({ amount: priceOf(itemId), currency: 'usd' });
` }),
  R('ai-pay-through-zod', 'PAY-006', 'A schema checks the amount, but the visitor still chooses it', 'api/zod-pay.js',
    { 'api/zod-pay.js': `const { amount } = schema.parse(await req.json());
await stripe.paymentIntents.create({ amount, currency: 'usd' });
` },
    { 'api/zod-pay.js': `const { itemId } = schema.parse(await req.json());
const amount = priceOf(itemId);
await stripe.paymentIntents.create({ amount, currency: 'usd' });
` }),
  R('ai-pay-form-action', 'PAY-006', 'A server action charges the amount from the form', 'lib/buy-action.js',
    { 'lib/buy-action.js': `export async function buy(formData) {
  const amount = Number(formData.get('amount'));
  await stripe.paymentIntents.create({ amount, currency: 'usd' });
}
` },
    { 'lib/buy-action.js': `export async function buy(formData) {
  const amount = priceOf(String(formData.get('id')));
  await stripe.paymentIntents.create({ amount, currency: 'usd' });
}
` }),
  R('ai-pay-fastapi', 'PAY-006', 'A FastAPI body\'s amount goes to Stripe', 'pay_api.py',
    { 'pay_api.py': `@app.post('/pay')
def pay(body: CheckoutIn):
    return stripe.PaymentIntent.create(amount=body.amount, currency='usd')
` },
    { 'pay_api.py': `@app.post('/pay')
def pay(body: CheckoutIn):
    item = ITEMS[body.item_id]
    return stripe.PaymentIntent.create(amount=item.price, currency='usd')
` }),
  R('ai-pay-flask', 'PAY-006', 'A Flask JSON amount goes to Stripe', 'pay_flask.py',
    { 'pay_flask.py': `data = request.get_json()
amount = data['amount']
intent = stripe.PaymentIntent.create(amount=amount, currency='usd')
` },
    { 'pay_flask.py': `data = request.get_json()
amount = PRICES[data['item']]
intent = stripe.PaymentIntent.create(amount=amount, currency='usd')
` }),
  R('ai-public-prefix-sveltekit', 'ENV-001', 'SvelteKit and Astro publish anything named PUBLIC_', '.env.production',
    { '.env.production': `PUBLIC_SITE_URL=https://shop.test
PUBLIC_OPENAI_API_KEY=made-up-value-not-a-key
` },
    { '.env.production': `PUBLIC_SITE_URL=https://shop.test
OPENAI_API_KEY=made-up-value-not-a-key
` }),
  R('ai-env-static-public', 'ENV-002', 'A key imported from SvelteKit\'s public settings', 'src/lib/llm.ts',
    { 'src/lib/llm.ts': `import { PUBLIC_OPENAI_API_KEY } from '$env/static/public';
export const key = PUBLIC_OPENAI_API_KEY;
` },
    { 'src/lib/llm.ts': `import { PUBLIC_SITE_URL } from '$env/static/public';
export const site = PUBLIC_SITE_URL;
` }),
  R('ai-next-config-env', 'ENV-003', 'next.config copies a key into the browser code through env', 'next.config.js',
    { 'next.config.js': `module.exports = {
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  },
};
` },
    { 'next.config.js': `module.exports = {
  env: {
    SITE_URL: process.env.SITE_URL,
  },
};
` }),
  R('ai-vite-define-whole-env', 'ENV-003', 'vite define puts every setting in the browser code', 'vite.config.js',
    { 'vite.config.js': `export default defineConfig({
  define: { 'process.env': process.env },
});
` },
    { 'vite.config.js': `export default defineConfig({
  define: { 'process.env': {} },
});
` }),
  R('ai-nuxt-public-secret', 'ENV-003', 'nuxt runtimeConfig.public holds a secret key', 'nuxt.config.ts',
    { 'nuxt.config.ts': `export default defineNuxtConfig({
  runtimeConfig: {
    public: {
      stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    },
  },
});
` },
    { 'nuxt.config.ts': `export default defineNuxtConfig({
  runtimeConfig: {
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    public: {
      siteUrl: process.env.SITE_URL,
    },
  },
});
` }),
  R('ai-astro-script-not-frontmatter', 'KEY-001', 'In an Astro page only a script block reaches the browser', 'src/pages/report.astro',
    { 'src/pages/report.astro': `---
const title = 'Report';
---
<script>
const db = createClient(url, serviceRoleKey);
</script>
` },
    { 'src/pages/report.astro': `---
const db = createClient(url, import.meta.env.SUPABASE_SERVICE_ROLE_KEY);
const rows = await db.from('rows').select('*');
---
<p>{rows.length}</p>
` }),
  R('ai-component-client-or-server', 'KEY-001', 'With an app/ router a component is browser code only if a client file imports it', 'components/Stats.tsx',
    { 'app/layout.tsx': `export default function Layout({ children }) { return children; }
`, 'components/Stats.tsx': `export async function Stats() {
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return db.name;
}
`, 'components/Panel.tsx': `'use client';
import { Stats } from './Stats';
export const Panel = () => <Stats />;
` },
    { 'app/layout.tsx': `export default function Layout({ children }) { return children; }
`, 'components/Stats.tsx': `export async function Stats() {
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return db.name;
}
`, 'app/page.tsx': `import { Stats } from '../components/Stats';
export default function Page() { return <Stats />; }
` }),
  R('ai-key-by-usual-ending-env', 'ENV-004', 'A service key known only by its usual ending, with a public prefix', '.env.staging',
    { '.env.staging': `VITE_RAPIDAPI_KEY=made-up-value-not-a-key
` },
    { '.env.staging': `VITE_FIREBASE_API_KEY=made-up-public-value
VITE_MAPBOX_TOKEN=made-up-public-value
` }),
  R('ai-key-by-usual-ending-code', 'ENV-005', 'Browser code reads a service key known only by its usual ending: Medium, the service decides if it is safe', 'src/gen.js',
    { 'src/gen.js': `export const key = import.meta.env.VITE_TMDB_API_KEY;
` },
    { 'src/gen.js': `export const key = import.meta.env.VITE_FIREBASE_API_KEY;
` }),
  R('ai-ai-key-in-code', 'ENV-002', 'Browser code reads an AI service\'s key: named for spending money, so High', 'src/ask.js',
    { 'src/ask.js': `export const key = import.meta.env.VITE_GOOGLE_GENERATIVE_AI_API_KEY;
` },
    { 'src/ask.js': `export const base = import.meta.env.VITE_API_URL;
` }),
  R('ai-pay-cart-sum-from-client', 'PAY-006', 'A total summed from the prices the visitor sent; the good copy sums the server\'s table', 'api/basket.js',
    { 'api/basket.js': `const { items } = req.body;
const amount = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
await stripe.paymentIntents.create({ amount, currency: 'usd' });
` },
    { 'api/basket.js': `const { items } = req.body;
const amount = items.reduce((sum, i) => sum + PRODUCTS[i.id].price * i.quantity, 0);
await stripe.paymentIntents.create({ amount, currency: 'usd' });
` }),
  X('ai-router-forgotten-mount', 'API-001', 'One protected mount does not protect the router mounted beside it', 'routes/users.js',
    { 'server.js': `const express = require('express');
const app = express();
const notesRouter = require('./routes/notes');
const usersRouter = require('./routes/users');
app.use('/api/notes', protect, notesRouter);
app.use('/api/users', usersRouter);
`, 'routes/notes.js': `const router = require('express').Router();
router.get('/', async (req, res) => res.json(await Note.find()));
module.exports = router;
`, 'routes/users.js': `const router = require('express').Router();
router.get('/', async (req, res) => res.json(await User.find()));
router.delete('/:id', async (req, res) => { await User.findByIdAndDelete(req.params.id); res.end(); });
module.exports = router;
` },
    { 'server.js': `const express = require('express');
const app = express();
const notesRouter = require('./routes/notes');
const usersRouter = require('./routes/users');
app.use('/api/notes', protect, notesRouter);
app.use('/api/users', protect, usersRouter);
`, 'routes/notes.js': `const router = require('express').Router();
router.get('/', async (req, res) => res.json(await Note.find()));
module.exports = router;
`, 'routes/users.js': `const router = require('express').Router();
router.get('/', async (req, res) => res.json(await User.find()));
router.delete('/:id', async (req, res) => { await User.findByIdAndDelete(req.params.id); res.end(); });
module.exports = router;
` }),
  Q('quiet-ai-honest-mounts', '^(API|DEBUG)-', 'Checks that do cover: a mount with a guard, a guard on a covering path, a router\'s own guard, Fastify\'s hook; and the password reset routes',
    { 'server.js': `const express = require('express');
const app = express();
const a = require('./routes/a');
const b = require('./routes/b');
const c = require('./routes/c');
app.use('/api/a', auth, a);
app.use('/api/secure', verifyToken);
app.use('/api/secure/b', b);
app.use('/api/c', c);
`, 'routes/a.js': `const router = require('express').Router();
router.get('/', async (req, res) => res.json(await User.find()));
module.exports = router;
`, 'routes/b.js': `const router = require('express').Router();
router.get('/', async (req, res) => res.json(await User.find()));
module.exports = router;
`, 'routes/c.js': `const router = require('express').Router();
router.use(auth);
router.get('/', async (req, res) => res.json(await User.find()));
module.exports = router;
`, 'plugins/fast.js': `const fastify = require('fastify');
const app = fastify();
app.addHook('onRequest', app.authenticate);
app.get('/customers', async () => Customer.find({}));
`, 'app/api/reset-password/route.ts': `export async function POST(req) {
  const { token, password } = await req.json();
  await prisma.user.update({ where: { token }, data: { password: await hash(password) } });
  return Response.json({ ok: true });
}
`, 'other/reset.js': `const express = require('express');
const app = express();
app.post('/api/reset-password', async (req, res) => {
  await User.updateOne({ token: req.body.token }, { hash: await hash(req.body.pw) });
  res.end();
});
` }),
  X('ai-webhook-nuxt', 'PAY-007', 'A Nuxt payment webhook with no signature check', 'server/api/webhooks/stripe.post.ts',
    { 'server/api/webhooks/stripe.post.ts': `export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  await fulfil(body);
  return { received: true };
});
` },
    { 'server/api/webhooks/stripe.post.ts': `export default defineEventHandler(async (event) => {
  const raw = await readRawBody(event);
  const body = stripe.webhooks.construct` + `Event(raw, getHeader(event, 'stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  if (body.livemode !== LIVE_MODE) return { ignored: true };
  await fulfil(body);
  return { received: true };
});
` }),
  R('ai-firebase-admin-through-client', 'KEY-003', 'lib/firebaseAdmin.ts is browser code when a client component imports it', 'lib/firebaseAdmin.ts',
    { 'lib/firebaseAdmin.ts': `import admin from 'firebase-admin';
export default admin;
`, 'components/Panel.tsx': `'use client';
import admin from '@/lib/firebaseAdmin';
export const Panel = () => <p>{admin.name}</p>;
` },
    { 'lib/firebaseAdmin.ts': `import admin from 'firebase-admin';
export default admin;
`, 'app/api/stats/route.ts': `import admin from '@/lib/firebaseAdmin';
export async function GET() { return Response.json({ name: admin.name }); }
` }),
  R('ai-firebase-admin-in-vite-src', 'KEY-003', 'A plain Vite app sends all of src/ to the browser', 'src/firebase.js',
    { 'vite.config.js': `export default {};
`, 'index.html': `<!doctype html><title>Shop</title>
`, 'src/firebase.js': `import admin from 'firebase-admin';
export default admin;
` },
    { 'vite.config.js': `export default {};
`, 'src/firebase.js': `import admin from 'firebase-admin';
export default admin;
` }),
  X('ai-table-no-rls-drizzle', 'RLS-001', 'Drizzle\'s migrations in a project that uses Supabase', 'drizzle/0000_first.sql',
    { 'src/db.js': `import { createClient } from '@supabase/supabase-js';
export const sb = createClient(url, key);
`, 'drizzle/0000_first.sql': `CREATE TABLE "notes" ("id" serial PRIMARY KEY);
` },
    { 'src/db.js': `import { createClient } from '@supabase/supabase-js';
export const sb = createClient(url, key);
`, 'drizzle/0000_first.sql': `CREATE TABLE "notes" ("id" serial PRIMARY KEY);
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
` }),
  Q('quiet-ai-supabase-auth-only', '^RLS-', 'Another database\'s migrations, with Supabase there for sign-in only',
    { 'src/auth.js': `import { createClient } from '@supabase/supabase-js';
export const sb = createClient(url, key);
export const me = () => sb.auth.getUser();
`, 'db/migrations/001_init.sql': `create table notes (id int);
` }),
  X('ai-sveltekit-route-open', 'API-001', 'A SvelteKit route deletes orders with no check', 'src/routes/api/orders/+server.ts',
    { 'src/routes/api/orders/+server.ts': `export async function DELETE() {
  await prisma.order.deleteMany();
  return new Response(null);
}
`, 'src/hooks.server.ts': `export const handle = async ({ event, resolve }) => {
  event.locals.user = await readUser(event.cookies);
  return resolve(event);
};
` },
    { 'src/routes/api/orders/+server.ts': `export async function DELETE() {
  await prisma.order.deleteMany();
  return new Response(null);
}
`, 'src/hooks.server.ts': `export const handle = async ({ event, resolve }) => {
  event.locals.user = await readUser(event.cookies);
  if (event.url.pathname.startsWith('/api') && !event.locals.user) throw error(401, 'Please sign in first.');
  return resolve(event);
};
` }),
  X('ai-nuxt-route-open', 'API-001', 'A Nuxt route returns orders with no check; the good copy has server middleware', 'server/api/orders.get.ts',
    { 'server/api/orders.get.ts': `export default defineEventHandler(async () => prisma.order.findMany());
` },
    { 'server/api/orders.get.ts': `export default defineEventHandler(async () => prisma.order.findMany());
`, 'server/middleware/auth.ts': `export default defineEventHandler(async (event) => {
  if (!event.context.user) throw createError({ statusCode: 401, message: 'Please sign in first.' });
});
` }),
  Q('quiet-ai-public-keys', '^ENV-', 'Keys that are meant to be in the page',
    { '.env': `VITE_FIREBASE_API_KEY=made-up-public-value
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=made-up-public-value
VITE_MAPBOX_TOKEN=made-up-public-value
VITE_MAPBOX_ACCESS_TOKEN=made-up-public-value
NEXT_PUBLIC_POSTHOG_KEY=made-up-public-value
NEXT_PUBLIC_SENTRY_DSN=https://madeup@sentry.test/1
NEXT_PUBLIC_ALGOLIA_SEARCH_API_KEY=made-up-public-value
NEXT_PUBLIC_RECAPTCHA_SITE_KEY=made-up-public-value
NEXT_PUBLIC_TURNSTILE_SITE_KEY=made-up-public-value
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=made-up-public-value
PUBLIC_SITE_URL=https://shop.test
GATSBY_SITE_URL=https://shop.test
VUE_APP_TITLE=Shop
`, 'src/keys.js': `export const k = [import.meta.env.VITE_FIREBASE_API_KEY, process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY, import.meta.env.VITE_MAPBOX_ACCESS_TOKEN, import.meta.env.PUBLIC_SITE_URL];
` }),
  R('ai-log-setting', 'LOG-001', 'A secret setting is written to the log', 'lib/boot.js',
    { 'lib/boot.js': `console.log('OpenAI key:', process.env.OPENAI_API_KEY);
` },
    { 'lib/boot.js': `console.log('OpenAI key set:', Boolean(process.env.OPENAI_API_KEY));
` }),
  R('ai-log-login-body', 'LOG-001', 'A sign-in\'s whole body, password and all, is written to the log', 'routes/sign-in.js',
    { 'routes/sign-in.js': `export function signIn(req, res) {
  console.log('Login attempt:', req.body);
  return check(req.body.email, req.body.password, res);
}
` },
    { 'routes/sign-in.js': `export function signIn(req, res) {
  console.log('Login attempt:', req.body.email);
  return check(req.body.email, req.body.password, res);
}
` }),
  R('ai-log-headers', 'LOG-001', 'A request\'s whole headers, cookies and all, are written to the log', 'lib/trace.js',
    { 'lib/trace.js': `export const trace = req => console.log('Headers:', req.headers);
` },
    { 'lib/trace.js': `export const trace = req => console.log('Host:', req.headers.host);
` }),
  X('ai-webhook-flask', 'PAY-007', 'A Flask payment webhook with no signature check', 'pay_hook.py',
    { 'pay_hook.py': `import stripe
@app.route('/webhook', methods=['POST'])
def hook():
    event = request.get_json()
    fulfil(event)
    return '', 200
` },
    { 'pay_hook.py': `import stripe
@app.route('/webhook', methods=['POST'])
def hook():
    event = stripe.Webhook.construct_event(request.data, request.headers['Stripe-Signature'], SECRET)
    fulfil(event)
    return '', 200
` }),
  X('ai-webhook-reads-header-only', 'PAY-007', 'A webhook reads the signature header and never checks it', 'app/api/pay/webhook/route.ts',
    { 'app/api/pay/webhook/route.ts': `export async function POST(req) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('No signature.', { status: 400 });
  const event = await req.json();
  await fulfil(event);
  return Response.json({ received: true });
}
` },
    { 'app/api/pay/webhook/route.ts': `export async function POST(req) {
  const sig = req.headers.get('stripe-signature');
  const event = stripe.webhooks.construct` + `Event(await req.text(), sig, process.env.STRIPE_WEBHOOK_SECRET);
  if (event.livemode !== LIVE_MODE) return Response.json({ ignored: true });
  await fulfil(event);
  return Response.json({ received: true });
}
` }),
  X('ai-table-no-rls-database-sql', 'RLS-001', 'database.sql in the project root creates a table with no row-level security', 'database.sql',
    { 'src/db.js': `import { createClient } from '@supabase/supabase-js';
export const db = createClient(url, key);
`, 'database.sql': `create table notes (id uuid primary key);
` },
    { 'src/db.js': `import { createClient } from '@supabase/supabase-js';
export const db = createClient(url, key);
`, 'database.sql': `create table notes (id uuid primary key);
alter table notes enable row level security;
` }),
  // ---- open routes behind an open read, sign-in middleware that protects less than it seems, Firebase's test mode ----
  X('ai-crud-get-first', 'API-001', 'An open GET on a table of no one in particular comes first; the open DELETE after it is the worst of the file', 'srv.js',
    { 'srv.js': `const express = require('express');
const app = express();
app.get('/api/todos', async (req, res) => res.json(await prisma.todo.findMany()));
app.delete('/api/todos/:id', async (req, res) => {
  await prisma.todo.delete({ where: { id: req.params.id } });
  res.end();
});
` },
    { 'srv.js': `const express = require('express');
const app = express();
app.get('/api/todos', async (req, res) => res.json(await prisma.todo.findMany()));
app.delete('/api/todos/:id', requireUser, async (req, res) => {
  await prisma.todo.delete({ where: { id: req.params.id } });
  res.end();
});
` }),
  X('ai-clerk-quickstart-open-api', 'API-001', 'Clerk\'s quickstart protects /dashboard; its matcher only says the middleware runs on /api', 'app/api/users/route.ts',
    { 'app/api/users/route.ts': `export async function GET() { return Response.json(await prisma.user.findMany()); }
export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }
`, 'middleware.ts': `import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
const isProtectedRoute = createRouteMatcher(['/dashboard(.*)']);
export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
});
export const config = { matcher: ['/(api|trpc)(.*)'] };
` },
    { 'app/api/users/route.ts': `export async function GET() { return Response.json(await prisma.user.findMany()); }
export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }
`, 'middleware.ts': `import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
const isPublicRoute = createRouteMatcher(['/sign-in(.*)']);
export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) await auth.protect();
});
export const config = { matcher: ['/(api|trpc)(.*)'] };
` }),
  X('ai-inline-server-action', 'API-001', 'A server action written inside a page wipes a table with nothing checking who posted', 'app/people/page.tsx',
    { 'app/people/page.tsx': `export default function Page() {
  async function wipe() {
    'use server';
    await prisma.user.deleteMany();
  }
  return <form action={wipe}><button>Wipe</button></form>;
}
` },
    { 'app/people/page.tsx': `export default function Page() {
  async function wipe() {
    'use server';
    const session = await auth();
    if (!session) return;
    await prisma.user.deleteMany();
  }
  return <form action={wipe}><button>Wipe</button></form>;
}
` }),
  X('ai-nextauth-bare-middleware', 'API-001', 'NextAuth\'s auth is handed over as the middleware with no authorized callback, so it turns no one away', 'app/api/notes/route.ts',
    { 'auth.ts': `import NextAuth from 'next-auth';
export const { handlers, auth } = NextAuth({ providers: [] });
`, 'middleware.ts': `export { auth as middleware } from '@/auth';
`, 'app/api/notes/route.ts': `export async function DELETE() {
  await prisma.note.deleteMany();
  return Response.json({});
}
` },
    { 'auth.ts': `import NextAuth from 'next-auth';
export const { handlers, auth } = NextAuth({ providers: [], callbacks: { authorized: ({ auth }) => !!auth } });
`, 'middleware.ts': `export { auth as middleware } from '@/auth';
`, 'app/api/notes/route.ts': `export async function DELETE() {
  await prisma.note.deleteMany();
  return Response.json({});
}
` }),
  X('ai-firestore-test-mode', 'FIRE-001', 'firestore.rules still says allow read, write: if true', 'firestore.rules',
    { 'src/fb.js': `import { initializeApp } from 'firebase/app';
export const app = initializeApp(config);
`, 'firestore.rules': `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
` },
    { 'src/fb.js': `import { initializeApp } from 'firebase/app';
export const app = initializeApp(config);
`, 'firestore.rules': `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
` }),
  X('ai-storage-rules-open', 'FIRE-001', 'storage.rules lets anyone write and overwrite every file', 'storage.rules',
    { 'firebase.json': `{ "storage": { "rules": "storage.rules" } }
`, 'storage.rules': `service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}
` },
    { 'firebase.json': `{ "storage": { "rules": "storage.rules" } }
`, 'storage.rules': `service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
` }),
  X('ai-realtime-rules-open', 'FIRE-001', 'database.rules.json has .read and .write set to true', 'database.rules.json',
    { 'package.json': `{ "dependencies": { "firebase": "10.0.0" } }
`, 'database.rules.json': `{
  "rules": {
    ".read": true,
    ".write": true
  }
}
` },
    { 'package.json': `{ "dependencies": { "firebase": "10.0.0" } }
`, 'database.rules.json': `{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
` }),
  R('ai-pay-hono-body', 'PAY-006', 'A Hono route charges the amount it read from c.req.json()', 'srv/pay.ts',
    { 'srv/pay.ts': `app.post('/pay', async (c) => {
  const { amount } = await c.req.json();
  await stripe.paymentIntents.create({ amount, currency: 'usd' });
  return c.json({});
});
` },
    { 'srv/pay.ts': `app.post('/pay', async (c) => {
  const { itemId } = await c.req.json();
  await stripe.paymentIntents.create({ amount: priceOf(itemId), currency: 'usd' });
  return c.json({});
});
` }),
  R('ai-pay-remix-action', 'PAY-006', 'A Remix route\'s action in a .tsx file charges what the form sent', 'app/routes/pay.tsx',
    { 'app/routes/pay.tsx': `export async function action({ request }) {
  const form = await request.formData();
  await stripe.paymentIntents.create({ amount: Number(form.get('amount')), currency: 'usd' });
  return null;
}
export default function Pay() { return <form method="post" />; }
` },
    { 'app/routes/pay.tsx': `export async function action({ request }) {
  const form = await request.formData();
  await stripe.paymentIntents.create({ amount: priceOf(form.get('id')), currency: 'usd' });
  return null;
}
export default function Pay() { return <form method="post" />; }
` }),
  R('ai-cors-hand-set', 'CORS-003', 'Headers set by hand send the visitor\'s own Origin back, with credentials allowed', 'api/open.js',
    { 'api/open.js': `app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin);
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});
` },
    { 'api/open.js': `app.use((req, res, next) => {
  if (ALLOWED.includes(req.headers.origin)) res.header('Access-Control-Allow-Origin', req.headers.origin);
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});
` }),
  R('ai-cors-hono-echo', 'CORS-003', 'Hono\'s cors hands back whichever site asked, with credentials on', 'srv/cors.ts',
    { 'srv/cors.ts': `import { cors } from 'hono/cors';
app.use('*', cors({ origin: (origin) => origin, credentials: true }));
` },
    { 'srv/cors.ts': `import { cors } from 'hono/cors';
app.use('*', cors({ origin: (origin) => (LIST.includes(origin) ? origin : null), credentials: true }));
` }),
  R('ai-vite-loadenv-all', 'ENV-003', 'vite define hands the browser every setting, through loadEnv with an empty prefix', 'vite.config.ts',
    { 'vite.config.ts': `export default ({ mode }) => ({ define: {
  'process.env': JSON.stringify(loadEnv(mode, process.cwd(), '')),
} });
` },
    { 'vite.config.ts': `export default ({ mode }) => ({ define: {
  'process.env': JSON.stringify(loadEnv(mode, process.cwd(), 'VITE_')),
} });
` }),
  Q('ai-quiet-hono-star', '^API-00[12]$', 'Hono: a check on /api/* covers the routes under it', {
    'srv.ts': `import { Hono } from 'hono';
const app = new Hono();
app.use('/api/*', jwt({ secret }));
app.post('/api/todos', async (c) => {
  await db.insert(todos).values(await c.req.json());
  return c.json({});
});
` }),
  Q('ai-quiet-express-own-guard', '^API-00[12]$', 'Express: the project\'s own key check on the .use line, and a mount behind isAdmin', {
    'server.js': `const express = require('express');
const app = express();
const adminRouter = require('./routes/admin');
function checkApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.API_KEY) return res.status(401).json({ error: 'That key is not right.' });
  next();
}
app.use('/api', checkApiKey);
app.use('/admin', isAdmin, adminRouter);
app.post('/api/todos', async (req, res) => {
  await prisma.todo.create({ data: req.body });
  res.end();
});
`, 'routes/admin.js': `const router = require('express').Router();
router.delete('/users/:id', async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.end();
});
module.exports = router;
` }),
  Q('ai-quiet-clerk-protects-all', '^API-00[12]$', 'Clerk: a check for every address, and a list of public ones with this route not among them', {
    'app/api/users/route.ts': `export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }
`, 'middleware.ts': `import { clerkMiddleware } from '@clerk/nextjs/server';
export default clerkMiddleware(async (auth) => { await auth.protect(); });
export const config = { matcher: ['/(api|trpc)(.*)'] };
` }),
  Q('ai-quiet-clerk-route-checks', '^API-00[12]$', 'Clerk: the route checks for itself, whatever the middleware does', {
    'app/api/users/route.ts': `import { auth } from '@clerk/nextjs/server';
export async function DELETE() {
  const { userId } = await auth();
  if (!userId) return new Response('Please sign in first.', { status: 401 });
  await prisma.user.deleteMany();
  return Response.json({});
}
`, 'middleware.ts': `import { clerkMiddleware } from '@clerk/nextjs/server';
export default clerkMiddleware();
` }),
  Q('ai-quiet-firebase-public-read', '^FIRE-001$', 'Firebase: a public collection anyone may read, writes guarded; a form anyone may add to', {
    'firebase.json': `{}
`, 'firestore.rules': `service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} {
      allow read: if true;
      allow write: if request.auth != null;
    }
    match /enquiries/{id} {
      allow create: if true;
    }
  }
}
` }),
  Q('ai-quiet-no-firebase', '^FIRE-001$', 'A rules file left in a project with no Firebase in it', {
    'src/db.js': `import pg from 'pg';
export const db = new pg.Pool();
`, 'firestore.rules': `match /{document=**} {
  allow read, write: if true;
}
` }),
  Q('ai-quiet-pay-browser-component', '^PAY-006$', 'A browser component reads an amount from its form; no server code here takes it', {
    'components/Pay.tsx': `export function Pay() {
  const submit = async (e) => {
    const formData = new FormData(e.target);
    const amount = Number(formData.get('amount'));
    await paypal.pay({ amount, currency: 'usd' });
  };
  return <form onSubmit={submit} />;
}
` }),

  // ---- an amount that goes through a variable or a function of the file ----
  R('ai-pay-one-variable-on', 'PAY-006', 'The amount from the body is turned into cents first, then charged', 'app/api/pay/route.ts',
    { 'app/api/pay/route.ts': `export async function POST(req) {
  const { amount } = await req.json();
  const amountInCents = Math.round(amount * 100);
  const intent = await stripe.paymentIntents.create({ amount: amountInCents, currency: 'usd' });
  return Response.json({ secret: intent.client_secret });
}
` },
    { 'app/api/pay/route.ts': `export async function POST(req) {
  const { itemId } = await req.json();
  const amountInCents = Math.round(PRICES[itemId] * 100);
  const intent = await stripe.paymentIntents.create({ amount: amountInCents, currency: 'usd' });
  return Response.json({ secret: intent.client_secret });
}
` }),
  R('ai-pay-sample-sums-sent-prices', 'PAY-006', 'A function of the file adds up the prices in the visitor\'s list; the good copy looks them up on the server', 'server/intent.js',
    { 'server/intent.js': `const calculateOrderAmount = (items) => {
  let total = 0;
  items.forEach((item) => {
    total += item.price;
  });
  return total;
};
app.post('/create-payment-intent', async (req, res) => {
  const { items } = req.body;
  const total = calculateOrderAmount(items);
  const intent = await stripe.paymentIntents.create({ amount: total, currency: 'usd' });
  res.send({ clientSecret: intent.client_secret });
});
` },
    { 'server/intent.js': `const calculateOrderAmount = (items) => {
  let total = 0;
  items.forEach((item) => {
    total += PRODUCTS[item.id].price * item.quantity;
  });
  return total;
};
app.post('/create-payment-intent', async (req, res) => {
  const { items } = req.body;
  const total = calculateOrderAmount(items);
  const intent = await stripe.paymentIntents.create({ amount: total, currency: 'usd' });
  res.send({ clientSecret: intent.client_secret });
});
` }),
  R('ai-pay-count-times-sent-price', 'PAY-006', 'A count times a price the visitor sent; the good copy multiplies by the server\'s price', 'app/api/credits/route.ts',
    { 'app/api/credits/route.ts': `export async function POST(req) {
  const { credits, price } = await req.json();
  await stripe.paymentIntents.create({ amount: credits * price, currency: 'usd' });
  return Response.json({ ok: true });
}
` },
    { 'app/api/credits/route.ts': `export async function POST(req) {
  const { credits } = await req.json();
  await stripe.paymentIntents.create({ amount: credits * PRICE_PER_CREDIT, currency: 'usd' });
  return Response.json({ ok: true });
}
` }),
  Q('ai-quiet-pay-sample-fixed-amount', '^PAY-006$', 'A sample whose function returns a fixed amount, with the sum left in a comment', {
    'server/intent.js': `const calculateOrderAmount = (items) => {
  // Work out the total on the server, so nobody can change it in the browser
  // items.forEach((item) => { total += item.amount; });
  return 1400;
};
app.post('/create-payment-intent', async (req, res) => {
  const { items } = req.body;
  const intent = await stripe.paymentIntents.create({
    amount: calculateOrderAmount(items),
    currency: 'usd',
  });
  res.send({ clientSecret: intent.client_secret });
});
` }),
  Q('ai-quiet-pay-plan-times-quantity', '^PAY-006$', 'The plan and the quantity come from the visitor; the price comes from the server', {
    'api/subscribe.js': `const { plan, quantity } = req.body;
await stripe.paymentIntents.create({ amount: PRICES[plan] * quantity, currency: 'usd' });
` }),
  Q('ai-quiet-pay-same-name-other-route', '^PAY-006$', 'One route quotes from what was sent; another fills the same name from the server and charges it', {
    'api/shop.js': `app.post('/quote', async (req, res) => {
  const { amount } = req.body;
  const total = amount * 1.2;
  res.json({ total });
});
app.post('/pay', async (req, res) => {
  const { id } = req.body;
  const total = priceOf(id);
  await stripe.paymentIntents.create({ amount: total, currency: 'usd' });
});
` }),

  // ---- checks that are not on the line a rule first reads ----
  X('ai-clerk-older-public-api', 'API-001', 'Clerk\'s older authMiddleware lists all of /api as public, so the delete is open; the good copy lists only the webhooks', 'app/api/orders/route.ts',
    { 'app/api/orders/route.ts': ORDERS_ROUTE, 'middleware.ts': `import { authMiddleware } from '@clerk/nextjs';
export default authMiddleware({ publicRoutes: ['/', '/api/(.*)'] });
export const config = { matcher: ['/((?!_next).*)', '/(api|trpc)(.*)'] };
` },
    { 'app/api/orders/route.ts': ORDERS_ROUTE, 'middleware.ts': `import { authMiddleware } from '@clerk/nextjs';
export default authMiddleware({ publicRoutes: ['/', '/api/webhooks(.*)'] });
export const config = { matcher: ['/((?!_next).*)', '/(api|trpc)(.*)'] };
` }),
  X('ai-inline-use-sets-header', 'API-001', 'An app.use written out in the call only sets a header; the good copy turns away who is not signed in', 'server/inline.js',
    { 'server/inline.js': `const express = require('express');
const app = express();
app.use((req, res, next) => {
  res.setHeader('X-Api-Key-Version', '1');
  next();
});
app.delete('/api/users/:id', async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.end();
});
` },
    { 'server/inline.js': `const express = require('express');
const app = express();
app.use((req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in first.' });
  next();
});
app.delete('/api/users/:id', async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.end();
});
` }),
  X('ai-all-route-only-logs', 'API-001', 'app.all over /api only logs; the good copy names a guard', 'server/all.js',
    { 'server/all.js': `const express = require('express');
const app = express();
function logCalls(req, res, next) { console.log(req.url); next(); }
app.all('/api/*', logCalls);
app.delete('/api/users/:id', async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.end();
});
` },
    { 'server/all.js': `const express = require('express');
const app = express();
app.all('/api/*', requireAuth);
app.delete('/api/users/:id', async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.end();
});
` }),
  Q('ai-quiet-use-verifies-token', '^API-001$', 'A guard written out in app.use verifies a Firebase token and answers 401', {
    'server/token.js': `const express = require('express');
const app = express();
app.use(async (req, res, next) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    req.me = await admin.auth().verifyIdToken(token);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Please sign in first.' });
  }
});
app.delete('/api/users/:id', async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.end();
});
` }),

  // ---- a route that hands its work to another file ----
  X('ai-controller-delete-open', 'API-001', 'A route names a controller in another file, and that controller deletes a user with no check anywhere', 'routes/userRoutes.js',
    { 'routes/userRoutes.js': `const express = require('express');
const router = express.Router();
const { deleteUser } = require('../controllers/userController');
router.delete('/:id', deleteUser);
module.exports = router;
`, 'controllers/userController.js': `const asyncHandler = require('express-async-handler');
const User = require('../models/userModel');
const deleteUser = asyncHandler(async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ message: 'Removed' });
});
module.exports = { deleteUser };
` },
    { 'routes/userRoutes.js': `const express = require('express');
const router = express.Router();
const { deleteUser } = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');
router.delete('/:id', protect, deleteUser);
module.exports = router;
`, 'controllers/userController.js': `const asyncHandler = require('express-async-handler');
const User = require('../models/userModel');
const deleteUser = asyncHandler(async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ message: 'Removed' });
});
module.exports = { deleteUser };
` }),
  X('ai-router-route-chain-open', 'API-001', 'router.route chains two methods to controllers with no check; the good copy has router.use(protect)', 'routes/users.js',
    { 'routes/users.js': `import { Router } from 'express';
import {
  getUsers,
  addUser,
} from '../controllers/users.js';
const router = Router();
router.route('/').get(getUsers).post(addUser);
export default router;
`, 'controllers/users.js': `export const getUsers = async (req, res) => {
  res.json(await User.find({}));
};
export const addUser = async (req, res) => {
  res.json(await new User(req.body).save());
};
` },
    { 'routes/users.js': `import { Router } from 'express';
import {
  getUsers,
  addUser,
} from '../controllers/users.js';
import { protect } from '../middleware/auth.js';
const router = Router();
router.use(protect);
router.route('/').get(getUsers).post(addUser);
export default router;
`, 'controllers/users.js': `export const getUsers = async (req, res) => {
  res.json(await User.find({}));
};
export const addUser = async (req, res) => {
  res.json(await new User(req.body).save());
};
` }),
  X('ai-route-calls-repo-open', 'API-001', 'A route returns userRepo.findAll(), and that function reads every user from another file', 'server/users.js',
    { 'server/users.js': `const express = require('express');
const app = express();
const userRepo = require('./db/userRepo');
app.get('/api/users', async (req, res) => {
  res.json(await userRepo.findAll());
});
`, 'server/db/userRepo.js': `const db = require('./pool');
module.exports = {
  findAll: () => db.query('SELECT * FROM users'),
};
` },
    { 'server/users.js': `const express = require('express');
const app = express();
const userRepo = require('./db/userRepo');
const { requireUser } = require('./mw');
app.get('/api/users', requireUser, async (req, res) => {
  res.json(await userRepo.findAll());
});
`, 'server/db/userRepo.js': `const db = require('./pool');
module.exports = {
  findAll: () => db.query('SELECT * FROM users'),
};
` }),
  Q('ai-quiet-controller-checks-itself', '^API-001$', 'The controller in another file checks req.user itself', {
    'routes/notes.js': `const router = require('express').Router();
const notes = require('../controllers/notes');
router.route('/:id')
  .get(notes.show)
  .delete(notes.drop);
module.exports = router;
`, 'controllers/notes.js': `exports.show = async (req, res) => {
  res.json(await Note.findOne({ _id: req.params.id, owner: req.user.id }));
};
exports.drop = async (req, res) => {
  await Note.findOneAndDelete({ _id: req.params.id, owner: req.user.id });
  res.end();
};
` }),
  Q('ai-quiet-controller-sign-up', '^API-001$', 'A shop\'s usual routes: sign-up and sign-in are open, the catalogue is public, changes have guards', {
    'routes/userRoutes.js': `const express = require('express');
const router = express.Router();
const { registerUser, authUser, getUsers } = require('../controllers/userController');
const { protect, admin } = require('../middleware/authMiddleware');
router.route('/').post(registerUser).get(protect, admin, getUsers);
router.post('/login', authUser);
module.exports = router;
`, 'routes/productRoutes.js': `const express = require('express');
const router = express.Router();
const { getProducts, deleteProduct } = require('../controllers/productController');
const { protect, admin } = require('../middleware/authMiddleware');
router.route('/').get(getProducts);
router.route('/:id').delete(protect, admin, deleteProduct);
module.exports = router;
`, 'controllers/userController.js': `const registerUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (await User.findOne({ email })) throw new Error('That email already has an account.');
  res.json(await User.create({ email, password }));
});
const authUser = asyncHandler(async (req, res) => {
  res.json(await User.findOne({ email: req.body.email }));
});
const getUsers = asyncHandler(async (req, res) => {
  res.json(await User.find({}));
});
module.exports = { registerUser, authUser, getUsers };
`, 'controllers/productController.js': `const getProducts = asyncHandler(async (req, res) => {
  res.json(await Product.find({}));
});
const deleteProduct = asyncHandler(async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.end();
});
module.exports = { getProducts, deleteProduct };
` }),

  // ---- a route that only adds a record ----
  X('ai-post-only-adds-record', 'API-002', 'A route takes only POST and only adds a record: Medium, in words that say when it is fine; the good copy checks who is calling', 'app/api/subscribers/route.ts',
    { 'app/api/subscribers/route.ts': `export async function POST(req) {
  await prisma.subscriber.create({ data: await req.json() });
  return Response.json({ ok: true });
}
` },
    { 'app/api/subscribers/route.ts': `export async function POST(req) {
  const session = await auth();
  if (!session) return new Response('Please sign in first.', { status: 401 });
  await prisma.subscriber.create({ data: await req.json() });
  return Response.json({ ok: true });
}
` }),
  Q('ai-quiet-post-only-form-not-high', '^API-001$', 'A form that only saves a message is not reported as a High', {
    'app/api/messages/route.ts': `export async function POST(req) {
  await prisma.message.create({ data: await req.json() });
  return Response.json({ ok: true });
}
` }),
  X('ai-secret-as-fallback', 'SEC-018', 'A form secret reads a setting, with the real key written in as the fallback; the good copy has no fallback and stops when the setting is missing', 'lib/captcha.php', { 'lib/captcha.php': `<?php
$s = getenv('CAPTCHA_SECRET');
define('CAPTCHA_SECRET_KEY', $s !== false ? $s : '${FORM_KEY()}');
` }, { 'lib/captcha.php': `<?php
$s = getenv('CAPTCHA_SECRET');
if ($s === false) { throw new RuntimeException('The form check has no key. Set CAPTCHA_SECRET on the server.'); }
define('CAPTCHA_SECRET_KEY', $s);
` }),
  X('ai-secret-under-its-name', 'SEC-018', 'A secret is written in under a name the password rules do not read; the good copy reads a setting', 'server/captcha.js', { 'server/captcha.js': `const recaptchaSecret = '${FORM_KEY()}';
module.exports = { recaptchaSecret };
` }, { 'server/captcha.js': `const recaptchaSecret = process.env.RECAPTCHA_SECRET;
module.exports = { recaptchaSecret };
` }),
  Q('ai-quiet-secret-look-alikes', '^SEC-018$', 'A site key, a setting name, a path, an empty fallback and a label picked by a ternary are not secrets', {
    'server/settings.js': `const RECAPTCHA_SITE_KEY = '${FORM_KEY()}';
const SECRET_HEADER = 'x-signature-sha256-v2-abcdef';
const secretFile = process.env.SECRET_FILE || '/run/secrets/app1';
const key = process.env.API_SECRET || '';
const label = isSecret ? 'hiddenvalue1' : 'shownvalue2';
` }),
];
