// Runtime composition of hosted Base signup: the host factory configures the single pool,
// initializes Base accounting once with the explicit first nonce, and mounts the worker.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Store } from "../src/store.js";
import { createCenterMcp } from "../src/mcp.js";
import { migrate } from "../src/db/migrate.js";
import { createRestRuntime } from "../src/rest/runtime.js";
import { readRestExecutionConfiguration } from "../src/rest/executionConfig.js";
import { createBaseWalletRecoveryHost, createBaseWalletSignupHost } from "../src/rest/wallet/baseHost.js";
import { PostgresWalletDeploymentStore } from "../src/rest/wallet/deploymentPostgres.js";
import { startWalletBaseAnvil } from "./fixtures/wallet-base-anvil.js";

vi.mock("../src/rest/site.js", async original => ({
  ...(await original<typeof import("../src/rest/site.js")>()),
  readRestAssets: async () => ({ accountsScript: "", walletScript: "/* wallet */", walletPaymentScript: "/* payment */",
    walletSignupScript: "/* signup */", walletRecoveryScript: "/* recovery */", documents: new Map() }),
}));
const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const origin = "https://wallet.juicebox.center", audience = "https://juicebox.center";
// Anvil account 0: public test key, the fixture treasury.
const signerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

suite("hosted Base signup runtime host", () => {
  const schema = `rest_wallet_base_host_${randomUUID().replaceAll("-", "")}`, poolId = randomUUID();
  let admin: Pool, pool: Pool, fixture: Awaited<ReturnType<typeof startWalletBaseAnvil>>;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
    await migrate(pool);
    fixture = await startWalletBaseAnvil();
  }, 90_000);
  afterAll(async () => {
    await fixture?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  const store = { consumeRequest: async () => ({ allowed: true, remaining: 100 }), cleanupRateLimits: async () => 0 } as unknown as Store;
  const mcp = () => createCenterMcp(store, { rpc: { request: async () => { throw new Error("The MCP transport is unused here"); }, supports: () => true },
    env: { MCP_PLAN_SECRET: "PUBLIC_WALLET_RUNTIME_FIXTURE_SECRET_ONLY", MCP_PUBLIC_ORIGIN: audience } });
  async function runtime(host: { poolId: string; initialNonce: string }) {
    const { services, config } = mcp();
    return createRestRuntime({ pool, store, services, config, upstreams: new Map(), rpc: fixture.readOnlyRpc,
      executionConfiguration: await readRestExecutionConfiguration({}), startMaintenance: false,
      wallet: { origin, manifest: fixture.manifest, utility: fixture.utility },
      walletSignup: context => createBaseWalletSignupHost(context, { url: fixture.endpoint, genesisHash: fixture.genesisHash, signer: privateKeyToAccount(signerKey),
        ...host, allocationWei: "5000000000000000", manifest: fixture.manifest, utility: fixture.utility }),
      walletRecovery: context => createBaseWalletRecoveryHost(context, { url: fixture.endpoint, genesisHash: fixture.genesisHash,
        signer: privateKeyToAccount(`0x${"55".repeat(32)}`), maximumOperations: 10, maximumCostWei: "100000000000000000", manifest: fixture.manifest, utility: fixture.utility }) });
  }

  it("refuses a first nonce that does not match the sender's actual nonce instead of adopting the provider value", async () => {
    await expect(runtime({ poolId, initialNonce: "7" })).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_CONFLICT" });
    expect((await new PostgresWalletDeploymentStore(pool).loadFundingContext(poolId)).pool.accounting).toBeUndefined();
  }, 60_000);
  it("configures the pool and initializes Base accounting once, then resumes without reinitializing", async () => {
    const first = await runtime({ poolId, initialNonce: "2" });
    try {
      expect(first.wallet?.signup).toBeDefined(); expect(first.wallet?.recovery).toBeDefined();
      await first.wallet!.recovery!.tick();
      const deployments = new PostgresWalletDeploymentStore(pool), funding = await deployments.loadFundingContext(poolId);
      expect(funding.pool.configuration).toMatchObject({ id: poolId, chainId: 8453, sender: fixture.sender, allocationWei: "5000000000000000" });
      expect(BigInt(funding.pool.configuration.policy.maximumTransactionCost)).toBeLessThanOrEqual(5000000000000000n);
      expect(funding.pool.accounting).toMatchObject({ environment: { kind: "base-mainnet", genesisHash: fixture.genesisHash }, nextNonce: "2", sequence: 0, fence: null });
      await first.wallet!.signup!.tick();
      const second = await runtime({ poolId, initialNonce: "2" });
      try {
        expect((await deployments.loadFundingContext(poolId)).pool).toEqual(funding.pool);
        expect(fixture.sends()).toHaveLength(0);
      } finally { await second.stop(); }
      await expect(runtime({ poolId, initialNonce: "3" })).rejects.toMatchObject({ code: "WALLET_CREATION_CONFIG_INVALID" });
    } finally { await first.stop(); }
  }, 60_000);
});
