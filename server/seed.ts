/**
 * A small starting set of contributors and tasks, loaded when the database is empty.
 * Names are placeholders. Task history is produced by running the real service against a
 * clock set in the past, so seeded tasks obey the same rules as ones created in the console.
 * Start with SEED=off to begin empty.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ContributorAction, Expertise, Priority } from '../shared/types.ts';
import { statement, transaction } from './db.ts';
import { RoutingEngine } from './engine.ts';
import { importContributors } from './import.ts';
import { TaskService } from './service.ts';

const person = (id: string, name: string, title: string, levels: Partial<Record<Expertise, number>>, lead = false) => ({
  id,
  name,
  title,
  branch: 'London',
  levels,
  lead,
});

/** Nobody covers "legal", so routing a legal task shows the no-match path. */
const CONTRIBUTORS = [
  person('seed-a', 'Contributor A', 'Finance Lead', { finance: 5, operations: 3 }, true),
  person('seed-b', 'Contributor B', 'Finance Analyst', { finance: 3 }),
  person('seed-c', 'Contributor C', 'Clinical Lead', { healthcare: 5 }, true),
  person('seed-d', 'Contributor D', 'Clinical Specialist', { healthcare: 3 }),
  person('seed-e', 'Contributor E', 'Data Lead', { 'data analysis': 5 }, true),
  person('seed-f', 'Contributor F', 'Operations Lead', { operations: 4 }, true),
];

const MINUTE = 60_000;

export function seedIfEmpty(db: DatabaseSync, now = Date.now()): void {
  // One transaction, so two instances starting together cannot both seed.
  transaction(db, () => {
    const { n } = statement(db, 'SELECT COUNT(*) AS n FROM contributors').get() as { n: number };
    if (n === 0) seed(db, now);
  });
}

function seed(db: DatabaseSync, now: number): void {
  importContributors(db, { contributors: CONTRIBUTORS });

  let clock = now;
  const service = new TaskService(db, new RoutingEngine(db), { now: () => clock });
  const at = (minutesAgo: number) => (clock = now - minutesAgo * MINUTE);
  const task = (title: string, description: string, expertise: Expertise, priority: Priority, submit = false) =>
    service.createTask({
      title,
      description,
      expertise,
      priority,
      branch: 'London',
      submit,
      ...(submit && { scenario: 'never' as const }),
    }).id;
  const current = (id: string) => service.detail(id).task;
  const assign = (id: string, contributorId: string) =>
    service.command(id, { action: 'assign', contributorId, expectedVersion: current(id).version });
  const respond = (id: string, action: ContributorAction, reason?: string) =>
    service.respond(id, { action, reason, assignmentId: current(id).assignee!.assignmentId });

  // Routine work, finished.
  at(190);
  const done = task('Reconcile vendor invoices', 'Match invoices to purchase orders and list differences.', 'finance', 'normal');
  assign(done, 'seed-a');
  at(180);
  respond(done, 'accept');
  respond(done, 'start');
  at(60);
  respond(done, 'submit_work', 'Differences listed.');
  service.command(done, { action: 'approve', rating: 4, expectedVersion: current(done).version });

  // Declined, waiting for an operator to decide.
  at(55);
  const declined = task('Review patient intake protocol', 'Check the revised intake flow before the pilot.', 'healthcare', 'high');
  assign(declined, 'seed-c');
  at(41);
  respond(declined, 'decline', 'No capacity this week.');

  at(30);
  const working = task('Map the returns process', 'Document the current flow and where it stalls.', 'operations', 'normal');
  assign(working, 'seed-f');
  respond(working, 'accept');
  respond(working, 'start');

  at(9);
  const offered = task('Build a retention dashboard', 'Weekly retention by signup group.', 'data analysis', 'normal');
  assign(offered, 'seed-e');

  // Sent to routing and never answered: the unresolved case.
  at(4);
  task('Validate trial dosage figures', 'Needs a second pair of eyes today.', 'healthcare', 'high', true);

  // Drafts to submit: one routine, one that nobody can take.
  at(3);
  task('Forecast next quarter costs', 'Estimate costs from the last four quarters.', 'finance', 'normal');
  at(2);
  task('Check supplier contract terms', 'Flag renewal and price escalation clauses.', 'legal', 'low');
}
