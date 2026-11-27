import type { AttentionReason, ProjectHealth, TaskStatus, TaskSummary } from '../../shared/types.ts';

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/** Time of day, with the date when it was not today. */
export function clockTime(at: number): string {
  const when = new Date(at);
  const today = when.toDateString() === new Date().toDateString();
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return today ? time : `${date(at)} ${time}`;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: 'Draft',
  routing: 'Routing',
  needs_attention: 'Needs attention',
  offered: 'Awaiting response',
  accepted: 'Accepted',
  in_progress: 'In progress',
  in_review: 'Awaiting review',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const ATTENTION_LABEL: Record<AttentionReason, string> = {
  no_match: 'No match found',
  declined: 'Declined',
  failed: 'Assignment failed',
  routing_stopped: 'Routing stopped',
  withdrawn: 'Assignment withdrawn',
  contributor_unavailable: 'Contributor unavailable',
  over_capacity: 'Everyone chosen was full',
  routing_error: 'Routing error',
};

export const HEALTH_LABEL: Record<ProjectHealth, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
  complete: 'Complete',
};

export const date = (at: number) => new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' });

/** "82%" with its sample, or a dash when there is nothing to measure. */
export const rate = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

/** A short flag shown instead of the plain status when something needs a look. */
export function warningLabel(task: TaskSummary): string | null {
  if (task.status === 'completed' || task.status === 'cancelled') return null;
  if (task.blocker) return 'Blocked';
  if (task.assigneeUnavailable) return 'Holder unavailable';
  if (task.pastDueSince !== null) return 'Past due';
  if (task.quietSince !== null) return 'No recent report';
  if (task.overdueSince === null) return null;
  return task.pendingRequest?.sentAt === null ? 'Routing · delayed' : 'Routing · overdue';
}

/** 17:00 local time on a date from a date input. */
export const endOfWorkingDay = (day: string) => new Date(`${day}T17:00:00`).getTime();
