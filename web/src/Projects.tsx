import { useState } from 'react';
import type { Branch, ProjectReport, ProjectSummary, Scenario } from '../../shared/types.ts';
import { ApiError, post, useIdempotencyKey, useResource } from './api.ts';
import { Progress } from './Fit.tsx';
import { PlanDialog } from './PlanDialog.tsx';
import { ScenarioField } from './ScenarioField.tsx';
import { StatusBadge } from './TaskTable.tsx';
import { HEALTH_LABEL, clockTime, date } from './format.ts';

const share = (p: ProjectSummary) => (p.totalHours ? Math.round((p.earnedHours / p.totalHours) * 100) : 0);
const Health = ({ project }: { project: ProjectSummary }) => (
  <span className={`badge health-${project.health}`}>{HEALTH_LABEL[project.health]}</span>
);

interface Props {
  selectedId: string | null;
  branch: Branch | '';
  online: boolean;
}

export function Projects({ selectedId, branch, online }: Props) {
  const [generation, setGeneration] = useState(0);
  const [planning, setPlanning] = useState(false);
  const projects = useResource<ProjectSummary[]>('/api/projects', generation);
  const report = useResource<ProjectReport>(selectedId ? `/api/projects/${selectedId}` : null, generation);
  const refresh = () => setGeneration((g) => g + 1);
  const visible = projects?.filter((p) => !branch || p.branch === branch);

  return (
    <main className="layout projects">
      <section>
        <button className="primary wide" disabled={!online} onClick={() => setPlanning(true)}>
          Plan a new project
        </button>
        {visible?.length === 0 && <p className="empty card">No projects here yet.</p>}
        <ul className="cards">
          {visible?.map((p) => (
            <li key={p.id} className={`card ${p.id === selectedId ? 'selected' : ''}`}>
              <a href={`#projects/${p.id}`}>{p.name}</a>
              <small>
                {p.branch} · {p.doneCount}/{p.taskCount} tasks{p.dueAt ? ` · due ${date(p.dueAt)}` : ''}
              </small>
              <Progress value={share(p)} label={`${p.name} progress`} />
              <Health project={p} /> {p.riskCount > 0 && <span className="muted">{p.riskCount} to look at</span>}
            </li>
          ))}
        </ul>
      </section>
      <section>
        {report ? (
          <Report key={report.project.id} report={report} online={online} refresh={refresh} />
        ) : (
          <p className="empty">Select a project to see how it is going.</p>
        )}
      </section>
      {planning && (
        <PlanDialog
          defaultBranch={branch || 'London'}
          onClose={() => setPlanning(false)}
          onCreated={(id) => {
            setPlanning(false);
            refresh();
            window.location.hash = `projects/${id}`;
          }}
        />
      )}
    </main>
  );
}

/** The same facts as the screen, as text to paste into an update. */
function statusText({ project: p, risks, criticalPathHours }: ProjectReport): string {
  return [
    `${p.name} (${p.branch}): ${HEALTH_LABEL[p.health]}`,
    `Progress: ${share(p)}% of ${p.totalHours} estimated hours; ${p.doneCount} of ${p.taskCount} tasks approved.`,
    `Longest remaining chain: ${criticalPathHours} hours.${p.dueAt ? ` Due ${date(p.dueAt)}.` : ''}`,
    risks.length ? `Needs attention:\n${risks.map((r) => `- ${r.text}`).join('\n')}` : 'Nothing needs attention.',
  ].join('\n');
}

function Report({ report, online, refresh }: { report: ProjectReport; online: boolean; refresh: () => void }) {
  const { project: p, tasks, risks, activity, team, ready, criticalPathHours } = report;
  const [scenario, setScenario] = useState<Scenario>('random');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const keyFor = useIdempotencyKey();

  const release = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { scenario };
      await post(`/api/projects/${p.id}/release`, body, keyFor([body, ready]));
      refresh();
    } catch (e) {
      setError((e as ApiError).message);
    }
    setBusy(false);
  };

  return (
    <div className="card detail">
      <div className="detail-head">
        <small>
          {p.branch} · <span className={`priority ${p.priority}`}>{p.priority}</span>
          {p.owner ? ` · owner ${p.owner}` : ''}
          {p.dueAt ? ` · due ${date(p.dueAt)}` : ''}
        </small>
        <h2>{p.name}</h2>
        <p>{p.goal}</p>
        <Health project={p} />
        <Progress value={share(p)} />
        <small>
          {share(p)}% of {p.totalHours} estimated hours · {p.doneCount} of {p.taskCount} approved · {criticalPathHours}h
          left on the longest chain
        </small>
        <button
          onClick={() => {
            navigator.clipboard.writeText(statusText(report)).then(
              () => setCopied(true),
              () => setError('Could not use the clipboard.'),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy status report'}
        </button>
      </div>

      <section>
        <h3>Needs your attention</h3>
        {risks.length === 0 && <p className="muted">Nothing right now.</p>}
        <ul className="records">
          {risks.map((r, i) => (
            <li key={i} className={`risk ${r.severity}`}>
              {r.taskId ? <a href={`#${r.taskId}`}>{r.text}</a> : r.text}
            </li>
          ))}
        </ul>
      </section>

      {ready.length > 0 && (
        <section>
          <h3>Ready to start</h3>
          <p>
            {ready.join(', ')} {ready.length === 1 ? 'has' : 'have'} nothing left to wait for.
          </p>
          <ScenarioField value={scenario} onChange={setScenario} />
          <button className="primary" disabled={!online || busy} onClick={() => void release()}>
            Send {ready.length} to routing
          </button>
          {error && <p className="error">{error}</p>}
        </section>
      )}

      <section className="scroll flush">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>State</th>
              <th>Who</th>
              <th>Progress</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} onClick={() => (window.location.hash = t.id)}>
                <td>
                  <a href={`#${t.id}`}>{t.title}</a>
                  <small>
                    {t.id} · {t.expertise} · {t.requirements.estimateHours}h
                    {t.waitingOn.length ? ` · after ${t.waitingOn.join(', ')}` : ''}
                  </small>
                </td>
                <td>
                  <StatusBadge task={t} />
                </td>
                <td>{t.assignee?.name ?? <span className="muted">—</span>}</td>
                <td className="nowrap">{t.status === 'completed' ? 100 : t.progress}%</td>
                <td className="nowrap">{t.dueAt ? date(t.dueAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {team.length > 0 && (
        <section>
          <h3>People on it</h3>
          <ul className="records">
            {team.map((m) => (
              <li key={m.id}>
                <a href={`#people/${m.id}`}>{m.name}</a> · {m.title} · {m.taskCount} here · {m.loadHours}h of{' '}
                {m.weeklyHours}h committed overall
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Recent activity</h3>
        <ol className="timeline">
          {activity.map((a) => (
            <li key={a.id}>
              <time title={new Date(a.at).toLocaleString()}>{clockTime(a.at)}</time>
              <div>
                <a href={`#${a.taskId}`}>{a.taskId}</a> <span className="actor">{a.actor}</span> {a.summary}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
