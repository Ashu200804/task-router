/** Read models for managers: how a project is going, and what a person is doing. */
import type { DatabaseSync } from 'node:sqlite';
import type {
  ActivityItem,
  Contributor,
  PersonDetail,
  ProjectHealth,
  ProjectReport,
  ProjectSummary,
  Risk,
  TaskSummary,
} from '../shared/types.ts';
import { statement } from './db.ts';
import { NotFoundError } from './errors.ts';
import { allContributors, findContributor } from './people.ts';
import { workingHours } from './planner.ts';
import { blockers } from './scoring.ts';
import { SUMMARY, toSummary, type SummaryRow } from './summary.ts';

type ProjectRow = Pick<ProjectSummary, 'id' | 'name' | 'goal' | 'branch' | 'owner' | 'priority'> & {
  created_at: number;
  due_at: number | null;
};

const closed = (t: TaskSummary) => t.status === 'completed' || t.status === 'cancelled';

function projectTasks(db: DatabaseSync, projectId: string): TaskSummary[] {
  const rows = statement(db, `${SUMMARY} WHERE t.project_id = ? ORDER BY t.created_at, t.rowid`).all(projectId);
  return (rows as unknown as SummaryRow[]).map(toSummary);
}

/** Longest chain of unfinished work. Tasks are in creation order, so dependencies come first. */
function criticalPath(db: DatabaseSync, tasks: TaskSummary[]): number {
  const finish = new Map<string, number>();
  const dependsOn = statement(db, 'SELECT depends_on AS id FROM dependencies WHERE task_id = ?');
  for (const t of tasks) {
    const own = closed(t) ? 0 : t.requirements.estimateHours * (1 - t.progress / 100);
    const before = (dependsOn.all(t.id) as { id: string }[]).map((d) => finish.get(d.id) ?? 0);
    finish.set(t.id, own + Math.max(0, ...before));
  }
  return Math.round(Math.max(0, ...finish.values()) * 10) / 10;
}

/** What a manager should look at, most serious first. Each line says why. */
function risksIn(tasks: TaskSummary[]): Risk[] {
  const risks: Risk[] = [];
  for (const t of tasks) {
    if (closed(t)) continue;
    const add = (severity: Risk['severity'], text: string) =>
      risks.push({ taskId: t.id, severity, text: `${t.title}: ${text}` });
    if (t.pastDueSince !== null) add('high', 'past its due date.');
    if (t.blocker) add('high', `blocked. “${t.blocker}”`);
    if (t.status === 'needs_attention') {
      add('high', `needs a decision (${t.attentionReason?.replaceAll('_', ' ')}).`);
    }
    if (t.assigneeUnavailable) add('medium', `${t.assignee?.name} is unavailable but still holds it.`);
    if (t.overdueSince !== null) add('medium', 'routing has had no answer for longer than normal.');
    if (t.quietSince !== null) add('medium', `no report from ${t.assignee?.name} within the check-in interval.`);
    if (t.status === 'in_review') add('medium', 'submitted and waiting for review.');
  }
  return risks.sort((a, b) => Number(b.severity === 'high') - Number(a.severity === 'high'));
}

/** Work that has not started and that nobody in the branch could take. Better to know now. */
function unfillable(tasks: TaskSummary[], people: Contributor[]): Risk[] {
  return tasks
    .filter((t) => t.status === 'draft')
    .filter((t) => {
      const need = { ...t.requirements, branch: t.branch, expertise: t.expertise, priority: t.priority };
      return !people.some((p) => blockers(p, need).length === 0);
    })
    .map((t) => ({ taskId: t.id, severity: 'medium' as const, text: `${t.title}: nobody in ${t.branch} can take it right now.` }));
}

function assess(db: DatabaseSync, row: ProjectRow, now: number, people: Contributor[]) {
  const tasks = projectTasks(db, row.id);
  const live = tasks.filter((t) => t.status !== 'cancelled');
  const done = live.filter((t) => t.status === 'completed');
  const criticalPathHours = criticalPath(db, tasks);
  const complete = live.length > 0 && done.length === live.length;

  const risks = complete ? [] : [...risksIn(tasks), ...unfillable(tasks, people)];
  let late = false;
  if (!complete && row.due_at !== null) {
    const available = workingHours(now, row.due_at);
    if (row.due_at < now) {
      late = true;
      risks.unshift({ taskId: null, severity: 'high', text: 'The project deadline has passed.' });
    } else if (criticalPathHours > available) {
      late = true;
      risks.unshift({
        taskId: null,
        severity: 'high',
        text: `About ${Math.round(criticalPathHours)} working hours remain on the longest chain, with about ${Math.round(available)} before the deadline.`,
      });
    }
  }
  const health: ProjectHealth = complete
    ? 'complete'
    : late || tasks.some((t) => !closed(t) && t.pastDueSince !== null)
      ? 'off_track'
      : risks.length
        ? 'at_risk'
        : 'on_track';

  const hours = (list: TaskSummary[], share: (t: TaskSummary) => number) =>
    Math.round(list.reduce((sum, t) => sum + t.requirements.estimateHours * share(t), 0) * 10) / 10;
  const summary: ProjectSummary = {
    id: row.id,
    name: row.name,
    goal: row.goal,
    branch: row.branch,
    owner: row.owner,
    priority: row.priority,
    createdAt: row.created_at,
    dueAt: row.due_at,
    health,
    taskCount: live.length,
    doneCount: done.length,
    totalHours: hours(live, () => 1),
    earnedHours: hours(live, (t) => (t.status === 'completed' ? 1 : t.progress / 100)),
    riskCount: risks.length,
  };
  return { summary, tasks, risks, criticalPathHours };
}

export function listProjects(db: DatabaseSync, now: number): ProjectSummary[] {
  const rows = statement(db, 'SELECT * FROM projects ORDER BY created_at DESC LIMIT 100').all() as unknown as ProjectRow[];
  const people = allContributors(db);
  return rows.map((row) => assess(db, row, now, people).summary);
}

export function projectReport(db: DatabaseSync, id: string, now: number): ProjectReport {
  const row = statement(db, 'SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!row) throw new NotFoundError('That project does not exist.');
  const { summary, tasks, risks, criticalPathHours } = assess(db, row, now, allContributors(db));

  const activity = statement(
    db,
    `SELECT e.id, e.at, e.task_id AS taskId, t.title AS taskTitle, COALESCE(e.actor_name, e.actor) AS actor, e.summary
     FROM events e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ? ORDER BY e.id DESC LIMIT 40`,
  ).all(id) as unknown as ActivityItem[];

  const involved = new Map<string, number>();
  for (const t of tasks) {
    if (t.assignee) involved.set(t.assignee.contributorId, (involved.get(t.assignee.contributorId) ?? 0) + 1);
  }
  const team = [...involved].map(([contributorId, taskCount]) => {
    const p = findContributor(db, contributorId)!;
    return { id: p.id, name: p.name, title: p.profile.title, taskCount, loadHours: p.loadHours, weeklyHours: p.profile.weeklyHours };
  });

  return {
    project: summary,
    tasks,
    risks,
    activity,
    team,
    ready: tasks.filter((t) => t.status === 'draft' && t.waitingOn.length === 0).map((t) => t.id),
    criticalPathHours,
  };
}

export function personDetail(db: DatabaseSync, id: string): PersonDetail {
  const person = findContributor(db, id);
  if (!person) throw new NotFoundError('That contributor does not exist.');
  const lead = allContributors(db).find(
    (c) => c.profile.lead && c.branch === person.branch && c.profile.team === person.profile.team && c.id !== id,
  );
  const rows = statement(
    db,
    `${SUMMARY} WHERE a.contributor_id = ? AND a.status IN ('offered', 'accepted', 'in_progress', 'in_review')
     ORDER BY t.priority_rank, t.created_at LIMIT 50`,
  ).all(id) as unknown as SummaryRow[];
  const activity = statement(
    db,
    `SELECT e.id, e.at, e.task_id AS taskId, t.title AS taskTitle, COALESCE(e.actor_name, e.actor) AS actor, e.summary
     FROM events e JOIN tasks t ON t.id = e.task_id WHERE e.contributor_id = ? ORDER BY e.id DESC LIMIT 30`,
  ).all(id) as unknown as ActivityItem[];
  return { person, lead: lead?.name ?? null, tasks: rows.map(toSummary), activity };
}
