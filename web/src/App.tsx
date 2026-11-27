import { useEffect, useState } from 'react';
import { BRANCHES, type CaseList, type Branch, type Health, type Queue } from '../../shared/types.ts';
import { operatorName, session, useResource, useSnapshot } from './api.ts';
import { Assistant } from './Assistant.tsx';
import { People } from './People.tsx';
import { Projects } from './Projects.tsx';
import { NewTaskDialog } from './NewTaskDialog.tsx';
import { TaskPanel } from './TaskPanel.tsx';
import { TaskTable } from './TaskTable.tsx';
import { duration } from './format.ts';

const FILTERS: { key: Queue | 'all'; label: string }[] = [
  { key: 'all', label: 'All tasks' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'routing', label: 'Routing' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'draft', label: 'Drafts' },
  { key: 'closed', label: 'Closed' },
];

type Tab = 'tasks' | 'projects' | 'people' | 'assistant';

/** The screen and selection live in the URL, so a refresh or a shared link returns to them. */
function useRoute() {
  const read = (): { tab: Tab; id: string | null } => {
    const [first = '', second] = window.location.hash.slice(1).split('/');
    if (first === 'projects' || first === 'people' || first === 'assistant') return { tab: first, id: second || null };
    return { tab: 'tasks', id: first && first !== 'tasks' ? first : null };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/** Server time, advanced locally, so ages tick and do not depend on the browser's clock. */
function useServerNow(serverTime = 0, receivedAt = 0) {
  const [local, setLocal] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setLocal(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return serverTime + Math.max(0, local - receivedAt);
}

function useDebounced(value: string, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function QueueHealth({ health }: { health: Health }) {
  const lagging = health.oldestJobAgeMs > 5000;
  if (!health.deadJobs && !lagging) return null;
  return (
    <div className="backlog" role="status">
      {lagging &&
        `Routing is backed up: ${health.queuedJobs} waiting, oldest ${duration(health.oldestJobAgeMs)}. Nothing is lost. `}
      {health.deadJobs > 0 &&
        `${health.deadJobs} routing job(s) failed permanently. The affected tasks are in Needs attention.`}
    </div>
  );
}

export function App() {
  const { tab, id } = useRoute();
  const selectedId = tab === 'tasks' ? id : null;
  const select = (next: string) => void (window.location.hash = next);
  const [branch, setBranch] = useState<Branch | ''>('');
  const [filter, setFilter] = useState<Queue | 'all'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [operator, setOperator] = useState(operatorName.read);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim(), 300);
  const query = new URLSearchParams({
    ...(branch && { branch }),
    ...(filter !== 'all' && { queue: filter }),
    ...(q && { q }),
    page: String(page),
  }).toString();
  const { snapshot, online, refresh } = useSnapshot(query, selectedId);
  const cases = useResource<CaseList>('/api/cases?status=open');
  const now = useServerNow(snapshot?.serverTime, snapshot?.receivedAt);

  // Tasks move between queues while someone is reading; never strand them on an empty page.
  const pages = snapshot ? Math.max(1, Math.ceil(snapshot.list.total / snapshot.list.pageSize)) : 1;
  useEffect(() => {
    if (snapshot?.query === query && page > pages) setPage(pages);
  }, [snapshot, query, page, pages]);

  if (!snapshot) {
    return <p className="loading">{online ? 'Loading…' : 'Cannot reach the server. Retrying…'}</p>;
  }
  const { list, contributors, health } = snapshot;
  const all = Object.values(list.counts).reduce((a, b) => a + b, 0);
  const detail = snapshot.detail?.task.id === selectedId ? snapshot.detail : null;
  const refilter = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Task Router</h1>
          <p>Operator console</p>
        </div>
        <nav className="tabs" aria-label="Screens">
          {(['tasks', 'projects', 'people', 'assistant'] as const).map((t) => (
            <a key={t} href={`#${t}`} aria-current={tab === t ? 'page' : undefined}>
              {t[0]!.toUpperCase() + t.slice(1)}
              {t === 'assistant' && cases && cases.open > 0 && <span className="count">{cases.open}</span>}
            </a>
          ))}
        </nav>
        <div className="controls">
          <select aria-label="Sign in as a person (development sign-in)" value="" onChange={(e) => void session.signIn(e.target.value)}>
            <option value="">Operator console</option>
            {contributors.map((c) => (
              <option key={c.id} value={c.id}>
                Sign in as {c.name} · {c.profile.title}
              </option>
            ))}
          </select>
          <input
            aria-label="Your name, recorded in task history"
            placeholder="Your name"
            value={operator}
            maxLength={60}
            onChange={(e) => {
              setOperator(e.target.value);
              operatorName.write(e.target.value);
            }}
          />
          <select aria-label="Branch" value={branch} onChange={(e) => refilter(setBranch)(e.target.value as Branch | '')}>
            <option value="">All branches</option>
            {BRANCHES.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
          {tab === 'tasks' && (
            <button className="primary" onClick={() => setCreating(true)} disabled={!online}>
              New task
            </button>
          )}
        </div>
      </header>

      {!online && (
        <div className="offline" role="alert">
          Lost contact with the server. What you see may be out of date, and actions are paused. Retrying…
        </div>
      )}
      <QueueHealth health={health} />
      {contributors.length === 0 && (
        <div className="backlog" role="status">
          No contributors yet, so nothing can be assigned. Add them with <code>npm run import -- &lt;file.json&gt;</code> (see
          the README).
        </div>
      )}

      {tab === 'projects' && <Projects selectedId={id} branch={branch} online={online} />}
      {tab === 'people' && (
        <People selectedId={id} branch={branch} contributors={contributors} online={online} refresh={refresh} />
      )}
      {tab === 'assistant' && <Assistant selectedId={id} branch={branch} online={online} now={now} />}
      {tab === 'tasks' && (
      <main className="layout">
        <section className="list">
          <nav className="filters" aria-label="Task filters">
            {FILTERS.map(({ key, label }) => {
              const count = key === 'all' ? all : list.counts[key];
              return (
                <button
                  key={key}
                  className={`${filter === key ? 'active' : ''} ${key === 'attention' && count ? 'alert' : ''}`}
                  aria-pressed={filter === key}
                  onClick={() => refilter(setFilter)(key)}
                >
                  {label} <span>{count}</span>
                </button>
              );
            })}
            <input
              type="search"
              aria-label="Search tasks"
              placeholder="Search title or ID"
              value={search}
              maxLength={100}
              onChange={(e) => refilter(setSearch)(e.target.value)}
            />
          </nav>
          <div className={snapshot.query === query ? '' : 'refreshing'}>
            <TaskTable tasks={list.tasks} now={now} selectedId={selectedId} onSelect={select} />
          </div>
          {pages > 1 && (
            <nav className="pager" aria-label="Pages">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>
                Page {page} of {pages} · {list.total} tasks
              </span>
              <button disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </nav>
          )}
        </section>

        <aside className="panel">
          {detail ? (
            <TaskPanel
              key={detail.task.id}
              detail={detail}
              now={now}
              online={online}
              refresh={refresh}
            />
          ) : (
            <p className="empty">Select a task to see its state, history and available actions.</p>
          )}
        </aside>
      </main>
      )}

      {creating && (
        <NewTaskDialog
          defaultBranch={branch || BRANCHES[0]}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setFilter('all');
            setSearch('');
            setPage(1);
            select(id);
            refresh();
          }}
        />
      )}
    </>
  );
}
