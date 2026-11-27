/**
 * The assistant. When a task needs a person, it investigates, writes up what it found as a
 * case, and offers options. It acts only when someone approves an option, and then through
 * the same guarded commands as any operator. People mark whether its cases were right.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Answer,
  CaseDetail,
  CaseList,
  CaseReport,
  CaseStatus,
  CaseSummary,
  ToolCall,
  Trigger,
  Verdict,
} from '../../shared/types.ts';
import { statement, transaction } from '../db.ts';
import { InvalidError, NotFoundError, StaleError } from '../errors.ts';
import type { TaskService } from '../service.ts';
import { answerByRules } from './answer.ts';
import { investigate, triggerFor } from './investigate.ts';
import { answerByModel, type CreateMessage } from './model.ts';
import { toolRunner } from './tools.ts';

const CASE = `
  SELECT c.*, t.title AS task_title, t.branch, t.priority
  FROM agent_cases c JOIN tasks t ON t.id = c.task_id`;

interface CaseRow {
  id: string;
  task_id: string;
  task_title: string;
  branch: CaseSummary['branch'];
  priority: CaseSummary['priority'];
  trigger: Trigger;
  task_version: number;
  status: CaseStatus;
  created_at: number;
  closed_at: number | null;
  failed: number;
  report: string;
  trace: string;
  chosen_option: string | null;
  resolved_by: string | null;
  verdict: Verdict | null;
  verdict_note: string | null;
  verdict_by: string | null;
}

const toSummary = (r: CaseRow): CaseSummary => ({
  id: r.id,
  taskId: r.task_id,
  taskTitle: r.task_title,
  branch: r.branch,
  priority: r.priority,
  trigger: r.trigger,
  status: r.status,
  headline: (JSON.parse(r.report) as CaseReport).headline,
  createdAt: r.created_at,
  failed: r.failed === 1,
  verdict: r.verdict,
});

export class Agent {
  #db: DatabaseSync;
  #service: TaskService;
  #model: CreateMessage | null;

  constructor(db: DatabaseSync, service: TaskService, model: CreateMessage | null = null) {
    this.#db = db;
    this.#service = service;
    this.#model = model;
  }

  /**
   * Investigates flagged tasks, urgent ones first, for about `budgetMs`. Each is its own
   * transaction, and the database allows one open case per task, so restarts and several
   * instances cannot produce duplicates.
   */
  sweep(budgetMs = 15): number {
    const started = performance.now();
    const flagged = statement(
      this.#db,
      'SELECT id FROM tasks WHERE triage = 1 ORDER BY priority_rank, last_activity_at LIMIT 50',
    ).all() as { id: string }[];
    let opened = 0;
    for (const [i, { id }] of flagged.entries()) {
      if (i > 0 && performance.now() - started >= budgetMs) break;
      if (this.#examine(id)) opened++;
    }
    return opened;
  }

  #examine(taskId: string): boolean {
    return transaction(this.#db, () => {
      const row = statement(this.#db, 'SELECT triage, version, priority_rank FROM tasks WHERE id = ?').get(taskId) as {
        triage: number;
        version: number;
        priority_rank: number;
      };
      if (!row.triage) return false; // another instance got there first
      statement(this.#db, 'UPDATE tasks SET triage = 0 WHERE id = ?').run(taskId);
      const trigger = triggerFor(this.#service.detail(taskId).task);
      if (!trigger) return false;

      const now = this.#service.now();
      // A different problem on the same version replaces the old case.
      statement(
        this.#db,
        `UPDATE agent_cases SET status = 'superseded', closed_at = ?
         WHERE task_id = ? AND status = 'open' AND NOT (trigger = ? AND task_version = ?)`,
      ).run(now, taskId, trigger, row.version);
      // Still open, or a person already dismissed exactly this: nothing new to say.
      const exists = statement(
        this.#db,
        `SELECT 1 FROM agent_cases WHERE task_id = ? AND task_version = ? AND trigger = ?
           AND status IN ('open', 'dismissed')`,
      ).get(taskId, row.version, trigger);
      if (exists) return false;

      const run = toolRunner({ db: this.#db, service: this.#service, taskId });
      let report: CaseReport;
      let failed = false;
      try {
        report = investigate(run, trigger, now);
      } catch (error) {
        // A broken investigation is itself reported, never silently dropped or retried forever.
        console.error(`Investigation of ${taskId} (${trigger}) failed:`, error);
        failed = true;
        const message = (error as Error).message;
        report = {
          headline: 'The assistant could not investigate this',
          findings: [{ certainty: 'recorded', text: `The investigation stopped with: ${message}`, evidence: [] }],
          evidence: [],
          options: [],
          draftMessage: null,
        };
      }
      statement(
        this.#db,
        `INSERT INTO agent_cases (id, task_id, trigger, task_version, status, priority_rank, created_at, failed, report, trace)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        taskId,
        trigger,
        row.version,
        row.priority_rank,
        now,
        failed ? 1 : 0,
        JSON.stringify(report),
        JSON.stringify(run.trace),
      );
      return true;
    });
  }

  list({ status = 'open', taskId }: { status?: 'open' | 'closed'; taskId?: string } = {}): CaseList {
    return transaction(
      this.#db,
      () => {
        const rows = (
          taskId
            ? statement(this.#db, `${CASE} WHERE c.task_id = ? ORDER BY c.created_at DESC, c.rowid DESC LIMIT 20`).all(taskId)
            : status === 'open'
              ? statement(this.#db, `${CASE} WHERE c.status = 'open' ORDER BY c.priority_rank, c.created_at LIMIT 100`).all()
              : statement(this.#db, `${CASE} WHERE c.status <> 'open' ORDER BY c.closed_at DESC LIMIT 100`).all()
        ) as unknown as CaseRow[];
        const count = (sql: string) => (statement(this.#db, sql).get() as { n: number }).n;
        return {
          cases: rows.map(toSummary),
          open: count(`SELECT COUNT(*) AS n FROM agent_cases WHERE status = 'open'`),
          waiting: count('SELECT COUNT(*) AS n FROM tasks WHERE triage = 1'),
          reviewed: {
            correct: count(`SELECT COUNT(*) AS n FROM agent_cases WHERE verdict = 'correct'`),
            wrong: count(`SELECT COUNT(*) AS n FROM agent_cases WHERE verdict = 'wrong'`),
          },
          modelEnabled: this.#model !== null,
        };
      },
      'DEFERRED',
    );
  }

  get(id: string): CaseDetail {
    const row = this.#row(id);
    const messages = statement(
      this.#db,
      'SELECT id, at, asked_by AS askedBy, question, answer FROM agent_messages WHERE case_id = ? ORDER BY id',
    ).all(id) as unknown as { id: number; at: number; askedBy: string | null; question: string; answer: string }[];
    return {
      ...toSummary(row),
      taskVersion: row.task_version,
      report: JSON.parse(row.report) as CaseReport,
      trace: JSON.parse(row.trace) as ToolCall[],
      chosenOption: row.chosen_option,
      resolvedBy: row.resolved_by,
      closedAt: row.closed_at,
      verdictNote: row.verdict_note,
      verdictBy: row.verdict_by,
      messages: messages.map((m) => ({ ...m, answer: JSON.parse(m.answer) as Answer })),
    };
  }

  /** A person approves an option. It runs only if the task is still as the case described it. */
  apply(caseId: string, optionId: string, reason: string | undefined, operator?: string): CaseDetail {
    return transaction(this.#db, () => {
      const row = this.#row(caseId);
      if (row.status !== 'open') throw new StaleError(`This case is ${row.status}; its options no longer apply.`);
      const option = (JSON.parse(row.report) as CaseReport).options.find((o) => o.id === optionId);
      if (!option) throw new InvalidError('That option is not part of this case.');
      if (!option.command) throw new InvalidError('That option is for a person to carry out; there is nothing to run.');
      this.#service.command(
        row.task_id,
        { ...option.command, reason: reason ?? option.command.reason, expectedVersion: row.task_version },
        operator,
      );
      statement(
        this.#db,
        `UPDATE agent_cases SET status = 'resolved', chosen_option = ?, resolved_by = ?, closed_at = ? WHERE id = ?`,
      ).run(optionId, operator ?? null, this.#service.now(), caseId);
      return this.get(caseId);
    });
  }

  /** A person's judgement of the diagnosis. Optionally closes the case without acting. */
  review(caseId: string, verdict: Verdict, note: string | undefined, dismiss: boolean, operator?: string): CaseDetail {
    return transaction(this.#db, () => {
      const row = this.#row(caseId);
      if (verdict === 'wrong' && !note) throw new InvalidError('Say what was wrong, so it can be fixed.');
      statement(this.#db, 'UPDATE agent_cases SET verdict = ?, verdict_note = ?, verdict_by = ? WHERE id = ?').run(
        verdict,
        note ?? null,
        operator ?? null,
        caseId,
      );
      if (dismiss && row.status === 'open') {
        statement(this.#db, `UPDATE agent_cases SET status = 'dismissed', closed_at = ?, resolved_by = ? WHERE id = ?`).run(
          this.#service.now(),
          operator ?? null,
          caseId,
        );
      }
      return this.get(caseId);
    });
  }

  /** Answers a question and keeps both with the case. */
  async ask(caseId: string, question: string, operator?: string): Promise<Answer> {
    const row = this.#row(caseId);
    const report = JSON.parse(row.report) as CaseReport;
    const context = { db: this.#db, service: this.#service, taskId: row.task_id };
    const byRules = () => answerByRules(toolRunner(context), report, row.trigger, question);

    let answer: Answer;
    if (this.#model) {
      try {
        const names = this.#service.contributors().map((c) => c.name);
        const operators = statement(
          this.#db,
          'SELECT DISTINCT actor_name AS name FROM events WHERE task_id = ? AND actor_name IS NOT NULL',
        ).all(row.task_id) as { name: string }[];
        answer = await answerByModel(this.#model, toolRunner(context), report, question, [
          ...names,
          ...operators.map((o) => o.name),
        ]);
      } catch (error) {
        console.error('Model answer discarded:', (error as Error).message);
        answer = { ...byRules(), note: `The model was not used: ${(error as Error).message}.` };
      }
    } else {
      answer = byRules();
    }
    statement(this.#db, 'INSERT INTO agent_messages (case_id, at, asked_by, question, answer) VALUES (?, ?, ?, ?, ?)').run(
      caseId,
      this.#service.now(),
      operator ?? null,
      question,
      JSON.stringify(answer),
    );
    return answer;
  }

  #row(id: string): CaseRow {
    const row = statement(this.#db, `${CASE} WHERE c.id = ?`).get(id) as CaseRow | undefined;
    if (!row) throw new NotFoundError('That case does not exist.');
    return row;
  }
}
