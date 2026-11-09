import type { Address, Hex } from "viem";
import type {
  Deployment,
  Intent,
  IntentDeploy,
  IntentDeployStatus,
  IntentEnvelope,
  IntentMetadata,
  SearchPage,
} from "./types.js";

export type NewIntent = IntentMetadata & {
  contentHash: Hex;
  envelope: IntentEnvelope;
  publisher: Address;
  signature: Hex;
  submittedBy: string;
  jbBytes: number;
};

export type StorageLimits = {
  maxIntents: number;
  maxBytes: number;
};

/** What the storage identity holds once the new intent is stored. */
export type StorageUsage = {
  intents: number;
  bytes: number;
};

export type NewDeployment = {
  chainId: number;
  projectId: string;
  transactionHash: Hex;
  forwarded: boolean;
};

export type DeployPatch = {
  /** Omitted when the patch only records why a row is waiting. */
  status?: IntentDeployStatus;
  transactionHash?: Hex;
  bundleUuid?: string;
  error?: string;
  spentWei?: bigint;
};

/** A failed row is asked for again only when no bundle was ever paid for it: a bundle may yet
 * execute. The route, the stores and `queueDeploys`' SQL all follow this one rule. */
export const retryableDeploy = (deploy: Pick<IntentDeploy, "status" | "bundleUuid">) =>
  deploy.status === "failed" && deploy.bundleUuid === null;

export type SearchFilters = {
  owner?: Address;
  publisher?: Address;
};

export interface Store {
  health(): Promise<void>;
  consumeRequest(
    client: string,
    limit: number,
    windowSeconds?: number,
  ): Promise<{ allowed: boolean; remaining: number }>;
  /** Removes rate-limit windows older than two days; returns the count removed. */
  cleanupRateLimits(): Promise<number>;
  /** `usage` accompanies a stored intent; a repeat publication stores nothing and reports none. */
  createIntent(
    value: NewIntent,
    limits: StorageLimits,
  ): Promise<{ intent: Intent; created: boolean; usage?: StorageUsage }>;
  getIntent(id: string): Promise<Intent | null>;
  search(
    query: string,
    limit: number,
    offset: number,
    filters: SearchFilters,
  ): Promise<SearchPage>;
  recordDeployment(intentId: string, value: NewDeployment): Promise<Deployment>;
  /** With `retryFailed`, a failed row among `chainIds` is reset to a fresh attempt; without it,
   * every row that already exists is left as it is. */
  queueDeploys(
    intentId: string,
    chainIds: number[],
    requester: string,
    reservedWeiPerChain: bigint,
    retryFailed?: boolean,
  ): Promise<IntentDeploy[]>;
  listDeploys(intentId: string): Promise<IntentDeploy[]>;
  claimQueuedDeploys(
    leaseSeconds: number,
    limit: number,
  ): Promise<{ intentId: string; chainIds: number[] }[]>;
  updateDeploy(intentId: string, chainId: number, patch: DeployPatch): Promise<void>;
  /** Give a claim back unspent: the lease ends and the attempt is not counted. */
  /** Hands a claim back without spending an attempt; the rows wait five minutes before the next pass. */
  releaseClaim(intentId: string, chainIds: number[]): Promise<void>;
  /** Reserved plus spent wei since `since`, for one requester or, with none, for every requester. */
  sponsoredWeiSince(since: Date, requester?: string): Promise<bigint>;
}

export class ConflictError extends Error {}
export class StorageLimitError extends Error {}
