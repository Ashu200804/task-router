/** Types and rules shared by the server and the web console. */

export const EXPERTISE = ['finance', 'healthcare', 'data analysis', 'operations', 'legal'] as const;
export type Expertise = (typeof EXPERTISE)[number];

export const BRANCHES = ['London', 'New York', 'Singapore', 'Bengaluru'] as const;
export type Branch = (typeof BRANCHES)[number];

export const QUEUES = ['attention', 'routing', 'assigned', 'draft', 'closed'] as const;
export type Queue = (typeof QUEUES)[number];

/** The team in each branch that owns work needing a given expertise. */
export const DEPARTMENTS: Record<Expertise, string> = {
  finance: 'Finance',
  healthcare: 'Clinical',
  'data analysis': 'Data',
  operations: 'Operations',
  legal: 'Legal',
};

export const SENIORITIES = ['junior', 'mid', 'senior', 'principal'] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export type TaskStatus =
  | 'draft'
  | 'routing'
  | 'needs_attention'
  | 'offered'
  | 'accepted'
  | 'in_progress'
  | 'in_review'
  | 'completed'
  | 'cancelled';

export type AttentionReason =
  | 'no_match'
  | 'declined'
  | 'failed'
  | 'routing_stopped'
  | 'withdrawn'
  | 'contributor_unavailable'
  | 'over_capacity'
  | 'routing_error';

export type AssignmentStatus =
  | 'offered'
  | 'accepted'
  | 'in_progress'
  | 'in_review'
  | 'completed'
  | 'declined'
  | 'failed'
  | 'revoked';

/** Simulation control: forces how the simulated engine behaves for one routing attempt. */
export const SCENARIOS = ['random', 'match', 'no_match', 'slow', 'never'] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Commands issued by the operator. Guarded by the task version the operator was looking at. */
export type OperatorAction =
  | 'submit'
  | 'reroute'
  | 'stop_routing'
  | 'assign'
  | 'withdraw'
  | 'cancel'
  | 'approve'
  | 'request_changes'
  | 'unblock';
/** Simulated contributor responses. Guarded by the assignment they refer to. */
export type ContributorAction = 'accept' | 'decline' | 'start' | 'update' | 'block' | 'submit_work' | 'fail';
export type Action = OperatorAction | ContributorAction;

export const OPERATOR_ACTIONS: Record<TaskStatus, OperatorAction[]> = {
  draft: ['submit', 'assign', 'cancel'],
  routing: ['reroute', 'stop_routing', 'assign', 'cancel'],
  needs_attention: ['reroute', 'assign', 'cancel'],
  offered: ['reroute', 'assign', 'withdraw', 'cancel'],
  // Acceptance completes routing. To route again the operator must first withdraw, on purpose.
  accepted: ['unblock', 'assign', 'withdraw', 'cancel'],
  in_progress: ['unblock', 'assign', 'withdraw', 'cancel'],
  in_review: ['approve', 'request_changes', 'assign', 'withdraw', 'cancel'],
  completed: [],
  cancelled: [],
};

export const CONTRIBUTOR_ACTIONS: Record<TaskStatus, ContributorAction[]> = {
  draft: [],
  routing: [],
  needs_attention: [],
  offered: ['accept', 'decline'],
  accepted: ['start', 'block', 'fail'],
  in_progress: ['update', 'submit_work', 'block', 'fail'],
  in_review: [],
  completed: [],
  cancelled: [],
};

/** The parts of a person that matter when deciding whether to give them work. */
export interface Profile {
  title: string;
  team: string;
  seniority: Seniority;
  lead: boolean;
  /** Proficiency from 1 (learning) to 5 (expert) in each expertise they list. */
  levels: Partial<Record<Expertise, number>>;
  skills: string[];
  certifications: string[];
  languages: string[];
  weeklyHours: number;
  joined: string;
}

/** Counts of outcomes. Rates are derived, so small samples can be treated with care. */
export interface WorkRecord {
  accepted: number;
  declined: number;
  failed: number;
  completed: number;
  onTime: number;
  firstPass: number;
  ratingSum: number;
  ratingCount: number;
  responses: number;
  responseMs: number;
}

/** What a task asks of whoever takes it. */
export interface Requirements {
  minLevel: number;
  certification: string | null;
  skills: string[];
  estimateHours: number;
}

export interface ScoreFactor {
  factor: 'Skill fit' | 'Quality' | 'Reliability' | 'Capacity' | 'Responsiveness';
  points: number;
  max: number;
  note: string;
}

export type BlockerCode =
  | 'unavailable'
  | 'branch'
  | 'expertise'
  | 'level'
  | 'certification'
  | 'capacity'
  | 'history'
  | 'requester';

export interface Candidate {
  contributorId: string;
  name: string;
  title: string;
  branch: Branch;
  /** Reasons routing will not pick them. Empty means eligible. */
  blockers: string[];
  /** The same reasons as `blockers`, in the same order, for code to act on. */
  codes: BlockerCode[];
  /** Levels short of the minimum, when the expertise is listed. */
  levelGap: number;
  score: number;
  factors: ScoreFactor[];
  /** Too little history for the rates to mean much. */
  lowData: boolean;
  loadHours: number;
  weeklyHours: number;
}

export interface Contributor {
  id: string;
  name: string;
  branch: Branch;
  available: boolean;
  expertise: Expertise[];
  activeCount: number;
  profile: Profile;
  record: WorkRecord;
  /** Estimated hours of unfinished work they hold. */
  loadHours: number;
}

export interface Assignee {
  assignmentId: string;
  contributorId: string;
  name: string;
  status: AssignmentStatus;
  since: number;
}

export interface TaskSummary {
  id: string;
  title: string;
  description: string;
  expertise: Expertise;
  branch: Branch;
  priority: Priority;
  status: TaskStatus;
  /** Which operator list the task is in. Decided by the server. */
  queue: Queue;
  attentionReason: AttentionReason | null;
  version: number;
  createdAt: number;
  statusSince: number;
  assignee: Assignee | null;
  /** Present only while status is "routing". `sentAt` is null while still in our own queue. */
  pendingRequest: { attempt: number; requestedAt: number; sentAt: number | null } | null;
  /** Set once a pending request has waited longer than the engine's normal window. */
  overdueSince: number | null;
  /** The current holder has been marked unavailable. */
  assigneeUnavailable: boolean;
  routingAttempts: number;
  /** The person who raised it from their own account, if anyone. */
  requester: { id: string; name: string } | null;
  projectId: string | null;
  requirements: Requirements;
  dueAt: number | null;
  /** Percent, as last reported by the holder. */
  progress: number;
  blocker: string | null;
  /** Set when accepted work has had no report for too long. */
  quietSince: number | null;
  pastDueSince: number | null;
  /** Unfinished tasks this one depends on. */
  waitingOn: string[];
  lastActivityAt: number;
}

export type RequestState = 'pending' | 'matched' | 'no_match' | 'superseded' | 'failed';

export interface RoutingAttempt {
  id: string;
  attempt: number;
  state: RequestState;
  requestedAt: number;
  closedAt: number | null;
  closedReason: string | null;
  /** Filled when the engine answered, whether or not the answer was used. */
  returnedAt: number | null;
  returnedContributorName: string | null;
}

export interface AssignmentRecord {
  id: string;
  contributorName: string;
  status: AssignmentStatus;
  source: 'routing' | 'operator';
  createdAt: number;
  endedAt: number | null;
  endReason: string | null;
}

export type Actor = 'operator' | 'engine' | 'contributor' | 'system';

export interface TaskEvent {
  id: number;
  at: number;
  actor: Actor;
  /** Self-declared operator name. Not authenticated. */
  actorName: string | null;
  type: string;
  summary: string;
  note: string | null;
}

export interface ProgressUpdate {
  id: number;
  at: number;
  contributorName: string;
  kind: 'progress' | 'blocker';
  note: string;
  percent: number | null;
  hours: number | null;
}

export interface Submission {
  id: number;
  at: number;
  contributorName: string;
  summary: string;
  link: string | null;
  decision: 'approved' | 'changes_requested' | null;
  feedback: string | null;
  rating: number | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
}

export const REQUEST_TYPES = ['status', 'question', 'help', 'extension', 'handover', 'cancel'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** open: waiting for a person. delegated: a helper task is doing it. Everything else is final. */
export type WorkRequestStatus = 'open' | 'delegated' | 'resolved' | 'approved' | 'declined' | 'closed';

export interface WorkRequest {
  id: string;
  taskId: string;
  taskTitle: string;
  type: RequestType;
  text: string;
  /** Extra days asked for, on extensions. */
  days: number | null;
  from: { id: string; name: string };
  /** Who has to act. Null with status "open" means the operator console. */
  handler: { id: string; name: string } | null;
  status: WorkRequestStatus;
  /** Why the system handled it the way it did. */
  routing: string;
  response: string | null;
  /** Who the system suggests taking over, on handovers. */
  suggestion: { id: string; name: string; score: number } | null;
  helperTaskId: string | null;
  createdAt: number;
  closedAt: number | null;
}

export interface MeView {
  person: Contributor;
  /** Offers and work assigned to me. */
  work: TaskSummary[];
  /** Tasks I raised, newest first. */
  raised: TaskSummary[];
  /** Requests waiting for my decision. */
  inbox: WorkRequest[];
  /** Requests I made, newest first. */
  sent: WorkRequest[];
}

export interface MyTask {
  detail: TaskDetail;
  requests: WorkRequest[];
  /** What I am to this task, which decides what I may do. */
  roles: { holder: boolean; requester: boolean };
}

export interface TaskDetail {
  requests: WorkRequest[];
  task: TaskSummary;
  updates: ProgressUpdate[];
  submissions: Submission[];
  dependencies: { id: string; title: string; status: TaskStatus }[];
  events: TaskEvent[];
  attempts: RoutingAttempt[];
  assignments: AssignmentRecord[];
  /** Contributors that routing will not pick again for this task, and why. */
  excluded: { contributorId: string; name: string; reason: string }[];
}

export interface TaskPage {
  tasks: TaskSummary[];
  /** Tasks matching the current queue filter, across all pages. */
  total: number;
  page: number;
  pageSize: number;
  /** Per queue, within the branch and search filters. */
  counts: Record<Queue, number>;
}

export interface Health {
  queuedJobs: number;
  oldestJobAgeMs: number;
  /** Work that was retried until we gave up. Needs a human to look at the logs. */
  deadJobs: number;
}

export interface ActivityItem {
  id: number;
  at: number;
  taskId: string;
  taskTitle: string;
  actor: string;
  summary: string;
}

export interface PersonDetail {
  person: Contributor;
  lead: string | null;
  tasks: TaskSummary[];
  activity: ActivityItem[];
}

export interface PlanStep {
  key: string;
  title: string;
  description: string;
  expertise: Expertise;
  minLevel: number;
  certification: string | null;
  skills: string[];
  estimateHours: number;
  dependsOn: string[];
  /** Why the splitter proposed this step. */
  reason: string;
}

export interface PlannedStep extends PlanStep {
  team: string;
  /** People in the branch who could take it right now, best first. */
  candidates: Candidate[];
}

export interface Plan {
  steps: PlannedStep[];
  warnings: string[];
}

export type ProjectHealth = 'on_track' | 'at_risk' | 'off_track' | 'complete';

export interface ProjectSummary {
  id: string;
  name: string;
  goal: string;
  branch: Branch;
  owner: string | null;
  priority: Priority;
  createdAt: number;
  dueAt: number | null;
  health: ProjectHealth;
  taskCount: number;
  doneCount: number;
  totalHours: number;
  /** Finished hours, counting partial progress reported by holders. */
  earnedHours: number;
  riskCount: number;
}

export interface Risk {
  taskId: string | null;
  severity: 'high' | 'medium';
  text: string;
}

export interface ProjectReport {
  project: ProjectSummary;
  tasks: TaskSummary[];
  risks: Risk[];
  activity: ActivityItem[];
  team: { id: string; name: string; title: string; taskCount: number; loadHours: number; weeklyHours: number }[];
  /** Tasks whose dependencies are met and which have not been released to routing. */
  ready: string[];
  /** Hours on the longest unfinished chain of dependent tasks. */
  criticalPathHours: number;
}

/** Why the assistant opened a case. */
export type Trigger =
  | AttentionReason
  | 'routing_overdue'
  | 'blocked'
  | 'holder_unavailable'
  | 'past_due'
  | 'no_report';

/** 'recorded': read from the data. 'inferred': a stated rule applied to it. 'unknown': cannot be known. */
export type Certainty = 'recorded' | 'inferred' | 'unknown';

export interface Evidence {
  id: string;
  tool: string;
  fact: string;
}

export interface Finding {
  text: string;
  certainty: Certainty;
  evidence: string[];
}

export interface CaseOption {
  id: string;
  label: string;
  /** Absent when it is something a person has to do outside the system. */
  command?: { action: OperatorAction; contributorId?: string; reason: string };
  /** Requirements this option sets aside. Empty for options that bend no rule. */
  relaxes: string[];
  tradeoff: string;
  recommended: boolean;
}

export interface CaseReport {
  headline: string;
  findings: Finding[];
  evidence: Evidence[];
  options: CaseOption[];
  /** A message the operator can copy to the person who needs to act. */
  draftMessage: string | null;
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  ms: number;
  error?: string;
}

export type CaseStatus = 'open' | 'resolved' | 'dismissed' | 'superseded';
export type Verdict = 'correct' | 'wrong';

export interface CaseSummary {
  id: string;
  taskId: string;
  taskTitle: string;
  branch: Branch;
  priority: Priority;
  trigger: Trigger;
  status: CaseStatus;
  headline: string;
  createdAt: number;
  /** The investigation itself broke; the report says how. */
  failed: boolean;
  verdict: Verdict | null;
}

export interface Answer {
  text: string;
  source: 'rules' | 'model';
  /** Why the model's answer was not used, when it was meant to be. */
  note: string | null;
  evidence: Evidence[];
}

export interface CaseDetail extends CaseSummary {
  taskVersion: number;
  report: CaseReport;
  trace: ToolCall[];
  chosenOption: string | null;
  resolvedBy: string | null;
  closedAt: number | null;
  verdictNote: string | null;
  verdictBy: string | null;
  messages: { id: number; at: number; askedBy: string | null; question: string; answer: Answer }[];
}

export interface CaseList {
  cases: CaseSummary[];
  open: number;
  /** Tasks flagged but not yet investigated. */
  waiting: number;
  reviewed: { correct: number; wrong: number };
  /** Whether questions go to a language model, or are answered by rules alone. */
  modelEnabled: boolean;
}
