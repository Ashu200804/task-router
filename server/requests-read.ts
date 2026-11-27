import type { DatabaseSync } from 'node:sqlite';
import type { WorkRequest } from '../shared/types.ts';
import { statement } from './db.ts';

const SELECT = `
  SELECT r.*, t.title AS task_title, f.name AS from_name, h.name AS handler_name
  FROM work_requests r JOIN tasks t ON t.id = r.task_id JOIN contributors f ON f.id = r.from_id
  LEFT JOIN contributors h ON h.id = r.handler_id`;

interface Row {
  id: string;
  task_id: string;
  task_title: string;
  type: WorkRequest['type'];
  text: string;
  days: number | null;
  from_id: string;
  from_name: string;
  handler_id: string | null;
  handler_name: string | null;
  status: WorkRequest['status'];
  routing: string;
  response: string | null;
  suggestion: string | null;
  helper_task_id: string | null;
  created_at: number;
  closed_at: number | null;
}

const toRequest = (r: Row): WorkRequest => ({
  id: r.id,
  taskId: r.task_id,
  taskTitle: r.task_title,
  type: r.type,
  text: r.text,
  days: r.days,
  from: { id: r.from_id, name: r.from_name },
  handler: r.handler_id ? { id: r.handler_id, name: r.handler_name! } : null,
  status: r.status,
  routing: r.routing,
  response: r.response,
  suggestion: r.suggestion ? (JSON.parse(r.suggestion) as WorkRequest['suggestion']) : null,
  helperTaskId: r.helper_task_id,
  createdAt: r.created_at,
  closedAt: r.closed_at,
});

export function readRequests(
  db: DatabaseSync,
  by: 'id' | 'task' | 'handler' | 'sender',
  value: string,
): WorkRequest[] {
  const where = {
    id: 'r.id = ?',
    task: 'r.task_id = ?',
    handler: `r.handler_id = ? AND r.status = 'open'`,
    sender: 'r.from_id = ?',
  }[by];
  const rows = statement(db, `${SELECT} WHERE ${where} ORDER BY r.created_at DESC, r.rowid DESC LIMIT 50`).all(value);
  return (rows as unknown as Row[]).map(toRequest);
}
