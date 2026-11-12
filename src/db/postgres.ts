import { Pool } from "pg";
import type { Store } from "../store.js";

export function createPool(connectionString: string): Pool & { connectsSinceLast(): number } {
  const pool = new Pool({
    connectionString,
    max: 10,
    // pg closes an idle connection after 10 s by default, so the first requests of a payment after
    // any quiet each opened a fresh one (TCP, SCRAM, backend start: tens of ms per acquisition,
    // several per admission). Kept connections cost nothing while the pool is under its maximum.
    idleTimeoutMillis: 600_000,
    // A kept socket whose peer went away silently would otherwise fail the next request instead of
    // being dropped while idle.
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    idle_in_transaction_session_timeout: 10_000,
  });
  // A connection the server terminates (idle-in-transaction timeout, restart) emits "error" on
  // the client that holds it. Without a listener that is an uncaught exception and the whole
  // process dies; with one, the query in flight rejects and the caller reports it.
  const report = (source: string) => () =>
    console.error(JSON.stringify({ level: "error", service: "db", code: "PG_CONNECTION_ERROR", source }));
  let connects = 0;
  pool.on("error", report("idle"));
  pool.on("connect", (client) => { client.on("error", report("client")); connects += 1; });
  // Connections opened since the last call, for the maintenance tick's db_pool line.
  return Object.assign(pool, { connectsSinceLast: () => { const n = connects; connects = 0; return n; } });
}

export class PostgresStore implements Store {
  constructor(readonly pool: Pool) {}

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async consumeRequest(
    client: string,
    limit: number,
    windowSeconds = 60,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const result = await this.pool.query<{ request_count: number }>(
      `INSERT INTO rate_limits (client_name, window_start, request_count)
       VALUES (
         $1,
         to_timestamp(floor(extract(epoch FROM now()) / $2) * $2),
         1
       )
       ON CONFLICT (client_name, window_start)
       DO UPDATE SET request_count = rate_limits.request_count + 1
       RETURNING request_count`,
      [client, windowSeconds],
    );
    const count = result.rows[0]!.request_count;
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  }

  /** Drops spent rate-limit windows; runs on the maintenance tick, not in front of every request. */
  async cleanupRateLimits(): Promise<number> {
    const result = await this.pool.query("DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'");
    return result.rowCount ?? 0;
  }
}
