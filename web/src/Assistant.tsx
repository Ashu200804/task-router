import { useState, type FormEvent } from 'react';
import type { Branch, CaseDetail, CaseList, CaseOption, Certainty, Trigger } from '../../shared/types.ts';
import { ApiError, post, useIdempotencyKey, useResource } from './api.ts';
import { Dialog } from './Dialog.tsx';
import { clockTime, duration } from './format.ts';

const CERTAINTY: Record<Certainty, string> = { recorded: 'Recorded', inferred: 'Inferred', unknown: 'Unknown' };
const label = (t: Trigger) => t.replaceAll('_', ' ');

interface Props {
  selectedId: string | null;
  branch: Branch | '';
  online: boolean;
  now: number;
}

export function Assistant({ selectedId, branch, online, now }: Props) {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [generation, setGeneration] = useState(0);
  const list = useResource<CaseList>(`/api/cases?status=${status}`, generation);
  const detail = useResource<CaseDetail>(selectedId ? `/api/cases/${selectedId}` : null, generation);
  const visible = list?.cases.filter((c) => !branch || c.branch === branch);
  const reviewed = list ? list.reviewed.correct + list.reviewed.wrong : 0;

  return (
    <main className="layout projects">
      <section>
        <nav className="filters" aria-label="Case filters">
          {(['open', 'closed'] as const).map((s) => (
            <button key={s} className={status === s ? 'active' : ''} aria-pressed={status === s} onClick={() => setStatus(s)}>
              {s === 'open' ? 'Open' : 'Closed'} {s === 'open' && <span>{list?.open}</span>}
            </button>
          ))}
        </nav>
        {list && (
          <p className="muted">
            {list.waiting > 0 && `${list.waiting} waiting to be investigated. `}
            {reviewed
              ? `People judged ${list.reviewed.correct} of ${reviewed} diagnoses correct.`
              : 'No diagnosis has been checked yet.'}
          </p>
        )}
        {visible?.length === 0 && <p className="empty card">{status === 'open' ? 'Nothing needs help right now.' : 'No closed cases.'}</p>}
        <ul className="cards">
          {visible?.map((c) => (
            <li key={c.id} className={`card ${c.id === selectedId ? 'selected' : ''}`}>
              <a href={`#assistant/${c.id}`}>{c.headline}</a>
              <small>
                {c.taskId} · {c.taskTitle}
              </small>
              <small>
                <span className={`priority ${c.priority}`}>{c.priority}</span> · {c.branch} · {duration(now - c.createdAt)} ago
                {c.status !== 'open' ? ` · ${c.status}` : ''}
                {c.verdict ? ` · judged ${c.verdict}` : ''}
              </small>
              {c.failed && <span className="badge needs_attention">Investigation failed</span>}
            </li>
          ))}
        </ul>
      </section>
      <section>
        {detail && list ? (
          <Case key={detail.id} item={detail} model={list.modelEnabled} online={online} refresh={() => setGeneration((g) => g + 1)} />
        ) : (
          <p className="empty">Select a case to see what happened, the evidence, and what can be done.</p>
        )}
      </section>
    </main>
  );
}

/** The whole case as text, for a ticket or a message. */
function asText(c: CaseDetail): string {
  const { report: r } = c;
  return [
    `${c.taskId} ${c.taskTitle}: ${r.headline} (${label(c.trigger)}, ${c.status})`,
    '',
    'Findings:',
    ...r.findings.map((f) => `- [${CERTAINTY[f.certainty]}] ${f.text}${f.evidence.length ? ` (${f.evidence.join(', ')})` : ''}`),
    '',
    'Evidence:',
    ...r.evidence.map((e) => `- ${e.id} ${e.tool}: ${e.fact}`),
    '',
    'Options:',
    ...r.options.map((o) => `- ${o.recommended ? '(recommended) ' : ''}${o.label}. ${o.tradeoff}`),
    ...(c.verdict ? ['', `Reviewed: ${c.verdict}${c.verdictNote ? `. ${c.verdictNote}` : ''}`] : []),
  ].join('\n');
}

type Pending = { kind: 'apply'; option: CaseOption } | { kind: 'wrong' };

function Case({ item, model, online, refresh }: { item: CaseDetail; model: boolean; online: boolean; refresh: () => void }) {
  const { report } = item;
  const [pending, setPending] = useState<Pending | null>(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const keyFor = useIdempotencyKey();
  const open = item.status === 'open';

  const send = async (path: string, body: unknown, key = keyFor([path, body])) => {
    setBusy(true);
    setError('');
    try {
      await post(`/api/cases/${item.id}/${path}`, body, key);
      refresh();
      return true;
    } catch (e) {
      setError((e as ApiError).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const copy = (what: string, text: string) =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(what),
      () => setError('Could not use the clipboard.'),
    );
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (await send('ask', { question }, crypto.randomUUID())) setQuestion('');
  };

  return (
    <div className="card detail">
      <div className="detail-head">
        <small>
          <a href={`#${item.taskId}`}>
            {item.taskId} · {item.taskTitle}
          </a>
          {' · '}
          {label(item.trigger)} · opened {clockTime(item.createdAt)}
        </small>
        <h2>{report.headline}</h2>
        {!open && (
          <p className="situation">
            {item.status === 'superseded'
              ? 'The task changed after this was written, so its options no longer apply.'
              : `${item.status === 'resolved' ? 'Resolved' : 'Dismissed'}${item.resolvedBy ? ` by ${item.resolvedBy}` : ''}${
                  item.chosenOption ? `: ${report.options.find((o) => o.id === item.chosenOption)?.label}` : ''
                }.`}
          </p>
        )}
        <button onClick={() => void copy('report', asText(item))}>{copied === 'report' ? 'Copied' : 'Copy report'}</button>
      </div>

      <section>
        <h3>What was found</h3>
        <ul className="records">
          {report.findings.map((f, i) => (
            <li key={i}>
              <span className={`certainty ${f.certainty}`}>{CERTAINTY[f.certainty]}</span> {f.text}{' '}
              <span className="muted">{f.evidence.join(' ')}</span>
            </li>
          ))}
        </ul>
        {report.evidence.length > 0 && (
          <details>
            <summary>Evidence ({report.evidence.length})</summary>
            <ul className="records">
              {report.evidence.map((e) => (
                <li key={e.id}>
                  <strong>{e.id}</strong> {e.fact} <span className="muted">via {e.tool}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <details>
          <summary>Steps taken ({item.trace.length} tool calls)</summary>
          <ol className="records">
            {item.trace.map((t, i) => (
              <li key={i}>
                {t.tool} <span className="muted">{t.ok ? 'ok' : `failed: ${t.error}`} · {t.ms}ms</span>
              </li>
            ))}
          </ol>
        </details>
      </section>

      {report.options.length > 0 && (
        <section>
          <h3>Options</h3>
          {report.options.map((o) => (
            <div key={o.id} className={`fit ${o.recommended ? 'recommended' : ''}`}>
              <div className="fit-head">
                <span>
                  {o.recommended && <span className="badge accepted">Recommended</span>} {o.label}
                </span>
                {o.command && open ? (
                  <button disabled={!online || busy} onClick={() => setPending({ kind: 'apply', option: o })}>
                    Review and run…
                  </button>
                ) : (
                  !o.command && <span className="muted">For you to do</span>
                )}
              </div>
              {o.relaxes.length > 0 && <small className="reasons">Sets aside: {o.relaxes.join(', ')}</small>}
              <small>{o.tradeoff}</small>
            </div>
          ))}
          {report.draftMessage && (
            <div className="callout">
              <p>{report.draftMessage}</p>
              <button onClick={() => void copy('draft', report.draftMessage!)}>{copied === 'draft' ? 'Copied' : 'Copy message'}</button>
              <small>Nothing is sent for you.</small>
            </div>
          )}
        </section>
      )}

      <section>
        <h3>Ask about this case</h3>
        <p className="muted">
          {model
            ? 'A language model answers from read-only tools. Check its citations. Names are hidden from it; task text is not.'
            : 'Answered by rules from the data. Try “Who else could do it?” or ask about a person by name.'}
        </p>
        <ul className="records">
          {item.messages.map((m) => (
            <li key={m.id} className="exchange">
              <strong>{m.question}</strong>
              <p>{m.answer.text}</p>
              <small>
                {m.answer.source === 'model' ? 'Written by a model' : 'From rules'}
                {m.answer.note ? ` · ${m.answer.note}` : ''}
                {m.answer.evidence.length ? ` · ${m.answer.evidence.map((e) => `${e.id}: ${e.fact}`).join(' ')}` : ''}
              </small>
            </li>
          ))}
        </ul>
        <form onSubmit={ask} className="ask">
          <input aria-label="Your question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} required />
          <button disabled={!online || busy}>{busy ? 'Working…' : 'Ask'}</button>
        </form>
      </section>

      <section>
        <h3>Was this diagnosis right?</h3>
        {item.verdict && (
          <p>
            Judged <strong>{item.verdict}</strong>
            {item.verdictBy ? ` by ${item.verdictBy}` : ''}
            {item.verdictNote ? `: ${item.verdictNote}` : ''}
          </p>
        )}
        <div className="actions">
          <button disabled={!online || busy} onClick={() => void send('review', { verdict: 'correct' })}>
            Yes, correct
          </button>
          <button disabled={!online || busy} onClick={() => setPending({ kind: 'wrong' })}>
            No, wrong…
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {pending && <Decide pending={pending} open={open} error={error} busy={busy} send={send} onClose={() => setPending(null)} />}
    </div>
  );
}

interface DecideProps {
  pending: Pending;
  open: boolean;
  error: string;
  busy: boolean;
  send: (path: string, body: unknown) => Promise<boolean>;
  onClose: () => void;
}

/** The approval step: shows exactly what will happen and lets the person change the reason. */
function Decide({ pending, open, error, busy, send, onClose }: DecideProps) {
  const apply = pending.kind === 'apply' ? pending.option : null;
  const [text, setText] = useState(apply?.command?.reason ?? '');
  const [dismiss, setDismiss] = useState(false);
  const stale = apply !== null && !open;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const sent = apply
      ? await send('apply', { optionId: apply.id, reason: text })
      : await send('review', { verdict: 'wrong', note: text, dismiss });
    if (sent) onClose();
  };

  return (
    <Dialog title={apply ? 'Approve this action' : 'What was wrong?'} onClose={onClose}>
      <form onSubmit={submit}>
        {apply && (
          <>
            <p>{apply.label}</p>
            {apply.relaxes.length > 0 && <p className="changed">This sets aside: {apply.relaxes.join(', ')}.</p>}
            <p className="muted">{apply.tradeoff} It runs under your name.</p>
          </>
        )}
        {stale && <p className="changed" role="alert">The task changed while you were deciding. This option no longer applies.</p>}
        <label>
          <span>{apply ? 'Reason recorded in history' : 'What should it have said?'}</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={apply ? 500 : 1000} required />
        </label>
        {!apply && open && (
          <label className="check">
            <input type="checkbox" checked={dismiss} onChange={(e) => setDismiss(e.target.checked)} />
            Also close this case
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button className="primary" disabled={busy || stale}>
            {apply ? 'Approve and run' : 'Save'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
