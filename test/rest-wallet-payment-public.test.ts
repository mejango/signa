import { describe, expect, it } from 'vitest';
import { publicWalletPaymentReview, publicWalletPaymentAppReview, publicWalletPaymentCentralReview as centralReview,
  type WalletPaymentCentralPublic } from '../src/rest/wallet/paymentPublic.js';
import type { WalletPaymentReviewView } from '../src/rest/wallet/paymentReviewsPostgres.js';
import { buildUserPayMetadata } from '@bananapus/nana-sdk-core/v6';
import { describeJBHookMetadata } from '@bananapus/nana-sdk-core/review/decode';
import type { Hex } from 'viem';
import { paymentProjectionFixture as fixture, projectionCallData } from './fixtures/wallet-payment-projection.js';
import { createWalletPaymentReviewContextFixture, now } from './fixtures/wallet-payment-review-context.js';
import { createWalletPaymentReviewDraft } from '../src/rest/wallet/paymentReviews.js';
import { decodeSafe7579Execution } from '../src/rest/smartAccounts/accountExecution.js';
import { buildReviewModel, decodeReviewCall } from '@bananapus/nana-sdk-core/review';
import { encodeFunctionData, erc20Abi } from 'viem';
import { basePaymentConfiguration } from '../src/rest/wallet/productionStack.js';

// A payment's central projection; the reviewed-calls kind has its own suite.
const publicWalletPaymentCentralReview=(view:WalletPaymentReviewView)=>centralReview(view) as WalletPaymentCentralPublic;
describe('wallet payment HTTP projection',()=>{
  it('returns the exact operation and payment for app comparison without private authority metadata',()=>{
    const source=fixture(), result=publicWalletPaymentReview(source) as any;
    expect(result).toMatchObject({version:'center-wallet-payment-review-v1',id:'review-id',accountId:source.draft.authority.accountId,
      app:{origin:source.draft.grant.origin,callbackUri:source.draft.grant.callbackUri,grantId:'grant-id',grantIncarnation:'7'},
      operationId:'operation-id',operationHash:'operation-hash',operation:{callData:projectionCallData},payment:{amount:'1000000'},status:'approved'});
    expect(JSON.stringify(result)).not.toContain('private-');expect(JSON.stringify(result)).not.toContain('selected-credential');
    expect(result).not.toHaveProperty('approval');expect(result).not.toHaveProperty('authority');expect(result).not.toHaveProperty('ceremony');
  });
  it('adds the winning owner envelope only to the original-app projection',()=>{
    const source=fixture(); expect(publicWalletPaymentAppReview(source)).toMatchObject({approval:{signature:'0x1234',signedCommitment:'0x4321'}});
    expect(publicWalletPaymentCentralReview(source)).not.toHaveProperty('approval');
    expect(publicWalletPaymentAppReview({...source,approval:null})).toMatchObject({approval:null});
  });
  it('gives the central browser the account passkeys that may approve and the exact SafeOp challenge',()=>{
    const result=publicWalletPaymentCentralReview(fixture()) as any;
    expect(result.passkey).toEqual({rpId:'wallet.example.test',credentialId:'selected-credential',credentialIds:['selected-credential','device-credential'],
      challenge:Buffer.from('ab'.repeat(32),'hex').toString('base64url'),userVerification:'required'});
    expect(JSON.stringify(result)).not.toContain('private-');expect(result).not.toHaveProperty('authority');
  });
  it('describes the metadata with the SDK review decoder for the central page only',()=>{
    const source=fixture();expect(publicWalletPaymentCentralReview(source).metadataSteps).toEqual([]);
    expect(publicWalletPaymentAppReview(source)).not.toHaveProperty('metadataSteps');
    const metadata=buildUserPayMetadata({chainId:8453,minimumSwapAmountOut:5n,tiers:{metadataIdTarget:'0x'+'11'.repeat(20) as Hex,tierIdsToMint:[2n]}});
    ((source.draft.review as any).payment as any).metadata=metadata;
    expect(publicWalletPaymentCentralReview(source).metadataSteps).toEqual(describeJBHookMetadata('pay',metadata));
    expect(publicWalletPaymentCentralReview(source).metadataSteps.map(step=>step.title)).toEqual(['Buyback hook swap instructions','721 shop mint instructions']);
    ((source.draft.review as any).payment as any).metadata='0x1234';expect(()=>publicWalletPaymentCentralReview(source)).toThrow();
  });
  it('shows the quote notice on the central review only, where the payer approves',()=>{
    const source=fixture(); expect(publicWalletPaymentCentralReview(source).notice).toBeNull();
    (source.draft as any).notice='Notice.'; expect(publicWalletPaymentCentralReview(source).notice).toBe('Notice.');
    expect(publicWalletPaymentReview(source)).not.toHaveProperty('notice');expect(publicWalletPaymentAppReview(source)).not.toHaveProperty('notice');
  });
  it('does not expose mutable internal draft objects through the projection',()=>{
    const source=fixture(), result=publicWalletPaymentAppReview(source) as any;
    result.operation.callData='changed';result.payment.amount='2';result.stepIndexes.push(9);result.signing.digest='changed';result.approval.signature='changed';
    expect(source.draft.operation.callData).toBe(projectionCallData);expect((source.draft.review as any).payment.amount).toBe('1000000');
    expect(source.draft.stepIndexes).toEqual([0,1]);expect(source.draft.signing.digest).not.toBe('changed');expect(source.approval!.signature).toBe('0x1234');
  });
  it("the public review's model is built from the operation bytes",async()=>{
    const {base}=await createWalletPaymentReviewContextFixture();
    const draft=createWalletPaymentReviewDraft(base,{id:'11111111-1111-4111-8111-111111111111',state:Buffer.alloc(32,1).toString('base64url'),createdAtMs:now});
    const view={draft,status:'pending' as const,approvedAtMs:null,cancelledAtMs:null,operationState:'prepared' as const,approvers:['a']};
    const shown=publicWalletPaymentCentralReview(view).reviewedCalls;
    expect(shown.model.calls.map(call=>[call.to.toLowerCase(),call.functionName,call.data])).toEqual(
      decodeSafe7579Execution(draft.operation.callData).map((call,index)=>[call.target.toLowerCase(),['approve','pay'][index],call.callData.toLowerCase()]));
    expect(shown.functions.map(item=>item?.name)).toEqual(['approve','pay']);
    expect(shown.model.calls[0]!.roles).toEqual([{role:'spender',address:expect.stringMatching(/^0x4444/i),name:null}]);
    // A stored payment summary that says something else changes nothing shown: the rows come from the bytes signed.
    const tampered=structuredClone(draft) as any;
    Object.assign(tampered.review.payment,{amount:'2',projectId:'8',beneficiary:'0x1111111111111111111111111111111111111111',memo:'other'});
    expect(publicWalletPaymentCentralReview({...view,draft:tampered}).reviewedCalls).toEqual(shown);
    expect(publicWalletPaymentAppReview({...view,approval:null})).not.toHaveProperty('reviewedCalls');
  });
  it("knows Base USDC's decimals and symbol as the SDK does, which the approval page shows without a read",()=>{
    const {token,directV6Terminal}=basePaymentConfiguration();
    const call=decodeReviewCall({chainId:8453,to:token,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[directV6Terminal,1n]}),value:0n});
    expect(buildReviewModel({kind:'transaction',title:'t',calls:[call]}).calls[0]!.tokenAmounts).toEqual([{token:expect.any(String),amount:1n,decimals:6,symbol:'USDC'}]);
  });
});
