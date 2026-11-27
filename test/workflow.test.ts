/** Delegation, planning, review and tracking: the manager's side of the work. */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { createApp } from '../server/api.ts';
import { InvalidError } from '../server/errors.ts';
import { findContributor } from '../server/people.ts';
import { split } from '../server/planner.ts';
import { evaluate, smoothed, type Need, type Person } from '../server/scoring.ts';
import { QUIET_AFTER_MS } from '../server/service.ts';
import type { PlanStep, Profile, WorkRecord } from '../shared/types.ts';
import { setup } from './helpers.ts';

const HOUR = 3_600_000;

const record = (r: Partial<WorkRecord> = {}): WorkRecord => ({
  accepted: 0, declined: 0, failed: 0, completed: 0, onTime: 0, firstPass: 0,
  ratingSum: 0, ratingCount: 0, responses: 0, responseMs: 0, ...r,
});
const proven = record({ accepted: 20, completed: 20, onTime: 19, firstPass: 18, ratingSum: 92, ratingCount: 20, responses: 20 });

const someone = (over: Partial<Person> = {}, profile: Partial<Profile> = {}): Person => ({
  id: 'p', name: 'P', branch: 'London', available: true, expertise: ['finance'], loadHours: 0, record: record(),
  ...over,
  profile: {
    title: 'Analyst', team: 'Finance', seniority: 'mid', lead: false, levels: { finance: 3 }, skills: [],
    certifications: [], languages: [], weeklyHours: 40, joined: '', ...profile,
  },
});
const need: Need = {
  branch: 'London', expertise: 'finance', priority: 'normal', minLevel: 3, certification: null, skills: [], estimateHours: 8,
};

describe('choosing a person', () => {
  test('hard requirements are reported, each with its reason', () => {
    const unfit = someone(
      { available: false, branch: 'Singapore', loadHours: 36 },
      { levels: { finance: 2 } },
    );
    const { blockers } = evaluate(unfit, { ...need, certification: 'CFA' });
    assert.deepEqual(
      blockers.map((b) => b.split(/[ ,]/)[0]),
      ['unavailable', 'in', 'finance', 'lacks', 'over'],
    );
  });

  test('a newcomer is neither perfect nor hopeless', () => {
    assert.ok(smoothed(1, 1) < 0.85);
    assert.ok(smoothed(0, 1) > 0.5);
    const fresh = evaluate(someone(), need);
    const strong = evaluate(someone({ record: proven }), need);
    assert.equal(fresh.lowData, true);
    assert.ok(strong.score > fresh.score);
    assert.ok(fresh.score > 40);
  });

  test('priority changes what matters: urgent favours record, low priority favours free time', () => {
    const busyStar = someone({ record: proven, loadHours: 30 });
    const freeNewcomer = someone({ loadHours: 0 });
    const order = (priority: Need['priority']) =>
      evaluate(busyStar, { ...need, priority }).score - evaluate(freeNewcomer, { ...need, priority }).score;
    assert.ok(order('high') > 0);
    assert.ok(order('low') < 0);
  });

  test('the factors add up to the score and never exceed their weight', () => {
    const c = evaluate(someone({ record: proven }, { levels: { finance: 5 } }), need);
    assert.ok(Math.abs(c.factors.reduce((s, f) => s + f.points, 0) - c.score) < 0.11);
    assert.ok(c.factors.every((f) => f.points >= 0 && f.points <= f.max));
    assert.equal(c.factors.reduce((s, f) => s + f.max, 0), 100);
  });

  test('routing never offers work to someone below the required level or without room', () => {
    const h = setup();
    h.db.prepare(`UPDATE contributors SET profile = '{"weeklyHours":10,"levels":{"finance":2}}' WHERE id = 'ana'`).run();
    h.db.prepare(`UPDATE contributors SET profile = '{"weeklyHours":10,"levels":{"finance":5}}' WHERE id = 'ben'`).run();
    const first = h.create({ requirements: { minLevel: 4, estimateHours: 8 } });
    h.advance(6_000);
    assert.equal(h.task(first).assignee!.contributorId, 'ben');
    const second = h.create({ requirements: { minLevel: 4, estimateHours: 8 } });
    h.advance(6_000);
    assert.equal(h.task(second).attentionReason, 'no_match');
    assert.throws(() => h.command(second, { action: 'assign', contributorId: 'ben' }), /over capacity/);
    h.command(second, { action: 'assign', contributorId: 'ben', reason: 'Agreed overtime' });
    assert.match(h.service.detail(second).events.at(-1)!.summary, /Override: over capacity/);
  });

  test('a burst cannot push anyone past capacity; routing retries with fresh workloads', () => {
    const h = setup();
    for (const id of ['ana', 'ben']) {
      h.db.prepare(`UPDATE contributors SET profile = '{"weeklyHours":20}' WHERE id = ?`).run(id);
    }
    const ids = Array.from({ length: 12 }, () => h.create({ requirements: { estimateHours: 8 } }));
    for (let i = 0; i < 6; i++) h.advance(6_000);
    for (const id of ['ana', 'ben']) assert.ok(findContributor(h.db, id)!.loadHours <= 20);
    const statuses = ids.map((id) => h.task(id).status);
    assert.equal(statuses.filter((s) => s === 'offered').length, 4, 'two each fit');
    assert.equal(statuses.filter((s) => s === 'needs_attention').length, 8, 'the rest reach a person');
  });
});

describe('splitting a brief', () => {
  const brief = {
    name: 'Supplier contract review',
    goal: 'Analyse spend data, assess cost impact and plan the rollout.',
  };

  test('finds the kinds of work and orders them', () => {
    const steps = split(brief);
    assert.deepEqual(
      [...new Set(steps.map((s) => s.expertise))],
      ['data analysis', 'finance', 'legal', 'operations'],
    );
    const seen = new Set<string>();
    for (const step of steps) {
      assert.ok(step.dependsOn.every((k) => seen.has(k)), 'depends only on earlier steps');
      assert.match(step.reason, /mentions/);
      seen.add(step.key);
    }
    assert.ok(steps.at(-1)!.dependsOn.length > 0);
  });

  test('says so when it recognises nothing, and does not invent work', () => {
    const h = setup();
    const plan = h.service.plan({ name: 'Party', goal: 'Cake', branch: 'London', priority: 'low', dueAt: null });
    assert.deepEqual(plan.steps, []);
    assert.match(plan.warnings[0]!, /Add the steps yourself/);
    assert.equal(h.service.list().total, 0, 'previewing creates nothing');
  });

  test('warns when a step has nobody or the deadline cannot be met', () => {
    const h = setup();
    const plan = h.service.plan({ ...brief, branch: 'London', priority: 'high', dueAt: h.clock.now + HOUR });
    assert.ok(plan.warnings.some((w) => /Nobody in London/.test(w)));
    assert.ok(plan.warnings.some((w) => /working hours/.test(w)));
  });
});

const step = (key: string, dependsOn: string[] = [], over: Partial<PlanStep> = {}): PlanStep => ({
  key, title: `Step ${key}`, description: '', expertise: 'finance', minLevel: 1, certification: null,
  skills: [], estimateHours: 4, dependsOn, reason: '', ...over,
});

function project(h: ReturnType<typeof setup>, dueIn = 30 * 24 * HOUR) {
  return h.service.createProject({
    name: 'P', goal: '', branch: 'London', priority: 'normal', dueAt: h.clock.now + dueIn,
    steps: [step('a'), step('b', ['a']), step('c', ['a'])],
  });
}

describe('projects', () => {
  test('created whole or not at all', () => {
    const h = setup();
    assert.throws(
      () =>
        h.service.createProject({
          name: 'Bad', goal: '', branch: 'London', priority: 'low', dueAt: null,
          steps: [step('a'), step('b', ['z'])],
        }),
      InvalidError,
    );
    assert.equal(h.service.list().total, 0);
    assert.equal(h.service.projects().length, 0);
  });

  test('dependent work waits, and release sends only what is ready', () => {
    const h = setup();
    const { id, taskIds } = project(h);
    const [a, b, c] = taskIds as [string, string, string];
    assert.deepEqual(h.task(b).waitingOn, [a]);
    assert.throws(() => h.command(b, { action: 'submit' }), /depends on/);
    assert.deepEqual(h.service.releaseReady(id, 'op-one', 'match').released, [a]);
    assert.deepEqual(h.service.releaseReady(id, 'op-one', 'match').released, [], 'releasing twice does nothing');

    h.command(b, { action: 'assign', contributorId: 'ana' });
    h.respond(b, 'accept');
    assert.throws(() => h.respond(b, 'start'), /depends on/);

    h.advance(6_000);
    h.respond(a, 'accept');
    h.respond(a, 'start');
    h.finish(a);
    h.respond(b, 'start');
    assert.deepEqual(h.service.project(id).ready, [c]);
  });

  test('a step nobody can take is a risk from the day it is planned', () => {
    const h = setup();
    const { id } = h.service.createProject({
      name: 'P', goal: '', branch: 'London', priority: 'low', dueAt: null,
      steps: [step('a', [], { expertise: 'legal' })],
    });
    const report = h.service.project(id);
    assert.equal(report.project.health, 'at_risk');
    assert.match(report.risks[0]!.text, /nobody in London/);
  });

  test('cancelling a prerequisite frees its dependents and records it', () => {
    const h = setup();
    const [a, b] = project(h).taskIds as [string, string];
    h.command(a, { action: 'cancel' });
    assert.deepEqual(h.task(b).waitingOn, []);
    assert.match(h.service.detail(b).events.at(-1)!.summary, /was cancelled/);
  });

  test('health follows the work: on track, at risk, off track, complete', () => {
    const h = setup();
    const { id, taskIds } = project(h);
    const health = () => h.service.project(id).project.health;
    assert.equal(health(), 'on_track');

    const [a] = taskIds as [string];
    h.command(a, { action: 'assign', contributorId: 'ana' });
    h.respond(a, 'accept');
    h.respond(a, 'block', 'No access');
    assert.equal(health(), 'at_risk');
    assert.equal(h.service.project(id).risks[0]!.severity, 'high');

    h.advance(40 * 24 * HOUR);
    assert.equal(health(), 'off_track');

    for (const taskId of taskIds) h.command(taskId, { action: 'cancel' });
    assert.notEqual(health(), 'complete', 'cancelling everything is not finishing');
  });

  test('reports progress by estimated hours and the longest remaining chain', () => {
    const h = setup();
    const { id, taskIds } = project(h);
    const [a] = taskIds as [string];
    assert.equal(h.service.project(id).criticalPathHours, 8);
    h.command(a, { action: 'assign', contributorId: 'ana' });
    h.respond(a, 'accept');
    h.respond(a, 'start');
    h.service.respond(a, { action: 'update', reason: 'Half way', percent: 50, assignmentId: h.task(a).assignee!.assignmentId });
    const report = h.service.project(id);
    assert.equal(report.project.earnedHours, 2);
    assert.equal(report.criticalPathHours, 6);
  });
});

describe('tracking work', () => {
  function working() {
    const h = setup();
    const id = h.create({ submit: false, dueAt: 1_000_000 + 100 * HOUR });
    h.command(id, { action: 'assign', contributorId: 'ana' });
    h.clock.now += HOUR;
    h.respond(id, 'accept');
    h.respond(id, 'start');
    return { h, id };
  }
  const ana = (h: ReturnType<typeof setup>) => findContributor(h.db, 'ana')!;

  test('a progress report does not disturb a manager who is mid-decision', () => {
    const { h, id } = working();
    const { version } = h.task(id);
    h.respond(id, 'update', 'Going well');
    assert.equal(h.task(id).version, version);
    assert.equal(h.service.detail(id).updates.length, 1);
  });

  test('silence is flagged once, and a report clears it', () => {
    const { h, id } = working();
    h.advance(QUIET_AFTER_MS + 1);
    h.advance(HOUR);
    assert.equal(h.task(id).queue, 'attention');
    assert.equal(h.events(id).filter((e) => e === 'quiet').length, 1);
    h.respond(id, 'update', 'Still on it');
    assert.equal(h.task(id).quietSince, null);
    assert.equal(h.task(id).queue, 'assigned');
  });

  test('a blocker stays until someone clears it or the work moves on', () => {
    const { h, id } = working();
    h.respond(id, 'block', 'Waiting on data');
    assert.equal(h.task(id).queue, 'attention');
    h.respond(id, 'update', 'Doing what I can');
    assert.equal(h.task(id).blocker, 'Waiting on data');
    h.command(id, { action: 'unblock', reason: 'Sent today' });
    assert.equal(h.task(id).queue, 'assigned');
    assert.throws(() => h.command(id, { action: 'unblock' }), /no open blocker/);
    h.respond(id, 'block', 'Again');
    h.command(id, { action: 'assign', contributorId: 'ben' });
    assert.equal(h.task(id).blocker, null);
    assert.equal(h.task(id).progress, 0);
  });

  test('work is complete only after review, and the record reflects it', () => {
    const { h, id } = working();
    h.respond(id, 'submit_work', 'First draft');
    assert.equal(h.task(id).status, 'in_review');
    assert.equal(ana(h).record.completed, 0);
    assert.equal(ana(h).loadHours, 0, 'waiting for review takes none of their time');
    assert.throws(() => h.command(id, { action: 'approve' }), /Rate the work/);
    assert.throws(() => h.command(id, { action: 'request_changes' }), /what needs to change/);

    h.command(id, { action: 'request_changes', reason: 'Add the totals' });
    h.respond(id, 'submit_work', 'Second draft');
    h.command(id, { action: 'approve', rating: 5 });

    assert.equal(h.task(id).status, 'completed');
    assert.deepEqual(h.service.detail(id).submissions.map((s) => s.decision), ['changes_requested', 'approved']);
    const r = ana(h).record;
    assert.deepEqual(
      [r.accepted, r.completed, r.onTime, r.firstPass, r.ratingSum, r.responseMs],
      [1, 1, 1, 0, 5, HOUR],
    );
  });

  test('timeliness is judged by submission, not by how slowly it was reviewed', () => {
    const { h, id } = working();
    h.respond(id, 'submit_work', 'On time');
    h.advance(500 * HOUR);
    assert.ok(h.task(id).pastDueSince);
    h.command(id, { action: 'approve', rating: 4 });
    assert.equal(ana(h).record.onTime, 1);
  });

  test('workload follows the work through every ending', () => {
    const { h, id } = working();
    const other = h.create({ submit: false, requirements: { estimateHours: 2.5 } });
    h.command(other, { action: 'assign', contributorId: 'ana' });
    const load = () => [ana(h).activeCount, ana(h).loadHours];
    assert.deepEqual(load(), [2, 6.5]);
    h.respond(id, 'submit_work', 'x');
    assert.deepEqual(load(), [2, 2.5]);
    h.command(id, { action: 'request_changes', reason: 'y' });
    assert.deepEqual(load(), [2, 6.5]);
    h.command(other, { action: 'cancel' });
    h.respond(id, 'submit_work', 'z');
    h.command(id, { action: 'approve', rating: 3 });
    assert.deepEqual(load(), [0, 0]);
  });

  test('an offer taken back does not count against anyone', () => {
    const h = setup();
    const id = h.create({ submit: false });
    h.command(id, { action: 'assign', contributorId: 'ana' });
    h.command(id, { action: 'withdraw' });
    assert.deepEqual(
      Object.values(ana(h).record).filter((v) => v !== 0),
      [],
    );
  });

  test('a person page shows what they hold and what happened', () => {
    const { h, id } = working();
    const page = h.service.person('ana');
    assert.deepEqual(page.tasks.map((t) => t.id), [id]);
    assert.ok(page.activity.some((a) => /accepted the assignment/.test(a.summary)));
  });
});

test('a proposed plan can be sent straight back to create the project', async (t) => {
  const h = setup();
  const app = createApp(h.service);
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    app.close();
    app.closeAllConnections();
  });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const brief = { name: 'Supplier rollout', goal: 'Analyse cost data, check contracts.', branch: 'London', priority: 'low', dueAt: null };

  const plan = (await (await post('/api/plans', brief)).json()) as { steps: Record<string, unknown>[] };
  // As the console sends it: the preview-only fields removed, empty values left as null.
  const steps = plan.steps.map(({ team: _, candidates: __, ...step }) => step);
  assert.ok(steps.some((s) => s.certification === null));
  assert.equal((await post('/api/projects', { ...brief, steps })).status, 201);
  assert.equal(h.service.list().total, steps.length);
});

test('the API rejects unsafe or impossible input', async (t) => {
  const h = setup();
  const app = createApp(h.service);
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    app.close();
    app.closeAllConnections();
  });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) =>
    (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
  const response = { action: 'submit_work', assignmentId: 'x', reason: 'r' };

  assert.equal(await post('/api/tasks/T-101/responses', { ...response, link: 'javascript:alert(1)' }), 400);
  assert.equal(await post('/api/tasks/T-101/responses', { ...response, percent: 140 }), 400);
  assert.equal(await post('/api/tasks/T-101/commands', { action: 'approve', expectedVersion: 1, rating: 9 }), 400);
  assert.equal(await post('/api/projects', { name: 'x', branch: 'London', priority: 'low', steps: [] }), 400);
  assert.equal(await post('/api/projects', { name: 'x', branch: 'London', priority: 'low', steps: [null] }), 400);
  assert.equal(await post('/api/plans', { name: 'cost data', branch: 'London', priority: 'low' }), 200);
  assert.equal((await fetch(`${base}/api/projects/P-none`)).status, 404);
});
