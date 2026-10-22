import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, padHex, toHex, type Address, type Hex } from "viem";
import type { RestRpc } from "../src/rest/core.js";
import { safeAbi } from "../src/rest/smartAccounts/service.js";
import { observeWalletOwners } from "../src/rest/wallet/ownerState.js";
import { PostgresWalletOwnerStateStore } from "../src/rest/wallet/ownerStatePostgres.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeIf = connectionString ? describe : describe.skip;
const account = "0x1111111111111111111111111111111111111111" as Address;
const now = () => 0x6553f100 * 1000;
const owners = ["0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"] as Address[];

describeIf("wallet owner state against real PostgreSQL", () => {
  const schema = `rest_wallet_owner_state_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 2 });
    await pool.query(await readFile(new URL("../src/db/migrations/063_wallet_owner_state.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("stores the observed state with its block hash and re-reads it on a reorg", async () => {
    const head = { 8453: "base-a", 10: "op-a" } as Record<number, string>, reads: number[] = [];
    const hashOf = (label: string) => padHex(toHex(label), { size: 32 });
    const rpc: RestRpc = { async request(chainId, method, params) {
      if (method === "eth_chainId") return toHex(chainId);
      if (method === "eth_getBlockByNumber") return { number: "0x64", hash: hashOf(head[chainId]!), timestamp: "0x6553f100" };
      const [call, at] = params as [{ data: Hex }, { blockHash: Hex }];
      expect(at.blockHash).toBe(hashOf(head[chainId]!));
      const { functionName } = decodeFunctionData({ abi: safeAbi, data: call.data });
      if (functionName === "getOwners") { reads.push(chainId); return encodeFunctionResult({ abi: safeAbi, functionName, result: owners }); }
      return encodeFunctionResult({ abi: safeAbi, functionName: "getThreshold", result: 1n });
    } };
    // Two stores over one table stand for two replicas.
    const first = new PostgresWalletOwnerStateStore(pool), second = new PostgresWalletOwnerStateStore(pool);
    expect(await observeWalletOwners({ account, chains: [10], rpc, store: first, now })).toMatchObject([{ chainId: 10, status: "consistent", owners, threshold: 1n }]);
    const row = (await pool.query("SELECT chain_id,block_number,block_hash,owners,threshold FROM rest_wallet_owner_states WHERE account=$1 AND chain_id=10", [account.toLowerCase()])).rows[0];
    expect(row).toMatchObject({ chain_id: "10", block_number: "100", block_hash: hashOf("op-a"), owners, threshold: "1" });
    expect(await second.get(account, 10)).toEqual({ owners, threshold: 1n,
      block: { chainId: 10, blockNumber: "100", blockHash: hashOf("op-a"), timestamp: String(0x6553f100), source: "onchain" } });
    // The same heads on another replica: nothing is read again.
    await observeWalletOwners({ account, chains: [10], rpc, store: second, now });
    expect(reads).toEqual([8453, 10]);
    // A reorg replaces Optimism's head at the same height: that chain alone is read again and stored at the new hash.
    head[10] = "op-b";
    await observeWalletOwners({ account, chains: [10], rpc, store: second, now });
    expect(reads).toEqual([8453, 10, 10]);
    expect((await first.get(account, 10))!.block.blockHash).toBe(hashOf("op-b"));
  });
});
