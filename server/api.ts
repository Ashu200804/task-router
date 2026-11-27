import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import {
  BRANCHES,
  CONTRIBUTOR_ACTIONS,
  EXPERTISE,
  OPERATOR_ACTIONS,
  PRIORITIES,
  QUEUES,
  REQUEST_TYPES,
  SCENARIOS,
  type ContributorAction,
  type OperatorAction,
  type PlanStep,
} from '../shared/types.ts';
import type { Agent } from './agent/agent.ts';
import { ReadCache } from './cache.ts';
import type { Accounts } from './accounts.ts';
import { AppError, ForbiddenError, InvalidError, NotFoundError, UnauthorizedError } from './errors.ts';
import type { Requests } from './requests.ts';
import type { TaskService } from './service.ts';

const operatorActions = [...new Set(Object.values(OPERATOR_ACTIONS).flat())] as OperatorAction[];
const contributorActions = [...new Set(Object.values(CONTRIBUTOR_ACTIONS).flat())] as ContributorAction[];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

type Body = Record<string, unknown>;

export interface People {
  accounts: Accounts;
  requests: Requests;
}

export function createApp(service: TaskService, staticDir?: string, agent?: Agent, people?: People): Server {
  const cache = new ReadCache();
  // Health changes with time rather than with writes, so it is cached by the second.
  const health = () => cache.get('health', String(Math.floor(Date.now() / 1000)), () => service.health()).body;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/')) await serveStatic(staticDir, res, url.pathname);
      else if (people && (url.pathname === '/api/session' || url.pathname.startsWith('/api/me') || req.headers['x-session'])) {
        await personal(service, people, cache, req, res, url.pathname);
      }
      else if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(health());
      } else if (req.method === 'GET') read(service, agent, cache, req, res, url);
      else await write(service, agent, people?.requests, req, res, url.pathname);
    } catch (error) {
      if (error instanceof AppError) {
        send(res, error.status, { error: { code: error.code, message: error.message } });
      } else if (isBusy(error)) {
        // Another instance held the write lock for too long. Nothing was changed.
        res.setHeader('retry-after', '1');
        send(res, 503, { error: { code: 'busy', message: 'The system is busy. Please try again.' } });
      } else if (isFull(error)) {
        console.error('The database cannot grow: free disk space.', error);
        send(res, 507, { error: { code: 'storage_full', message: 'Storage is full. Your change was not saved.' } });
      } else {
        console.error(error);
        send(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server.' } });
      }
    }
  });
}

/**
 * Everything a signed-in person can reach. A request that carries a session gets these
 * routes and no others, whatever it asks for.
 */
async function personal(
  service: TaskService,
  { accounts, requests }: People,
  cache: ReadCache,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
) {
  if (path === '/api/session' && req.method === 'POST') {
    const { body } = await readJson(req);
    return send(res, 201, accounts.signIn(text(body, 'contributorId', 80, true)));
  }
  const token = req.headers['x-session'];
  if (typeof token !== 'string') throw new UnauthorizedError('Sign in first.');
  const me = accounts.who(token);
  const task = /^\/api\/me\/tasks\/([\w-]+)$/.exec(path);

  if (req.method === 'GET') {
    let load: () => unknown;
    if (path === '/api/me') load = () => accounts.me(me);
    else if (task) load = () => accounts.task(me, task[1]!);
    else throw new ForbiddenError('Signed-in people can only see their own work.');
    // Cached per person: one person's answer must never be served to another.
    // The tag names the person too, or someone switching accounts could be told "unchanged".
    const { body, etag } = cache.get(`${me} ${path}`, `${service.version()}-${me}`, load);
    const headers = { etag, 'x-server-time': String(service.now()), 'cache-control': 'private, no-cache' };
    if (req.headers['if-none-match'] === etag) return void res.writeHead(304, headers).end();
    return void res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(body);
  }

  const { body, raw } = await readJson(req);
  const reason = text(body, 'reason', 500);
  const action = /^\/api\/me\/tasks\/([\w-]+)\/(respond|review|requests)$/.exec(path);
  const decision = /^\/api\/me\/requests\/([\w-]+)\/decide$/.exec(path);
  let status = 200;
  let work: () => unknown;
  if (req.method === 'POST' && path === '/api/me/tasks') {
    status = 201;
    const input = {
      title: text(body, 'title', 120, true),
      description: text(body, 'description', 2000) ?? '',
      expertise: body.expertise === undefined ? undefined : oneOf(body, 'expertise', EXPERTISE),
      priority: oneOf(body, 'priority', PRIORITIES),
      ...requirements(body),
      dueAt: optionalNumber(body, 'dueAt', 0, 8.6e15) ?? null,
      scenario: body.scenario === undefined ? undefined : oneOf(body, 'scenario', SCENARIOS),
    };
    work = () => accounts.raise(me, input);
  } else if (req.method === 'POST' && decision) {
    const choice = oneOf(body, 'decision', ['approve', 'decline', 'answer'] as const);
    const reply = text(body, 'text', 500);
    work = () => requests.decide(decision[1]!, me, choice, reply);
  } else if (req.method === 'POST' && action) {
    const [, id, kind] = action as unknown as [string, string, string];
    if (kind === 'respond') {
      const response = {
        action: oneOf(body, 'action', contributorActions),
        assignmentId: text(body, 'assignmentId', 80, true),
        reason,
        percent: optionalNumber(body, 'percent', 0, 100, true),
        hours: optionalNumber(body, 'hours', 0, 1000),
        link: webLink(body, 'link'),
      };
      work = () => accounts.respond(me, id, response);
    } else if (kind === 'review') {
      if (!Number.isInteger(body.expectedVersion)) throw new InvalidError('expectedVersion is required.');
      const input = {
        decision: oneOf(body, 'decision', ['approve', 'changes'] as const),
        rating: optionalNumber(body, 'rating', 1, 5, true),
        feedback: text(body, 'feedback', 500),
        expectedVersion: body.expectedVersion as number,
      };
      work = () => accounts.review(me, id, input);
    } else {
      status = 201;
      const input = {
        type: oneOf(body, 'type', REQUEST_TYPES),
        text: text(body, 'text', 500, true),
        days: optionalNumber(body, 'days', 1, 30, true),
        scenario: body.scenario === undefined ? undefined : oneOf(body, 'scenario', SCENARIOS),
      };
      work = () => requests.create(id, me, input);
    }
  } else {
    throw new ForbiddenError('Signed-in people cannot do that.');
  }
  // Keys are scoped to the person, so nobody can replay someone else's answer.
  const key = idempotencyKey(req);
  const fingerprint = createHash('sha256').update(`${me} ${req.method} ${path}\n${raw}`).digest('hex');
  const { result } = service.idempotent(key && `${me}:${key}`, fingerprint, work);
  send(res, status, result);
}

function idempotencyKey(req: IncomingMessage): string | undefined {
  const key = req.headers['idempotency-key'] as string | undefined;
  if (key !== undefined && !/^[\w-]{8,100}$/.test(key)) {
    throw new InvalidError('Idempotency-Key must be 8 to 100 letters, digits, dashes or underscores.');
  }
  return key;
}

/** SQLITE_BUSY or SQLITE_LOCKED. */
const isBusy = (error: unknown) => [5, 6].includes((error as { errcode?: number })?.errcode ?? -1);

/** SQLITE_FULL. */
const isFull = (error: unknown) => (error as { errcode?: number })?.errcode === 13;

function read(service: TaskService, agent: Agent | undefined, cache: ReadCache, req: IncomingMessage, res: ServerResponse, url: URL) {
  const caseId = /^\/api\/cases\/([\w-]+)$/.exec(url.pathname);
  const task = /^\/api\/tasks\/([\w-]+)$/.exec(url.pathname);
  const candidates = /^\/api\/tasks\/([\w-]+)\/candidates$/.exec(url.pathname);
  const project = /^\/api\/projects\/([\w-]+)$/.exec(url.pathname);
  const person = /^\/api\/contributors\/([\w-]+)$/.exec(url.pathname);
  let load: () => unknown;
  if (url.pathname === '/api/tasks') {
    const query = Object.fromEntries(url.searchParams) as Body;
    const page = Number(query.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 1_000_000) {
      throw new InvalidError('page must be a positive integer.');
    }
    const filters = {
      page,
      branch: query.branch === undefined ? undefined : oneOf(query, 'branch', BRANCHES),
      queue: query.queue === undefined ? undefined : oneOf(query, 'queue', QUEUES),
      search: text(query, 'q', 100),
    };
    load = () => service.list(filters);
  } else if (url.pathname === '/api/contributors') {
    load = () => service.contributors();
  } else if (agent && url.pathname === '/api/cases') {
    const query = Object.fromEntries(url.searchParams) as Body;
    const filter = {
      status: query.status === undefined ? undefined : oneOf(query, 'status', ['open', 'closed'] as const),
      taskId: text(query, 'taskId', 40),
    };
    load = () => agent.list(filter);
  } else if (agent && caseId) {
    load = () => agent.get(caseId[1]!);
  } else if (url.pathname === '/api/projects') {
    load = () => service.projects();
  } else if (project) {
    load = () => service.project(project[1]!);
  } else if (person) {
    load = () => service.person(person[1]!);
  } else if (candidates) {
    load = () => service.candidates(candidates[1]!);
  } else if (task) {
    load = () => service.detail(task[1]!);
  } else {
    throw new NotFoundError('No such endpoint.');
  }

  const { body, etag } = cache.get(url.pathname + url.search, service.version(), load);
  // A 304 has no body, so the clock travels in a header.
  const headers = { etag, 'x-server-time': String(service.now()), 'cache-control': 'no-cache' };
  if (req.headers['if-none-match'] === etag) return void res.writeHead(304, headers).end();
  res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(body);
}

async function write(service: TaskService, agent: Agent | undefined, requests: Requests | undefined, req: IncomingMessage, res: ServerResponse, path: string) {
  const { body, raw } = await readJson(req);
  // A preview changes nothing, so it needs no idempotency.
  if (path === '/api/plans') {
    const steps = body.steps === undefined ? undefined : planSteps(body.steps);
    return send(res, 200, service.plan({ ...projectBrief(body), steps }));
  }
  const operator = operatorName(req);
  // Asking changes nothing but the case's own notes, and may wait on a model, so it runs apart.
  const ask = /^\/api\/cases\/([\w-]+)\/ask$/.exec(path);
  if (ask && agent && req.method === 'POST') {
    return send(res, 200, await agent.ask(ask[1]!, text(body, 'question', 500, true), operator));
  }
  const key = idempotencyKey(req);
  const fingerprint = createHash('sha256').update(`${req.method} ${path}\n${raw}`).digest('hex');
  const { status, work } = route(service, agent, requests, req.method ?? '', path, body, operator);
  const { result, replayed } = service.idempotent(key, fingerprint, work);
  if (replayed) res.setHeader('idempotent-replay', 'true');
  send(res, status, result);
}

/** Validates the input and returns the change to make. */
function route(
  service: TaskService,
  agent: Agent | undefined,
  requests: Requests | undefined,
  method: string,
  path: string,
  body: Body,
  operator: string | undefined,
): { status: number; work: () => unknown } {
  if (method !== 'POST') throw new NotFoundError('No such endpoint.');
  const scenario = body.scenario === undefined ? undefined : oneOf(body, 'scenario', SCENARIOS);

  if (path === '/api/tasks') {
    const input = {
      title: text(body, 'title', 120, true),
      description: text(body, 'description', 2000) ?? '',
      expertise: oneOf(body, 'expertise', EXPERTISE),
      branch: oneOf(body, 'branch', BRANCHES),
      priority: oneOf(body, 'priority', PRIORITIES),
      submit: body.submit === true,
      scenario,
      requirements: requirements(body),
      dueAt: optionalNumber(body, 'dueAt', 0, 8.6e15),
    };
    return { status: 201, work: () => service.createTask(input, operator) };
  }

  const workRequest = /^\/api\/requests\/([\w-]+)\/decide$/.exec(path);
  if (workRequest && requests) {
    const choice = oneOf(body, 'decision', ['approve', 'decline', 'answer'] as const);
    const reply = text(body, 'text', 500);
    return { status: 200, work: () => requests.decide(workRequest[1]!, null, choice, reply, operator) };
  }

  const decision = /^\/api\/cases\/([\w-]+)\/(apply|review)$/.exec(path);
  if (decision && agent) {
    const [, id, kind] = decision as unknown as [string, string, string];
    if (kind === 'apply') {
      const optionId = text(body, 'optionId', 20, true);
      const reason = text(body, 'reason', 500);
      return { status: 200, work: () => agent.apply(id, optionId, reason, operator) };
    }
    const verdict = oneOf(body, 'verdict', ['correct', 'wrong'] as const);
    const note = text(body, 'note', 1000);
    return { status: 200, work: () => agent.review(id, verdict, note, body.dismiss === true, operator) };
  }

  if (path === '/api/projects') {
    const steps = planSteps(body.steps);
    if (!steps.length) throw new InvalidError('A project needs at least one step.');
    const input = { ...projectBrief(body), steps };
    return { status: 201, work: () => service.createProject(input, operator) };
  }

  const release = /^\/api\/projects\/([\w-]+)\/release$/.exec(path);
  if (release) {
    return { status: 200, work: () => service.releaseReady(release[1]!, operator, scenario) };
  }

  const availability = /^\/api\/contributors\/([\w-]+)\/availability$/.exec(path);
  if (availability) {
    if (typeof body.available !== 'boolean') throw new InvalidError('available must be true or false.');
    const available = body.available;
    const reason = text(body, 'reason', 500);
    return { status: 200, work: () => service.setAvailability(availability[1]!, available, reason, operator) };
  }

  const match = /^\/api\/tasks\/([\w-]+)\/(commands|responses)$/.exec(path);
  if (!match) throw new NotFoundError('No such endpoint.');
  const [, id, kind] = match as unknown as [string, string, string];
  const reason = text(body, 'reason', 500);

  if (kind === 'commands') {
    if (!Number.isInteger(body.expectedVersion)) throw new InvalidError('expectedVersion is required.');
    const command = {
      action: oneOf(body, 'action', operatorActions),
      expectedVersion: body.expectedVersion as number,
      contributorId: text(body, 'contributorId', 80),
      reason,
      scenario,
      rating: optionalNumber(body, 'rating', 1, 5, true),
    };
    return { status: 200, work: () => service.command(id, command, operator) };
  }
  const response = {
    action: oneOf(body, 'action', contributorActions),
    assignmentId: text(body, 'assignmentId', 80, true),
    reason,
    percent: optionalNumber(body, 'percent', 0, 100, true),
    hours: optionalNumber(body, 'hours', 0, 1000),
    link: webLink(body, 'link'),
  };
  return { status: 200, work: () => service.respond(id, response) };
}

function optionalNumber(body: Body, key: string, min: number, max: number, whole = false): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !(value >= min && value <= max) || (whole && !Number.isInteger(value))) {
    throw new InvalidError(`${key} must be a ${whole ? 'whole ' : ''}number from ${min} to ${max}.`);
  }
  return value;
}

/** Only web addresses: a submitted link is shown to other people and must be safe to click. */
function webLink(body: Body, key: string): string | undefined {
  const value = text(body, key, 500);
  if (value !== undefined && !/^https?:\/\//i.test(value)) throw new InvalidError(`${key} must start with http:// or https://.`);
  return value;
}

function textList(body: Body, key: string): string[] {
  const value = body[key] ?? [];
  if (!Array.isArray(value) || value.length > 20 || value.some((v) => typeof v !== 'string' || v.length > 60)) {
    throw new InvalidError(`${key} must be a list of short text values.`);
  }
  return value as string[];
}

function requirements(body: Body) {
  return {
    minLevel: optionalNumber(body, 'minLevel', 1, 5, true) ?? 1,
    certification: text(body, 'certification', 60) ?? null,
    skills: textList(body, 'skills'),
    estimateHours: optionalNumber(body, 'estimateHours', 0.5, 400) ?? 4,
  };
}

function projectBrief(body: Body) {
  return {
    name: text(body, 'name', 120, true),
    goal: text(body, 'goal', 2000) ?? '',
    branch: oneOf(body, 'branch', BRANCHES),
    priority: oneOf(body, 'priority', PRIORITIES),
    dueAt: optionalNumber(body, 'dueAt', 0, 8.6e15) ?? null,
  };
}

function planSteps(value: unknown): PlanStep[] {
  if (!Array.isArray(value) || value.length > 20) throw new InvalidError('steps must be a list of at most 20 items.');
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new InvalidError('Each step must be an object.');
    const step = item as Body;
    return {
      key: text(step, 'key', 20, true),
      title: text(step, 'title', 120, true),
      description: text(step, 'description', 2000) ?? '',
      expertise: oneOf(step, 'expertise', EXPERTISE),
      ...requirements(step),
      dependsOn: textList(step, 'dependsOn'),
      reason: text(step, 'reason', 300) ?? '',
    };
  });
}

/** Who says they are acting. Recorded in history, not verified. */
function operatorName(req: IncomingMessage): string | undefined {
  const header = req.headers['x-operator'];
  if (typeof header !== 'string') return undefined;
  try {
    // Percent-encoded so that any name fits in a header.
    return decodeURIComponent(header).trim().slice(0, 60) || undefined;
  } catch {
    throw new InvalidError('X-Operator is not valid percent-encoding.');
  }
}

async function readJson(req: IncomingMessage): Promise<{ body: Body; raw: string }> {
  // Requiring this header also means another website cannot post here without a CORS preflight.
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new InvalidError('Send JSON with a Content-Type of application/json.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 100_000) throw new InvalidError('Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new InvalidError('Request body is not valid JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidError('Request body must be a JSON object.');
  }
  return { body: body as Body, raw };
}

function text(body: Body, key: string, max: number, required: true): string;
function text(body: Body, key: string, max: number, required?: false): string | undefined;
function text(body: Body, key: string, max: number, required = false): string | undefined {
  const value = body[key] ?? undefined; // null means "not given"
  if (value !== undefined && typeof value !== 'string') throw new InvalidError(`${key} must be text.`);
  const trimmed = value?.trim();
  if (!trimmed) {
    if (required) throw new InvalidError(`${key} is required.`);
    return undefined;
  }
  if (trimmed.length > max) throw new InvalidError(`${key} must be at most ${max} characters.`);
  return trimmed;
}

function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[]): T {
  const value = body[key];
  if (!allowed.includes(value as T)) throw new InvalidError(`${key} must be one of: ${allowed.join(', ')}.`);
  return value as T;
}

async function serveStatic(dir: string | undefined, res: ServerResponse, pathname: string) {
  if (!dir) throw new NotFoundError('No web build is being served.');
  const root = resolve(dir);
  const file = join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + sep)) throw new NotFoundError('Not found.');
  const content = await readFile(file).catch(() => {
    throw new NotFoundError('Not found.');
  });
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(content);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}
