import { existsSync } from 'node:fs';
import { Agent } from './agent/agent.ts';
import { connectModel } from './agent/model.ts';
import { Accounts } from './accounts.ts';
import { createApp } from './api.ts';
import { DB_PATH, DIST_DIR, PORT, TIME_SCALE } from './config.ts';
import { openDatabase } from './db.ts';
import { RoutingEngine } from './engine.ts';
import { Requests } from './requests.ts';
import { OVERDUE_AFTER_MS, TaskService } from './service.ts';
import { startWorker } from './worker.ts';

const db = openDatabase(DB_PATH);
const service = new TaskService(db, new RoutingEngine(db, Math.random, TIME_SCALE), {
  overdueAfterMs: OVERDUE_AFTER_MS * TIME_SCALE,
});
// Off by default: using a model sends task data to an outside service.
const model = process.env.ASSISTANT_MODEL === 'on' ? await connectModel() : null;
const agent = new Agent(db, service, model);
const requests = new Requests(db, service);
const server = createApp(service, existsSync(DIST_DIR) ? DIST_DIR : undefined, agent, {
  requests,
  accounts: new Accounts(db, service, requests),
});
let stopWorker = () => {};

// A longer backlog absorbs bursts of new connections (the OS may cap it lower).
server.listen({ port: PORT, host: '127.0.0.1', backlog: 2048 }, () => {
  console.log(`Task router listening on http://127.0.0.1:${PORT}`);
  if (!service.contributors().length) console.log('No contributors yet. Add them with: npm run import -- <file.json>');
  stopWorker = startWorker(service, agent, requests);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Finish requests already in progress. Anything unfinished is safe in the database.
    stopWorker();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
