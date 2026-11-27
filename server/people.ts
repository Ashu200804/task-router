/** Loading contributors with their profile, track record and current load. */
import type { DatabaseSync } from 'node:sqlite';
import type { Contributor, Profile, WorkRecord } from '../shared/types.ts';
import { statement } from './db.ts';

const SELECT = `
  SELECT c.id, c.name, c.branch, c.expertise, c.available, c.profile,
    c.active_count AS activeCount, ROUND(c.load_hours, 2) AS loadHours,
    w.accepted, w.declined, w.failed, w.completed, w.on_time AS onTime, w.first_pass AS firstPass,
    w.rating_sum AS ratingSum, w.rating_count AS ratingCount, w.responses, w.response_ms AS responseMs
  FROM contributors c LEFT JOIN work_records w ON w.contributor_id = c.id`;

type Row = { id: string; name: string; branch: Contributor['branch']; expertise: string; available: number; profile: string; activeCount: number; loadHours: number } & {
  [K in keyof WorkRecord]: number | null;
};

const DEFAULT_PROFILE: Profile = {
  title: 'Contributor',
  team: 'Unassigned',
  seniority: 'mid',
  lead: false,
  levels: {},
  skills: [],
  certifications: [],
  languages: [],
  weeklyHours: 40,
  joined: '',
};

function toContributor(row: Row): Contributor {
  const expertise = JSON.parse(row.expertise) as Contributor['expertise'];
  const profile = { ...DEFAULT_PROFILE, ...(JSON.parse(row.profile) as Partial<Profile>) };
  // Someone listing an expertise without a stated level is taken to be competent.
  profile.levels = { ...Object.fromEntries(expertise.map((e) => [e, 3])), ...profile.levels };
  const record: WorkRecord = {
    accepted: row.accepted ?? 0,
    declined: row.declined ?? 0,
    failed: row.failed ?? 0,
    completed: row.completed ?? 0,
    onTime: row.onTime ?? 0,
    firstPass: row.firstPass ?? 0,
    ratingSum: row.ratingSum ?? 0,
    ratingCount: row.ratingCount ?? 0,
    responses: row.responses ?? 0,
    responseMs: row.responseMs ?? 0,
  };
  return {
    id: row.id,
    name: row.name,
    branch: row.branch,
    expertise,
    available: row.available === 1,
    profile,
    record,
    activeCount: row.activeCount,
    loadHours: row.loadHours,
  };
}

export const allContributors = (db: DatabaseSync): Contributor[] =>
  (statement(db, `${SELECT} ORDER BY c.name, c.id`).all() as unknown as Row[]).map(toContributor);

export const contributorsIn = (db: DatabaseSync, branch: string): Contributor[] =>
  (statement(db, `${SELECT} WHERE c.branch = ? ORDER BY c.name, c.id`).all(branch) as unknown as Row[]).map(toContributor);

export function findContributor(db: DatabaseSync, id: string): Contributor | null {
  const row = statement(db, `${SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
  return row ? toContributor(row) : null;
}

/** Adds outcomes to someone's record. Call inside the transaction that records the outcome. */
export function addToRecord(db: DatabaseSync, contributorId: string, delta: Partial<WorkRecord>): void {
  const d = (key: keyof WorkRecord) => delta[key] ?? 0;
  statement(db, 'INSERT INTO work_records (contributor_id) VALUES (?) ON CONFLICT DO NOTHING').run(contributorId);
  statement(
    db,
    `UPDATE work_records SET accepted = accepted + ?, declined = declined + ?, failed = failed + ?,
       completed = completed + ?, on_time = on_time + ?, first_pass = first_pass + ?,
       rating_sum = rating_sum + ?, rating_count = rating_count + ?, responses = responses + ?,
       response_ms = response_ms + ? WHERE contributor_id = ?`,
  ).run(
    d('accepted'), d('declined'), d('failed'), d('completed'), d('onTime'), d('firstPass'),
    d('ratingSum'), d('ratingCount'), d('responses'), d('responseMs'), contributorId,
  );
}
