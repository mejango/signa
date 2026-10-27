import { array, nullable, object, ref, type Schema } from './schemas.js';
import { SIGNA_HOME_CHAIN_ID } from '../wallet/chains.js';
import { REVIEWED_CALLS_MAXIMUM } from '../userOperations/reviewedCalls.js';
/** Signed app surface only. Central cookie ceremonies belong to the isolated wallet origin. */
export function walletPaymentSchemas(): Record<string, Schema> {
  const milliseconds = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const indexes = array({ type: 'integer', minimum: 0, maximum: 31 }, { minItems: 1, maxItems: 3, uniqueItems: true });
  const state = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', description: 'Canonical base64url encoding of 32 random bytes retained by the initiating app.' };
  const payment = object({ kind: { const: 'v6-usdc-pay', type: 'string' }, chainId: { const: SIGNA_HOME_CHAIN_ID, type: 'integer' },
    account: ref('Address'), token: ref('Address'), terminal: ref('Address'), projectId: ref('Uint256'), amount: ref('PositiveUint256'),
    beneficiary: ref('Address'), minimumReturnedTokens: ref('Uint256'), memo: { type: 'string', maxLength: 32768 },
    metadata: { ...ref('HexBytes'), description: 'Empty (0x), or Juicebox hook metadata in the JBMetadataResolver format (for example prepareUserPay metadata with 721 tiers). The review page shows it through the SDK review decoder; entries it cannot name show as raw hook data under their id. minimumReturnedTokens is what the beneficiary must receive; a buyback minimum in the metadata covers the swap and mint before the reserved split, so it can be higher.' },
    stepIndexes: indexes, approvalStepIndexes: { ...indexes, minItems: 0, maxItems: 2 }, paymentStepIndex: { type: 'integer', minimum: 0, maximum: 31 }, resetAllowance: { type: 'boolean' } });
  const call = object({ to: ref('Address'), value: ref('Uint256'), data: ref('HexBytes') });
  const source = { oneOf: [object({ source: { const: 'first-party', type: 'string' } }),
    object({ source: { const: 'etherscan', type: 'string' }, abi: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'object' },
      description: 'The one verified function the call decodes with, stored so the page decodes with the same one.' }, implementation: ref('Address') }, ['source', 'abi']),
    object({ source: { const: 'raw', type: 'string' }, lookup: { type: 'string', enum: ['no-abi', 'lookup-failed'] } })] };
  const review = object({ kind: { const: 'reviewed-calls-v1', type: 'string' }, chainId: { const: SIGNA_HOME_CHAIN_ID, type: 'integer' },
    calls: array(call, { minItems: 1, maxItems: REVIEWED_CALLS_MAXIMUM }), sources: array(source, { minItems: 1, maxItems: REVIEWED_CALLS_MAXIMUM }) });
  const properties = { version: { type: 'string', const: 'center-wallet-payment-review-v1' }, id: ref('ResourceId'), state,
    issuer: { type: 'string', format: 'uri' }, accountId: ref('AccountId'),
    app: object({ origin: { type: 'string', format: 'uri' }, callbackUri: { type: 'string', format: 'uri' }, grantId: ref('ResourceId'), grantIncarnation: ref('PositiveUint256') }),
    planId: ref('ResourceId'), planCommitment: ref('Hash'), operationId: ref('ResourceId'), operationCommitment: ref('Hash'), operationHash: ref('Hash'),
    stepIndexes: { ...indexes, maxItems: REVIEWED_CALLS_MAXIMUM }, operation: ref('UserOperationV07'), chainId: { type: 'integer', const: SIGNA_HOME_CHAIN_ID }, entryPoint: ref('Address'), safe7579: ref('Address'),
    payment, review, signing: object({ digest: ref('Hash'), signedData: ref('HexBytes'), validAfter: ref('Uint256'), validUntil: ref('Uint256') }),
    createdAtMs: milliseconds, expiresAtMs: milliseconds, status: { type: 'string', enum: ['pending', 'approved', 'cancelled'] },
    approvedAtMs: nullable(milliseconds), cancelledAtMs: nullable(milliseconds), operationState: { type: 'string' } };
  // A payment review carries `payment`; a reviewed call set carries `review` instead.
  const required = Object.keys(properties).filter(key => key !== 'payment' && key !== 'review');
  const either = { oneOf: [{ required: ['payment'] }, { required: ['review'] }] };
  const request = { oneOf: [
    object({ kind: { const: 'typed-data', type: 'string' }, chainId: { const: SIGNA_HOME_CHAIN_ID, type: 'integer' },
      typedData: { ...object({ domain: { type: 'object' }, types: { type: 'object' }, primaryType: { type: 'string' }, message: { type: 'object' } }),
        description: 'EIP-712 typed data as eth_signTypedData_v4 takes it. Its domain must name this chainId; integers above 2^53 go as decimal strings.' } }),
    object({ kind: { const: 'message', type: 'string' }, chainId: { const: SIGNA_HOME_CHAIN_ID, type: 'integer' },
      message: { type: 'string', minLength: 1, maxLength: 16384, description: 'UTF-8 text, signed as personal_sign (EIP-191) signs it.' } })] };
  const approval = nullable(object({ signature: ref('HexBytes'), signedCommitment: ref('Hash') }));
  const signature = { ...Object.fromEntries(['version', 'id', 'state', 'issuer', 'accountId', 'app', 'chainId', 'createdAtMs', 'expiresAtMs', 'status',
    'approvedAtMs', 'cancelledAtMs'].map(key => [key, properties[key as keyof typeof properties]])),
    review: object({ kind: { const: 'reviewed-signature-v1', type: 'string' }, chainId: { const: SIGNA_HOME_CHAIN_ID, type: 'integer' }, request,
      sources: array(source, { maxItems: 1 }) }),
    signing: object({ digest: { ...ref('Hash'), description: "The account's SafeMessage digest of requestDigest: what the passkey signs." },
      requestDigest: { ...ref('Hash'), description: 'The EIP-712 or EIP-191 hash of the request: what isValidSignature checks.' } }) };
  return {
    // Any call set from the account. Calls go out in order as one atomic execution; `expectation`, one entry per call, is
    // checked against the decode ({ functionName, args } for a decoded call, null for a raw one) and never shown.
    PrepareReviewedCalls: object({ bindingId: ref('Hash'), chainId: { const: SIGNA_HOME_CHAIN_ID, type: 'integer' }, account: ref('Address'),
      calls: array(object({ to: ref('Address'), value: ref('Uint256'), data: ref('HexBytes') }, ['to', 'data']), { minItems: 1, maxItems: REVIEWED_CALLS_MAXIMUM }),
      expectation: array({ anyOf: [object({ functionName: { type: 'string' }, args: { type: 'array' } }), { type: 'null' }] }, { maxItems: REVIEWED_CALLS_MAXIMUM }) },
    ['bindingId', 'account', 'calls']),
    // The app may name the review's id (a UUID it drew) to open its page before the review exists; an id already taken is a conflict.
    PrepareWalletPaymentReview: object({ operationId: ref('ResourceId'), state, id: ref('ResourceId') }, ['operationId', 'state']),
    // The account signs the request through its own ERC-1271 check; refusals (self-administration, another chain) are 422.
    PrepareWalletSignatureReview: object({ request, state, id: ref('ResourceId') }, ['request', 'state']),
    WalletSignatureReview: object(signature),
    WalletSignatureAppReview: object({ ...signature, approval }),
    WalletPaymentReview: { ...object(properties, required), ...either },
    WalletPaymentAppReview: { ...object({ ...properties, approval },
      [...required, 'approval']), ...either },
  };
}
