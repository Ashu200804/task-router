/**
 * What a signed-in person can see and do: their work, what they raised, and requests that
 * are theirs to decide.
 *
 * Sign-in here is for development: choosing a name issues a token, with no password. It shows what
 * each role gets, and is not access control: the operator console needs no sign-in at all.
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type Expertise,
  type MeView,
  type MyTask,
  type Priority,
  type Scenario,
  type TaskSummary,
} from '../shared/types.ts';
import { statement, transaction } from './db.ts';
import { ForbiddenError, InvalidError, NotFoundError, UnauthorizedError } from './errors.ts';
import { classify } from './planner.ts';
import { readRequests } from './requests-read.ts';
import type { Requests } from './requests.ts';
import type { ContributorResponse, TaskService } from './service.ts';
import { SUMMARY, toSummary, type SummaryRow } from './summary.ts';

const SESSION_MS = 12 * 60 * 60_000;

export interface Raised {
  title: string;
  description: string;
  /** Absent: the system works it out from the words used. */
  expertise?: Expertise;
  priority: Priority;
  estimateHours: number;
  minLevel: number;
  dueAt: number | null;
  scenario?: Scenario;
}

export class Accounts {
  #db: DatabaseSync;
  #service: TaskService;
  #requests: Requests;

  constructor(db: DatabaseSync, service: TaskService, requests: Requests) {
    this.#db = db;
    this.#service = service;
    this.#requests = requests;
  }

  signIn(contributorId: string): { token: string; name: string } {
    const person = this.#service.contributors().find((c) => c.id === contributorId);
    if (!person) throw new NotFoundError('That person does not exist.');
    const token = randomBytes(24).toString('base64url');
    statement(this.#db, 'INSERT INTO sessions (token, contributor_id, created_at) VALUES (?, ?, ?)').run(
      token,
      contributorId,
      this.#service.now(),
    );
    return { token, name: person.name };
  }

  who(token: string): string {
    const row = statement(this.#db, 'SELECT contributor_id AS id, created_at AS at FROM sessions WHERE token = ?').get(token) as
      | { id: string; at: number }
      | undefined;
    if (!row || this.#service.now() - row.at > SESSION_MS) throw new UnauthorizedError();
    return row.id;
  }

  me(id: string): MeView {
    const person = this.#service.contributors().find((c) => c.id === id)!;
    const tasks = (sql: string) => (statement(this.#db, `${SUMMARY} ${sql}`).all(id) as unknown as SummaryRow[]).map(toSummary);
    return {
      person,
      work: tasks(
        `WHERE a.contributor_id = ? AND a.status IN ('offered', 'accepted', 'in_progress', 'in_review')
         ORDER BY t.priority_rank, t.created_at LIMIT 50`,
      ),
      raised: tasks('WHERE t.requester_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT 30'),
      inbox: readRequests(this.#db, 'handler', id),
      sent: readRequests(this.#db, 'sender', id),
    };
  }

  /** A task is visible to whoever holds or held it, raised it, or was asked about it. */
  task(id: string, taskId: string): MyTask {
    const detail = this.#service.detail(taskId);
    const roles = this.#requests.roles(detail.task, id);
    const involved =
      roles.holder ||
      roles.requester ||
      detail.requests.some((r) => r.handler?.id === id || r.from.id === id) ||
      statement(this.#db, 'SELECT 1 FROM assignments WHERE task_id = ? AND contributor_id = ?').get(taskId, id) !== undefined;
    if (!involved) throw new ForbiddenError('That task is not yours to see.');
    // Other people's refusals, scores and the routing internals stay with operators.
    return {
      roles,
      requests: detail.requests.filter((r) => roles.holder || roles.requester || r.handler?.id === id || r.from.id === id),
      detail: { ...detail, requests: [], excluded: [] },
    };
  }

  /** Raises a task in the person's branch and sends it straight to routing. */
  raise(id: string, input: Raised): { task: TaskSummary; notes: string[] } {
    return transaction(this.#db, () => {
      const person = this.#service.contributors().find((c) => c.id === id)!;
      const notes: string[] = [];
      let expertise = input.expertise;
      let needs = { estimateHours: input.estimateHours, minLevel: input.minLevel, certification: null as string | null, skills: [] as string[] };
      if (!expertise) {
        const [best, ...others] = classify({ name: input.title, goal: input.description });
        // A wrong guess sends work to the wrong people, so a tie goes back to the person.
        if (!best || others[0]?.words.length === best.words.length) {
          const between = best ? `: it could be ${best.expertise} or ${others[0]!.expertise}` : '';
          throw new InvalidError(`The system could not tell what kind of work this is${between}. Choose the expertise.`);
        }
        expertise = best.expertise;
        needs = { ...needs, certification: best.first.certification, minLevel: Math.max(needs.minLevel, best.first.minLevel) };
        notes.push(`Read as ${expertise} work, from the words ${best.words.map((w) => `“${w}”`).join(', ')}.`);
        if (others.length) {
          notes.push(`It also mentions ${others.map((k) => k.expertise).join(', ')}. Ask a lead to plan it as a project if that work is needed too.`);
        }
      }
      const task = this.#service.createTask(
        { ...input, expertise, branch: person.branch, submit: true, requirements: needs, requesterId: id },
        person.name,
      );
      const eligible = this.#service.candidates(task.id).filter((c) => !c.blockers.length).length;
      notes.push(
        eligible
          ? `Sent to routing. ${eligible} ${eligible === 1 ? 'person' : 'people'} in ${person.branch} can take it.`
          : `Sent to routing, but nobody in ${person.branch} can take it now. If routing finds no one, the assistant will propose options to an operator.`,
      );
      return { task, notes };
    });
  }

  respond(id: string, taskId: string, response: ContributorResponse) {
    return transaction(this.#db, () => {
      const { assignee } = this.#service.detail(taskId).task;
      if (assignee?.contributorId !== id || assignee.assignmentId !== response.assignmentId) {
        throw new ForbiddenError('That assignment is not yours.');
      }
      return this.#service.respond(taskId, response);
    });
  }

  /** The person who raised a task judges the work handed in. */
  review(id: string, taskId: string, input: { decision: 'approve' | 'changes'; rating?: number; feedback?: string; expectedVersion: number }) {
    return transaction(this.#db, () => {
      const { task } = this.#service.detail(taskId);
      if (task.requester?.id !== id) throw new ForbiddenError('Only the person who raised this task can review it here.');
      if (task.assignee?.contributorId === id) throw new ForbiddenError('You cannot review your own work.');
      const name = this.#service.contributors().find((c) => c.id === id)!.name;
      return this.#service.command(
        taskId,
        {
          action: input.decision === 'approve' ? 'approve' : 'request_changes',
          rating: input.rating,
          reason: input.feedback,
          expectedVersion: input.expectedVersion,
        },
        name,
      );
    });
  }
}
