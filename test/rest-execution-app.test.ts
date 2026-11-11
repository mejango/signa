import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { createSignaProtocol } from "../src/signaProtocol.js";
import type { Store } from "../src/store.js";
import { createRestRuntime } from "../src/rest/runtime.js";
import { readRestExecutionConfiguration } from "../src/rest/executionConfig.js";
import { Metrics } from "../src/observability.js";
import { PostgresAccountStore } from "../src/rest/auth/index.js";
import { TransactionService } from "../src/rest/transactions/service.js";
import { UserOperationService } from "../src/rest/userOperations/service.js";

// Asset packaging is checked by the production build. This suite exercises the
// real runtime composition and public readiness without opening a DB or network.
vi.mock("../src/rest/site.js", async (original) => ({
  ...(await original<typeof import("../src/rest/site.js")>()),
  readRestAssets: async () => ({ accountsScript: "", documents: new Map() }),
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture(configured: boolean, metrics?: Metrics) {
  const pool = new Pool({
    connectionString: "postgresql://fixture@127.0.0.1:1/unused",
  });
  const query = vi.spyOn(pool, "query").mockImplementation(() => {
    throw new Error("Unexpected database request during discovery");
  });
  const request = vi.fn(async (): Promise<never> => {
    throw new Error("Unexpected upstream request during discovery");
  });
  const store = {
    consumeRequest: async () => ({ allowed: true, remaining: 100 }),
    cleanupRateLimits: async () => 0,
  } as unknown as Store;
  const operations = createSignaProtocol();
  const executionConfiguration = await readRestExecutionConfiguration(
    configured
      ? JSON.stringify({
          chains: [
            {
              chainId: 11155111,
              bundlerUrl: "https://bundler.invalid/SECRET_FIXTURE",
              paymasterUrl: "https://paymaster.invalid/SECRET_FIXTURE",
              paymasterPolicyId: "fixture",
              sessionGuardAddress: "0x6000000000000000000000000000000000000006",
              gas: {
                maximumCallGas: "1000000",
                maximumVerificationGas: "1000000",
                maximumPreVerificationGas: "100000",
                maximumPaymasterVerificationGas: "100000",
                maximumPaymasterPostOpGas: "0",
                maximumFeePerGas: "1000000000",
                maximumPriorityFeePerGas: "100000000",
                maximumCost: "10000000000000000",
              },
            },
          ],
        })
      : {},
  );
  const runtime = await createRestRuntime({
    pool,
    store,
    operations,
    upstreams: new Map(),
    rpc: { request },
    executionConfiguration,
    startMaintenance: !!metrics,
    ...(metrics ? { metrics } : {}),
  });
  cleanup.push(async () => {
    await runtime.stop();
    await pool.end();
  });
  const app = new Hono().route("/api/v1", runtime.site.app);
  return { app, request, query, store };
}
describe("production execution runtime composition", () => {
  it("reports bounded recovery failures and stale workers through runtime metrics", async () => {
    vi.useFakeTimers();
    const metrics = new Metrics();
    const pendingAt = Date.now() - 31 * 60_000;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const nonces = vi.spyOn(PostgresAccountStore.prototype, "cleanupExpiredNonces")
      .mockRejectedValueOnce(new Error("SECRET_PROVIDER_URL and signed bytes"))
      .mockResolvedValue(0);
    const transactions = vi.spyOn(TransactionService.prototype, "recoverPending")
      .mockResolvedValueOnce({ reconciled: [{ planId: "private-plan", status: "reconciliation-unavailable" }], broadcastAttempted: false, oldestPendingAt: pendingAt })
      .mockResolvedValue({ reconciled: [], broadcastAttempted: false, oldestPendingAt: null });
    const operations = vi.spyOn(UserOperationService.prototype, "recoverPending")
      .mockResolvedValueOnce({ items: [{ id: "private-operation", state: "verification-unavailable" }], broadcastAttempted: false, oldestPendingAt: pendingAt })
      .mockResolvedValue({ items: [], broadcastAttempted: false, oldestPendingAt: null });
    await fixture(false, metrics);
    const read = () => metrics.render();
    expect(await read()).toContain('jbcenter_rest_recovery_last_completed_timestamp_seconds{task="transactions"} 0');
    await vi.advanceTimersByTimeAsync(30_000);
    const failed = await read();
    for (const task of ["nonce_cleanup", "transactions", "user_operations"]) {
      expect(failed).toContain(`jbcenter_rest_recovery_last_failures{task="${task}"} 1`);
      expect(failed).toContain(`jbcenter_rest_recovery_runs_total{task="${task}"} 1`);
      expect(failed).toContain(`jbcenter_rest_recovery_sample_oldest_pending_timestamp_seconds{task="${task}"} ${task === "nonce_cleanup" ? 0 : pendingAt / 1000}`);
    }
    expect(nonces).toHaveBeenCalledWith(expect.any(Number), 1000);
    expect(transactions).toHaveBeenCalledWith({ limit: 5 });
    expect(operations).toHaveBeenCalledWith(5);
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET_PROVIDER_URL|signed bytes|private-plan|private-operation/);

    // A slow read must not overlap another sweep or pretend it has completed.
    let release!: () => void;
    nonces.mockImplementationOnce(() => new Promise<number>((resolve) => {
      release = () => resolve(0);
    }));
    try {
      await vi.advanceTimersByTimeAsync(90_000);
      expect(nonces).toHaveBeenCalledTimes(2);
      expect(transactions).toHaveBeenCalledTimes(1);
      expect(operations).toHaveBeenCalledTimes(1);
      expect(await read()).toContain(`jbcenter_rest_recovery_last_completed_timestamp_seconds{task="transactions"} ${(Date.now() - 90_000) / 1000}`);
    } finally {
      release?.();
    }
    await vi.advanceTimersByTimeAsync(0);
    const recovered = await read();
    for (const task of ["nonce_cleanup", "transactions", "user_operations"]) {
      expect(recovered).toContain(`jbcenter_rest_recovery_last_failures{task="${task}"} 0`);
      expect(recovered).toContain(`jbcenter_rest_recovery_failures_total{task="${task}"} 1`);
      expect(recovered).toContain(`jbcenter_rest_recovery_runs_total{task="${task}"} 2`);
      expect(recovered).toContain(`jbcenter_rest_recovery_sample_oldest_pending_timestamp_seconds{task="${task}"} 0`);
    }
  });

  it.each([false, true])(
    "reports exact configured execution readiness without upstream access: %s",
    async (configured) => {
      const f = await fixture(configured);
      const response = await f.app.request("/api/v1/capabilities");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.smartAccounts.deployments).toHaveLength(8);
      expect(
        body.smartAccounts.deployments.every(
          (d: { mode: string; manifest: unknown }) =>
            d.mode === "execution-candidate" && d.manifest,
        ),
      ).toBe(true);
      expect(body.userOperations.preparation).toBe(configured);
      expect(body.userOperations.relay).toBe(configured);
      expect(body.sessions.activationReady).toBe(configured);
      expect(body.sessions.requiresVerifiedGuardDeployment).toBe(true);
      expect(
        body.transactions.transports.find(
          (t: { kind: string }) => t.kind === "eip4337-user-operation",
        ).supported,
      ).toBe(configured);
      expect(body.transactions.authorization.onchainSessionKeysSupported).toBe(
        configured,
      );
      expect(JSON.stringify(body)).not.toContain("SECRET_FIXTURE");
      expect(f.request).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
      const spec = await (await f.app.request("/api/v1/openapi.json")).json();
      for (const route of [
        "/smart-accounts/creation-plans",
        "/smart-accounts/sessions",
        "/user-operations",
      ]) {
        expect(spec.paths[`/api/v1${route}`].post).toBeDefined();
        const rejected = await f.app.request(`/api/v1${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(rejected.status).toBe(401);
      }
      expect(f.request).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
    },
  );
});
