/**
 * Things people ask for on a task, and what happens to them.
 *
 * Fixed rules, in this order: answer from the data if the data holds the answer; act at once
 * if the action is low risk; turn work into a helper task and let routing find the person;
 * otherwise hand the decision to the most suitable person and say why they were chosen.
 * Nothing is dropped: with nobody suitable, it goes to the operator console.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Contributor, RequestType, Scenario, TaskSummary, WorkRequest, WorkRequestStatus } from '../shared/types.ts';
import { statement, transaction } from './db.ts';
import { ForbiddenError, InvalidError, NotFoundError, StaleError } from './errors.ts';
import { readRequests } from './requests-read.ts';
import type { TaskService } from './service.ts';

/** Extensions up to this many days may be granted without asking anyone. */
export const AUTO_EXTENSION_DAYS = 1;
const DAY = 86_400_000;

export interface NewRequest {
  type: RequestType;
  text: string;
  days?: number;
  /** Simulation control for the helper task's routing. */
  scenario?: Scenario;
}

export type Decision = 'approve' | 'decline' | 'answer';

interface Handling {
  status: WorkRequestStatus;
  routing: string;
  handler?: Contributor | null;
  response?: string;
  suggestion?: WorkRequest['suggestion'];
  helperTaskId?: string;
}

interface Choice {
  handler: Contributor | null;
  why: string;
}

export class Requests {
  #db: DatabaseSync;
  #service: TaskService;

  constructor(db: DatabaseSync, service: TaskService) {
    this.#db = db;
    this.#service = service;
  }

  /** What `person` is to a task. Everything they may see or do follows from this. */
  roles(task: TaskSummary, personId: string): { holder: boolean; requester: boolean } {
    return {
      holder: task.assignee?.contributorId === personId && task.status !== 'completed',
      requester: task.requester?.id === personId,
    };
  }

  create(taskId: string, fromId: string, input: NewRequest): WorkRequest {
    return transaction(this.#db, () => {
      const task = this.#service.detail(taskId).task;
      const from = this.#person(fromId);
      const { holder, requester } = this.roles(task, fromId);
      if (!holder && !requester) throw new ForbiddenError('Only the person doing a task, or who raised it, can make requests on it.');
      if (task.status === 'completed' || task.status === 'cancelled') throw new InvalidError(`This task is ${task.status}.`);
      if (['help', 'extension', 'handover'].includes(input.type)) {
        if (!holder || task.status === 'offered') throw new InvalidError('Accept the task before asking for that.');
      }
      if (input.type === 'cancel' && !requester) throw new ForbiddenError('Only the person who raised it can ask to cancel it.');
      const live = readRequests(this.#db, 'task', taskId).some(
        (r) => r.from.id === fromId && r.type === input.type && (r.status === 'open' || r.status === 'delegated'),
      );
      if (live) throw new StaleError('You already have that request waiting on this task.');

      const id = randomUUID();
      const handling = this.#handle(task, from, input);
      const now = this.#service.now();
      statement(
        this.#db,
        `INSERT INTO work_requests (id, task_id, type, text, days, from_id, handler_id, status, routing,
           response, suggestion, helper_task_id, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        taskId,
        input.type,
        input.text,
        input.days ?? null,
        fromId,
        handling.handler?.id ?? null,
        handling.status,
        handling.routing,
        handling.response ?? null,
        handling.suggestion ? JSON.stringify(handling.suggestion) : null,
        handling.helperTaskId ?? null,
        now,
        handling.status === 'open' || handling.status === 'delegated' ? null : now,
      );
      this.#service.record(taskId, `${from.name} asked: ${input.type}. ${handling.routing}`, from, input.text);
      // A cancellation that needs nobody's approval is carried out once it is on record.
      if (input.type === 'cancel' && handling.status === 'approved') this.#cancel(taskId, from.name, input.text);
      return this.#get(id);
    });
  }

  #handle(task: TaskSummary, from: Contributor, input: NewRequest): Handling {
    switch (input.type) {
      case 'status':
        return { status: 'resolved', routing: 'Answered at once from the task data.', response: this.#statusReport(task) };

      case 'question': {
        const { handler, why } = this.#whoDecides(task, from);
        return { status: 'open', handler, routing: why };
      }

      case 'help': {
        const helper = this.#service.createTask(
          {
            title: `Help with ${task.id}: ${input.text}`.slice(0, 120),
            description: `${from.name} asked for help with “${task.title}”.\n${input.text}`,
            expertise: task.expertise,
            branch: task.branch,
            priority: task.priority,
            submit: true,
            scenario: input.scenario,
            // Supporting someone asks a little less than owning the work. Certification still applies.
            requirements: { ...task.requirements, minLevel: Math.max(1, task.requirements.minLevel - 1), estimateHours: 2 },
            requesterId: from.id,
          },
          from.name,
        );
        return {
          status: 'delegated',
          helperTaskId: helper.id,
          routing: `Created helper task ${helper.id} and sent it to routing, which picks the most suitable person other than ${from.name}.`,
        };
      }

      case 'extension': {
        const days = input.days;
        if (!days || !Number.isInteger(days) || days < 1 || days > 30) throw new InvalidError('Ask for 1 to 30 days.');
        if (task.dueAt === null) throw new InvalidError('This task has no due date to extend.');
        const blocked = this.#whyNotAutomatic(task, days);
        if (!blocked) {
          this.#service.extendDue(task.id, days, input.text, 'Automatic rule');
          return {
            status: 'approved',
            routing: `Approved automatically: ${days} day, nothing depends on it, and the first such extension.`,
            response: `Due date moved ${days} day(s) later.`,
          };
        }
        const { handler, why } = this.#whoDecides(task, from);
        return { status: 'open', handler, routing: `Needs a decision because ${blocked}. ${why}` };
      }

      case 'handover': {
        const { handler, why } = this.#whoLeads(task, from);
        const next = this.#service
          .candidates(task.id)
          .find((c) => !c.blockers.length && c.contributorId !== from.id);
        return {
          status: 'open',
          handler,
          suggestion: next ? { id: next.contributorId, name: next.name, score: next.score } : null,
          routing: `Moving work needs approval. ${why} ${next ? `Suggested next: ${next.name}, score ${next.score}.` : 'Nobody else currently meets every requirement.'}`,
        };
      }

      case 'cancel': {
        if (['draft', 'routing', 'needs_attention', 'offered'].includes(task.status)) {
          return { status: 'approved', routing: 'Cancelled at once: nobody had accepted it.', response: 'Task cancelled.' };
        }
        const { handler, why } = this.#whoLeads(task, from);
        return { status: 'open', handler, routing: `Work has been accepted, so cancelling needs approval. ${why}` };
      }
    }
  }

  /** Null if an extension can be granted without a person. */
  #whyNotAutomatic(task: TaskSummary, days: number): string | null {
    if (days > AUTO_EXTENSION_DAYS) return `it is more than ${AUTO_EXTENSION_DAYS} day`;
    const count = (sql: string) => (statement(this.#db, sql).get(task.id) as { n: number }).n;
    if (count('SELECT COUNT(*) AS n FROM dependencies WHERE depends_on = ?')) return 'other tasks depend on this one';
    if (count(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'extended'`)) return 'it has been extended before';
    if (task.projectId) {
      const { due } = statement(this.#db, 'SELECT due_at AS due FROM projects WHERE id = ?').get(task.projectId) as { due: number | null };
      if (due !== null && task.dueAt! + days * DAY > due) return 'it would pass the project deadline';
    }
    return null;
  }

  #statusReport(task: TaskSummary): string {
    const detail = this.#service.detail(task.id);
    const update = detail.updates.at(-1);
    return [
      `State: ${task.status.replaceAll('_', ' ')}.`,
      task.assignee ? `With ${task.assignee.name}, ${task.progress}% reported.` : 'Nobody holds it yet.',
      task.blocker ? `Blocked: “${task.blocker}”.` : '',
      update ? `Latest report: “${update.note}”.` : 'No progress report yet.',
      task.dueAt ? `Due ${new Date(task.dueAt).toISOString().slice(0, 10)}${task.pastDueSince ? ', which has passed' : ''}.` : '',
    ].filter(Boolean).join(' ');
  }

  /** Whoever raised the task, if that helps; else its holder; else the team lead. */
  #whoDecides(task: TaskSummary, from: Contributor): Choice {
    const { holder, requester } = this.roles(task, from.id);
    const other = holder ? task.requester?.id : requester ? task.assignee?.contributorId : undefined;
    const person = other && other !== from.id ? this.#person(other) : null;
    if (person?.available) {
      return { handler: person, why: `Sent to ${person.name}, who ${holder ? 'raised the task' : 'is doing the work'}.` };
    }
    const lead = this.#whoLeads(task, from);
    return person ? { ...lead, why: `${person.name} is away. ${lead.why}` } : lead;
  }

  /** The team lead for this work, then another lead in the branch, then the operator console. */
  #whoLeads(task: TaskSummary, from: Contributor): Choice {
    const leads = this.#service
      .contributors()
      .filter((c) => c.branch === task.branch && c.profile.lead && c.available && c.id !== from.id);
    const own = leads.find((c) => c.expertise[0] === task.expertise) ?? leads.find((c) => c.expertise.includes(task.expertise));
    if (own) return { handler: own, why: `Sent to ${own.name}, the available ${task.expertise} lead in ${task.branch}.` };
    const any = leads.sort((a, b) => a.activeCount - b.activeCount || a.id.localeCompare(b.id))[0];
    if (any) return { handler: any, why: `No other ${task.expertise} lead is available, so sent to ${any.name}, the least loaded lead in ${task.branch}.` };
    return { handler: null, why: 'No suitable person is available, so it is with the operator console.' };
  }

  /** `by` is null for the operator console, which may decide any open request. */
  decide(requestId: string, by: string | null, decision: Decision, text: string | undefined, operator?: string): WorkRequest {
    return transaction(this.#db, () => {
      const request = this.#get(requestId);
      if (by !== null && request.handler?.id !== by) throw new ForbiddenError('This request is for someone else to decide.');
      if (request.status !== 'open') throw new StaleError(`This request is already ${request.status}.`);
      const decider = by ? this.#person(by) : { id: '', name: operator || 'Operator' };
      const isQuestion = request.type === 'question';
      if (isQuestion !== (decision === 'answer')) {
        throw new InvalidError(isQuestion ? 'A question needs an answer.' : 'Approve or decline this request.');
      }
      if ((isQuestion || decision === 'decline') && !text) throw new InvalidError('Write a reply.');
      const status: WorkRequestStatus = isQuestion ? 'resolved' : decision === 'approve' ? 'approved' : 'declined';
      let response = text ?? 'Approved.';
      statement(this.#db, 'UPDATE work_requests SET status = ?, response = ?, closed_at = ? WHERE id = ?').run(
        status,
        response,
        this.#service.now(),
        requestId,
      );

      const task = this.#service.detail(request.taskId).task;
      const note = `Requested by ${request.from.name}; approved by ${decider.name}. ${text ?? ''}`.trim();
      if (decision === 'approve') {
        if (request.type === 'extension') {
          this.#service.extendDue(task.id, request.days!, note, decider.name);
          response = `Due date moved ${request.days} day(s) later.`;
        } else if (request.type === 'cancel') {
          this.#cancel(task.id, decider.name, note);
          response = 'Task cancelled.';
        } else if (request.type === 'handover') {
          // Picked again now: the earlier suggestion may no longer fit.
          const next = this.#service.candidates(task.id).find((c) => !c.blockers.length && c.contributorId !== request.from.id);
          this.#service.command(
            task.id,
            next
              ? { action: 'assign', contributorId: next.contributorId, reason: note, expectedVersion: task.version }
              : { action: 'withdraw', reason: note, expectedVersion: task.version },
            decider.name,
          );
          response = next ? `Offered to ${next.name}.` : 'Taken back; nobody else is eligible, so it needs attention.';
        }
        statement(this.#db, 'UPDATE work_requests SET response = ? WHERE id = ?').run(
          text ? `${response} ${text}` : response,
          requestId,
        );
      }
      this.#service.record(request.taskId, `${decider.name} ${isQuestion ? 'answered' : status} ${request.from.name}’s ${request.type} request.`, decider, text);
      return this.#get(requestId);
    });
  }

  /** Passes on open requests whose handler has become unavailable. */
  rehome(): number {
    const stranded = statement(
      this.#db,
      `SELECT r.id FROM work_requests r JOIN contributors c ON c.id = r.handler_id
       WHERE r.status = 'open' AND c.available = 0 LIMIT 50`,
    ).all() as { id: string }[];
    for (const { id } of stranded) {
      transaction(this.#db, () => {
        const r = this.#get(id);
        if (r.status !== 'open' || !r.handler || this.#person(r.handler.id).available) return;
        const task = this.#service.detail(r.taskId).task;
        const from = this.#person(r.from.id);
        const next = r.type === 'handover' || r.type === 'cancel' ? this.#whoLeads(task, from) : this.#whoDecides(task, from);
        statement(this.#db, 'UPDATE work_requests SET handler_id = ?, routing = ? WHERE id = ?').run(
          next.handler?.id ?? null,
          `${r.handler.name} became unavailable. ${next.why}`,
          id,
        );
        this.#service.record(r.taskId, `${r.from.name}’s ${r.type} request moved on. ${next.why}`, from);
      });
    }
    return stranded.length;
  }

  #cancel(taskId: string, by: string, reason: string): void {
    const { version } = this.#service.detail(taskId).task;
    this.#service.command(taskId, { action: 'cancel', reason, expectedVersion: version }, by);
  }

  #get(id: string): WorkRequest {
    const [found] = readRequests(this.#db, 'id', id);
    if (!found) throw new NotFoundError('That request does not exist.');
    return found;
  }

  #person(id: string): Contributor {
    const found = this.#service.contributors().find((c) => c.id === id);
    if (!found) throw new NotFoundError('That person does not exist.');
    return found;
  }
}
