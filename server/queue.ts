/**
 * A durable work queue in the same database as the data it changes.
 *
 * Delivery is at least once. Because a job is claimed, executed and removed inside one
 * transaction, its effect on our data happens exactly once: a crash rolls back all three.
 * The database's single writer means two instances can never run the same job together.
 *
 * If a handler ever calls a real network service, that call cannot sit inside the
 * transaction. It would need a lease on the job and an idempotent receiver.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Health, Priority } from '../shared/types.ts';
import { statement, transaction } from './db.ts';
import { PermanentError } from './errors.ts';

export const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 60_000;
/** A high priority job runs as if it had been queued this much earlier. Old work still gets its turn. */
const HEAD_START_MS: Record<Priority, number> = { high: 60_000, normal: 30_000, low: 0 };

export type JobKind = 'dispatch' | 'apply';

export interface Job {
  id: number;
  kind: JobKind;
  request_id: string;
  payload: string | null;
  attempts: number;
}

export class Queue {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Idempotent per (kind, request). Call inside the transaction that creates the need for it. */
  add(kind: JobKind, requestId: string, priority: Priority, now: number, payload: string | null = null): void {
    statement(
      this.#db,
      `INSERT INTO jobs (kind, request_id, payload, created_at, rank, run_after) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, request_id) DO NOTHING`,
    ).run(kind, requestId, payload, now, now - HEAD_START_MS[priority], now);
  }

  /**
   * Runs ready jobs for about `budgetMs`, then commits them together (one disk sync for the
   * batch). Each job has its own savepoint, so a failing one does not undo or block the rest.
   * Returns true if ready work remains.
   */
  run(
    now: number,
    handle: (job: Job) => void,
    onDead: (job: Job, error: Error) => void,
    budgetMs: number,
  ): boolean {
    return transaction(this.#db, () => {
      const started = performance.now();
      const ready = statement(
        this.#db,
        `SELECT id, kind, request_id, payload, attempts FROM jobs
         WHERE dead_at IS NULL AND run_after <= ? ORDER BY rank, id LIMIT 500`,
      ).all(now) as unknown as Job[];

      let done = 0;
      for (const job of ready) {
        if (done > 0 && performance.now() - started >= budgetMs) break;
        done++;
        try {
          transaction(this.#db, () => {
            handle(job);
            statement(this.#db, 'DELETE FROM jobs WHERE id = ?').run(job.id);
          });
        } catch (error) {
          if (!this.#db.isTransaction) throw error; // the whole batch is gone
          this.#fail(job, error as Error, now, onDead);
        }
      }
      return done < ready.length || ready.length === 500;
    });
  }

  #fail(job: Job, error: Error, now: number, onDead: (job: Job, error: Error) => void): void {
    const attempts = job.attempts + 1;
    const dead = error instanceof PermanentError || attempts >= MAX_ATTEMPTS;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempts - 1));
    statement(this.#db, 'UPDATE jobs SET attempts = ?, run_after = ?, dead_at = ?, last_error = ? WHERE id = ?').run(
      attempts,
      now + delay,
      dead ? now : null,
      error.message,
      job.id,
    );
    console.error(
      `Job ${job.id} (${job.kind}) failed, attempt ${attempts}${dead ? ', giving up' : `, retrying in ${delay}ms`}: ${error.message}`,
    );
    if (dead) onDead(job, error);
  }

  health(now: number): Health {
    const row = statement(
      this.#db,
      `SELECT COUNT(*) FILTER (WHERE dead_at IS NULL) AS queued,
              MIN(created_at) FILTER (WHERE dead_at IS NULL) AS oldest,
              COUNT(*) FILTER (WHERE dead_at IS NOT NULL) AS dead
       FROM jobs`,
    ).get() as { queued: number; oldest: number | null; dead: number };
    return {
      queuedJobs: row.queued,
      oldestJobAgeMs: row.oldest === null ? 0 : Math.max(0, now - row.oldest),
      deadJobs: row.dead,
    };
  }
}
