import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { StaleError, InvalidError } from '../server/errors.ts';
import { setup } from './helpers.ts';

describe('routine assignment', () => {
  test('moves from routing to completed with a readable history', () => {
    const h = setup();
    const id = h.create();
    assert.equal(h.task(id).status, 'routing');
    h.advance(5_999);
    assert.equal(h.task(id).status, 'routing');
    h.advance(1);
    assert.equal(h.task(id).status, 'offered');
    h.respond(id, 'accept');
    h.respond(id, 'start');
    h.finish(id);
    assert.equal(h.task(id).status, 'completed');
    assert.ok(h.task(id).assignee, 'completed task still shows who did it');
    assert.deepEqual(h.events(id), [
      'created', 'routing_requested', 'matched', 'accepted', 'in_progress', 'submitted', 'completed',
    ]);
  });

  test('only offers to contributors with matching expertise', () => {
    const h = setup();
    const id = h.create({ expertise: 'healthcare' });
    h.advance(6_000);
    assert.equal(h.task(id).assignee?.contributorId, 'cy');
  });

  test('reports no match when nobody is eligible', () => {
    const h = setup();
    const id = h.create({ expertise: 'legal', scenario: 'match' });
    h.advance(6_000);
    assert.equal(h.task(id).status, 'needs_attention');
    assert.equal(h.task(id).attentionReason, 'no_match');
  });

  test('routes several tasks independently', () => {
    const h = setup();
    const quick = h.create();
    const slow = h.create({ scenario: 'slow' });
    const stuck = h.create({ scenario: 'never' });
    h.advance(6_000);
    assert.deepEqual([quick, slow, stuck].map((id) => h.task(id).status), ['offered', 'routing', 'routing']);
    h.advance(39_000);
    assert.deepEqual([quick, slow, stuck].map((id) => h.task(id).status), ['offered', 'offered', 'routing']);
  });
});

describe('unresolved routing', () => {
  test('stays pending indefinitely; the app never invents an outcome', () => {
    const h = setup();
    const id = h.create({ scenario: 'never' });
    h.advance(24 * 60 * 60_000);
    assert.equal(h.task(id).status, 'routing');
    assert.equal(h.task(id).pendingRequest?.attempt, 1);
  });

  test('the operator can try again', () => {
    const h = setup();
    const id = h.create({ scenario: 'never' });
    h.advance(60_000);
    h.command(id, { action: 'reroute', scenario: 'match' });
    h.advance(6_000);
    assert.equal(h.task(id).status, 'offered');
    assert.deepEqual(h.service.detail(id).attempts.map((a) => a.state), ['superseded', 'matched']);
  });
});

describe('intervention while routing is pending', () => {
  for (const [action, expected] of [
    ['assign', 'offered'],
    ['stop_routing', 'needs_attention'],
    ['cancel', 'cancelled'],
  ] as const) {
    test(`a late answer cannot undo "${action}"`, () => {
      const h = setup();
      const id = h.create({ scenario: 'slow' });
      h.advance(1_000);
      h.command(id, { action, contributorId: action === 'assign' ? 'ben' : undefined });
      const before = h.task(id);

      h.advance(60_000);

      assert.deepEqual(h.task(id), before, 'task is untouched, including its version');
      assert.equal(before.status, expected);
      assert.equal(h.events(id).at(-1), 'late_response');
      const [attempt] = h.service.detail(id).attempts;
      assert.equal(attempt!.state, 'superseded');
      assert.ok(attempt!.returnedAt, 'the ignored answer is still recorded');
    });
  }

  test('an old attempt answering first does not resolve the newer attempt', () => {
    const h = setup();
    const id = h.create({ scenario: 'match' });
    h.advance(1_000);
    h.command(id, { action: 'reroute', scenario: 'slow' });
    h.advance(10_000); // attempt 1 has now answered, attempt 2 has not
    assert.equal(h.task(id).status, 'routing');
    assert.equal(h.task(id).pendingRequest?.attempt, 2);
    h.advance(45_000);
    assert.equal(h.task(id).status, 'offered');
  });

  test('if the engine answers first, the operator command is rejected as stale', () => {
    const h = setup();
    const id = h.create();
    const seen = h.task(id).version;
    h.advance(6_000);
    assert.throws(
      () => h.service.command(id, { action: 'assign', contributorId: 'ben', expectedVersion: seen }),
      StaleError,
    );
    assert.equal(h.task(id).status, 'offered');
    assert.equal(h.service.detail(id).assignments.length, 1);
  });

  test('delivering the same answer twice has no further effect', () => {
    const h = setup();
    const id = h.create();
    h.advance(6_000);
    const { attempts, events } = h.service.detail(id);
    h.service.applyRoutingResponse(attempts[0]!.id, { outcome: 'match', contributorId: 'ben' });
    assert.deepEqual(h.service.detail(id).events, events);
    assert.equal(h.service.detail(id).assignments.length, 1);
  });
});

describe('recovery', () => {
  test('after a decline, routing skips the person who declined', () => {
    const h = setup();
    const id = h.create();
    h.advance(6_000);
    const first = h.task(id).assignee!.contributorId;
    h.respond(id, 'decline', 'No capacity');
    assert.equal(h.task(id).attentionReason, 'declined');
    assert.equal(h.task(id).assignee, null);
    assert.equal(h.service.detail(id).assignments[0]!.endReason, 'No capacity');

    h.command(id, { action: 'reroute', scenario: 'match' });
    h.advance(6_000);
    assert.notEqual(h.task(id).assignee!.contributorId, first);

    h.respond(id, 'decline');
    h.command(id, { action: 'reroute', scenario: 'match' });
    h.advance(6_000);
    assert.equal(h.task(id).attentionReason, 'no_match', 'everyone eligible has declined');
  });

  test('a failure after acceptance but before work can be reassigned by hand', () => {
    const h = setup();
    const id = h.create();
    h.advance(6_000);
    h.respond(id, 'accept');
    h.respond(id, 'fail', 'Access never granted');
    assert.equal(h.task(id).attentionReason, 'failed');
    h.command(id, { action: 'assign', contributorId: 'cy', reason: 'Has done this before' });
    assert.equal(h.task(id).status, 'offered');
  });

  test('acceptance completes routing: no direct re-route from accepted', () => {
    const h = setup();
    const id = h.create();
    h.advance(6_000);
    h.respond(id, 'accept');
    assert.throws(() => h.command(id, { action: 'reroute' }), StaleError);
    h.command(id, { action: 'withdraw' });
    h.command(id, { action: 'reroute' });
    assert.equal(h.task(id).status, 'routing');
  });

  test('history names whoever loses a task when it is routed again or cancelled', () => {
    const h = setup();
    const id = h.create();
    h.advance(6_000);
    const first = h.task(id).assignee!.name;
    h.command(id, { action: 'reroute', scenario: 'match' });
    h.advance(6_000);
    const second = h.task(id).assignee!.name;
    h.command(id, { action: 'cancel' });
    const summaries = h.service.detail(id).events.map((e) => e.summary).join('\n');
    assert.match(summaries, new RegExp(`withdrew the assignment from ${first}`));
    assert.match(summaries, new RegExp(`${second}'s assignment ended`));
  });

  test('a response from a contributor who was replaced is rejected', () => {
    const h = setup();
    const id = h.create();
    h.advance(6_000);
    const old = h.task(id).assignee!;
    h.command(id, { action: 'assign', contributorId: old.contributorId === 'ana' ? 'ben' : 'ana' });
    assert.throws(() => h.service.respond(id, { action: 'accept', assignmentId: old.assignmentId }), StaleError);
    assert.equal(h.task(id).status, 'offered');
  });

  test('assigning outside expertise needs a reason', () => {
    const h = setup();
    const id = h.create({ submit: false });
    assert.throws(() => h.command(id, { action: 'assign', contributorId: 'cy' }), InvalidError);
    h.command(id, { action: 'assign', contributorId: 'cy', reason: 'Former auditor' });
    assert.equal(h.task(id).status, 'offered');
  });

  test('a rejected command leaves nothing half done', () => {
    const h = setup();
    const id = h.create({ scenario: 'never' });
    const before = h.service.detail(id);
    assert.throws(() => h.command(id, { action: 'assign', contributorId: 'nobody' }), InvalidError);
    assert.deepEqual(h.service.detail(id), before);
  });
});

test('the database refuses a second active assignee', () => {
  const h = setup();
  const id = h.create();
  h.advance(6_000);
  assert.throws(
    () =>
      h.db
        .prepare(
          `INSERT INTO assignments (id, task_id, contributor_id, status, source, created_at, updated_at)
           VALUES ('x', ?, 'ben', 'accepted', 'operator', 0, 0)`,
        )
        .run(id),
    /UNIQUE/,
  );
});

describe('restart', () => {
  function withFile(run: (path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'router-'));
    try {
      run(join(dir, 'app.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('pending work survives and resolves after the process comes back', () => {
    withFile((path) => {
      const first = setup(path);
      const answered = first.create();
      const stuck = first.create({ scenario: 'never' });
      first.drain();
      first.db.close();

      const second = setup(path);
      second.clock.now += 60_000;
      second.drain();
      assert.equal(second.task(answered).status, 'offered');
      assert.equal(second.task(stuck).status, 'routing');
      second.db.close();
    });
  });

  test('a request recorded but not yet dispatched is sent after restart', () => {
    withFile((path) => {
      const first = setup(path);
      const id = first.create(); // no tick: the process dies here
      first.db.close();

      const second = setup(path);
      second.advance(6_000);
      assert.equal(second.task(id).status, 'offered');
      second.db.close();
    });
  });

  test('an answer that fails to apply is retried after a delay', (t) => {
    const h = setup();
    const id = h.create();
    h.drain();
    h.clock.now += 6_000;
    const apply = t.mock.method(h.service, 'applyRoutingResponse', () => {
      throw new Error('disk full');
    });
    t.mock.method(console, 'error', () => {});
    h.drain();
    assert.equal(h.task(id).status, 'routing');
    apply.mock.restore();
    h.drain();
    assert.equal(h.task(id).status, 'routing', 'backing off, not hammering');
    h.clock.now += 500;
    h.drain();
    assert.equal(h.task(id).status, 'offered');
  });
});
