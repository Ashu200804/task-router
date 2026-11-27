import { useState, type FormEvent } from 'react';
import {
  BRANCHES,
  EXPERTISE,
  PRIORITIES,
  type Branch,
  type Expertise,
  type Plan,
  type PlanStep,
  type PlannedStep,
  type Priority,
} from '../../shared/types.ts';
import { ApiError, post, useIdempotencyKey } from './api.ts';
import { Dialog } from './Dialog.tsx';
import { endOfWorkingDay } from './format.ts';

interface Props {
  defaultBranch: Branch;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

/** Brief, then a proposed split the manager edits, then creation. Nothing is saved before that. */
export function PlanDialog({ defaultBranch, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [branch, setBranch] = useState<Branch>(defaultBranch);
  const [priority, setPriority] = useState<Priority>('normal');
  const [due, setDue] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  /** Set after an edit: the shown candidates and warnings no longer match. */
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyFor = useIdempotencyKey();

  const brief = () => ({ name, goal, branch, priority, dueAt: due ? endOfWorkingDay(due) : null });
  const bare = (steps: PlannedStep[]): PlanStep[] => steps.map(({ team: _, candidates: __, ...step }) => step);

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as ApiError).message);
    }
    setBusy(false);
  };

  const check = (steps?: PlanStep[]) =>
    attempt(async () => {
      const body = { ...brief(), steps };
      setPlan(await post<Plan>('/api/plans', body, crypto.randomUUID()));
      setStale(false);
    });

  const create = () =>
    attempt(async () => {
      const body = { ...brief(), steps: bare(plan!.steps) };
      const { id } = await post<{ id: string }>('/api/projects', body, keyFor(body));
      onCreated(id);
    });

  const edit = (steps: PlannedStep[]) => {
    setPlan({ ...plan!, steps });
    setStale(true);
  };
  const change = (key: string, patch: Partial<PlanStep>) =>
    edit(plan!.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const remove = (key: string) =>
    edit(plan!.steps.filter((s) => s.key !== key).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((k) => k !== key) })));
  const add = () => {
    let n = plan!.steps.length + 1;
    while (plan!.steps.some((s) => s.key === `s${n}`)) n++;
    edit([
      ...plan!.steps,
      {
        key: `s${n}`, title: 'New step', description: '', expertise: 'operations', minLevel: 2, certification: null,
        skills: [], estimateHours: 4, dependsOn: [], reason: 'Added by you.', team: '', candidates: [],
      },
    ]);
  };

  return (
    <Dialog title="Plan a project" onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void check();
        }}
      >
        <label>
          <span>Project name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
        </label>
        <label>
          <span>Goal: say what has to happen, in plain words</span>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="e.g. Analyse vendor spend, assess the cost impact, check contracts and plan the rollout."
          />
        </label>
        <div className="row three">
          <label>
            <span>Branch</span>
            <select value={branch} onChange={(e) => { setBranch(e.target.value as Branch); setStale(true); }}>
              {BRANCHES.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Priority</span>
            <select value={priority} onChange={(e) => { setPriority(e.target.value as Priority); setStale(true); }}>
              {PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Deadline (optional)</span>
            <input type="date" value={due} onChange={(e) => { setDue(e.target.value); setStale(true); }} />
          </label>
        </div>
        {!plan && (
          <footer>
            <button type="button" onClick={onClose}>
              Close
            </button>
            <button className="primary" disabled={busy || !name.trim()}>
              Propose a split
            </button>
          </footer>
        )}
        {error && !plan && <p className="error">{error}</p>}
      </form>

      {plan && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <p className="muted">
            Suggested by keyword rules, not by understanding the text. Check every step before creating.
          </p>
          {plan.warnings.map((w) => (
            <p key={w} className="changed">
              {w}
            </p>
          ))}
          <ol className="steps">
            {plan.steps.map((s, i) => {
              const eligible = s.candidates.filter((c) => !c.blockers.length);
              return (
                <li key={s.key} className="card">
                  <label>
                    <span>Step {i + 1}</span>
                    <input value={s.title} required maxLength={120} onChange={(e) => change(s.key, { title: e.target.value })} />
                  </label>
                  <div className="row three">
                    <label>
                      <span>Expertise</span>
                      <select
                        value={s.expertise}
                        onChange={(e) => change(s.key, { expertise: e.target.value as Expertise, skills: [], certification: null })}
                      >
                        {EXPERTISE.map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Min level</span>
                      <input type="number" min={1} max={5} required value={s.minLevel} onChange={(e) => change(s.key, { minLevel: Number(e.target.value) })} />
                    </label>
                    <label>
                      <span>Hours</span>
                      <input type="number" min={0.5} max={400} step={0.5} required value={s.estimateHours} onChange={(e) => change(s.key, { estimateHours: Number(e.target.value) })} />
                    </label>
                  </div>
                  {i > 0 && (
                    <fieldset>
                      <legend>Starts after</legend>
                      {plan.steps.slice(0, i).map((other, j) => (
                        <label key={other.key} className="check">
                          <input
                            type="checkbox"
                            checked={s.dependsOn.includes(other.key)}
                            onChange={(e) =>
                              change(s.key, {
                                dependsOn: e.target.checked
                                  ? [...s.dependsOn, other.key]
                                  : s.dependsOn.filter((k) => k !== other.key),
                              })
                            }
                          />
                          Step {j + 1}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <small>
                    {s.reason}
                    {s.certification ? ` Requires: ${s.certification}.` : ''}
                    {s.skills.length ? ` Skills: ${s.skills.join(', ')}.` : ''}
                  </small>
                  {!stale && (
                    <small className={eligible.length ? '' : 'reasons'}>
                      {s.team}:{' '}
                      {eligible.length
                        ? eligible.map((c) => `${c.name} (${c.score})`).join(', ')
                        : 'nobody eligible. You can still create the project and assign this step with a reason.'}
                    </small>
                  )}
                  <button type="button" className="link" onClick={() => remove(s.key)}>
                    Remove step
                  </button>
                </li>
              );
            })}
          </ol>
          {error && <p className="error">{error}</p>}
          <footer>
            <button type="button" onClick={onClose}>
              Close
            </button>
            <button type="button" onClick={add} disabled={plan.steps.length >= 20}>
              Add step
            </button>
            <button type="button" disabled={busy} onClick={() => void check(bare(plan.steps))}>
              Re-check people
            </button>
            <button className="primary" disabled={busy || !plan.steps.length || !name.trim()}>
              Create project
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}
