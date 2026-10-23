/** One home for sponsorship metering: what a sponsor may spend, and how much a commitment reserves. */

export const CREATION_FEE_CEILING = 100_000_000_000_000n; // 0.0001 ETH today; MAX_CREATION_FEE on chain is 0.001 ETH

export type SponsorPolicy = {
  paused: boolean;
  perRequesterPerDay: number;
  dailyBudgetWei: bigint;
  /** The slice of the daily budget the co-hosted MCP may spend, checked before the shared one. */
  mcpDailyBudgetWei: bigint;
  maximumGas: bigint;
  maximumFeePerGas: bigint;
  confirmations: number;
};

/** One committed call: the gas the sponsor will sign for plus the creation fee ceiling. */
export function reservationWei(policy: SponsorPolicy, callCount: number): bigint {
  return BigInt(callCount) * (policy.maximumGas * policy.maximumFeePerGas + CREATION_FEE_CEILING);
}

export function readSponsorPolicy(env: NodeJS.ProcessEnv): SponsorPolicy {
  const int = (name: string, fallback: string) => {
    const value = env[name] ?? fallback;
    if (!/^[0-9]{1,30}$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  const dailyBudgetWei = BigInt(int("SPONSOR_DAILY_BUDGET_WEI", "50000000000000000"));
  return {
    paused: env.SPONSOR_PAUSED === "1",
    perRequesterPerDay: Number(int("SPONSOR_DEPLOYS_PER_REQUESTER_PER_DAY", "5")),
    dailyBudgetWei,
    mcpDailyBudgetWei: BigInt(
      int("SPONSOR_MCP_DAILY_BUDGET_WEI", String(dailyBudgetWei / 5n)),
    ),
    maximumGas: BigInt(int("SPONSOR_MAX_GAS", "8000000")),
    maximumFeePerGas: BigInt(int("SPONSOR_MAX_FEE_PER_GAS", "1000000000")),
    // The deployment verifier requires two confirmations; a lower setting cannot be honoured.
    confirmations: Math.max(2, Number(int("SPONSOR_CONFIRMATIONS", "2"))),
  };
}
