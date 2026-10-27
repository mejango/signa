import { buildSync } from 'esbuild';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { sha256, stringToHex } from 'viem';
import { CenterClient } from '../src/rest/client/center.js';
import { createCenterWalletClient } from '../src/rest/client/wallet.js';
import { readRequestClaims, verifyRequestSignature } from '../src/rest/auth/signatures.js';
import { createCenterWalletPaymentClient } from '../src/rest/client/walletPayments.js';
import { uoCanonical } from '../src/rest/userOperations/codec.js';
import { createWalletPaymentClientFixture } from './fixtures/wallet-payment-client.js';
import { createWalletReviewsFixture } from './fixtures/wallet-reviews-client.js';
import { signaWalletAdapter } from '../wallet-client/src/core/adapter.js';

const reviewId = '550e8400-e29b-41d4-a716-446655440000';
function fixture() {
  const f = createWalletPaymentClientFixture(), data = new Map<string, string>();
  const calls: Array<{ path: string; body: any; key: string | null; search: string }> = [];
  const appKey = privateKeyToAccount(`0x${'37'.repeat(32)}`);
  let grant = { ...f.grant, signerAddress: appKey.address.toLowerCase() as typeof appKey.address }, active = true;
  let now = f.nowMs, href = f.origin + '/pay', state = '', loseReview = false, loseSubmission = false, reviewMissing = false, refusal: unknown;
  let loseRetirement = false, reviewStatus = 'approved', operation = { ...f.prepared, state: 'pending' } as any;
  let submissionBodyFailure: 'read' | 'truncated' | undefined;
  let heldSubmission: { started(): void; response: Response | undefined; promise: Promise<Response> } | undefined;
  let heldReview: typeof heldSubmission;
  let mutateView: (value: any) => any = value => value;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const location = { href: () => href, replace: (value: string) => { href = value; } };
  function view(status: string, app: boolean) {
    const signing = f.prepared.signing as any;
    return mutateView({ version: 'center-wallet-payment-review-v1', id: reviewId, state, issuer: f.issuer, accountId: grant.accountId,
      app: { origin: grant.origin, callbackUri: grant.callbackUri, grantId: grant.id, grantIncarnation: grant.incarnation },
      planId: f.plan.id, planCommitment: f.plan.commitment, operationId: f.prepared.id,
      operationCommitment: f.prepared.commitment, operationHash: f.prepared.operationHash, stepIndexes: f.prepared.stepIndexes,
      operation: f.prepared.operation, chainId: 8453, entryPoint: f.entryPoint, safe7579: f.safe7579, payment: f.payment,
      signing: { digest: signing.digest, signedData: signing.signedData, validAfter: signing.validAfter, validUntil: signing.validUntil },
      createdAtMs: f.nowMs, expiresAtMs: f.prepared.expiresAt, status, approvedAtMs: status === 'approved' ? f.nowMs : null,
      cancelledAtMs: status === 'cancelled' ? f.nowMs : null, operationState: operation.state,
      ...(app ? { approval: status === 'approved' ? { signature: f.signature, signedCommitment: f.signedCommitment } : null } : {}) });
  }
  const transport = (async (input, init) => {
    const url = new URL(String(input)), path = url.pathname, headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : undefined;
    const signed = readRequestClaims({ method: init?.method ?? 'GET', requestTarget: path + url.search, contentType: headers.get('content-type') ?? '',
      body: init?.body ? init.body as Uint8Array : new Uint8Array(), headers });
    await verifyRequestSignature(f.audience, signed.claims, signed.signature);
    expect(signed.claims.accountId).toBe(f.accountId); expect(signed.claims.grantId).toBe(f.grant.id);
    expect(signed.claims.signer.toLowerCase()).toBe(grant.signerAddress.toLowerCase());
    expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store');
    calls.push({ path, body, key: headers.get('idempotency-key'), search: url.search });
    if (path === '/api/v1/wallet/payment-reviews') {
      expect(body.operationId).toBe(f.prepared.id);
      expect([...data.values()].some(value => JSON.parse(value).version === 'center-wallet-payment-client-v1')).toBe(true); state = body.state;
      if (loseReview) { loseReview = false; throw new Error('response disappeared'); }
      return Response.json(view('pending', false));
    }
    if (path === '/api/v1/wallet/payment-reviews/' + reviewId) {
      if (reviewMissing) return Response.json({ error: { code: 'WALLET_PAYMENT_REVIEW_EXPIRED' } }, { status: 410 });
      if (heldReview) {
        const held = heldReview; heldReview = undefined;
        held.response = Response.json(view(reviewStatus, true)); held.started(); return held.promise;
      }
      return Response.json(view(reviewStatus, true));
    }
    if (path === '/api/v1/user-operations/' + f.prepared.id + '/submissions') {
      expect(body).toEqual({ signature: f.signature });
      expect([...data.values()].some(value => JSON.parse(value).submissionStarted === true)).toBe(true);
      if (loseSubmission) { loseSubmission = false; throw new Error('send result disappeared'); }
      if (refusal) { const body = refusal; refusal = undefined; return Response.json(body, { status: 502 }); }
      if (submissionBodyFailure) {
        const failure = submissionBodyFailure; submissionBodyFailure = undefined;
        const body = new ReadableStream<Uint8Array>({ start(stream) {
          stream.enqueue(new TextEncoder().encode('{"operation":'));
          if (failure === 'read') stream.error(new Error('body connection interrupted')); else stream.close();
        } });
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      }
      if (heldSubmission) {
        const held = heldSubmission; heldSubmission = undefined;
        held.response = Response.json(operation); held.started(); return held.promise;
      }
      return Response.json(operation);
    }
    if (path === '/api/v1/user-operations/' + f.prepared.id) return Response.json(operation);
    if (path === '/api/v1/user-operations/' + f.prepared.id + '/retirement') {
      expect(body).toEqual({});
      if (loseRetirement) { loseRetirement = false; throw new Error('retirement answer disappeared'); }
      // Retirement takes an unclaimed operation only; a claimed one comes back as it is.
      if (!operation.submission) operation = { ...structuredClone(f.prepared), state: 'retired', revision: 1 };
      return Response.json(operation);
    }
    throw new Error('Unexpected request.');
  }) as typeof fetch;
  const client = new CenterClient({ audience: f.audience, accountId: f.accountId, grantId: f.grant.id, signer: appKey, fetch: transport, now: () => Math.floor(now / 1000) });
  const options = { issuer: f.issuer, audience: f.audience, callbackUri: f.callbackUri, storage, location, now: () => now,
    connection: () => active ? { grant, client } : null };
  function holdNextResponse(kind: 'review' | 'submission') {
    let started!: () => void, resolve!: (value: Response) => void, reject!: (reason: Error) => void;
    const startedPromise = new Promise<void>(done => { started = done; });
    const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
    const held = { started, promise, response: undefined as Response | undefined };
    if (kind === 'review') heldReview = held; else heldSubmission = held;
    return { started: startedPromise, release: (outcome: 'success' | 'failure') => {
      if (outcome === 'success') resolve(held.response!); else reject(new Error('stale response failure'));
    } };
  }
  return { ...f, data, calls, storage, options, transport, helper: () => createCenterWalletPaymentClient(options),
    input: () => ({ plan: f.plan, operation: f.prepared, expectedPayment: f.expected }),
    callback: () => { href = f.callbackUri + '?' + new URLSearchParams({ review: reviewId, state, iss: f.issuer }); return href; }, href: () => href,
    loseReview: () => { loseReview = true; }, loseSubmission: () => { loseSubmission = true; }, loseRetirement: () => { loseRetirement = true; }, refuseSubmission: (body: unknown) => { refusal = body; }, expireReview: () => { reviewMissing = true; },
    loseSubmissionBody: (kind: 'read' | 'truncated') => { submissionBodyFailure = kind; },
    holdNextSubmission: () => holdNextResponse('submission'), holdNextReview: () => holdNextResponse('review'),
    replaceGrant: () => { grant = { ...grant, incarnation: '2' }; }, disconnect: () => { active = false; }, advance: (ms: number) => { now += ms; },
    replaceSigner: (address: `0x${string}`) => { grant = { ...grant, signerAddress: address }; },
    changeView: (fn: typeof mutateView) => { mutateView = fn; }, cancel: () => { reviewStatus = 'cancelled'; },
    observed: (value: any) => { operation = value; } };
}

describe('Center browser payment review continuity', () => {
  it('composes the packaged wallet connection into payment review and submission without exposing its app key', async () => {
    const f = fixture(), code = Buffer.alloc(32, 5).toString('base64url'), intentId = Buffer.alloc(32, 4).toString('base64url');
    let handoff: any;
    const transport = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/wallet/config') return Response.json({ version: 'center-wallet-v1', issuer: f.issuer, audience: f.audience,
        rpId: f.rpId, app: { origin: f.origin, callbackUris: [f.callbackUri], generation: 1 } });
      if (url.pathname === '/wallet/handoff/prepare') {
        handoff = JSON.parse(String(init?.body)).request; f.replaceSigner(handoff.requestKey);
        return Response.json({ id: intentId, request: handoff, state: 'prepared', createdAtMs: f.nowMs, expiresAtMs: handoff.expiresAtMs });
      }
      if (url.pathname === '/wallet/handoff/exchange') return Response.json({ grant: f.options.connection()!.grant, replayed: false });
      return f.transport(input, init);
    }) as typeof fetch;
    const wallet = createCenterWalletClient({ issuer: f.issuer, audience: f.audience, callbackUri: f.callbackUri,
      storage: f.storage, location: f.options.location, now: f.options.now, fetch: transport });
    await wallet.prepareConnection();
    await wallet.completeConnection(f.callbackUri + '?' + new URLSearchParams({ code, state: handoff.state, iss: f.issuer }));
    const payments = wallet.payments();
    expect((await payments.preparePayment(f.input())).reviewId).toBe(reviewId);
    await payments.completePayment(f.callback()); expect((await payments.submitPayment()).status).toBe('pending');
    wallet.disconnect(); await expect(payments.submitPayment()).rejects.toMatchObject({ code: 'WALLET_PAYMENT_CONNECTION_CHANGED' });
    expect(payments.pendingPayment()!.operationId).toBe(f.prepared.id);
  });

  it('sends the review id the app chose, refuses a review under another id, and names the page for an id ahead of the review', async () => {
    const f = fixture(), helper = f.helper();
    expect(helper.reviewUrl(reviewId)).toBe(f.issuer + '/wallet/payment?review=' + reviewId);
    expect(() => helper.reviewUrl('not-a-uuid')).toThrow();
    const prepared = await helper.preparePayment(f.input(), { reviewId });
    expect(prepared.approvalUrl).toBe(f.issuer + '/wallet/payment?review=' + reviewId);
    expect(f.calls.find(call => call.path === '/api/v1/wallet/payment-reviews')!.body.id).toBe(reviewId);
    expect(JSON.parse([...f.data.values()][0]!).reviewId).toBe(reviewId);
    const other = fixture();
    await expect(other.helper().preparePayment(other.input(), { reviewId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' })).rejects.toMatchObject({ code: 'WALLET_PAYMENT_MISMATCH' });
    await expect(fixture().helper().preparePayment(f.input(), { reviewId: 'nope' })).rejects.toMatchObject({ code: 'WALLET_PAYMENT_INPUT_INVALID' });
  });
  it('carries an approved payment the approval already sent on as submitted, and leaves an unsent one approved for the app', async () => {
    const f = fixture(), helper = f.helper();
    await helper.preparePayment(f.input());
    expect((await helper.completePayment(f.callback())).status).toBe('approved');
    // Not yet published: the read leaves it approved (and reads the review beside the operation).
    const unsent = f.observedOperation('pending'); delete unsent.submission; f.observed({ ...unsent, state: 'prepared', observation: undefined });
    expect((await helper.refreshPayment()).status).toBe('approved');
    expect(f.calls.at(-1)!.path === '/api/v1/user-operations/' + f.prepared.id || f.calls.at(-2)!.path === '/api/v1/user-operations/' + f.prepared.id).toBe(true);
    // Published by the approval: submitted from here on, with no submission of its own.
    f.observed(f.observedOperation('confirming'));
    expect((await helper.refreshPayment()).status).toBe('confirming');
    expect(helper.pendingPayment()!.status).toBe('confirming');
    expect(f.calls.filter(call => call.path.endsWith('/submissions'))).toHaveLength(0);
    await expect(helper.submitPayment()).resolves.toBeTruthy();
    // A published operation under other bytes than the approval's is a mismatch.
    const g = fixture(); await g.helper().preparePayment(g.input()); await g.helper().completePayment(g.callback());
    g.observed({ ...g.observedOperation('confirming'), submission: { commitment: `0x${'ab'.repeat(32)}`, startedAt: g.nowMs } });
    await expect(g.helper().refreshPayment()).rejects.toMatchObject({ code: 'WALLET_PAYMENT_MISMATCH' });
  });
  it('binds a signed review, owner envelope and one submission key to the original exact payment', async () => {
    const f = fixture(), helper = f.helper(), prepared = await helper.preparePayment(f.input());
    expect(prepared.approvalUrl).toBe(f.issuer + '/wallet/payment?review=' + reviewId);
    expect(prepared.operationId).toBe(f.prepared.id);
    const saved = JSON.parse([...f.data.values()][0]!);
    expect(saved.grant.incarnation).toBe('1'); expect(saved.submissionKey).toBeTruthy();
    expect((await helper.completePayment(f.callback())).status).toBe('approved');
    expect(f.href()).toBe(f.callbackUri);
    expect((await helper.submitPayment()).status).toBe('pending');
    expect(f.calls.at(-1)!.key).toBe(saved.submissionKey);
    expect(f.helper().pendingPayment()!.operationId).toBe(f.prepared.id);
    expect(JSON.stringify(helper.pendingPayment())).not.toContain(f.signature);
  });

  it('recovers a lost review response with the same operation, state and idempotency key after reload', async () => {
    const f = fixture(); f.loseReview();
    await expect(f.helper().preparePayment(f.input())).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const first = f.calls[0];
    expect((await f.helper().refreshPayment()).reviewId).toBe(reviewId);
    expect(f.calls[1]).toEqual(first);
  });

  it('keeps overlapping review requests bound to one local operation and idempotency key', async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.helper().preparePayment(f.input()), f.helper().preparePayment(f.input())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'WALLET_PAYMENT_CHANGED' } });
    expect(f.calls).toHaveLength(2); expect(f.calls[0]).toEqual(f.calls[1]);
    expect(f.helper().pendingPayment()!.reviewId).toBe(reviewId);
  });

  it('keeps overlapping explicit submissions bound to the original approved envelope and submission key', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    const results = await Promise.allSettled([f.helper().submitPayment(), f.helper().submitPayment()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const sends = f.calls.filter(call => call.path.endsWith('/submissions'));
    expect(sends).toHaveLength(2); expect(sends[0]).toEqual(sends[1]);
    expect(f.helper().pendingPayment()!.status).toBe('pending');
  });

  it('retries a lost submission with its original approved bytes and key even after review expiration', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); f.loseSubmission();
    await expect(f.helper().submitPayment()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const first = f.calls.at(-1); f.advance(301_000); f.expireReview();
    expect((await f.helper().submitPayment()).status).toBe('pending');
    expect(f.calls.at(-1)).toEqual(first);
    expect(f.helper().pendingPayment()!.operationId).toBe(f.prepared.id);
  });

  it.each(['read', 'truncated'] as const)('recovers a fulfilled HTTP response with a %s body failure using the original submission', async kind => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); f.loseSubmissionBody(kind);
    await expect(f.helper().submitPayment()).rejects.toMatchObject({ code: kind === 'read' ? 'NETWORK_ERROR' : 'INVALID_RESPONSE' });
    const first = f.calls.at(-1);
    expect(f.helper().pendingPayment()!.status).toBe('unknown');
    expect((await f.helper().submitPayment()).status).toBe('pending');
    expect(f.calls.at(-1)).toEqual(first);
    expect(f.calls.filter(call => call.path === '/api/v1/wallet/payment-reviews')).toHaveLength(1);
  });

  it.each(['success', 'failure'] as const)('cannot overwrite newer paid evidence with a held stale %s', async outcome => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    const held = f.holdNextSubmission(), old = f.helper().submitPayment().then(value => value, error => error);
    await held.started;
    await f.helper().submitPayment(); f.observed(f.observedOperation()); await f.helper().refreshPayment();
    const saved = [...f.data.entries()]; held.release(outcome);
    expect(await old).toMatchObject({ code: 'WALLET_PAYMENT_CHANGED' });
    expect([...f.data.entries()]).toEqual(saved); expect(f.helper().pendingPayment()!.status).toBe('paid');
    const sends = f.calls.filter(call => call.path.endsWith('/submissions'));
    expect(sends).toHaveLength(2); expect(sends[0]).toEqual(sends[1]);
  });

  it.each(['success', 'failure'] as const)('cannot recreate an archived payment from a held stale %s', async outcome => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    const held = f.holdNextSubmission(), old = f.helper().submitPayment().then(value => value, error => error);
    await held.started;
    await f.helper().submitPayment(); f.observed(f.observedOperation()); await f.helper().refreshPayment(); f.helper().clearPayment();
    const saved = [...f.data.entries()]; held.release(outcome);
    expect(await old).toMatchObject({ code: 'WALLET_PAYMENT_CHANGED' });
    expect([...f.data.entries()]).toEqual(saved); expect(f.helper().pendingPayment()).toBeNull();
    expect(f.calls.filter(call => call.path === '/api/v1/wallet/payment-reviews')).toHaveLength(1);
    expect(f.calls.filter(call => call.path.endsWith('/submissions'))).toHaveLength(2);
  });

  it.each(['state', 'issuer', 'review', 'duplicate', 'extra', 'path', 'fragment'])('rejects callback %s replacement before fetching approval', async kind => {
    const f = fixture(); await f.helper().preparePayment(f.input()); const url = new URL(f.callback());
    if (kind === 'state') url.searchParams.set('state', 'A'.repeat(43));
    if (kind === 'issuer') url.searchParams.set('iss', 'https://evil.test');
    if (kind === 'review') url.searchParams.set('review', '550e8400-e29b-41d4-a716-446655440099');
    if (kind === 'duplicate') url.searchParams.append('state', 'A'.repeat(43));
    if (kind === 'extra') url.searchParams.append('code', 'A'.repeat(43));
    if (kind === 'path') url.pathname = '/other';
    if (kind === 'fragment') url.hash = 'token';
    const count = f.calls.length;
    await expect(f.helper().completePayment(url.href)).rejects.toMatchObject({ code: 'WALLET_PAYMENT_CALLBACK_INVALID' });
    expect(f.href()).toBe(f.callbackUri); expect(f.calls).toHaveLength(count);
  });

  it.each(['amount', 'beneficiary', 'minimumReturnedTokens', 'terminal', 'fees', 'calls', 'account', 'chain'])('rejects locally mismatched %s before recording a review', async kind => {
    const f = fixture(), input = structuredClone(f.input());
    if (kind === 'amount') input.expectedPayment.amount = '2';
    if (kind === 'beneficiary') input.expectedPayment.beneficiary = '0x' + '12'.repeat(20) as `0x${string}`;
    if (kind === 'minimumReturnedTokens') input.expectedPayment.minimumReturnedTokens = '6';
    if (kind === 'terminal') input.expectedPayment.terminal = '0x' + '12'.repeat(20) as `0x${string}`;
    if (kind === 'fees') input.expectedPayment.maximumNetworkFee = '1';
    if (kind === 'calls') input.operation.operation.callData = '0x';
    if (kind === 'account') input.operation.operation.sender = '0x' + '12'.repeat(20) as `0x${string}`;
    if (kind === 'chain') input.operation.chainId = 1;
    await expect(f.helper().preparePayment(input)).rejects.toMatchObject({ code: 'WALLET_PAYMENT_MISMATCH' });
    expect(f.calls).toHaveLength(0); expect(f.data.size).toBe(0);
  });

  it.each(['operation', 'fees', 'state', 'grant', 'account', 'signing', 'payment', 'commitment'])('rejects a substituted review %s and retains the original journal', async kind => {
    const f = fixture(); await f.helper().preparePayment(f.input()); f.changeView(view => {
      if (kind === 'operation') view.operationId = 'different-operation';
      if (kind === 'fees') view.operation = { ...view.operation, maxFeePerGas: '0x65' };
      if (kind === 'state') view.state = 'A'.repeat(43);
      if (kind === 'grant') view.app = { ...view.app, grantIncarnation: '2' };
      if (kind === 'account') view.accountId = 'eip155:8453:0x' + '12'.repeat(20);
      if (kind === 'signing') view.signing = { ...view.signing, digest: '0x' + '12'.repeat(32) };
      if (kind === 'payment') view.payment = { ...view.payment, amount: '2' };
      if (kind === 'commitment') view.approval.signedCommitment = '0x' + '12'.repeat(32);
      return view;
    });
    await expect(f.helper().completePayment(f.callback())).rejects.toMatchObject({ code: 'WALLET_PAYMENT_MISMATCH' });
    expect(f.helper().pendingPayment()!.operationId).toBe(f.prepared.id);
    expect(f.calls.some(call => call.path.endsWith('/submissions'))).toBe(false);
  });

  it.each(['renew', 'disconnect'])('never rehomes a pending approved payment after %s', async kind => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    if (kind === 'renew') f.replaceGrant(); else f.disconnect(); const count = f.calls.length;
    await expect(f.helper().submitPayment()).rejects.toMatchObject({ code: 'WALLET_PAYMENT_CONNECTION_CHANGED' });
    expect(f.calls).toHaveLength(count); expect(f.helper().pendingPayment()!.operationId).toBe(f.prepared.id);
    expect(() => f.helper().clearPayment()).toThrow();
  });

  it('blocks submission when its durable local send marker cannot be saved', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    f.storage.setItem = () => { throw new Error('quota'); }; const count = f.calls.length;
    await expect(f.helper().submitPayment()).rejects.toMatchObject({ code: 'WALLET_PAYMENT_STORAGE_UNAVAILABLE' });
    expect(f.calls).toHaveLength(count);
  });

  it('keeps a missing or expired review unresolved without making a new payment', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); f.expireReview();
    expect((await f.helper().refreshPayment()).status).toBe('unknown');
    expect(() => f.helper().clearPayment()).toThrow();
    expect(f.calls.filter(call => call.path === '/api/v1/wallet/payment-reviews')).toHaveLength(1);
  });

  it('pins a shorter review lifetime without changing the original SafeOp validity window', async () => {
    const f = fixture(), expiry = f.nowMs + 30_000;
    f.changeView(value => ({ ...value, expiresAtMs: expiry }));
    expect((await f.helper().preparePayment(f.input())).expiresAtMs).toBe(expiry);
    expect((await f.helper().completePayment(f.callback())).status).toBe('approved');
    f.changeView(value => ({ ...value, expiresAtMs: expiry + 1000 }));
    await expect(f.helper().refreshPayment()).rejects.toMatchObject({ code: 'WALLET_PAYMENT_MISMATCH' });
  });

  it('does not archive an unsubmitted payment just because its shorter review expired', async () => {
    const f = fixture(); f.changeView(value => ({ ...value, expiresAtMs: f.nowMs + 30_000 }));
    await f.helper().preparePayment(f.input()); f.advance(31_000); f.expireReview();
    expect((await f.helper().refreshPayment()).status).toBe('unknown');
    expect(() => f.helper().clearPayment()).toThrow();
    expect(f.helper().pendingPayment()!.operationId).toBe(f.prepared.id);
  });

  it.each(['review-known', 'review-response-lost'] as const)('explicitly archives unknown original references after an unsigned local payment window elapsed: %s', async kind => {
    const f = fixture();
    if (kind === 'review-response-lost') f.loseReview();
    await f.helper().preparePayment(f.input()).catch(() => undefined);
    const [key, raw] = [...f.data.entries()][0]!, saved = JSON.parse(raw);
    f.advance(121_000); f.disconnect(); const calls = f.calls.length;
    f.helper().clearPayment();
    expect(f.helper().pendingPayment()).toBeNull(); expect(f.calls).toHaveLength(calls);
    expect(JSON.parse(f.data.get(key + ':history')!)).toEqual([expect.objectContaining({
      status: 'unknown', archiveReason: 'no-local-submission-recorded', accountId: f.accountId,
      planId: f.plan.id, planCommitment: f.plan.commitment, operationId: f.prepared.id,
      operationCommitment: f.prepared.commitment, operationHash: f.prepared.operationHash,
      reviewId: kind === 'review-known' ? reviewId : null, reviewState: saved.state,
      grantId: f.grant.id, grantIncarnation: f.grant.incarnation,
      submissionKey: saved.submissionKey, reviewKey: saved.reviewKey,
      validUntil: String(Math.floor(f.prepared.expiresAt / 1000)),
    })]);
  });

  it.each(['approved', 'may-have-sent'] as const)('preserves an expired %s payment instead of archiving it as locally unsubmitted', async kind => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    if (kind === 'may-have-sent') { f.loseSubmission(); await expect(f.helper().submitPayment()).rejects.toThrow(); }
    f.advance(121_000); const saved = [...f.data.entries()];
    expect(() => f.helper().clearPayment()).toThrow(); expect([...f.data.entries()]).toEqual(saved);
  });

  it('refuses to archive a saved unbounded SafeOp even after its record expiry', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input());
    const [key, encoded] = [...f.data.entries()][0]!, { integrity: _, ...record } = JSON.parse(encoded);
    record.operation.signing.validUntil = '0';
    f.data.set(key, JSON.stringify({ ...record, integrity: sha256(stringToHex(uoCanonical(record))) }));
    f.advance(121_000); const saved = [...f.data.entries()];
    expect(() => f.helper().clearPayment()).toThrow(); expect([...f.data.entries()]).toEqual(saved);
  });

  it('drops the oldest receipts when the archive is full instead of keeping a settled payment open', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); f.advance(121_000); f.disconnect();
    const [key] = [...f.data.entries()][0]!;
    f.data.set(key + ':history', JSON.stringify(Array.from({ length: 64 }, (_, i) => ({ operationId: `old-${i}`, padding: 'x'.repeat(16_000) }))));
    f.helper().clearPayment();
    const history = JSON.parse(f.data.get(key + ':history')!);
    expect(history).toHaveLength(64); expect(history[0].operationId).toBe('old-1'); expect(history.at(-1).operationId).toBe(f.prepared.id);
    expect(new TextEncoder().encode(JSON.stringify(history)).length).toBeLessThanOrEqual(1_048_576);
  });
  it('keeps an expired unsigned active payment when its unknown history cannot be saved', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); f.advance(121_000);
    f.storage.setItem = () => { throw new Error('quota'); };
    expect(() => f.helper().clearPayment()).toThrow();
    expect(f.helper().pendingPayment()!.operationId).toBe(f.prepared.id);
  });

  it('does not remove an active journal that changes during archive persistence', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); f.advance(121_000);
    const [key, raw] = [...f.data.entries()][0]!, { integrity: _, ...record } = JSON.parse(raw);
    record.status = 'unknown'; const changed = JSON.stringify({ ...record, integrity: sha256(stringToHex(uoCanonical(record))) });
    const setItem = f.storage.setItem;
    f.storage.setItem = (name, value) => { setItem(name, value); if (name.endsWith(':history')) f.data.set(key, changed); };
    expect(() => f.helper().clearPayment()).toThrow(); expect(f.data.get(key)).toBe(changed);
  });

  it.each(['success', 'failure'] as const)('cannot recreate or send an expired archived payment when a held approval reply ends with %s', async outcome => {
    const f = fixture(); await f.helper().preparePayment(f.input());
    const held = f.holdNextReview(), old = f.helper().completePayment(f.callback()).then(value => value, error => error);
    await held.started; f.advance(121_000); f.helper().clearPayment();
    const saved = [...f.data.entries()]; held.release(outcome);
    expect(await old).toBeInstanceOf(Error); expect([...f.data.entries()]).toEqual(saved);
    expect(f.helper().pendingPayment()).toBeNull();
    expect(f.calls.some(call => call.path.endsWith('/submissions'))).toBe(false);
    expect(f.calls.filter(call => call.path === '/api/v1/wallet/payment-reviews')).toHaveLength(1);
  });

  it('does not reuse a pending review when the app changes its expected payment', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); const changed = f.input();
    changed.expectedPayment = { ...changed.expectedPayment, amount: '2' };
    await expect(f.helper().preparePayment(changed)).rejects.toMatchObject({ code: 'WALLET_PAYMENT_MISMATCH' });
    expect(f.calls).toHaveLength(1);
  });

  it('does not accept paid evidence without the matching original submission commitment', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); await f.helper().submitPayment();
    const record = f.observedOperation(); delete record.submission; f.observed(record);
    expect((await f.helper().refreshPayment()).status).toBe('unknown');
    expect(() => f.helper().clearPayment()).toThrow();
  });

  it('keeps canonical inner failure distinct from a successful outer transaction', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); await f.helper().submitPayment();
    const payFailure = { reason: 'TERMINAL_UNDER_MIN', received: '812', minimum: '900', message: 'This payment would get fewer tokens than your minimum, so lower your minimum or try again.' };
    const reverted = f.observedOperation('reverted');
    f.observed({ ...reverted, observation: { ...reverted.observation, payFailure } });
    const status = await f.helper().refreshPayment();
    // The status carries the SDK's reading; the observation keeps what Signa served.
    expect(status).toMatchObject({ status: 'reverted', payFailure: { ...payFailure, received: 812n, minimum: 900n, zeroFill: false, adjustable: 'minimum' }, observation: { payFailure } });
    f.helper().clearPayment(); expect(f.helper().pendingPayment()).toBeNull();
  });

  it('hands the app a refused submission\'s payment reason, in its exact shape only', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    const payFailure = { reason: 'TERMINAL_UNDER_MIN', received: '812', minimum: '900', message: 'This payment would get fewer tokens than your minimum, so lower your minimum or try again.' };
    f.refuseSubmission({ code: 'USER_OPERATION_PROVIDER_REJECTED', detail: 'Refused.', payFailure });
    await expect(f.helper().submitPayment()).rejects.toMatchObject({ code: 'USER_OPERATION_PROVIDER_REJECTED', payFailure: { ...payFailure, received: 812n, minimum: 900n, zeroFill: false, adjustable: 'minimum' } });
    f.refuseSubmission({ code: 'USER_OPERATION_PROVIDER_REJECTED', payFailure: { ...payFailure, message: 'https://node.example/key' } });
    const g = fixture(); await g.helper().preparePayment(g.input()); await g.helper().completePayment(g.callback());
    g.refuseSubmission({ code: 'USER_OPERATION_PROVIDER_REJECTED', payFailure: { ...payFailure, message: 'https://node.example/key' } });
    const error = await g.helper().submitPayment().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'USER_OPERATION_PROVIDER_REJECTED' });
    expect((error as { payFailure?: unknown }).payFailure).toBeUndefined();
  });

  it('retires a refused payment at once, so the payer reviews a fresh one right away', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    const payFailure = { reason: 'TERMINAL_UNDER_MIN', received: '812', minimum: '900', message: 'This payment would get fewer tokens than your minimum, so lower your minimum or try again.' };
    f.refuseSubmission({ code: 'USER_OPERATION_PROVIDER_REJECTED', payFailure });
    await expect(f.helper().submitPayment()).rejects.toMatchObject({ code: 'USER_OPERATION_PROVIDER_REJECTED', payFailure: { ...payFailure, received: 812n, minimum: 900n, zeroFill: false, adjustable: 'minimum' } });
    // No clock moved: Signa retired the approval under its claim lock, so nothing can send it any more.
    expect(f.calls.at(-1)!.path).toBe('/api/v1/user-operations/' + f.prepared.id + '/retirement');
    expect(f.helper().pendingPayment()!.status).toBe('refused');
    await expect(f.helper().submitPayment()).rejects.toMatchObject({ code: 'WALLET_PAYMENT_NOT_APPROVED' });
    f.helper().clearPayment(); expect(f.helper().pendingPayment()).toBeNull();
    const history = JSON.parse(f.data.get([...f.data.keys()].find(key => key.endsWith(':history'))!)!);
    expect(history.at(-1)).toMatchObject({ status: 'refused', operationId: f.prepared.id });
    expect((await f.helper().preparePayment(f.input())).status).toBe('reviewing');
  });

  it('follows the submission a claim made before the refusal reached the app, instead of retiring it', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    // Another replica claimed and sent the approval while this request was refused.
    f.observed(f.observedOperation('pending'));
    f.refuseSubmission({ code: 'USER_OPERATION_PROVIDER_REJECTED' });
    await expect(f.helper().submitPayment()).rejects.toMatchObject({ code: 'USER_OPERATION_PROVIDER_REJECTED' });
    expect(f.helper().pendingPayment()!.status).toBe('pending');
    expect(() => f.helper().clearPayment()).toThrow(expect.objectContaining({ code: 'WALLET_PAYMENT_UNRESOLVED' }));
  });

  it('keeps a refusal whose retirement answer was lost unknown, until the payer retires it again', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    f.refuseSubmission({ code: 'USER_OPERATION_PROVIDER_REJECTED' }); f.loseRetirement();
    await expect(f.helper().submitPayment()).rejects.toMatchObject({ code: 'USER_OPERATION_PROVIDER_REJECTED' });
    expect(f.helper().pendingPayment()!.status).toBe('unknown');
    expect(() => f.helper().clearPayment()).toThrow(expect.objectContaining({ code: 'WALLET_PAYMENT_UNRESOLVED' }));
    expect((await f.helper().retirePayment()).status).toBe('refused');
    f.helper().clearPayment(); expect(f.helper().pendingPayment()).toBeNull();
  });

  it('keeps a lost answer unknown, and retires it only when asked', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); f.loseSubmission();
    await expect(f.helper().submitPayment()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(f.calls.some(call => call.path.endsWith('/retirement'))).toBe(false);
    expect(f.helper().pendingPayment()!.status).toBe('unknown');
    f.observed({ ...structuredClone(f.prepared), state: 'prepared' });
    expect((await f.helper().refreshPayment()).status).toBe('unknown');
    expect((await f.helper().retirePayment()).status).toBe('refused');
    f.helper().clearPayment(); expect(f.helper().pendingPayment()).toBeNull();
    await expect(f.helper().retirePayment()).rejects.toMatchObject({ code: 'WALLET_PAYMENT_MISSING' });
  });

  it('reads an approval whose own send Signa refused and retired as refused', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    f.observed({ ...structuredClone(f.prepared), state: 'retired', revision: 1 });
    expect((await f.helper().refreshPayment()).status).toBe('refused');
    f.helper().clearPayment(); expect(f.helper().pendingPayment()).toBeNull();
  });

  it('shows a payment reason only while the payment stands reverted', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); await f.helper().submitPayment();
    const payFailure = { reason: 'TERMINAL_UNDER_MIN', received: '812', minimum: '900', message: 'This payment would get fewer tokens than your minimum, so lower your minimum or try again.' };
    const confirming = f.observedOperation('confirming');
    f.observed({ ...confirming, observation: { ...confirming.observation, payFailure } });
    const status = await f.helper().refreshPayment();
    expect(status.status).toBe('confirming');
    expect(status).not.toHaveProperty('payFailure');
    expect(status.observation).not.toHaveProperty('payFailure');
  });

  it('drops a served payment reason outside its exact shape, on the status and inside the observation', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); await f.helper().submitPayment();
    const reverted = f.observedOperation('reverted');
    f.observed({ ...reverted, observation: { ...reverted.observation,
      payFailure: { reason: 'TERMINAL_UNDER_MIN', message: 'See https://node.example/key', received: '812', minimum: '900' } } });
    const status = await f.helper().refreshPayment();
    expect(status.status).toBe('reverted');
    expect(status).not.toHaveProperty('payFailure');
    expect(status.observation).toBeDefined();
    expect(status.observation).not.toHaveProperty('payFailure');
  });

  it('waits on the operation past the revision it last saw, once it has seen one', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    const helper = f.helper(); await helper.submitPayment();
    // Each read waits past the revision of the last operation view it received; a fresh client
    // that has seen none reads at once.
    await helper.refreshPayment({ waitSeconds: 20 });
    f.observed(f.observedOperation()); await helper.refreshPayment({ waitSeconds: 20 }); await helper.refreshPayment({ waitSeconds: 5 });
    await f.helper().refreshPayment({ waitSeconds: 20 });
    const reads = f.calls.filter(call => call.path === '/api/v1/user-operations/' + f.prepared.id).map(call => call.search);
    expect(reads).toEqual(['?wait=20&since=0', '?wait=20&since=0', '?wait=5&since=2', '']);

    await expect(helper.refreshPayment({ waitSeconds: 21 })).rejects.toThrow();
  });

  it('archives a submitted payment whose app grant is gone, since nothing can resolve it here any more', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback());
    await f.helper().submitPayment();
    f.disconnect();
    await expect(f.helper().refreshPayment()).rejects.toMatchObject({ code: 'WALLET_PAYMENT_CONNECTION_CHANGED' });
    // While the signed operation could still execute, the record is kept.
    expect(() => f.helper().clearPayment()).toThrow();
    f.advance(600_000);
    f.helper().clearPayment();
    expect(f.helper().pendingPayment()).toBeNull();
    const history = JSON.parse(f.data.get([...f.data.keys()].find(key => key.endsWith(':history'))!)!);
    expect(history.at(-1)).toMatchObject({ status: 'unknown', archiveReason: 'grant-expired', operationId: f.prepared.id });
  });

  it('treats an operation the chain never included, past its validity, as final so the app can offer a fresh payment', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); await f.helper().submitPayment();
    f.observed(f.observedOperation('expired'));
    expect((await f.helper().refreshPayment()).status).toBe('expired');
    f.helper().clearPayment(); expect(f.helper().pendingPayment()).toBeNull();
    // Execution evidence next to an expired verdict is a contradiction, never a settled payment.
    const g = fixture(); await g.helper().preparePayment(g.input()); await g.helper().completePayment(g.callback()); await g.helper().submitPayment();
    const record = g.observedOperation('expired'); record.observation!.transactionHash = g.transactionHash; g.observed(record);
    expect((await g.helper().refreshPayment()).status).toBe('unknown');
  });
  it.each(['receipt', 'canonical', 'hash', 'effects'])('retains uncertainty when confirmed evidence is missing %s', async kind => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); await f.helper().submitPayment();
    const record = f.observedOperation();
    if (kind === 'receipt') delete record.observation!.receipt;
    if (kind === 'canonical') record.observation!.receipt!.canonical = false;
    if (kind === 'hash') record.observation!.receipt!.transactionHash = '0x' + '12'.repeat(32) as `0x${string}`;
    if (kind === 'effects') record.observation!.semantic!.status = 'failed';
    f.observed(record); expect((await f.helper().refreshPayment()).status).toBe('unknown');
    expect(() => f.helper().clearPayment()).toThrow();
  });

  it('preserves terminal recovery when archiving fails before clearing the active payment', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); await f.helper().submitPayment();
    f.observed(f.observedOperation()); await f.helper().refreshPayment();
    f.storage.setItem = () => { throw new Error('quota'); };
    expect(() => f.helper().clearPayment()).toThrow();
    expect(f.helper().pendingPayment()!.status).toBe('paid');
  });

  it('retries clearing the last archive slot after a transient pending-record removal failure', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); f.cancel(); await f.helper().refreshPayment();
    const key = [...f.data.keys()][0]!, historyKey = key + ':history';
    f.data.set(historyKey, JSON.stringify(Array.from({ length: 63 }, (_, index) => ({ operationId: 'previous-' + index }))));
    const remove = f.storage.removeItem;
    f.storage.removeItem = () => { throw new Error('Transient storage failure'); };
    expect(() => f.helper().clearPayment()).toThrow();
    expect(JSON.parse(f.data.get(historyKey)!)).toHaveLength(64);
    expect(f.helper().pendingPayment()?.operationId).toBe(f.prepared.id);
    f.storage.removeItem = remove;
    f.helper().clearPayment();
    expect(f.helper().pendingPayment()).toBeNull();
    expect(JSON.parse(f.data.get(historyKey)!)).toHaveLength(64);
    expect(JSON.parse(f.data.get(historyKey)!).filter((item: { operationId: string }) => item.operationId === f.prepared.id)).toHaveLength(1);
  });

  it('requires canonical verified economic effects before paid and archives terminal evidence before clearing', async () => {
    const f = fixture(); await f.helper().preparePayment(f.input()); await f.helper().completePayment(f.callback()); await f.helper().submitPayment();
    const confirmed = f.observedOperation();
    f.observed({ ...confirmed, observation: { ...confirmed.observation, semantic: { status: 'unknown' } } });
    expect((await f.helper().refreshPayment()).status).toBe('unknown');
    expect(() => f.helper().clearPayment()).toThrow();
    f.observed(confirmed);
    const paid = await f.helper().refreshPayment(); expect(paid.status).toBe('paid');
    expect(paid.transactionHash).toBe(confirmed.observation!.transactionHash);
    expect(paid.transactionHash).not.toBe(f.prepared.operationHash);
    f.helper().clearPayment(); expect(f.helper().pendingPayment()).toBeNull();
    expect([...f.data.values()].some(value => value.includes(confirmed.observation!.transactionHash!))).toBe(true);
  });

  it('bundles payment continuity without server stores, credentials or Node builtins', async () => {
    const built = buildSync({ entryPoints: [new URL('../src/rest/client/walletPayments.ts', import.meta.url).pathname], bundle: true,
      platform: 'browser', format: 'iife', globalName: 'Payments', write: false, metafile: true, logLevel: 'silent' });
    expect(Object.keys(built.metafile!.inputs).some(path => /wallet\/(paymentReviews|paymentReviewsPostgres|paymentPublic|webauthn)\.ts$/.test(path))).toBe(false);
    const api = runInNewContext(built.outputFiles![0]!.text + '\nPayments;', { crypto: webcrypto, atob, btoa, TextEncoder, TextDecoder,
      Uint8Array, URL, URLSearchParams, Headers, Response, Request, AbortController, setTimeout, clearTimeout, structuredClone });
    const f = fixture(), helper = api.createCenterWalletPaymentClient(f.options);
    expect((await helper.preparePayment(f.input())).reviewId).toBe(reviewId);
  });
});

describe('Signa reviews of any call set and signature', () => {
  it('prepareReview sends raw calls and never a model', async () => {
    const f = createWalletReviewsFixture(), reviews = f.reviews();
    const prepared = await reviews.prepareReview({ chainId: 8453, calls: f.sent });
    expect(prepared).toMatchObject({ status: 'reviewing', reviewId, approvalUrl: f.issuer + '/wallet/payment?review=' + reviewId, operationId: f.prepared.id });
    expect(prepared.expectedCalls).toEqual({ chainId: 8453, calls: f.sent.map(call => ({ ...call, value: call.value.toString() })) });
    expect(f.calls.map(call => call.method + ' ' + call.path)).toEqual(['GET /api/v1/smart-accounts/bindings', 'POST /api/v1/wallet/reviewed-calls',
      'POST /api/v1/user-operations', 'POST /api/v1/wallet/payment-reviews']);
    // Exactly the bytes, values and targets: no model, label or description crosses to Signa.
    expect(f.calls[1]!.body).toEqual({ bindingId: f.bindingId, chainId: 8453, account: f.safe, calls: f.sent.map(call => ({ ...call, value: call.value.toString() })) });
    expect(f.calls[2]!.body).toEqual({ planId: f.plan.id, stepIndexes: [0, 1] });
    expect(f.calls[3]!.body).toEqual({ operationId: f.prepared.id, state: expect.any(String) });
    // The same call set resumes the saved review; another one waits for it.
    expect((await f.reviews().prepareReview({ chainId: 8453, calls: f.sent })).reviewId).toBe(reviewId);
    expect(f.calls).toHaveLength(4);
    await expect(reviews.prepareReview({ chainId: 8453, calls: f.sent.slice(0, 1) })).rejects.toMatchObject({ code: 'WALLET_PAYMENT_PENDING' });
    // Approved, submitted and followed like a payment, under its own record.
    expect((await reviews.completeReview(f.callback())).status).toBe('approved');
    expect((await reviews.submitReview()).status).toBe('pending');
    f.observed(f.observedOperation('confirmed'));
    const done = await reviews.refreshReview();
    expect(done.observation!.receipt!.transactionHash).toBe(f.transactionHash);
    expect(createCenterWalletPaymentClient(f.options).pendingPayment()).toBeNull();
  });

  it('refuses a served review whose calls differ from the raw calls sent', async () => {
    const f = createWalletReviewsFixture(), changed = { ...f.sent[1]!, value: 1n };
    await expect(f.reviews().prepareReview({ chainId: 8453, calls: [f.sent[0]!, changed] })).rejects.toMatchObject({ code: 'WALLET_PAYMENT_MISMATCH' });
    expect(f.calls.some(call => call.path === '/api/v1/wallet/payment-reviews')).toBe(false);
  });

  it('a closed signature page is read back before it is called unsigned', async () => {
    const f = createWalletReviewsFixture(), reviews = f.reviews(); f.signatures();
    const wallet = { restoreConnection: () => ({ address: f.safe }), reviews: () => reviews };
    // Approved on the page, its callback lost with the close: the signature is returned.
    await expect(signaWalletAdapter(wallet, { approve: async () => { f.approve(); return null; } }).signMessage(f.signatureRequest.message))
      .resolves.toBe(f.accountSignature);
    // Still undecided when closed: nothing was signed.
    const g = createWalletReviewsFixture(), open = g.reviews(); g.signatures(); g.undecided();
    await expect(signaWalletAdapter({ restoreConnection: () => ({ address: g.safe }), reviews: () => open }, { approve: async () => null })
      .signMessage(g.signatureRequest.message)).rejects.toMatchObject({ code: 4001, message: 'The review was closed. Nothing was signed.' });
    // Signa could not be read: the outcome is unknown, never a rejection.
    const h = createWalletReviewsFixture(), lost = h.reviews(); h.signatures();
    const error = await signaWalletAdapter({ restoreConnection: () => ({ address: h.safe }), reviews: () => ({ ...lost,
      refreshSignature: async () => { throw new Error('offline'); } }) }, { approve: async () => null })
      .signMessage(h.signatureRequest.message).then(() => undefined, (caught: { code?: unknown }) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error!.code).toBeUndefined();
  });

  it('a review closed without Cancel lets the next different call set prepare at once', async () => {
    const f = createWalletReviewsFixture(), reviews = f.reviews(); f.undecided();
    const adapter = signaWalletAdapter({ restoreConnection: () => ({ address: f.safe }), reviews: () => reviews }, { approve: async () => null });
    await expect(adapter.submitToReviewer({ account: f.safe, calls: f.sent.map(call => ({ chainId: 8453, ...call })) })).rejects.toMatchObject({ code: 4001 });
    // Read first, then withdrawn on Signa: nothing of it can be approved or sent any more.
    expect(f.cancellations()).toBe(1);
    expect(reviews.pendingReview()).toBeNull();
    const next = f.nextCalls();
    const prepared = await reviews.prepareReview({ chainId: 8453, calls: next.sent });
    expect(prepared).toMatchObject({ status: 'reviewing', expectedCalls: { calls: next.sent.map(call => ({ ...call, value: call.value.toString() })) } });
    expect(f.calls.filter(call => call.path.endsWith('/submissions'))).toHaveLength(0);
  });

  it('a close that races an approval completes the approval, not a cancel', async () => {
    const f = createWalletReviewsFixture(), reviews = f.reviews(); f.undecided(); f.observed(f.observedOperation('confirmed'));
    // Approved on the page, its callback lost with the close.
    const adapter = signaWalletAdapter({ restoreConnection: () => ({ address: f.safe }), reviews: () => reviews },
      { approve: async () => { f.approve(); return null; } });
    await expect(adapter.submitToReviewer({ account: f.safe, calls: f.sent.map(call => ({ chainId: 8453, ...call })) })).resolves.toBe(f.transactionHash);
    expect(f.cancellations()).toBe(0);
    expect(f.calls.filter(call => call.path.endsWith('/submissions'))).toHaveLength(1);
    // Approved between the read and the withdrawal: Signa refuses the cancel and the approval is read again.
    const g = createWalletReviewsFixture(), raced = g.reviews(); g.undecided(); g.approveOnCancel();
    await raced.prepareReview({ chainId: 8453, calls: g.sent });
    expect((await raced.cancelReview()).status).toBe('approved');
    expect(g.cancellations()).toBe(1);
    expect(raced.pendingReview()!.status).toBe('approved');
  });

  it('prepareSignature sends the raw request and never a model', async () => {
    const f = createWalletReviewsFixture(); f.signatures();
    const reviews = f.reviews(), prepared = await reviews.prepareSignature(f.signatureRequest);
    expect(prepared).toMatchObject({ status: 'reviewing', reviewId, approvalUrl: f.issuer + '/wallet/payment?review=' + reviewId,
      request: f.signatureRequest, requestDigest: f.signatureSigning.requestDigest });
    expect(f.calls.map(call => call.method + ' ' + call.path)).toEqual(['POST /api/v1/wallet/signature-reviews']);
    expect(f.calls[0]!.body).toEqual({ request: f.signatureRequest, state: expect.any(String) });
    const signed = await reviews.completeSignature(f.callback());
    expect(signed).toMatchObject({ status: 'approved', signature: f.accountSignature });
    expect(f.reviews().pendingSignature()).toMatchObject({ status: 'approved', signature: f.accountSignature });
  });
});
