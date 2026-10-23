import type { Pool } from 'pg';
import { toHex } from 'viem';
import type { ServerSigner } from '../signer.js';
import type { ContractPin, SmartAccountManifest } from '../smartAccounts/types.js';
import { observeBaseReceiptFees } from './baseFeeObservation.js';
import { createBaseWalletDeploymentReader, type BaseWalletDeploymentOptions } from './deploymentBase.js';
import { createWalletDeviceRelay } from './deviceRelay.js';
import { walletDeploymentQuantity } from './deploymentTransport.js';
import { RestError } from '../core.js';

/** The recovery relay's reviewed fees, shared by device additions: the signer creation and owner swap fit well inside this gas, the
 * priority fee is Base's ordinary floor, and a quote above the maximum is refused rather than
 * capped so a fee spike never produces an unmineable pair; L1/operator fees are reserved separately. */
const baseWalletRecoveryFees = Object.freeze({ gas: 3_000_000n, maxPriorityFeePerGas: 1_000_000n, maximumFeePerGas: 1_000_000_000n });
function unavailable(): never { throw new RestError(502, 'WALLET_DEVICE_BASE_UNAVAILABLE', 'The configured Base provider could not price or verify the device transactions.'); }

/** Hosted Base device-addition relay: the recovery relay's endpoint, fees and finality rules. */
export function createBaseWalletDeviceRelay(options: BaseWalletDeploymentOptions & {
  pool: Pool; signer: ServerSigner; manifest: SmartAccountManifest; utility: ContractPin; maximumOperations: number; maximumCostWei: string;
}) {
  const reader = createBaseWalletDeploymentReader(options);
  return createWalletDeviceRelay({ pool: options.pool, signer: options.signer, manifest: options.manifest, utility: options.utility,
    maximumOperations: options.maximumOperations, maximumCostWei: options.maximumCostWei,
    adapter: { configurationVersion: 'base-mainnet-recovery-v1', kind: 'base-mainnet', genesisHash: reader.genesisHash,
      reads: reader.reads, identity: reader.identity, send: reader.send, reserve: reader.reserve, releaseAfterFinality: true,
      quote: async (rpc, latest) => {
        const block = await rpc.request('eth_getBlockByNumber', [toHex(BigInt(latest.blockNumber)), false]);
        if (!block || typeof block !== 'object' || (block as { hash?: string }).hash?.toLowerCase() !== latest.blockHash) unavailable();
        const baseFee = walletDeploymentQuantity((block as { baseFeePerGas?: unknown }).baseFeePerGas, unavailable);
        const maxFeePerGas = baseFee * 2n + baseWalletRecoveryFees.maxPriorityFeePerGas;
        if (maxFeePerGas > baseWalletRecoveryFees.maximumFeePerGas) unavailable();
        return { gas: baseWalletRecoveryFees.gas, maxFeePerGas, maxPriorityFeePerGas: baseWalletRecoveryFees.maxPriorityFeePerGas };
      },
      fees: async (rpc, raw, receipt) => {
        const fees = await observeBaseReceiptFees(rpc, raw, receipt.block);
        if (fees.gasUsed !== receipt.gasUsed || fees.effectiveGasPrice !== receipt.effectiveGasPrice
          || fees.status !== (receipt.status === 'success' ? 'success' : 'reverted')) unavailable();
        return { executionWei: String(fees.executionWei), l1Wei: String(fees.l1Wei), operatorWei: String(fees.operatorWei), totalWei: String(fees.totalWei) };
      } } });
}
