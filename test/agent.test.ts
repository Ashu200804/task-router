/** The assistant: what it concludes, what it may do, and what happens when it goes wrong. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent } from '../server/agent/agent.ts';
import { staffingChoices } from '../server/agent/fallback.ts';
import { MODEL, pseudonyms, type CreateMessage } from '../server/agent/model.ts';
import { TOOLS, toolRunner } from '../server/agent/tools.ts';
import { createApp } from '../server/api.ts';
import { InvalidError, StaleError } from '../server/errors.ts';
import { QUIET_AFTER_MS, OVERDUE_AFTER_MS } from '../server/service.ts';
import type { Candidate, CaseDetail } from '../shared/types.ts';
import { setup } from './helpers.ts';

const quiet = (t: TestContext) => t.mock.method(console, 'error', () => {});
type H = ReturnType<typeof setup>;

const only = (h: H): CaseDetail => {
  const cases = h.triage();
  assert.equal(cases.length, 1);
  return h.agent.get(cases[0]!.id);
};

/** A task ana declined; ben is free. */
function declined(h: H, reason?: string) {
  const id = h.create({ submit: false });
  h.command(id, { action: 'assign', contributorId: 'ana' });
  h.respond(id, 'decline', reason);
  return id;
}

describe('fallback ladder', () => {
  const person = (id: string, codes: Candidate['codes'], extra: Partial<Candidate> = {}): Candidate => ({
    contributorId: id, name: id, title: '', branch: 'London', blockers: codes.map(String), codes, levelGap: 0,
    score: 50, factors: [], lowData: false, loadHours: 36, weeklyHours: 40, ...extra,
  });
  const rungs = (people: Candidate[], hours = 8) => staffingChoices(people, hours).map((c) => [c.rung.name, c.candidate.contributorId]);

  test('goes from bending nothing to bending one rule, in a fixed order', () => {
    const people = [
      person('away', ['branch']),
      person('stretch', ['capacity']),
      person('junior', ['level'], { levelGap: 1 }),
      person('fits', [], { score: 40 }),
      person('better', [], { score: 90 }),
    ];
    const expected = [['eligible', 'better'], ['stretch_capacity', 'stretch'], ['one_level_below', 'junior'], ['other_branch', 'away']];
    assert.deepEqual(rungs(people), expected);
    assert.deepEqual(rungs([...people].reverse()), expected, 'input order does not matter');
  });

  test('never sets aside certification or expertise, two rules at once, or a large overload', () => {
    assert.deepEqual(
      rungs([
        person('uncertified', ['certification']),
        person('unskilled', ['expertise']),
        person('two', ['branch', 'capacity']),
        person('deep', ['level'], { levelGap: 2 }),
        person('swamped', ['capacity'], { loadHours: 45 }),
        person('ill', ['unavailable']),
        person('failed', ['history'], { blockers: ['previously failed this task'] }),
      ]),
      [],
    );
  });
});

describe('investigation', () => {
  test('writes one case with evidence behind every recorded fact, and repeats nothing', () => {
    const h = setup();
    const id = declined(h, 'On leave');
    const c = only(h);
    assert.equal(c.taskId, id);
    assert.equal(c.trigger, 'declined');
    assert.match(c.report.headline, /ana declined/);
    assert.match(c.report.findings[0]!.text, /On leave/);
    const ids = new Set(c.report.evidence.map((e) => e.id));
    for (const f of c.report.findings) {
      if (f.certainty === 'recorded') assert.ok(f.evidence.length);
      assert.ok(f.evidence.every((e) => ids.has(e)));
    }
    assert.ok(c.trace.some((t) => t.tool === 'rank_candidates' && t.ok));
    h.agent.sweep(1000);
    h.agent.sweep(1000);
    assert.equal(h.agent.list().cases.length, 1);
  });

  test('the same data gives the same report', () => {
    const run = () => {
      const h = setup();
      declined(h, 'Busy');
      return only(h).report;
    };
    assert.deepEqual(run(), run());
  });

  test('investigating changes nothing about the task', () => {
    const h = setup();
    const id = declined(h);
    const before = h.service.detail(id);
    h.triage();
    assert.deepEqual(h.service.detail(id), before);
  });

  test('says what it cannot know', () => {
    const h = setup();
    declined(h);
    assert.ok(only(h).report.findings.some((f) => f.certainty === 'unknown'));
  });

  test('does not send someone to the lead who is the problem', () => {
    const h = setup();
    h.db.prepare(`UPDATE contributors SET profile = '{"weeklyHours":100000,"lead":true}' WHERE id = 'ana'`).run();
    declined(h);
    const { options, draftMessage } = only(h).report;
    assert.ok(options.some((o) => /Escalate above the team/.test(o.label)));
    assert.ok(options.every((o) => !/Ask ana/.test(o.label)));
    assert.equal(draftMessage, null);
  });

  test('routine work, including review, opens no case', () => {
    const h = setup();
    const id = h.create();
    h.advance(6_000);
    h.respond(id, 'accept');
    h.respond(id, 'start');
    h.respond(id, 'submit_work', 'x');
    assert.deepEqual(h.triage(), []);
  });

  test('never recommends setting a rule aside', () => {
    const h = setup();
    const id = h.create({ branch: 'Singapore', expertise: 'healthcare' });
    h.advance(6_000);
    assert.equal(h.task(id).attentionReason, 'no_match');
    const { options } = only(h).report;
    const crossing = options.find((o) => o.relaxes.length)!;
    assert.equal(crossing.command!.contributorId, 'cy');
    assert.equal(crossing.recommended, false);
    assert.deepEqual(options.find((o) => o.recommended)!.relaxes, []);
  });

  test('reports a coverage gap and notices a pattern', () => {
    const h = setup();
    for (let i = 0; i < 3; i++) h.create({ expertise: 'legal' });
    h.advance(6_000);
    const cases = h.triage().map((c) => h.agent.get(c.id));
    assert.ok(cases.every((c) => c.report.findings.some((f) => /coverage gap/.test(f.text))));
    const again = declinedLegalPattern(h);
    assert.ok(again.report.findings.some((f) => /pattern/.test(f.text)));
  });
  function declinedLegalPattern(h: H) {
    const ids = Array.from({ length: 3 }, () => declined(h));
    const cases = h.triage();
    return h.agent.get(cases.find((c) => c.taskId === ids.at(-1))!.id);
  }

  test('explains a routing breakdown with the stored error', (t) => {
    quiet(t);
    const h = setup();
    h.create();
    h.drain();
    h.db.prepare('UPDATE engine_jobs SET response = ?').run('{"outcome":"match","contributorId":"ghost"}');
    h.advance(6_000);
    const c = only(h);
    assert.equal(c.trigger, 'routing_error');
    assert.match(c.report.findings[0]!.text, /unknown contributor/);
    assert.match(c.report.findings[1]!.text, /answered, but the answer could not be used/);
    assert.equal(c.report.options[0]!.command!.action, 'assign', 'the local ranking stands in for the engine');
  });

  test('tells a struggling engine from one slow request', () => {
    const h = setup();
    for (let i = 0; i < 6; i++) h.create({ scenario: 'never' });
    h.advance(OVERDUE_AFTER_MS + 1);
    const c = h.agent.get(h.triage()[0]!.id);
    assert.ok(c.report.findings.some((f) => f.certainty === 'unknown'));
    assert.ok(c.report.findings.some((f) => /engine appears to be having trouble/.test(f.text)));
    assert.equal(c.report.options[0]!.command!.action, 'assign');

    const calm = setup();
    calm.create({ scenario: 'never' });
    calm.advance(OVERDUE_AFTER_MS + 1);
    assert.equal(only(calm).report.options[0]!.command!.action, 'reroute');
  });

  test('a new problem replaces the old case; a recurring one is reported again', () => {
    const h = setup();
    const id = h.create({ submit: false });
    h.command(id, { action: 'assign', contributorId: 'ana' });
    h.respond(id, 'accept');
    h.advance(QUIET_AFTER_MS + 1);
    const first = only(h);
    assert.equal(first.trigger, 'no_report');
    h.respond(id, 'start');
    assert.equal(h.agent.get(first.id).status, 'superseded');
    h.advance(QUIET_AFTER_MS + 1);
    h.respond(id, 'update', 'here');
    h.advance(QUIET_AFTER_MS + 1);
    assert.equal(only(h).trigger, 'no_report');
    h.respond(id, 'block', 'No access');
    const blocked = only(h);
    assert.equal(blocked.trigger, 'blocked');
    assert.equal(h.agent.list({ taskId: id }).cases.filter((c) => c.status === 'open').length, 1);
  });

  test('a broken investigation is reported, not lost or retried forever', (t) => {
    quiet(t);
    const h = setup();
    declined(h);
    t.mock.method(h.service, 'candidates', () => {
      throw new Error('ranking exploded');
    });
    const c = only(h);
    assert.equal(c.failed, true);
    assert.match(c.report.findings[0]!.text, /ranking exploded/);
    assert.ok(c.trace.some((call) => !call.ok && call.error === 'ranking exploded'));
    assert.equal(h.agent.sweep(1000), 0);
  });

  test('two instances never open two cases for one problem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'router-'));
    try {
      const a = setup(join(dir, 'app.db'));
      const b = setup(join(dir, 'app.db'));
      for (let i = 0; i < 20; i++) declined(a);
      b.agent.sweep(10_000);
      a.agent.sweep(10_000);
      assert.equal(a.agent.list().cases.length, 20);
      a.db.close();
      b.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('acting on a case', () => {
  test('nothing happens until a person approves; then it runs as their command', () => {
    const h = setup();
    const id = declined(h);
    const c = only(h);
    const option = c.report.options.find((o) => o.command?.action === 'assign')!;
    const done = h.agent.apply(c.id, option.id, undefined, 'op-one');
    assert.equal(h.task(id).assignee!.contributorId, option.command!.contributorId);
    assert.deepEqual([done.status, done.chosenOption, done.resolvedBy], ['resolved', option.id, 'op-one']);
    assert.equal(h.service.detail(id).events.at(-1)!.actorName, 'op-one');
    assert.throws(() => h.agent.apply(c.id, option.id, undefined), StaleError);
  });

  test('an option cannot run once the task has moved on', () => {
    const h = setup();
    const id = declined(h);
    const c = only(h);
    h.command(id, { action: 'cancel' });
    assert.equal(h.agent.get(c.id).status, 'superseded');
    assert.throws(() => h.agent.apply(c.id, 'o1', undefined), StaleError);
  });

  test('the task version is checked even if a case were wrongly left open', () => {
    const h = setup();
    const id = declined(h);
    const c = only(h);
    h.command(id, { action: 'cancel' });
    h.db.prepare(`UPDATE agent_cases SET status = 'open' WHERE id = ?`).run(c.id);
    assert.throws(() => h.agent.apply(c.id, 'o1', undefined), /changed while you were deciding/);
    assert.equal(h.task(id).status, 'cancelled');
  });

  test('normal guards still apply, and a refused option leaves the case open', () => {
    const h = setup();
    declined(h);
    const c = only(h);
    const option = c.report.options.find((o) => o.command?.action === 'assign')!;
    h.db.prepare('UPDATE contributors SET available = 0 WHERE id = ?').run(option.command!.contributorId!);
    assert.throws(() => h.agent.apply(c.id, option.id, undefined), InvalidError);
    assert.equal(h.agent.get(c.id).status, 'open');
    assert.throws(() => h.agent.apply(c.id, 'o99', undefined), InvalidError);
  });

  test('people record whether it was right; a dismissed case stays dismissed', () => {
    const h = setup();
    const id = h.create({ submit: false });
    h.command(id, { action: 'assign', contributorId: 'ana' });
    h.respond(id, 'accept');
    h.respond(id, 'block', 'x');
    const c = only(h);
    assert.throws(() => h.agent.review(c.id, 'wrong', undefined, false), InvalidError);
    h.agent.review(c.id, 'wrong', 'Not really blocked', true, 'op-one');
    h.respond(id, 'start');
    assert.deepEqual(h.agent.list().reviewed, { correct: 0, wrong: 1 });
    assert.equal(h.agent.get(c.id).verdictNote, 'Not really blocked');
  });
});

describe('tools', () => {
  test('are all read-only', () => {
    const h = setup();
    const id = declined(h);
    const run = toolRunner({ db: h.db, service: h.service, taskId: id });
    const before = h.db.prepare('SELECT total_changes() AS n').get();
    for (const [name, spec] of Object.entries(TOOLS)) {
      const input = Object.fromEntries(Object.keys(spec.inputs).map((k) => [k, k === 'person_id' ? 'ana' : 'declined']));
      run.call(name as keyof typeof TOOLS, input);
    }
    assert.deepEqual(h.db.prepare('SELECT total_changes() AS n').get(), before);
  });

  test('refuse unknown names and unexpected input, and record the refusal', () => {
    const h = setup();
    const run = toolRunner({ db: h.db, service: h.service, taskId: declined(h) });
    assert.throws(() => run.call('delete_task' as never), /no tool/);
    assert.throws(() => run.call('toString' as never), /no tool/);
    assert.throws(() => run.call('get_task', { task_id: 'T-999' }), /takes exactly/);
    assert.deepEqual(run.trace.map((t) => t.ok), [false, false, false]);
  });
});

describe('asking questions', () => {
  test('rules answer from data and admit what is outside them', async () => {
    const h = setup();
    declined(h, 'Busy');
    const c = only(h);
    const why = await h.agent.ask(c.id, 'Why not ana?', 'op-one');
    assert.match(why.text, /previously declined/);
    assert.ok(why.evidence.length);
    assert.match((await h.agent.ask(c.id, 'Who else could do it?')).text, /ben/);
    assert.match((await h.agent.ask(c.id, 'Tell me a joke')).text, /Try one of those/);
    assert.equal(h.agent.get(c.id).messages.length, 3);
  });

  const reply = (content: unknown[], stop_reason = 'end_turn') =>
    ({ content, stop_reason }) as unknown as Anthropic.Beta.BetaMessage;
  const say = (text: string) => reply([{ type: 'text', text }]);
  const use = (name: string, input = {}) => reply([{ type: 'tool_use', id: `u-${name}`, name, input }], 'tool_use');

  function withModel(replies: Anthropic.Beta.BetaMessage[]) {
    const h = setup();
    declined(h, 'ana is busy');
    const c = only(h);
    const sent: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    const model: CreateMessage = async (params) => {
      sent.push(structuredClone(params));
      const next = replies.shift();
      if (!next) throw new Error('connection reset');
      return next;
    };
    const agent = new Agent(h.db, h.service, model);
    return { h, c, sent, ask: (q = 'Why not ana?') => agent.ask(c.id, q) };
  }

  test('a cited model answer is used, with real names restored', async () => {
    const m = withModel([use('rank_candidates'), say('Person-1 declined [E1]; see ranking [T1].')]);
    const answer = await m.ask();
    assert.equal(answer.source, 'model');
    assert.equal(answer.text, 'ana declined [E1]; see ranking [T1].');
    assert.deepEqual(answer.evidence.map((e) => e.id), ['E1', 'T1']);
  });

  test('no real name leaves the system, and only read-only tools are offered', async () => {
    const m = withModel([use('rank_candidates'), use('get_history'), say('Known [E1].')]);
    await m.ask();
    const outgoing = JSON.stringify(m.sent.map((p) => p.messages));
    for (const name of ['ana', 'ben', 'dee']) assert.doesNotMatch(outgoing, new RegExp(`\\b${name}\\b`, 'i'));
    assert.deepEqual(m.sent[0]!.tools!.map((t) => (t as { name: string }).name), Object.keys(TOOLS));
    assert.equal(m.sent[0]!.model, MODEL);
  });

  for (const [name, replies, why] of [
    ['cites nothing', [say('ana is lazy.')], /cited no evidence/],
    ['invents evidence', [say('It was fine [E42].')], /does not exist \(E42\)/],
    ['is refused', [reply([], 'refusal')], /declined to answer/],
    ['is cut off', [reply([], 'max_tokens')], /cut off/],
    ['loops', Array.from({ length: 10 }, () => use('get_task')), /step limit/],
    ['cannot be reached', [], /connection reset/],
  ] as const) {
    test(`a model that ${name} is set aside for the rule-based answer`, async (t) => {
      quiet(t);
      const m = withModel([...replies]);
      const answer = await m.ask();
      assert.equal(answer.source, 'rules');
      assert.match(answer.note!, why);
      assert.match(answer.text, /previously declined/);
    });
  }

  test('a model asking for a tool that does not exist gets an error and changes nothing', async () => {
    const m = withModel([use('cancel_task'), say('I cannot do that [E1].')]);
    const before = m.h.service.detail(m.c.taskId);
    await m.ask('Cancel it');
    assert.match(JSON.stringify(m.sent[1]!.messages.at(-1)), /is_error":true.*no tool called cancel_task/);
    assert.deepEqual(m.h.service.detail(m.c.taskId), before);
  });

  test('placeholders cover first names without clipping other words', () => {
    const mask = pseudonyms(['Kim Alpha', 'Lee Beta']);
    assert.equal(mask.hide('Kim Alpha and kim met Lee; kimono leeway.'), 'Person-1 and Person-1 met Person-2; kimono leeway.');
    assert.equal(mask.show('Person-2 and Person-9'), 'Lee Beta and Person-9');
  });
});

test('the assistant over HTTP', async (t) => {
  const h = setup();
  const app = createApp(h.service, undefined, h.agent);
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    app.close();
    app.closeAllConnections();
  });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/cases`;
  declined(h);
  const c = only(h);
  const post = (path: string, body: unknown, key?: string) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key && { 'idempotency-key': key }) },
      body: JSON.stringify(body),
    });
  assert.equal((await (await fetch(base)).json() as { open: number }).open, 1);
  assert.equal((await post(`/${c.id}/ask`, { question: 'Who else?' })).status, 200);
  assert.equal((await post(`/${c.id}/ask`, {})).status, 400);
  assert.equal((await post(`/${c.id}/review`, { verdict: 'maybe' })).status, 400);
  const option = c.report.options.find((o) => o.command)!.id;
  const first = await post(`/${c.id}/apply`, { optionId: option }, 'apply-case-0001');
  const retry = await post(`/${c.id}/apply`, { optionId: option }, 'apply-case-0001');
  assert.deepEqual([first.status, retry.status], [200, 200]);
});
