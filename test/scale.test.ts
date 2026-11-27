/** Behaviour that matters once there is load, several operators, and things going wrong. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { createApp } from '../server/api.ts';
import { openDatabase } from '../server/db.ts';
import { InvalidError, StaleError } from '../server/errors.ts';
import { MAX_ATTEMPTS } from '../server/queue.ts';
import { OVERDUE_AFTER_MS, PAGE_SIZE } from '../server/service.ts';
import { setup } from './helpers.ts';

const quiet = (t: TestContext) => t.mock.method(console, 'error', () => {});

/** Two services sharing one database file, as two app instances would. */
function twoInstances(run: (a: ReturnType<typeof setup>, b: ReturnType<typeof setup>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'router-'));
  try {
    const path = join(dir, 'app.db');
    const a = setup(path);
    const b = setup(path);
    run(a, b);
    a.db.close();
    b.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('queue', () => {
  test('one request the engine rejects does not hold back the others, and ends up with a person', (t) => {
    quiet(t);
    const h = setup();
    const bad = h.create({ title: 'bad' });
    const good = h.create({ title: 'good' });
    const real = h.engine.submit.bind(h.engine);
    t.mock.method(h.engine, 'submit', (input: Parameters<typeof real>[0], now: number) => {
      if (input.task.id === bad) throw new Error('payload rejected');
      real(input, now);
    });

    h.advance(6_000);
    assert.equal(h.task(good).status, 'offered');
    assert.equal(h.task(bad).status, 'routing');

    for (let i = 1; i < MAX_ATTEMPTS; i++) h.advance(60_000);
    assert.equal(h.task(bad).attentionReason, 'routing_error');
    assert.equal(h.service.health().deadJobs, 1);
    assert.equal(h.service.detail(bad).events.at(-1)!.note, 'payload rejected');
    h.command(bad, { action: 'assign', contributorId: 'ana' });
    assert.equal(h.task(bad).status, 'offered');
    assert.equal(h.service.health().deadJobs, 0, 'dealt with, so no longer reported');
  });

  for (const [name, raw] of [
    ['an unknown contributor', '{"outcome":"match","contributorId":"ghost"}'],
    ['broken JSON', '{"outcome":'],
    ['an unknown shape', '{"result":"ok"}'],
  ] as const) {
    test(`an answer with ${name} is not retried forever`, (t) => {
      quiet(t);
      const h = setup();
      const id = h.create();
      h.drain();
      h.db.prepare('UPDATE engine_jobs SET response = ?').run(raw);
      h.advance(6_000);
      assert.equal(h.task(id).attentionReason, 'routing_error');
      assert.equal(h.service.health().deadJobs, 1);
    });
  }

  test('high priority goes first, but old low priority work is not starved', () => {
    const h = setup();
    const oldLow = h.create({ priority: 'low' });
    h.clock.now += 120_000;
    const normal = h.create({ priority: 'normal' });
    const high = h.create({ priority: 'high' });
    const order = h.db
      .prepare('SELECT r.task_id AS id FROM jobs j JOIN routing_requests r ON r.id = j.request_id ORDER BY j.rank, j.id')
      .all()
      .map((r) => (r as { id: string }).id);
    assert.deepEqual(order, [oldLow, high, normal]);
  });

  test('a large burst is processed in bounded batches', () => {
    const h = setup();
    for (let i = 0; i < 1_200; i++) h.create();
    assert.equal(h.service.tick().more, true, 'one tick does not take everything');
    h.advance(6_000);
    assert.equal(h.service.health().queuedJobs, 0);
    assert.equal(h.service.list({ queue: 'assigned' }).total, 1_200);
  });

  test('two instances on one database never process a request twice', () => {
    twoInstances((a, b) => {
      const ids = Array.from({ length: 40 }, () => a.create());
      for (const h of [b, a]) h.service.tick();
      for (const h of [a, b]) h.clock.now += 6_000;
      for (let i = 0; i < 5; i++) for (const h of [a, b]) h.service.tick();
      for (const id of ids) {
        assert.equal(a.service.detail(id).assignments.length, 1);
        assert.equal(a.events(id).filter((e) => e === 'matched').length, 1);
      }
    });
  });
});

describe('waiting', () => {
  test('a request past the window moves to attention without changing version', () => {
    const h = setup();
    const id = h.create({ scenario: 'never' });
    h.drain();
    const before = h.task(id);
    h.advance(OVERDUE_AFTER_MS + 1);
    h.advance(60_000);
    const after = h.task(id);
    assert.equal(after.queue, 'attention');
    assert.ok(after.overdueSince);
    assert.equal(after.version, before.version);
    assert.equal(h.events(id).filter((e) => e === 'overdue').length, 1);
  });

  test('time spent in our own queue is not blamed on the engine', () => {
    const h = setup();
    const id = h.create({ scenario: 'never' });
    h.clock.now += OVERDUE_AFTER_MS + 1; // no worker ran
    h.drain();
    assert.ok(h.task(id).pendingRequest!.sentAt);
    assert.equal(h.task(id).queue, 'routing', 'the response window starts when it is sent');
  });
});

describe('branches and availability', () => {
  test('routing stays inside the branch; crossing it needs a reason', () => {
    const h = setup();
    const id = h.create({ branch: 'Singapore' });
    h.advance(6_000);
    assert.equal(h.task(id).assignee!.contributorId, 'dee');
    assert.throws(() => h.command(id, { action: 'assign', contributorId: 'ana' }), InvalidError);
    h.command(id, { action: 'assign', contributorId: 'ana', reason: 'Cover for the holiday' });
    assert.match(h.service.detail(id).events.at(-1)!.summary, /Override: in London, not Singapore/);
  });

  test('going on leave returns unanswered offers and flags accepted work', () => {
    const h = setup();
    const offered = h.create({ branch: 'Singapore' });
    const accepted = h.create({ branch: 'Singapore' });
    h.advance(6_000);
    h.respond(accepted, 'accept');
    h.service.setAvailability('dee', false, 'Sick leave', 'op-one');

    assert.equal(h.task(offered).attentionReason, 'contributor_unavailable');
    assert.equal(h.task(accepted).status, 'accepted');
    assert.equal(h.task(accepted).queue, 'attention');
    assert.throws(() => h.command(offered, { action: 'assign', contributorId: 'dee' }), InvalidError);
    assert.deepEqual(h.service.detail(offered).excluded, [], 'being ill does not count against them');

    h.respond(accepted, 'start');
    assert.equal(h.task(accepted).assigneeUnavailable, true);
    h.service.setAvailability('dee', true);
    assert.equal(h.task(accepted).queue, 'assigned');
    h.command(offered, { action: 'reroute', scenario: 'match' });
    h.advance(6_000);
    assert.equal(h.task(offered).assignee!.contributorId, 'dee');
  });

  test('an answer naming someone who left meanwhile makes no offer', () => {
    const h = setup();
    const id = h.create({ branch: 'Singapore' });
    h.drain();
    h.service.setAvailability('dee', false);
    h.advance(6_000);
    assert.equal(h.task(id).attentionReason, 'contributor_unavailable');
    assert.equal(h.task(id).assignee, null);
  });
});

describe('several operators', () => {
  test('the conflict message names who got there first', () => {
    const h = setup();
    const id = h.create({ scenario: 'never' });
    const expectedVersion = h.task(id).version;
    h.service.command(id, { action: 'stop_routing', expectedVersion }, 'op-one');
    assert.throws(
      () => h.service.command(id, { action: 'cancel', expectedVersion }, 'Kai'),
      (e: Error) => e instanceof StaleError && /stopped routing.*\(op-one\)/.test(e.message),
    );
  });

  test('lists are paged, filtered and counted by the database', () => {
    const h = setup();
    for (let i = 0; i < PAGE_SIZE + 5; i++) h.create({ submit: false, title: `draft ${i}` });
    h.create({ submit: false, branch: 'Singapore', title: '100% done_check' });
    const first = h.service.list({ branch: 'London' });
    assert.equal(first.tasks.length, PAGE_SIZE);
    assert.equal(first.counts.draft, PAGE_SIZE + 5);
    assert.equal(h.service.list({ branch: 'London', page: 2 }).tasks.length, 5);
    assert.equal(h.service.list({ search: '100%' }).total, 1);
    assert.equal(h.service.list({ search: 'done_' }).total, 1);
    assert.equal(h.service.list({ search: 't-101' }).total, 1);
  });
});

describe('HTTP under retries', () => {
  async function server(t: TestContext) {
    const h = setup();
    const app = createApp(h.service);
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      app.close();
      app.closeAllConnections();
    });
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    return { h, base, post };
  }
  const task = { title: 'Once', expertise: 'finance', branch: 'London', priority: 'normal', submit: true };

  test('the same key creates one task, however many times it is sent', async (t) => {
    const s = await server(t);
    const key = { 'idempotency-key': 'create-00000001' };
    const replies = await Promise.all(Array.from({ length: 20 }, () => s.post('/api/tasks', task, key)));
    const ids = new Set(await Promise.all(replies.map(async (r) => ((await r.json()) as { id: string }).id)));
    assert.equal(ids.size, 1);
    assert.equal(s.h.service.list().total, 1);
    assert.equal((await s.post('/api/tasks', { ...task, title: 'Different' }, key)).status, 422);
  });

  test('retrying a command replays its success instead of reporting a conflict', async (t) => {
    const s = await server(t);
    const id = s.h.create({ scenario: 'never' });
    const body = { action: 'cancel', expectedVersion: s.h.task(id).version };
    const headers = { 'idempotency-key': 'cancel-00000001', 'x-operator': encodeURIComponent('Zoë 王') };
    const first = await s.post(`/api/tasks/${id}/commands`, body, headers);
    const again = await s.post(`/api/tasks/${id}/commands`, body, headers);
    assert.deepEqual([first.status, again.status], [200, 200]);
    assert.equal(again.headers.get('idempotent-replay'), 'true');
    assert.equal(s.h.events(id).filter((e) => e === 'cancelled').length, 1);
    assert.equal(s.h.service.detail(id).events.at(-1)!.actorName, 'Zoë 王');
  });

  test('a failed attempt is not remembered', async (t) => {
    const s = await server(t);
    const id = s.h.create({ submit: false });
    const path = `/api/tasks/${id}/commands`;
    const headers = { 'idempotency-key': 'retry-000000001' };
    const body = { action: 'assign', contributorId: 'ana', expectedVersion: 1 };
    s.h.service.setAvailability('ana', false);
    assert.equal((await s.post(path, body, headers)).status, 400);
    s.h.service.setAvailability('ana', true);
    assert.equal((await s.post(path, body, headers)).status, 200);
  });

  test('unchanged pages answer 304, and any write invalidates them', async (t) => {
    const s = await server(t);
    s.h.create({ submit: false });
    const first = await fetch(`${s.base}/api/tasks`);
    const etag = first.headers.get('etag')!;
    const get = () => fetch(`${s.base}/api/tasks`, { headers: { 'if-none-match': etag } });
    const same = await get();
    assert.equal(same.status, 304);
    assert.ok(same.headers.get('x-server-time'));
    s.h.create({ submit: false });
    const changed = await get();
    assert.equal(changed.status, 200);
    assert.equal(((await changed.json()) as { total: number }).total, 2);
  });

  test('a write through another instance invalidates this one', () => {
    twoInstances((a, b) => {
      const before = a.service.version();
      b.create();
      assert.notEqual(a.service.version(), before);
    });
  });
});

test('a full disk rejects the change cleanly and work resumes afterwards', async (t) => {
  quiet(t);
  const h = setup();
  const app = createApp(h.service);
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    app.close();
    app.closeAllConnections();
  });
  const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/tasks`;
  const create = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'big', description: 'x'.repeat(1500), expertise: 'finance', branch: 'London',
        priority: 'normal', submit: true, scenario: 'match',
      }),
    });
  const { page_count } = h.db.prepare('PRAGMA page_count').get() as { page_count: number };
  h.db.exec(`PRAGMA max_page_count = ${page_count + 5}`);

  let saved = 0;
  let status = 201;
  while (status === 201 && saved < 500) {
    status = (await create()).status;
    if (status === 201) saved++;
  }
  assert.equal(status, 507);
  assert.equal(h.service.list().total, saved, 'no half-created task');
  const orphans = h.db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'routing' AND id NOT IN (SELECT task_id FROM routing_requests)`)
    .get() as { n: number };
  assert.equal(orphans.n, 0);

  h.db.exec('PRAGMA max_page_count = 1000000');
  assert.equal((await create()).status, 201);
  h.advance(6_000);
  assert.equal(h.service.list({ queue: 'routing' }).total, 0);
});

test('a database from the previous version is refused with an instruction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-'));
  try {
    const path = join(dir, 'app.db');
    const db = openDatabase(path);
    db.exec('PRAGMA user_version = 0');
    db.close();
    assert.throws(() => openDatabase(path), /npm run reset/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
