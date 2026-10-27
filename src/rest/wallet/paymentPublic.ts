import type { WalletPaymentReviewView, WalletPaymentReviewAppView } from './paymentReviewsPostgres.js';
import type { Address, Hex } from 'viem';
import type { UserOperationV07 } from '../userOperations/types.js';
import type { WalletV6UsdcPayment } from '../userOperations/semantics.js';
import { passkeyPayMetadataSteps, type PayMetadataStep } from '../userOperations/userPayMetadata.js';
import { SIGNA_HOME_CHAIN_ID } from './chains.js';
import type { ReviewGas } from '../sponsorCaps.js';
import { reviewGas } from './paymentReviews.js';
import { operationCallsView, reviewedCallsView, type ReviewedCallsReview } from '../userOperations/reviewedCalls.js';
import { reviewedSignatureView, type ReviewedSignatureReview } from '../userOperations/reviewedSignatures.js';
import { isSignatureReview, type WalletReviewDraft, type WalletSignatureReviewDraft } from './paymentReviews.js';

interface WalletReviewPublicBase {
  version: 'center-wallet-payment-review-v1';
  id: string;
  state: string;
  issuer: string;
  accountId: string;
  app: { origin: string; callbackUri: string; grantId: string; grantIncarnation: string };
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
  signing: { digest: Hex; signedData: Hex; validAfter: string; validUntil: string };
  createdAtMs: number;
  expiresAtMs: number;
  status: 'pending' | 'approved' | 'cancelled';
  approvedAtMs: number | null;
  cancelledAtMs: number | null;
  operationState: string;
}
export interface WalletPaymentReviewPublic extends WalletReviewPublicBase { payment: WalletV6UsdcPayment }
/** A reviewed call set carries its calls and their sources in place of a payment. */
export interface WalletReviewedCallsPublic extends WalletReviewPublicBase { review: ReviewedCallsReview }
export type WalletReviewPublic = WalletPaymentReviewPublic | WalletReviewedCallsPublic;
export interface WalletPaymentAppPublic extends WalletPaymentReviewPublic {
  approval: { signature: Hex; signedCommitment: Hex } | null;
}
/** A signature: the exact request, the digest its ERC-1271 signature is for and the passkey's SafeMessage digest over it. */
export interface WalletSignaturePublic extends Pick<WalletReviewPublicBase, 'version' | 'id' | 'state' | 'issuer' | 'accountId' | 'app' | 'chainId' |
  'createdAtMs' | 'expiresAtMs' | 'status' | 'approvedAtMs' | 'cancelledAtMs'> {
  review: ReviewedSignatureReview;
  signing: { digest: Hex; requestDigest: Hex };
}
/** `approval.signature` is the account's ERC-1271 signature over `approval.signedCommitment`, the request digest. */
export type WalletReviewAppPublic = WalletPaymentAppPublic | ((WalletReviewedCallsPublic | WalletSignaturePublic) & Pick<WalletPaymentAppPublic, 'approval'>);
interface WalletCentralPublic {
  /** Shown beside approval: the quote could not read the pool price. Center's own page only. */
  notice: string | null;
  /** Who pays the gas, as the signed paymaster fields fix it. Center's own page only: an app's
   * client checks its view's exact keys. */
  gas: ReviewGas;
  passkey: { rpId: string; credentialId: string; credentialIds: string[]; challenge: string; userVerification: 'required' };
  /** The SDK's model of each call and the function each decoded call used, so the page decodes the bytes itself. */
  reviewedCalls: ReturnType<typeof reviewedCallsView>;
}
export interface WalletPaymentCentralPublic extends WalletPaymentReviewPublic, WalletCentralPublic {
  /** The pay metadata as the SDK's review decoder reads it, decoded here so the page does not bundle the SDK; empty for `0x`. */
  metadataSteps: PayMetadataStep[];
}
export interface WalletReviewedCallsCentralPublic extends WalletReviewedCallsPublic, WalletCentralPublic {}
export interface WalletSignatureCentralPublic extends WalletSignaturePublic, Pick<WalletCentralPublic, 'passkey'> {
  /** What the page re-derives from the request, the warning codes it words itself, and the SDK's view of a call the signature lets someone run. */
  reviewedSignature: ReturnType<typeof reviewedSignatureView>;
}

/** Project an already validated durable review. No internal authority or credential document
 * crosses the app boundary, and returned objects cannot mutate the source receipt. */
function signaturePublic(view: WalletPaymentReviewView, d: WalletSignatureReviewDraft): WalletSignaturePublic {
  return { version: d.version, id: d.id, state: d.state, issuer: d.issuer, accountId: d.authority.accountId,
    app: { origin: d.grant.origin, callbackUri: d.grant.callbackUri, grantId: d.grant.id, grantIncarnation: d.grant.incarnation },
    chainId: d.chainId, review: structuredClone(d.review), signing: { ...d.signing }, createdAtMs: d.createdAtMs, expiresAtMs: d.expiresAtMs,
    status: view.status, approvedAtMs: view.approvedAtMs, cancelledAtMs: view.cancelledAtMs };
}
export function publicWalletPaymentReview(view: WalletPaymentReviewView): WalletReviewPublic | WalletSignaturePublic {
  if (isSignatureReview(view.draft)) return signaturePublic(view, view.draft);
  const d = view.draft as WalletReviewDraft;
  const base: WalletReviewPublicBase = { version: d.version, id: d.id, state: d.state, issuer: d.issuer, accountId: d.authority.accountId,
    app: { origin: d.grant.origin, callbackUri: d.grant.callbackUri, grantId: d.grant.id, grantIncarnation: d.grant.incarnation },
    planId: d.planId, planCommitment: d.planCommitment, operationId: d.operationId, operationCommitment: d.operationCommitment,
    operationHash: d.operationHash, stepIndexes: [...d.stepIndexes], operation: structuredClone(d.operation),
    chainId: d.chainId, entryPoint: d.entryPoint, safe7579: d.safe7579,
    signing: { ...d.signing }, createdAtMs: d.createdAtMs, expiresAtMs: d.expiresAtMs,
    status: view.status, approvedAtMs: view.approvedAtMs, cancelledAtMs: view.cancelledAtMs, operationState: view.operationState ?? 'prepared' };
  return d.review.kind === 'v6-usdc-pay' ? { ...base, payment: structuredClone(d.review.payment) } : { ...base, review: structuredClone(d.review) };
}
export function publicWalletPaymentAppReview(view: WalletPaymentReviewAppView): WalletReviewAppPublic {
  return { ...publicWalletPaymentReview(view), approval: view.approval ? { ...view.approval } : null } as WalletReviewAppPublic;
}
export function publicWalletPaymentCentralReview(view: WalletPaymentReviewView): WalletPaymentCentralPublic | WalletReviewedCallsCentralPublic | WalletSignatureCentralPublic {
  const passkey: WalletCentralPublic['passkey'] = { rpId: view.draft.authority.credential.rpId,
    credentialId: view.draft.authority.credential.credentialId, credentialIds: [...view.approvers],
    challenge: Buffer.from(view.draft.signing.digest.slice(2), 'hex').toString('base64url'), userVerification: 'required' };
  if (isSignatureReview(view.draft)) {
    const d = view.draft;
    return { ...signaturePublic(view, d), passkey, reviewedSignature: reviewedSignatureView(d.review, d.authority.accountId.split(':')[2] as Address) };
  }
  const d = view.draft as WalletReviewDraft, review = publicWalletPaymentReview(view);
  const central: Omit<WalletCentralPublic, 'reviewedCalls'> = { notice: d.notice ?? null, gas: reviewGas(d), passkey };
  return d.review.kind === 'v6-usdc-pay' ? { ...review as WalletPaymentReviewPublic, ...central, metadataSteps: passkeyPayMetadataSteps(d.review.payment.metadata),
    // Described from the operation's own bytes, never the stored payment or the plan's summary.
    reviewedCalls: operationCallsView(d.operation) }
    : { ...review as WalletReviewedCallsPublic, ...central, reviewedCalls: reviewedCallsView(d.review as ReviewedCallsReview, d.operation.sender) };
}
