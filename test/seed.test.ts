import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../server/db.ts';
import { RoutingEngine } from '../server/engine.ts';
import { importContributors } from '../server/import.ts';
import { seedIfEmpty } from '../server/seed.ts';
import { TaskService } from '../server/service.ts';

const open = () => {
  const db = openDatabase(':memory:');
  return { db, service: new TaskService(db, new RoutingEngine(db)) };
};

test('an empty database gets a small set covering the main situations, once', () => {
  const { db, service } = open();
  seedIfEmpty(db);
  seedIfEmpty(db);
  const { tasks, total } = service.list();
  assert.equal(service.contributors().length, 6);
  assert.equal(total, 7);
  assert.deepEqual(
    tasks.map((t) => t.status).sort(),
    ['completed', 'draft', 'draft', 'in_progress', 'needs_attention', 'offered', 'routing'],
  );
  for (const t of tasks) {
    const active = service.detail(t.id).assignments.filter((a) => ['offered', 'accepted', 'in_progress', 'in_review'].includes(a.status));
    assert.ok(active.length <= 1);
  }
});

test('a database that already has people is left alone', () => {
  const { db, service } = open();
  importContributors(db, { contributors: [{ id: 'own', name: 'Own', branch: 'London', levels: { finance: 3 } }] });
  seedIfEmpty(db);
  assert.equal(service.contributors().length, 1);
  assert.equal(service.list().total, 0);
});
