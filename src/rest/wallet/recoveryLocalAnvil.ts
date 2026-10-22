import type { Pool } from 'pg';
import type { Hex } from 'viem';
import type { ServerSigner } from '../signer.js';
import type { ContractPin, SmartAccountManifest } from '../smartAccounts/types.js';
import { createLocalAnvilWalletDeploymentReader } from './deploymentLocalAnvil.js';
import { createWalletRecoveryRelay } from './recoveryRelay.js';

export type { LocalWalletRecoveryStatus } from './recoveryRelay.js';

/** Explicit host-created test capability on an unforked local Anvil: fixed fees, execution-only
 * receipts and lane release as soon as both rotation receipts are canonical. */
export function createLocalAnvilWalletRecovery(options: {
  pool: Pool; endpoint: string; expectedGenesisHash: Hex; signer: ServerSigner;
  manifest: SmartAccountManifest; utility: ContractPin; maximumOperations: number; maximumCostWei: string;
}) {
  const local = createLocalAnvilWalletDeploymentReader(options);
  return createWalletRecoveryRelay({ ...options, adapter: { configurationVersion: 'unforked-anvil-recovery-v1', kind: 'unforked-anvil',
    genesisHash: options.expectedGenesisHash.toLowerCase() as Hex, reads: local.reads, identity: local.identity, send: local.send,
    quote: async () => ({ gas: 3_000_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
    fees: async (_rpc, _raw, receipt) => ({ executionWei: String(receipt.gasUsed * receipt.effectiveGasPrice) }),
    releaseAfterFinality: false } });
}
