import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../server/db.ts';
import { RoutingEngine, TIMING, type RoutingResponse } from '../server/engine.ts';

/** Small seeded generator so the distribution test is repeatable. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random mode: about 20% never return, the rest take 5-20s and pick an eligible candidate', () => {
  const db = openDatabase(':memory:');
  const engine = new RoutingEngine(db, seeded(7));
  const total = 2000;
  for (let i = 0; i < total; i++) {
    engine.submit(
      {
        requestId: `r${i}`,
        scenario: 'random',
        task: { id: 't', title: 't', expertise: 'finance', priority: 'normal' },
        candidates: [{ id: 'weaker', score: 40 }, { id: 'stronger', score: 80 }],
      },
      0,
    );
  }

  const delivered: RoutingResponse[] = [];
  const collect = (_: string, raw: string) => void delivered.push(JSON.parse(raw) as RoutingResponse);
  engine.deliverDue(TIMING.normalMinMs - 1, collect, total);
  assert.equal(delivered.length, 0);
  engine.deliverDue(TIMING.normalMaxMs, collect, total);
  const returned = delivered.length;
  engine.deliverDue(Number.MAX_SAFE_INTEGER, collect, total);

  assert.equal(delivered.length, returned, 'nothing arrives after the normal window');
  const neverShare = 1 - returned / total;
  assert.ok(neverShare > 0.17 && neverShare < 0.23, `never share was ${neverShare}`);
  assert.ok(delivered.every((r) => r.outcome === 'match' && r.contributorId === 'stronger'));
});
