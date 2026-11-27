import type { TaskSummary } from '../../shared/types.ts';
import { ATTENTION_LABEL, STATUS_LABEL, duration, warningLabel } from './format.ts';

interface Props {
  tasks: TaskSummary[];
  now: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function StatusBadge({ task }: { task: TaskSummary }) {
  const warning = warningLabel(task);
  return <span className={`badge ${warning ? 'warn' : task.status}`}>{warning ?? STATUS_LABEL[task.status]}</span>;
}

function stateNote(task: TaskSummary, now: number): string {
  const pending = task.pendingRequest;
  if (pending) {
    if (pending.sentAt === null) return `Attempt ${pending.attempt} queued ${duration(now - pending.requestedAt)}, not sent yet`;
    const late = task.overdueSince !== null ? ', past normal window' : '';
    return `Attempt ${pending.attempt} pending ${duration(now - pending.sentAt)}${late}`;
  }
  if (task.waitingOn.length && task.status === 'draft') return `Waiting for ${task.waitingOn.join(', ')}`;
  if (task.status === 'in_progress') return `${task.progress}% reported · for ${duration(now - task.statusSince)}`;
  if (task.attentionReason) return `${ATTENTION_LABEL[task.attentionReason]} · ${duration(now - task.statusSince)} ago`;
  return `${task.assigneeUnavailable ? `${STATUS_LABEL[task.status]} ` : ''}for ${duration(now - task.statusSince)}`;
}

export function TaskTable({ tasks, now, selectedId, onSelect }: Props) {
  if (tasks.length === 0) return <p className="empty card">No tasks in this view.</p>;
  return (
    <div className="card scroll">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Priority</th>
            <th>State</th>
            <th>Contributor</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} className={task.id === selectedId ? 'selected' : ''} onClick={() => onSelect(task.id)}>
              <td>
                <a href={`#${task.id}`}>{task.title}</a>
                <small>
                  {task.id} · {task.branch} · {task.expertise}
                </small>
              </td>
              <td>
                <span className={`priority ${task.priority}`}>{task.priority}</span>
              </td>
              <td>
                <StatusBadge task={task} />
                <small>{stateNote(task, now)}</small>
              </td>
              <td>{task.assignee?.name ?? <span className="muted">—</span>}</td>
              <td className="nowrap">{duration(now - task.createdAt)} ago</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
