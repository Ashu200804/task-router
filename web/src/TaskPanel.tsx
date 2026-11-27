import { useState } from 'react';
import {
  CONTRIBUTOR_ACTIONS,
  OPERATOR_ACTIONS,
  type Action,
  type Candidate,
  type CaseList,
  type RoutingAttempt,
  type TaskDetail,
  type TaskSummary,
} from '../../shared/types.ts';
import { ApiError, post, useIdempotencyKey, useResource } from './api.ts';
import { Fit, Progress } from './Fit.tsx';
import { Requests } from './Requests.tsx';
import { ActionDialog, type ActionInput } from './ActionDialog.tsx';
import { ACTIONS, isContributorAction } from './actions.ts';
import { StatusBadge } from './TaskTable.tsx';
import { STATUS_LABEL, clockTime, duration } from './format.ts';

interface Props {
  detail: TaskDetail;
  now: number;
  online: boolean;
  refresh: () => void;
}

/** One plain-language answer to "what is going on, and is it my move?" */
function situation(detail: TaskDetail, now: number): string {
  const { task } = detail;
  const who = task.assignee?.name;
  const since = duration(now - task.statusSince);
  switch (task.status) {
    case 'draft':
      return task.waitingOn.length
        ? `Waiting for ${task.waitingOn.join(', ')} to finish before it can be routed.`
        : 'Not submitted yet.';
    case 'routing': {
      const { sentAt, requestedAt } = task.pendingRequest!;
      if (sentAt === null) {
        return `Waiting in our queue to be sent to the engine (${duration(now - requestedAt)}). Nothing is lost. You can still step in.`;
      }
      const waited = duration(now - sentAt);
      return task.overdueSince !== null
        ? `No answer after ${waited}. The engine normally answers within 20s. It may be slow or it may never answer; there is no way to tell. You can keep waiting, route again, or assign someone yourself.`
        : `Waiting for the engine (${waited}). Answers normally take 5–20s. You can step in at any time.`;
    }
    case 'needs_attention':
      switch (task.attentionReason!) {
        case 'no_match':
          return 'The engine found no eligible contributor. Assign someone yourself, or route again if circumstances changed.';
        case 'declined':
          return 'The contributor declined. Nothing further happens until you decide.';
        case 'failed':
          return 'The assignment failed. Nothing further happens until you decide.';
        case 'routing_stopped':
          return 'Routing was stopped. Nothing further happens until you decide.';
        case 'withdrawn':
          return 'The assignment was withdrawn. Nothing further happens until you decide.';
        case 'contributor_unavailable':
          return 'The person selected or offered this task is not available. Route again, or assign someone yourself.';
        case 'over_capacity':
          return 'Each person routing chose had filled up before the offer could be made. Assign someone, or route again later.';
        case 'routing_error':
          return 'The system gave up on this routing attempt; the history shows why. Route again, or assign someone yourself.';
      }
    case 'offered':
      return `Offered to ${who} ${since} ago. Waiting for them to accept or decline.`;
    case 'accepted':
      return `${who} accepted, so routing is complete. Work has not started.`;
    case 'in_progress':
      return `${who} has been working on this for ${since}.`;
    case 'in_review':
      return `${who} submitted work ${since} ago. Review it: approve with a rating, or ask for changes.`;
    case 'completed':
      return `Completed by ${who}.`;
    case 'cancelled':
      return 'Cancelled. No further actions.';
  }
}

function attemptText(a: RoutingAttempt, now: number): string {
  const answer = a.returnedContributorName ? `selected ${a.returnedContributorName}` : 'found no match';
  if (a.state === 'pending') return `Pending for ${duration(now - a.requestedAt)}`;
  if (a.state === 'matched' || a.state === 'no_match') return `Answered in ${duration(a.returnedAt! - a.requestedAt)}: ${answer}`;
  const late = a.returnedAt
    ? `Answered after ${duration(a.returnedAt - a.requestedAt)} (${answer}); ignored.`
    : 'No answer received.';
  return `Closed: ${a.closedReason}. ${late}`;
}

/** Points to the assistant's write-up when there is an open one. */
function CaseLink({ taskId }: { taskId: string }) {
  const found = useResource<CaseList>(`/api/cases?taskId=${taskId}`)?.cases.find((c) => c.status === 'open');
  if (!found) return null;
  return (
    <p className="callout">
      The assistant looked into this: <a href={`#assistant/${found.id}`}>{found.headline}. See findings and options</a>
    </p>
  );
}

/** Requirements, deadline, progress and what the task depends on. */
function Meta({ detail }: { detail: TaskDetail }) {
  const { task, dependencies } = detail;
  const need = task.requirements;
  return (
    <>
      <dl className="facts">
        <dt>Needs</dt>
        <dd>
          {task.expertise} level {need.minLevel}+, about {need.estimateHours}h
          {need.skills.length ? ` · ${need.skills.join(', ')}` : ''}
          {need.certification ? ` · ${need.certification}` : ''}
        </dd>
        {task.dueAt !== null && (
          <>
            <dt>Due</dt>
            <dd>{new Date(task.dueAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd>
          </>
        )}
        {task.projectId && (
          <>
            <dt>Project</dt>
            <dd>
              <a href={`#projects/${task.projectId}`}>Open project report</a>
            </dd>
          </>
        )}
        {dependencies.length > 0 && (
          <>
            <dt>After</dt>
            <dd>
              {dependencies.map((d) => (
                <a key={d.id} className="dependency" href={`#${d.id}`}>
                  {d.id} {d.title} ({STATUS_LABEL[d.status].toLowerCase()})
                </a>
              ))}
            </dd>
          </>
        )}
      </dl>
      {(task.status === 'in_progress' || task.progress > 0) && <Progress value={task.progress} />}
    </>
  );
}

/** What the holder has reported and handed in. */
function Work({ detail }: { detail: TaskDetail }) {
  const { submissions, updates } = detail;
  return (
    <>
      {submissions.length > 0 && (
        <section>
          <h3>Submissions</h3>
          <ul className="records">
            {[...submissions].reverse().map((s) => (
              <li key={s.id} className="submission">
                <strong>{s.contributorName}</strong> · {clockTime(s.at)}
                <p>{s.summary}</p>
                {s.link && (
                  <a href={s.link} target="_blank" rel="noreferrer noopener">
                    {s.link}
                  </a>
                )}
                <small>
                  {s.decision === null
                    ? 'Waiting for review'
                    : s.decision === 'approved'
                      ? `Approved ${s.rating}/5${s.reviewedBy ? ` by ${s.reviewedBy}` : ''}`
                      : `Changes requested${s.reviewedBy ? ` by ${s.reviewedBy}` : ''}`}
                  {s.feedback ? `: ${s.feedback}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {updates.length > 0 && (
        <section>
          <h3>Work log</h3>
          <ul className="records">
            {[...updates].reverse().map((u) => (
              <li key={u.id} className={u.kind === 'blocker' ? 'blocker' : ''}>
                <small>
                  {u.contributorName} · {clockTime(u.at)}
                  {u.percent !== null ? ` · ${u.percent}%` : ''}
                  {u.hours !== null ? ` · ${u.hours}h spent` : ''}
                  {u.kind === 'blocker' ? ' · blocker' : ''}
                </small>
                {u.note}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Loaded only when opened: it ranks everyone against this task. */
function Candidates({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const all = useResource<Candidate[]>(open ? `/api/tasks/${taskId}/candidates` : null);
  const eligible = all?.filter((c) => !c.blockers.length) ?? [];
  return (
    <section>
      <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide who fits' : 'Who fits this task?'}
      </button>
      {open && !all && <p className="muted">Loading…</p>}
      {all && (
        <>
          <p className="muted">
            {eligible.length} of {all.length} people meet every requirement. Scores advise; they do not decide.
          </p>
          {(eligible.length ? eligible : all).slice(0, 5).map((c) => (
            <Fit key={c.contributorId} candidate={c} />
          ))}
        </>
      )}
    </section>
  );
}

export function TaskPanel({ detail, now, online, refresh }: Props) {
  const { task, events, attempts, assignments } = detail;
  const [open, setOpen] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyFor = useIdempotencyKey();
  const warn = task.queue === 'attention';

  const run = async (action: Action, input: ActionInput, seen: TaskSummary) => {
    const { contributorId, reason, scenario, rating, percent, hours, link } = input;
    try {
      const [kind, body] = isContributorAction(action)
        ? ['responses', { action, reason, percent, hours, link, assignmentId: seen.assignee?.assignmentId }]
        : ['commands', { action, reason, scenario, contributorId, rating, expectedVersion: seen.version }];
      const path = `/api/tasks/${task.id}/${kind}`;
      await post(path, body, keyFor([path, body]));
    } finally {
      refresh();
    }
  };

  const choose = async (action: Action) => {
    setError('');
    if (ACTIONS[action].explain) return setOpen(action);
    setBusy(true);
    try {
      await run(action, {}, task);
    } catch (e) {
      setError((e as ApiError).message);
    }
    setBusy(false);
  };

  const decide = async (id: string, body: unknown) => {
    await post(`/api/requests/${id}/decide`, body, keyFor([id, body]));
    refresh();
  };

  const buttons = (actions: Action[]) =>
    actions.map((a) => (
      <button key={a} className={ACTIONS[a].danger ? 'danger' : ''} disabled={!online || busy} onClick={() => void choose(a)}>
        {ACTIONS[a].label}
        {ACTIONS[a].explain ? '…' : ''}
      </button>
    ));

  const operator = OPERATOR_ACTIONS[task.status].filter(
    (a) => (a !== 'unblock' || task.blocker) && (a !== 'submit' || !task.waitingOn.length),
  );
  const contributor = CONTRIBUTOR_ACTIONS[task.status];

  return (
    <div className="card detail">
      <div className="detail-head">
        <small>
          {task.id} · {task.branch} · {task.expertise} · <span className={`priority ${task.priority}`}>{task.priority}</span> · created{' '}
          {duration(now - task.createdAt)} ago
        </small>
        <h2>{task.title}</h2>
        {task.description && <p>{task.description}</p>}
        <StatusBadge task={task} />
        <p className={`situation ${warn ? 'warn' : ''}`}>
          {task.assigneeUnavailable &&
            `${task.assignee?.name} is marked unavailable but still holds this task. Reassign or withdraw it if it cannot wait. `}
          {task.blocker && `Blocked: “${task.blocker}” `}
          {task.pastDueSince !== null && task.status !== 'completed' && 'The due date has passed. '}
          {task.quietSince !== null && 'No report within the check-in interval. '}
          {situation(detail, now)}
        </p>
        <CaseLink taskId={task.id} />
        <Meta detail={detail} />
      </div>

      {operator.length > 0 && (
        <section>
          <h3>Your actions</h3>
          <div className="actions">{buttons(operator)}</div>
        </section>
      )}
      {contributor.length > 0 && (
        <section className="simulation">
          <h3>Simulate {task.assignee?.name}’s response</h3>
          <div className="actions">{buttons(contributor)}</div>
        </section>
      )}
      {error && <p className="error">{error}</p>}

      <Requests requests={detail.requests} canDecide={online} post={decide} />
      <Work detail={detail} />
      {!['completed', 'cancelled'].includes(task.status) && <Candidates taskId={task.id} />}

      <section>
        <h3>History</h3>
        <ol className="timeline">
          {[...events].reverse().map((e) => (
            <li key={e.id} className={e.type === 'late_response' ? 'late' : ''}>
              <time title={new Date(e.at).toLocaleString()}>{clockTime(e.at)}</time>
              <div>
                <span className={`actor ${e.actor}`}>{e.actorName ?? e.actor}</span> {e.summary}
                {e.note && <q>{e.note}</q>}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {attempts.length > 0 && (
        <section>
          <h3>Routing attempts</h3>
          <ul className="records">
            {attempts.map((a) => (
              <li key={a.id}>
                <strong>#{a.attempt}</strong> {attemptText(a, now)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {assignments.length > 0 && (
        <section>
          <h3>Assignments</h3>
          <ul className="records">
            {assignments.map((a) => (
              <li key={a.id}>
                <strong>{a.contributorName}</strong> {a.status.replace('_', ' ')} · via{' '}
                {a.source === 'routing' ? 'routing' : 'operator'}
                {a.endReason ? ` · ${a.endReason}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {open && (
        <ActionDialog
          action={open}
          detail={detail}
          online={online}
          run={(input, seen) => run(open, input, seen)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
