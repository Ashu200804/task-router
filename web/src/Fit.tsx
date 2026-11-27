import type { Candidate } from '../../shared/types.ts';

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Progress'}>
      <div style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

/** One person against one task: the score, and every reason behind it. */
export function Fit({ candidate: c }: { candidate: Candidate }) {
  return (
    <div className={`fit ${c.blockers.length ? 'unfit' : ''}`}>
      <div className="fit-head">
        <span>
          <a href={`#people/${c.contributorId}`}>{c.name}</a> <span className="muted">{c.title}</span>
        </span>
        <strong>{c.score}</strong>
      </div>
      {c.blockers.length > 0 && <small className="reasons">Not eligible: {c.blockers.join('; ')}</small>}
      {c.lowData && <small className="reasons">Limited history: rates are estimates.</small>}
      <details>
        <summary>Why this score</summary>
        <ul className="records">
          {c.factors.map((f) => (
            <li key={f.factor}>
              {f.factor} {f.points}/{f.max} <span className="muted">· {f.note}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
