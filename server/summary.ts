/** The row shape shown in lists. One query returns it, so cost does not grow per task. */
import { QUEUES, type Assignee, type AssignmentStatus, type TaskSummary } from '../shared/types.ts';

export const SUMMARY = `
  SELECT t.*,
         a.id AS a_id, a.contributor_id AS a_contributor, c.name AS a_name, a.status AS a_status,
         a.updated_at AS a_since,
         r.attempt AS p_attempt, r.requested_at AS p_requested, r.dispatched_at AS p_sent,
         (SELECT name FROM contributors q WHERE q.id = t.requester_id) AS requester_name,
         (SELECT COUNT(*) FROM routing_requests x WHERE x.task_id = t.id) AS attempts,
         (SELECT json_group_array(d.depends_on) FROM dependencies d JOIN tasks o ON o.id = d.depends_on
           WHERE d.task_id = t.id AND o.status NOT IN ('completed', 'cancelled')) AS waiting_on
  FROM tasks t
  LEFT JOIN assignments a ON a.task_id = t.id
    AND a.status IN ('offered', 'accepted', 'in_progress', 'in_review', 'completed')
  LEFT JOIN contributors c ON c.id = a.contributor_id
  LEFT JOIN routing_requests r ON r.task_id = t.id AND r.state = 'pending'`;

export interface SummaryRow {
  id: string;
  title: string;
  description: string;
  expertise: TaskSummary['expertise'];
  branch: TaskSummary['branch'];
  priority: TaskSummary['priority'];
  status: TaskSummary['status'];
  attention_reason: TaskSummary['attentionReason'];
  version: number;
  created_at: number;
  status_since: number;
  overdue_since: number | null;
  holder_away: number;
  queue_rank: number;
  project_id: string | null;
  estimate_hours: number;
  due_at: number | null;
  min_level: number;
  certification: string | null;
  skills: string;
  progress: number;
  blocker: string | null;
  quiet_since: number | null;
  past_due_since: number | null;
  last_activity_at: number;
  a_id: string | null;
  a_contributor: string;
  a_name: string;
  a_status: AssignmentStatus;
  a_since: number;
  p_attempt: number | null;
  p_requested: number;
  p_sent: number | null;
  attempts: number;
  waiting_on: string;
  requester_id: string | null;
  requester_name: string | null;
}

export function toSummary(r: SummaryRow): TaskSummary {
  const assignee: Assignee | null = r.a_id
    ? { assignmentId: r.a_id, contributorId: r.a_contributor, name: r.a_name, status: r.a_status, since: r.a_since }
    : null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    expertise: r.expertise,
    branch: r.branch,
    priority: r.priority,
    status: r.status,
    queue: QUEUES[r.queue_rank]!,
    attentionReason: r.attention_reason,
    version: r.version,
    createdAt: r.created_at,
    statusSince: r.status_since,
    assignee,
    pendingRequest:
      r.p_attempt === null ? null : { attempt: r.p_attempt, requestedAt: r.p_requested, sentAt: r.p_sent },
    overdueSince: r.overdue_since,
    assigneeUnavailable: r.holder_away === 1,
    routingAttempts: r.attempts,
    requester: r.requester_id ? { id: r.requester_id, name: r.requester_name! } : null,
    projectId: r.project_id,
    requirements: {
      minLevel: r.min_level,
      certification: r.certification,
      skills: JSON.parse(r.skills) as string[],
      estimateHours: r.estimate_hours,
    },
    dueAt: r.due_at,
    progress: r.progress,
    blocker: r.blocker,
    quietSince: r.quiet_since,
    pastDueSince: r.past_due_since,
    waitingOn: JSON.parse(r.waiting_on) as string[],
    lastActivityAt: r.last_activity_at,
  };
}
