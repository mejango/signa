import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSponsorCapStore } from "../src/rest/sponsorCaps.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeIf = connectionString ? describe : describe.skip;

describeIf("sponsor caps against real PostgreSQL", () => {
  const schema = `rest_sponsor_caps_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
    await pool.query(await readFile(new URL("../src/db/migrations/066_sponsor_caps.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
  const expiresAt = () => Date.now() + 300_000;

  it("concurrent reservations never exceed the cap", async () => {
    // Two stores over one table stand for two replicas.
    const policies = [{ chainId: 8453, accountDailyWei: 10n, paused: false }];
    const stores = [new PostgresSponsorCapStore(pool, policies), new PostgresSponsorCapStore(pool, policies)];
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => stores[index % 2]!.reserve({
      chainId: 8453, accountId: "eip155:8453:0x1111111111111111111111111111111111111111", operationId: `concurrent-${index}`, reservationWei: 3n, expiresAt: expiresAt() })));
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.filter((result) => !result.ok)).toEqual(Array(7).fill({ ok: false, reason: "account-cap" }));
    const reserved = await pool.query<{ wei: string }>("SELECT sum(reserved_wei)::text AS wei FROM rest_sponsor_cap_reservations WHERE chain_id=8453");
    expect(BigInt(reserved.rows[0]!.wei)).toBe(9n);
  });

  it("settles, releases, lapses and replaces reservations by the database's clock", async () => {
    const store = new PostgresSponsorCapStore(pool, [{ chainId: 10, accountDailyWei: 10n, paused: false }]);
    const reserve = (operationId: string, reservationWei: bigint, until = expiresAt()) =>
      store.reserve({ chainId: 10, accountId: "account", operationId, reservationWei, expiresAt: until });
    expect(await reserve("a", 8n)).toEqual({ ok: true });
    expect(await reserve("b", 3n)).toEqual({ ok: false, reason: "account-cap" });
    // Its own final maximum replaces the ceiling reserved before the sponsor was asked.
    expect(await reserve("a", 2n)).toEqual({ ok: true });
    expect(await reserve("b", 8n)).toEqual({ ok: true });
    await store.hold({ operationId: "a" });
    await store.settle({ operationId: "a", spentWei: 1n });
    await store.release({ operationId: "b" });
    // Released and settled rows never take a reservation again.
    await expect(reserve("b", 1n)).rejects.toThrow();
    expect(await reserve("c", 9n, Date.now() - 1)).toEqual({ ok: true });
    // Unsigned and past its expiry, "c" counts for nothing.
    expect(await reserve("d", 9n)).toEqual({ ok: true });
    expect(await reserve("e", 1n)).toEqual({ ok: false, reason: "account-cap" });
    // A day-old row is pruned when its account reserves again.
    await pool.query("UPDATE rest_sponsor_cap_reservations SET created_at=created_at-86400000 WHERE operation_id IN ('a','d')");
    expect(await reserve("e", 10n)).toEqual({ ok: true });
    expect((await pool.query("SELECT operation_id FROM rest_sponsor_cap_reservations WHERE chain_id=10 ORDER BY operation_id")).rows.map((row) => row.operation_id))
      .toEqual(["b", "c", "e"]);
  });
});
