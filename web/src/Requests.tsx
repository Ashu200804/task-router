import { useState } from 'react';
import type { WorkRequest } from '../../shared/types.ts';
import { ApiError } from './api.ts';
import { clockTime } from './format.ts';

interface Props {
  requests: WorkRequest[];
  /** Whether the viewer may decide the open ones shown. */
  canDecide: boolean;
  /** Limits decisions to one person's requests; the operator may decide any. */
  me?: string;
  post: (requestId: string, body: unknown) => Promise<void>;
}

/** Requests on a task: what was asked, what the system did with it, and any decision due. */
export function Requests({ requests, ...rest }: Props) {
  if (!requests.length) return null;
  return (
    <section>
      <h3>Requests</h3>
      {requests.map((r) => (
        <RequestCard key={r.id} request={r} {...rest} />
      ))}
    </section>
  );
}

export function RequestCard({ request: r, canDecide, me, post, showTask }: Omit<Props, 'requests'> & { request: WorkRequest; showTask?: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mine = r.status === 'open' && (me === undefined || r.handler?.id === me);
  const question = r.type === 'question';

  const send = async (decision: 'approve' | 'decline' | 'answer') => {
    if (decision !== 'approve' && !text.trim()) return setError('Write a reply first.');
    setBusy(true);
    setError('');
    try {
      await post(r.id, { decision, text: text.trim() || undefined });
    } catch (e) {
      setError((e as ApiError).message);
    }
    setBusy(false);
  };

  return (
    <div className="fit">
      <div className="fit-head">
        <span>
          <strong>{r.from.name}</strong> · {r.type}
          {r.days ? ` · ${r.days} day(s)` : ''}
          {showTask && (
            <>
              {' · '}
              <a href={`#${r.taskId}`}>
                {r.taskId} {r.taskTitle}
              </a>
            </>
          )}
        </span>
        <span className={`badge ${r.status === 'open' ? 'warn' : ''}`}>
          {r.status === 'open' ? `With ${r.handler?.name ?? 'operator'}` : r.status}
        </span>
      </div>
      <p>{r.text}</p>
      <small>
        {clockTime(r.createdAt)} · {r.routing}
        {r.helperTaskId && (
          <>
            {' '}
            <a href={`#${r.helperTaskId}`}>Open {r.helperTaskId}</a>
          </>
        )}
      </small>
      {r.response && <p className="callout">{r.response}</p>}
      {mine && canDecide && (
        <div className="ask">
          <input aria-label={question ? 'Your answer' : 'Your note'} placeholder={question ? 'Your answer' : 'Note (needed to decline)'} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
          <div className="actions">
            {question ? (
              <button disabled={busy} onClick={() => void send('answer')}>
                Send answer
              </button>
            ) : (
              <>
                <button disabled={busy} onClick={() => void send('approve')}>
                  Approve
                </button>
                <button disabled={busy} onClick={() => void send('decline')}>
                  Decline
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
