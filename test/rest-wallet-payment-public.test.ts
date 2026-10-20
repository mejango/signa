import { describe, expect, it } from 'vitest';
import { publicWalletPaymentReview, publicWalletPaymentAppReview, publicWalletPaymentCentralReview } from '../src/rest/wallet/paymentPublic.js';
import { buildUserPayMetadata } from '@bananapus/nana-sdk-core/v6';
import { describeJBHookMetadata } from '@bananapus/nana-sdk-core/review/decode';
import type { Hex } from 'viem';
import { paymentProjectionFixture as fixture } from './fixtures/wallet-payment-projection.js';

describe('wallet payment HTTP projection',()=>{
  it('returns the exact operation and payment for app comparison without private authority metadata',()=>{
    const source=fixture(), result=publicWalletPaymentReview(source) as any;
    expect(result).toMatchObject({version:'center-wallet-payment-review-v1',id:'review-id',accountId:source.draft.authority.accountId,
      app:{origin:source.draft.grant.origin,callbackUri:source.draft.grant.callbackUri,grantId:'grant-id',grantIncarnation:'7'},
      operationId:'operation-id',operationHash:'operation-hash',operation:{callData:'exact-call-data'},payment:{amount:'1000000'},status:'approved'});
    expect(JSON.stringify(result)).not.toContain('private-');expect(JSON.stringify(result)).not.toContain('selected-credential');
    expect(result).not.toHaveProperty('approval');expect(result).not.toHaveProperty('authority');expect(result).not.toHaveProperty('ceremony');
  });
  it('adds the winning owner envelope only to the original-app projection',()=>{
    const source=fixture(); expect(publicWalletPaymentAppReview(source)).toMatchObject({approval:{signature:'0x1234',signedCommitment:'0x4321'}});
    expect(publicWalletPaymentCentralReview(source)).not.toHaveProperty('approval');
    expect(publicWalletPaymentAppReview({...source,approval:null})).toMatchObject({approval:null});
  });
  it('gives the central browser only the selected credential and exact SafeOp challenge',()=>{
    const result=publicWalletPaymentCentralReview(fixture()) as any;
    expect(result.passkey).toEqual({rpId:'wallet.example.test',credentialId:'selected-credential',
      challenge:Buffer.from('ab'.repeat(32),'hex').toString('base64url'),userVerification:'required'});
    expect(JSON.stringify(result)).not.toContain('private-');expect(result).not.toHaveProperty('authority');
  });
  it('describes the metadata with the SDK review decoder for the central page only',()=>{
    const source=fixture();expect(publicWalletPaymentCentralReview(source).metadataSteps).toEqual([]);
    expect(publicWalletPaymentAppReview(source)).not.toHaveProperty('metadataSteps');
    const metadata=buildUserPayMetadata({chainId:8453,minimumSwapAmountOut:5n,tiers:{metadataIdTarget:'0x'+'11'.repeat(20) as Hex,tierIdsToMint:[2n]}});
    (source.draft.payment as any).metadata=metadata;
    expect(publicWalletPaymentCentralReview(source).metadataSteps).toEqual(describeJBHookMetadata('pay',metadata));
    expect(publicWalletPaymentCentralReview(source).metadataSteps.map(step=>step.title)).toEqual(['Buyback hook swap instructions','721 shop mint instructions']);
    (source.draft.payment as any).metadata='0x1234';expect(()=>publicWalletPaymentCentralReview(source)).toThrow();
  });
  it('does not expose mutable internal draft objects through the projection',()=>{
    const source=fixture(), result=publicWalletPaymentAppReview(source) as any;
    result.operation.callData='changed';result.payment.amount='2';result.stepIndexes.push(9);result.signing.digest='changed';result.approval.signature='changed';
    expect(source.draft.operation.callData).toBe('exact-call-data');expect(source.draft.payment.amount).toBe('1000000');
    expect(source.draft.stepIndexes).toEqual([0,1]);expect(source.draft.signing.digest).not.toBe('changed');expect(source.approval!.signature).toBe('0x1234');
  });
});
