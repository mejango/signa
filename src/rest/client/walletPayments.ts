import { isAddress, sha256, stringToHex, type Address, type Hex } from 'viem';
import { RestClientError, newRequestNonce } from './index.js';
import { payFailureOf, type PayFailure } from './payFailure.js';
import { isSettledPayment } from './paymentStates.js';
import type { CenterClient } from './center.js';
import { assertReviewedOperation, type PreparedUserOperation, type SmartWalletPlan } from './smartAccounts.js';
import type { CenterWalletStorage } from './wallet.js';
import { decodeSafe7579PasskeyOwnerSignature, safe7579PasskeyOwnerSigningPayload } from '../smartAccounts/passkeySignatures.js';
import { normalizeUserOperation, userOperationCommitment, userOperationMaximumCost, uoCanonical } from '../userOperations/codec.js';
import { recognizeWalletV6UsdcPayment, type WalletV6UsdcPayment } from '../userOperations/semantics.js';
import type { UserOperationObservation } from '../userOperations/types.js';
import type { WalletAppGrant } from '../wallet/appGrants.js';
import type { WalletPaymentReviewPublic, WalletPaymentAppPublic } from '../wallet/paymentPublic.js';
import { validateWalletHandoffToken } from '../wallet/sharedHandoff.js';
import { SIGNA_HOME_CHAIN_ID } from '../wallet/chains.js';
import { REVIEWED_CALLS_KIND, REVIEWED_CALLS_OPERATION } from '../userOperations/reviewedCallRules.js';
import { REVIEWED_SIGNATURE_KIND, signatureRequestOf, signatureSigning, type SignatureRequest } from '../userOperations/reviewedSignatureRules.js';

export type CenterWalletExpectedPayment = Omit<WalletV6UsdcPayment,
  'stepIndexes' | 'approvalStepIndexes' | 'paymentStepIndex' | 'resetAllowance'> & {
  /** Maximum EntryPoint prefund in native wei, excluding separate rollup data fees. */
  maximumNetworkFee: string;
};
export interface CenterWalletPaymentInput {
  plan: SmartWalletPlan;
  operation: PreparedUserOperation;
  expectedPayment: CenterWalletExpectedPayment;
}
/** `expired`: published but never included before its signed validity ended; it cannot execute.
 * `refused`: Signa refused to send it and retired the approval; Signa never sends it, and a fresh payment takes its nonce. */
export type CenterWalletPaymentState = 'reviewing' | 'approved' | 'submitting' | 'pending' | 'confirming' | 'paid' | 'reverted' | 'cancelled' | 'unknown' | 'expired' | 'refused';
export interface CenterWalletPaymentStatus {
  status: CenterWalletPaymentState;
  accountId: string;
  chainId: typeof SIGNA_HOME_CHAIN_ID;
  operationId: string;
  operationHash: Hex;
  reviewId: string | null;
  approvalUrl: string | null;
  expiresAtMs: number;
  expectedPayment: CenterWalletExpectedPayment;
  /** An observed outer transaction identifier, never an alias for operationHash. */
  transactionHash?: Hex;
  observation?: UserOperationObservation;
  /** Why this payment reverted, when its trace says; shown only while it stands reverted. The SDK's own
   * `PayFailure` (bigint amounts, with `zeroFill` and `adjustable` for a shortfall); `observation.payFailure`
   * keeps the served form. Advisory: a changed minimum needs a fresh preparation and review. */
  payFailure?: PayFailure;
}
/** One call an app asks a Signa account to make. */
export interface CenterWalletReviewCall { to: Address; value: bigint; data: Hex }
export interface CenterWalletReviewInput {
  chainId: number;
  calls: readonly CenterWalletReviewCall[];
  /** One entry per call, checked against Signa's decode and never shown: `{ functionName, args }`, or null for a raw call. */
  expectation?: unknown;
}
/** The exact calls as Signa reviews them, values in decimal. */
export interface CenterWalletExpectedCalls { chainId: number; calls: { to: Address; value: string; data: Hex }[]; expectation?: unknown }
/** A reviewed call set follows a payment's states, with its calls in place of the payment. */
export type CenterWalletReviewStatus = Omit<CenterWalletPaymentStatus, 'expectedPayment'> & { expectedCalls: CenterWalletExpectedCalls };
/** What an app asks a Signa account to sign: eth_signTypedData_v4 JSON (integers above 2^53 as decimal strings), or text. */
export type CenterWalletSignatureRequest = SignatureRequest;
export interface CenterWalletSignatureStatus {
  status: 'reviewing' | 'approved' | 'cancelled';
  accountId: string;
  chainId: number;
  reviewId: string | null;
  approvalUrl: string | null;
  expiresAtMs: number | null;
  request: SignatureRequest;
  /** The EIP-712 or EIP-191 hash the account's ERC-1271 signature is for. */
  requestDigest: Hex;
  /** The account's ERC-1271 signature, once approved. */
  signature?: Hex;
}
/** Internal composition used by wallet.payments() and wallet.reviews(). No owner or app private key crosses this seam. */
export interface CenterWalletPaymentClientOptions {
  issuer: string;
  audience: string;
  callbackUri: string;
  storage: CenterWalletStorage;
  location: { href(): string; replace(url: string): void };
  now(): number;
  connection(): { grant: WalletAppGrant; client: CenterClient } | null;
}
interface Journal extends Omit<CenterWalletPaymentInput, 'expectedPayment'> {
  expectedPayment?: CenterWalletExpectedPayment;
  /** A reviewed call set in place of a payment. */
  expectedCalls?: CenterWalletExpectedCalls;
  version: 'center-wallet-payment-client-v1';
  issuer: string;
  audience: string;
  callbackUri: string;
  grant: WalletAppGrant;
  startedAtMs: number;
  state: string;
  reviewKey: string;
  /** The review id the app chose, so it can open the review page before the review exists. */
  reviewId?: string;
  submissionKey: string;
  submissionStarted: boolean;
  status: CenterWalletPaymentState;
  review?: WalletPaymentReviewPublic;
  approval?: NonNullable<WalletPaymentAppPublic['approval']>;
  observation?: UserOperationObservation;
}
type Saved = { value: Journal; encoded: string };
interface SignatureJournal {
  version: 'center-wallet-signature-client-v1';
  issuer: string;
  audience: string;
  callbackUri: string;
  grant: WalletAppGrant;
  request: SignatureRequest;
  digest: Hex;
  requestDigest: Hex;
  state: string;
  reviewKey: string;
  reviewId?: string;
  status: CenterWalletSignatureStatus['status'];
  review?: { id: string; createdAtMs: number; expiresAtMs: number };
  signature?: Hex;
}
type SavedSignature = { value: SignatureJournal; encoded: string };
const maximumBytes = 1_048_576;
const reviewPath = '/api/v1/wallet/payment-reviews';
const reviewIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const paymentFields = ['kind', 'chainId', 'account', 'token', 'terminal', 'projectId', 'amount', 'beneficiary', 'minimumReturnedTokens', 'memo', 'metadata'] as const;
const states = ['reviewing', 'approved', 'submitting', 'pending', 'confirming', 'paid', 'reverted', 'cancelled', 'unknown', 'expired', 'refused'];
const terminal = isSettledPayment;
const hex32 = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const equal = (a: unknown, b: unknown) => uoCanonical(a) === uoCanonical(b);
function fail(code: string, message: string): never { throw new RestClientError(code, message); }
function mismatch(): never { return fail('WALLET_PAYMENT_MISMATCH', 'The payment differs from this app’s exact reviewed operation.'); }
function snapshot<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || new TextEncoder().encode(encoded).length > maximumBytes) mismatch();
  return JSON.parse(encoded) as T;
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) mismatch();
  const keys = Object.keys(value);
  if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) mismatch();
  return value as Record<string, unknown>;
}
const lower = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : value;
const comparableCalls = (calls: unknown) => Array.isArray(calls) ? calls.map(call => ({ ...call, to: lower(call?.to), data: lower(call?.data) })) : calls;
function comparablePayment(payment: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(payment).map(([key, value]) => [key,
    ['account', 'token', 'terminal', 'beneficiary', 'metadata'].includes(key) && typeof value === 'string' ? value.toLowerCase() : value]));
}

function createWalletReviewJournal<Status>(options: CenterWalletPaymentClientOptions, namespace: 'payment' | 'review') {
  const { issuer, audience, callbackUri, storage, location, now } = options;
  const key = 'center.wallet.' + namespace + '.v1:' + issuer + ':' + callbackUri, historyKey = key + ':history', signatureKey = key + ':signature';
  function raw(name = key): string | null {
    try { return storage.getItem(name); } catch { return fail('WALLET_PAYMENT_STORAGE_UNAVAILABLE', 'This tab could not read its payment record.'); }
  }
  function save<T extends Journal | SignatureJournal>(value: T, expected: string | null, name = key): { value: T; encoded: string } {
    const copy = snapshot(value), integrity = sha256(stringToHex(uoCanonical(copy))), encoded = JSON.stringify({ ...copy, integrity });
    if (raw(name) !== expected) fail('WALLET_PAYMENT_CHANGED', 'This tab changed its pending payment. Resume the current payment.');
    try {
      if (new TextEncoder().encode(encoded).length > maximumBytes) throw new Error();
      storage.setItem(name, encoded);
      if (storage.getItem(name) !== encoded) throw new Error();
    } catch { return fail('WALLET_PAYMENT_STORAGE_UNAVAILABLE', 'This tab could not preserve its payment before continuing.'); }
    return { value: copy, encoded };
  }
  /** The payment the operation makes, or null for a reviewed call set, whose plan must carry exactly its calls. */
  function checkInput(input: Pick<Journal, 'plan' | 'operation' | 'expectedPayment' | 'expectedCalls'>, grant: WalletAppGrant, at: number): WalletV6UsdcPayment | null {
    try {
      const operation = input.operation, expected = input.expectedPayment!;
      assertReviewedOperation(operation, input.plan, at);
      if (operation.chainId !== SIGNA_HOME_CHAIN_ID || grant.accountId !== `eip155:${SIGNA_HOME_CHAIN_ID}:` + operation.operation.sender.toLowerCase() ||
        operation.session || operation.submission || operation.observation || input.plan.expiresAt <= at ||
        !hex32(operation.commitment) || !integer(at) || !('ownerProfile' in operation.signing) || operation.signing.ownerProfile !== 'center-passkey-v1') mismatch();
      const signing = operation.signing;
      const derived = safe7579PasskeyOwnerSigningPayload({ operation: operation.operation, chainId: SIGNA_HOME_CHAIN_ID, entryPoint: operation.entryPoint,
        safe7579: signing.typedData.domain.verifyingContract as `0x${string}`, validAfter: signing.validAfter, validUntil: signing.validUntil });
      if (!equal(signing, { ...derived, ownerProfile: 'center-passkey-v1' })) mismatch();
      const wanted = input.expectedCalls;
      if (wanted) {
        const calls = input.plan.draft.calls;
        if (input.plan.draft.operation !== REVIEWED_CALLS_OPERATION || wanted.chainId !== SIGNA_HOME_CHAIN_ID || calls.length !== wanted.calls.length ||
          !equal(operation.stepIndexes, calls.map((_call, index) => index)) ||
          !equal(comparableCalls(calls.map(call => ({ to: call.to, value: call.value, data: call.data }))), comparableCalls(wanted.calls)) ||
          calls.some(call => call.chainId !== wanted.chainId)) mismatch();
        return null;
      }
      const payment = recognizeWalletV6UsdcPayment(input.plan, operation.stepIndexes,
        { chainId: SIGNA_HOME_CHAIN_ID, token: expected.token, directV6Terminal: expected.terminal });
      if (!payment || paymentFields.some(field => {
        const actual = payment[field], wanted = expected[field];
        return ['account', 'token', 'terminal', 'beneficiary', 'metadata'].includes(field) ? !same(actual, wanted) : actual !== wanted;
      }) || typeof expected.maximumNetworkFee !== 'string' || !/^[1-9][0-9]{0,77}$/.test(expected.maximumNetworkFee) ||
        BigInt(expected.maximumNetworkFee) >= 2n ** 256n || userOperationMaximumCost(operation.operation) > BigInt(expected.maximumNetworkFee)) mismatch();
      return payment;
    } catch { return mismatch(); }
  }
  function live(value?: { grant: WalletAppGrant }) {
    let current: ReturnType<typeof options.connection>;
    try { current = options.connection(); } catch { current = null; }
    if (!current || current.grant.revokedAt !== null || current.grant.expiresAt <= Math.floor(now() / 1000) ||
      current.grant.audience !== audience || current.grant.callbackUri !== callbackUri ||
      (value && !equal(current.grant, value.grant)))
      fail('WALLET_PAYMENT_CONNECTION_CHANGED', 'Reconnect the original app grant to continue this pending payment.');
    return current;
  }
  function checkApproval(value: unknown, saved: Journal): NonNullable<WalletPaymentAppPublic['approval']> {
    const approval = fields(value, ['signature', 'signedCommitment']);
    if (typeof approval.signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){77,8192}$/.test(approval.signature) || !hex32(approval.signedCommitment)) mismatch();
    const signing = saved.operation.signing;
    if (!('ownerProfile' in signing)) mismatch();
    const entries = decodeSafe7579PasskeyOwnerSignature({ signature: approval.signature as Hex,
      validAfter: signing.validAfter, validUntil: signing.validUntil, threshold: 1 });
    if (entries.length !== 1 || entries[0]?.kind !== 'contract' || !same(approval.signedCommitment,
      userOperationCommitment({ ...saved.operation.operation, signature: approval.signature as Hex }, saved.operation.entryPoint, SIGNA_HOME_CHAIN_ID))) mismatch();
    return { signature: approval.signature as Hex, signedCommitment: approval.signedCommitment };
  }
  function checkView(input: unknown, saved: Journal, appView: boolean): WalletPaymentAppPublic | WalletPaymentReviewPublic {
    try {
      const value = snapshot(input);
      const v = fields(value, ['version', 'id', 'state', 'issuer', 'accountId', 'app', 'planId', 'planCommitment', 'operationId',
        'operationCommitment', 'operationHash', 'stepIndexes', 'operation', 'chainId', 'entryPoint', 'safe7579', saved.expectedCalls ? 'review' : 'payment',
        'signing', 'createdAtMs', 'expiresAtMs', 'status', 'approvedAtMs', 'cancelledAtMs', 'operationState', ...(appView ? ['approval'] : [])]);
      const app = fields(v.app, ['origin', 'callbackUri', 'grantId', 'grantIncarnation']);
      const signing = saved.operation.signing;
      if (!('ownerProfile' in signing)) mismatch();
      const expectedSigning = { digest: signing.digest, signedData: signing.signedData, validAfter: signing.validAfter, validUntil: signing.validUntil };
      const payment = checkInput(saved, saved.grant, saved.startedAtMs);
      if (v.version !== 'center-wallet-payment-review-v1' || !uuid(v.id) || (saved.review && v.id !== saved.review.id) ||
        v.state !== saved.state || v.issuer !== issuer || v.accountId !== saved.grant.accountId ||
        app.origin !== saved.grant.origin || app.callbackUri !== callbackUri || app.grantId !== saved.grant.id || app.grantIncarnation !== saved.grant.incarnation ||
        v.planId !== saved.plan.id || !same(v.planCommitment, saved.plan.commitment) || v.operationId !== saved.operation.id ||
        !same(v.operationCommitment, saved.operation.commitment) || !same(v.operationHash, saved.operation.operationHash) ||
        !equal(v.stepIndexes, saved.operation.stepIndexes) || !equal(normalizeUserOperation(v.operation), normalizeUserOperation(saved.operation.operation)) ||
        v.chainId !== SIGNA_HOME_CHAIN_ID || !same(v.entryPoint, saved.operation.entryPoint) || !same(v.safe7579, signing.typedData.domain.verifyingContract) ||
        !equal(v.signing, expectedSigning) || !reviewed(v, payment, saved.expectedCalls) ||
        !integer(v.createdAtMs) || v.createdAtMs < saved.startedAtMs - 30_000 || v.createdAtMs > now() + 30_000 ||
        !integer(v.expiresAtMs) || v.expiresAtMs <= v.createdAtMs || v.expiresAtMs > saved.operation.expiresAt ||
        v.expiresAtMs > saved.grant.expiresAt * 1000 || v.expiresAtMs > v.createdAtMs + 300_000 ||
        (saved.review && (v.createdAtMs !== saved.review.createdAtMs || v.expiresAtMs !== saved.review.expiresAtMs)) ||
        !['pending', 'approved', 'cancelled'].includes(String(v.status)) ||
        !['prepared', 'submitting', 'submission_unknown', 'pending', 'unknown', 'confirming', 'confirmed', 'reverted', 'expired', 'retired'].includes(String(v.operationState))) mismatch();
      if (v.status === 'approved' ? !integer(v.approvedAtMs) || v.cancelledAtMs !== null : v.approvedAtMs !== null) mismatch();
      if (v.status === 'cancelled' ? !integer(v.cancelledAtMs) : v.cancelledAtMs !== null) mismatch();
      for (const at of [v.approvedAtMs, v.cancelledAtMs])
        if (at !== null && (!integer(at) || at < v.createdAtMs || at > v.expiresAtMs || at > now() + 30_000)) mismatch();
      if (appView) {
        if (v.status === 'approved') checkApproval(v.approval, saved);
        else if (v.approval !== null) mismatch();
      }
      if (saved.approval && (v.status !== 'approved' || (appView && !equal(v.approval, saved.approval)))) mismatch();
      return value as WalletPaymentAppPublic | WalletPaymentReviewPublic;
    } catch { return mismatch(); }
  }
  /** A payment view carries the payment; a call set's, its exact calls and a source for each. */
  function reviewed(v: Record<string, unknown>, payment: WalletV6UsdcPayment | null, wanted?: CenterWalletExpectedCalls): boolean {
    if (!wanted) return equal(comparablePayment(v.payment as Record<string, unknown>), comparablePayment(payment as unknown as Record<string, unknown>));
    const review = fields(v.review, ['kind', 'chainId', 'calls', 'sources']);
    return review.kind === REVIEWED_CALLS_KIND && review.chainId === wanted.chainId && Array.isArray(review.sources) &&
      review.sources.length === wanted.calls.length && equal(comparableCalls(review.calls), comparableCalls(wanted.calls));
  }
  function read(): Saved | null {
    const encoded = raw();
    if (encoded === null) return null;
    try {
      if (new TextEncoder().encode(encoded).length > maximumBytes) throw new Error();
      const decoded = JSON.parse(encoded), { integrity, ...value } = decoded;
      if (integrity !== sha256(stringToHex(uoCanonical(value))) || value.version !== 'center-wallet-payment-client-v1' ||
        value.issuer !== issuer || value.audience !== audience || value.callbackUri !== callbackUri ||
        !states.includes(value.status) || typeof value.submissionStarted !== 'boolean' ||
        !/^payment-review-[0-9a-f]{64}$/.test(value.reviewKey) || !/^payment-submit-[0-9a-f]{64}$/.test(value.submissionKey) ||
        (value.reviewId !== undefined && !reviewIdPattern.test(value.reviewId))) throw new Error();
      validateWalletHandoffToken(value.state);
      checkInput(value, value.grant, value.startedAtMs);
      if (value.review) checkView(value.review, value, false);
      if (value.approval) checkApproval(value.approval, value);
      if (value.submissionStarted && !value.approval) throw new Error();
      return { value, encoded };
    } catch { return fail('WALLET_PAYMENT_STORAGE_INVALID', 'The saved payment record is invalid. Preserve it for recovery.'); }
  }
  function pending(): Saved {
    const value = read();
    if (!value) fail('WALLET_PAYMENT_MISSING', 'There is no pending payment in this tab.');
    return value;
  }
  function status(value: Journal): Status {
    // A served reason reaches the app only in its exact shape, and only while this payment stands
    // reverted: an unknown or changed outcome drops it, on the status and inside the observation.
    const served = value.status === 'reverted' && value.observation?.state === 'reverted' ? value.observation.payFailure : undefined;
    const payFailure = payFailureOf(served);
    const { payFailure: _served, ...observed } = value.observation ?? {};
    const observation = value.observation && { ...observed, ...(payFailure ? { payFailure: served } : {}) } as UserOperationObservation;
    // The decoded reason carries bigints, so it joins after the JSON copy.
    const copy = snapshot({ status: value.status, accountId: value.grant.accountId, chainId: SIGNA_HOME_CHAIN_ID, operationId: value.operation.id,
      operationHash: value.operation.operationHash, reviewId: value.review?.id ?? null,
      approvalUrl: value.review ? issuer + '/wallet/payment?review=' + value.review.id : null,
      expiresAtMs: value.review?.expiresAtMs ?? value.operation.expiresAt,
      ...(value.expectedCalls ? { expectedCalls: value.expectedCalls } : { expectedPayment: value.expectedPayment! }),
      ...(observation ? { observation,
        ...(hex32(observation.transactionHash) ? { transactionHash: observation.transactionHash } : {}) } : {}) });
    return (payFailure ? { ...copy, payFailure } : copy) as Status;
  }
  function receiveView(input: unknown, saved: Saved, appView: boolean): Saved {
    const reviewed = checkView(input, saved.value, appView);
    const { approval, ...review } = reviewed as WalletPaymentAppPublic;
    const state = saved.value.submissionStarted ? saved.value.status : reviewed.status === 'approved' ? 'approved' : reviewed.status === 'cancelled' ? 'cancelled' : 'reviewing';
    return save({ ...saved.value, review, status: state, ...(approval ? { approval } : {}) }, saved.encoded);
  }
  async function requestReview(saved: Saved): Promise<Saved> {
    const client = live(saved.value).client;
    const value = await client.request({ method: 'POST', requestTarget: reviewPath,
      json: { operationId: saved.value.operation.id, state: saved.value.state, ...(saved.value.reviewId ? { id: saved.value.reviewId } : {}) },
      idempotencyKey: saved.value.reviewKey });
    // A review under another id than the one chosen is refused before anything of it is kept.
    if (saved.value.reviewId && (value as { id?: unknown } | null)?.id !== saved.value.reviewId) mismatch();
    return receiveView(value, saved, false);
  }
  /** The page a review with this id is approved on; the app may open it before the review exists. */
  function reviewUrl(reviewId: string): string {
    if (!reviewIdPattern.test(reviewId)) fail('WALLET_PAYMENT_INPUT_INVALID', 'Choose a version 4 UUID for the review.');
    return issuer + '/wallet/payment?review=' + reviewId;
  }
  function chosenReview(reviewId?: string) {
    if (reviewId !== undefined && !reviewIdPattern.test(reviewId)) fail('WALLET_PAYMENT_INPUT_INVALID', 'Choose a version 4 UUID for the review.');
  }
  /** The callback state that binds Signa's answer to this tab's request. */
  function handoffState() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }
  /** Journals a checked operation before its review is requested, then requests it. */
  async function begin(copy: Pick<Journal, 'plan' | 'operation' | 'expectedPayment' | 'expectedCalls'>, grant: WalletAppGrant, startedAtMs: number, reviewId?: string): Promise<Status> {
    const value: Journal = { ...copy, version: 'center-wallet-payment-client-v1', issuer, audience, callbackUri,
      grant: snapshot(grant), startedAtMs, state: handoffState(), reviewKey: 'payment-review-' + newRequestNonce().slice(2),
      ...(reviewId ? { reviewId } : {}),
      submissionKey: 'payment-submit-' + newRequestNonce().slice(2), submissionStarted: false, status: 'reviewing' };
    return status((await requestReview(save(value, null))).value);
  }
  async function preparePayment(input: CenterWalletPaymentInput, options: { reviewId?: string } = {}): Promise<Status> {
    chosenReview(options.reviewId);
    const existing = read();
    if (existing) {
      if (existing.value.expectedCalls) fail('WALLET_PAYMENT_PENDING', 'Resolve this tab’s existing payment before preparing another operation.');
      checkInput(snapshot(input), existing.value.grant, existing.value.startedAtMs);
      if (input.expectedPayment.maximumNetworkFee !== existing.value.expectedPayment!.maximumNetworkFee) mismatch();
      if (!equal(existing.value.plan, snapshot(input.plan)) || !equal(existing.value.operation, snapshot(input.operation)))
        fail('WALLET_PAYMENT_PENDING', 'Resolve this tab’s existing payment before preparing another operation.');
      live(existing.value);
      if (existing.value.review) return status(existing.value);
      return status((await requestReview(existing)).value);
    }
    const current = live(), copy = snapshot(input), startedAtMs = now();
    const payment = checkInput(copy, current.grant, startedAtMs)!;
    const expectedPayment = { ...Object.fromEntries(paymentFields.map(field => [field, payment[field]])), maximumNetworkFee: copy.expectedPayment.maximumNetworkFee } as CenterWalletExpectedPayment;
    return begin({ ...copy, expectedPayment }, current.grant, startedAtMs, options.reviewId);
  }
  /** Any call set from the account, on one chain: Signa plans it from the raw calls, the app prepares the operation, and
   * Signa's page reviews it. Nothing but the calls (and the optional expectation) reaches Signa. */
  async function prepareReview(input: CenterWalletReviewInput, options: { reviewId?: string } = {}): Promise<Status> {
    chosenReview(options.reviewId);
    let wanted: CenterWalletExpectedCalls;
    try {
      if (!Number.isSafeInteger(input.chainId) || !Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 16) throw new Error();
      wanted = { chainId: input.chainId, calls: input.calls.map(({ to, value, data }) => {
        if (typeof to !== 'string' || !isAddress(to) || typeof value !== 'bigint' || value < 0n || value >= 2n ** 256n ||
          typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error();
        return { to, value: value.toString(), data: data as Hex };
      }), ...(input.expectation === undefined ? {} : { expectation: snapshot(input.expectation) }) };
    } catch { return fail('WALLET_PAYMENT_INPUT_INVALID', 'Name the chain and 1 to 16 calls of { to, value, data }.'); }
    const existing = read();
    if (existing) {
      if (!existing.value.expectedCalls || !equal(existing.value.expectedCalls, wanted))
        fail('WALLET_PAYMENT_PENDING', 'Resolve this tab’s existing review before preparing another.');
      live(existing.value);
      if (existing.value.review) return status(existing.value);
      return status((await requestReview(existing)).value);
    }
    const current = live(), smart = current.client.smartAccounts(), account = current.grant.accountId.split(':')[2] as Address;
    const bindings = (await smart.bindings()).items.filter(item => item.wallet.chainId === wanted.chainId && same(item.wallet.address, account));
    if (bindings.length !== 1) fail('WALLET_REVIEW_ACCOUNT_UNAVAILABLE', 'This Signa account has no wallet on this network.');
    const plan = await current.client.request<SmartWalletPlan>({ method: 'POST', requestTarget: '/api/v1/wallet/reviewed-calls',
      json: { bindingId: bindings[0]!.id, chainId: wanted.chainId, account, calls: wanted.calls, ...(wanted.expectation === undefined ? {} : { expectation: wanted.expectation }) },
      idempotencyKey: 'reviewed-calls-' + newRequestNonce().slice(2) });
    const operation = await smart.prepareUserOperation({ planId: plan.id, stepIndexes: plan.draft.calls.map((_call, index) => index) });
    const copy = snapshot({ plan, operation, expectedCalls: wanted }), startedAtMs = now();
    checkInput(copy, current.grant, startedAtMs);
    return begin(copy, current.grant, startedAtMs, options.reviewId);
  }
  function checkCallback(incoming: string, reviewId: string | undefined, state: string) {
    try {
      const url = new URL(incoming);
      if (incoming.length > 4096 || incoming.slice(0, incoming.indexOf('?')) !== callbackUri || url.origin + url.pathname !== callbackUri ||
        url.username || url.password || url.hash || [...url.searchParams].length !== 3 ||
        ['review', 'state', 'iss'].some(name => url.searchParams.getAll(name).length !== 1) ||
        url.searchParams.get('review') !== reviewId || url.searchParams.get('state') !== state || url.searchParams.get('iss') !== issuer) throw new Error();
    } catch { return fail('WALLET_PAYMENT_CALLBACK_INVALID', 'The callback does not match the original payment and app grant.'); }
  }
  async function completePayment(callbackUrl?: string): Promise<Status> {
    const incoming = callbackUrl ?? location.href();
    try { location.replace(callbackUri); } catch { return fail('WALLET_PAYMENT_CALLBACK_INVALID', 'The payment callback could not be cleared.'); }
    const saved = pending();
    checkCallback(incoming, saved.value.review?.id, saved.value.state);
    const result = await live(saved.value).client.request({ requestTarget: reviewPath + '/' + saved.value.review!.id });
    return status(receiveView(result, saved, true).value);
  }
  function receiveOperation(input: PreparedUserOperation, saved: Saved): Saved {
    try {
      const operation = snapshot(input), original = saved.value.operation;
      for (const name of ['id', 'planId', 'planCommitment', 'commitment', 'operationHash', 'chainId', 'entryPoint', 'accountBindingId', 'accountStateHash', 'createdAt', 'expiresAt'] as const)
        if (operation[name] !== original[name]) mismatch();
      if (!equal(normalizeUserOperation(operation.operation), normalizeUserOperation(original.operation)) || !equal(operation.stepIndexes, original.stepIndexes) ||
        (operation.submission && !same(operation.submission.commitment, saved.value.approval?.signedCommitment))) mismatch();
      if (Number.isInteger(operation.revision) && operation.revision >= 0) revisions.set(operation.id, operation.revision);
      const observation = operation.observation;
      if (observation && (!same(observation.operationHash, original.operationHash) ||
        (observation.transactionHash !== undefined && !hex32(observation.transactionHash)))) mismatch();
      let result: CenterWalletPaymentState = operation.state === 'pending' ? 'pending' : operation.state === 'confirming' ? 'confirming' : 'unknown';
      const receipt = observation?.receipt;
      const canonical = !!operation.submission && receipt?.canonical === true && hex32(receipt.blockHash) && hex32(receipt.transactionHash) &&
        same(receipt.transactionHash, observation?.transactionHash) && Number.isSafeInteger(receipt.confirmations) && receipt.confirmations > 0 &&
        typeof receipt.blockNumber === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(receipt.blockNumber) && integer(receipt.observedAt);
      if (operation.state === 'confirmed' && observation?.state === 'confirmed' && canonical && receipt?.status === 'success' && observation.semantic?.status === 'verified') result = 'paid';
      if (operation.state === 'reverted' && observation?.state === 'reverted' && canonical &&
        (receipt?.status === 'reverted' || observation.semantic?.status === 'failed')) result = 'reverted';
      if (operation.state === 'expired' && observation?.state === 'expired' && observation.transactionHash === undefined && !receipt) result = 'expired';
      if (operation.state === 'retired' && !operation.submission && !observation) result = 'refused';
      return save({ ...saved.value, status: result, ...(observation ? { observation } : {}) }, saved.encoded);
    } catch (error) {
      if (error instanceof RestClientError && ['WALLET_PAYMENT_STORAGE_UNAVAILABLE', 'WALLET_PAYMENT_CHANGED'].includes(error.code)) throw error;
      return mismatch();
    }
  }
  async function submitPayment(): Promise<Status> {
    let saved = pending();
    const client = live(saved.value).client;
    if (!saved.value.approval || terminal(saved.value.status))
      fail('WALLET_PAYMENT_NOT_APPROVED', 'Retrieve fresh owner approval for this exact payment before submission.');
    // Once a dispatch may have occurred, retain the original bytes/key even after their first-use window.
    if (!saved.value.submissionStarted && saved.value.operation.expiresAt <= now())
      fail('WALLET_PAYMENT_EXPIRED', 'This approval expired before submission. Preserve the payment for recovery.');
    saved = save({ ...saved.value, submissionStarted: true, status: 'submitting' }, saved.encoded);
    try {
      const result = await client.smartAccounts().submitUserOperation(saved.value.operation.id, saved.value.approval!.signature, saved.value.submissionKey);
      return status(receiveOperation(result, saved).value);
    } catch (error) {
      saved = save({ ...saved.value, status: 'unknown' }, saved.encoded);
      // Signa answered with a refusal: the approval is retired at once so a fresh payment can be
      // reviewed, unless a claim won meanwhile, which comes back as that submission. A lost answer
      // stays unknown: its send may still be under way.
      if (error instanceof RestClientError && error.status !== undefined && error.status >= 400) await retire(saved).catch(() => undefined);
      throw error;
    }
  }
  function retire(saved: Saved): Promise<Saved> {
    return live(saved.value).client.smartAccounts().retireUserOperation(saved.value.operation.id).then(result => receiveOperation(result, saved));
  }
  /** Retires an approved payment Signa has not sent (a refusal, or an answer lost before any send) so a
   * fresh one can be reviewed: `refused`, or the submission that already claimed it. */
  async function retirePayment(): Promise<Status> {
    const saved = pending();
    if (!saved.value.approval || terminal(saved.value.status)) fail('WALLET_PAYMENT_NOT_APPROVED', 'Only an approved payment that has not settled can be retired.');
    return status((await retire(saved)).value);
  }
  // The revision of the last operation view received here, per operation: a waiting read waits past it.
  const revisions = new Map<string, number>();
  /** With `waitSeconds`, a submitted payment's read is held on Center until the operation moves. */
  async function refreshPayment(options: { waitSeconds?: number } = {}): Promise<Status> {
    if (options.waitSeconds !== undefined && (!Number.isInteger(options.waitSeconds) || options.waitSeconds < 1 || options.waitSeconds > 20))
      fail('WALLET_PAYMENT_INPUT_INVALID', 'Wait between one and twenty seconds.');
    const saved = pending(), client = live(saved.value).client;
    try {
      if (saved.value.submissionStarted) {
        const since = revisions.get(saved.value.operation.id);
        const wait = options.waitSeconds !== undefined && since !== undefined ? { seconds: options.waitSeconds, since } : undefined;
        return status(receiveOperation(await client.smartAccounts().userOperation(saved.value.operation.id, wait), saved).value);
      }
      if (!saved.value.review) return status((await requestReview(saved)).value);
      if (saved.value.approval) {
        // The approval is the send: an approved payment reads its review, as before, and its
        // operation beside it. One the approval already published carries on as submitted, with
        // the same signed bytes and no submission of its own; one not yet published stays approved
        // for the app to submit.
        const [value, operation] = await Promise.all([
          client.request({ requestTarget: reviewPath + '/' + saved.value.review.id }),
          client.smartAccounts().userOperation(saved.value.operation.id),
        ]);
        const reviewed = receiveView(value, saved, true);
        if (!snapshot(operation).submission && operation.state !== 'retired') return status(reviewed.value);
        return status(receiveOperation(operation, save({ ...reviewed.value, submissionStarted: true, status: 'submitting' }, reviewed.encoded)).value);
      }
      const value = await client.request({ requestTarget: reviewPath + '/' + saved.value.review.id });
      return status(receiveView(value, saved, true).value);
    } catch (error) {
      if (error instanceof RestClientError && ['WALLET_PAYMENT_MISMATCH', 'WALLET_PAYMENT_CHANGED', 'WALLET_PAYMENT_STORAGE_UNAVAILABLE'].includes(error.code)) throw error;
      return status(save({ ...saved.value, status: 'unknown' }, saved.encoded).value);
    }
  }
  function pendingPayment(): Status | null {
    const value = read()?.value;
    return value ? status(value) : null;
  }
  function clearPayment(): void {
    const saved = pending(), archivedAtMs = now(), signing = saved.value.operation.signing;
    if (!('ownerProfile' in signing)) mismatch();
    const settled = terminal(saved.value.status);
    // Explicit local bookkeeping only: this clock and a missing local send marker do not prove an onchain outcome.
    const unsignedWindowElapsed = saved.value.submissionStarted === false && !saved.value.approval &&
      typeof signing.validUntil === 'string' && /^[1-9][0-9]{0,14}$/.test(signing.validUntil) &&
      BigInt(signing.validUntil) < 2n ** 48n && integer(archivedAtMs) &&
      BigInt(Math.floor(archivedAtMs / 1000)) > BigInt(signing.validUntil);
    // A record whose app grant has expired or changed can never be refreshed here again; once its
    // signed validity has also passed, it is archived as unknown so it stops holding up the
    // account, and Center keeps the outcome.
    const validityElapsed = typeof signing.validUntil === 'string' && /^[1-9][0-9]{0,14}$/.test(signing.validUntil) &&
      BigInt(signing.validUntil) < 2n ** 48n && integer(archivedAtMs) && BigInt(Math.floor(archivedAtMs / 1000)) > BigInt(signing.validUntil);
    let grantGone = false;
    try { live(saved.value); } catch { grantGone = true; }
    if (!settled && !unsignedWindowElapsed && !(grantGone && validityElapsed))
      fail('WALLET_PAYMENT_UNRESOLVED', 'Keep this payment until its outcome is verified or its original approval window has elapsed without a saved approval or local submission.');
    const existing = raw(historyKey);
    try {
      const history = existing === null ? [] : JSON.parse(existing);
      if (!Array.isArray(history)) throw new Error();
      // The archive is JSON: it keeps the served reason inside the observation, not the decoded one.
      const { payFailure: _decoded, ...archived } = status(saved.value) as CenterWalletPaymentStatus;
      const receipt = { ...archived, ...(!settled ? { status: 'unknown', archiveReason: unsignedWindowElapsed ? 'no-local-submission-recorded' : 'grant-expired' } : {}),
        issuer, audience, callbackUri, archivedAtMs, grantId: saved.value.grant.id, grantIncarnation: saved.value.grant.incarnation,
        planId: saved.value.plan.id, planCommitment: saved.value.plan.commitment, operationCommitment: saved.value.operation.commitment,
        reviewState: saved.value.state, reviewKey: saved.value.reviewKey, submissionKey: saved.value.submissionKey,
        validAfter: signing.validAfter, validUntil: signing.validUntil };
      // The receipt archive is bounded (64 entries, 1 MiB) and must never keep a settled payment from
      // closing: the oldest receipts go first.
      const receipts = [...history.filter(item => item.operationId !== saved.value.operation.id), receipt];
      const fits = () => receipts.length <= 64 && new TextEncoder().encode(JSON.stringify(receipts)).length <= maximumBytes;
      while (!fits() && receipts.length > 1) receipts.shift();
      const encoded = JSON.stringify(receipts);
      if (!fits() || raw() !== saved.encoded || raw(historyKey) !== existing) throw new Error();
      storage.setItem(historyKey, encoded);
      if (storage.getItem(historyKey) !== encoded || raw() !== saved.encoded) throw new Error();
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new Error();
    } catch { fail('WALLET_PAYMENT_STORAGE_UNAVAILABLE', 'The original payment must be archived before clearing this tab’s pending record.'); }
  }
  function readSignature(): SavedSignature | null {
    const encoded = raw(signatureKey);
    if (encoded === null) return null;
    try {
      if (new TextEncoder().encode(encoded).length > maximumBytes) throw new Error();
      const { integrity, ...value } = JSON.parse(encoded);
      const signing = signatureSigning(value.grant.accountId.split(':')[2], signatureRequestOf(value.request));
      if (integrity !== sha256(stringToHex(uoCanonical(value))) || value.version !== 'center-wallet-signature-client-v1' ||
        value.issuer !== issuer || value.audience !== audience || value.callbackUri !== callbackUri ||
        !['reviewing', 'approved', 'cancelled'].includes(value.status) || !same(value.digest, signing.digest) || !same(value.requestDigest, signing.requestDigest) ||
        !/^signature-review-[0-9a-f]{64}$/.test(value.reviewKey) || (value.reviewId !== undefined && !reviewIdPattern.test(value.reviewId)) ||
        (value.status === 'approved') !== (typeof value.signature === 'string')) throw new Error();
      validateWalletHandoffToken(value.state);
      return { value, encoded };
    } catch { return fail('WALLET_PAYMENT_STORAGE_INVALID', 'The saved signature record is invalid. Preserve it for recovery.'); }
  }
  function signatureStatus(value: SignatureJournal): CenterWalletSignatureStatus {
    return snapshot({ status: value.status, accountId: value.grant.accountId, chainId: value.request.chainId, reviewId: value.review?.id ?? null,
      approvalUrl: value.review ? issuer + '/wallet/payment?review=' + value.review.id : null, expiresAtMs: value.review?.expiresAtMs ?? null,
      request: value.request, requestDigest: value.requestDigest, ...(value.signature ? { signature: value.signature } : {}) });
  }
  /** Keeps Signa's answer only when it is this tab's exact request, under its digests; an approval carries the account's signature over the request digest. */
  function receiveSignature(input: unknown, saved: SavedSignature, appView: boolean): SavedSignature {
    let review: NonNullable<SignatureJournal['review']>, signature: Hex | undefined, decided: string;
    try {
      const value = snapshot(input), s = saved.value, grant = s.grant;
      const v = fields(value, ['version', 'id', 'state', 'issuer', 'accountId', 'app', 'chainId', 'review', 'signing', 'createdAtMs', 'expiresAtMs',
        'status', 'approvedAtMs', 'cancelledAtMs', ...(appView ? ['approval'] : [])]);
      const app = fields(v.app, ['origin', 'callbackUri', 'grantId', 'grantIncarnation']), served = fields(v.review, ['kind', 'chainId', 'request', 'sources']);
      const signing = fields(v.signing, ['digest', 'requestDigest']);
      if (v.version !== 'center-wallet-payment-review-v1' || !uuid(v.id) || (s.reviewId && v.id !== s.reviewId) || (s.review && v.id !== s.review.id) ||
        v.state !== s.state || v.issuer !== issuer || v.accountId !== grant.accountId || app.origin !== grant.origin || app.callbackUri !== callbackUri ||
        app.grantId !== grant.id || app.grantIncarnation !== grant.incarnation || v.chainId !== s.request.chainId ||
        served.kind !== REVIEWED_SIGNATURE_KIND || served.chainId !== s.request.chainId || !equal(served.request, s.request) || !Array.isArray(served.sources) ||
        !same(signing.digest, s.digest) || !same(signing.requestDigest, s.requestDigest) || !integer(v.createdAtMs) || !integer(v.expiresAtMs) ||
        v.expiresAtMs <= v.createdAtMs || !['pending', 'approved', 'cancelled'].includes(String(v.status))) mismatch();
      if (appView && v.status === 'approved') {
        const approval = fields(v.approval, ['signature', 'signedCommitment']);
        if (typeof approval.signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){65,16384}$/.test(approval.signature) || !same(approval.signedCommitment, s.requestDigest)) mismatch();
        signature = approval.signature as Hex;
      } else if (appView && v.approval !== null) mismatch();
      review = { id: v.id as string, createdAtMs: v.createdAtMs as number, expiresAtMs: v.expiresAtMs as number };
      decided = String(v.status);
    } catch { return mismatch(); }
    // An approval already received stays: a later answer can only repeat it.
    if (saved.value.signature && signature !== saved.value.signature) mismatch();
    const state = signature ? 'approved' : decided === 'cancelled' ? 'cancelled' : 'reviewing';
    return save<SignatureJournal>({ ...saved.value, review, status: state, ...(signature ? { signature } : {}) }, saved.encoded, signatureKey);
  }
  /** A signature from the account, reviewed on Signa's page from the raw request. The same request resumes its review;
   * another replaces it, since an unused signature review moves nothing. */
  async function prepareSignature(input: SignatureRequest, options: { reviewId?: string } = {}): Promise<CenterWalletSignatureStatus> {
    chosenReview(options.reviewId);
    let request: SignatureRequest;
    try { request = signatureRequestOf(snapshot(input)); }
    catch { return fail('WALLET_PAYMENT_INPUT_INVALID', 'Send { kind: "typed-data", chainId, typedData } or { kind: "message", chainId, message }.'); }
    const current = live(), existing = readSignature();
    let saved = existing && equal(existing.value.request, request) && equal(existing.value.grant, current.grant) && existing.value.status !== 'cancelled' ? existing : null;
    if (saved?.value.review) return signatureStatus(saved.value);
    if (!saved) saved = save<SignatureJournal>({ version: 'center-wallet-signature-client-v1', issuer, audience, callbackUri, grant: snapshot(current.grant), request,
      ...signatureSigning(current.grant.accountId.split(':')[2] as Address, request), state: handoffState(),
      reviewKey: 'signature-review-' + newRequestNonce().slice(2), ...(options.reviewId ? { reviewId: options.reviewId } : {}), status: 'reviewing' },
    existing?.encoded ?? null, signatureKey);
    const view = await current.client.request({ method: 'POST', requestTarget: '/api/v1/wallet/signature-reviews',
      json: { request: saved.value.request, state: saved.value.state, ...(saved.value.reviewId ? { id: saved.value.reviewId } : {}) }, idempotencyKey: saved.value.reviewKey });
    return signatureStatus(receiveSignature(view, saved, false).value);
  }
  function pendingSignatureRecord(): SavedSignature {
    const saved = readSignature();
    if (!saved?.value.review) fail('WALLET_PAYMENT_MISSING', 'There is no pending signature in this tab.');
    return saved;
  }
  async function completeSignature(callbackUrl?: string): Promise<CenterWalletSignatureStatus> {
    const incoming = callbackUrl ?? location.href();
    try { location.replace(callbackUri); } catch { return fail('WALLET_PAYMENT_CALLBACK_INVALID', 'The payment callback could not be cleared.'); }
    const saved = pendingSignatureRecord();
    checkCallback(incoming, saved.value.review!.id, saved.value.state);
    return refreshSignatureRecord(saved);
  }
  async function refreshSignatureRecord(saved: SavedSignature): Promise<CenterWalletSignatureStatus> {
    const result = await live(saved.value).client.request({ requestTarget: reviewPath + '/' + saved.value.review!.id });
    return signatureStatus(receiveSignature(result, saved, true).value);
  }
  return { preparePayment, prepareReview, reviewUrl, completePayment, submitPayment, refreshPayment, retirePayment, pendingPayment, clearPayment,
    prepareSignature, completeSignature, refreshSignature: () => refreshSignatureRecord(pendingSignatureRecord()),
    pendingSignature: (): CenterWalletSignatureStatus | null => { const saved = readSignature(); return saved ? signatureStatus(saved.value) : null; } };
}

/** Payments of the configured token through the configured terminal: what `wallet.payments()` returns. */
export function createCenterWalletPaymentClient(options: CenterWalletPaymentClientOptions) {
  const j = createWalletReviewJournal<CenterWalletPaymentStatus>(options, 'payment');
  return Object.freeze({ preparePayment: j.preparePayment, reviewUrl: j.reviewUrl, completePayment: j.completePayment, submitPayment: j.submitPayment,
    refreshPayment: j.refreshPayment, retirePayment: j.retirePayment, pendingPayment: j.pendingPayment, clearPayment: j.clearPayment });
}
/** Any call set and any signature, each reviewed on Signa's own page from the raw request: what `wallet.reviews()` returns.
 * A call set follows a payment's states and journal under its own record; a signature is approved or cancelled. */
export function createCenterWalletReviewClient(options: CenterWalletPaymentClientOptions) {
  const j = createWalletReviewJournal<CenterWalletReviewStatus>(options, 'review');
  return Object.freeze({ prepareReview: j.prepareReview, reviewUrl: j.reviewUrl, completeReview: j.completePayment, submitReview: j.submitPayment,
    refreshReview: j.refreshPayment, retireReview: j.retirePayment, pendingReview: j.pendingPayment, clearReview: j.clearPayment,
    prepareSignature: j.prepareSignature, completeSignature: j.completeSignature, refreshSignature: j.refreshSignature, pendingSignature: j.pendingSignature });
}
