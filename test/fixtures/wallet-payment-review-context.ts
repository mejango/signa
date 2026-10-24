// The passkey Safe, grant, plan and operation a payment review is drafted from: real enrollment
// crypto and commitments, synthetic service records. Shared by the review suites.
import { randomUUID } from "node:crypto";
import { encodeFunctionData, erc20Abi, hashTypedData, parseAbi, type Address } from "viem";
import type { WalletPaymentReviewContext } from "../../src/rest/wallet/paymentReviews.js";
import { createWalletAuthorityContextFixture } from "./wallet-authority-context.js";
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from "./wallet-enrollment-crypto.js";
import { createWalletEnrollmentIntent, prepareWalletEnrollmentCandidate, verifyWalletEnrollmentProof, walletEnrollmentDocument, enrollmentDigest, type WalletEnrollment } from "../../src/rest/wallet/enrollment.js";
import { createWalletAuthorityIdentity, reconcileWalletAuthority, walletAuthorityContextDigest } from "../../src/rest/wallet/authority.js";
import { fingerprint } from "../../src/rest/smartAccounts/service.js";
import { walletAppPrincipalId } from "../../src/rest/wallet/appGrants.js";
import { encodeSafe7579Execution } from "../../src/rest/smartAccounts/accountExecution.js";
import { digest } from "../../src/rest/userOperations/store.js";
import { getUserOperationHash, userOperationMaximumCost } from "../../src/rest/userOperations/codec.js";

export const now = 1_800_000_120_000, issuer = "https://wallet.juicebox.center", rpId = "wallet.juicebox.center";
export const audience = "https://juicebox.center";
export const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
export const terminal = "0x4444444444444444444444444444444444444444" as Address;
export const payAbi = parseAbi(["function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns (uint256)"]);
/** Recomputes the plan and operation commitments after a test changes them. */
export function recommit(c: WalletPaymentReviewContext): void {
  c.plan.commitment = digest({ actor: c.plan.actor, draft: c.plan.draft, expiresAt: c.plan.expiresAt, smartAccount: c.plan.smartAccount });
  const r = c.operation;
  r.planCommitment = c.plan.commitment;
  r.operationHash = getUserOperationHash(r.operation, r.entryPoint, r.chainId);
  // The cap left the operation for the account to pay, and its balance covers the gas.
  r.gas = { payer: "account", chainId: r.chainId, maximumWei: userOperationMaximumCost(r.operation).toString(), reason: "account-cap",
    balanceWei: (10n ** 18n).toString(), funded: true };
  r.commitment = digest({ planId: r.planId, planCommitment: r.planCommitment, operation: r.operation, operationHash: r.operationHash,
    accountBindingId: r.accountBindingId, accountStateHash: r.accountStateHash, gasPolicyId: r.gasPolicyId,
    providerId: r.providerId, createdAt: r.createdAt, expiresAt: r.expiresAt });
}
/** A real enrolled passkey Safe with a live app grant and a prepared Base USDC payment. */
export async function createWalletPaymentReviewContextFixture() {
  let base: WalletPaymentReviewContext;
  const authority = await createWalletAuthorityContextFixture(now);
  const manifest = structuredClone(authority.enrollment.intent.manifest);
  manifest.entryPoint = { ...manifest.safe7579, address: "0x0000000071727de22e5e9d8baf0edac6f37da032", version: "0.7" };
  const intent = createWalletEnrollmentIntent({ manifest, rpId, origin: issuer, recoveryOwner: enrollmentBackupAccount.address, expiresAt: now - 60_000 });
  const empty: WalletEnrollment = { intent, createdAt: now - 120_000, state: "awaiting_registration", candidate: null,
    candidateDigest: null, creation: null, possession: null, receipt: null };
  const credential = createRegistration({ rpId, origin: issuer, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}` });
  const pending: WalletEnrollment = { ...empty, ...prepareWalletEnrollmentCandidate(empty, credential.response), state: "awaiting_possession" };
  const document = walletEnrollmentDocument(pending), proof = await verifyWalletEnrollmentProof(pending, {
    assertion: signGet({ ...credential, rpId, origin: issuer, challenge: hashTypedData(document) }), backupSignature: await signBackupProof(document) });
  const safe = pending.creation!.address, accountId = `eip155:8453:${safe.toLowerCase()}`;
  authority.enrollment = { ...pending, state: "verified", receipt: { id: intent.id, enrollmentId: intent.id, accountId,
    credentialId: credential.credentialId, initializerHash: pending.creation!.initializerHash, manifestCommitment: `0x${enrollmentDigest(manifest)}`,
    manifestRevision: manifest.revision, creationCommitment: `0x${enrollmentDigest(pending.creation)}`,
    verificationDigest: proof.verificationDigest, verifiedAt: now - 119_999 } };
  authority.accountId = accountId;
  authority.credential = { accountId, enrollmentId: intent.id, rpId, credentialId: credential.credentialId, userHandle: credential.userHandle,
    publicKey: credential.publicKey, backupEligible: true, verifiedAtMs: now - 119_999, supersededAtMs: null };
  const b = authority.binding, signer = pending.creation!.bootstrap.signerAddress;
  b.id = fingerprint({ ownerAccountId: accountId, wallet: safe, chainId: 8453 });
  b.ownerAccountId = accountId; b.ownerAddress = safe; b.wallet.address = safe;
  b.authorization.setup!.initializerHash = pending.creation!.initializerHash;
  b.state.address = safe; b.state.owners = [signer, intent.recoveryOwner]; b.state.executionVerified = true;
  (b.state.modules!.details as any).provenance.initializerHash = pending.creation!.initializerHash;
  b.state.ownerProfile!.signer = { ...b.state.ownerProfile!.signer, address: signer, ...credential.publicKey };
  const identity = createWalletAuthorityIdentity(authority, { stateHash: b.state.stateHash,
    sessionAdministration: { epoch: "0", hash: digest("administration") }, creationTransaction: digest("creation") });
  authority.prior = reconcileWalletAuthority(authority, { version: "center-wallet-authority-observation-v1", accountId,
    contextDigest: walletAuthorityContextDigest(authority), observedAtMs: now, validUntilMs: now + 30_000, head: b.state.evidence,
    priorAnchor: { status: "none", expected: null, observed: null }, identity, eligibility: "matched", reason: null }, now);
  const grant: WalletPaymentReviewContext["grant"] = { kind: "wallet-app", id: randomUUID(), incarnation: "1", accountId,
    signerAddress: "0x2222222222222222222222222222222222222222", scopes: ["read", "plan", "relay"], origin: "https://beep.juicebox.money",
    callbackUri: "https://beep.juicebox.money/wallet/callback", audience, appGeneration: 1, authorityEpoch: "1", sessionEpoch: "1",
    createdAt: now / 1000 - 1, expiresAt: now / 1000 + 3599, revokedAt: null, retainUntil: now / 1000 + 3599 + 86400 };
  const actor = { accountId, principalId: walletAppPrincipalId(grant) };
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [terminal, 1_000_000n] });
  const pay = encodeFunctionData({ abi: payAbi, functionName: "pay", args: [7n, token, 1_000_000n, safe, 5n, "hello", "0x"] });
  const calls = [{ chainId: 8453, to: token, data: approve, value: "0", label: "Approve", dependsOn: [], decoded: {} },
    { chainId: 8453, to: terminal, data: pay, value: "0", label: "Pay", dependsOn: [0], decoded: {} }];
  const plan: WalletPaymentReviewContext["plan"] = { id: randomUUID(), actor, draft: { operation: "pay", account: safe,
    project: { chainId: 8453, projectId: "7", version: 6 }, calls, evidence: [b.state.evidence], summary: {
      operation: "pay", project: { chainId: 8453, projectId: "7", version: 6 }, account: safe, terminal,
      terminalPath: [terminal], routerGateway: null, route: "multi-terminal", payment: { token, amount: "1000000", unit: "token-base-units" },
      beneficiary: safe, minimumBeneficiaryTokenCount: "5", metadata: "0x" }, warnings: [] },
    commitment: digest("pending"), createdAt: now - 1000, expiresAt: now + 240_000, revision: 0,
    smartAccount: { bindingId: b.id, stateHash: b.state.stateHash, chainId: 8453, address: safe, manifestRevision: manifest.revision },
    steps: calls.map((_, index) => ({ index, state: "waiting" })) };
  const operation: WalletPaymentReviewContext["operation"] = { id: randomUUID(), actor, planId: plan.id, planCommitment: plan.commitment,
    stepIndexes: [0, 1], chainId: 8453, entryPoint: manifest.entryPoint.address, sender: safe.toLowerCase() as Address,
    operation: { sender: safe.toLowerCase() as Address, nonce: "0x0", callData: encodeSafe7579Execution(calls.map(c => ({ target: c.to, value: c.value, callData: c.data }))),
      callGasLimit: "0x186a0", verificationGasLimit: "0x30d40", preVerificationGas: "0xc350", maxFeePerGas: "0x64", maxPriorityFeePerGas: "0x1", signature: "0xabcd" },
    operationHash: digest("pending"), preparationKey: "prepare-payment-001", inputHash: digest("input"), commitment: digest("pending"),
    accountBindingId: b.id, accountStateHash: b.state.stateHash, gasPolicyId: "gas", providerId: "provider", createdAt: now - 500,
    expiresAt: now + 120_000, revision: 0, state: "prepared" };
  base = { issuer, token, directV6Terminal: terminal, grant, authority, plan, operation, manifest }; recommit(base);
  return { base: base!, credential };
}
