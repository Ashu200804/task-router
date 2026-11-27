import { useState, type FormEvent } from 'react';
import {
  BRANCHES,
  EXPERTISE,
  PRIORITIES,
  type Branch,
  type Expertise,
  type Priority,
  type Scenario,
  type TaskSummary,
} from '../../shared/types.ts';
import { ApiError, post, useIdempotencyKey } from './api.ts';
import { Dialog } from './Dialog.tsx';
import { ScenarioField } from './ScenarioField.tsx';
import { endOfWorkingDay } from './format.ts';

interface Props {
  defaultBranch: Branch;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function NewTaskDialog({ defaultBranch, onClose, onCreated }: Props) {
  const [branch, setBranch] = useState<Branch>(defaultBranch);
  const keyFor = useIdempotencyKey();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [expertise, setExpertise] = useState<Expertise>('finance');
  const [priority, setPriority] = useState<Priority>('normal');
  const [scenario, setScenario] = useState<Scenario>('random');
  const [error, setError] = useState('');
  const [minLevel, setMinLevel] = useState('1');
  const [estimateHours, setHours] = useState('4');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (submit: boolean) => {
    setBusy(true);
    setError('');
    try {
      const body = {
        title, description, expertise, branch, priority, submit, scenario,
        minLevel: Number(minLevel),
        estimateHours: Number(estimateHours),
        dueAt: due ? endOfWorkingDay(due) : undefined,
      };
      const task = await post<TaskSummary>('/api/tasks', body, keyFor(body));
      onCreated(task.id);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title="New task" onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void create(true);
        }}
      >
        <label>
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required autoFocus />
        </label>
        <label>
          <span>Description (optional)</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} />
        </label>
        <div className="row">
          <label>
            <span>Branch</span>
            <select value={branch} onChange={(e) => setBranch(e.target.value as Branch)}>
              {BRANCHES.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Expertise needed</span>
            <select value={expertise} onChange={(e) => setExpertise(e.target.value as Expertise)}>
              {EXPERTISE.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="row three">
          <label>
            <span>Minimum level (1–5)</span>
            <input type="number" min={1} max={5} required value={minLevel} onChange={(e) => setMinLevel(e.target.value)} />
          </label>
          <label>
            <span>Estimated hours</span>
            <input type="number" min={0.5} max={400} step={0.5} required value={estimateHours} onChange={(e) => setHours(e.target.value)} />
          </label>
          <label>
            <span>Due (optional)</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <ScenarioField value={scenario} onChange={setScenario} />
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button type="button" disabled={busy || !title.trim()} onClick={() => void create(false)}>
            Save draft
          </button>
          <button className="primary" disabled={busy || !title.trim()}>
            Create and route
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
