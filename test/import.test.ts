import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../server/db.ts';
import { InvalidError } from '../server/errors.ts';
import { importContributors } from '../server/import.ts';
import { findContributor } from '../server/people.ts';

const entry = { id: 'p1', name: 'Person One', branch: 'London', levels: { finance: 4 } };

test('imports people with defaults, and updates them without touching their record', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(importContributors(db, { contributors: [{ ...entry, record: { completed: 3 } }] }), { added: 1, updated: 0 });
  const first = findContributor(db, 'p1')!;
  assert.deepEqual([first.profile.team, first.profile.weeklyHours, first.record.completed], ['Finance', 40, 3]);

  const again = importContributors(db, { contributors: [{ ...entry, name: 'Renamed', record: { completed: 99 } }] });
  assert.deepEqual(again, { added: 0, updated: 1 });
  const second = findContributor(db, 'p1')!;
  assert.deepEqual([second.name, second.record.completed], ['Renamed', 3]);
});

test('one bad entry rejects the whole file with a reason', () => {
  const db = openDatabase(':memory:');
  for (const bad of [
    { ...entry, id: 'p2', branch: 'Mars' },
    { ...entry, id: 'p2', levels: { finance: 9 } },
    { ...entry, id: 'p2', levels: {} },
    { ...entry, id: 'p2', name: ' ' },
    { ...entry, id: 'p2', weeklyHours: -1 },
    { ...entry },
  ]) {
    assert.throws(() => importContributors(db, { contributors: [entry, bad] }), InvalidError);
  }
  assert.equal(findContributor(db, 'p1'), null);
  assert.throws(() => importContributors(db, {}), /non-empty/);
});
