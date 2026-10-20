import { sha256, stringToHex, type Hex } from 'viem';
import { RestClientError, newRequestNonce, payFailureOf } from './index.js';
import type { CenterClient } from './center.js';
import { assertReviewedOperation, type PreparedUserOperation, type SmartWalletPlan } from './smartAccounts.js';
import type { CenterWalletStorage } from './wallet.js';
import { decodeSafe7579PasskeyOwnerSignature, safe7579PasskeyOwnerSigningPayload } from '../smartAccounts/passkeySignatures.js';
import { normalizeUserOperation, userOperationCommitment, userOperationMaximumCost, uoCanonical } from '../userOperations/codec.js';
import { recognizeWalletV6UsdcPayment, type WalletV6UsdcPayment } from '../userOperations/semantics.js';
import type { PayFailure, UserOperationObservation } from '../userOperations/types.js';
import type { WalletAppGrant } from '../wallet/appGrants.js';
import type { WalletPaymentReviewPublic, WalletPaymentAppPublic } from '../wallet/paymentPublic.js';
import { validateWalletHandoffToken } from '../wallet/sharedHandoff.js';

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
/** `expired`: published but never included before its signed validity ended; it cannot execute. */
export type CenterWalletPaymentState = 'reviewing' | 'approved' | 'submitting' | 'pending' | 'confirming' | 'paid' | 'reverted' | 'cancelled' | 'unknown' | 'expired';
export interface CenterWalletPaymentStatus {
  status: CenterWalletPaymentState;
  accountId: string;
  chainId: 8453;
  operationId: string;
  operationHash: Hex;
  reviewId: string | null;
  approvalUrl: string | null;
  expiresAtMs: number;
  expectedPayment: CenterWalletExpectedPayment;
  /** An observed outer transaction identifier, never an alias for operationHash. */
  transactionHash?: Hex;
  observation?: UserOperationObservation;
  /** Why a reverted payment reverted, when its trace says: the payer can adjust the minimum and retry. */
  payFailure?: PayFailure;
}
/** Internal composition used by wallet.payments(). No owner or app private key crosses this seam. */
export interface CenterWalletPaymentClientOptions {
  issuer: string;
  audience: string;
  callbackUri: string;
  storage: CenterWalletStorage;
  location: { href(): string; replace(url: string): void };
  now(): number;
  connection(): { grant: WalletAppGrant; client: CenterClient } | null;
}
interface Journal extends CenterWalletPaymentInput {
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
const maximumBytes = 1_048_576;
const reviewPath = '/api/v1/wallet/payment-reviews';
const reviewIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const paymentFields = ['kind', 'chainId', 'account', 'token', 'terminal', 'projectId', 'amount', 'beneficiary', 'minimumReturnedTokens', 'memo', 'metadata'] as const;
const states = ['reviewing', 'approved', 'submitting', 'pending', 'confirming', 'paid', 'reverted', 'cancelled', 'unknown', 'expired'];
const terminal = (status: string) => ['paid', 'reverted', 'cancelled', 'expired'].includes(status);
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
function comparablePayment(payment: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(payment).map(([key, value]) => [key,
    ['account', 'token', 'terminal', 'beneficiary', 'metadata'].includes(key) && typeof value === 'string' ? value.toLowerCase() : value]));
}

export function createCenterWalletPaymentClient(options: CenterWalletPaymentClientOptions) {
  const { issuer, audience, callbackUri, storage, location, now } = options;
  const key = 'center.wallet.payment.v1:' + issuer + ':' + callbackUri, historyKey = key + ':history';
  function raw(name = key): string | null {
    try { return storage.getItem(name); } catch { return fail('WALLET_PAYMENT_STORAGE_UNAVAILABLE', 'This tab could not read its payment record.'); }
  }
  function save(value: Journal, expected: string | null): Saved {
    const copy = snapshot(value), integrity = sha256(stringToHex(uoCanonical(copy))), encoded = JSON.stringify({ ...copy, integrity });
    if (raw() !== expected) fail('WALLET_PAYMENT_CHANGED', 'This tab changed its pending payment. Resume the current payment.');
    try {
      if (new TextEncoder().encode(encoded).length > maximumBytes) throw new Error();
      storage.setItem(key, encoded);
      if (storage.getItem(key) !== encoded) throw new Error();
    } catch { return fail('WALLET_PAYMENT_STORAGE_UNAVAILABLE', 'This tab could not preserve its payment before continuing.'); }
    return { value: copy, encoded };
  }
  function checkInput(input: CenterWalletPaymentInput, grant: WalletAppGrant, at: number): WalletV6UsdcPayment {
    try {
      const operation = input.operation, expected = input.expectedPayment;
      assertReviewedOperation(operation, input.plan, at);
      if (operation.chainId !== 8453 || grant.accountId !== 'eip155:8453:' + operation.operation.sender.toLowerCase() ||
        operation.session || operation.submission || operation.observation || input.plan.expiresAt <= at ||
        !hex32(operation.commitment) || !integer(at) || !('ownerProfile' in operation.signing) || operation.signing.ownerProfile !== 'center-passkey-v1') mismatch();
      const signing = operation.signing;
      const derived = safe7579PasskeyOwnerSigningPayload({ operation: operation.operation, chainId: 8453, entryPoint: operation.entryPoint,
        safe7579: signing.typedData.domain.verifyingContract as `0x${string}`, validAfter: signing.validAfter, validUntil: signing.validUntil });
      if (!equal(signing, { ...derived, ownerProfile: 'center-passkey-v1' })) mismatch();
      const payment = recognizeWalletV6UsdcPayment(input.plan, operation.stepIndexes,
        { chainId: 8453, token: expected.token, directV6Terminal: expected.terminal });
      if (!payment || paymentFields.some(field => {
        const actual = payment[field], wanted = expected[field];
        return ['account', 'token', 'terminal', 'beneficiary', 'metadata'].includes(field) ? !same(actual, wanted) : actual !== wanted;
      }) || typeof expected.maximumNetworkFee !== 'string' || !/^[1-9][0-9]{0,77}$/.test(expected.maximumNetworkFee) ||
        BigInt(expected.maximumNetworkFee) >= 2n ** 256n || userOperationMaximumCost(operation.operation) > BigInt(expected.maximumNetworkFee)) mismatch();
      return payment;
    } catch { return mismatch(); }
  }
  function live(value?: Journal) {
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
      userOperationCommitment({ ...saved.operation.operation, signature: approval.signature as Hex }, saved.operation.entryPoint, 8453))) mismatch();
    return { signature: approval.signature as Hex, signedCommitment: approval.signedCommitment };
  }
  function checkView(input: unknown, saved: Journal, appView: boolean): WalletPaymentAppPublic | WalletPaymentReviewPublic {
    try {
      const value = snapshot(input);
      const v = fields(value, ['version', 'id', 'state', 'issuer', 'accountId', 'app', 'planId', 'planCommitment', 'operationId',
        'operationCommitment', 'operationHash', 'stepIndexes', 'operation', 'chainId', 'entryPoint', 'safe7579', 'payment',
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
        v.chainId !== 8453 || !same(v.entryPoint, saved.operation.entryPoint) || !same(v.safe7579, signing.typedData.domain.verifyingContract) ||
        !equal(v.signing, expectedSigning) || !equal(comparablePayment(v.payment as Record<string, unknown>), comparablePayment(payment as unknown as Record<string, unknown>)) ||
        !integer(v.createdAtMs) || v.createdAtMs < saved.startedAtMs - 30_000 || v.createdAtMs > now() + 30_000 ||
        !integer(v.expiresAtMs) || v.expiresAtMs <= v.createdAtMs || v.expiresAtMs > saved.operation.expiresAt ||
        v.expiresAtMs > saved.grant.expiresAt * 1000 || v.expiresAtMs > v.createdAtMs + 300_000 ||
        (saved.review && (v.createdAtMs !== saved.review.createdAtMs || v.expiresAtMs !== saved.review.expiresAtMs)) ||
        !['pending', 'approved', 'cancelled'].includes(String(v.status)) ||
        !['prepared', 'submitting', 'submission_unknown', 'pending', 'unknown', 'confirming', 'confirmed', 'reverted', 'expired'].includes(String(v.operationState))) mismatch();
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
  function status(value: Journal): CenterWalletPaymentStatus {
    // A served reason reaches the app only in its exact shape, and only while this payment stands
    // reverted: an unknown or changed outcome drops it, on the status and inside the observation.
    const payFailure = value.status === 'reverted' && value.observation?.state === 'reverted'
      ? payFailureOf(value.observation.payFailure) : undefined;
    const { payFailure: _served, ...observed } = value.observation ?? {};
    const observation = value.observation && { ...observed, ...(payFailure ? { payFailure } : {}) } as UserOperationObservation;
    return snapshot({ status: value.status, accountId: value.grant.accountId, chainId: 8453, operationId: value.operation.id,
      operationHash: value.operation.operationHash, reviewId: value.review?.id ?? null,
      approvalUrl: value.review ? issuer + '/wallet/payment?review=' + value.review.id : null,
      expiresAtMs: value.review?.expiresAtMs ?? value.operation.expiresAt, expectedPayment: value.expectedPayment,
      ...(observation ? { observation,
        ...(hex32(observation.transactionHash) ? { transactionHash: observation.transactionHash } : {}) } : {}),
      ...(payFailure ? { payFailure } : {}) });
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
  async function preparePayment(input: CenterWalletPaymentInput, options: { reviewId?: string } = {}): Promise<CenterWalletPaymentStatus> {
    if (options.reviewId !== undefined && !reviewIdPattern.test(options.reviewId)) fail('WALLET_PAYMENT_INPUT_INVALID', 'Choose a version 4 UUID for the review.');
    const existing = read();
    if (existing) {
      checkInput(snapshot(input), existing.value.grant, existing.value.startedAtMs);
      if (input.expectedPayment.maximumNetworkFee !== existing.value.expectedPayment.maximumNetworkFee) mismatch();
      if (!equal(existing.value.plan, snapshot(input.plan)) || !equal(existing.value.operation, snapshot(input.operation)))
        fail('WALLET_PAYMENT_PENDING', 'Resolve this tab’s existing payment before preparing another operation.');
      live(existing.value);
      if (existing.value.review) return status(existing.value);
      return status((await requestReview(existing)).value);
    }
    const current = live(), copy = snapshot(input), startedAtMs = now();
    const payment = checkInput(copy, current.grant, startedAtMs);
    const expectedPayment = { ...Object.fromEntries(paymentFields.map(field => [field, payment[field]])), maximumNetworkFee: copy.expectedPayment.maximumNetworkFee } as CenterWalletExpectedPayment;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const state = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const value: Journal = { ...copy, expectedPayment, version: 'center-wallet-payment-client-v1', issuer, audience, callbackUri,
      grant: snapshot(current.grant), startedAtMs, state, reviewKey: 'payment-review-' + newRequestNonce().slice(2),
      ...(options.reviewId ? { reviewId: options.reviewId } : {}),
      submissionKey: 'payment-submit-' + newRequestNonce().slice(2), submissionStarted: false, status: 'reviewing' };
    return status((await requestReview(save(value, null))).value);
  }
  async function completePayment(callbackUrl?: string): Promise<CenterWalletPaymentStatus> {
    const incoming = callbackUrl ?? location.href();
    try { location.replace(callbackUri); } catch { return fail('WALLET_PAYMENT_CALLBACK_INVALID', 'The payment callback could not be cleared.'); }
    const saved = pending();
    try {
      const url = new URL(incoming);
      if (incoming.length > 4096 || incoming.slice(0, incoming.indexOf('?')) !== callbackUri || url.origin + url.pathname !== callbackUri ||
        url.username || url.password || url.hash || [...url.searchParams].length !== 3 ||
        ['review', 'state', 'iss'].some(name => url.searchParams.getAll(name).length !== 1) ||
        url.searchParams.get('review') !== saved.value.review?.id || url.searchParams.get('state') !== saved.value.state || url.searchParams.get('iss') !== issuer) throw new Error();
    } catch { return fail('WALLET_PAYMENT_CALLBACK_INVALID', 'The callback does not match the original payment and app grant.'); }
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
      return save({ ...saved.value, status: result, ...(observation ? { observation } : {}) }, saved.encoded);
    } catch (error) {
      if (error instanceof RestClientError && ['WALLET_PAYMENT_STORAGE_UNAVAILABLE', 'WALLET_PAYMENT_CHANGED'].includes(error.code)) throw error;
      return mismatch();
    }
  }
  async function submitPayment(): Promise<CenterWalletPaymentStatus> {
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
      save({ ...saved.value, status: 'unknown' }, saved.encoded);
      throw error;
    }
  }
  // The revision of the last operation view received here, per operation: a waiting read waits past it.
  const revisions = new Map<string, number>();
  /** With `waitSeconds`, a submitted payment's read is held on Center until the operation moves. */
  async function refreshPayment(options: { waitSeconds?: number } = {}): Promise<CenterWalletPaymentStatus> {
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
        if (!snapshot(operation).submission) return status(reviewed.value);
        return status(receiveOperation(operation, save({ ...reviewed.value, submissionStarted: true, status: 'submitting' }, reviewed.encoded)).value);
      }
      const value = await client.request({ requestTarget: reviewPath + '/' + saved.value.review.id });
      return status(receiveView(value, saved, true).value);
    } catch (error) {
      if (error instanceof RestClientError && ['WALLET_PAYMENT_MISMATCH', 'WALLET_PAYMENT_CHANGED', 'WALLET_PAYMENT_STORAGE_UNAVAILABLE'].includes(error.code)) throw error;
      return status(save({ ...saved.value, status: 'unknown' }, saved.encoded).value);
    }
  }
  function pendingPayment(): CenterWalletPaymentStatus | null {
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
      const receipt = { ...status(saved.value), ...(!settled ? { status: 'unknown', archiveReason: unsignedWindowElapsed ? 'no-local-submission-recorded' : 'grant-expired' } : {}),
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
  return Object.freeze({ preparePayment, reviewUrl, completePayment, submitPayment, refreshPayment, pendingPayment, clearPayment });
}
