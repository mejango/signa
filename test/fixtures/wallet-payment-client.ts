import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PreparedUserOperation } from "../../src/rest/client/smartAccounts.js";
import { encodeSafe7579Execution } from "../../src/rest/smartAccounts/accountExecution.js";
import { encodeSafe7579PasskeyOwnerSignature, safe7579PasskeyOwnerSigningPayload } from "../../src/rest/smartAccounts/passkeySignatures.js";
import { digest } from "../../src/rest/sponsorship/validation.js";
import type { SemanticResult, StoredPlan } from "../../src/rest/transactions/types.js";
import { getUserOperationHash, normalizeUserOperation, userOperationCommitment, userOperationMaximumCost } from "../../src/rest/userOperations/codec.js";
import type { WalletV6UsdcPayment } from "../../src/rest/userOperations/semantics.js";
import type { UserOperationObservation } from "../../src/rest/userOperations/types.js";
import type { WalletAppGrant } from "../../src/rest/wallet/appGrants.js";
import { basePaymentConfiguration } from "../../src/rest/wallet/productionStack.js";
import { verifyWalletAssertion } from "../../src/rest/wallet/webauthn.js";
import { createRegistration, signGet } from "./wallet-enrollment-crypto.js";

const payAbi = parseAbi([
  "function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns (uint256)",
]);

/** Real calldata, commitments and P256 proof; synthetic service records and chain observations.
 * No contract deployment, RPC, passkey device, database admission or payment is proved here.
 */
export function createWalletPaymentClientFixture(nowMs = 1_900_000_000_000, metadata: Hex = "0x",
  { token, directV6Terminal: terminal } = basePaymentConfiguration()) {
  const issuer = "https://wallet.juicebox.center", audience = "https://juicebox.center";
  const origin = "https://beep.biz", callbackUri = `${origin}/center/callback`, rpId = "wallet.juicebox.center";
  const safe = "0x3333333333333333333333333333333333333333" as Address;
  const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032" as Address;
  const safe7579 = "0x7579f2ad53b01c3d8779fe17928e0d48885b0003" as Address;
  const passkeyOwner = "0x9000000000000000000000000000000000000001" as Address;
  const accountId = `eip155:8453:${safe}`, seconds = Math.floor(nowMs / 1000);
  // Publicly known, unfunded fixture key. It authenticates API requests only.
  const appSigner = privateKeyToAccount(`0x${"73".repeat(32)}`);
  const grant: WalletAppGrant = {
    kind: "wallet-app", id: "11111111-1111-4111-8111-111111111111", incarnation: "1", accountId,
    signerAddress: appSigner.address.toLowerCase() as Address, scopes: ["read", "plan", "relay"],
    origin, callbackUri, audience, appGeneration: 1, authorityEpoch: "1", sessionEpoch: "1",
    createdAt: seconds - 1, expiresAt: seconds + 3599, revokedAt: null, retainUntil: seconds + 3599 + 86400,
  };
  const payment: WalletV6UsdcPayment = {
    kind: "v6-usdc-pay", chainId: 8453, account: safe, token, terminal, projectId: "7", amount: "1000000",
    beneficiary: safe, minimumReturnedTokens: "5", memo: "hello", metadata, stepIndexes: [0, 1],
    approvalStepIndexes: [0], paymentStepIndex: 1, resetAllowance: false,
  };
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [terminal, BigInt(payment.amount)] });
  const pay = encodeFunctionData({ abi: payAbi, functionName: "pay", args: [BigInt(payment.projectId), token,
    BigInt(payment.amount), safe, BigInt(payment.minimumReturnedTokens), payment.memo, payment.metadata] });
  const calls: StoredPlan["draft"]["calls"] = [
    { chainId: 8453, to: token, data: approve, value: "0", label: "Approve exact USDC amount", dependsOn: [], decoded: {} },
    { chainId: 8453, to: terminal, data: pay, value: "0", label: "Pay V6 project", dependsOn: [0], decoded: {} },
  ];
  const plan: StoredPlan = {
    id: "22222222-2222-4222-8222-222222222222", actor: { accountId, principalId: `app:${grant.id}:${grant.incarnation}` },
    draft: { operation: "pay", account: safe, project: { chainId: 8453, projectId: payment.projectId, version: 6 },
      calls, evidence: [{ chainId: 8453, blockNumber: "100", blockHash: digest("payment-client:block"),
        timestamp: String(seconds), source: "onchain" }], summary: {
        operation: "pay", project: { chainId: 8453, projectId: payment.projectId, version: 6 }, account: safe, terminal,
        terminalPath: [terminal], routerGateway: null, route: "multi-terminal",
        payment: { token, amount: payment.amount, unit: "token-base-units" }, beneficiary: payment.beneficiary,
        minimumBeneficiaryTokenCount: payment.minimumReturnedTokens, metadata: payment.metadata,
      }, warnings: [] },
    commitment: digest("pending-plan"), createdAt: nowMs - 1000, expiresAt: nowMs + 240_000, revision: 0,
    smartAccount: { bindingId: digest("payment-client:binding"), stateHash: digest("payment-client:state"),
      chainId: 8453, address: safe, manifestRevision: digest("payment-client:manifest") },
    steps: [{ index: 0, state: "waiting" }, { index: 1, state: "waiting" }],
  };
  plan.commitment = digest({ actor: plan.actor, draft: plan.draft, expiresAt: plan.expiresAt, smartAccount: plan.smartAccount });
  const operation = normalizeUserOperation({ sender: safe, nonce: "0x0",
    callData: encodeSafe7579Execution(calls.map(call => ({ target: call.to, value: call.value, callData: call.data }))),
    callGasLimit: "0x186a0", verificationGasLimit: "0xf4240", preVerificationGas: "0xc350",
    maxFeePerGas: "0x64", maxPriorityFeePerGas: "0x1", signature: "0x" });
  const createdAt = nowMs - 500, expiresAt = nowMs + 120_000;
  const signing = { ...safe7579PasskeyOwnerSigningPayload({ operation, chainId: 8453, entryPoint, safe7579,
    validAfter: String(Math.floor(createdAt / 1000)), validUntil: String(Math.floor(expiresAt / 1000)) }),
    ownerProfile: "center-passkey-v1" as const };
  const prepared: PreparedUserOperation = {
    id: "33333333-3333-4333-8333-333333333333", planId: plan.id, planCommitment: plan.commitment,
    stepIndexes: [0, 1], chainId: 8453, entryPoint, operation, operationHash: getUserOperationHash(operation, entryPoint, 8453),
    commitment: digest("pending-operation"), accountBindingId: plan.smartAccount!.bindingId,
    accountStateHash: plan.smartAccount!.stateHash, gasPolicyId: "payment-client-gas", providerId: "payment-client-provider",
    createdAt, expiresAt, revision: 0, state: "prepared", signing,
  };
  prepared.commitment = digest({ planId: prepared.planId, planCommitment: prepared.planCommitment, operation,
    operationHash: prepared.operationHash, accountBindingId: prepared.accountBindingId, accountStateHash: prepared.accountStateHash,
    gasPolicyId: prepared.gasPolicyId, providerId: prepared.providerId, createdAt, expiresAt });
  const expected = { ...payment, maximumNetworkFee: userOperationMaximumCost(operation).toString() };
  const credential = createRegistration({ rpId, origin: issuer, userHandle: Buffer.alloc(32, 6).toString("base64url"),
    credentialId: Buffer.alloc(32, 7).toString("base64url"), challenge: digest("payment-client:registration") });
  const assertion = signGet({ ...credential, rpId, origin: issuer, challenge: signing.digest });
  const verified = verifyWalletAssertion(assertion, { purpose: "payment", rpId, origin: issuer,
    challenge: signing.digest, credential: { id: credential.credentialId, userHandle: credential.userHandle,
      publicKey: credential.publicKey, backupEligible: true }, requireUserHandle: true });
  const signature = encodeSafe7579PasskeyOwnerSignature({ validAfter: signing.validAfter, validUntil: signing.validUntil,
    signatures: [{ kind: "contract", owner: passkeyOwner, signature: verified.contractSignature }] });
  const signedCommitment = userOperationCommitment({ ...operation, signature }, entryPoint, 8453);
  const transactionHash = digest("payment-client:outer-transaction");

  /** Trusted HTTP boundary stand-in, never fabricated RPC execution evidence.
   * confirmed + unknown/failed intentionally models mined execution with unresolved economic effects.
   */
  function observation(state: UserOperationObservation["state"] = "confirmed",
    semanticStatus: SemanticResult["status"] = state === "confirmed" ? "verified" : state === "reverted" ? "failed" : "unknown",
  ): UserOperationObservation {
    if (state === "expired") return { state, operationHash: prepared.operationHash,
      reason: "The operation's validity ended before any inclusion; it can no longer execute." };
    if (state === "pending" || state === "unknown") return { state, operationHash: prepared.operationHash,
      transactionHash, reason: "Synthetic fixture: independent payment evidence is unavailable." };
    return { state, operationHash: prepared.operationHash, transactionHash,
      receipt: { transactionHash, blockHash: digest("payment-client:block"), blockNumber: "100", status: "success",
        canonical: true, confirmations: state === "confirming" ? 1 : 12, observedAt: nowMs + 1000,
        logs: [], logsStored: false, logCount: 2, logsHash: digest("payment-client:omitted-scoped-logs") },
      semantic: { status: semanticStatus, details: { fixture: "Synthetic service semantic result", payment } } };
  }
  function observedOperation(state: UserOperationObservation["state"] = "confirmed", semanticStatus?: SemanticResult["status"]): PreparedUserOperation {
    return { ...structuredClone(prepared), state, revision: 2, observation: observation(state, semanticStatus),
      submission: { commitment: signedCommitment, startedAt: nowMs } };
  }
  return { nowMs, issuer, audience, origin, callbackUri, rpId, accountId, safe, token, terminal, entryPoint, safe7579,
    passkeyOwner, appSigner, grant, plan, prepared, payment, expected, credential, assertion,
    contractSignature: verified.contractSignature, signature, signedCommitment, transactionHash, observation, observedOperation };
}
