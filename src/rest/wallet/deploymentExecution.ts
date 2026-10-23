import { isAddress, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { RestError } from "../core.js";
import type { ServerSigner } from "../signer.js";
import { enrollmentDigest } from "./enrollment.js";
import { prepareWalletDeploymentTemplate, validateSignedWalletDeployment } from "./deployment.js";
import { walletDeploymentRelayPolicy } from "./deploymentPostgres.js";
import { assertWalletDeploymentDispatchAdmission, walletDeploymentDispatchLimits } from "./deploymentDispatch.js";
import type { WalletDeploymentObservation } from "./deploymentObservation.js";
import type { WalletDeploymentOperation, WalletDeploymentObservationCommit, WalletDeploymentSignedCommit } from "./deploymentPostgres.js";
import type { WalletDeploymentDispatchAdmission, WalletDeploymentDispatchClaim, WalletDeploymentDispatchJournal,
  WalletDeploymentDispatchSettlement, WalletDeploymentExecutionContext } from "./deploymentDispatch.js";

export interface WalletDeploymentExecutionStore {
  loadExecutionContext(operationId: string): Promise<WalletDeploymentExecutionContext>;
  leaseSigning(operationId: string, durationMs?: number): Promise<{ operation: WalletDeploymentOperation;
    leaseToken: string | null; leaseUntil: number | null; revision: number }>;
  persistSigned(input: WalletDeploymentSignedCommit): Promise<{ operation: WalletDeploymentOperation; replayed: boolean }>;
  saveObservation(input: WalletDeploymentObservationCommit): Promise<{ operation: WalletDeploymentOperation; replayed: boolean }>;
  leaseDispatch(input: WalletDeploymentDispatchClaim): Promise<WalletDeploymentDispatchJournal>;
  settleDispatch(input: WalletDeploymentDispatchSettlement): Promise<{ journal: WalletDeploymentDispatchJournal; replayed: boolean }>;
}
export interface WalletDeploymentExperimentalTransport {
  admit(context: WalletDeploymentExecutionContext, signal?: AbortSignal): Promise<WalletDeploymentDispatchAdmission>;
  broadcast(admission: WalletDeploymentDispatchAdmission, signal?: AbortSignal, dispatchLeaseUntil?: number): Promise<"accepted" | "unknown">;
}
export interface WalletDeploymentExecutionOptions {
  store: WalletDeploymentExecutionStore;
  signer: ServerSigner;
  chain: { observeSigned(context: Pick<WalletDeploymentExecutionContext, "enrollment" | "operation">,
    signal?: AbortSignal, options?: { inspection?: "full" | "inclusion" }): Promise<WalletDeploymentObservation> };
  experimentalTransport?: WalletDeploymentExperimentalTransport;
  signingTimeoutMs?: number;
  signingLeaseMs?: number;
  dispatchLeaseMs?: number;
}

/** Internal durable-operation coordinator. No public request principal can supply an enrollment,
 * signing template, raw transaction, admission or destination to this boundary. */
export function createWalletDeploymentExecution(options: WalletDeploymentExecutionOptions) {
  const { store, chain, signer, experimentalTransport } = options;
  const signingTimeoutMs = options.signingTimeoutMs ?? 3000, signingLeaseMs = options.signingLeaseMs ?? 15_000;
  const dispatchLeaseMs = options.dispatchLeaseMs ?? walletDeploymentDispatchLimits.leaseMs;
  function fail(code = "WALLET_DEPLOYMENT_CONFLICT", status = 409): never {
    throw new RestError(status, code, "The durable deployment could not complete this bounded execution step.");
  }
  if (!isAddress(signer.address) || ![signingTimeoutMs, signingLeaseMs, dispatchLeaseMs].every(Number.isSafeInteger) ||
      signingTimeoutMs < 1 || signingTimeoutMs > 10_000 || signingLeaseMs < 1 || signingLeaseMs > 120_000 ||
      dispatchLeaseMs < 1 || dispatchLeaseMs > walletDeploymentDispatchLimits.leaseMs) fail("WALLET_DEPLOYMENT_INVALID", 400);
  const signerAddress = signer.address.toLowerCase();
  async function load(operationId: string) {
    const context = structuredClone(await store.loadExecutionContext(operationId)), { operation, pool, enrollment } = context;
    if (operation.id !== operationId || operation.state === "prepared" || !operation.template || !operation.admission ||
        operation.poolId !== pool.configuration.id || operation.poolConfigurationDigest !== pool.configurationDigest ||
        enrollmentDigest(pool.configuration) !== pool.configurationDigest || pool.activeOperationId !== operationId ||
        operation.template.sender.toLowerCase() !== signerAddress || pool.configuration.sender.toLowerCase() !== signerAddress) fail();
    const tx = operation.template.transaction, expected = prepareWalletDeploymentTemplate(enrollment, operation.approval,
      { sender: operation.template.sender, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas },
      walletDeploymentRelayPolicy(pool.configuration));
    if (enrollmentDigest(expected) !== enrollmentDigest(operation.template) || `0x${enrollmentDigest(expected)}` !== operation.templateCommitment) fail();
    if (operation.state === "signed") {
      if (!operation.signed) fail();
      const signed = await validateSignedWalletDeployment({ enrollment, approval: operation.approval, template: expected,
        rawTransaction: operation.signed.rawTransaction, policy: walletDeploymentRelayPolicy(pool.configuration) });
      if (signed.hash !== operation.signed.hash || signed.maximumExecutionCost !== operation.signed.maximumExecutionCost) fail();
    }
    return context;
  }
  function cancelled(signal?: AbortSignal) { if (signal?.aborted) fail("WALLET_DEPLOYMENT_CANCELLED", 499); }
  async function sign(operationId: string, signal?: AbortSignal): Promise<WalletDeploymentOperation> {
    cancelled(signal);
    const before = await load(operationId);
    if (before.operation.signed) return before.operation;
    if (before.pool.state !== "active") fail();
    const lease = await store.leaseSigning(operationId, signingLeaseMs);
    if (lease.operation.signed) return (await load(operationId)).operation;
    if (!lease.leaseToken || !lease.operation.template ||
        enrollmentDigest(lease.operation.template) !== enrollmentDigest(before.operation.template)) fail();
    const tx = lease.operation.template.transaction;
    // Explicit projection gives even a mutable/async signer only the frozen type-2 transaction.
    const transaction: TransactionSerializableEIP1559 = { type: "eip1559", chainId: 8453, to: tx.to, data: tx.data, value: 0n,
      nonce: Number(tx.nonce), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), accessList: [] };
    cancelled(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signingTimedOut = false;
    const deadline = performance.now() + signingTimeoutMs;
    let rawTransaction: Hex;
    try {
      rawTransaction = await Promise.race([Promise.resolve().then(() => signer.signTransaction(transaction)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { signingTimedOut = true; reject(new RestError(504,
          "WALLET_DEPLOYMENT_SIGNING_TIMEOUT", "The configured signer exceeded its deadline.")); }, signingTimeoutMs); })]);
      if (signingTimedOut || performance.now() >= deadline) fail("WALLET_DEPLOYMENT_SIGNING_TIMEOUT", 504);
    } catch {
      if (signingTimedOut || performance.now() >= deadline) fail("WALLET_DEPLOYMENT_SIGNING_TIMEOUT", 504);
      fail("WALLET_DEPLOYMENT_SIGNING_UNAVAILABLE", 503);
    } finally { if (timer) clearTimeout(timer); }
    cancelled(signal);
    try { await store.persistSigned({ operationId, leaseToken: lease.leaseToken, revision: lease.revision, rawTransaction }); }
    catch (error) {
      // A lost COMMIT response or stale signer may still have a durable winner. Never use the
      // local candidate as dispatch authority; only a separately reloaded, validated winner.
      const current = await load(operationId);
      if (current.operation.signed) return current.operation;
      throw error;
    }
    const current = await load(operationId);
    if (!current.operation.signed) fail();
    return current.operation;
  }
  return {
    sign,
    /** "accepted" is the exact provider hash response only. "observed" also includes unknown
     * evidence: callers must inspect operation.observation, never infer wallet readiness from it. */
    async recover(operationId: string, signal?: AbortSignal): Promise<{
      operation: WalletDeploymentOperation; dispatch: "disabled" | "observed" | "accepted" | "unknown";
      journal: WalletDeploymentDispatchJournal | null;
    }> {
      cancelled(signal);
      let context = await load(operationId);
      if (!context.operation.signed) { await sign(operationId, signal); context = await load(operationId); }
      const before = context.operation;
      // The pass needs the inclusion, not the wallet's state: the page is told at the receipt and
      // the lane is released on the nonce; the inspection runs behind (signup's pass, activation).
      const observation = await chain.observeSigned(structuredClone({ enrollment: context.enrollment, operation: before }), signal, { inspection: "inclusion" });
      await store.saveObservation({ operationId, expectedRevision: before.revision, signedHash: before.signed!.hash, observation });
      context = await load(operationId);
      if (!experimentalTransport) return { operation: context.operation, dispatch: "disabled", journal: null };
      const latest = context.operation.observation;
      if (latest?.transaction.state !== "not-observed" || latest.wallet.state !== "undeployed" ||
          context.operation.historicalCanonicalObservation?.finality.state === "finalized")
        return { operation: context.operation, dispatch: "observed", journal: null };
      cancelled(signal);
      const admission = await experimentalTransport.admit(structuredClone(context), signal);
      assertWalletDeploymentDispatchAdmission(admission, context, Date.now());
      const journal = await store.leaseDispatch({ operationId, expectedRevision: context.operation.revision,
        signedHash: context.operation.signed!.hash, admission, leaseMs: dispatchLeaseMs });
      // Durable claim precedes the single physical send. Aborts/errors after this boundary are
      // unknown outcomes, not cancelled transactions; a stale sender can finish with these bytes.
      let status: "accepted" | "unknown" = "unknown";
      if (!signal?.aborted && Date.now() < journal.leaseUntil) {
        try { status = await experimentalTransport.broadcast(admission, signal, journal.leaseUntil); } catch { /* retain liability */ }
      }
      try {
        const settled = await store.settleDispatch({ operationId, expectedRevision: journal.revision,
          leaseToken: journal.leaseToken, signedHash: journal.transactionHash, status });
        return { operation: (await load(operationId)).operation, dispatch: status, journal: settled.journal };
      } catch {
        throw new RestError(503, "WALLET_DEPLOYMENT_DISPATCH_UNCERTAIN",
          "A durable attempt exists and delivery may have occurred. Reconcile the same operation and transaction hash.",
          { operationId, transactionHash: journal.transactionHash });
      }
    },
  };
}
