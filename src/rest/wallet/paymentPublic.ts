import type { WalletPaymentReviewView, WalletPaymentReviewAppView } from './paymentReviewsPostgres.js';
import type { Address, Hex } from 'viem';
import type { UserOperationV07 } from '../userOperations/types.js';
import type { WalletV6UsdcPayment } from '../userOperations/semantics.js';
import { passkeyPayMetadataSteps, type PayMetadataStep } from '../userOperations/userPayMetadata.js';

export interface WalletPaymentReviewPublic {
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
  chainId: 8453;
  entryPoint: Address;
  safe7579: Address;
  payment: WalletV6UsdcPayment;
  signing: { digest: Hex; signedData: Hex; validAfter: string; validUntil: string };
  createdAtMs: number;
  expiresAtMs: number;
  status: 'pending' | 'approved' | 'cancelled';
  approvedAtMs: number | null;
  cancelledAtMs: number | null;
  operationState: string;
}
export interface WalletPaymentAppPublic extends WalletPaymentReviewPublic {
  approval: { signature: Hex; signedCommitment: Hex } | null;
}
export interface WalletPaymentCentralPublic extends WalletPaymentReviewPublic {
  /** Shown beside approval: the quote could not read the pool price. Center's own page only. */
  notice: string | null;
  passkey: { rpId: string; credentialId: string; challenge: string; userVerification: 'required' };
  /** The pay metadata as the SDK's review decoder reads it, decoded here so the page does not bundle the SDK; empty for `0x`. */
  metadataSteps: PayMetadataStep[];
}

/** Project an already validated durable review. No internal authority or credential document
 * crosses the app boundary, and returned objects cannot mutate the source receipt. */
export function publicWalletPaymentReview(view: WalletPaymentReviewView): WalletPaymentReviewPublic {
  const d = view.draft;
  return { version: d.version, id: d.id, state: d.state, issuer: d.issuer, accountId: d.authority.accountId,
    app: { origin: d.grant.origin, callbackUri: d.grant.callbackUri, grantId: d.grant.id, grantIncarnation: d.grant.incarnation },
    planId: d.planId, planCommitment: d.planCommitment, operationId: d.operationId, operationCommitment: d.operationCommitment,
    operationHash: d.operationHash, stepIndexes: [...d.stepIndexes], operation: structuredClone(d.operation),
    chainId: d.chainId, entryPoint: d.entryPoint, safe7579: d.safe7579, payment: structuredClone(d.payment),
    signing: { ...d.signing }, createdAtMs: d.createdAtMs, expiresAtMs: d.expiresAtMs,
    status: view.status, approvedAtMs: view.approvedAtMs, cancelledAtMs: view.cancelledAtMs, operationState: view.operationState };
}
export function publicWalletPaymentAppReview(view: WalletPaymentReviewAppView): WalletPaymentAppPublic {
  return { ...publicWalletPaymentReview(view), approval: view.approval ? { ...view.approval } : null };
}
export function publicWalletPaymentCentralReview(view: WalletPaymentReviewView): WalletPaymentCentralPublic {
  const d = view.draft;
  return { ...publicWalletPaymentReview(view), notice: d.notice ?? null, passkey: { rpId: d.authority.credential.rpId,
    credentialId: d.authority.credential.credentialId,
    challenge: Buffer.from(d.signing.digest.slice(2), 'hex').toString('base64url'), userVerification: 'required' },
    metadataSteps: passkeyPayMetadataSteps(d.payment.metadata) };
}
