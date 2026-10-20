import { array, nullable, object, ref, type Schema } from './schemas.js';

/** Signed app surface only. Central cookie ceremonies belong to the isolated wallet origin. */
export function walletPaymentSchemas(): Record<string, Schema> {
  const milliseconds = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const indexes = array({ type: 'integer', minimum: 0, maximum: 31 }, { minItems: 1, maxItems: 3, uniqueItems: true });
  const state = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', description: 'Canonical base64url encoding of 32 random bytes retained by the initiating app.' };
  const payment = object({ kind: { const: 'v6-usdc-pay', type: 'string' }, chainId: { const: 8453, type: 'integer' },
    account: ref('Address'), token: ref('Address'), terminal: ref('Address'), projectId: ref('Uint256'), amount: ref('PositiveUint256'),
    beneficiary: ref('Address'), minimumReturnedTokens: ref('Uint256'), memo: { type: 'string', maxLength: 32768 },
    metadata: { ...ref('HexBytes'), description: 'Empty (0x), or exactly buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut }) from @bananapus/nana-sdk-core: the buyback registry quote (0, minimum, skipSplits = true) with no tiers, and minimumReturnedTokens at least that minimum. Any other metadata is refused.' },
    stepIndexes: indexes, approvalStepIndexes: { ...indexes, minItems: 0, maxItems: 2 }, paymentStepIndex: { type: 'integer', minimum: 0, maximum: 31 }, resetAllowance: { type: 'boolean' } });
  const properties = { version: { type: 'string', const: 'center-wallet-payment-review-v1' }, id: ref('ResourceId'), state,
    issuer: { type: 'string', format: 'uri' }, accountId: ref('AccountId'),
    app: object({ origin: { type: 'string', format: 'uri' }, callbackUri: { type: 'string', format: 'uri' }, grantId: ref('ResourceId'), grantIncarnation: ref('PositiveUint256') }),
    planId: ref('ResourceId'), planCommitment: ref('Hash'), operationId: ref('ResourceId'), operationCommitment: ref('Hash'), operationHash: ref('Hash'),
    stepIndexes: indexes, operation: ref('UserOperationV07'), chainId: { type: 'integer', const: 8453 }, entryPoint: ref('Address'), safe7579: ref('Address'),
    payment, signing: object({ digest: ref('Hash'), signedData: ref('HexBytes'), validAfter: ref('Uint256'), validUntil: ref('Uint256') }),
    createdAtMs: milliseconds, expiresAtMs: milliseconds, status: { type: 'string', enum: ['pending', 'approved', 'cancelled'] },
    approvedAtMs: nullable(milliseconds), cancelledAtMs: nullable(milliseconds), operationState: { type: 'string' } };
  return {
    // The app may name the review's id (a UUID it drew) to open its page before the review exists; an id already taken is a conflict.
    PrepareWalletPaymentReview: object({ operationId: ref('ResourceId'), state, id: ref('ResourceId') }, ['operationId', 'state']),
    WalletPaymentReview: object(properties),
    WalletPaymentAppReview: object({ ...properties, approval: nullable(object({ signature: ref('HexBytes'), signedCommitment: ref('Hash') })) }),
  };
}
