import type { Pool } from "pg";
import type { Hex } from "viem";
import type { ServerSigner } from "../signer.js";
import { RestError, type RestRpc } from "../core.js";
import type { createSmartAccountService } from "../smartAccounts/service.js";
import { PostgresSmartAccountRegistry } from "../smartAccounts/postgres.js";
import type { ContractPin, SmartAccountManifest } from "../smartAccounts/types.js";
import { PostgresWalletAuthorityStore } from "./authorityPostgres.js";
import { createWalletAuthorityChain } from "./authorityChain.js";
import { PostgresSafe7579CheckpointStore } from "../smartAccounts/checkpoints.js";
import { createWalletAuthorityService } from "./authorityService.js";
import { createBaseWalletDeploymentReader, createBaseWalletDeploymentSettlement, createBaseWalletDeploymentTransport } from "./deploymentBase.js";
import { createWalletDeploymentChain } from "./deploymentChain.js";
import { createWalletDeploymentExecution } from "./deploymentExecution.js";
import { PostgresWalletDeploymentStore, type WalletDeploymentPoolConfiguration } from "./deploymentPostgres.js";
import { PostgresWalletEnrollmentStore } from "./enrollmentPostgres.js";
import { createLocalWalletSignup } from "./signup.js";
import { PostgresWalletSignupStore } from "./signupPostgres.js";
import { createBaseWalletRecovery } from "./recoveryBase.js";
import { createBaseWalletDeviceRelay } from "./deviceBase.js";
import { createLocalWalletDevices } from "./deviceService.js";
import { PostgresWalletDeviceStore } from "./devicesPostgres.js";
import { PostgresWalletRecoveryStore } from "./recoveryPostgres.js";
import { PostgresWalletRecoveryFlowStore } from "./recoveryFlowPostgres.js";
import { createLocalWalletRecovery } from "./recoveryService.js";
import type { RestWalletRuntime } from "../runtime.js";

export interface BaseWalletHostContext { pool: Pool; rpc: RestRpc; wallet: RestWalletRuntime; audience: string;
  smart: ReturnType<typeof createSmartAccountService> }
/** Every hosted observation shares the durable history checkpoints, so a refresh scans only what is new. */
function authorityChain(context: BaseWalletHostContext, rpc: RestRpc, options: { manifest: SmartAccountManifest; utility: ContractPin }) {
  return createWalletAuthorityChain({ rpc, manifest: options.manifest, utility: options.utility,
    checkpointStore: new PostgresSafe7579CheckpointStore(context.pool),
    // The first observation after a signup's binding carries the creation worker's verification.
    carried: (manifestId, address) => context.smart.remembered(manifestId, address),
    onError: code => console.info(JSON.stringify({ service: "wallet", action: "authority_observe", outcome: "failed", code })) });
}
export interface BaseWalletSignupHostOptions {
  url: string;
  genesisHash?: Hex;
  /** Dedicated creation treasury signer. */
  signer: ServerSigner;
  poolId: string;
  allocationWei: string;
  /** The sender's expected first nonce. Initialization never adopts a provider value. */
  initialNonce: string;
  manifest: SmartAccountManifest;
  utility: ContractPin;
  onEvent?: Parameters<typeof createLocalWalletSignup>[0]["onEvent"];
}
/** Reviewed pilot relay policy: one Safe creation per operation, bounded execution envelope. The
 * whole allocation must cover one maximum envelope (2M gas at 1 gwei = 0.002 ETH); admission pauses
 * while Base's base fee exceeds about 0.5 gwei. L1/operator fees are reserved separately. */
export const baseWalletCreationPolicy = Object.freeze({ maximumRawBytes: 32768, maximumGas: "2000000", maximumFeePerGas: "1000000000",
  maximumTransactionCost: "2000000000000000", maximumObservationAgeMs: 30_000 });

/** Explicit host composition for hosted Base signup. Startup configures the single permanent pool
 * and initializes its accounting exactly once; a later start with different values fails closed. */
export async function createBaseWalletSignupHost(context: BaseWalletHostContext, options: BaseWalletSignupHostOptions) {
  if (!options.signer || typeof options.initialNonce !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(options.initialNonce))
    throw new RestError(500, "WALLET_CREATION_CONFIG_INVALID", "Hosted creation requires a signer key and explicit first nonce.");
  const signer = options.signer;
  const configuration: WalletDeploymentPoolConfiguration = { id: options.poolId, chainId: 8453, sender: signer.address.toLowerCase() as Hex,
    allocationWei: options.allocationWei, globalAllocationLimitWei: options.allocationWei, policy: { ...baseWalletCreationPolicy } };
  const base = { url: options.url, ...(options.genesisHash ? { genesisHash: options.genesisHash } : {}) };
  const reader = createBaseWalletDeploymentReader(base);
  const deployments = new PostgresWalletDeploymentStore(context.pool);
  const settlement = createBaseWalletDeploymentSettlement({ ...base, utility: options.utility });
  await deployments.configurePool(configuration);
  const funding = await deployments.loadFundingContext(configuration.id);
  if (!funding.pool.accounting) await deployments.initializeAccounting(funding, await settlement.observeFunding(funding), options.initialNonce);
  else if (funding.pool.accounting.initialNonce !== options.initialNonce)
    throw new RestError(500, "WALLET_CREATION_CONFIG_INVALID", "The configured first nonce differs from the initialized accounting.");
  // Every chain read for creation and readiness goes through the single Dwellir endpoint, never a public fallback.
  const chain = createWalletDeploymentChain({ rpc: reader.reads, configuration, manifest: options.manifest, utility: options.utility });
  const execution = createWalletDeploymentExecution({ store: deployments, chain, signer, experimentalTransport: createBaseWalletDeploymentTransport(base) });
  const authority = createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(context.pool),
    chain: authorityChain(context, reader.reads, options) });
  return createLocalWalletSignup({ flows: new PostgresWalletSignupStore(context.pool, { rpId: new URL(context.wallet.origin).hostname,
      origin: context.wallet.origin, manifest: options.manifest }),
    enrollments: new PostgresWalletEnrollmentStore(context.pool),
    deployments, settlement, execution, chain, smart: context.smart, registry: new PostgresSmartAccountRegistry(context.pool), authority,
    poolId: configuration.id, preconfirmationReads: reader.reads, login: context.wallet.login, ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
}

export interface BaseWalletRecoveryHostOptions {
  url: string;
  genesisHash?: Hex;
  /** Dedicated recovery relay signer, distinct from the creation treasury. */
  signer: ServerSigner;
  maximumOperations: number;
  maximumCostWei: string;
  manifest: SmartAccountManifest;
  utility: ContractPin;
  onEvent?: Parameters<typeof createLocalWalletRecovery>[0]["onEvent"];
}
/** Explicit host composition for adding devices on hosted Base. It shares the recovery relay's
 * signer key and lane (one owner change at a time per sender); the lane row is created on first use. */
export function createBaseWalletDeviceHost(context: BaseWalletHostContext, options: BaseWalletRecoveryHostOptions & { onDeviceEvent?: Parameters<typeof createLocalWalletDevices>[0]["onEvent"] }) {
  if (!options.signer)
    throw new RestError(500, "WALLET_DEVICE_CONFIG_INVALID", "Adding devices requires the dedicated relay signer key.");
  const reader = createBaseWalletDeploymentReader({ url: options.url, ...(options.genesisHash ? { genesisHash: options.genesisHash } : {}) });
  const chain = authorityChain(context, reader.reads, options);
  const origin = context.wallet.origin, rpId = new URL(origin).hostname;
  return createLocalWalletDevices({ audience: context.audience, smart: context.smart, authority: new PostgresWalletAuthorityStore(context.pool), login: context.wallet.login,
    devices: new PostgresWalletDeviceStore(context.pool, { origin, rpId }, { audience: context.audience, observe: value => chain.observe(value) }),
    ...(options.onDeviceEvent ? { onEvent: options.onDeviceEvent } : {}),
    addition: createBaseWalletDeviceRelay({ pool: context.pool, url: options.url, ...(options.genesisHash ? { genesisHash: options.genesisHash } : {}),
      signer: options.signer, manifest: options.manifest, utility: options.utility,
      maximumOperations: options.maximumOperations, maximumCostWei: options.maximumCostWei }) });
}
/** Explicit host composition for hosted Base recovery. The lane row is created on first use. */
export function createBaseWalletRecoveryHost(context: BaseWalletHostContext, options: BaseWalletRecoveryHostOptions) {
  if (!options.signer)
    throw new RestError(500, "WALLET_RECOVERY_CONFIG_INVALID", "Hosted recovery requires a dedicated relay signer key.");
  const reader = createBaseWalletDeploymentReader({ url: options.url, ...(options.genesisHash ? { genesisHash: options.genesisHash } : {}) });
  const chain = authorityChain(context, reader.reads, options);
  const origin = context.wallet.origin, rpId = new URL(origin).hostname;
  return createLocalWalletRecovery({ audience: context.audience, smart: context.smart,
    authority: createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(context.pool), chain }),
    recoveries: new PostgresWalletRecoveryStore(context.pool, { origin, rpId }, { audience: context.audience, observe: value => chain.observe(value) }),
    flows: new PostgresWalletRecoveryFlowStore(context.pool), ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    rotation: createBaseWalletRecovery({ pool: context.pool, url: options.url, ...(options.genesisHash ? { genesisHash: options.genesisHash } : {}),
      signer: options.signer, manifest: options.manifest, utility: options.utility,
      maximumOperations: options.maximumOperations, maximumCostWei: options.maximumCostWei }) });
}
