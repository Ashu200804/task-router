/**
 * Loads people into the system from a JSON file: `npm run import -- organisation.json`.
 * The whole file is checked first and applied in one transaction. Running it again updates
 * the same people (matched by id) and leaves their work and record alone.
 */
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { BRANCHES, DEPARTMENTS, EXPERTISE, SENIORITIES, type Branch, type Expertise, type Profile, type WorkRecord } from '../shared/types.ts';
import { DB_PATH } from './config.ts';
import { openDatabase, statement, transaction } from './db.ts';
import { InvalidError } from './errors.ts';
import { addToRecord } from './people.ts';

const RECORD_FIELDS = [
  'accepted', 'declined', 'failed', 'completed', 'onTime', 'firstPass', 'ratingSum', 'ratingCount', 'responses', 'responseMs',
] as const;

interface Entry {
  id: string;
  name: string;
  branch: Branch;
  expertise: Expertise[];
  profile: Profile;
  /** Outcome history from an earlier system. Applied only when the person is first added. */
  record: Partial<WorkRecord>;
}

function parse(value: unknown, position: number): Entry {
  const fail = (problem: string) => {
    throw new InvalidError(`Contributor ${position + 1}: ${problem}.`);
  };
  if (typeof value !== 'object' || value === null) fail('must be an object');
  const v = value as Record<string, unknown>;
  const text = (key: string, fallback?: string): string => {
    const found = v[key] ?? fallback;
    if (typeof found !== 'string' || (!found.trim() && fallback === undefined)) fail(`"${key}" must be text`);
    return (found as string).trim();
  };
  const list = (key: string): string[] => {
    const found = v[key] ?? [];
    if (!Array.isArray(found) || found.some((x) => typeof x !== 'string')) fail(`"${key}" must be a list of text`);
    return found as string[];
  };
  const id = text('id');
  if (!/^[\w-]{1,80}$/.test(id)) fail('"id" may use letters, digits, dashes and underscores');
  const branch = text('branch') as Branch;
  if (!BRANCHES.includes(branch)) fail(`"branch" must be one of: ${BRANCHES.join(', ')}`);

  const levels = v.levels as Record<string, unknown> | undefined;
  if (typeof levels !== 'object' || levels === null || !Object.keys(levels).length) fail('"levels" must name at least one expertise');
  for (const [name, level] of Object.entries(levels!)) {
    if (!EXPERTISE.includes(name as Expertise)) fail(`unknown expertise "${name}"`);
    if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 5) fail(`level for "${name}" must be 1 to 5`);
  }
  const expertise = Object.keys(levels!) as Expertise[];

  const seniority = text('seniority', 'mid') as Profile['seniority'];
  if (!SENIORITIES.includes(seniority)) fail(`"seniority" must be one of: ${SENIORITIES.join(', ')}`);
  const weeklyHours = v.weeklyHours ?? 40;
  if (typeof weeklyHours !== 'number' || !(weeklyHours > 0)) fail('"weeklyHours" must be a positive number');

  const record = (v.record ?? {}) as Record<string, unknown>;
  for (const [key, n] of Object.entries(record)) {
    if (!(RECORD_FIELDS as readonly string[]).includes(key) || !Number.isInteger(n) || (n as number) < 0) {
      fail(`"record.${key}" is not a known count`);
    }
  }

  return {
    id,
    name: text('name'),
    branch,
    expertise,
    record: record as Partial<WorkRecord>,
    profile: {
      title: text('title', 'Contributor'),
      team: text('team', DEPARTMENTS[expertise[0]!]),
      seniority,
      lead: v.lead === true,
      levels: levels as Profile['levels'],
      skills: list('skills'),
      certifications: list('certifications'),
      languages: list('languages'),
      weeklyHours: weeklyHours as number,
      joined: text('joined', ''),
    },
  };
}

export function importContributors(db: DatabaseSync, data: unknown): { added: number; updated: number } {
  const items = (data as { contributors?: unknown })?.contributors;
  if (!Array.isArray(items) || !items.length) throw new InvalidError('The file needs a non-empty "contributors" list.');
  const entries = items.map(parse);
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new InvalidError('Two contributors share an id.');

  return transaction(db, () => {
    let added = 0;
    for (const e of entries) {
      const exists = statement(db, 'SELECT 1 FROM contributors WHERE id = ?').get(e.id) !== undefined;
      statement(
        db,
        `INSERT INTO contributors (id, name, branch, expertise, profile) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, branch = excluded.branch,
           expertise = excluded.expertise, profile = excluded.profile`,
      ).run(e.id, e.name, e.branch, JSON.stringify(e.expertise), JSON.stringify(e.profile));
      if (!exists) {
        added++;
        addToRecord(db, e.id, e.record);
      }
    }
    return { added, updated: entries.length - added };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run import -- <file.json>');
    process.exit(1);
  }
  try {
    const db = openDatabase(DB_PATH);
    const { added, updated } = importContributors(db, JSON.parse(readFileSync(file, 'utf8')));
    console.log(`Imported: ${added} added, ${updated} updated.`);
    db.close();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
