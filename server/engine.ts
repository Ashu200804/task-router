/**
 * Simulation of an external routing engine.
 *
 * It accepts a request, and some time later calls back with an answer, or never does.
 * It knows nothing about tasks changing after submission: it cannot be cancelled, and it
 * delivers answers at least once. Coping with both is the application's job.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Expertise, Priority, Scenario } from '../shared/types.ts';
import { statement } from './db.ts';

export interface RoutingInput {
  requestId: string;
  scenario: Scenario;
  task: { id: string; title: string; expertise: Expertise; priority: Priority };
  /** Everyone who meets the requirements at submission time, with how well they fit. */
  candidates: { id: string; score: number }[];
}

export type RoutingResponse = { outcome: 'match'; contributorId: string } | { outcome: 'no_match' };

export const TIMING = {
  normalMinMs: 5_000,
  normalMaxMs: 20_000,
  fastMs: 6_000,
  slowMs: 45_000,
  neverRate: 0.2,
};

/** Score points within which candidates count as equally good. */
const NEAR_EQUAL = 5;

export class RoutingEngine {
  #db: DatabaseSync;
  #random: () => number;
  /** Below 1 compresses time, for load testing. */
  #timeScale: number;

  constructor(db: DatabaseSync, random: () => number = Math.random, timeScale = 1) {
    this.#db = db;
    this.#random = random;
    this.#timeScale = timeScale;
  }

  /** Idempotent: submitting the same request id again changes nothing. */
  submit(input: RoutingInput, now: number): void {
    const delay = this.#delay(input.scenario);
    const response = delay === null ? null : this.#decide(input);
    statement(
      this.#db,
      `INSERT INTO engine_jobs (request_id, deliver_at, response) VALUES (?, ?, ?)
       ON CONFLICT (request_id) DO NOTHING`,
    ).run(
      input.requestId,
      delay === null ? null : now + Math.round(delay * this.#timeScale),
      response && JSON.stringify(response),
    );
  }

  /**
   * Hands over answers that are due, oldest first. A job is marked delivered only after the
   * receiver returns, in the caller's transaction, so a crash causes redelivery, not loss.
   * Returns true if more are waiting.
   */
  deliverDue(now: number, receive: (requestId: string, rawResponse: string) => void, limit = 500): boolean {
    const due = statement(
      this.#db,
      `SELECT request_id, response FROM engine_jobs
       WHERE delivered_at IS NULL AND deliver_at IS NOT NULL AND deliver_at <= ?
       ORDER BY deliver_at LIMIT ?`,
    ).all(now, limit) as { request_id: string; response: string }[];

    for (const job of due) {
      receive(job.request_id, job.response);
      statement(this.#db, 'UPDATE engine_jobs SET delivered_at = ? WHERE request_id = ?').run(now, job.request_id);
    }
    return due.length === limit;
  }

  /** Returns null for a request that will never come back. */
  #delay(scenario: Scenario): number | null {
    switch (scenario) {
      case 'never':
        return null;
      case 'slow':
        return TIMING.slowMs;
      case 'match':
      case 'no_match':
        return TIMING.fastMs;
      case 'random': {
        if (this.#random() < TIMING.neverRate) return null;
        return Math.round(TIMING.normalMinMs + this.#random() * (TIMING.normalMaxMs - TIMING.normalMinMs));
      }
    }
  }

  /**
   * One of the best fitting candidates. Choosing at random among near-equals stops a burst
   * of similar tasks all landing on one person.
   */
  #decide({ scenario, candidates }: RoutingInput): RoutingResponse {
    if (scenario === 'no_match' || candidates.length === 0) return { outcome: 'no_match' };
    const top = Math.max(...candidates.map((c) => c.score));
    const close = candidates.filter((c) => c.score >= top - NEAR_EQUAL);
    const chosen = close[Math.floor(this.#random() * close.length)] ?? close[0]!;
    return { outcome: 'match', contributorId: chosen.id };
  }
}
