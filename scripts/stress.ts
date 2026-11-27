/**
 * Stress and chaos test against real server processes.
 *
 * Several instances share one database. Creators, operators and contributors hit them at the
 * same time, some requests are sent twice, and instances are killed with SIGKILL while they
 * work. Afterwards the database is checked against what clients were told.
 *
 *   npm run stress -- --tasks 5000 --instances 2 --operators 50 --kill-every 2000
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { Agent, request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDatabase, transaction } from '../server/db.ts';
import { RoutingEngine } from '../server/engine.ts';
import { TaskService } from '../server/service.ts';
import { BRANCHES, EXPERTISE, PRIORITIES, QUEUES, type Contributor, type TaskPage, type TaskSummary } from '../shared/types.ts';

const { values } = parseArgs({
  options: {
    tasks: { type: 'string', default: '3000' },
    preload: { type: 'string', default: '0' },
    instances: { type: 'string', default: '2' },
    creators: { type: 'string', default: '60' },
    operators: { type: 'string', default: '50' },
    responders: { type: 'string', default: '30' },
    contributors: { type: 'string', default: '240' },
    'kill-every': { type: 'string', default: '2000' },
    'time-scale': { type: 'string', default: '0.1' },
    port: { type: 'string', default: '4300' },
  },
});
const n = (key: keyof typeof values) => Number(values[key]);

const dir = mkdtempSync(join(tmpdir(), 'router-stress-'));
const dbPath = join(dir, 'app.db');
const main = fileURLToPath(new URL('../server/main.ts', import.meta.url));

const pick = <T>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;
const chance = (p: number) => Math.random() < p;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ data

const db = openDatabase(dbPath);
transaction(db, () => {
  const insert = db.prepare('INSERT INTO contributors (id, name, branch, expertise, profile) VALUES (?, ?, ?, ?, ?)');
  // Unlimited hours keeps the run about throughput; capacity has its own tests.
  const profile = JSON.stringify({ weeklyHours: 1_000_000 });
  for (let i = 0; i < n('contributors'); i++) {
    const branch = BRANCHES[i % BRANCHES.length]!;
    // "legal" is deliberately uncovered, so some tasks find no match.
    const covered = EXPERTISE.filter((e) => e !== 'legal');
    const first = covered[Math.floor(i / BRANCHES.length) % covered.length]!;
    const expertise = chance(0.3) ? [...new Set([first, pick(covered)])] : [first];
    insert.run(`p${i}`, `Person ${i}`, branch, JSON.stringify(expertise), profile);
  }
});
if (n('preload')) {
  const service = new TaskService(db, new RoutingEngine(db));
  transaction(db, () => {
    for (let i = 0; i < n('preload'); i++) {
      service.createTask({
        title: `preload-${i}`,
        description: '',
        expertise: pick(EXPERTISE),
        branch: pick(BRANCHES),
        priority: pick(PRIORITIES),
        submit: false,
      });
    }
  });
}

// ------------------------------------------------------------------ servers

const ports = Array.from({ length: n('instances') }, (_, i) => n('port') + i);
const servers = new Map<number, ChildProcess>();
const serverErrors: string[] = [];
let kills = 0;
// Never leave servers running behind a crashed or interrupted test.
process.on('exit', () => servers.forEach((s) => s.kill('SIGKILL')));
process.on('SIGINT', () => process.exit(130));

function start(port: number): Promise<void> {
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), ROUTING_TIME_SCALE: values['time-scale'] },
  });
  servers.set(port, child);
  child.stderr.on('data', (d) => serverErrors.push(String(d)));
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    child.once('exit', (code) => code !== null && code !== 0 && reject(new Error(serverErrors.join(''))));
  });
}

// ------------------------------------------------------------------ client

const latency: Record<string, number[]> = {};
const tally: Record<string, number> = {};
const count = (key: string) => (tally[key] = (tally[key] ?? 0) + 1);
const unexpected: string[] = [];

// node:http rather than fetch: Node 26.4's fetch can crash the process (setTypeOfService
// EINVAL) when a server is killed under it, which this test does on purpose.
const agent = new Agent({ keepAlive: true, maxSockets: 256 });

function exchange(port: number, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers, agent, signal: AbortSignal.timeout(10_000) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

interface Reply<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/** Retries like the console does: same key, any instance, until there is a definite answer. */
async function send<T>(kind: string, path: string, body?: unknown, key?: string, etag?: Map<string, [string, unknown]>): Promise<Reply<T> | null> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const known = etag?.get(path);
    const started = performance.now();
    try {
      const res = await exchange(
        pick(ports),
        path,
        {
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...(key && { 'idempotency-key': key }),
          ...(known && { 'if-none-match': known[0] }),
        },
        body === undefined ? undefined : JSON.stringify(body),
      );
      const reply = res.status === 304 ? known![1] : JSON.parse(res.text);
      const ms = performance.now() - started;
      if (res.status === 503) {
        count('503 busy, retried');
      } else {
        (latency[res.status === 304 ? `${kind} (304)` : kind] ??= []).push(ms);
        if (![200, 201, 304, 400, 409].includes(res.status)) unexpected.push(`${res.status} ${path} ${res.text}`);
        if (res.status === 409) count('409 conflict (expected between users)');
        const tag = res.headers.etag;
        if (tag) etag?.set(path, [tag, reply]);
        return { status: res.status, body: reply as T, replayed: 'idempotent-replay' in res.headers };
      }
    } catch {
      count('connection lost, retried');
    }
    await sleep(Math.min(1000, 50 * (attempt + 1)));
  }
  count('gave up');
  return null;
}

// ------------------------------------------------------------------ actors

let loading = true;
let next = 0;
const acknowledgedCreates = new Map<string, string>(); // title -> id
const acknowledgedVersions = new Map<string, number>(); // task -> highest version a client saw confirmed
const mismatchedDuplicates: string[] = [];

const confirmed = (task: TaskSummary) =>
  acknowledgedVersions.set(task.id, Math.max(task.version, acknowledgedVersions.get(task.id) ?? 0));

async function creator() {
  while (next < n('tasks')) {
    const title = `stress-${next++}`;
    const key = randomUUID();
    const body = {
      title,
      expertise: chance(0.05) ? 'legal' : pick(EXPERTISE.filter((e) => e !== 'legal')),
      branch: pick(BRANCHES),
      priority: pick(PRIORITIES),
      submit: true,
    };
    const copies = chance(0.15) ? 3 : 1; // double clicks and impatient retries
    const replies = await Promise.all(Array.from({ length: copies }, () => send<TaskSummary>('create', '/api/tasks', body, key)));
    if (chance(0.05)) replies.push(await send<TaskSummary>('create', '/api/tasks', body, key)); // a much later retry
    for (const reply of replies) {
      if (reply?.status !== 201) continue;
      if (reply.replayed) count('duplicate answered from idempotency key');
      const earlier = acknowledgedCreates.get(title);
      if (earlier && earlier !== reply.body.id) mismatchedDuplicates.push(title);
      acknowledgedCreates.set(title, reply.body.id);
      confirmed(reply.body);
    }
  }
}

function browse(queue?: string) {
  const query = new URLSearchParams();
  if (chance(0.5)) query.set('branch', pick(BRANCHES));
  query.set('queue', queue ?? pick(QUEUES));
  if (chance(0.2)) query.set('page', '2');
  return `/api/tasks?${query}`;
}

async function operator(people: Contributor[]) {
  const etags = new Map<string, [string, unknown]>();
  const watching = browse();
  while (loading) {
    const page = await send<TaskPage>('list page', chance(0.7) ? watching : browse(), undefined, undefined, etags);
    await send('health', '/api/health');
    // Reviews wait in the attention queue, so look there now and then.
    const review = chance(0.5) ? await send<TaskPage>('list page', browse('attention')) : null;
    const seen = review?.body.tasks?.length ? review : page;
    const task = seen?.body.tasks?.length ? pick(seen.body.tasks) : null;
    if (task) {
      await send('detail', `/api/tasks/${task.id}`, undefined, undefined, etags);
      const actions =
        task.status === 'in_review' ? ['approve', 'request_changes']
        : task.status === 'needs_attention' ? ['reroute', 'assign', 'cancel']
        : task.status === 'routing' ? ['assign', 'stop_routing', 'reroute']
        : task.status === 'offered' ? ['withdraw', 'assign']
        : [];
      if (actions.length && chance(0.4)) {
        const action = pick(actions);
        const body = {
          action,
          expectedVersion: task.version,
          reason: 'stress',
          ...(action === 'approve' && { rating: 4 }),
          ...(action === 'assign' && { contributorId: pick(people.filter((p) => p.branch === task.branch)).id }),
        };
        const reply = await send<TaskSummary>('command', `/api/tasks/${task.id}/commands`, body, randomUUID());
        if (reply?.status === 200) confirmed(reply.body);
      }
    }
    await sleep(200 + Math.random() * 400);
  }
}

async function responder() {
  while (loading) {
    const page = await send<TaskPage>('list page', browse('assigned'));
    const task = page?.body.tasks?.length ? pick(page.body.tasks) : null;
    if (task?.assignee && task.status !== 'in_review') {
      const action =
        task.status === 'offered' ? (chance(0.8) ? 'accept' : 'decline')
        : task.status === 'accepted' ? (chance(0.9) ? 'start' : 'fail')
        : chance(0.3) ? 'update' : 'submit_work';
      const body = { action, assignmentId: task.assignee.assignmentId, reason: 'stress' };
      const key = randomUUID();
      const path = `/api/tasks/${task.id}/responses`;
      const replies = await Promise.all(Array.from({ length: chance(0.1) ? 2 : 1 }, () => send<TaskSummary>('response', path, body, key)));
      for (const reply of replies) if (reply?.status === 200) confirmed(reply.body);
    }
    await sleep(20 + Math.random() * 60);
  }
}

async function leaveAndReturn(people: Contributor[]) {
  while (loading) {
    const person = pick(people);
    const path = `/api/contributors/${person.id}/availability`;
    await send('availability', path, { available: false }, randomUUID());
    await sleep(700);
    await send('availability', path, { available: true }, randomUUID());
  }
}

async function chaos() {
  while (loading) {
    await sleep(n('kill-every'));
    if (!loading) return;
    const port = pick(ports);
    const child = servers.get(port)!;
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await gone;
    kills++;
    await sleep(200);
    await start(port);
  }
}

// ------------------------------------------------------------------ run

console.log(
  `${n('tasks')} new tasks (+${n('preload')} preloaded), ${n('instances')} instances, ${n('creators')} creators, ` +
    `${n('operators')} operators, ${n('responders')} responders, SIGKILL every ${n('kill-every') || '-'}ms`,
);
await Promise.all(ports.map(start));
const people = (await send<Contributor[]>('contributors', '/api/contributors'))!.body;
const began = performance.now();
const background = [
  ...Array.from({ length: n('operators') }, () => operator(people)),
  ...Array.from({ length: n('responders') }, responder),
  leaveAndReturn(people),
  ...(n('kill-every') ? [chaos()] : []),
];
await Promise.all(Array.from({ length: n('creators') }, creator));
const loadSeconds = (performance.now() - began) / 1000;
loading = false;
await Promise.all(background);

// Wait for all work that can finish to finish.
const drainStart = performance.now();
const outstanding = () =>
  (db.prepare(
    `SELECT (SELECT COUNT(*) FROM jobs WHERE dead_at IS NULL)
          + (SELECT COUNT(*) FROM engine_jobs WHERE delivered_at IS NULL AND deliver_at IS NOT NULL) AS n`,
  ).get() as { n: number }).n;
while (outstanding() > 0 && performance.now() - drainStart < 120_000) await sleep(200);
await sleep(1000);
const drainSeconds = (performance.now() - drainStart) / 1000;
for (const child of servers.values()) child.kill('SIGKILL');

// ------------------------------------------------------------------ verdict

const zero = (sql: string) => (db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get() as { n: number }).n;
const stored = new Map(
  (db.prepare('SELECT id, title, version FROM tasks').all() as { id: string; title: string; version: number }[]).map(
    (t) => [t.id, t],
  ),
);
const created = [...acknowledgedCreates];

const checks: [string, number][] = [
  ['acknowledged creates missing from the database', created.filter(([title, id]) => stored.get(id)?.title !== title).length],
  ['retries of one create that returned different tasks', mismatchedDuplicates.length],
  ['tasks created more than once', zero('SELECT title FROM tasks GROUP BY title HAVING COUNT(*) > 1')],
  ['requested tasks that never arrived', n('tasks') - zero(`SELECT DISTINCT title FROM tasks WHERE title LIKE 'stress-%'`)],
  ['confirmed changes rolled back', [...acknowledgedVersions].filter(([id, v]) => (stored.get(id)?.version ?? 0) < v).length],
  ['tasks with two active assignees', zero(`SELECT task_id FROM assignments WHERE status IN ('offered','accepted','in_progress','in_review') GROUP BY task_id HAVING COUNT(*) > 1`)],
  ['routing answers applied twice', zero(`SELECT task_id, summary FROM events WHERE type IN ('matched','no_match','late_response','rejected_match') GROUP BY task_id, summary HAVING COUNT(*) > 1`)],
  ['matched requests without exactly one assignment', zero(`SELECT r.id FROM routing_requests r LEFT JOIN assignments a ON a.request_id = r.id WHERE (r.state = 'matched') <> (a.id IS NOT NULL)`)],
  ['task state disagreeing with its assignment', zero(
    `SELECT t.id FROM tasks t LEFT JOIN assignments a ON a.task_id = t.id AND a.status IN ('offered','accepted','in_progress','in_review','completed')
     WHERE CASE WHEN t.status IN ('offered','accepted','in_progress','in_review','completed') THEN a.status IS NOT t.status ELSE a.id IS NOT NULL END`)],
  ['task state disagreeing with its routing request', zero(
    `SELECT t.id FROM tasks t LEFT JOIN routing_requests r ON r.task_id = t.id AND r.state = 'pending'
     WHERE (t.status = 'routing') <> (r.id IS NOT NULL)`)],
  ['answers received but never applied', zero(
    `SELECT e.request_id FROM engine_jobs e JOIN routing_requests r ON r.id = e.request_id
     WHERE e.delivered_at IS NOT NULL AND r.returned_at IS NULL`)],
  ['due answers never received', zero(`SELECT request_id FROM engine_jobs WHERE delivered_at IS NULL AND deliver_at IS NOT NULL`)],
  ['pending requests that never reached the engine', zero(
    `SELECT r.id FROM routing_requests r LEFT JOIN engine_jobs e ON e.request_id = r.id WHERE r.state = 'pending' AND e.request_id IS NULL`)],
  ['work records disagreeing with approved work', zero(
    `SELECT w.contributor_id FROM work_records w WHERE w.completed <>
       (SELECT COUNT(*) FROM assignments a WHERE a.contributor_id = w.contributor_id AND a.status = 'completed')`)],
  ['stored workload disagreeing with open assignments', zero(
    `SELECT c.id FROM contributors c LEFT JOIN assignments a ON a.contributor_id = c.id
       AND a.status IN ('offered','accepted','in_progress','in_review') LEFT JOIN tasks t ON t.id = a.task_id
     GROUP BY c.id HAVING c.active_count <> COUNT(a.id) OR ABS(c.load_hours - COALESCE(SUM(
       CASE WHEN a.status <> 'in_review' THEN t.estimate_hours END), 0)) > 0.01`)],
  ['two assistant cases open on one task', zero(`SELECT task_id FROM agent_cases WHERE status = 'open' GROUP BY task_id HAVING COUNT(*) > 1`)],
  ['open cases describing a task that has moved on', zero(
    `SELECT c.id FROM agent_cases c JOIN tasks t ON t.id = c.task_id WHERE c.status = 'open' AND (c.task_version <> t.version OR t.queue_rank <> 0)`)],
  ['assistant investigations that broke', zero('SELECT id FROM agent_cases WHERE failed = 1')],
  ['jobs left in the queue', zero('SELECT id FROM jobs WHERE dead_at IS NULL')],
  ['jobs given up on', zero('SELECT id FROM jobs WHERE dead_at IS NOT NULL')],
  ['unexpected HTTP responses', unexpected.length],
  ['requests the client gave up on', tally['gave up'] ?? 0],
];
const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
checks.push(['database integrity problems', integrity === 'ok' ? 0 : 1]);

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
console.log(`\nLoad ${loadSeconds.toFixed(1)}s (${Math.round(n('tasks') / loadSeconds)} tasks/s), drain ${drainSeconds.toFixed(1)}s, ${kills} SIGKILLs`);
console.table(
  Object.fromEntries(
    Object.entries(latency).map(([kind, ms]) => {
      ms.sort((a, b) => a - b);
      return [kind, { requests: ms.length, p50: Math.round(percentile(ms, 0.5)), p95: Math.round(percentile(ms, 0.95)), p99: Math.round(percentile(ms, 0.99)), max: Math.round(ms.at(-1)!) }];
    }),
  ),
);
console.log(tally);
console.log('\nGuarantees');
for (const [name, bad] of checks) console.log(`  ${bad === 0 ? 'PASS' : 'FAIL'}  ${name}: ${bad}`);
const stillPending = zero(`SELECT id FROM routing_requests WHERE state = 'pending'`);
console.log(`Assistant: ${zero('SELECT id FROM agent_cases')} cases written, ${zero('SELECT id FROM tasks WHERE triage = 1')} tasks still waiting.`);
console.log(`\n${stored.size} tasks stored. ${stillPending} requests still pending (the engine never answers about 20%).`);
for (const line of unexpected.slice(0, 5)) console.log(line);
const logged = serverErrors.join('');
if (logged) console.log(`\nServer error output (first 1500 characters):\n${logged.slice(0, 1500)}`);

db.close();
rmSync(dir, { recursive: true, force: true });
process.exit(checks.some(([, bad]) => bad !== 0) ? 1 : 0);
