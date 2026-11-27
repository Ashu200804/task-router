# Reliability and performance

[← Back to the README](../README.md)

## Guarantees

| Guarantee | Mechanism |
|---|---|
| A confirmed change survives a process crash | Reply only after commit; write-ahead log with `synchronous=FULL` |
| A routing request reaches the engine at least once | Job written in the same transaction as the request |
| An engine answer is processed at least once | Marked delivered only in the transaction that queues it |
| No answer takes effect twice | Job removed with its effect; unique index on assignment per request |
| A repeated client request applies once | Idempotency key stored with the change for 24 hours |
| One active assignee per task | Partial unique index |
| Failing work does not block other work | Savepoint per job, backoff, dead jobs surfaced to operators |

"Exactly once" applies only to effects inside this database.

## Stress and crash testing

```bash
npm run stress
```

```bash
npm run stress -- --tasks 20000 --preload 50000 --instances 3 \
  --creators 200 --operators 100 --responders 60 --kill-every 1000
```

Creators, operators and contributors act at once, some requests are sent repeatedly, and server
processes are killed with `SIGKILL`. Afterwards 23 checks compare the database with what clients
were told: nothing acknowledged is missing or duplicated, no answer applied twice, state agrees
with assignments and requests, stored workloads and records are correct, and no work is stranded.

## Measurements

One laptop (15-core Apple silicon, Node 26), load generator on the same machine. Compare runs;
do not read these as capacity promises. All runs passed all checks.

| Scenario | New tasks/s | p50 | p99 |
|---|---|---|---|
| Default: 3,000 tasks, 2 instances, 140 clients | ~800 | – | – |
| 1 instance, 50k existing, 360 clients | ~730 | ~255ms | ~315ms |
| 3 instances, 50k existing, 360 clients, 27 kills | ~570 | ~100ms | ~2.4s |

```bash
npm run bench
```

| Tasks waiting | Dispatch all | Apply all answers | Longest pause | One list page |
|---|---|---|---|---|
| 1,000 | 0.1s | 0.1s | 30ms | 0.6ms |
| 6,000 | 0.6s | 0.8s | 34ms | 0.5ms |
| 50,000 | 6.0s | 9.2s | 45ms | 1.5ms |

## What the numbers show

- More instances do not raise write throughput, because there is one writer. They give failover
  and worsen the slowest requests while waiting for the write lock.
- The assistant shares the server process. In the three-instance run it wrote about 1,500 cases
  and 4,500 tasks were still waiting when load stopped.
- The stress test gives people unlimited weekly hours; capacity is covered by unit tests.

## Not tested

Power loss or disk failure, several machines, runs longer than a minute, project planning and
reports under load, and the "database busy" retry path. There is no backup or replica, and
history is never archived.
