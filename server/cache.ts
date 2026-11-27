/**
 * Many operators ask for the same pages again and again. A response is built once per data
 * version and shared. The version comes from the database, so this stays correct with
 * several instances: a write through any of them invalidates every cache.
 */
export class ReadCache {
  #entries = new Map<string, { version: string; body: string }>();
  #limit: number;

  constructor(limit = 500) {
    this.#limit = limit;
  }

  get(key: string, version: string, load: () => unknown): { body: string; etag: string } {
    let entry = this.#entries.get(key);
    if (entry?.version !== version) entry = { version, body: JSON.stringify(load()) };
    // Re-inserting keeps the map in least-recently-used order.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (this.#entries.size > this.#limit) this.#entries.delete(this.#entries.keys().next().value!);
    return { body: entry.body, etag: `"${entry.version}"` };
  }
}
