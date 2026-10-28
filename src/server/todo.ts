// The To Do's routes (src/todo.ts): its rows, parts, sizes, quick checks and your day. A project is named by its id
// only (job:<id> for TOMLIN's own, folder:<id> for a project folder on the Projects page), never by a folder path; its
// name comes from here, not from the page. A row is named by its own id.
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { TodoStore, isProject, type Result } from '../todo.ts';
import { type Routes, json, store } from './core.ts';
import { bridgeProjects } from './bridge.ts';
import { jobRoutes } from './jobs.ts';

const todo = new TodoStore(join(store.dir, 'todo.json'));

/** Every project a row can name, { ref: name }: TOMLIN's projects (planned or saved on Home), then the project folders. */
async function projects(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const j of await jobRoutes.listJobs()) if (!j.hidden) out[`job:${j.id}`] = j.name || j.goal || j.id;
  for (const u of await jobRoutes.unplanned()) out[`job:${u.id}`] ??= u.name || u.goal || u.id;
  for (const p of bridgeProjects()) out[`folder:${p.id}`] = p.name;
  return out;
}

/** A project there is now, by its ref, with its name; null for anything else. */
async function projectOf(v: unknown): Promise<{ ref: string; name: string } | null> {
  if (!isProject(v)) return null;
  const all = await projects();
  return Object.hasOwn(all, v) ? { ref: v, name: all[v] } : null;
}

const itemId = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{8,16}$/.test(v) ? v : null);
const say = (res: ServerResponse, r: Result) => (r.ok ? json(res, 200, r) : json(res, 400, { error: [r.fault, r.reason, r.wayOut].filter(Boolean).join(' '), ...r }));
const notThere = { error: 'That project is not in TOMLIN or on the Projects page any more. Reload the page, then pick it again.' };

/** The To Do with every project it can name (for + Add), TOMLIN's first. */
async function todoView() {
  const all = await projects();
  const v = await todo.view(all, k => Object.hasOwn(all, k));
  return { ...v, projects: Object.entries(all).map(([ref, name]) => ({ ref, name, type: ref.startsWith('job:') ? 'job' : 'folder' })) };
}

export const todoGet: Routes = {
  '/api/todo': async ({ res }) => json(res, 200, await todoView()),
};

export const todoPost: Routes = {
  // { project (ref), size, note, zone, every? }: a row, and (with every) the project's quick check too.
  '/api/todo/add': async ({ res, b }) => {
    const p = await projectOf(b.project);
    if (!p) return json(res, 404, notThere);
    const r = await todo.add({ project: p.ref, name: p.name, size: b.size, note: b.note, zone: b.zone });
    if (r.ok && (b.every === 'week' || b.every === 'month')) await todo.setCheck(p.ref, b.every, p.name);
    return say(res, r);
  },
  '/api/todo/set': async ({ res, b }) => say(res, await todo.set(itemId(b.item), { size: b.size, note: b.note })),
  '/api/todo/move': async ({ res, b }) => say(res, await todo.move(itemId(b.item), b.zone, itemId(b.before))),
  '/api/todo/done': async ({ res, b }) => say(res, await todo.done(itemId(b.item), b.done !== false)),
  '/api/todo/remove': async ({ res, b }) => say(res, await todo.remove(itemId(b.item))),
  // A project's quick check: { project (ref), every: 'week' | 'month' | 'off' } ('off' also for a project that is gone).
  '/api/todo/check': async ({ res, b }) => {
    const p = await projectOf(b.project);
    if (!p && b.every !== 'off') return json(res, 404, notThere);
    return say(res, await todo.setCheck(p ? p.ref : b.project, b.every, p ? p.name : ''));
  },
  '/api/todo/settings': async ({ res, b }) => say(res, await todo.setSettings({ dayHours: b.dayHours, checksPerDay: b.checksPerDay, doneShow: b.doneShow })),
};
