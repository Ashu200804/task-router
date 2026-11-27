/** Signed-in people: what they can reach, and what happens to their requests. */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test, type TestContext } from 'node:test';
import { Accounts } from '../server/accounts.ts';
import { createApp } from '../server/api.ts';
import { ForbiddenError, InvalidError, UnauthorizedError } from '../server/errors.ts';
import { Requests } from '../server/requests.ts';
import { setup } from './helpers.ts';

const DAY = 86_400_000;

/** ana (finance, lead) raises work; ben ends up doing it. */
function scene() {
  const h = setup();
  h.db.prepare(`UPDATE contributors SET profile = '{"weeklyHours":100000,"lead":true}' WHERE id IN ('ana','cy')`).run();
  const requests = new Requests(h.db, h.service);
  const accounts = new Accounts(h.db, h.service, requests);
  const id = h.create({ requesterId: 'ana', dueAt: h.clock.now + 5 * DAY });
  h.advance(6_000);
  const work = () => {
    h.respond(id, 'accept');
    h.respond(id, 'start');
  };
  return { h, id, requests, accounts, work };
}

describe('raising work', () => {
  test('routing never gives people their own request', () => {
    const { h, id } = scene();
    assert.equal(h.task(id).assignee!.contributorId, 'ben');
  });

  test('a tie between kinds of work is put back to the person', () => {
    const { accounts } = scene();
    const input = { title: 'cost data', description: '', priority: 'low' as const, estimateHours: 1, minLevel: 1, dueAt: null };
    assert.throws(() => accounts.raise('ana', input), /could be data analysis or finance|could be finance or data analysis/);
  });
});

describe('requests', () => {
  test('help asks one level less and excludes the asker', () => {
    const { h, id, requests, work } = scene();
    h.db.prepare('UPDATE tasks SET min_level = 4 WHERE id = ?').run(id);
    work();
    const r = requests.create(id, 'ben', { type: 'help', text: 'check totals', scenario: 'match' });
    const helper = h.task(r.helperTaskId!);
    assert.equal(helper.requirements.minLevel, 3);
    h.advance(6_000);
    assert.equal(h.task(helper.id).assignee!.contributorId, 'ana');
    h.command(helper.id, { action: 'cancel' });
    assert.equal(h.service.detail(id).requests[0]!.status, 'closed');
  });

  for (const ending of ['withdraw', 'decline-or-fail', 'reassign', 'cancel'] as const) {
    test(`a holder's request lapses when the task ends for them: ${ending}`, () => {
      const { h, id, requests, work } = scene();
      work();
      requests.create(id, 'ben', { type: 'extension', text: 'x', days: 5 });
      if (ending === 'withdraw') h.command(id, { action: 'withdraw' });
      if (ending === 'decline-or-fail') h.respond(id, 'fail');
      if (ending === 'reassign') h.command(id, { action: 'assign', contributorId: 'ana', reason: 'x' });
      if (ending === 'cancel') h.command(id, { action: 'cancel' });
      assert.equal(h.service.detail(id).requests[0]!.status, 'closed');
    });
  }

  test('an extension is automatic only when it is small and harmless', () => {
    const { h, id, requests, work } = scene();
    work();
    const due = h.task(id).dueAt!;
    assert.equal(requests.create(id, 'ben', { type: 'extension', text: 'x', days: 1 }).status, 'approved');
    assert.equal(h.task(id).dueAt, due + DAY);
    const second = requests.create(id, 'ben', { type: 'extension', text: 'x', days: 1 });
    assert.deepEqual([second.status, second.handler!.id], ['open', 'ana']);
    assert.throws(() => requests.decide(second.id, 'ben', 'approve', undefined), ForbiddenError);
    assert.throws(() => requests.decide(second.id, 'ana', 'decline', undefined), InvalidError);
    requests.decide(second.id, 'ana', 'decline', 'Needed Friday');
    assert.equal(h.task(id).dueAt, due + DAY);
  });

  test('only people involved may ask, and only for what fits their role', () => {
    const { id, requests, work } = scene();
    assert.throws(() => requests.create(id, 'cy', { type: 'status', text: 'x' }), ForbiddenError);
    assert.throws(() => requests.create(id, 'ben', { type: 'help', text: 'x' }), /Accept the task/);
    work();
    assert.throws(() => requests.create(id, 'ana', { type: 'handover', text: 'x' }), InvalidError);
    assert.throws(() => requests.create(id, 'ben', { type: 'cancel', text: 'x' }), ForbiddenError);
  });

  test('the person who raised it cannot cancel accepted work alone', () => {
    const { h, id, requests, work } = scene();
    work();
    const r = requests.create(id, 'ana', { type: 'cancel', text: 'Not needed' });
    assert.deepEqual([r.status, r.handler!.id], ['open', 'cy'], 'another lead, not themselves');
    assert.equal(h.task(id).status, 'in_progress');
    requests.decide(r.id, 'cy', 'approve', undefined);
    assert.equal(h.task(id).status, 'cancelled');
  });

  test('with nobody suitable, a request goes to the operator, who can decide it', () => {
    const { h, id, requests, work } = scene();
    work();
    h.service.setAvailability('ana', false);
    h.service.setAvailability('cy', false);
    const r = requests.create(id, 'ben', { type: 'question', text: 'VAT?' });
    assert.equal(r.handler, null);
    assert.match(r.routing, /operator console/);
    assert.equal(requests.decide(r.id, null, 'answer', 'No', 'op-one').status, 'resolved');
  });
});

describe('signed-in access', () => {
  async function server(t: TestContext) {
    const s = scene();
    const app = createApp(s.h.service, undefined, s.h.agent, { accounts: s.accounts, requests: s.requests });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      app.close();
      app.closeAllConnections();
    });
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const as = (token: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-session': token, ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { ...s, as, token: (id: string) => s.accounts.signIn(id).token };
  }

  test('a session reaches only its own routes', async (t) => {
    const s = await server(t);
    const cy = s.token('cy');
    for (const path of ['/api/tasks', `/api/tasks/${s.id}`, '/api/contributors', '/api/cases', '/api/projects', '/api/health']) {
      assert.equal((await s.as(cy, path)).status, 403, path);
    }
    for (const path of ['/api/tasks', `/api/tasks/${s.id}/commands`, '/api/contributors/ben/availability']) {
      assert.equal((await s.as(cy, path, { action: 'cancel', expectedVersion: 1, available: false })).status, 403, path);
    }
    assert.equal((await s.as(cy, `/api/me/tasks/${s.id}`)).status, 403);
    assert.equal((await s.as('forged', '/api/me')).status, 401);
  });

  test('one person is never told another’s cached page is unchanged', async (t) => {
    const s = await server(t);
    const first = await s.as(s.token('ana'), '/api/me');
    const other = await s.as(s.token('ben'), '/api/me', undefined, { 'if-none-match': first.headers.get('etag')! });
    assert.equal(other.status, 200);
    assert.equal(((await other.json()) as { person: { id: string } }).person.id, 'ben');
  });

  test('another person cannot replay someone’s idempotency key', async (t) => {
    const s = await server(t);
    const body = { type: 'status', text: 'x' };
    const headers = { 'idempotency-key': 'shared-key-0001' };
    assert.equal((await s.as(s.token('ana'), `/api/me/tasks/${s.id}/requests`, body, headers)).status, 201);
    assert.equal((await s.as(s.token('cy'), `/api/me/tasks/${s.id}/requests`, body, headers)).status, 403);
  });

  test('sessions expire', () => {
    const { h, accounts } = scene();
    const { token } = accounts.signIn('ben');
    h.clock.now += 13 * 3_600_000;
    assert.throws(() => accounts.who(token), UnauthorizedError);
  });
});
