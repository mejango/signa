import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createPool, PostgresStore } from "../src/db/postgres.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `signa_quota_test_${randomUUID().replaceAll("-", "")}`;
const adminPool = connectionString ? createPool(connectionString) : null;
let pool: Pool;
let store: PostgresStore;

suite("Signa PostgreSQL request budgets", () => {
  beforeAll(async () => {
    await adminPool!.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    store = new PostgresStore(pool);
    await Promise.all([migrate(pool), migrate(pool)]);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool!.end();
  });

  it("serializes concurrent migrations and preserves their journal on rerun", async () => {
    const names = (await readdir(new URL("../src/db/migrations", import.meta.url)))
      .filter(name => name.endsWith(".sql")).sort();
    const applied = async () => (await pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    )).rows.map(row => row.filename);
    expect(await applied()).toEqual(names);
    await migrate(pool);
    expect(await applied()).toEqual(names);
    await expect(store.health()).resolves.toBeUndefined();
  });

  it("shares an atomic request limit across store instances", async () => {
    const other = new PostgresStore(pool);
    const key = `shared:${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? other : store).consumeRequest(key, 10, 3600),
    ));
    expect(results.filter(result => result.allowed)).toHaveLength(10);
    expect(results.every(result => result.remaining >= 0)).toBe(true);
    expect(await other.consumeRequest(key, 10, 3600)).toEqual({ allowed: false, remaining: 0 });
    expect(await store.consumeRequest(`independent:${randomUUID()}`, 10, 3600))
      .toEqual({ allowed: true, remaining: 9 });
  });

  it("starts a new window without carrying the spent window's count", async () => {
    const key = `window:${randomUUID()}`;
    await pool.query(
      `INSERT INTO rate_limits (client_name, window_start, request_count)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / 60) * 60) - interval '1 minute', 20)`,
      [key],
    );
    expect(await store.consumeRequest(key, 10)).toEqual({ allowed: true, remaining: 9 });
  });

  it("cleans old windows without clearing the active quota", async () => {
    const key = `cleanup:${randomUUID()}`;
    await store.consumeRequest(key, 1, 3600);
    await pool.query(
      "INSERT INTO rate_limits (client_name, window_start, request_count) VALUES ($1, now() - interval '3 days', 1)",
      [`stale:${key}`],
    );
    expect(await store.cleanupRateLimits()).toBe(1);
    expect(await store.consumeRequest(key, 1, 3600)).toEqual({ allowed: false, remaining: 0 });
  });
});
