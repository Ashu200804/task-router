# HTTP API

[← Back to the README](../README.md)

JSON over HTTP on localhost. Writes require `Content-Type: application/json`.

## Headers

| Header | Direction | Meaning |
|---|---|---|
| `Idempotency-Key` | request | 8–100 letters, digits, `-` or `_`. Repeating a write with the same key returns the first result |
| `X-Operator` | request | Operator name for history, percent-encoded. Unverified |
| `X-Session` | request | Development session. Limits the caller to the signed-in routes |
| `ETag`, `If-None-Match` | both | Unchanged reads return `304` |
| `X-Server-Time` | response | Server clock in milliseconds |
| `Idempotent-Replay` | response | The result came from an earlier identical write |

## Operator routes

| Method and path | Purpose |
|---|---|
| `GET /api/tasks?branch&queue&q&page` | A page of tasks with queue counts |
| `POST /api/tasks` | Create, optionally submitting for routing |
| `GET /api/tasks/:id` | Task, history, attempts, assignments, work and requests |
| `GET /api/tasks/:id/candidates` | Ranked people with reasons |
| `POST /api/tasks/:id/commands` | `submit`, `reroute`, `stop_routing`, `assign`, `withdraw`, `cancel`, `approve`, `request_changes`, `unblock`. Requires `expectedVersion` |
| `POST /api/tasks/:id/responses` | Simulated contributor reply: `accept`, `decline`, `start`, `update`, `block`, `submit_work`, `fail`. Requires `assignmentId` |
| `GET /api/contributors`, `GET /api/contributors/:id` | People, profiles and activity |
| `POST /api/contributors/:id/availability` | Mark away or available |
| `POST /api/plans` | Propose or re-check a plan. Saves nothing |
| `GET /api/projects`, `GET /api/projects/:id` | Project summaries and report |
| `POST /api/projects` | Create a project from a plan |
| `POST /api/projects/:id/release` | Route every task that is ready |
| `GET /api/cases?status&taskId`, `GET /api/cases/:id` | Assistant cases |
| `POST /api/cases/:id/apply` | Run an approved option |
| `POST /api/cases/:id/review` | Record whether the diagnosis was right |
| `POST /api/cases/:id/ask` | Ask about a case |
| `POST /api/requests/:id/decide` | Operator decision on a request |
| `GET /api/health` | Queue depth, age and failed jobs |

## Signed-in routes

| Method and path | Purpose |
|---|---|
| `POST /api/session` | Start a development session for a contributor |
| `GET /api/me` | Own work, raised tasks, inbox and requests |
| `POST /api/me/tasks` | Raise a task |
| `GET /api/me/tasks/:id` | A task the person is involved in |
| `POST /api/me/tasks/:id/respond` | Respond to an own assignment |
| `POST /api/me/tasks/:id/review` | Review work they asked for |
| `POST /api/me/tasks/:id/requests` | `status`, `question`, `help`, `extension`, `handover`, `cancel` |
| `POST /api/me/requests/:id/decide` | `approve`, `decline` or `answer` |

## Errors

`{ "error": { "code": "...", "message": "..." } }`

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid` | The input or action is not acceptable |
| 401 | `unauthorized` | Session missing or expired |
| 403 | `forbidden` | Not this person's to see or do |
| 404 | `not_found` | No such thing |
| 409 | `stale` | Things changed; read again |
| 422 | `key_reused` | Idempotency key used for a different request |
| 503 | `busy` | Retry with the same key |
| 507 | `storage_full` | Nothing was saved |
