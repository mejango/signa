// Core 4.0.0's own `sendReviewed` against the published adapter and the real reviews client, with
// Signa's HTTP answers from the shared fixture: what jbm, revnet, Sticky and Homerun run for a Signa account.
import { sendReviewed, type ReviewModel, type WalletAdapter } from '@bananapus/nana-sdk-core/review';
import { describe, expect, it } from 'vitest';
import { signaWalletAdapter } from '../../wallet-client/src/core/adapter.js';
import { createWalletReviewsFixture } from '../../test/fixtures/wallet-reviews-client.js';

describe('acceptance/shared-wallet', () => {
  it('signaWalletAdapter is accepted by sendReviewed', async () => {
    const f = createWalletReviewsFixture(), reviews = f.reviews();
    f.observed(f.observedOperation('confirmed'));
    const opened: string[] = [];
    // Typed as core's own wallet: the adapter is declared structurally, with no core import.
    const adapter: WalletAdapter = signaWalletAdapter({ restoreConnection: () => ({ address: f.safe }), reviews: () => reviews },
      { approve: async url => { opened.push(url); return f.callback(); } });
    let preview: ReviewModel | undefined;
    const result = await sendReviewed({ account: f.safe, calls: f.sent.map(call => ({ chainId: 8453, ...call })) },
      { adapter, clientFor: () => { throw new Error('A self-reviewing wallet reads no chain in core.'); }, hold: {} as never, onPreview: model => { preview = model; } });
    expect(result).toEqual({ status: 'done', hashes: [f.transactionHash], receipts: [] });
    expect(result.status === 'done' && result.hashes[0]).not.toBe(f.prepared.operationHash);
    expect(opened).toEqual([f.issuer + '/wallet/payment?review=550e8400-e29b-41d4-a716-446655440000']);
    expect(preview).toBeDefined();
    // Signa got the raw calls, never core's model.
    expect(f.calls.find(call => call.path === '/api/v1/wallet/reviewed-calls')!.body.calls)
      .toEqual(f.sent.map(call => ({ ...call, value: call.value.toString() })));
    // Settled, so the next action starts fresh.
    expect(reviews.pendingReview()).toBeNull();
  });
  /** Core's sendReviewed over Signa, recording what it tells the site per call. */
  async function send(f: ReturnType<typeof createWalletReviewsFixture>, approve?: () => void) {
    const reviews = f.reviews(), told: string[] = [];
    const adapter: WalletAdapter = signaWalletAdapter({ restoreConnection: () => ({ address: f.safe }), reviews: () => reviews },
      { approve: async () => { approve?.(); return f.callback(); } });
    const error = await sendReviewed({ account: f.safe, calls: f.sent.map(call => ({ chainId: 8453, ...call })),
      onSubmitted: (_call, step) => { told.push('submitted ' + step); }, onUnsent: (_call, step) => { told.push('unsent ' + step); } },
    { adapter, clientFor: () => { throw new Error('A self-reviewing wallet reads no chain in core.'); }, hold: {} as never })
      .then(() => undefined, (caught: unknown) => caught as { code?: unknown; message?: string; transactionHash?: unknown });
    return { error, told, reviews };
  }

  it('an operation whose calls reverted onchain is never done, and never unsent', async () => {
    for (const state of ['confirming', 'reverted'] as const) {
      // The bundle's own receipt succeeded; EntryPoint reports the account's execution failed.
      const f = createWalletReviewsFixture();
      f.observed(f.observedOperation(state, 'failed'));
      const { error, told } = await send(f);
      expect(error).toMatchObject({ message: 'This ran onchain and failed, so none of it took effect.', transactionHash: f.transactionHash });
      expect(error!.code).toBeUndefined();
      expect(told).toEqual([]);
    }
  });

  it('a call set Signa proves unsent releases every call', async () => {
    const refused = createWalletReviewsFixture();
    refused.refuseSubmission();
    const first = await send(refused);
    expect(first.error).toMatchObject({ code: 4001, message: 'Signa did not send this. Nothing was charged; review it again.' });
    expect(first.told).toEqual(refused.sent.map((_, step) => 'unsent ' + step));
    expect(first.reviews.pendingReview()).toBeNull();
    const expired = createWalletReviewsFixture();
    expired.observed(expired.observedOperation('expired'));
    const second = await send(expired);
    expect(second.error).toMatchObject({ code: 4001, message: 'This expired before it was included onchain. Nothing was charged; review it again.' });
    expect(second.told).toEqual(expired.sent.map((_, step) => 'unsent ' + step));
    // An answer Signa lost proves nothing: the calls stay held.
    const lost = createWalletReviewsFixture();
    lost.observed(lost.observedOperation('pending'));
    const third = await send(lost);
    expect(third.error!.code).toBeUndefined();
    expect(third.told).toEqual([]);
  });
  it('a call set Signa refuses before any review releases every call; an unreachable Signa holds them', async () => {
    const refused = createWalletReviewsFixture();
    refused.refuse(422, 'REVIEWED_CALLS_REFUSED');
    const first = await send(refused);
    expect(first.error).toMatchObject({ code: 4001 });
    expect(first.told).toEqual(refused.sent.map((_, step) => 'unsent ' + step));
    const down = createWalletReviewsFixture();
    down.refuse(503, 'UNAVAILABLE');
    const second = await send(down);
    expect(second.error!.code).not.toBe(4001);
    expect(second.told).toEqual([]);
  });
});
