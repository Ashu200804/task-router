import type { Agent } from './agent/agent.ts';
import type { Requests } from './requests.ts';
import type { TaskService } from './service.ts';

/**
 * Drives background work. All of its state is in the database, so there are no per-request
 * timers to lose. While there is a backlog it runs again at once, yielding to web requests
 * between batches. Returns a function that stops it.
 */
export function startWorker(service: TaskService, agent: Agent, requests: Requests, idleMs = 200): () => void {
  let timer: NodeJS.Timeout;
  const run = () => {
    let more = false;
    try {
      more = service.tick().more;
    } catch (error) {
      console.error('Background batch failed; will retry.', error);
    }
    // Separate, so a fault in the assistant can never hold up routing. It gets a small slice.
    try {
      requests.rehome();
      agent.sweep();
    } catch (error) {
      console.error('Assistant sweep failed; will retry.', error);
    }
    timer = setTimeout(run, more ? 0 : idleMs);
  };
  timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
}
