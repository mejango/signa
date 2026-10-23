/** One home for sponsorship metering: what a sponsor may spend, and how much a commitment reserves. */
import type { Pool } from "pg";
import type { Address } from "viem";
import { normalizeUserOperation, userOperationMaximumCost } from "./userOperations/codec.js";
import type { UserOperationV07 } from "./userOperations/types.js";

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

/** Signa's own limit on Pimlico sponsorship: per account, per chain, over a rolling day. Pimlico
 * stays the sponsor; this decides, before asking it, whether this account may be sponsored today. */
export interface SponsorCapPolicy {
  chainId: number;
  /** SIGNA_SPONSOR_ACCOUNT_DAILY_WEI_<chainId>; 0 means never sponsored on that chain. */
  accountDailyWei: bigint;
  /** SIGNA_SPONSOR_PAUSED */
  paused: boolean;
}
export const sponsorCapWindowMs = 86_400_000;

/** Throws when a chain with a Pimlico paymaster policy has no cap, so none goes silently unsponsored. */
export function readSponsorCapPolicies(env: NodeJS.ProcessEnv, pimlicoChains: readonly number[]): SponsorCapPolicy[] {
  const paused = env.SIGNA_SPONSOR_PAUSED === "1";
  return pimlicoChains.map((chainId) => {
    const name = `SIGNA_SPONSOR_ACCOUNT_DAILY_WEI_${chainId}`, value = env[name];
    if (value === undefined) throw new Error(`${name} is required: chain ${chainId} has a Pimlico paymaster policy`);
    if (!/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n) throw new Error(`${name} must be a non-negative integer`);
    return { chainId, accountDailyWei: BigInt(value), paused };
  });
}

export type SponsorCapRefusal = "paused" | "account-cap";
export interface SponsorCapStore {
  /** Reserves the operation's maximum gas cost. Reserving again for the same operation replaces its
   * amount under the same cap. Until `hold`, the reservation lapses at `expiresAt`. */
  reserve(input: { chainId: number; accountId: string; operationId: string; reservationWei: bigint; expiresAt: number }):
    Promise<{ ok: true } | { ok: false; reason: SponsorCapRefusal }>;
  /** The owner signed: the reservation no longer lapses, whatever happens to the submission. */
  hold(input: { operationId: string }): Promise<void>;
  /** From the canonical UserOperationEvent actualGasCost. */
  settle(input: { operationId: string; spentWei: bigint }): Promise<void>;
  /** Only on proven non-submission, retirement, or a preparation that never became an operation. */
  release(input: { operationId: string }): Promise<void>;
}

/** Who pays the operation's gas, as the one approval shows it. The payer is fixed at preparation:
 * `paymasterAndData` is inside the signed operation. */
export type ReviewGas =
  | { payer: "pimlico"; chainId: number; paymaster: Address }
  | { payer: "account"; chainId: number; maximumWei: string; reason: "account-cap" | "paused" | "sponsor-refused"; balanceWei: string; funded: boolean };

/** The gas a review may show for this unsigned operation: the payer its signed paymaster fields name,
 * and for the account the operation's own maximum cost against the balance read for it. */
export function checkReviewGas(input: unknown, unsigned: UserOperationV07, chainId: number): ReviewGas {
  const invalid = (): never => { throw new Error("The review's gas does not match its operation"); };
  const gas = (input && typeof input === "object" && !Array.isArray(input) ? input : invalid()) as Record<string, unknown>;
  const keys = (...names: string[]) => { if (Object.keys(gas).sort().join() !== names.sort().join()) invalid(); };
  const operation = normalizeUserOperation(unsigned), decimal = (value: unknown) =>
    typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) ? BigInt(value) : invalid();
  if (gas.chainId !== chainId) invalid();
  if (operation.paymaster) {
    keys("payer", "chainId", "paymaster");
    if (gas.payer !== "pimlico" || typeof gas.paymaster !== "string" || gas.paymaster !== operation.paymaster.toLowerCase()) invalid();
    return { payer: "pimlico", chainId, paymaster: gas.paymaster as Address };
  }
  keys("payer", "chainId", "maximumWei", "reason", "balanceWei", "funded");
  const maximum = userOperationMaximumCost(operation), balance = decimal(gas.balanceWei);
  if (gas.payer !== "account" || decimal(gas.maximumWei) !== maximum || !["account-cap", "paused", "sponsor-refused"].includes(gas.reason as string)
    || gas.funded !== balance >= maximum) invalid();
  return { payer: "account", chainId, maximumWei: maximum.toString(), reason: gas.reason as "account-cap", balanceWei: balance.toString(), funded: balance >= maximum };
}

interface CapRow { chainId: number; accountId: string; reservedWei: bigint; spentWei?: bigint; createdAt: number; expiresAt?: number; releasedAt?: number }
/** What a reservation counts against its cap now: its spend once settled, else its reservation while it holds. */
function counted(row: CapRow, now: number): bigint {
  if (row.createdAt <= now - sponsorCapWindowMs) return 0n;
  if (row.spentWei !== undefined) return row.spentWei;
  if (row.releasedAt !== undefined || (row.expiresAt !== undefined && row.expiresAt <= now)) return 0n;
  return row.reservedWei;
}
function capFor(policies: readonly SponsorCapPolicy[], chainId: number) {
  return policies.find((policy) => policy.chainId === chainId);
}
function refusal(policy: SponsorCapPolicy | undefined): SponsorCapRefusal | undefined {
  if (!policy) return "account-cap";
  return policy.paused ? "paused" : undefined;
}
function amount(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= 0n || value >= 2n ** 256n) throw new Error("A sponsorship reservation must be a positive uint256");
  return value;
}

export class MemorySponsorCapStore implements SponsorCapStore {
  private readonly rows = new Map<string, CapRow>();
  constructor(private readonly policies: readonly SponsorCapPolicy[], private readonly now: () => number = Date.now) {}
  async reserve(input: Parameters<SponsorCapStore["reserve"]>[0]): ReturnType<SponsorCapStore["reserve"]> {
    const policy = capFor(this.policies, input.chainId), refused = refusal(policy), reservedWei = amount(input.reservationWei);
    if (refused) return { ok: false, reason: refused };
    const now = this.now(), prior = this.rows.get(input.operationId);
    if (prior && (prior.chainId !== input.chainId || prior.accountId !== input.accountId || prior.spentWei !== undefined || prior.releasedAt !== undefined))
      throw new Error("The sponsorship reservation belongs to another operation state");
    let used = 0n;
    for (const [id, row] of this.rows)
      if (id !== input.operationId && row.chainId === input.chainId && row.accountId === input.accountId) used += counted(row, now);
    if (used + reservedWei > policy!.accountDailyWei) return { ok: false, reason: "account-cap" };
    this.rows.set(input.operationId, { chainId: input.chainId, accountId: input.accountId, reservedWei, createdAt: prior?.createdAt ?? now, expiresAt: input.expiresAt });
    return { ok: true };
  }
  async hold(input: { operationId: string }) {
    const row = this.rows.get(input.operationId);
    if (row) delete row.expiresAt;
  }
  async settle(input: { operationId: string; spentWei: bigint }) {
    const row = this.rows.get(input.operationId);
    if (row) { row.spentWei = input.spentWei; delete row.releasedAt; }
  }
  async release(input: { operationId: string }) {
    const row = this.rows.get(input.operationId);
    if (row && row.spentWei === undefined) row.releasedAt = this.now();
  }
}

const nowSql = "floor(extract(epoch FROM clock_timestamp())*1000)::bigint";
/** One account's reservations on one chain are decided under one advisory lock, so concurrent
 * preparations never reserve past the cap together. Time is the database's. */
export class PostgresSponsorCapStore implements SponsorCapStore {
  constructor(private readonly pool: Pool, private readonly policies: readonly SponsorCapPolicy[]) {}
  async reserve(input: Parameters<SponsorCapStore["reserve"]>[0]): ReturnType<SponsorCapStore["reserve"]> {
    const policy = capFor(this.policies, input.chainId), refused = refusal(policy), reservedWei = amount(input.reservationWei);
    if (refused) return { ok: false, reason: refused };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sponsor-cap:' || $1::text || ':' || $2::text, 0))", [input.chainId, input.accountId]);
      const now = Number((await client.query<{ now: string }>(`SELECT ${nowSql}::text AS now`)).rows[0]!.now);
      // Past the window a reservation counts for nothing: one account's rows stay bounded.
      await client.query("DELETE FROM rest_sponsor_cap_reservations WHERE chain_id=$1 AND account_id=$2 AND created_at<=$3 AND operation_id<>$4",
        [input.chainId, input.accountId, now - sponsorCapWindowMs, input.operationId]);
      const used = BigInt((await client.query<{ wei: string }>(`SELECT coalesce(sum(CASE
          WHEN spent_wei IS NOT NULL THEN spent_wei
          WHEN released_at IS NULL AND (expires_at IS NULL OR expires_at>$4) THEN reserved_wei ELSE 0 END),0)::text AS wei
        FROM rest_sponsor_cap_reservations WHERE chain_id=$1 AND account_id=$2 AND operation_id<>$3`,
      [input.chainId, input.accountId, input.operationId, now])).rows[0]!.wei);
      if (used + reservedWei > policy!.accountDailyWei) { await client.query("ROLLBACK"); return { ok: false, reason: "account-cap" }; }
      const saved = await client.query(`INSERT INTO rest_sponsor_cap_reservations(operation_id,chain_id,account_id,reserved_wei,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (operation_id) DO UPDATE SET reserved_wei=excluded.reserved_wei,expires_at=excluded.expires_at
        WHERE rest_sponsor_cap_reservations.chain_id=excluded.chain_id AND rest_sponsor_cap_reservations.account_id=excluded.account_id
          AND rest_sponsor_cap_reservations.spent_wei IS NULL AND rest_sponsor_cap_reservations.released_at IS NULL`,
      [input.operationId, input.chainId, input.accountId, reservedWei.toString(), now, input.expiresAt]);
      if (saved.rowCount !== 1) throw new Error("The sponsorship reservation belongs to another operation state");
      await client.query("COMMIT");
      return { ok: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async hold(input: { operationId: string }) {
    await this.pool.query("UPDATE rest_sponsor_cap_reservations SET expires_at=NULL WHERE operation_id=$1", [input.operationId]);
  }
  async settle(input: { operationId: string; spentWei: bigint }) {
    await this.pool.query("UPDATE rest_sponsor_cap_reservations SET spent_wei=$2,released_at=NULL WHERE operation_id=$1",
      [input.operationId, input.spentWei.toString()]);
  }
  async release(input: { operationId: string }) {
    await this.pool.query(`UPDATE rest_sponsor_cap_reservations SET released_at=${nowSql} WHERE operation_id=$1 AND spent_wei IS NULL AND released_at IS NULL`,
      [input.operationId]);
  }
}
