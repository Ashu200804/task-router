import { useState, type FormEvent } from 'react';
import { OPERATOR_ACTIONS, type Action, type Candidate, type Scenario, type TaskDetail, type TaskSummary } from '../../shared/types.ts';
import { ApiError, useResource } from './api.ts';
import { ACTIONS, isContributorAction } from './actions.ts';
import { Dialog } from './Dialog.tsx';
import { Fit } from './Fit.tsx';
import { ScenarioField } from './ScenarioField.tsx';
import { STATUS_LABEL } from './format.ts';

export interface ActionInput {
  contributorId?: string;
  reason?: string;
  scenario?: Scenario;
  rating?: number;
  percent?: number;
  hours?: number;
  link?: string;
}

/** What the text box means for each action, and whether it can be left empty. */
const TEXT: Partial<Record<Action, [label: string, required: boolean]>> = {
  update: ['What has been done', true],
  block: ['What is blocking the work', true],
  submit_work: ['Summary of what you are submitting', true],
  request_changes: ['What needs to change', true],
  approve: ['Feedback (optional)', false],
  unblock: ['How it was resolved (optional)', false],
};

interface Props {
  action: Action;
  detail: TaskDetail;
  online: boolean;
  /** `seen` is the task as the operator last reviewed it; the server rejects the call if it moved on. */
  run: (input: ActionInput, seen: TaskSummary) => Promise<void>;
  onClose: () => void;
}

export function ActionDialog({ action, detail, online, run, onClose }: Props) {
  const [seen, setSeen] = useState(detail.task);
  const [contributorId, setContributorId] = useState('');
  const [reason, setReason] = useState('');
  const [scenario, setScenario] = useState<Scenario>('random');
  const [rating, setRating] = useState('');
  const [percent, setPercent] = useState('');
  const [hours, setHours] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const task = detail.task;
  const copy = ACTIONS[action];
  const changed = task.version !== seen.version;
  const stillPossible = isContributorAction(action)
    ? task.assignee?.assignmentId === seen.assignee?.assignmentId
    : OPERATOR_ACTIONS[task.status].includes(action);
  const routes = action === 'submit' || action === 'reroute';

  const candidates = useResource<Candidate[]>(action === 'assign' ? `/api/tasks/${task.id}/candidates` : null);
  const choices = (candidates ?? []).filter((c) => c.contributorId !== task.assignee?.contributorId);
  const chosen = choices.find((c) => c.contributorId === contributorId);
  // "Previously declined" is a warning; the rest are requirements being overruled.
  const overrides = chosen?.blockers.filter((b) => !b.startsWith('previously')) ?? [];

  const [label, required] = TEXT[action] ?? ['Reason (optional, kept in history)', false];
  const number = (value: string) => (value === '' ? undefined : Number(value));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await run(
        {
          reason: reason.trim() || undefined,
          contributorId: action === 'assign' ? contributorId : undefined,
          scenario: routes ? scenario : undefined,
          rating: number(rating),
          percent: number(percent),
          hours: number(hours),
          link: link.trim() || undefined,
        },
        seen,
      );
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  };

  const option = (c: Candidate) => (
    <option key={c.contributorId} value={c.contributorId} disabled={c.blockers.includes('unavailable')}>
      {c.name} · score {c.score}
      {c.blockers.length ? ` · ${c.blockers.join('; ')}` : ''}
    </option>
  );

  return (
    <Dialog title={`${copy.label} · ${task.id}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p>{copy.explain?.(task.status)}</p>

        {changed && !busy && (
          <div className="changed" role="alert">
            <strong>This task changed while this window was open.</strong>
            <p>
              Now: {STATUS_LABEL[task.status]}
              {task.assignee ? ` (${task.assignee.name})` : ''}. {detail.events.at(-1)?.summary}
            </p>
            {stillPossible ? (
              <button type="button" onClick={() => { setSeen(task); setError(''); }}>
                I have reviewed this, continue
              </button>
            ) : (
              <p>This action no longer applies. Close this window.</p>
            )}
          </div>
        )}

        {action === 'assign' && (
          <>
            <label>
              <span>Contributor, best fit first</span>
              <select value={contributorId} onChange={(e) => setContributorId(e.target.value)} required>
                <option value="">{candidates ? 'Choose…' : 'Loading…'}</option>
                <optgroup label="Meets every requirement">{choices.filter((c) => !c.blockers.length).map(option)}</optgroup>
                <optgroup label="Does not (needs a reason)">{choices.filter((c) => c.blockers.length).map(option)}</optgroup>
              </select>
            </label>
            {chosen && <Fit candidate={chosen} />}
          </>
        )}

        {routes && detail.excluded.length > 0 && (
          <p className="muted">
            Routing will skip {detail.excluded.map((e) => `${e.name} (${e.reason})`).join(', ')}.
            {action === 'reroute' && task.status === 'offered' && task.assignee ? ` It will also skip ${task.assignee.name}.` : ''}
          </p>
        )}

        {action === 'approve' && (
          <label>
            <span>Rating</span>
            <select value={rating} onChange={(e) => setRating(e.target.value)} required>
              <option value="">Choose…</option>
              <option value="5">5 · excellent</option>
              <option value="4">4 · good</option>
              <option value="3">3 · acceptable</option>
              <option value="2">2 · weak</option>
              <option value="1">1 · poor</option>
            </select>
          </label>
        )}

        {action === 'update' && (
          <div className="row">
            <label>
              <span>Percent complete (optional)</span>
              <input type="number" min={0} max={100} step={1} value={percent} onChange={(e) => setPercent(e.target.value)} />
            </label>
            <label>
              <span>Hours spent (optional)</span>
              <input type="number" min={0} max={1000} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} />
            </label>
          </div>
        )}

        <label>
          <span>{overrides.length ? `Reason (required: ${overrides.join('; ')})` : label}</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            required={required || overrides.length > 0}
          />
        </label>

        {action === 'submit_work' && (
          <label>
            <span>Link to the work (optional)</span>
            <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" maxLength={500} />
          </label>
        )}

        {routes && <ScenarioField value={scenario} onChange={setScenario} />}
        {error && <p className="error">{error}</p>}

        <footer>
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button className={copy.danger ? 'danger' : 'primary'} disabled={busy || changed || !online}>
            {copy.label}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
