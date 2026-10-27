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
});
