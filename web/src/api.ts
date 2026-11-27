import { useCallback, useEffect, useRef, useState } from 'react';
import type { Contributor, Health, TaskDetail, TaskPage } from '../../shared/types.ts';

export class ApiError extends Error {
  stale: boolean;
  constructor(message: string, stale = false) {
    super(message);
    this.stale = stale;
  }
}

const POLL_MS = 2000;
const HIDDEN_POLL_MS = 15_000;

/** Last body seen per URL, so an unchanged page costs a 304 and no re-render. */
const seen = new Map<string, { etag: string; body: unknown }>();
let serverClock = { serverTime: 0, receivedAt: 0 };

/**
 * The development sign-in lives in this tab only, so two tabs can be two people. Switching reloads
 * the page, which drops everything cached for whoever was there before.
 */
export const session = {
  read(): { token: string; name: string } | null {
    try {
      return JSON.parse(sessionStorage.getItem('session') ?? 'null');
    } catch {
      return null;
    }
  },
  async signIn(contributorId: string) {
    const made = await post<{ token: string; name: string }>('/api/session', { contributorId }, crypto.randomUUID());
    sessionStorage.setItem('session', JSON.stringify(made));
    window.location.hash = '';
    window.location.reload();
  },
  signOut() {
    sessionStorage.removeItem('session');
    window.location.hash = '';
    window.location.reload();
  },
};
const sessionHeader = (): Record<string, string> => {
  const found = session.read();
  return found ? { 'x-session': found.token } : {};
};

async function get<T>(url: string): Promise<T> {
  const known = seen.get(url);
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { ...sessionHeader(), ...(known && { 'if-none-match': known.etag }) },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401) session.signOut();
  const time = Number(res.headers.get('x-server-time'));
  if (time) serverClock = { serverTime: time, receivedAt: Date.now() };
  if (res.status === 304 && known) return known.body as T;
  const body = await res.json();
  if (!res.ok) throw new ApiError(body?.error?.message ?? `Request failed (${res.status}).`);
  const etag = res.headers.get('etag');
  if (etag) {
    if (seen.size > 100) seen.clear();
    seen.set(url, { etag, body });
  }
  return body as T;
}

export const operatorName = {
  read(): string {
    try {
      return localStorage.getItem('operator') ?? '';
    } catch {
      return '';
    }
  },
  write(name: string) {
    try {
      localStorage.setItem('operator', name);
    } catch {
      /* private window: the name lasts until reload */
    }
    current = name;
  },
};
let current = operatorName.read();

/**
 * Sends a change. The idempotency key makes repeating it safe, so network failures and a busy
 * server are retried automatically with the same key.
 */
export async function post<T>(path: string, body: unknown, key: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
          'x-operator': encodeURIComponent(current),
          ...sessionHeader(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      /* no reply: the change may or may not have happened */
    }
    if (res && res.status !== 503) {
      const reply = await res.json().catch(() => null);
      if (res.ok && reply) return reply as T;
      if (reply) throw new ApiError(reply.error?.message ?? 'Request failed.', reply.error?.code === 'stale');
    }
    if (attempt === 3) {
      throw new ApiError('No confirmation from the server. It is safe to try again: it will not be applied twice.');
    }
    await new Promise((r) => setTimeout(r, attempt * 500));
  }
}

/** The same intent keeps the same key, so pressing the button again cannot apply it twice. */
export function useIdempotencyKey() {
  const last = useRef({ payload: '', key: '' });
  return useCallback((payload: unknown) => {
    const text = JSON.stringify(payload);
    if (text !== last.current.payload) last.current = { payload: text, key: crypto.randomUUID() };
    return last.current.key;
  }, []);
}

/** Polls one resource while a screen shows it. */
export function useResource<T>(url: string | null, generation = 0): T | null {
  const [result, setResult] = useState<{ url: string; body: T } | null>(null);
  useEffect(() => {
    if (!url) return;
    let stopped = false;
    let timer = 0;
    const load = async () => {
      try {
        const body = await get<T>(url);
        if (!stopped) setResult({ url, body });
      } catch {
        /* the main poll reports lost contact */
      }
      if (!stopped) timer = window.setTimeout(load, document.hidden ? HIDDEN_POLL_MS : POLL_MS * 1.5);
    };
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [url, generation]);
  return result && result.url === url ? result.body : null;
}

export interface Snapshot {
  /** The list query these results answer. */
  query: string;
  list: TaskPage;
  contributors: Contributor[];
  health: Health;
  detail: TaskDetail | null;
  serverTime: number;
  receivedAt: number;
}

/**
 * Polls conditionally. Polling recovers by itself after a restart or a switch between server
 * instances, and unchanged data costs almost nothing. Hidden tabs slow right down.
 */
export function useSnapshot(query: string, selectedId: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(true);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const load = async () => {
      window.clearTimeout(timer);
      try {
        const [list, contributors, health, detail] = await Promise.all([
          get<TaskPage>(`/api/tasks?${query}`),
          get<Contributor[]>('/api/contributors'),
          get<Health>('/api/health'),
          selectedId ? get<TaskDetail>(`/api/tasks/${selectedId}`).catch(() => null) : null,
        ]);
        if (stopped) return;
        setSnapshot({ query, list, contributors, health, detail, ...serverClock });
        setOnline(true);
      } catch {
        if (!stopped) setOnline(false);
      }
      // Jitter keeps many consoles from asking in step.
      const wait = (document.hidden ? HIDDEN_POLL_MS : POLL_MS) * (0.85 + Math.random() * 0.3);
      if (!stopped) timer = window.setTimeout(load, wait);
    };
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [query, selectedId, generation]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  return { snapshot, online, refresh };
}
