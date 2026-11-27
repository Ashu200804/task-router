import { useState, type FormEvent } from 'react';
import type { Branch, Contributor, PersonDetail, WorkRecord } from '../../shared/types.ts';
import { ApiError, post, useIdempotencyKey, useResource } from './api.ts';
import { Dialog } from './Dialog.tsx';
import { Progress } from './Fit.tsx';
import { StatusBadge } from './TaskTable.tsx';
import { clockTime, rate } from './format.ts';

/** Matches the server's threshold for calling a record thin. */
const ENOUGH_HISTORY = 5;

const rating = (r: WorkRecord) => (r.ratingCount ? (r.ratingSum / r.ratingCount).toFixed(1) : '—');
const load = (p: Contributor) => Math.round((p.loadHours / p.profile.weeklyHours) * 100);

interface Props {
  selectedId: string | null;
  branch: Branch | '';
  contributors: Contributor[];
  online: boolean;
  refresh: () => void;
}

export function People({ selectedId, branch, contributors, online, refresh }: Props) {
  const [team, setTeam] = useState('');
  const [search, setSearch] = useState('');
  const detail = useResource<PersonDetail>(selectedId ? `/api/contributors/${selectedId}` : null);
  const inBranch = contributors.filter((p) => !branch || p.branch === branch);
  const teams = [...new Set(inBranch.map((p) => p.profile.team))].sort();
  const needle = search.trim().toLowerCase();
  const visible = inBranch
    .filter((p) => !team || p.profile.team === team)
    .filter((p) =>
      !needle || [p.name, p.profile.title, ...p.profile.skills, ...p.expertise].some((v) => v.toLowerCase().includes(needle)),
    )
    .sort((a, b) => a.branch.localeCompare(b.branch) || a.profile.team.localeCompare(b.profile.team) || Number(b.profile.lead) - Number(a.profile.lead));

  return (
    <main className="layout">
      <section className="list">
        <nav className="filters" aria-label="People filters">
          <select aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <input type="search" aria-label="Search people" placeholder="Search name or skill" value={search} onChange={(e) => setSearch(e.target.value)} />
        </nav>
        <div className="card scroll">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Committed</th>
                <th>Done</th>
                <th>On time</th>
                <th>First pass</th>
                <th>Rating</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className={p.id === selectedId ? 'selected' : ''} onClick={() => (window.location.hash = `people/${p.id}`)}>
                  <td>
                    <a href={`#people/${p.id}`}>{p.name}</a>
                    {p.profile.lead && <span className="tag">lead</span>}
                    {!p.available && <span className="tag away">unavailable</span>}
                    <small>
                      {p.profile.title} · {p.branch} · {p.profile.team}
                    </small>
                  </td>
                  <td>
                    <Progress value={load(p)} label={`${p.name} workload`} />
                    <small className="nowrap">
                      {p.loadHours}h of {p.profile.weeklyHours}h
                    </small>
                  </td>
                  <td>{p.record.completed}</td>
                  <td>{rate(p.record.onTime, p.record.completed)}</td>
                  <td>{rate(p.record.firstPass, p.record.completed)}</td>
                  <td>{rating(p.record)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <aside className="panel">
        {detail ? (
          <Profile key={detail.person.id} detail={detail} online={online} refresh={refresh} />
        ) : (
          <p className="empty">Select a person to see their profile, record and current work.</p>
        )}
      </aside>
    </main>
  );
}

function Profile({ detail, online, refresh }: { detail: PersonDetail; online: boolean; refresh: () => void }) {
  const { person, lead, tasks, activity } = detail;
  const { profile: f, record: r } = person;
  const [changing, setChanging] = useState(false);
  const hours = r.responses ? (r.responseMs / r.responses / 3_600_000).toFixed(1) : null;
  const facts: [string, string][] = [
    ['Role', `${f.title} · ${f.seniority}${f.lead ? ' · team lead' : ''}`],
    ['Team', `${person.branch} · ${f.team}${lead ? ` · lead ${lead}` : ''}`],
    ['Expertise', person.expertise.map((e) => `${e} ${f.levels[e]}/5`).join(', ')],
    ['Skills', f.skills.join(', ') || '—'],
    ['Certifications', f.certifications.join(', ') || '—'],
    ['Languages', f.languages.join(', ') || '—'],
    ['Joined', f.joined || '—'],
    ['Capacity', `${person.loadHours}h committed of ${f.weeklyHours}h a week, ${person.activeCount} open task(s)`],
  ];
  const record: [string, string][] = [
    ['Tasks approved', String(r.completed)],
    ['Submitted on time', `${rate(r.onTime, r.completed)} (${r.onTime}/${r.completed})`],
    ['Approved first time', `${rate(r.firstPass, r.completed)} (${r.firstPass}/${r.completed})`],
    ['Average rating', `${rating(r)} from ${r.ratingCount}`],
    ['Offers accepted', `${rate(r.accepted, r.accepted + r.declined)} (${r.accepted}/${r.accepted + r.declined})`],
    ['Time to respond', hours === null ? '—' : `${hours}h average`],
    ['Failed assignments', String(r.failed)],
  ];
  const list = (rows: [string, string][]) => (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k} className="pair">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <div className="card detail">
      <div className="detail-head">
        <h2>{person.name}</h2>
        <span className={`badge ${person.available ? 'accepted' : 'warn'}`}>{person.available ? 'Available' : 'Unavailable'}</span>
        {list(facts)}
        <button disabled={!online} onClick={() => setChanging(true)}>
          {person.available ? 'Mark unavailable…' : 'Mark available…'}
        </button>
      </div>
      <section>
        <h3>Work record</h3>
        {r.completed < ENOUGH_HISTORY && <p className="situation warn">Limited history. Do not read much into these numbers.</p>}
        {list(record)}
        <p className="muted">
          Counts of work outcomes only. They miss difficulty, help given to others and anything outside this system.
        </p>
      </section>
      <section>
        <h3>Holding now</h3>
        {tasks.length === 0 && <p className="muted">Nothing open.</p>}
        <ul className="records">
          {tasks.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`}>{t.title}</a> <StatusBadge task={t} />
              <small>
                {t.requirements.estimateHours}h · {t.progress}% · last activity {clockTime(t.lastActivityAt)}
              </small>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Activity on tasks</h3>
        {activity.length === 0 && <p className="muted">Nothing recorded in this system yet.</p>}
        <ol className="timeline">
          {activity.map((a) => (
            <li key={a.id}>
              <time title={new Date(a.at).toLocaleString()}>{clockTime(a.at)}</time>
              <div>
                <a href={`#${a.taskId}`}>{a.taskId}</a> {a.summary}
              </div>
            </li>
          ))}
        </ol>
      </section>
      {changing && (
        <AvailabilityDialog
          person={person}
          onClose={() => {
            setChanging(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function AvailabilityDialog({ person, onClose }: { person: Contributor; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyFor = useIdempotencyKey();
  const available = !person.available;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = { available, reason: reason.trim() || undefined };
    try {
      await post(`/api/contributors/${person.id}/availability`, body, keyFor(body));
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Mark ${person.name} ${available ? 'available' : 'unavailable'}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p>
          {available
            ? 'Routing can select them again.'
            : `Routing will skip them. Unanswered offers are withdrawn at once; work they already accepted stays with them and is flagged. They hold ${person.activeCount} open task(s).`}
        </p>
        <label>
          <span>Reason (optional, kept in history)</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
        </label>
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button className="primary" disabled={busy}>
            Confirm
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
