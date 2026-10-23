import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { concat, encodeAbiParameters, encodeFunctionData, erc20Abi, hashTypedData, parseAbi, type Address, type Hex } from "viem";
import { createWalletPaymentReviewDraft, validateWalletPaymentReviewDraft, assertWalletPaymentReviewContext,
  verifyWalletPaymentReviewProof, type WalletPaymentReviewContext } from "../src/rest/wallet/paymentReviews.js";
import { createWalletAuthorityContextFixture } from "./fixtures/wallet-authority-context.js";
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { createWalletEnrollmentIntent, prepareWalletEnrollmentCandidate, verifyWalletEnrollmentProof,
  walletEnrollmentDocument, enrollmentDigest, type WalletEnrollment } from "../src/rest/wallet/enrollment.js";
import { createWalletAuthorityIdentity, reconcileWalletAuthority, walletAuthorityContextDigest } from "../src/rest/wallet/authority.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import { walletAppPrincipalId } from "../src/rest/wallet/appGrants.js";
import { encodeSafe7579Execution } from "../src/rest/smartAccounts/accountExecution.js";
import { decodeSafe7579PasskeyOwnerSignature, safe7579PasskeyOwnerSigningPayload } from "../src/rest/smartAccounts/passkeySignatures.js";
import { digest } from "../src/rest/userOperations/store.js";
import { getUserOperationHash, userOperationCommitment, userOperationMaximumCost } from "../src/rest/userOperations/codec.js";
import { createWalletRecoveryIntent, createWalletRecoveryMapping, prepareWalletRecoveryCandidate,
  verifyWalletRecoveryProof, walletRecoveryDocument } from '../src/rest/wallet/recovery.js';
import { passkeyOnboardingDocument } from '../src/rest/smartAccounts/passkeyOnboarding.js';
import { createHookMetadata, getJBContractAddress } from "@bananapus/nana-sdk-core";
import { buildBuybackPayMetadata, buildUserPayMetadata, PAY_QUOTE_FAILED_MESSAGE } from "@bananapus/nana-sdk-core/v6";

const now = 1_800_000_120_000, issuer = "https://wallet.juicebox.center", rpId = "wallet.juicebox.center";
const audience = "https://juicebox.center";
const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const terminal = "0x4444444444444444444444444444444444444444" as Address;
const payAbi = parseAbi(["function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns (uint256)"]);
let base: WalletPaymentReviewContext, credential: ReturnType<typeof createRegistration>;
const options = () => ({ id: randomUUID(), state: randomBytes(32).toString("base64url"), createdAtMs: now });
const context = () => structuredClone(base);
function recommit(c: WalletPaymentReviewContext): void {
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
beforeAll(async () => {
  const authority = await createWalletAuthorityContextFixture(now);
  const manifest = structuredClone(authority.enrollment.intent.manifest);
  manifest.entryPoint = { ...manifest.safe7579, address: "0x0000000071727de22e5e9d8baf0edac6f37da032", version: "0.7" };
  const intent = createWalletEnrollmentIntent({ manifest, rpId, origin: issuer, recoveryOwner: enrollmentBackupAccount.address, expiresAt: now - 60_000 });
  const empty: WalletEnrollment = { intent, createdAt: now - 120_000, state: "awaiting_registration", candidate: null,
    candidateDigest: null, creation: null, possession: null, receipt: null };
  credential = createRegistration({ rpId, origin: issuer, userHandle: intent.userHandle,
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
});
function assertion(draft: ReturnType<typeof createWalletPaymentReviewDraft>, changes: Record<string, unknown> = {}) {
  return signGet({ ...credential, rpId, origin: issuer, challenge: draft.signing.digest, ...changes });
}
describe("owner-approved modeled payment review", () => {
  it('requires a fresh new-key approval after recovery while preserving payment proof format and the Safe', async () => {
    const c = context(), oldDraft = createWalletPaymentReviewDraft(c, options()), originalSafe = c.operation.sender;
    const intent = createWalletRecoveryIntent(c.authority, { rpId, origin: issuer, nowMs: now, expiresAtMs: now + 120000 });
    const nextKey = createRegistration({ rpId, origin: issuer, userHandle: intent.userHandle,
      challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
    const candidate = prepareWalletRecoveryCandidate(intent, nextKey.response), document = walletRecoveryDocument(candidate);
    const proof = await verifyWalletRecoveryProof(candidate, { assertion: signGet({ ...nextKey, rpId, origin: issuer,
      challenge: hashTypedData(document) }), backupSignature: await signBackupProof(document) }, now + 1);
    const b = c.authority.binding, setup = b.authorization.setup!;
    b.state.stateHash = digest('recovered state'); b.state.owners = [candidate.signerAddress, intent.recoveryOwner];
    Object.assign(b.state.ownerProfile!.signer, { address: candidate.signerAddress, ...nextKey.publicKey });
    b.authorization.nonce = digest('recovered setup nonce'); b.authorization.expiresAt = now / 1000 + 300;
    setup.issuedAt = now / 1000; setup.grantId = randomUUID(); setup.grantExpiresAt = now / 1000 + 3600;
    const setupDocument = passkeyOnboardingDocument(audience, { profile: 'center-passkey-v1', address: b.wallet.address,
      manifestId: b.manifestId, nonce: b.authorization.nonce, issuedAt: setup.issuedAt, expiresAt: b.authorization.expiresAt,
      grant: { id: setup.grantId, botAddress: setup.botAddress, scopes: setup.scopes, expiresAt: setup.grantExpiresAt, label: setup.label } }, b.state);
    b.authorization.digest = hashTypedData(setupDocument);
    c.authority = createWalletRecoveryMapping({ intent, candidate, proof }, c.authority, now + 20, audience).context;
    const identity = createWalletAuthorityIdentity(c.authority, { stateHash: b.state.stateHash,
      sessionAdministration: { epoch: '0', hash: digest('administration') }, creationTransaction: digest('creation') });
    const prior = c.authority.prior!;
    c.authority.prior = reconcileWalletAuthority(c.authority, { ...prior.latestObservation!, contextDigest: walletAuthorityContextDigest(c.authority),
      identity, observedAtMs: now + 30, validUntilMs: now + 30030,
      priorAnchor: { status: 'same', expected: prior.acceptedAnchor!, observed: prior.acceptedAnchor! } }, now + 30);
    c.grant.id = randomUUID(); c.grant.authorityEpoch = c.authority.prior.authorityEpoch; c.grant.sessionEpoch = c.authority.prior.sessionEpoch;
    const actor = { accountId: c.grant.accountId, principalId: walletAppPrincipalId(c.grant) };
    c.plan.actor = actor; c.operation.actor = actor; c.plan.smartAccount!.stateHash = b.state.stateHash;
    c.operation.accountStateHash = b.state.stateHash; c.plan.createdAt = c.operation.createdAt = now + 35; recommit(c);
    const reviewed = createWalletPaymentReviewDraft(c, { ...options(), createdAtMs: now + 40 });
    expect(reviewed.operation.sender).toBe(originalSafe); expect(reviewed.authority.credential).not.toHaveProperty('recovery');
    expect(() => assertWalletPaymentReviewContext(reviewed, c)).not.toThrow();
    expect(() => assertWalletPaymentReviewContext(oldDraft, c)).toThrow();
    expect(() => verifyWalletPaymentReviewProof(reviewed, assertion(reviewed))).toThrow();
    const approved = verifyWalletPaymentReviewProof(reviewed, signGet({ ...nextKey, rpId, origin: issuer, challenge: reviewed.signing.digest }));
    expect(decodeSafe7579PasskeyOwnerSignature({ signature: approved.signature, ...reviewed.signing, threshold: 1 })[0]).toMatchObject({ kind: 'contract', owner: candidate.signerAddress });
  });
  it("keeps the enrolled wallet RP origin distinct from the configured REST audience", () => {
    const c = context(), draft = createWalletPaymentReviewDraft(c, options());
    expect(draft.issuer).toBe("https://wallet.juicebox.center");
    expect(draft.grant.audience).toBe("https://juicebox.center");
    expect(validateWalletPaymentReviewDraft(draft)).toEqual(draft);
    expect(() => assertWalletPaymentReviewContext(draft, c)).not.toThrow();
    expect(verifyWalletPaymentReviewProof(draft, assertion(draft)).signature).not.toBe("0x");
  });
  it("builds an immutable exact SafeOp review from server records, without estimation signature", () => {
    const c = context(), draft = createWalletPaymentReviewDraft(c, options());
    expect(draft.operation.signature).toBe("0x");
    expect(draft.expiresAtMs).toBe(c.operation.expiresAt);
    expect(draft.ceremony.challenge).toBe(Buffer.from(draft.signing.digest.slice(2), "hex").toString("base64url"));
    const signing = safe7579PasskeyOwnerSigningPayload({ operation: c.operation.operation, chainId: 8453,
      entryPoint: c.operation.entryPoint, safe7579: c.manifest.safe7579.address,
      validAfter: String(Math.floor(c.operation.createdAt / 1000)), validUntil: String(Math.floor(c.operation.expiresAt / 1000)) });
    expect(draft.signing).toEqual({ digest: signing.digest, signedData: signing.signedData, validAfter: signing.validAfter, validUntil: signing.validUntil });
    expect(Object.isFrozen(draft)).toBe(true); expect(Object.isFrozen(draft.operation)).toBe(true);
    expect(validateWalletPaymentReviewDraft(draft)).toEqual(draft);
    expect(() => assertWalletPaymentReviewContext(draft, c)).not.toThrow();
  });
  it("carries the payer the signed paymaster fields fix in the one review, for every kind", () => {
    // Capped: the account pays, and the review says so with the balance read for it.
    const c = context(), draft = createWalletPaymentReviewDraft(c, options());
    expect(draft.gas).toEqual(c.operation.gas);
    expect(draft.gas).toMatchObject({ payer: "account", reason: "account-cap", funded: true });
    // Sponsored: the paymaster inside the signed operation names Pimlico, recorded or not.
    const sponsored = context(), paymaster = "0x00000000000000fb866daaa79352cc568a005d96" as Address;
    Object.assign(sponsored.operation.operation, { paymaster, paymasterVerificationGasLimit: "0x64", paymasterPostOpGasLimit: "0x0", paymasterData: "0x1234" });
    recommit(sponsored); delete sponsored.operation.gas;
    expect(createWalletPaymentReviewDraft(sponsored, options()).gas).toEqual({ payer: "pimlico", chainId: 8453, paymaster });
    // A recorded payer that disagrees with the signed fields makes no review.
    sponsored.operation.gas = c.operation.gas!;
    expect(() => createWalletPaymentReviewDraft(sponsored, options())).toThrow();
    const unsponsored = context(); delete unsponsored.operation.gas;
    expect(() => createWalletPaymentReviewDraft(unsponsored, options())).toThrow();
    // A stored review whose gas row changed is invalid.
    expect(() => validateWalletPaymentReviewDraft({ ...draft, gas: { ...draft.gas, funded: false } })).toThrow();
  });
  it("binds the plan's quote notice into the review, and nothing else from its warnings", () => {
    const plain = createWalletPaymentReviewDraft(context(), options());
    expect(plain).not.toHaveProperty("notice");
    const c = context(); c.plan.draft.warnings = ["Other warning.", `${PAY_QUOTE_FAILED_MESSAGE} Quote again for the pool price.`]; recommit(c);
    const draft = createWalletPaymentReviewDraft(c, options());
    expect(draft.notice).toBe(PAY_QUOTE_FAILED_MESSAGE);
    expect(validateWalletPaymentReviewDraft(draft)).toEqual(draft);
    expect(() => assertWalletPaymentReviewContext(draft, c)).not.toThrow();
    // The notice is part of the reviewed context: a plan without it no longer matches, and it cannot be edited.
    expect(() => assertWalletPaymentReviewContext(plain, c)).toThrow();
    expect(() => validateWalletPaymentReviewDraft({ ...structuredClone(draft), notice: "Anything else." })).toThrow();
    expect(() => validateWalletPaymentReviewDraft({ ...structuredClone(plain), notice: PAY_QUOTE_FAILED_MESSAGE })).toThrow();
  });
  it("verifies real P256 UV possession and returns the Safe contract owner envelope", () => {
    const draft = createWalletPaymentReviewDraft(context(), options()), proof = verifyWalletPaymentReviewProof(draft, assertion(draft));
    const entries = decodeSafe7579PasskeyOwnerSignature({ signature: proof.signature, ...draft.signing, threshold: 1 });
    expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ kind: "contract", owner: base.authority.binding.state.ownerProfile!.signer.address });
    expect(proof.signedCommitment).toBe(userOperationCommitment({ ...draft.operation, signature: proof.signature }, draft.entryPoint, 8453));
  });
  it("keeps semantic proof stable across fresh signatures and counters while returning each actual envelope", () => {
    const draft = createWalletPaymentReviewDraft(context(), options());
    const a = verifyWalletPaymentReviewProof(draft, assertion(draft)), b = verifyWalletPaymentReviewProof(draft, assertion(draft, { signCount: 42, backedUp: false }));
    expect(a.proofDigest).toBe(b.proofDigest); expect(a.signature).not.toBe(b.signature); expect(a.signedCommitment).not.toBe(b.signedCommitment);
  });
  it("compares immutable context after lifecycle observation changes without reissuing a review", () => {
    const c = context(), draft = createWalletPaymentReviewDraft(c, options());
    c.operation.state = "submission_unknown"; c.operation.revision = 8; c.operation.observation = { state: "unknown", operationHash: c.operation.operationHash };
    c.plan.revision = 3; c.plan.steps[0]!.state = "unknown";
    expect(() => assertWalletPaymentReviewContext(draft, c)).not.toThrow();
  });
  it("accepts an ownership binding whose historical execution flag is false, retaining the current authority identity", () => {
    const c = context(); c.authority.binding.state.executionVerified = false;
    const draft = createWalletPaymentReviewDraft(c, options());
    expect(draft.operationHash).toBe(c.operation.operationHash);
    expect(() => assertWalletPaymentReviewContext(draft, c)).not.toThrow();
  });
  it("caps expiry at the real SafeOp second, app grant and five minute review limit", () => {
    const c = context(); c.operation.expiresAt += 999; recommit(c);
    expect(createWalletPaymentReviewDraft(c, options()).expiresAtMs).toBe(now + 120_000);
    c.grant.expiresAt = now / 1000 + 30; c.grant.retainUntil = c.grant.expiresAt + 86400;
    expect(createWalletPaymentReviewDraft(c, options()).expiresAtMs).toBe(now + 30_000);
    const long = context(); long.operation.expiresAt = now + 600_000; long.plan.expiresAt = now + 900_000; recommit(long);
    expect(createWalletPaymentReviewDraft(long, options()).expiresAtMs).toBe(now + 300_000);
  });
  it("keeps the review identity across ordinary refreshed chain observations", () => {
    const c = context(), draft = createWalletPaymentReviewDraft(c, options()), a = c.authority;
    a.binding.state.safeNonce = "12";
    const prior = a.prior!;
    a.prior = reconcileWalletAuthority(a, { ...prior.latestObservation!, contextDigest: walletAuthorityContextDigest(a),
      observedAtMs: now + 10, validUntilMs: now + 30_010,
      priorAnchor: { status: "same", expected: prior.acceptedAnchor!, observed: prior.acceptedAnchor! } }, now + 10);
    expect(() => assertWalletPaymentReviewContext(draft, c)).not.toThrow();
  });
  it.each(["nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas"] as const)("rejects a different operation %s under the original review", field => {
    const c = context(), draft = createWalletPaymentReviewDraft(c, options()); c.operation.operation[field] = field === "maxPriorityFeePerGas" ? "0x2" : "0x12345"; recommit(c);
    expect(() => assertWalletPaymentReviewContext(draft, c)).toThrow();
  });
  it.each(["issuer", "state", "operationHash", "operationId", "planCommitment", "entryPoint", "safe7579", "expiresAtMs"])("rejects changed stored review %s", field => {
    const draft = structuredClone(createWalletPaymentReviewDraft(context(), options())) as any;
    draft[field] = field === "expiresAtMs" ? draft[field] + 1 : field === "issuer" ? "https://evil.example" : field === "state" ? randomBytes(32).toString("base64url") : field.endsWith("Id") ? randomUUID() : digest("other");
    expect(() => validateWalletPaymentReviewDraft(draft)).toThrow();
  });
  it("requires exact grant principal, incarnation, epochs, authority identity, configured terminal and token", () => {
    const draft = createWalletPaymentReviewDraft(context(), options());
    for (const change of [(c: WalletPaymentReviewContext) => { c.grant.incarnation = "2"; },
      (c: WalletPaymentReviewContext) => { c.grant.sessionEpoch = "2"; },
      (c: WalletPaymentReviewContext) => { c.operation.actor.principalId = "owner:" + c.grant.accountId; },
      (c: WalletPaymentReviewContext) => { c.authority.binding.authorization.digest = digest("other"); },
      (c: WalletPaymentReviewContext) => { c.token = terminal; },
      (c: WalletPaymentReviewContext) => { c.directV6Terminal = token; }]) {
      const c = context(); change(c); expect(() => assertWalletPaymentReviewContext(draft, c)).toThrow();
    }
  });
  it("requires full modeled payment and rejects operation calldata outside the selected plan", () => {
    for (const change of [(c: WalletPaymentReviewContext) => { c.plan.draft.operation = "arbitrary"; },
      (c: WalletPaymentReviewContext) => { c.operation.stepIndexes = [0]; },
      (c: WalletPaymentReviewContext) => { c.operation.operation.callData = encodeSafe7579Execution([{ target: terminal, value: "1", callData: "0x" }]); },
      (c: WalletPaymentReviewContext) => { c.operation.session = {} as any; }]) {
      const c = context(); change(c); recommit(c); expect(() => createWalletPaymentReviewDraft(c, options())).toThrow();
    }
  });
  it("rejects modified token amounts, beneficiaries and minimums even when plan and operation hashes are recomputed", () => {
    const draft = createWalletPaymentReviewDraft(context(), options());
    for (const changed of [[8n, token, 1_000_000n, base.plan.draft.account, 5n, "hello", "0x"],
      [7n, token, 1_000_000n, terminal, 5n, "hello", "0x"], [7n, token, 1_000_000n, base.plan.draft.account, 0n, "hello", "0x"]] as const) {
      const c = context(); c.plan.draft.calls[1]!.data = encodeFunctionData({ abi: payAbi, functionName: "pay", args: changed });
      c.operation.operation.callData = encodeSafe7579Execution(c.plan.draft.calls.map(call => ({ target: call.to, callData: call.data, value: call.value })));
      recommit(c); expect(() => assertWalletPaymentReviewContext(draft, c)).toThrow();
    }
  });
  it("admits any Juicebox hook metadata, whatever its buyback minimum", () => {
    const withMetadata = (metadata: Hex) => {
      const c = context(), summary = c.plan.draft.summary as { metadata: Hex };
      c.plan.draft.calls[1]!.data = encodeFunctionData({ abi: payAbi, functionName: "pay",
        args: [7n, token, 1_000_000n, c.plan.draft.account, 5n, "hello", metadata] });
      summary.metadata = metadata;
      c.operation.operation.callData = encodeSafe7579Execution(c.plan.draft.calls.map(call => ({ target: call.to, callData: call.data, value: call.value })));
      recommit(c); return c;
    };
    const registry = getJBContractAddress("JBBuybackHookRegistry", 6, 8453), userPay = buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 5n });
    for (const metadata of [
      buildUserPayMetadata({ chainId: 8453 }), userPay,
      buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 5n, tiers: { metadataIdTarget: terminal, tierIdsToMint: [1n, 1n] } }),
      buildBuybackPayMetadata({ hook: registry, amountToSwapWith: 0n, minimumSwapAmountOut: 5n }),
      buildBuybackPayMetadata({ hook: registry, amountToSwapWith: 1n, minimumSwapAmountOut: 5n, skipSplits: true }),
      buildBuybackPayMetadata({ hook: terminal, amountToSwapWith: 0n, minimumSwapAmountOut: 5n, skipSplits: true }),
      createHookMetadata(["0xdeadbeef"], [`0x${"ab".repeat(40)}`]),
      // A buyback minimum above the terminal minimum (5): with the reserved split honored it covers the
      // swap and leftover mint before the split. It can only revert the pay; the terminal minimum holds.
      buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 6n, skipSplits: false }),
      buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 6n, tiers: { metadataIdTarget: terminal, tierIdsToMint: [1n] } }),
      createHookMetadata(["0xdeadbeef"], [encodeAbiParameters([{ type: "bool" }, { type: "uint16[]" }], [true, []])]),
    ] as Hex[]) {
      const draft = createWalletPaymentReviewDraft(withMetadata(metadata), options());
      expect(validateWalletPaymentReviewDraft(draft)).toEqual(draft);
    }
    for (const metadata of [
      concat([userPay, "0x00"]), userPay.slice(0, -2) as Hex, "0x1234" as Hex,
    ]) expect(() => createWalletPaymentReviewDraft(withMetadata(metadata), options())).toThrow();
  });
  it("rejects corrupted plan and operation commitments before requesting owner approval", () => {
    for (const field of ["plan", "operation"] as const) {
      const c = context(); c[field].commitment = digest("corrupt");
      expect(() => createWalletPaymentReviewDraft(c, options())).toThrow();
    }
  });
  it("rejects wrong purpose digest, origin, RP, user handle, key and missing UV", () => {
    const draft = createWalletPaymentReviewDraft(context(), options());
    for (const changed of [assertion(draft, { challenge: digest("login") }), assertion(draft, { origin: "https://evil.example" }),
      assertion(draft, { rpId: "evil.example" }), { ...assertion(draft), userHandle: randomBytes(32).toString("base64url") },
      { ...assertion(draft), credentialId: randomBytes(32).toString("base64url") }])
      expect(() => verifyWalletPaymentReviewProof(draft, changed)).toThrowError(expect.objectContaining({ code: "WALLET_PAYMENT_REVIEW_PROOF_INVALID" }));
    const noUv = assertion(draft); noUv.authenticatorData[32]! &= ~4;
    expect(() => verifyWalletPaymentReviewProof(draft, noUv)).toThrow();
  });
  it("accepts allowCredentials assertions with a null user handle while pinning exact credential ID and key", () => {
    const draft = createWalletPaymentReviewDraft(context(), options());
    const a = assertion(draft), b = { ...a, userHandle: null };
    expect(verifyWalletPaymentReviewProof(draft, b).proofDigest).toBe(verifyWalletPaymentReviewProof(draft, a).proofDigest);
  });
  it("rejects a genuine assertion from a different P256 private key", () => {
    const draft = createWalletPaymentReviewDraft(context(), options());
    const other = createRegistration({ rpId, origin: issuer, userHandle: credential.userHandle, challenge: draft.signing.digest });
    expect(() => verifyWalletPaymentReviewProof(draft, assertion(draft, { key: other.key }))).toThrow();
  });
  it("does not execute assertion byte iterators or getters and rejects proxy byte views", () => {
    const draft = createWalletPaymentReviewDraft(context(), options()); let calls = 0;
    const a = assertion(draft), original = verifyWalletPaymentReviewProof(draft, a);
    Object.defineProperty(a.authenticatorData, Symbol.iterator, { value() { calls++; throw new Error("iterator"); } });
    Object.defineProperty(a.authenticatorData, "byteLength", { get() { calls++; throw new Error("length"); } });
    expect(verifyWalletPaymentReviewProof(draft, a)).toEqual(original); expect(calls).toBe(0);
    expect(() => verifyWalletPaymentReviewProof(draft, { ...a, authenticatorData: new Proxy(a.authenticatorData, {}) })).toThrow();
    Object.defineProperty(a, "signature", { get() { calls++; throw new Error("signature"); } });
    expect(() => verifyWalletPaymentReviewProof(draft, a)).toThrow(); expect(calls).toBe(0);
  });
  it("rejects getters, proxies, hidden fields and large public trees without executing user code", () => {
    let calls = 0;
    const c = context(); Object.defineProperty(c.operation.operation, "nonce", { enumerable: true, get() { calls++; return "0x0"; } });
    expect(() => createWalletPaymentReviewDraft(c, options())).toThrow(); expect(calls).toBe(0);
    const proxy = new Proxy(context(), { ownKeys() { calls++; return []; } });
    expect(() => createWalletPaymentReviewDraft(proxy, options())).toThrow(); expect(calls).toBe(0);
    const large = context(); large.plan.draft.summary = "x".repeat(1_048_577);
    expect(() => createWalletPaymentReviewDraft(large, options())).toThrow();
    const draft = structuredClone(createWalletPaymentReviewDraft(context(), options())); Object.defineProperty(draft, "authorityOverride", { value: true });
    expect(() => validateWalletPaymentReviewDraft(draft)).toThrow();
  });
});
