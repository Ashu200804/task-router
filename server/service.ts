/**
 * All task state changes go through this class. Every public mutation is one transaction.
 *
 * Guards against the ways work goes wrong:
 *  - the engine answering after the operator has moved on: an answer is applied only if
 *    its request is still "pending". Anything else that ends routing supersedes it first.
 *  - a person acting on a stale screen: operator commands carry the task version they saw,
 *    contributor responses carry the assignment they are responding to.
 *  - a client repeating a request: an idempotency key replays the first answer.
 *  - background work failing or the process dying: see queue.ts.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CONTRIBUTOR_ACTIONS,
  OPERATOR_ACTIONS,
  QUEUES,
  type Actor,
  type AssignmentRecord,
  type AssignmentStatus,
  type AttentionReason,
  type Branch,
  type Candidate,
  type Contributor,
  type ContributorAction,
  type Expertise,
  type Health,
  type OperatorAction,
  type PersonDetail,
  type Plan,
  type ProjectReport,
  type ProjectSummary,
  type PlanStep,
  type Priority,
  type ProgressUpdate,
  type Queue as QueueName,
  type RequestState,
  type Requirements,
  type RoutingAttempt,
  type Scenario,
  type Submission,
  type TaskDetail,
  type TaskEvent,
  type TaskPage,
  type TaskStatus,
  type TaskSummary,
} from '../shared/types.ts';
import { statement, transaction } from './db.ts';
import { TIMING, type RoutingEngine, type RoutingResponse } from './engine.ts';
import { InvalidError, KeyReusedError, NotFoundError, PermanentError, StaleError } from './errors.ts';
import { addToRecord, allContributors, contributorsIn, findContributor } from './people.ts';
import { review as reviewPlan, scheduleSteps, split } from './planner.ts';
import { listProjects, personDetail, projectReport } from './reports.ts';
import { Queue, type Job } from './queue.ts';
import { readRequests } from './requests-read.ts';
import { evaluate, ranked, type Need } from './scoring.ts';
import { SUMMARY, toSummary, type SummaryRow } from './summary.ts';

/** The engine's documented upper bound plus a little slack for our own polling. */
export const OVERDUE_AFTER_MS = TIMING.normalMaxMs + 5_000;
export const PAGE_SIZE = 50;
const KEY_LIFETIME_MS = 24 * 60 * 60_000;

const ACTIVE = `('offered', 'accepted', 'in_progress', 'in_review')`;
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const DEFAULT_ESTIMATE_HOURS = 4;
/** Accepted work with no report for this long is flagged. */
export const QUIET_AFTER_MS = 24 * 60 * 60_000;
/** How often routing retries by itself when the chosen person filled up in the meantime. */
const CAPACITY_RETRIES = 3;

interface TaskRow {
  id: string;
  title: string;
  expertise: Expertise;
  branch: Branch;
  priority: Priority;
  status: TaskStatus;
  version: number;
  project_id: string | null;
  estimate_hours: number;
  due_at: number | null;
  min_level: number;
  certification: string | null;
  skills: string;
  blocker: string | null;
  requester_id: string | null;
}

interface RequestRow {
  id: string;
  task_id: string;
  attempt: number;
  state: RequestState;
  scenario: Scenario;
  dispatched_at: number | null;
  closed_reason: string | null;
  returned_at: number | null;
}

interface ActiveAssignmentRow {
  id: string;
  contributor_id: string;
  name: string;
  status: AssignmentStatus;
  created_at: number;
  revisions: number;
}

export interface NewTask {
  title: string;
  description: string;
  expertise: Expertise;
  branch: Branch;
  priority: Priority;
  submit: boolean;
  scenario?: Scenario;
  requirements?: Partial<Requirements>;
  dueAt?: number | null;
  requesterId?: string;
}

export interface NewProject {
  name: string;
  goal: string;
  branch: Branch;
  priority: Priority;
  dueAt: number | null;
  steps: PlanStep[];
}

export interface OperatorCommand {
  action: OperatorAction;
  expectedVersion: number;
  contributorId?: string;
  reason?: string;
  scenario?: Scenario;
  /** 1 to 5, required to approve work. */
  rating?: number;
}

export interface ContributorResponse {
  action: ContributorAction;
  assignmentId: string;
  /** Reason, progress note, blocker or submission summary, depending on the action. */
  reason?: string;
  percent?: number;
  hours?: number;
  link?: string;
}

export interface ListQuery {
  branch?: Branch;
  queue?: QueueName;
  search?: string;
  page?: number;
}

export interface ServiceOptions {
  now?: () => number;
  overdueAfterMs?: number;
  quietAfterMs?: number;
  /** How long one batch of background work may hold the process. */
  batchBudgetMs?: number;
}

export class TaskService {
  #db: DatabaseSync;
  #engine: RoutingEngine;
  #queue: Queue;
  #now: () => number;
  #overdueAfterMs: number;
  #quietAfterMs: number;
  #batchBudgetMs: number;
  #lastPurge = 0;

  constructor(db: DatabaseSync, engine: RoutingEngine, options: ServiceOptions = {}) {
    this.#db = db;
    this.#engine = engine;
    this.#queue = new Queue(db);
    this.#now = options.now ?? Date.now;
    this.#overdueAfterMs = options.overdueAfterMs ?? OVERDUE_AFTER_MS;
    this.#batchBudgetMs = options.batchBudgetMs ?? 25;
    this.#quietAfterMs = options.quietAfterMs ?? QUIET_AFTER_MS;
  }

  now(): number {
    return this.#now();
  }

  overdueAfterMs(): number {
    return this.#overdueAfterMs;
  }

  // ---------------------------------------------------------------- background work

  /**
   * One slice of background work: take in engine answers, run queued jobs, flag overdue
   * requests. Bounded, so web requests are served in between. `more` asks to be called again soon.
   */
  tick(): { more: boolean } {
    const now = this.#now();
    // Receiving only records the answer. It is applied by the queue, with retries.
    const moreAnswers = transaction(this.#db, () =>
      this.#engine.deliverDue(now, (requestId, raw) => {
        const row = statement(
          this.#db,
          `SELECT t.priority FROM routing_requests r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?`,
        ).get(requestId) as { priority: Priority } | undefined;
        if (row) this.#queue.add('apply', requestId, row.priority, now, raw);
      }),
    );

    const pools = new Map<string, Contributor[]>();
    const moreJobs = this.#queue.run(
      now,
      (job) => (job.kind === 'dispatch' ? this.#dispatch(job, pools) : this.#applyRaw(job)),
      (job, error) => this.#abandon(job, error),
      this.#batchBudgetMs,
    );
    const moreOverdue = this.#flagOverdue();
    const moreRisks = this.#flagStalledWork();
    this.#purge();
    return { more: moreAnswers || moreJobs || moreOverdue || moreRisks };
  }

  #dispatch(job: Job, pools: Map<string, Contributor[]>): void {
    const request = this.#request(job.request_id);
    if (!request || request.state !== 'pending' || request.dispatched_at !== null) return;
    const task = this.#task(request.task_id);

    // Many requests in a burst share a branch; load its people once per batch.
    let pool = pools.get(task.branch);
    if (!pool) pools.set(task.branch, (pool = contributorsIn(this.#db, task.branch)));

    const now = this.#now();
    this.#engine.submit(
      {
        requestId: request.id,
        scenario: request.scenario,
        task: { id: task.id, title: task.title, expertise: task.expertise, priority: task.priority },
        candidates: this.#evaluate(task, pool)
          .filter((c) => c.blockers.length === 0)
          .map((c) => ({ id: c.contributorId, score: c.score })),
      },
      now,
    );
    // The response window starts when the engine receives it, so any queueing delay flag resets.
    statement(this.#db, 'UPDATE routing_requests SET dispatched_at = ?, overdue_flagged = 0 WHERE id = ?').run(
      now,
      request.id,
    );
    // Touching the task also invalidates cached pages, which show when the request was sent.
    statement(this.#db, 'UPDATE tasks SET overdue_since = NULL WHERE id = ?').run(task.id);
    this.#refreshQueue(task.id);
  }

  #applyRaw(job: Job): void {
    let response: RoutingResponse;
    try {
      response = JSON.parse(job.payload ?? '') as RoutingResponse;
    } catch {
      throw new PermanentError('The engine sent a response that is not valid JSON.');
    }
    const valid =
      response?.outcome === 'no_match' ||
      (response?.outcome === 'match' && typeof response.contributorId === 'string');
    if (!valid) throw new PermanentError('The engine sent a response in an unknown shape.');
    this.applyRoutingResponse(job.request_id, response);
  }

  /** We gave up on a job. The task must not sit in "routing" as if something were still coming. */
  #abandon(job: Job, error: Error): void {
    const request = this.#request(job.request_id);
    if (!request || request.state !== 'pending') {
      // Nobody is waiting on it, so there is nothing for a person to do. The log has the error.
      statement(this.#db, 'DELETE FROM jobs WHERE id = ?').run(job.id);
      return;
    }
    const task = this.#task(request.task_id);
    const what = job.kind === 'dispatch' ? 'could not be sent to the engine' : 'returned an answer that could not be used';
    this.#closeRequest(request.id, 'failed', what);
    this.#setStatus(task, 'needs_attention', 'routing_error');
    this.#log(task.id, 'system', 'routing_error', `Routing attempt ${request.attempt} ${what}.`, { note: error.message });
  }

  /** Safe to call late, twice, or for a request the application has given up on. */
  applyRoutingResponse(requestId: string, response: RoutingResponse): void {
    transaction(this.#db, () => {
      const request = this.#request(requestId);
      if (!request || request.returned_at !== null) return;

      let chosen: Contributor | null = null;
      if (response.outcome === 'match') {
        chosen = findContributor(this.#db, response.contributorId);
        if (!chosen) throw new PermanentError(`The engine selected an unknown contributor (${response.contributorId}).`);
      }
      const now = this.#now();
      statement(
        this.#db,
        'UPDATE routing_requests SET returned_at = ?, returned_contributor_id = ? WHERE id = ?',
      ).run(now, chosen?.id ?? null, requestId);

      if (request.state !== 'pending') {
        // Recorded for the history, but the task itself does not change (and neither does its version).
        const answer = chosen ? `selected ${chosen.name}` : 'found no match';
        this.#log(
          request.task_id,
          'engine',
          'late_response',
          `Late answer to routing attempt ${request.attempt} ignored: it ${answer}, but the attempt was already closed (${request.closed_reason}).`,
        );
        return;
      }

      const task = this.#task(request.task_id);
      if (!chosen) {
        this.#closeRequest(requestId, 'no_match', 'engine found no match');
        this.#setStatus(task, 'needs_attention', 'no_match');
        this.#log(task.id, 'engine', 'no_match', `Routing attempt ${request.attempt} found no eligible contributor.`);
        return;
      }
      // The world may have changed while the engine was thinking.
      const problem = !chosen.available
        ? 'is no longer available'
        : chosen.branch !== task.branch
          ? `has moved to ${chosen.branch}`
          : !chosen.expertise.includes(task.expertise)
            ? `no longer lists ${task.expertise}`
            : null;
      if (problem) {
        this.#closeRequest(requestId, 'failed', `engine selected ${chosen.name}, who ${problem}`);
        this.#setStatus(task, 'needs_attention', 'contributor_unavailable');
        this.#log(
          task.id,
          'engine',
          'rejected_match',
          `Routing attempt ${request.attempt} selected ${chosen.name}, who ${problem}. No offer was made.`,
        );
        return;
      }
      if (chosen.loadHours + task.estimate_hours > chosen.profile.weeklyHours) {
        this.#retryOverCapacity(task, request, chosen.name);
        return;
      }
      this.#closeRequest(requestId, 'matched', 'engine selected a contributor');
      this.#offer(task, chosen.id, 'routing', requestId);
      this.#setStatus(task, 'offered', null);
      this.#log(task.id, 'engine', 'matched', `Routing attempt ${request.attempt} selected ${chosen.name}. Waiting for a response.`, {
        contributorId: chosen.id,
      });
    });
  }

  /**
   * They had room when we asked and do not now: our information was stale, nobody refused.
   * So routing tries again by itself with current workloads, a limited number of times.
   */
  #retryOverCapacity(task: TaskRow, request: RequestRow, name: string): void {
    this.#closeRequest(request.id, 'failed', `engine selected ${name}, who is now at capacity`, 'capacity');
    const { n } = statement(
      this.#db,
      `SELECT COUNT(*) AS n FROM routing_requests WHERE task_id = ? AND closed_code = 'capacity'`,
    ).get(task.id) as { n: number };
    this.#log(
      task.id,
      'engine',
      'rejected_match',
      `Routing attempt ${request.attempt} selected ${name}, who has filled up since it was sent. No offer was made.`,
    );
    if (n < CAPACITY_RETRIES) {
      this.#startRouting(task, request.scenario, { actor: 'system' });
    } else {
      this.#setStatus(task, 'needs_attention', 'over_capacity');
    }
  }

  /** Marks requests that have outlived the normal window. Not a state change: the version stays. */
  #flagOverdue(limit = 500): boolean {
    return transaction(this.#db, () => {
      const now = this.#now();
      const rows = statement(
        this.#db,
        `SELECT id, task_id, attempt, dispatched_at FROM routing_requests
         WHERE state = 'pending' AND overdue_flagged = 0 AND COALESCE(dispatched_at, requested_at) < ?
         LIMIT ?`,
      ).all(now - this.#overdueAfterMs, limit) as unknown as (RequestRow & { task_id: string })[];
      for (const r of rows) {
        statement(this.#db, 'UPDATE routing_requests SET overdue_flagged = 1 WHERE id = ?').run(r.id);
        statement(this.#db, 'UPDATE tasks SET overdue_since = ? WHERE id = ?').run(now, r.task_id);
        this.#refreshQueue(r.task_id);
        this.#log(
          r.task_id,
          'system',
          'overdue',
          r.dispatched_at === null
            ? `Routing attempt ${r.attempt} is still waiting to be sent.`
            : `Routing attempt ${r.attempt} passed the normal response window.`,
        );
      }
      return rows.length === limit;
    });
  }

  /** Flags accepted work that has gone quiet, and open work that has passed its due date. */
  #flagStalledWork(limit = 500): boolean {
    return transaction(this.#db, () => {
      const now = this.#now();
      const quiet = statement(
        this.#db,
        `SELECT id FROM tasks WHERE status IN ('accepted', 'in_progress') AND quiet_since IS NULL
           AND last_activity_at < ? LIMIT ?`,
      ).all(now - this.#quietAfterMs, limit) as { id: string }[];
      for (const { id } of quiet) {
        statement(this.#db, 'UPDATE tasks SET quiet_since = ? WHERE id = ?').run(now, id);
        this.#refreshQueue(id);
        this.#log(id, 'system', 'quiet', 'No progress report for longer than the check-in interval.');
      }
      const late = statement(
        this.#db,
        `SELECT id FROM tasks WHERE due_at IS NOT NULL AND past_due_since IS NULL
           AND status NOT IN ('completed', 'cancelled') AND due_at < ? LIMIT ?`,
      ).all(now, limit) as { id: string }[];
      for (const { id } of late) {
        statement(this.#db, 'UPDATE tasks SET past_due_since = ? WHERE id = ?').run(now, id);
        this.#refreshQueue(id);
        this.#log(id, 'system', 'past_due', 'The due date passed before the work was approved.');
      }
      return quiet.length === limit || late.length === limit;
    });
  }

  #purge(): void {
    const now = this.#now();
    if (now - this.#lastPurge < 60_000) return;
    this.#lastPurge = now;
    statement(this.#db, 'DELETE FROM idempotency_keys WHERE created_at < ?').run(now - KEY_LIFETIME_MS);
  }

  // ---------------------------------------------------------------- commands

  /**
   * Runs `work` at most once per key. The key and the result are committed together with the
   * change, so there is no moment where one exists without the other. Failures are not
   * remembered: nothing changed, so trying again is safe.
   */
  idempotent<T>(key: string | undefined, fingerprint: string, work: () => T): { result: T; replayed: boolean } {
    return transaction(this.#db, () => {
      if (!key) return { result: work(), replayed: false };
      const seen = statement(this.#db, 'SELECT fingerprint, response FROM idempotency_keys WHERE key = ?').get(key) as
        | { fingerprint: string; response: string }
        | undefined;
      if (seen) {
        if (seen.fingerprint !== fingerprint) throw new KeyReusedError();
        return { result: JSON.parse(seen.response) as T, replayed: true };
      }
      const result = work();
      statement(
        this.#db,
        'INSERT INTO idempotency_keys (key, fingerprint, response, created_at) VALUES (?, ?, ?, ?)',
      ).run(key, fingerprint, JSON.stringify(result), this.#now());
      return { result, replayed: false };
    });
  }

  createTask(input: NewTask, operator?: string): TaskSummary {
    return transaction(this.#db, () => {
      const id = this.#insertTask(input, null, operator);
      if (input.submit) this.#startRouting(this.#task(id), input.scenario ?? 'random', { operator });
      return this.#summary(id);
    });
  }

  /**
   * Creates a project and all its tasks together, or nothing. Steps may only depend on
   * earlier steps, so the plan cannot contain a cycle.
   */
  createProject(input: NewProject, operator?: string): { id: string; taskIds: string[] } {
    return transaction(this.#db, () => {
      const id = `P-${randomUUID().slice(0, 8)}`;
      const now = this.#now();
      statement(
        this.#db,
        `INSERT INTO projects (id, name, goal, branch, owner, priority, created_at, due_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.name, input.goal, input.branch, operator ?? null, input.priority, now, input.dueAt);

      const dueDates = scheduleSteps(input.steps, now, input.dueAt);
      const ids = new Map<string, string>();
      for (const step of input.steps) {
        const unknown = step.dependsOn.find((key) => !ids.has(key));
        if (unknown || ids.has(step.key)) {
          throw new InvalidError(`Step "${step.title}" has a duplicate key or depends on a step that does not come before it.`);
        }
        const taskId = this.#insertTask(
          {
            title: step.title,
            description: step.description,
            expertise: step.expertise,
            branch: input.branch,
            priority: input.priority,
            submit: false,
            requirements: step,
            dueAt: dueDates.get(step.key) ?? null,
          },
          id,
          operator,
        );
        for (const key of step.dependsOn) {
          statement(this.#db, 'INSERT OR IGNORE INTO dependencies (task_id, depends_on) VALUES (?, ?)').run(
            taskId,
            ids.get(key)!,
          );
        }
        ids.set(step.key, taskId);
      }
      return { id, taskIds: [...ids.values()] };
    });
  }

  /** Sends every task in the project that is ready to start into routing. */
  releaseReady(projectId: string, operator?: string, scenario: Scenario = 'random'): { released: string[] } {
    return transaction(this.#db, () => {
      const found = statement(this.#db, 'SELECT id FROM projects WHERE id = ?').get(projectId);
      if (!found) throw new NotFoundError('That project does not exist.');
      const drafts = statement(
        this.#db,
        `SELECT t.id FROM tasks t WHERE t.project_id = ? AND t.status = 'draft' AND NOT EXISTS (
           SELECT 1 FROM dependencies d JOIN tasks o ON o.id = d.depends_on
           WHERE d.task_id = t.id AND o.status NOT IN ('completed', 'cancelled'))
         ORDER BY t.created_at, t.id`,
      ).all(projectId) as { id: string }[];
      for (const { id } of drafts) this.#startRouting(this.#task(id), scenario, { operator });
      return { released: drafts.map((d) => d.id) };
    });
  }

  #insertTask(input: NewTask, projectId: string | null, operator?: string): string {
    const { task_seq } = statement(this.#db, 'UPDATE meta SET task_seq = task_seq + 1 RETURNING task_seq').get() as {
      task_seq: number;
    };
    const id = `T-${task_seq}`;
    const now = this.#now();
    const need = input.requirements ?? {};
    statement(
      this.#db,
      `INSERT INTO tasks (id, title, description, expertise, branch, priority, priority_rank, status,
         created_at, status_since, queue_rank, project_id, estimate_hours, due_at, min_level,
         certification, skills, last_activity_at, requester_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.description,
      input.expertise,
      input.branch,
      input.priority,
      PRIORITY_RANK[input.priority],
      now,
      now,
      QUEUES.indexOf('draft'),
      projectId,
      need.estimateHours ?? DEFAULT_ESTIMATE_HOURS,
      input.dueAt ?? null,
      need.minLevel ?? 1,
      need.certification ?? null,
      JSON.stringify(need.skills ?? []),
      now,
      input.requesterId ?? null,
    );
    this.#log(id, 'operator', 'created', 'Task created.', { operator, contributorId: input.requesterId });
    return id;
  }

  /** Everyone who might take this task, ranked, with reasons. */
  candidates(taskId: string): Candidate[] {
    return transaction(this.#db, () => ranked(this.#evaluate(this.#task(taskId), allContributors(this.#db))), 'DEFERRED');
  }

  #evaluate(task: TaskRow, people: Contributor[]): Candidate[] {
    const excluded = new Map(this.#excluded(task.id).map((e) => [e.contributorId, e.reason]));
    const need: Need = {
      branch: task.branch,
      expertise: task.expertise,
      priority: task.priority,
      minLevel: task.min_level,
      certification: task.certification,
      skills: JSON.parse(task.skills) as string[],
      estimateHours: task.estimate_hours,
    };
    return people.map((p) => evaluate(p, need, excluded.get(p.id), p.id === task.requester_id));
  }

  command(taskId: string, command: OperatorCommand, operator?: string): TaskSummary {
    return transaction(this.#db, () => {
      const task = this.#task(taskId);
      if (task.version !== command.expectedVersion) {
        const last = statement(
          this.#db,
          `SELECT actor_name AS who, summary FROM events WHERE task_id = ? AND type <> 'late_response'
           ORDER BY id DESC LIMIT 1`,
        ).get(taskId) as { who: string | null; summary: string };
        throw new StaleError(
          `This task changed while you were deciding. Latest: ${last.summary}${last.who ? ` (${last.who})` : ''} Review it and try again.`,
        );
      }
      const { action, reason } = command;
      if (!OPERATOR_ACTIONS[task.status].includes(action)) {
        throw new StaleError(`"${action}" is not available while the task is ${task.status.replaceAll('_', ' ')}.`);
      }
      const log = (type: string, summary: string, contributorId?: string) =>
        this.#log(task.id, 'operator', type, summary, { note: reason, operator, contributorId });
      if (action === 'submit' || action === 'reroute') this.#requireDependencies(task.id);

      switch (action) {
        case 'submit':
          this.#startRouting(task, command.scenario ?? 'random', { operator });
          break;

        case 'approve':
          this.#approve(task, command.rating, reason, operator);
          break;

        case 'request_changes': {
          if (!reason) throw new InvalidError('Say what needs to change.');
          const active = this.#activeAssignment(task.id)!;
          this.#review(active.id, 'changes_requested', reason, null, operator);
          statement(
            this.#db,
            `UPDATE assignments SET status = 'in_progress', revisions = revisions + 1, updated_at = ? WHERE id = ?`,
          ).run(this.#now(), active.id);
          this.#setStatus(task, 'in_progress', null, !this.#isAvailable(active.contributor_id));
          log('changes_requested', `Changes requested from ${active.name}.`, active.contributor_id);
          break;
        }

        case 'unblock': {
          if (!task.blocker) throw new StaleError('There is no open blocker on this task.');
          statement(
            this.#db,
            'UPDATE tasks SET blocker = NULL, quiet_since = NULL, last_activity_at = ?, version = version + 1 WHERE id = ?',
          ).run(this.#now(), task.id);
          this.#refreshQueue(task.id);
          log('unblocked', `Blocker cleared: ${task.blocker}`, this.#activeAssignment(task.id)?.contributor_id);
          break;
        }

        case 'reroute': {
          this.#supersedePending(task.id, 'operator restarted routing');
          const name = this.#revokeActive(task.id, reason ?? 'operator routed the task again');
          if (name) log('withdrawn', `Operator withdrew the assignment from ${name} to route again.`);
          this.#startRouting(task, command.scenario ?? 'random', { reason, operator });
          break;
        }

        case 'stop_routing':
          this.#supersedePending(task.id, 'operator stopped routing');
          this.#setStatus(task, 'needs_attention', 'routing_stopped');
          log('routing_stopped', 'Operator stopped routing.');
          break;

        case 'assign':
          this.#assign(task, command.contributorId, reason, operator);
          break;

        case 'withdraw': {
          const name = this.#revokeActive(task.id, reason ?? 'withdrawn by operator');
          this.#setStatus(task, 'needs_attention', 'withdrawn');
          log('withdrawn', `Operator withdrew the assignment from ${name}.`);
          break;
        }

        case 'cancel': {
          this.#supersedePending(task.id, 'operator cancelled the task');
          const name = this.#revokeActive(task.id, reason ?? 'task cancelled');
          this.#setStatus(task, 'cancelled', null);
          const held = name ? ` ${name}'s assignment ended.` : '';
          log('cancelled', `Operator cancelled the task.${held}`);
          this.#releaseDependents(task.id, 'was cancelled');
          break;
        }
      }
      return this.#summary(taskId);
    });
  }

  respond(taskId: string, response: ContributorResponse): TaskSummary {
    return transaction(this.#db, () => {
      const task = this.#task(taskId);
      const active = this.#activeAssignment(taskId);
      if (!active || active.id !== response.assignmentId) {
        throw new StaleError('That assignment is no longer active, so the response was not applied.');
      }
      const { action, reason } = response;
      if (!CONTRIBUTOR_ACTIONS[task.status].includes(action)) {
        throw new StaleError(`"${action}" is not possible while the task is ${task.status.replaceAll('_', ' ')}.`);
      }
      const who = active.contributor_id;
      const log = (type: string, text: string, note = reason) =>
        this.#log(task.id, 'contributor', type, `${active.name} ${text}`, { note, contributorId: who });
      const now = this.#now();
      const move = (assignment: AssignmentStatus, status: TaskStatus, attention: AttentionReason | null = null) => {
        const ended = assignment === 'declined' || assignment === 'failed';
        statement(
          this.#db,
          'UPDATE assignments SET status = ?, updated_at = ?, ended_at = ?, end_reason = ? WHERE id = ?',
        ).run(assignment, now, ended ? now : null, ended ? (reason ?? null) : null, active.id);
        // Someone who is away but still holds the task stays flagged.
        this.#setStatus(task, status, attention, !ended && !this.#isAvailable(who));
      };

      switch (action) {
        case 'accept':
          addToRecord(this.#db, who, { accepted: 1, responses: 1, responseMs: now - active.created_at });
          move('accepted', 'accepted');
          log('accepted', 'accepted the assignment. Routing is complete.');
          break;
        case 'decline':
          addToRecord(this.#db, who, { declined: 1, responses: 1, responseMs: now - active.created_at });
          move('declined', 'needs_attention', 'declined');
          log('declined', 'declined the assignment.');
          break;
        case 'start':
          this.#requireDependencies(task.id);
          move('in_progress', 'in_progress');
          log('in_progress', 'started work.');
          break;
        case 'fail':
          addToRecord(this.#db, who, { failed: 1 });
          move('failed', 'needs_attention', 'failed');
          log('failed', 'reported that the assignment failed.');
          break;
        case 'update': {
          if (!reason) throw new InvalidError('Describe the progress made.');
          const percent = response.percent ?? null;
          this.#recordUpdate(task.id, active.id, 'progress', reason, percent, response.hours ?? null);
          // A report is not a change of state: the version stays, so open dialogs remain valid.
          statement(
            this.#db,
            'UPDATE tasks SET progress = COALESCE(?, progress), quiet_since = NULL, last_activity_at = ? WHERE id = ?',
          ).run(percent, now, task.id);
          this.#refreshQueue(task.id);
          log('progress', `reported progress${percent === null ? '' : ` (${percent}%)`}.`);
          break;
        }
        case 'block': {
          if (!reason) throw new InvalidError('Describe what is blocking the work.');
          this.#recordUpdate(task.id, active.id, 'blocker', reason, null, null);
          statement(
            this.#db,
            'UPDATE tasks SET blocker = ?, quiet_since = NULL, last_activity_at = ?, version = version + 1 WHERE id = ?',
          ).run(reason, now, task.id);
          this.#refreshQueue(task.id);
          log('blocked', 'reported a blocker.');
          break;
        }
        case 'submit_work': {
          if (!reason) throw new InvalidError('Summarise what is being submitted.');
          statement(
            this.#db,
            'INSERT INTO submissions (task_id, assignment_id, at, summary, link) VALUES (?, ?, ?, ?, ?)',
          ).run(task.id, active.id, now, reason, response.link ?? null);
          move('in_review', 'in_review');
          statement(this.#db, 'UPDATE tasks SET progress = 100 WHERE id = ?').run(task.id);
          log('submitted', 'submitted work for review.');
          break;
        }
      }
      return this.#summary(taskId);
    });
  }

  #approve(task: TaskRow, rating: number | undefined, feedback: string | undefined, operator?: string): void {
    if (!rating) throw new InvalidError('Rate the work from 1 to 5 to approve it.');
    const active = this.#activeAssignment(task.id)!;
    const submission = this.#review(active.id, 'approved', feedback ?? null, rating, operator);
    const now = this.#now();
    statement(
      this.#db,
      `UPDATE assignments SET status = 'completed', updated_at = ?, ended_at = ? WHERE id = ?`,
    ).run(now, now, active.id);
    // Timeliness is judged by when they handed it in, not by how long the review took.
    addToRecord(this.#db, active.contributor_id, {
      completed: 1,
      onTime: task.due_at === null || submission.at <= task.due_at ? 1 : 0,
      firstPass: active.revisions === 0 ? 1 : 0,
      ratingSum: rating,
      ratingCount: 1,
    });
    this.#setStatus(task, 'completed', null);
    this.#log(task.id, 'operator', 'completed', `Work by ${active.name} approved, rated ${rating}/5.`, {
      note: feedback,
      operator,
      contributorId: active.contributor_id,
    });
    this.#releaseDependents(task.id, 'is complete');
    this.#settleRequests(`helper_task_id = ?`, [task.id], 'resolved', `${active.name} completed the helper task ${task.id}.`);
  }

  /** Records the decision on the latest submission. */
  #review(
    assignmentId: string,
    decision: 'approved' | 'changes_requested',
    feedback: string | null,
    rating: number | null,
    operator?: string,
  ): { at: number } {
    const latest = statement(
      this.#db,
      'SELECT id, at FROM submissions WHERE assignment_id = ? ORDER BY id DESC LIMIT 1',
    ).get(assignmentId) as { id: number; at: number };
    statement(
      this.#db,
      'UPDATE submissions SET decision = ?, feedback = ?, rating = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
    ).run(decision, feedback, rating, operator ?? null, this.#now(), latest.id);
    return latest;
  }

  #recordUpdate(taskId: string, assignmentId: string, kind: string, note: string, percent: number | null, hours: number | null) {
    statement(
      this.#db,
      `INSERT INTO progress_updates (task_id, assignment_id, at, kind, note, percent, hours)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(taskId, assignmentId, this.#now(), kind, note, percent, hours);
  }

  #requireDependencies(taskId: string): void {
    const waiting = statement(
      this.#db,
      `SELECT o.id FROM dependencies d JOIN tasks o ON o.id = d.depends_on
       WHERE d.task_id = ? AND o.status NOT IN ('completed', 'cancelled')`,
    ).all(taskId) as { id: string }[];
    if (waiting.length) {
      throw new InvalidError(`This task depends on ${waiting.map((w) => w.id).join(', ')}, which is not finished.`);
    }
  }

  /** Tells tasks that were waiting on this one that something changed. */
  #releaseDependents(taskId: string, what: string): void {
    const dependents = statement(this.#db, 'SELECT task_id AS id FROM dependencies WHERE depends_on = ?').all(taskId) as {
      id: string;
    }[];
    for (const { id } of dependents) {
      const waiting = this.#summary(id).waitingOn.length;
      const next = waiting ? `Still waiting on ${waiting} other task(s).` : 'Nothing else is holding it.';
      this.#log(id, 'system', 'dependency', `${taskId} ${what}. ${next}`);
    }
  }

  /**
   * Someone goes on leave, or comes back. Unanswered offers are taken back at once. Work they
   * already accepted is only flagged: moving it is a judgement for the operator.
   */
  setAvailability(contributorId: string, available: boolean, reason?: string, operator?: string): Contributor {
    return transaction(this.#db, () => {
      const person = findContributor(this.#db, contributorId);
      if (!person) throw new NotFoundError('That contributor does not exist.');
      if (person.available === available) return person;
      statement(this.#db, 'UPDATE contributors SET available = ? WHERE id = ?').run(available ? 1 : 0, contributorId);

      const held = statement(
        this.#db,
        `SELECT task_id, status FROM assignments WHERE contributor_id = ? AND status IN ${ACTIVE}`,
      ).all(contributorId) as { task_id: string; status: AssignmentStatus }[];

      for (const { task_id, status } of held) {
        const task = this.#task(task_id);
        if (!available && status === 'offered') {
          this.#revokeActive(task_id, reason ?? 'contributor unavailable', 'unavailable');
          this.#setStatus(task, 'needs_attention', 'contributor_unavailable');
          this.#log(task_id, 'operator', 'unavailable', `${person.name} was marked unavailable. Their unanswered offer was withdrawn.`, {
            note: reason,
            operator,
            contributorId,
          });
        } else {
          // The state is unchanged, so "since" is kept. The version moves: operators should look again.
          statement(this.#db, 'UPDATE tasks SET holder_away = ?, version = version + 1 WHERE id = ?').run(
            available ? 0 : 1,
            task_id,
          );
          this.#refreshQueue(task_id);
          const text = available
            ? `${person.name} is available again.`
            : `${person.name} was marked unavailable but still holds this task.`;
          this.#log(task_id, 'operator', available ? 'available' : 'unavailable', text, {
            note: reason,
            operator,
            contributorId,
          });
        }
      }
      return findContributor(this.#db, contributorId)!;
    });
  }

  // ---------------------------------------------------------------- queries

  /** Changes whenever the data does, and differs between databases. Safe to cache against. */
  version(): string {
    const row = statement(this.#db, 'SELECT epoch, revision FROM meta').get() as { epoch: string; revision: number };
    return `${row.epoch}-${row.revision}`;
  }

  list({ branch, queue, search, page = 1 }: ListQuery = {}): TaskPage {
    return transaction(
      this.#db,
      () => {
        const where: string[] = [];
        const args: (string | number)[] = [];
        if (branch) {
          where.push('t.branch = ?');
          args.push(branch);
        }
        if (search) {
          where.push(`(t.title LIKE ? ESCAPE '\\' OR t.id = ?)`);
          args.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`, search.toUpperCase());
        }
        const clause = (extra: string[]) => {
          const all = [...where, ...extra];
          return all.length ? `WHERE ${all.join(' AND ')}` : '';
        };

        const counts = Object.fromEntries(QUEUES.map((q) => [q, 0])) as Record<QueueName, number>;
        const grouped = statement(
          this.#db,
          `SELECT t.queue_rank AS rank, COUNT(*) AS n FROM tasks t ${clause([])} GROUP BY t.queue_rank`,
        ).all(...args) as { rank: number; n: number }[];
        for (const { rank, n } of grouped) counts[QUEUES[rank]!] = n;

        const filter = queue ? ['t.queue_rank = ?'] : [];
        const filterArgs = queue ? [...args, QUEUES.indexOf(queue)] : args;
        const rows = statement(
          this.#db,
          `${SUMMARY} ${clause(filter)}
           ORDER BY t.queue_rank, t.priority_rank, t.created_at, t.id LIMIT ? OFFSET ?`,
        ).all(...filterArgs, PAGE_SIZE, (page - 1) * PAGE_SIZE) as unknown as SummaryRow[];

        return {
          tasks: rows.map(toSummary),
          total: queue ? counts[queue] : Object.values(counts).reduce((a, b) => a + b, 0),
          page,
          pageSize: PAGE_SIZE,
          counts,
        };
      },
      'DEFERRED',
    );
  }

  contributors(): Contributor[] {
    return allContributors(this.#db);
  }

  projects(): ProjectSummary[] {
    return transaction(this.#db, () => listProjects(this.#db, this.#now()), 'DEFERRED');
  }

  project(id: string): ProjectReport {
    return transaction(this.#db, () => projectReport(this.#db, id, this.#now()), 'DEFERRED');
  }

  person(id: string): PersonDetail {
    return transaction(this.#db, () => personDetail(this.#db, id), 'DEFERRED');
  }

  /** Proposes a plan, or re-checks an edited one. Creates nothing. */
  plan(brief: Omit<NewProject, 'steps'> & { steps?: PlanStep[] }): Plan {
    return reviewPlan(brief.steps ?? split(brief), { ...brief, now: this.#now() }, this.contributors());
  }

  health(): Health {
    return this.#queue.health(this.#now());
  }

  detail(taskId: string): TaskDetail {
    return transaction(
      this.#db,
      () => {
        const task = this.#summary(taskId);
        const events = statement(
          this.#db,
          `SELECT id, at, actor, actor_name AS actorName, type, summary, note FROM events
           WHERE task_id = ? ORDER BY id`,
        ).all(taskId) as unknown as TaskEvent[];
        // Deliberately omits scenario: the console must not know how a pending request will end.
        const attempts = statement(
          this.#db,
          `SELECT r.id, r.attempt, r.state, r.requested_at AS requestedAt, r.closed_at AS closedAt,
                  r.closed_reason AS closedReason, r.returned_at AS returnedAt, c.name AS returnedContributorName
           FROM routing_requests r LEFT JOIN contributors c ON c.id = r.returned_contributor_id
           WHERE r.task_id = ? ORDER BY r.attempt`,
        ).all(taskId) as unknown as RoutingAttempt[];
        const assignments = statement(
          this.#db,
          `SELECT a.id, c.name AS contributorName, a.status, a.source, a.created_at AS createdAt,
                  a.ended_at AS endedAt, a.end_reason AS endReason
           FROM assignments a JOIN contributors c ON c.id = a.contributor_id
           WHERE a.task_id = ? ORDER BY a.created_at, a.rowid`,
        ).all(taskId) as unknown as AssignmentRecord[];
        const updates = statement(
          this.#db,
          `SELECT u.id, u.at, c.name AS contributorName, u.kind, u.note, u.percent, u.hours
           FROM progress_updates u JOIN assignments a ON a.id = u.assignment_id
           JOIN contributors c ON c.id = a.contributor_id WHERE u.task_id = ? ORDER BY u.id`,
        ).all(taskId) as unknown as ProgressUpdate[];
        const submissions = statement(
          this.#db,
          `SELECT s.id, s.at, c.name AS contributorName, s.summary, s.link, s.decision, s.feedback, s.rating,
                  s.reviewed_by AS reviewedBy, s.reviewed_at AS reviewedAt
           FROM submissions s JOIN assignments a ON a.id = s.assignment_id
           JOIN contributors c ON c.id = a.contributor_id WHERE s.task_id = ? ORDER BY s.id`,
        ).all(taskId) as unknown as Submission[];
        const dependencies = statement(
          this.#db,
          `SELECT o.id, o.title, o.status FROM dependencies d JOIN tasks o ON o.id = d.depends_on
           WHERE d.task_id = ? ORDER BY o.created_at, o.id`,
        ).all(taskId) as unknown as TaskDetail['dependencies'];
        const requests = readRequests(this.#db, 'task', taskId);
        const excluded = this.#excluded(taskId);
        return { task, events, attempts, assignments, updates, submissions, dependencies, requests, excluded };
      },
      'DEFERRED',
    );
  }

  // ---------------------------------------------------------------- internals

  #startRouting(
    task: TaskRow,
    scenario: Scenario,
    by: { reason?: string; operator?: string; actor?: Actor } = {},
  ): void {
    const { n } = statement(
      this.#db,
      'SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM routing_requests WHERE task_id = ?',
    ).get(task.id) as { n: number };
    const id = randomUUID();
    const now = this.#now();
    statement(
      this.#db,
      `INSERT INTO routing_requests (id, task_id, attempt, state, scenario, requested_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).run(id, task.id, n, scenario, now);
    this.#queue.add('dispatch', id, task.priority, now);
    this.#setStatus(task, 'routing', null);
    this.#log(task.id, by.actor ?? 'operator', 'routing_requested', `Routing attempt ${n} started.`, {
      note: by.reason,
      operator: by.operator,
    });
  }

  #assign(task: TaskRow, contributorId: string | undefined, reason: string | undefined, operator?: string): void {
    if (!contributorId) throw new InvalidError('Choose a contributor to assign.');
    const contributor = findContributor(this.#db, contributorId);
    if (!contributor) throw new InvalidError(`Contributor ${contributorId} does not exist.`);
    if (!contributor.available) throw new InvalidError(`${contributor.name} is marked unavailable.`);
    const current = this.#activeAssignment(task.id);
    if (current?.contributor_id === contributorId) {
      throw new InvalidError(`${contributor.name} already holds this task.`);
    }
    // A manager may overrule the requirements, but has to say why.
    const overrides = this.#evaluate(task, [contributor])[0]!.blockers.filter((b) => !b.startsWith('previously'));
    if (overrides.length && !reason) {
      throw new InvalidError(`Give a reason to assign ${contributor.name}: ${overrides.join('; ')}.`);
    }
    this.#supersedePending(task.id, 'operator assigned manually');
    const previous = this.#revokeActive(task.id, reason ?? `reassigned to ${contributor.name}`);
    this.#offer(task, contributorId, 'operator', null);
    this.#setStatus(task, 'offered', null);
    const from = previous ? ` (taken from ${previous})` : '';
    const warning = overrides.length ? ` Override: ${overrides.join('; ')}.` : '';
    this.#log(task.id, 'operator', 'assigned', `Operator offered the task to ${contributor.name}${from}.${warning}`, {
      note: reason,
      operator,
      contributorId,
    });
  }

  #offer(task: TaskRow, contributorId: string, source: 'routing' | 'operator', requestId: string | null): void {
    const now = this.#now();
    // Progress and blockers belonged to whoever held it before.
    statement(this.#db, 'UPDATE tasks SET progress = 0, blocker = NULL WHERE id = ?').run(task.id);
    // So did anything the previous holder asked for as holder.
    this.#settleRequests(
      `task_id = ? AND type IN ('help', 'extension', 'handover') AND from_id <> ?`,
      [task.id, contributorId],
      'closed',
      'The task moved to someone else.',
    );
    statement(
      this.#db,
      `INSERT INTO assignments (id, task_id, contributor_id, request_id, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'offered', ?, ?, ?)`,
    ).run(randomUUID(), task.id, contributorId, requestId, source, now, now);
  }

  /** Returns the name of the contributor who lost the task, if anyone held it. */
  #revokeActive(taskId: string, reason: string, code: 'unavailable' | null = null): string | null {
    const active = this.#activeAssignment(taskId);
    if (!active) return null;
    const now = this.#now();
    statement(
      this.#db,
      `UPDATE assignments SET status = 'revoked', updated_at = ?, ended_at = ?, end_reason = ?, end_code = ?
       WHERE id = ?`,
    ).run(now, now, reason, code, active.id);
    return active.name;
  }

  #supersedePending(taskId: string, reason: string): void {
    const pending = statement(
      this.#db,
      `SELECT id, attempt FROM routing_requests WHERE task_id = ? AND state = 'pending'`,
    ).get(taskId) as { id: string; attempt: number } | undefined;
    if (!pending) return;
    this.#closeRequest(pending.id, 'superseded', reason);
    // No point sending a request nobody wants any more.
    statement(this.#db, `DELETE FROM jobs WHERE kind = 'dispatch' AND request_id = ?`).run(pending.id);
    this.#log(
      taskId,
      'system',
      'superseded',
      `Routing attempt ${pending.attempt} closed. Any answer it still returns will be ignored.`,
    );
  }

  #closeRequest(requestId: string, state: RequestState, reason: string, code: 'capacity' | null = null): void {
    statement(
      this.#db,
      'UPDATE routing_requests SET state = ?, closed_at = ?, closed_reason = ?, closed_code = ? WHERE id = ?',
    ).run(state, this.#now(), reason, code, requestId);
  }

  #setStatus(task: TaskRow, status: TaskStatus, attention: AttentionReason | null, holderAway = false): void {
    const now = this.#now();
    // A blocker survives only while the same person is still working on it.
    const keepBlocker = status === 'accepted' || status === 'in_progress';
    statement(
      this.#db,
      `UPDATE tasks SET status = ?, attention_reason = ?, version = version + 1, status_since = ?,
         last_activity_at = ?, overdue_since = NULL, quiet_since = NULL, holder_away = ?,
         blocker = CASE WHEN ? THEN blocker ELSE NULL END
       WHERE id = ?`,
    ).run(status, attention, now, now, holderAway ? 1 : 0, keepBlocker ? 1 : 0, task.id);
    this.#refreshQueue(task.id);
    if (status === 'needs_attention' || status === 'routing') {
      // Nobody holds it now, so what the holder asked for has lapsed.
      this.#settleRequests(
        `task_id = ? AND type IN ('help', 'extension', 'handover')`,
        [task.id],
        'closed',
        'The assignment ended before this was dealt with.',
      );
    }
    if (status === 'completed' || status === 'cancelled') {
      this.#settleRequests('task_id = ?', [task.id], 'closed', `The task was ${status}.`);
      if (status === 'cancelled') {
        this.#settleRequests('helper_task_id = ?', [task.id], 'closed', `The helper task ${task.id} was cancelled.`);
      }
    }
    // Moving the task on resolves any failed job behind it. The history keeps the record.
    if (status !== 'needs_attention') {
      statement(
        this.#db,
        `DELETE FROM jobs WHERE dead_at IS NOT NULL
           AND request_id IN (SELECT id FROM routing_requests WHERE task_id = ?)`,
      ).run(task.id);
    }
  }

  /** Closes live requests that events have answered or overtaken. */
  #settleRequests(where: string, values: string[], status: 'resolved' | 'closed', response: string): void {
    statement(
      this.#db,
      `UPDATE work_requests SET status = ?, response = ?, closed_at = ?
       WHERE ${where} AND status IN ('open', 'delegated')`,
    ).run(status, response, this.#now(), ...values);
  }

  /** Adds a line to a task's history, for things that happen around it. */
  record(taskId: string, summary: string, by: { name: string; id: string }, note?: string): void {
    this.#log(taskId, 'contributor', 'request', summary, { note, contributorId: by.id, operator: by.name });
  }

  /** Moves a deadline later, and clears the flag if the new date is in the future. */
  extendDue(taskId: string, days: number, note: string, by: string): void {
    transaction(this.#db, () => {
      const task = this.#task(taskId);
      if (task.due_at === null) throw new InvalidError('This task has no due date to move.');
      const due = task.due_at + days * 86_400_000;
      statement(
        this.#db,
        `UPDATE tasks SET due_at = ?, version = version + 1,
           past_due_since = CASE WHEN ? > ? THEN NULL ELSE past_due_since END WHERE id = ?`,
      ).run(due, due, this.#now(), taskId);
      this.#refreshQueue(taskId);
      this.#log(taskId, 'operator', 'extended', `Due date moved ${days} day(s) later.`, { note, operator: by });
    });
  }

  /** The one place that decides which operator list a task belongs in. */
  #refreshQueue(taskId: string): void {
    const rank = (queue: QueueName) => QUEUES.indexOf(queue);
    statement(
      this.#db,
      `UPDATE tasks SET queue_rank = CASE
         WHEN status IN ('completed', 'cancelled') THEN ${rank('closed')}
         WHEN status IN ('needs_attention', 'in_review') OR overdue_since IS NOT NULL OR holder_away = 1
              OR blocker IS NOT NULL OR quiet_since IS NOT NULL OR past_due_since IS NOT NULL THEN ${rank('attention')}
         WHEN status = 'routing' THEN ${rank('routing')}
         WHEN status = 'draft' THEN ${rank('draft')}
         ELSE ${rank('assigned')} END
       WHERE id = ?`,
    ).run(taskId);
    // Work waiting for review is routine. Anything else needing attention gets investigated.
    statement(
      this.#db,
      `UPDATE tasks SET triage = (queue_rank = ${rank('attention')} AND NOT (status = 'in_review'
         AND holder_away = 0 AND past_due_since IS NULL AND overdue_since IS NULL)) WHERE id = ?`,
    ).run(taskId);
    // A case describes one moment. Once the task has moved on, it is closed as out of date.
    statement(
      this.#db,
      `UPDATE agent_cases SET status = 'superseded', closed_at = ? WHERE task_id = ? AND status = 'open'
         AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = agent_cases.task_id
           AND (t.version <> agent_cases.task_version OR t.queue_rank <> ${rank('attention')}))`,
    ).run(this.#now(), taskId);
  }

  #log(
    taskId: string,
    actor: Actor,
    type: string,
    summary: string,
    extra: { note?: string; operator?: string; contributorId?: string } = {},
  ): void {
    statement(
      this.#db,
      `INSERT INTO events (task_id, at, actor, actor_name, type, summary, note, contributor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      this.#now(),
      actor,
      extra.operator ?? null,
      type,
      summary,
      extra.note ?? null,
      extra.contributorId ?? null,
    );
  }

  #task(id: string): TaskRow {
    const row = statement(
      this.#db,
      `SELECT id, title, expertise, branch, priority, status, version, project_id, estimate_hours, due_at,
              min_level, certification, skills, blocker, requester_id FROM tasks WHERE id = ?`,
    ).get(id) as TaskRow | undefined;
    if (!row) throw new NotFoundError(`Task ${id} does not exist.`);
    return row;
  }

  #request(id: string): RequestRow | undefined {
    return statement(this.#db, 'SELECT * FROM routing_requests WHERE id = ?').get(id) as RequestRow | undefined;
  }

  #summary(taskId: string): TaskSummary {
    const row = statement(this.#db, `${SUMMARY} WHERE t.id = ?`).get(taskId) as SummaryRow | undefined;
    if (!row) throw new NotFoundError(`Task ${taskId} does not exist.`);
    return toSummary(row);
  }

  #isAvailable(contributorId: string): boolean {
    const row = statement(this.#db, 'SELECT available FROM contributors WHERE id = ?').get(contributorId) as {
      available: number;
    };
    return row.available === 1;
  }

  #activeAssignment(taskId: string): ActiveAssignmentRow | undefined {
    return statement(
      this.#db,
      `SELECT a.id, a.contributor_id, c.name, a.status, a.created_at, a.revisions
       FROM assignments a JOIN contributors c ON c.id = a.contributor_id
       WHERE a.task_id = ? AND a.status IN ${ACTIVE}`,
    ).get(taskId) as ActiveAssignmentRow | undefined;
  }

  /** Anyone who declined or failed this task, or had it deliberately taken back. */
  #excluded(taskId: string): TaskDetail['excluded'] {
    const rows = statement(
      this.#db,
      `SELECT a.contributor_id AS contributorId, c.name, a.status
       FROM assignments a JOIN contributors c ON c.id = a.contributor_id
       WHERE a.task_id = ? AND a.status IN ('declined', 'failed', 'revoked') AND a.end_code IS NULL
       ORDER BY a.created_at, a.rowid`,
    ).all(taskId) as unknown as { contributorId: string; name: string; status: string }[];
    const latest = new Map(
      rows.map((r) => [
        r.contributorId,
        { contributorId: r.contributorId, name: r.name, reason: r.status === 'revoked' ? 'withdrawn' : r.status },
      ]),
    );
    return [...latest.values()];
  }
}
