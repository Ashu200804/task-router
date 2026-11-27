/** Measures how cost grows with data size. `npm run bench` */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../server/db.ts';
import { RoutingEngine } from '../server/engine.ts';
import { TaskService } from '../server/service.ts';

const timed = (work: () => void) => {
  const start = performance.now();
  work();
  return performance.now() - start;
};

const rows = [];
for (const size of [1_000, 6_000, 50_000]) {
  const dir = mkdtempSync(join(tmpdir(), 'router-bench-'));
  const db = openDatabase(join(dir, 'app.db'));
  transaction(db, () => {
    const insert = db.prepare('INSERT INTO contributors (id, name, branch, expertise, profile) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 200; i++) insert.run(`c${i}`, `c${i}`, 'London', '["finance"]', '{"weeklyHours":1000000}');
  });
  const clock = { now: 1_000_000 };
  const service = new TaskService(db, new RoutingEngine(db, () => 0.5), { now: () => clock.now });
  const create = timed(() => {
    for (let i = 0; i < size; i++) {
      service.createTask({ title: 't', description: '', expertise: 'finance', branch: 'London', priority: 'normal', submit: true, scenario: 'match' });
    }
  });
  let longest = 0;
  const drain = () => {
    let more = true;
    return timed(() => {
      while (more) longest = Math.max(longest, timed(() => (more = service.tick().more)));
    });
  };
  const dispatch = drain();
  clock.now += 6_000;
  const apply = drain();
  let bytes = 0;
  const page = timed(() => (bytes = JSON.stringify(service.list()).length));
  rows.push({
    tasks: size,
    'creates/s': Math.round((size / create) * 1000),
    'dispatch all (s)': +(dispatch / 1000).toFixed(2),
    'apply all (s)': +(apply / 1000).toFixed(2),
    'longest pause (ms)': Math.round(longest),
    'list page (ms)': +page.toFixed(1),
    'page size (KB)': Math.round(bytes / 1024),
  });
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
console.table(rows);
