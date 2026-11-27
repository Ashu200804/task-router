/**
 * Everything the assistant is able to do. Every tool is read-only and bound to one task, so
 * neither the rules nor a model can change data or wander elsewhere. Changes happen only
 * when a person approves an option, through the same guarded commands operators use.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ToolCall } from '../../shared/types.ts';
import { statement } from '../db.ts';
import { findContributor } from '../people.ts';
import type { TaskService } from '../service.ts';

export interface ToolContext {
  db: DatabaseSync;
  service: TaskService;
  taskId: string;
}

interface ToolSpec<I, O> {
  description: string;
  /** Names of required text inputs. Most tools need none: the task is fixed. */
  inputs: Record<keyof I & string, string>;
  run: (context: ToolContext, input: I) => O;
}

const tool = <I, O>(spec: ToolSpec<I, O>) => spec;
const DAY = 86_400_000;

export const TOOLS = {
  get_task: tool({
    description: 'The task: state, requirements, holder, deadline, progress and any blocker.',
    inputs: {},
    run: ({ service, taskId }) => service.detail(taskId).task,
  }),
  get_history: tool({
    description: 'The latest 30 events on the task, oldest first, with the reasons people gave.',
    inputs: {},
    run: ({ service, taskId }) => service.detail(taskId).events.slice(-30),
  }),
  get_routing_attempts: tool({
    description: 'Every routing attempt and how it ended, plus errors from jobs that were given up on.',
    inputs: {},
    run: ({ db, service, taskId }) => ({
      attempts: service.detail(taskId).attempts,
      errors: statement(
        db,
        `SELECT r.attempt, j.kind, j.attempts AS tries, j.last_error AS error FROM jobs j
         JOIN routing_requests r ON r.id = j.request_id WHERE r.task_id = ? AND j.dead_at IS NOT NULL`,
      ).all(taskId) as unknown as { attempt: number; kind: string; tries: number; error: string }[],
    }),
  }),
  get_assignments: tool({
    description: 'Who has held the task and why each assignment ended.',
    inputs: {},
    run: ({ service, taskId }) => service.detail(taskId).assignments,
  }),
  rank_candidates: tool({
    description: 'Everyone ranked for this task, with the requirements each person misses and why they score as they do.',
    inputs: {},
    run: ({ service, taskId }) => service.candidates(taskId),
  }),
  get_team_lead: tool({
    description: 'The lead of the team in the task’s branch that owns this kind of work.',
    inputs: {},
    run: ({ service, taskId }) => {
      const { branch, expertise } = service.detail(taskId).task;
      const leads = service.contributors().filter((c) => c.profile.lead && c.branch === branch);
      const lead = leads.find((c) => c.expertise[0] === expertise) ?? leads.find((c) => c.expertise.includes(expertise));
      return lead ? { id: lead.id, name: lead.name, title: lead.profile.title, available: lead.available } : null;
    },
  }),
  get_person: tool({
    description: 'One person’s profile, current load and work record.',
    inputs: { person_id: 'The contributor id, as returned by rank_candidates.' },
    run: ({ db }, input: { person_id: string }) => findContributor(db, input.person_id),
  }),
  get_dependencies: tool({
    description: 'Tasks this one waits for, and their state.',
    inputs: {},
    run: ({ service, taskId }) => service.detail(taskId).dependencies,
  }),
  find_similar: tool({
    description: 'How often the same kind of problem occurred in this branch and expertise over the last 7 days.',
    inputs: { trigger: 'The kind of problem, for example no_match or declined.' },
    run: ({ db, service, taskId }, input: { trigger: string }) => {
      const { branch, expertise } = service.detail(taskId).task;
      return statement(
        db,
        `SELECT COUNT(DISTINCT c.task_id) AS tasks FROM agent_cases c JOIN tasks t ON t.id = c.task_id
         WHERE c.trigger = ? AND t.branch = ? AND t.expertise = ? AND c.task_id <> ? AND c.created_at > ?`,
      ).get(input.trigger, branch, expertise, taskId, service.now() - 7 * DAY) as { tasks: number };
    },
  }),
  get_engine_health: tool({
    description: 'How the routing engine handled the last 40 requests sent to it.',
    inputs: {},
    run: ({ db, service }) => {
      const rows = statement(
        db,
        `SELECT dispatched_at AS sent, returned_at AS back FROM routing_requests
         WHERE dispatched_at IS NOT NULL ORDER BY dispatched_at DESC LIMIT 40`,
      ).all() as { sent: number; back: number | null }[];
      const limit = service.overdueAfterMs();
      // Only requests old enough to have been answered tell us anything.
      const mature = rows.filter((r) => r.back !== null || service.now() - r.sent > limit);
      return { judged: mature.length, unanswered: mature.filter((r) => r.back === null).length, windowMs: limit };
    },
  }),
};

export type ToolName = keyof typeof TOOLS;
export type ToolResult<N extends ToolName> = ReturnType<(typeof TOOLS)[N]['run']>;

/** Calls a tool, checking its input and recording the call. */
export function toolRunner(context: ToolContext) {
  const trace: ToolCall[] = [];
  function call<N extends ToolName>(name: N, input: Record<string, unknown> = {}): ToolResult<N> {
    const started = performance.now();
    const record = (ok: boolean, error?: string) =>
      trace.push({ tool: name, input, ok, ms: Math.round((performance.now() - started) * 10) / 10, ...(error && { error }) });
    try {
      if (!Object.hasOwn(TOOLS, name)) throw new Error(`There is no tool called ${name}.`);
      const spec = TOOLS[name] as unknown as ToolSpec<Record<string, string>, ToolResult<N>>;
      const expected = Object.keys(spec.inputs);
      const given = Object.keys(input);
      if (given.some((k) => !expected.includes(k)) || expected.some((k) => typeof input[k] !== 'string')) {
        throw new Error(`${name} takes exactly: ${expected.join(', ') || 'no input'}.`);
      }
      const result = spec.run(context, input as Record<string, string>);
      record(true);
      return result;
    } catch (error) {
      record(false, (error as Error).message);
      throw error;
    }
  }
  return { call, trace };
}
export type Run = ReturnType<typeof toolRunner>;
