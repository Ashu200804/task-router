import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from '../server/api.ts';
import { setup } from './helpers.ts';

const h = setup();
const server = createApp(h.service);
let base = '';
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => void server.close());

const post = async (path: string, body: unknown, type = 'application/json') => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const task = {
  title: 'Audit',
  expertise: 'finance',
  branch: 'London',
  priority: 'high',
  submit: true,
  scenario: 'never',
};

test('create, read and act on a task', async () => {
  const created = await post('/api/tasks', task);
  assert.equal(created.status, 201);
  const { id, version } = created.body;

  const stale = await post(`/api/tasks/${id}/commands`, { action: 'cancel', expectedVersion: version - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale');

  const stopped = await post(`/api/tasks/${id}/commands`, { action: 'stop_routing', expectedVersion: version });
  assert.equal(stopped.body.status, 'needs_attention');
});

test('responses never reveal how a pending request will end', async () => {
  const { body } = await post('/api/tasks', task);
  h.drain();
  for (const path of ['/api/tasks', `/api/tasks/${body.id}`]) {
    const text = await (await fetch(base + path)).text();
    assert.doesNotMatch(text, /scenario|never|deliver/i);
  }
});

test('rejects bad input', async () => {
  assert.equal((await post('/api/tasks', { ...task, title: '  ' })).status, 400);
  assert.equal((await post('/api/tasks', { ...task, expertise: 'astrology' })).status, 400);
  assert.equal((await post('/api/tasks', task, 'text/plain')).status, 400);
  assert.equal((await post('/api/tasks/T-999/commands', { action: 'cancel', expectedVersion: 1 })).status, 404);
  assert.equal((await post('/api/tasks/T-101/commands', { action: 'accept', expectedVersion: 1 })).status, 400);
});
