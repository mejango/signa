import { privateKeyToAccount } from 'viem/accounts';
import { CenterClient } from '../../src/rest/client/center.js';
import { createCenterWalletReviewClient } from '../../src/rest/client/walletPayments.js';
import { signatureSigning } from '../../src/rest/userOperations/reviewedSignatureRules.js';
import { createWalletPaymentClientFixture } from './wallet-payment-client.js';

const reviewId = '550e8400-e29b-41d4-a716-446655440000';

/** A Signa account reviewing an app's raw call set, and a raw signature request, through Signa's own page. */
export function createWalletReviewsFixture() {
  const f = createWalletPaymentClientFixture(), data = new Map<string, string>();
  const calls: Array<{ method: string; path: string; body: any; key: string | null }> = [];
  const appKey = privateKeyToAccount(`0x${'37'.repeat(32)}`);
  const grant = { ...f.grant, signerAddress: appKey.address.toLowerCase() as typeof appKey.address };
  const bindingId = f.plan.smartAccount!.bindingId;
  /** One call set Signa plans and the app prepares: the approve and pay a payment fixture builds, as raw calls. */
  function callSet(base: ReturnType<typeof createWalletPaymentClientFixture>) {
    const sent = base.plan.draft.calls.map(call => ({ to: call.to, value: BigInt(call.value), data: call.data }));
    const sources = sent.map(() => ({ source: 'first-party' }));
    const plan = { ...structuredClone(base.plan), draft: { operation: 'reviewed-calls', account: base.safe, evidence: base.plan.draft.evidence, warnings: [],
      summary: { kind: 'reviewed-calls-v1', sources }, calls: base.plan.draft.calls.map((call, index) => ({ ...call, label: '', dependsOn: index ? [index - 1] : [] })) } } as any;
    return { base, sent, sources, plan };
  }
  let current = callSet(f);
  const { sent, plan } = current;
  const signatureRequest = { kind: 'message' as const, chainId: 8453, message: 'Sign in to Beep' };
  const signatureSigning_ = signatureSigning(f.safe, signatureRequest);
  const accountSignature = `0x${'00'.repeat(20)}${'ab'.repeat(97)}` as `0x${string}`;
  let state = '', reviewStatus = 'approved', operation: any = f.observedOperation('pending'), cancellations = 0, approveOnCancel = false, kind: 'calls' | 'signature' = 'calls';
  const app = { origin: grant.origin, callbackUri: grant.callbackUri, grantId: grant.id, grantIncarnation: grant.incarnation };
  function view(status: string, appView: boolean) {
    const decided = { status, approvedAtMs: status === 'approved' ? f.nowMs : null, cancelledAtMs: status === 'cancelled' ? f.nowMs : null };
    if (kind === 'signature') return { version: 'center-wallet-payment-review-v1', id: reviewId, state, issuer: f.issuer, accountId: grant.accountId, app,
      chainId: 8453, review: { kind: 'reviewed-signature-v1', chainId: 8453, request: signatureRequest, sources: [] }, signing: signatureSigning_,
      createdAtMs: f.nowMs, expiresAtMs: f.nowMs + 300_000, ...decided,
      ...(appView ? { approval: status === 'approved' ? { signature: accountSignature, signedCommitment: signatureSigning_.requestDigest } : null } : {}) };
    const { base, plan, sent, sources } = current, signing = base.prepared.signing as any;
    return { version: 'center-wallet-payment-review-v1', id: reviewId, state, issuer: f.issuer, accountId: grant.accountId, app,
      planId: plan.id, planCommitment: plan.commitment, operationId: base.prepared.id, operationCommitment: base.prepared.commitment,
      operationHash: base.prepared.operationHash, stepIndexes: base.prepared.stepIndexes, operation: base.prepared.operation, chainId: 8453,
      entryPoint: f.entryPoint, safe7579: f.safe7579,
      review: { kind: 'reviewed-calls-v1', chainId: 8453, calls: sent.map(call => ({ ...call, value: call.value.toString() })), sources },
      signing: { digest: signing.digest, signedData: signing.signedData, validAfter: signing.validAfter, validUntil: signing.validUntil },
      createdAtMs: f.nowMs, expiresAtMs: base.prepared.expiresAt, ...decided, operationState: 'prepared',
      ...(appView ? { approval: status === 'approved' ? { signature: base.signature, signedCommitment: base.signedCommitment } : null } : {}) };
  }
  const transport = (async (input, init) => {
    const url = new URL(String(input)), path = url.pathname, headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path, body, key: headers.get('idempotency-key') });
    if (path === '/api/v1/smart-accounts/bindings') return Response.json({ items: [{ id: bindingId, wallet: { chainId: 8453, address: f.safe }, manifestId: 'base' }] });
    if (path === '/api/v1/wallet/reviewed-calls') return Response.json(current.plan, { status: 201 });
    if (path === '/api/v1/user-operations') return Response.json(current.base.prepared, { status: 201 });
    if (path === '/api/v1/wallet/payment-reviews' || path === '/api/v1/wallet/signature-reviews') { state = body.state; return Response.json(view('pending', false), { status: 201 }); }
    if (path === '/api/v1/wallet/payment-reviews/' + reviewId) return Response.json(view(reviewStatus, true));
    // The app withdraws a review its person closed; one approved meanwhile stays approved.
    if (path === '/api/v1/wallet/payment-reviews/' + reviewId + '/cancellation') {
      cancellations++;
      if (approveOnCancel) reviewStatus = 'approved';
      if (reviewStatus === 'approved') return Response.json({ code: 'WALLET_PAYMENT_REVIEW_CONFLICT', message: 'The original payment review cannot be replaced or reused.' }, { status: 409 });
      reviewStatus = 'cancelled'; return Response.json(view('cancelled', true));
    }
    if (path === '/api/v1/user-operations/' + f.prepared.id + '/submissions') return Response.json(operation);
    if (path === '/api/v1/user-operations/' + f.prepared.id) return Response.json(operation);
    throw new Error('Unexpected request ' + path);
  }) as typeof fetch;
  const client = new CenterClient({ audience: f.audience, accountId: f.accountId, grantId: f.grant.id, signer: appKey, fetch: transport, now: () => Math.floor(f.nowMs / 1000) });
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  let href = f.origin + '/pay';
  const options = { issuer: f.issuer, audience: f.audience, callbackUri: f.callbackUri, storage, now: () => f.nowMs,
    location: { href: () => href, replace: (value: string) => { href = value; } }, connection: () => ({ grant, client }) };
  return { ...f, calls, data, sent, plan, bindingId, signatureRequest, signatureSigning: signatureSigning_, accountSignature, options,
    reviews: () => createCenterWalletReviewClient(options),
    callback: () => f.callbackUri + '?' + new URLSearchParams({ review: reviewId, state, iss: f.issuer }),
    signatures: () => { kind = 'signature'; }, cancel: () => { reviewStatus = 'cancelled'; }, observed: (value: any) => { operation = value; },
    /** Signa's page is open, or was closed, with no decision. */
    undecided: () => { reviewStatus = 'pending'; }, approve: () => { reviewStatus = 'approved'; }, approveOnCancel: () => { approveOnCancel = true; }, cancellations: () => cancellations,
    /** The app's next action: another call set (a pay with other metadata), its own plan and operation. */
    nextCalls: () => { current = callSet(createWalletPaymentClientFixture(f.nowMs, '0xabcd')); return current; } };
}
