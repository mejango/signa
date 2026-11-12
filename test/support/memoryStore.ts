import type { Store } from "../../src/store.js";

export class MemoryStore implements Store {
  async cleanupRateLimits() { return 0; }
  requests = new Map<string, number>();

  async health() {}

  async consumeRequest(client: string, limit: number, _windowSeconds?: number) {
    const count = (this.requests.get(client) ?? 0) + 1;
    this.requests.set(client, count);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  }
}
