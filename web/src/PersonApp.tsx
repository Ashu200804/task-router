import { useEffect, useState, type FormEvent } from 'react';
import {
  CONTRIBUTOR_ACTIONS,
  EXPERTISE,
  PRIORITIES,
  type Action,
  type ContributorAction,
  type Expertise,
  type MeView,
  type MyTask,
  type Priority,
  type RequestType,
  type Scenario,
  type TaskSummary,
  type WorkRequest,
} from '../../shared/types.ts';
import { ApiError, post, session, useIdempotencyKey, useResource } from './api.ts';
import { ActionDialog, type ActionInput } from './ActionDialog.tsx';
import { ACTIONS, isContributorAction } from './actions.ts';
import { Dialog } from './Dialog.tsx';
import { Progress } from './Fit.tsx';
import { RequestCard, Requests } from './Requests.tsx';
import { ScenarioField } from './ScenarioField.tsx';
import { StatusBadge } from './TaskTable.tsx';
import { clockTime, date, endOfWorkingDay } from './format.ts';

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

/** What a signed-in person sees: only their own work, requests and decisions. */
export function PersonApp({ name }: { name: string }) {
  const selected = useHash() || null;
  const [generation, setGeneration] = useState(0);
  const [raising, setRaising] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const me = useResource<MeView>('/api/me', generation);
  const task = useResource<MyTask>(selected ? `/api/me/tasks/${selected}` : null, generation);
  const refresh = () => setGeneration((g) => g + 1);
  const keyFor = useIdempotencyKey();
  const decide = async (id: string, body: unknown) => {
    await post(`/api/me/requests/${id}/decide`, body, keyFor([id, body]));
    refresh();
  };

  const list = (tasks: TaskSummary[], empty: string) =>
    tasks.length === 0 ? (
      <p className="muted">{empty}</p>
    ) : (
      <ul className="cards">
        {tasks.map((t) => (
          <li key={t.id} className={`card row-item ${t.id === selected ? 'selected' : ''}`}>
            <a href={`#${t.id}`}>{t.title}</a> <StatusBadge task={t} />
            <small>
              {t.id} · <span className={`priority ${t.priority}`}>{t.priority}</span>
              {t.assignee ? ` · with ${t.assignee.name}` : ''}
              {t.dueAt ? ` · due ${date(t.dueAt)}` : ''}
            </small>
          </li>
        ))}
      </ul>
    );

  return (
    <>
      <header className="topbar">
        <div>
          <h1>My work</h1>
          <p>
            Signed in as {name}
            {me ? ` · ${me.person.profile.title} · ${me.person.branch}` : ''} · development sign-in, no password
          </p>
        </div>
        <div className="controls">
          <button className="primary" onClick={() => setRaising(true)}>
            Raise a task
          </button>
          <button onClick={() => session.signOut()}>Sign out</button>
        </div>
      </header>
      {!me ? (
        <p className="loading">Loading…</p>
      ) : (
        <main className="layout person">
          <section>
            {notes.length > 0 && (
              <div className="callout" role="status">
                {notes.map((n) => (
                  <p key={n}>{n}</p>
                ))}
              </div>
            )}
            {me.inbox.length > 0 && (
              <>
                <h3>Waiting for your decision ({me.inbox.length})</h3>
                {me.inbox.map((r) => (
                  <RequestCard key={r.id} request={r} me={me.person.id} canDecide post={decide} showTask />
                ))}
              </>
            )}
            <h3>Assigned to you</h3>
            {list(me.work, 'Nothing assigned to you.')}
            <h3>Raised by you</h3>
            {list(me.raised, 'You have not raised any tasks.')}
            {me.sent.length > 0 && (
              <>
                <h3>Your requests</h3>
                {me.sent.slice(0, 8).map((r) => (
                  <RequestCard key={r.id} request={r} me={me.person.id} canDecide={false} post={decide} showTask />
                ))}
              </>
            )}
          </section>
          <aside className="panel">
            {task && task.detail.task.id === selected ? (
              <PersonTask key={task.detail.task.id} item={task} me={me.person.id} refresh={refresh} decide={decide} />
            ) : (
              <p className="empty">Select a task.</p>
            )}
          </aside>
        </main>
      )}
      {raising && (
        <RaiseDialog
          onClose={() => setRaising(false)}
          onRaised={(id, said) => {
            setRaising(false);
            setNotes(said);
            window.location.hash = id;
            refresh();
          }}
        />
      )}
    </>
  );
}

function PersonTask({ item, me, refresh, decide }: { item: MyTask; me: string; refresh: () => void; decide: (id: string, body: unknown) => Promise<void> }) {
  const { detail, requests, roles } = item;
  const { task, updates, submissions, events } = detail;
  const [open, setOpen] = useState<Action | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const keyFor = useIdempotencyKey();
  const live = task.status !== 'completed' && task.status !== 'cancelled';

  const run = async (action: Action, input: ActionInput, seen: TaskSummary) => {
    const { reason, percent, hours, link, rating } = input;
    const [kind, body] = isContributorAction(action)
      ? ['respond', { action: action as ContributorAction, reason, percent, hours, link, assignmentId: seen.assignee?.assignmentId }]
      : ['review', { decision: action === 'approve' ? 'approve' : 'changes', rating, feedback: reason, expectedVersion: seen.version }];
    const path = `/api/me/tasks/${task.id}/${kind}`;
    try {
      await post(path, body, keyFor([path, body]));
    } finally {
      refresh();
    }
  };
  const choose = async (action: Action) => {
    setError('');
    if (ACTIONS[action].explain) return setOpen(action);
    try {
      await run(action, {}, task);
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  const buttons = (actions: Action[]) =>
    actions.map((a) => (
      <button key={a} onClick={() => void choose(a)}>
        {ACTIONS[a].label}
        {ACTIONS[a].explain ? '…' : ''}
      </button>
    ));
  const mine = roles.holder ? CONTRIBUTOR_ACTIONS[task.status] : [];
  const reviewing = roles.requester && task.status === 'in_review';

  return (
    <div className="card detail">
      <div className="detail-head">
        <small>
          {task.id} · {task.expertise} · {task.priority}
          {task.requester ? ` · raised by ${task.requester.name}` : ''}
        </small>
        <h2>{task.title}</h2>
        {task.description && <p>{task.description}</p>}
        <StatusBadge task={task} />
        <p className="muted">
          {task.assignee ? `With ${task.assignee.name}.` : 'Nobody holds it yet.'}
          {task.blocker ? ` Blocked: “${task.blocker}”.` : ''}
          {task.dueAt ? ` Due ${date(task.dueAt)}.` : ''}
        </p>
        {task.progress > 0 && <Progress value={task.progress} />}
      </div>
      {mine.length > 0 && (
        <section>
          <h3>Your work</h3>
          <div className="actions">{buttons(mine)}</div>
        </section>
      )}
      {reviewing && (
        <section>
          <h3>Review the work you asked for</h3>
          <div className="actions">{buttons(['approve', 'request_changes'])}</div>
        </section>
      )}
      {live && (roles.holder || roles.requester) && (
        <section>
          <button className="primary" onClick={() => setAsking(true)}>
            Make a request…
          </button>
        </section>
      )}
      {error && <p className="error">{error}</p>}
      <Requests requests={requests} me={me} canDecide post={decide} />
      {(submissions.length > 0 || updates.length > 0) && (
        <section>
          <h3>Work so far</h3>
          <ul className="records">
            {submissions.map((s) => (
              <li key={`s${s.id}`} className="submission">
                Submitted by {s.contributorName}: {s.summary}
              </li>
            ))}
            {updates.map((u) => (
              <li key={`u${u.id}`}>
                {u.contributorName}: {u.note}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3>History</h3>
        <ol className="timeline">
          {[...events].reverse().slice(0, 15).map((e) => (
            <li key={e.id}>
              <time>{clockTime(e.at)}</time>
              <div>{e.summary}</div>
            </li>
          ))}
        </ol>
      </section>
      {open && <ActionDialog action={open} detail={detail} online run={(input, seen) => run(open, input, seen)} onClose={() => setOpen(null)} />}
      {asking && <AskDialog item={item} onClose={() => setAsking(false)} refresh={refresh} />}
    </div>
  );
}

const ASKS: Record<RequestType, [label: string, explain: string, who: 'either' | 'holder' | 'requester']> = {
  status: ['Where is this?', 'Answered immediately from the task data.', 'either'],
  question: ['Ask a question', 'Goes to the person who can answer it.', 'either'],
  help: ['Ask for help', 'Creates a small helper task and routes it to the most suitable colleague.', 'holder'],
  extension: ['Ask for more time', 'One day may be granted automatically; more needs a decision.', 'holder'],
  handover: ['Hand it over', 'Needs a lead’s approval. The system suggests who should take it.', 'holder'],
  cancel: ['Cancel it', 'Immediate if nobody accepted it; otherwise a lead decides.', 'requester'],
};

function AskDialog({ item, onClose, refresh }: { item: MyTask; onClose: () => void; refresh: () => void }) {
  const { roles, detail } = item;
  const working = roles.holder && detail.task.status !== 'offered';
  const types = (Object.keys(ASKS) as RequestType[]).filter((t) => {
    const who = ASKS[t][2];
    return who === 'either' || (who === 'holder' ? working : roles.requester);
  });
  const [type, setType] = useState<RequestType>(types[0]!);
  const [text, setText] = useState('');
  const [days, setDays] = useState('1');
  const [scenario, setScenario] = useState<Scenario>('random');
  const [result, setResult] = useState<WorkRequest | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyFor = useIdempotencyKey();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = { type, text, days: type === 'extension' ? Number(days) : undefined, scenario: type === 'help' ? scenario : undefined };
    try {
      setResult(await post<WorkRequest>(`/api/me/tasks/${detail.task.id}/requests`, body, keyFor(body)));
      refresh();
    } catch (err) {
      setError((err as ApiError).message);
    }
    setBusy(false);
  };

  return (
    <Dialog title={result ? 'What the system did' : `Request · ${detail.task.id}`} onClose={onClose}>
      {result ? (
        <form onSubmit={(e) => e.preventDefault()}>
          <p>
            <span className="badge">{result.status === 'open' ? `With ${result.handler?.name ?? 'operator'}` : result.status}</span>
          </p>
          <p>{result.routing}</p>
          {result.response && <p className="callout">{result.response}</p>}
          <footer>
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </footer>
        </form>
      ) : (
        <form onSubmit={submit}>
          <label>
            <span>What do you need?</span>
            <select value={type} onChange={(e) => setType(e.target.value as RequestType)}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {ASKS[t][0]}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">{ASKS[type][1]}</p>
          {type === 'extension' && (
            <label>
              <span>Extra days</span>
              <input type="number" min={1} max={30} value={days} onChange={(e) => setDays(e.target.value)} required />
            </label>
          )}
          <label>
            <span>Details</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={500} required />
          </label>
          {type === 'help' && <ScenarioField value={scenario} onChange={setScenario} />}
          {error && <p className="error">{error}</p>}
          <footer>
            <button type="button" onClick={onClose}>
              Close
            </button>
            <button className="primary" disabled={busy}>
              Send
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}

function RaiseDialog({ onClose, onRaised }: { onClose: () => void; onRaised: (id: string, notes: string[]) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [expertise, setExpertise] = useState<Expertise | ''>('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [hours, setHours] = useState('4');
  const [due, setDue] = useState('');
  const [scenario, setScenario] = useState<Scenario>('random');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyFor = useIdempotencyKey();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      title,
      description,
      expertise: expertise || undefined,
      priority,
      estimateHours: Number(hours),
      dueAt: due ? endOfWorkingDay(due) : undefined,
      scenario,
    };
    try {
      const { task, notes } = await post<{ task: TaskSummary; notes: string[] }>('/api/me/tasks', body, keyFor(body));
      onRaised(task.id, notes);
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title="Raise a task" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          <span>What do you need done?</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required autoFocus />
        </label>
        <label>
          <span>Details</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />
        </label>
        <div className="row">
          <label>
            <span>Kind of work</span>
            <select value={expertise} onChange={(e) => setExpertise(e.target.value as Expertise | '')}>
              <option value="">Let the system work it out</option>
              {EXPERTISE.map((x) => (
                <option key={x}>{x}</option>
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
          <label>
            <span>Estimated hours</span>
            <input type="number" min={0.5} max={400} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} required />
          </label>
          <label>
            <span>Needed by (optional)</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <ScenarioField value={scenario} onChange={setScenario} />
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button className="primary" disabled={busy}>
            Raise and route
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
