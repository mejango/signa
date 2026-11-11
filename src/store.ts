/** Shared request budgets for Signa's account runtime. */
export interface Store {
  health(): Promise<void>;
  consumeRequest(
    client: string,
    limit: number,
    windowSeconds?: number,
  ): Promise<{ allowed: boolean; remaining: number }>;
  /** Removes rate-limit windows older than two days; returns the count removed. */
  cleanupRateLimits(): Promise<number>;
}
