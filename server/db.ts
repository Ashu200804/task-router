import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL,                    -- random per database, so a reset invalidates caches
  revision INTEGER NOT NULL,              -- bumped by triggers; the read cache is keyed on it
  task_seq INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (id, epoch, revision, task_seq)
VALUES (1, lower(hex(randomblob(8))), 0, 100);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  branch TEXT NOT NULL,
  owner TEXT,
  priority TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  due_at INTEGER
);

CREATE TABLE IF NOT EXISTS contributors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  expertise TEXT NOT NULL,                -- JSON array
  available INTEGER NOT NULL DEFAULT 1,
  profile TEXT NOT NULL DEFAULT '{}',     -- JSON, see Profile
  -- Current workload, kept by triggers. Counting it on every read grows with the backlog.
  active_count INTEGER NOT NULL DEFAULT 0,
  load_hours REAL NOT NULL DEFAULT 0
);

-- Outcome counts, updated in the same transaction as the outcome. Reading them is O(1).
CREATE TABLE IF NOT EXISTS work_records (
  contributor_id TEXT PRIMARY KEY REFERENCES contributors(id),
  accepted INTEGER NOT NULL DEFAULT 0,
  declined INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  on_time INTEGER NOT NULL DEFAULT 0,
  first_pass INTEGER NOT NULL DEFAULT 0,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  responses INTEGER NOT NULL DEFAULT 0,
  response_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS contributors_by_branch ON contributors(branch, name);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  expertise TEXT NOT NULL,
  branch TEXT NOT NULL,
  priority TEXT NOT NULL,
  priority_rank INTEGER NOT NULL,
  status TEXT NOT NULL,
  attention_reason TEXT,
  -- Bumped on every state change. Operator commands must name the version they saw.
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  status_since INTEGER NOT NULL,
  overdue_since INTEGER,
  holder_away INTEGER NOT NULL DEFAULT 0,
  queue_rank INTEGER NOT NULL,            -- index into QUEUES, derived from the columns around it
  project_id TEXT REFERENCES projects(id),
  estimate_hours REAL NOT NULL,
  due_at INTEGER,
  min_level INTEGER NOT NULL,
  certification TEXT,
  skills TEXT NOT NULL,                   -- JSON array
  progress INTEGER NOT NULL DEFAULT 0,
  blocker TEXT,
  quiet_since INTEGER,
  past_due_since INTEGER,
  last_activity_at INTEGER NOT NULL,
  triage INTEGER NOT NULL DEFAULT 0,      -- 1: waiting for the assistant to investigate
  requester_id TEXT REFERENCES contributors(id)
);
CREATE INDEX IF NOT EXISTS tasks_by_requester ON tasks(requester_id, created_at) WHERE requester_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_to_triage ON tasks(priority_rank, last_activity_at) WHERE triage = 1;
CREATE INDEX IF NOT EXISTS tasks_by_project ON tasks(project_id, created_at, id);
CREATE INDEX IF NOT EXISTS tasks_that_may_go_quiet ON tasks(last_activity_at)
  WHERE status IN ('accepted', 'in_progress') AND quiet_since IS NULL;
CREATE INDEX IF NOT EXISTS tasks_that_may_pass_due ON tasks(due_at)
  WHERE due_at IS NOT NULL AND past_due_since IS NULL AND status NOT IN ('completed', 'cancelled');

CREATE TABLE IF NOT EXISTS dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX IF NOT EXISTS dependents ON dependencies(depends_on);
CREATE INDEX IF NOT EXISTS tasks_listing ON tasks(queue_rank, priority_rank, created_at, id);
CREATE INDEX IF NOT EXISTS tasks_listing_by_branch ON tasks(branch, queue_rank, priority_rank, created_at, id);

CREATE TABLE IF NOT EXISTS routing_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,                    -- pending | matched | no_match | superseded | failed
  scenario TEXT NOT NULL,                 -- simulation control, never exposed by the API
  requested_at INTEGER NOT NULL,
  dispatched_at INTEGER,                  -- null until handed to the engine
  closed_at INTEGER,
  closed_reason TEXT,
  closed_code TEXT,                       -- 'capacity': retried automatically a few times
  returned_at INTEGER,
  returned_contributor_id TEXT REFERENCES contributors(id),
  overdue_flagged INTEGER NOT NULL DEFAULT 0,
  UNIQUE (task_id, attempt)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request_per_task
  ON routing_requests(task_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS requests_awaiting_overdue_flag
  ON routing_requests(COALESCE(dispatched_at, requested_at)) WHERE state = 'pending' AND overdue_flagged = 0;

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  contributor_id TEXT NOT NULL REFERENCES contributors(id),
  request_id TEXT REFERENCES routing_requests(id),
  status TEXT NOT NULL,
  source TEXT NOT NULL,                   -- routing | operator
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  end_code TEXT,                          -- 'unavailable': revoked through no fault of theirs
  revisions INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS progress_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                     -- progress | blocker
  note TEXT NOT NULL,
  percent INTEGER,
  hours REAL
);
CREATE INDEX IF NOT EXISTS updates_by_task ON progress_updates(task_id, id);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  link TEXT,
  decision TEXT,                          -- approved | changes_requested
  feedback TEXT,
  rating INTEGER,
  reviewed_by TEXT,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS submissions_by_task ON submissions(task_id, id);
-- The core rules, enforced by the database and not only by code.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_assignment_per_task
  ON assignments(task_id) WHERE status IN ('offered', 'accepted', 'in_progress', 'in_review');
CREATE UNIQUE INDEX IF NOT EXISTS one_assignment_per_routing_request
  ON assignments(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assignments_by_task ON assignments(task_id, status);
CREATE INDEX IF NOT EXISTS active_assignments_by_contributor
  ON assignments(contributor_id) WHERE status IN ('offered', 'accepted', 'in_progress', 'in_review');

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  actor_name TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  note TEXT,
  contributor_id TEXT                     -- whom the event is about, for their activity feed
);
CREATE INDEX IF NOT EXISTS events_by_task ON events(task_id, id);
CREATE INDEX IF NOT EXISTS events_by_contributor ON events(contributor_id, id) WHERE contributor_id IS NOT NULL;

-- Durable work queue. A job is removed in the same transaction as its effect.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                     -- dispatch | apply
  request_id TEXT NOT NULL REFERENCES routing_requests(id),
  payload TEXT,
  created_at INTEGER NOT NULL,
  rank INTEGER NOT NULL,                  -- lower runs first: age, with a head start for priority
  run_after INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  dead_at INTEGER,
  last_error TEXT,
  UNIQUE (kind, request_id)
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(rank, id) WHERE dead_at IS NULL;
CREATE INDEX IF NOT EXISTS jobs_dead ON jobs(request_id) WHERE dead_at IS NOT NULL;

-- Written in the same transaction as the change it describes, so a retry replays the answer.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_by_age ON idempotency_keys(created_at);

-- Development sign-ins: they say who is acting, with no password. Not authentication.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  contributor_id TEXT NOT NULL REFERENCES contributors(id),
  created_at INTEGER NOT NULL
);

-- Things people ask for on a task.
CREATE TABLE IF NOT EXISTS work_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  days INTEGER,
  from_id TEXT NOT NULL REFERENCES contributors(id),
  handler_id TEXT REFERENCES contributors(id),
  status TEXT NOT NULL,                   -- open | delegated | resolved | approved | declined | closed
  routing TEXT NOT NULL,
  response TEXT,
  suggestion TEXT,                        -- JSON
  helper_task_id TEXT REFERENCES tasks(id),
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_request_per_kind
  ON work_requests(task_id, from_id, type) WHERE status IN ('open', 'delegated');
CREATE INDEX IF NOT EXISTS requests_by_task ON work_requests(task_id);
CREATE INDEX IF NOT EXISTS requests_by_handler ON work_requests(handler_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS requests_by_sender ON work_requests(from_id, created_at);
CREATE INDEX IF NOT EXISTS requests_by_helper ON work_requests(helper_task_id) WHERE helper_task_id IS NOT NULL;

-- One investigation per occurrence of a problem, kept for people to verify. Never deleted.
CREATE TABLE IF NOT EXISTS agent_cases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  trigger TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  status TEXT NOT NULL,                   -- open | resolved | dismissed | superseded
  priority_rank INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  failed INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL,                   -- JSON, see CaseReport
  trace TEXT NOT NULL,                    -- JSON: every tool call made
  chosen_option TEXT,
  resolved_by TEXT,
  verdict TEXT,                           -- correct | wrong, given by a person
  verdict_note TEXT,
  verdict_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_case_per_task ON agent_cases(task_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS cases_by_status ON agent_cases(status, priority_rank, created_at);
CREATE INDEX IF NOT EXISTS cases_by_task ON agent_cases(task_id, status);
CREATE INDEX IF NOT EXISTS cases_reviewed ON agent_cases(verdict) WHERE verdict IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES agent_cases(id),
  at INTEGER NOT NULL,
  asked_by TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL                    -- JSON, see Answer
);
CREATE INDEX IF NOT EXISTS messages_by_case ON agent_messages(case_id, id);

-- Owned by the simulated engine. The application never reads it.
-- It stands in for state held by an external service, so it survives app restarts.
CREATE TABLE IF NOT EXISTS engine_jobs (
  request_id TEXT PRIMARY KEY,
  deliver_at INTEGER,                     -- null: this request will never return
  response TEXT,                          -- JSON
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS engine_due
  ON engine_jobs(deliver_at) WHERE delivered_at IS NULL AND deliver_at IS NOT NULL;
`;

/** Review takes none of the holder's time, so it counts as open but not as load. */
const OPEN = `('offered', 'accepted', 'in_progress', 'in_review')`;
const LOADING = `('offered', 'accepted', 'in_progress')`;
const hours = '(SELECT estimate_hours FROM tasks WHERE id = NEW.task_id)';

const WORKLOAD_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS workload_on_insert AFTER INSERT ON assignments BEGIN
  UPDATE contributors SET
    active_count = active_count + (NEW.status IN ${OPEN}),
    load_hours = load_hours + (NEW.status IN ${LOADING}) * ${hours}
  WHERE id = NEW.contributor_id;
END;
CREATE TRIGGER IF NOT EXISTS workload_on_status AFTER UPDATE OF status ON assignments BEGIN
  UPDATE contributors SET
    active_count = active_count + (NEW.status IN ${OPEN}) - (OLD.status IN ${OPEN}),
    load_hours = load_hours + ((NEW.status IN ${LOADING}) - (OLD.status IN ${LOADING})) * ${hours}
  WHERE id = NEW.contributor_id;
END;
`;

const TRIGGERS = ['tasks', 'events', 'contributors', 'projects', 'agent_cases', 'agent_messages', 'work_requests']
  .flatMap((table) =>
    ['INSERT', 'UPDATE'].map(
      (op) => `CREATE TRIGGER IF NOT EXISTS bump_${table}_${op} AFTER ${op} ON ${table}
               BEGIN UPDATE meta SET revision = revision + 1; END;`,
    ),
  )
  .join('\n');

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout first: switching to WAL needs a lock that another instance may hold.
  // synchronous=FULL: a commit is on disk before we acknowledge it to anyone.
  db.exec(
    'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;',
  );
  transaction(db, () => {
    const { user_version: found } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'tasks'`).get() as { n: number };
    if (n > 0 && found !== SCHEMA_VERSION) {
      throw new Error(`${path} was created by an older version. Run "npm run reset" and start again.`);
    }
    db.exec(SCHEMA + TRIGGERS + WORKLOAD_TRIGGERS + `PRAGMA user_version = ${SCHEMA_VERSION};`);
  });
  return db;
}

/**
 * Runs `work` atomically. `work` must be synchronous, so nothing can interleave with it.
 * Nested calls become savepoints: an inner failure undoes only the inner work.
 */
export function transaction<T>(db: DatabaseSync, work: () => T, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE'): T {
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT nested' : `BEGIN ${mode}`);
  try {
    const result = work();
    db.exec(nested ? 'RELEASE nested' : 'COMMIT');
    return result;
  } catch (error) {
    // Some failures (a full disk) make SQLite roll back by itself.
    if (db.isTransaction) db.exec(nested ? 'ROLLBACK TO nested; RELEASE nested' : 'ROLLBACK');
    throw error;
  }
}

const cache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** Compiles each statement once per connection. */
export function statement(db: DatabaseSync, sql: string): StatementSync {
  let statements = cache.get(db);
  if (!statements) cache.set(db, (statements = new Map()));
  let found = statements.get(sql);
  if (!found) statements.set(sql, (found = db.prepare(sql)));
  return found;
}
