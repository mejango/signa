import { isProxy } from "node:util/types";
import { isAddress, size, type Address, type Hex } from "viem";
import { RestError } from "../core.js";
import type { SmartAccountManifest } from "../smartAccounts/types.js";
import type { StoredPlan } from "../transactions/types.js";
import { assertNew, defaultCodec, digest, type UserOperationRecord } from "../userOperations/store.js";
import { assertNewPlan } from "../transactions/store.js";
import { assertSafe7579Execution, decodeSafe7579Execution } from "../smartAccounts/accountExecution.js";
import { encodeSafe7579PasskeyOwnerSignature, safe7579PasskeyOwnerSigningPayload } from "../smartAccounts/passkeySignatures.js";
import { getUserOperationHash, normalizeUserOperation, uoCanonical, userOperationCommitment } from "../userOperations/codec.js";
import { userOperationPasskeyProfile } from "../userOperations/passkeyVerification.js";
import { PASSKEY_MAX_SIGNATURE_BYTES } from "../userOperations/passkeyEstimation.js";
import type { UserOperationV07 } from "../userOperations/types.js";
import { recognizeWalletV6UsdcPayment, type WalletV6UsdcPayment } from "../userOperations/semantics.js";
import { passkeyPayMetadataSteps } from "../userOperations/userPayMetadata.js";
import { validateWalletAppGrant, walletAppFields, walletAppPrincipalId, walletAppBigint, type WalletAppGrant } from "./appGrants.js";
import { createWalletAuthorityIdentity, validateWalletAuthorityContext, walletAuthorityIdentityDigest,
  type WalletAuthorityContext, type WalletAuthorityCredential } from "./authority.js";
import { assertWalletCeremonyDraft, type WalletCeremonyDraft } from "./ceremonies.js";
import { validateWalletRpConfiguration, verifyWalletAssertion, type WalletAssertion } from "./webauthn.js";
import { validateWalletPolicyOrigin } from "./policy.js";
import { validateWalletHandoffToken } from "./handoff.js";
import { PAY_QUOTE_FAILED_MESSAGE } from "@bananapus/nana-sdk-core/v6";
import { SIGNA_HOME_CHAIN_ID } from "./chains.js";
import { checkReviewGas, type ReviewGas } from "../sponsorCaps.js";

export interface WalletPaymentReviewContext {
  issuer: string;
  token: Address;
  directV6Terminal: Address;
  grant: WalletAppGrant;
  authority: WalletAuthorityContext;
  plan: StoredPlan;
  operation: UserOperationRecord;
  manifest: SmartAccountManifest;
}
/** What a draft asks the owner to approve. Each kind carries its own recognized facts. */
export type WalletReview = { kind: "v6-usdc-pay"; payment: WalletV6UsdcPayment };
export interface WalletReviewDraft {
  version: "center-wallet-payment-review-v1";
  id: string;
  state: string;
  issuer: string;
  grant: WalletAppGrant;
  authority: {
    accountId: string;
    enrollmentId: string;
    credential: WalletAuthorityCredential;
    authorityIdentityDigest: Hex;
    authorityEpoch: string;
    sessionEpoch: string;
    bindingId: Hex;
    bindingAuthorizationDigest: Hex;
    stateHash: Hex;
    manifestRevision: Hex;
    signer: Address;
  };
  planId: string;
  planCommitment: Hex;
  operationId: string;
  operationCommitment: Hex;
  operationHash: Hex;
  stepIndexes: number[];
  operation: UserOperationV07;
  chainId: typeof SIGNA_HOME_CHAIN_ID;
  entryPoint: Address;
  safe7579: Address;
  review: WalletReview;
  /** Who pays the gas, as the signed paymaster fields fix it; every kind of review shows it. */
  gas: ReviewGas;
  /** The SDK's notice when the plan's quote could not read the pool price; absent otherwise. */
  notice?: typeof PAY_QUOTE_FAILED_MESSAGE;
  signing: { digest: Hex; signedData: Hex; validAfter: string; validUntil: string };
  createdAtMs: number;
  expiresAtMs: number;
  ceremony: WalletCeremonyDraft;
}
export interface WalletPaymentReviewProof {
  proofDigest: string;
  signature: Hex;
  signedCommitment: Hex;
}
export const walletPaymentReviewMaximumLifetimeMs = 300_000;
function invalid(): never {
  throw new RestError(400, "WALLET_PAYMENT_REVIEW_INVALID", "Wallet payment review context is invalid.");
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const word = /^0x[0-9a-f]{64}$/;
const same = (a: unknown, b: unknown) => uoCanonical(a) === uoCanonical(b);
const address = (value: unknown): Address => {
  if (typeof value !== "string" || !isAddress(value) || BigInt(value) <= 1n) invalid();
  return value.toLowerCase() as Address;
};
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const fields = (value: unknown, keys: string[]) => walletAppFields(value, keys);
function snapshot<T>(value: T, depth = 0, budget = { nodes: 0, bytes: 0 }): T {
  if (++budget.nodes > 8192 || depth > 24) invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid(); return value; }
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (value.length > 131_072 || budget.bytes > 524_288) invalid(); return value;
  }
  if (!value || typeof value !== "object" || isProxy(value)) invalid();
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 256 || keys.length !== value.length + 1) invalid();
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
      return snapshot(descriptor.value, depth + 1, budget);
    }) as T;
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || keys.length > 64) invalid();
  const entries = keys.map(key => {
    if (typeof key !== "string" || key.length > 128) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
    return [key, snapshot(descriptor.value, depth + 1, budget)];
  });
  return Object.fromEntries(entries) as T;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function signing(draft: Pick<WalletReviewDraft, "operation" | "chainId" | "entryPoint" | "safe7579">,
  validAfter: string, validUntil: string): WalletReviewDraft["signing"] {
  const p = safe7579PasskeyOwnerSigningPayload({ ...draft, validAfter, validUntil });
  return { digest: p.digest, signedData: p.signedData, validAfter: p.validAfter, validUntil: p.validUntil };
}
/** The stored JSON keeps the payment under `payment`: rows written by this build read in the previous one. */
export function walletReviewToStored<T extends { review: WalletReview }>(draft: T): Omit<T, "review"> & { payment: WalletV6UsdcPayment } {
  return Object.fromEntries(Object.entries(draft).map(([key, value]) => key === "review" ? ["payment", (value as WalletReview).payment] : [key, value])) as never;
}
/** Rename only; the validator decides whether the result is a valid draft. */
export function walletReviewFromStored(stored: unknown): WalletReviewDraft {
  if (!stored || typeof stored !== "object" || !("payment" in stored)) return stored as WalletReviewDraft;
  return Object.fromEntries(Object.entries(stored).map(([key, value]) => key === "payment" ? ["review", { kind: "v6-usdc-pay", payment: value }] : [key, value])) as never;
}
function contextDigest(base: Omit<WalletReviewDraft, "ceremony">): string {
  return digest(["center-wallet-payment-review-context-v1", walletReviewToStored(base)]).slice(2);
}

/** Server-loaded records and pinned configuration only. Clock, policy and current readiness
 * admission remain inside the store transaction; reconstruction also supports receipt recovery. */
export function createWalletPaymentReviewDraft(inputContext: WalletPaymentReviewContext,
  input: { id: string; state: string; createdAtMs: number }): WalletReviewDraft {
  try {
    const c = snapshot(inputContext), options = snapshot(input);
    fields(c, ["issuer", "token", "directV6Terminal", "grant", "authority", "plan", "operation", "manifest"]);
    fields(options, ["id", "state", "createdAtMs"]);
    if (!uuid.test(options.id) || !time(options.createdAtMs)) invalid();
    validateWalletHandoffToken(options.state); validateWalletPolicyOrigin(c.issuer);
    address(c.token); address(c.directV6Terminal);
    const a = validateWalletAuthorityContext(c.authority), g = validateWalletAppGrant(c.grant), p = c.plan, r = c.operation;
    const b = a.binding, current = a.prior, identity = current?.identity;
    if (!current || !identity || current.bootstrapRequired || !same(c.manifest, a.enrollment.intent.manifest) ||
      c.manifest.mode !== "execution-candidate" || !c.manifest.entryPoint || c.manifest.entryPoint.version !== "0.7" ||
      c.issuer !== a.enrollment.intent.origin || a.accountId !== g.accountId ||
      g.authorityEpoch !== current.authorityEpoch || g.sessionEpoch !== current.sessionEpoch || g.revokedAt !== null ||
      options.createdAtMs < g.createdAt * 1000 || options.createdAtMs < r.createdAt || options.createdAtMs < a.credential.verifiedAtMs ||
      !same(createWalletAuthorityIdentity(a, { stateHash: b.state.stateHash, sessionAdministration: identity.sessionAdministration,
        creationTransaction: identity.creationTransaction }), identity)) invalid();
    const profile = userOperationPasskeyProfile(b, c.manifest);
    // A historical ownership binding can predate execution qualification. The prepared
    // operation and ordinary signed submission retain their canonical execution checks.
    if (!profile || !b.state.moduleConfigurationVerified || r.session ||
      r.actor.accountId !== g.accountId || r.actor.principalId !== walletAppPrincipalId(g) || !same(r.actor, p.actor) ||
      r.chainId !== SIGNA_HOME_CHAIN_ID || p.id !== r.planId || p.commitment !== r.planCommitment || r.accountBindingId !== b.id ||
      r.accountStateHash !== b.state.stateHash || address(r.sender) !== address(b.wallet.address) ||
      address(r.operation.sender) !== address(b.wallet.address) || address(r.entryPoint) !== address(c.manifest.entryPoint.address) ||
      r.expiresAt > p.expiresAt || r.createdAt < p.createdAt || !p.smartAccount ||
      !same(p.smartAccount, { bindingId: b.id, stateHash: b.state.stateHash, chainId: SIGNA_HOME_CHAIN_ID,
        address: b.wallet.address, manifestRevision: c.manifest.revision })) invalid();
    const { submission: _submission, observation: _observation, ...initial } = r;
    assertNew({ ...initial, revision: 0, state: "prepared" }, r.createdAt, defaultCodec);
    assertNewPlan({ ...p, revision: 0, steps: p.draft.calls.map((_, index) => ({ index, state: "waiting" })) }, p.createdAt);
    if (p.commitment !== digest({ actor: p.actor, draft: p.draft, expiresAt: p.expiresAt, smartAccount: p.smartAccount }) ||
      r.commitment !== digest({ planId: r.planId, planCommitment: r.planCommitment, operation: r.operation, operationHash: r.operationHash,
        accountBindingId: r.accountBindingId, accountStateHash: r.accountStateHash, gasPolicyId: r.gasPolicyId,
        providerId: r.providerId, createdAt: r.createdAt, expiresAt: r.expiresAt })) invalid();
    const payment = recognizeWalletV6UsdcPayment(p, r.stepIndexes, { chainId: SIGNA_HOME_CHAIN_ID, token: c.token, directV6Terminal: c.directV6Terminal });
    if (!payment) invalid();
    passkeyPayMetadataSteps(payment.metadata);
    assertSafe7579Execution(r.operation.callData, r.stepIndexes.map(index => {
      const call = p.draft.calls[index]!; return { target: call.to, value: call.value, callData: call.data };
    }));
    const operation = normalizeUserOperation({ ...r.operation, signature: "0x" });
    const quoteFailed = p.draft.warnings.some(warning => typeof warning === "string" && warning.startsWith(PAY_QUOTE_FAILED_MESSAGE));
    const expiresAtMs = Math.min(Math.floor(r.expiresAt / 1000) * 1000, g.expiresAt * 1000, options.createdAtMs + walletPaymentReviewMaximumLifetimeMs);
    if (expiresAtMs <= options.createdAtMs) invalid();
    // Authority identity commits the full validated lineage. The approval proof keeps
    // its original bounded key fields; current context and epochs are rechecked at admission.
    const { recovery: _recovery, ...proofCredential } = a.credential;
    const base: Omit<WalletReviewDraft, "ceremony"> = { version: "center-wallet-payment-review-v1", ...options,
      issuer: c.issuer, grant: g, authority: { accountId: a.accountId, enrollmentId: a.enrollment.intent.id, credential: proofCredential,
        authorityIdentityDigest: walletAuthorityIdentityDigest(identity), authorityEpoch: current.authorityEpoch, sessionEpoch: current.sessionEpoch,
        bindingId: b.id, bindingAuthorizationDigest: b.authorization.digest, stateHash: b.state.stateHash,
        manifestRevision: c.manifest.revision, signer: address(profile.signer.address) },
      planId: p.id, planCommitment: p.commitment, operationId: r.id, operationCommitment: r.commitment, operationHash: r.operationHash,
      stepIndexes: [...r.stepIndexes], operation, chainId: SIGNA_HOME_CHAIN_ID, entryPoint: address(r.entryPoint), safe7579: address(c.manifest.safe7579.address),
      review: { kind: "v6-usdc-pay", payment },
      // An operation prepared before the payer was recorded was sponsored: its paymaster says so.
      gas: checkReviewGas(r.gas ?? { payer: "pimlico", chainId: r.chainId, paymaster: operation.paymaster?.toLowerCase() }, operation, SIGNA_HOME_CHAIN_ID),
      ...(quoteFailed ? { notice: PAY_QUOTE_FAILED_MESSAGE } : {}),
      signing: signing({ operation, chainId: SIGNA_HOME_CHAIN_ID, entryPoint: r.entryPoint, safe7579: c.manifest.safe7579.address },
        String(Math.floor(r.createdAt / 1000)), String(Math.floor(r.expiresAt / 1000))), expiresAtMs };
    return validateWalletPaymentReviewDraft({ ...base, ceremony: { id: base.id, accountId: a.accountId, purpose: "payment",
      contextDigest: contextDigest(base), challenge: Buffer.from(base.signing.digest.slice(2), "hex").toString("base64url"), expiresAt: expiresAtMs } });
  } catch { return invalid(); }
}

export function validateWalletPaymentReviewDraft(input: unknown): WalletReviewDraft {
  try {
    const d = snapshot(input) as WalletReviewDraft;
    walletAppFields(d, ["version", "id", "state", "issuer", "grant", "authority", "planId", "planCommitment", "operationId", "operationCommitment",
      "operationHash", "stepIndexes", "operation", "chainId", "entryPoint", "safe7579", "review", "gas", "signing", "createdAtMs", "expiresAtMs", "ceremony"], ["notice"]);
    if ("notice" in d && d.notice !== PAY_QUOTE_FAILED_MESSAGE) invalid();
    if (Buffer.byteLength(JSON.stringify(walletReviewToStored(d))) > 65_536 || d.version !== "center-wallet-payment-review-v1" ||
      ![d.id, d.planId, d.operationId].every(value => typeof value === "string" && uuid.test(value)) || d.chainId !== SIGNA_HOME_CHAIN_ID ||
      !time(d.createdAtMs) || !time(d.expiresAtMs) || d.expiresAtMs <= d.createdAtMs || d.expiresAtMs > d.createdAtMs + walletPaymentReviewMaximumLifetimeMs) invalid();
    validateWalletHandoffToken(d.state); validateWalletPolicyOrigin(d.issuer); validateWalletAppGrant(d.grant);
    fields(d.authority, ["accountId", "enrollmentId", "credential", "authorityIdentityDigest", "authorityEpoch", "sessionEpoch", "bindingId",
      "bindingAuthorizationDigest", "stateHash", "manifestRevision", "signer"]);
    const a = d.authority, c = a.credential;
    fields(c, ["accountId", "enrollmentId", "rpId", "credentialId", "userHandle", "publicKey", "backupEligible", "verifiedAtMs", "supersededAtMs"]);
    fields(c.publicKey, ["x", "y"]);
    for (const value of [d.planCommitment, d.operationCommitment, d.operationHash, a.authorityIdentityDigest, a.bindingId,
      a.bindingAuthorizationDigest, a.stateHash, a.manifestRevision, c.publicKey.x, c.publicKey.y])
      if (typeof value !== "string" || !word.test(value)) invalid();
    if (!uuid.test(a.enrollmentId) || c.enrollmentId !== a.enrollmentId || c.accountId !== a.accountId || a.accountId !== d.grant.accountId ||
      typeof c.rpId !== "string" || c.rpId.length > 253 || typeof c.credentialId !== "string" || !/^[A-Za-z0-9_-]{1,1364}$/.test(c.credentialId) ||
      Buffer.from(c.credentialId, "base64url").toString("base64url") !== c.credentialId ||
      typeof c.backupEligible !== "boolean" || c.supersededAtMs !== null || !time(c.verifiedAtMs) || c.verifiedAtMs > d.createdAtMs ||
      !walletAppBigint(a.authorityEpoch) || !walletAppBigint(a.sessionEpoch) || a.authorityEpoch !== d.grant.authorityEpoch ||
      a.sessionEpoch !== d.grant.sessionEpoch || d.createdAtMs < d.grant.createdAt * 1000 ||
      d.expiresAtMs > d.grant.expiresAt * 1000 || d.grant.revokedAt !== null) invalid();
    validateWalletHandoffToken(c.userHandle); validateWalletRpConfiguration({ rpId: c.rpId, origin: d.issuer });
    for (const value of [d.entryPoint, d.safe7579, a.signer]) if (address(value) !== value) invalid();
    if (!same(normalizeUserOperation(d.operation), d.operation) || d.operation.signature !== "0x" ||
      `eip155:${SIGNA_HOME_CHAIN_ID}:${d.operation.sender}` !== a.accountId || getUserOperationHash(d.operation, d.entryPoint, d.chainId) !== d.operationHash) invalid();
    fields(d.signing, ["digest", "signedData", "validAfter", "validUntil"]);
    if (!same(signing(d, d.signing.validAfter, d.signing.validUntil), d.signing) ||
      BigInt(d.signing.validAfter) * 1000n > BigInt(d.createdAtMs) || BigInt(d.signing.validUntil) * 1000n < BigInt(d.expiresAtMs)) invalid();
    if (!same(checkReviewGas(d.gas, d.operation, d.chainId), d.gas)) invalid();
    fields(d.review, ["kind", "payment"]);
    if (d.review.kind !== "v6-usdc-pay") invalid();
    const payment = d.review.payment;
    fields(payment, ["kind", "chainId", "account", "token", "terminal", "projectId", "amount", "beneficiary", "minimumReturnedTokens",
      "memo", "metadata", "stepIndexes", "approvalStepIndexes", "paymentStepIndex", "resetAllowance"]);
    const calls = decodeSafe7579Execution(d.operation.callData).map((call, index) => ({ chainId: SIGNA_HOME_CHAIN_ID, to: call.target, value: call.value,
      data: call.callData, label: "", decoded: {}, dependsOn: index ? [index - 1] : [] }));
    const project = { chainId: SIGNA_HOME_CHAIN_ID, projectId: payment.projectId, version: 6 as const };
    const checked = recognizeWalletV6UsdcPayment({ draft: { operation: "pay", account: d.operation.sender, project, calls, evidence: [], warnings: [],
      summary: { operation: "pay", project, account: d.operation.sender, terminal: payment.terminal, terminalPath: [payment.terminal],
        routerGateway: null, route: "multi-terminal", payment: { token: payment.token, amount: payment.amount, unit: "token-base-units" },
        beneficiary: payment.beneficiary, minimumBeneficiaryTokenCount: payment.minimumReturnedTokens, metadata: payment.metadata } } },
      d.stepIndexes, { chainId: SIGNA_HOME_CHAIN_ID, token: payment.token, directV6Terminal: payment.terminal });
    if (!checked || !same(checked, payment)) invalid();
    passkeyPayMetadataSteps(payment.metadata);
    fields(d.ceremony, ["id", "accountId", "purpose", "contextDigest", "challenge", "expiresAt"]); assertWalletCeremonyDraft(d.ceremony);
    const { ceremony, ...base } = d;
    if (ceremony.id !== d.id || ceremony.accountId !== a.accountId || ceremony.purpose !== "payment" || ceremony.expiresAt !== d.expiresAtMs ||
      ceremony.contextDigest !== contextDigest(base) || ceremony.challenge !== Buffer.from(d.signing.digest.slice(2), "hex").toString("base64url")) invalid();
    return freeze(d);
  } catch { return invalid(); }
}

export function assertWalletPaymentReviewContext(input: WalletReviewDraft, context: WalletPaymentReviewContext): void {
  const draft = validateWalletPaymentReviewDraft(input);
  if (!same(draft, createWalletPaymentReviewDraft(context, { id: draft.id, state: draft.state, createdAtMs: draft.createdAtMs }))) invalid();
}
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;
function bytes(value: unknown, min: number, max: number): Uint8Array {
  if (!value || typeof value !== "object" || isProxy(value)) invalid();
  const length = typedArrayByteLength.call(value);
  if (!(value instanceof Uint8Array) || length < min || length > max) invalid();
  const result = new Uint8Array(length); Uint8Array.prototype.set.call(result, value); return result;
}
/** Copy the bounded caller-owned assertion before a store performs its first asynchronous read.
 * No credential lookup or signature verification occurs here. */
export function copyWalletPaymentReviewAssertion(assertion: WalletAssertion): WalletAssertion {
  try {
    const a = fields(assertion, ["credentialId", "userHandle", "authenticatorData", "clientDataJSON", "signature"]);
    if (typeof a.credentialId !== "string" || a.credentialId.length > 1364 ||
      (a.userHandle !== null && (typeof a.userHandle !== "string" || a.userHandle.length > 86))) invalid();
    return { credentialId: a.credentialId, userHandle: a.userHandle,
      authenticatorData: bytes(a.authenticatorData, 37, 37), clientDataJSON: bytes(a.clientDataJSON, 1, 2048), signature: bytes(a.signature, 8, 72) };
  } catch { throw new RestError(403, "WALLET_PAYMENT_REVIEW_PROOF_INVALID", "A matching fresh wallet payment assertion is required."); }
}
/** Verification never consumes a review. A durable first winner must retain its original
 * signature: later valid assertions can share this semantic digest but have different bytes. */
/** The passkey that approves: the draft's primary by default, or one of the account's devices,
 * which signs the same digest as its own Safe owner. The store resolves it from the session. */
export interface WalletPaymentReviewApprover {
  credential: WalletReviewDraft["authority"]["credential"]; signer: Address;
}
export function verifyWalletPaymentReviewProof(input: WalletReviewDraft, assertion: WalletAssertion, approver?: WalletPaymentReviewApprover,
  /** `framedBy`: the review's app origin when that app is admitted to frame the review page. */
  options: { framedBy?: string } = {}): WalletPaymentReviewProof {
  try {
    const draft = validateWalletPaymentReviewDraft(input), owned = copyWalletPaymentReviewAssertion(assertion);
    const c = approver?.credential ?? draft.authority.credential, signer = approver ? address(approver.signer) : draft.authority.signer;
    if (approver && (c.accountId !== draft.authority.accountId || c.enrollmentId !== draft.authority.enrollmentId || c.rpId !== draft.authority.credential.rpId)) invalid();
    if (options.framedBy !== undefined && options.framedBy !== draft.grant.origin) invalid();
    const proof = verifyWalletAssertion(owned, { purpose: "payment", challenge: draft.signing.digest, rpId: c.rpId, origin: draft.issuer,
      ...(options.framedBy ? { topOrigin: options.framedBy } : {}),
      credential: { id: c.credentialId, userHandle: c.userHandle, publicKey: c.publicKey, backupEligible: c.backupEligible }, requireUserHandle: false });
    const signature = encodeSafe7579PasskeyOwnerSignature({ ...draft.signing,
      signatures: [{ kind: "contract", owner: signer, signature: proof.contractSignature }] });
    if (size(signature) > PASSKEY_MAX_SIGNATURE_BYTES) invalid();
    return freeze({ proofDigest: digest(["center-wallet-payment-review-proof-v1", draft.ceremony.contextDigest,
      draft.signing.digest, draft.authority.authorityIdentityDigest, c]).slice(2), signature,
      signedCommitment: userOperationCommitment({ ...draft.operation, signature }, draft.entryPoint, draft.chainId) });
  } catch { throw new RestError(403, "WALLET_PAYMENT_REVIEW_PROOF_INVALID", "A matching fresh wallet payment assertion is required."); }
}
