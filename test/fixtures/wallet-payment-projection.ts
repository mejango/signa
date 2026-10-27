import type { WalletPaymentReviewAppView } from '../../src/rest/wallet/paymentReviewsPostgres.js';
import { encodeFunctionData, erc20Abi } from 'viem';
import { encodeSafe7579Execution } from '../../src/rest/smartAccounts/accountExecution.js';
import { payAbi, terminal, token } from './wallet-payment-review-context.js';

const wallet = '0x0000000000000000000000000000000000000003';
/** Real Safe7579 bytes of an approve and a pay: the central projection describes the calls from them. */
export const projectionCallData = encodeSafe7579Execution([
  { target: token, value: '0', callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [terminal, 1_000_000n] }) },
  { target: terminal, value: '0', callData: encodeFunctionData({ abi: payAbi, functionName: 'pay', args: [1n, token, 1_000_000n, wallet, 5n, '', '0x'] }) }]);

// Projection-only fixture. Genuine crypto, durable reviews and exact operation verification
// are exercised in their domain/PG/EVM suites; this verifies what may cross each HTTP surface.
export function paymentProjectionFixture(): WalletPaymentReviewAppView {
  return {
    draft: { version:'center-wallet-payment-review-v1',id:'review-id',state:'app-state',issuer:'https://wallet.example.test',
      grant:{id:'grant-id',incarnation:'7',origin:'https://beep.example.test',callbackUri:'https://beep.example.test/center/callback',signerAddress:'private-request-key-metadata'},
      authority:{accountId:'eip155:8453:0x0000000000000000000000000000000000000003',credential:{rpId:'wallet.example.test',credentialId:'selected-credential',userHandle:'private-user-handle',publicKey:{x:'private-x',y:'private-y'}},authorityEpoch:'private-authority-epoch',bindingId:'private-binding-id'},
      planId:'plan-id',planCommitment:'plan-commitment',operationId:'operation-id',operationCommitment:'operation-commitment',operationHash:'operation-hash',
      stepIndexes:[0,1],operation:{sender:wallet,callData:projectionCallData},chainId:8453,entryPoint:'entry-point',safe7579:'adapter',
      review:{kind:'v6-usdc-pay',payment:{amount:'1000000',beneficiary:'recipient',projectId:'1',minimumReturnedTokens:'5',metadata:'0x'}},gas:{payer:'pimlico',chainId:8453,paymaster:'paymaster'},signing:{digest:`0x${'ab'.repeat(32)}`,signedData:'safe-op-preimage',validAfter:'10',validUntil:'20'},
      createdAtMs:10_000,expiresAtMs:20_000,ceremony:{id:'private-ceremony',challenge:'private-random-challenge'} },
    status:'approved',approvedAtMs:12_000,cancelledAtMs:null,operationState:'prepared',approvers:['selected-credential','device-credential'],approval:{signature:'0x1234',signedCommitment:'0x4321'},
  } as unknown as WalletPaymentReviewAppView;
}
