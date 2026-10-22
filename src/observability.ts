import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { hostingSetting } from "./firstParty.js";
import type { JbcenterEnv } from "./types.js";

type RecoveryTask = "nonce_cleanup" | "rate_limit_cleanup" | "transactions" | "user_operations";

export class Metrics {
  private requests = new Map<string, number>();
  private durationMs = 0;
  private inFlight = 0;
  private recovery = new Map<RecoveryTask, {
    completedAt: number;
    failures: number;
    totalFailures: number;
    runs: number;
    oldestPendingAt: number;
  }>();

  private sponsor = { bundles: 0, paymentsWei: 0n, failures: 0 };

  /** Sponsored deploys move real money; only aggregate counts are exported. */
  observeSponsorEvent(event: { event: string; wei?: string }): void {
    if (event.event === "bundle") this.sponsor.bundles += 1;
    if (event.event === "payment") this.sponsor.paymentsWei += BigInt(event.wei ?? "0");
    if (event.event === "failed") this.sponsor.failures += 1;
  }

  startRestRecovery(): void {
    for (const task of ["nonce_cleanup", "rate_limit_cleanup", "transactions", "user_operations"] as const) {
      this.recovery.set(task, { completedAt: 0, failures: 0, totalFailures: 0, runs: 0, oldestPendingAt: 0 });
    }
  }

  /** Only aggregate counts leave the worker; upstream errors can contain signed bytes or secrets. */
  async observeRestRecovery(task: RecoveryTask, work: () => Promise<{
    failures: number;
    oldestPendingAt?: number | null;
  }>): Promise<void> {
    const state = this.recovery.get(task)!;
    let failures: number;
    try {
      const result = await work();
      failures = result.failures;
      state.oldestPendingAt = (result.oldestPendingAt ?? 0) / 1000;
    } catch {
      failures = 1;
      // Keep the previous sample when no new page was observed.
    }
    state.completedAt = Date.now() / 1000;
    state.failures = failures;
    state.totalFailures += failures;
    state.runs += 1;
    if (failures) {
      console.error(JSON.stringify({
        level: "error", service: "rest", code: "MAINTENANCE_UNAVAILABLE", task, failures,
      }));
    }
  }

  middleware(): MiddlewareHandler<JbcenterEnv> {
    return async (c, next) => {
      const requestId = c.req.header("x-request-id")?.slice(0, 128) || randomUUID();
      const started = performance.now();
      this.inFlight += 1;
      c.set("requestId", requestId);
      c.header("X-Request-Id", requestId);
      try {
        await next();
      } finally {
        const elapsed = performance.now() - started;
        this.inFlight -= 1;
        this.durationMs += elapsed;
        const key = `${c.req.method}:${c.res.status}`;
        this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
        if (process.env.NODE_ENV !== "test") {
          console.log(
            JSON.stringify({
              level: "info",
              message: "request",
              requestId,
              method: c.req.method,
              path: c.req.path,
              status: c.res.status,
              ...(c.get("errorCode") ? { code: c.get("errorCode") } : {}),
              ...(c.get("errorDetail") ? { detail: c.get("errorDetail") } : {}),
              durationMs: Math.round(elapsed * 100) / 100,
              ...(c.get("authMs") !== undefined ? { authMs: c.get("authMs") } : {}),
              client: c.get("client") ?? null,
              region: hostingSetting("replicaRegion") ?? null,
              replica: hostingSetting("replicaId") ?? null,
            }),
          );
        }
      }
    };
  }

  render(): string {
    const lines = [
      "# TYPE jbcenter_http_requests_total counter",
      ...[...this.requests.entries()].map(([key, count]) => {
        const [method, status] = key.split(":");
        return `jbcenter_http_requests_total{method="${method}",status="${status}"} ${count}`;
      }),
      "# TYPE jbcenter_http_request_duration_milliseconds_total counter",
      `jbcenter_http_request_duration_milliseconds_total ${this.durationMs}`,
      "# TYPE jbcenter_http_requests_in_flight gauge",
      `jbcenter_http_requests_in_flight ${this.inFlight}`,
      "# TYPE jbcenter_sponsor_bundles_total counter",
      `jbcenter_sponsor_bundles_total ${this.sponsor.bundles}`,
      "# TYPE jbcenter_sponsor_payments_wei_total counter",
      `jbcenter_sponsor_payments_wei_total ${this.sponsor.paymentsWei}`,
      "# TYPE jbcenter_sponsor_failures_total counter",
      `jbcenter_sponsor_failures_total ${this.sponsor.failures}`,
      "# TYPE jbcenter_rest_recovery_last_completed_timestamp_seconds gauge",
      ...[...this.recovery].map(([task, state]) =>
        `jbcenter_rest_recovery_last_completed_timestamp_seconds{task="${task}"} ${state.completedAt}`),
      "# TYPE jbcenter_rest_recovery_last_failures gauge",
      ...[...this.recovery].map(([task, state]) =>
        `jbcenter_rest_recovery_last_failures{task="${task}"} ${state.failures}`),
      "# TYPE jbcenter_rest_recovery_failures_total counter",
      ...[...this.recovery].map(([task, state]) =>
        `jbcenter_rest_recovery_failures_total{task="${task}"} ${state.totalFailures}`),
      "# TYPE jbcenter_rest_recovery_runs_total counter",
      ...[...this.recovery].map(([task, state]) =>
        `jbcenter_rest_recovery_runs_total{task="${task}"} ${state.runs}`),
      "# TYPE jbcenter_rest_recovery_sample_oldest_pending_timestamp_seconds gauge",
      ...[...this.recovery].map(([task, state]) =>
        `jbcenter_rest_recovery_sample_oldest_pending_timestamp_seconds{task="${task}"} ${state.oldestPendingAt}`),
    ];
    return `${lines.join("\n")}\n`;
  }
}
