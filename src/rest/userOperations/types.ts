import type { Address, Hex } from "viem";
import type { RestBlockEvidence, RestCall } from "../core.js";
import type { SemanticResult, StoredReceipt } from "../transactions/types.js";

/** Standard unpacked EntryPoint v0.7 RPC representation. No v0.8/7702 extensions. */
export interface UserOperationV07 {
  sender: Address;
  nonce: Hex;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymaster?: Address;
  paymasterVerificationGasLimit?: Hex;
  paymasterPostOpGasLimit?: Hex;
  paymasterData?: Hex;
  signature: Hex;
}
export interface PackedUserOperationV07 {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}
export interface UserOperationCodePin {
  address: Address;
  runtimeCodeHash: Hex;
}
export interface UserOperationGasEstimate {
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  paymasterVerificationGasLimit?: Hex;
  paymasterPostOpGasLimit?: Hex;
}
export interface UserOperationGasPolicy {
  id: string;
  maximumCallGas: bigint;
  maximumVerificationGas: bigint;
  maximumPreVerificationGas: bigint;
  maximumPaymasterVerificationGas: bigint;
  maximumPaymasterPostOpGas: bigint;
  maximumFeePerGas: bigint;
  maximumPriorityFeePerGas: bigint;
  maximumCost: bigint;
  requirePaymaster: boolean;
}
export interface PaymasterDataProof {
  policyId: string;
  commitment: Hex;
  validAfter: number;
  validUntil: number;
  /** Source-reviewed paymaster behavior: no account asset charge or new allowance. */
  gasOnly: true;
}
export interface UserOperationPaymasterPolicy {
  id: string;
  profile?: "pimlico-v7-legacy-mode" | "pimlico-v7-current-flags";
  maximumPaymasterDataLength?: number;
  contract: UserOperationCodePin;
  /** Host-owned provider policy parameters; never supplied by a client. */
  context: Record<string, unknown>;
  /** Source-specific data decoder/checker for the pinned runtime. No permissive default. */
  inspect(
    operation: UserOperationV07,
    phase: "stub" | "final",
  ): PaymasterDataProof;
}
export interface UserOperationProviderConfig {
  chainId: number;
  providerId: string;
  entryPoint: UserOperationCodePin;
  bundlerUrl: string;
  paymasterUrl?: string;
  /** Private operator-selected origin for current Pimlico restricted-bundler simulation; verified onchain before use. */
  simulationBundlerAddress?: Address;
  /** Operator credentials only; sanitized from every result and error. */
  bundlerHeaders?: Record<string, string>;
  paymasterHeaders?: Record<string, string>;
  paymasterPolicy?: UserOperationPaymasterPolicy;
}
export interface PaymasterStub {
  operation: UserOperationV07;
  isFinal: boolean;
  proof: PaymasterDataProof;
}
export interface UserOperationPreflight {
  operationHash: Hex;
  signedCommitment: Hex;
  evidence: RestBlockEvidence;
  maximumCost: string;
  nonceKey: string;
  nonceSequence: string;
  paymasterProof?: PaymasterDataProof;
  /** The origin the EntryPoint validation is simulated from (a restricted sponsor's bundler, else a dead address). */
  validationOrigin?: Address;
}
/** Trusted compiler output is independently decoded again before receipt evidence is accepted. */
export interface UserOperationExecutionBinding {
  chainId: number;
  entryPoint: UserOperationCodePin;
  accountCode: UserOperationCodePin;
  operation: UserOperationV07;
  operationHash: Hex;
  calls: readonly RestCall[];
}
/** Why one payment attempt reverted, as the SDK's `decodePayFailure` reads it from revert data, with
 * amounts as decimal strings in the failing check's units. Advisory and specific to that attempt:
 * `received` and `minimum` are set only for a shortfall, and any changed minimum needs a fresh
 * preparation, simulation and owner review. The message is the SDK's fixed sentence, never node text. */
export interface PayFailure {
  reason: string;
  received?: string;
  minimum?: string;
  message: string;
}
export interface UserOperationObservation {
  /** `expired`: never included and past its validity window, so it can no longer execute. */
  state: "pending" | "unknown" | "confirming" | "confirmed" | "reverted" | "expired";
  operationHash: Hex;
  transactionHash?: Hex;
  receipt?: StoredReceipt;
  /** Logs are restricted to this operation's execution interval in the EntryPoint bundle. */
  scopedLogs?: readonly unknown[];
  semantic?: SemanticResult;
  reason?: string;
  /** When this observation was made (ms); a poll within moments of it answers from it. */
  observedAt?: number;
  /** The execution block at which the account's authority was verified for this observation. */
  verifiedAtBlock?: Hex;
  /** Why a reverted payment reverted, when its trace shows a known payment revert. */
  payFailure?: PayFailure;
  /** The canonical UserOperationEvent's actualGasCost (wei, decimal), once the EntryPoint reported one. */
  actualGasCost?: string;
}
