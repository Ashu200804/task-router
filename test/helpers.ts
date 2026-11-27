import { Agent } from '../server/agent/agent.ts';
import { openDatabase, transaction } from '../server/db.ts';
import { RoutingEngine } from '../server/engine.ts';
import { TaskService, type NewTask, type OperatorCommand } from '../server/service.ts';
import type { Branch, ContributorAction, Expertise } from '../shared/types.ts';

const PEOPLE: [string, Branch, Expertise[]][] = [
  ['ana', 'London', ['finance']],
  ['ben', 'London', ['finance']],
  ['cy', 'London', ['healthcare']],
  ['dee', 'Singapore', ['finance']],
];

/** A service on a fresh database with a clock the test controls. */
export function setup(path = ':memory:', random: () => number = () => 0.5) {
  const db = openDatabase(path);
  transaction(db, () => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO contributors (id, name, branch, expertise, profile) VALUES (?, ?, ?, ?, ?)',
    );
    // Effectively unlimited hours, so that only the capacity tests are about capacity.
    const profile = JSON.stringify({ weeklyHours: 1_000_000 });
    for (const [id, branch, expertise] of PEOPLE) insert.run(id, id, branch, JSON.stringify(expertise), profile);
  });
  const clock = { now: 1_000_000 };
  const engine = new RoutingEngine(db, random);
  const service = new TaskService(db, engine, { now: () => clock.now, batchBudgetMs: 1000 });

  const h = {
    db,
    clock,
    engine,
    service,
    create: (input: Partial<NewTask> = {}) =>
      service.createTask({
        title: 'Task',
        description: '',
        expertise: 'finance',
        branch: 'London',
        priority: 'normal',
        submit: true,
        scenario: 'match',
        ...input,
      }).id,
    agent: new Agent(db, service),
    /** Investigates everything flagged. */
    triage() {
      h.agent.sweep(10_000);
      return h.agent.list().cases;
    },
    /** Runs background work until none is immediately ready. */
    drain() {
      while (service.tick().more);
    },
    /** Dispatch, move time forward, deliver. */
    advance(ms: number) {
      h.drain();
      clock.now += ms;
      h.drain();
    },
    task: (id: string) => service.detail(id).task,
    command: (id: string, command: Omit<OperatorCommand, 'expectedVersion'>) =>
      service.command(id, { ...command, expectedVersion: h.task(id).version }),
    respond: (id: string, action: ContributorAction, reason?: string) =>
      service.respond(id, { action, reason, assignmentId: h.task(id).assignee!.assignmentId }),
    /** Submits and approves, for tests that only need finished work. */
    finish(id: string, rating = 4) {
      h.respond(id, 'submit_work', 'Done');
      h.command(id, { action: 'approve', rating });
    },
    events: (id: string) => service.detail(id).events.map((e) => e.type),
  };
  return h;
}
