import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, getAddress, hashMessage, hashTypedData, maxUint160, zeroAddress, type Address, type Hex } from 'viem';
import { getJBContractAddress, jbMultiTerminalAbi } from '@bananapus/nana-sdk-core';
import { decodeSafe7579MessageSignature, safe7579MessageSigningPayload } from '../src/rest/smartAccounts/passkeySignatures.js';
import type { EtherscanAbiSource } from '../src/rest/userOperations/reviewedCalls.js';
import { recognizeReviewedSignature, reviewedSignatureView, reviewSignature, type ReviewedSignatureReview,
  type SignatureChain } from '../src/rest/userOperations/reviewedSignatures.js';
import { signatureRequestOf, type SignatureRequest } from '../src/rest/userOperations/reviewedSignatureRules.js';
import { createWalletSignatureReviewDraft, validateWalletAnyReviewDraft, validateWalletSignatureReviewDraft, verifyWalletPaymentReviewProof,
  type WalletPaymentReviewContext } from '../src/rest/wallet/paymentReviews.js';
import { publicWalletPaymentAppReview, publicWalletPaymentCentralReview, type WalletSignatureCentralPublic } from '../src/rest/wallet/paymentPublic.js';
import { createWalletPaymentReviewContextFixture, issuer, now, rpId } from './fixtures/wallet-payment-review-context.js';
import { signGet } from './fixtures/wallet-enrollment-crypto.js';

const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;
const token = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const spender = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad' as Address;
const otherSafe = '0x9999999999999999999999999999999999999999' as Address;
const terminal = getJBContractAddress('JBMultiTerminal', 6, 8453) as Address;
const forwarder = '0xc29d6995ab3b0df4650ad643adeac55e7acbb566' as Address;

let base: WalletPaymentReviewContext, credential: Awaited<ReturnType<typeof createWalletPaymentReviewContextFixture>>['credential'];
let account: Address;
beforeAll(async () => { ({ base, credential } = await createWalletPaymentReviewContextFixture()); account = base.plan.draft.account; });

const consistent: SignatureChain = { deployed: async () => true, owners: async () => 'consistent' };
const noLookups: EtherscanAbiSource = { abiFor: vi.fn(async () => { throw new Error('No lookup expected'); }) };
const typed = (typedData: unknown, chainId = 8453) => signatureRequestOf({ kind: 'typed-data', chainId, typedData });
const permitSingle = (amount: bigint | string = 1_000_000n) => typed({
  domain: { name: 'Permit2', chainId: 8453, verifyingContract: permit2 },
  types: { PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
    PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
  primaryType: 'PermitSingle',
  message: { details: { token, amount: amount.toString(), expiration: 1_800_086_400, nonce: 0 }, spender, sigDeadline: '1800003600' } });
const safeTx = (verifyingContract: Address, operation = 0, data: Hex = '0x') => typed({ domain: { chainId: 8453, verifyingContract },
  types: { SafeTx: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' }] },
  primaryType: 'SafeTx', message: { to: spender, value: '0', data, operation, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: 3 } });
const payData = () => encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: 'pay', args: [7n, token, 5n, account, 0n, 'hi', '0x'] });
const forwardRequest = (from: Address = account) => typed({ domain: { name: 'Juicebox', version: '1', chainId: 8453, verifyingContract: forwarder },
  types: { ForwardRequest: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint48' }, { name: 'data', type: 'bytes' }] },
  primaryType: 'ForwardRequest', message: { from, to: terminal, value: '0', gas: '300000', nonce: '0', deadline: 1_800_003_600, data: payData() } });
async function reviewed(request: SignatureRequest, chain = consistent, abis = noLookups) {
  const result = await reviewSignature({ account, request, chain, abis });
  if (!result.ok) throw new Error(result.refusal);
  return { review: result.review, view: reviewedSignatureView(result.review, account) };
}
const refusal = async (request: SignatureRequest, chain = consistent) => {
  const result = await reviewSignature({ account, request, chain, abis: noLookups });
  return result.ok ? null : result.refusal;
};
const draftOf = (review: ReviewedSignatureReview) => createWalletSignatureReviewDraft(base,
  { id: randomUUID(), state: randomBytes(32).toString('base64url'), createdAtMs: now, review });

describe('signatures from a Signa account', () => {
  it('decodes a Permit2 PermitSingle with token, amount, spender and expiry', async () => {
    const { view } = await reviewed(permitSingle());
    expect(view.facts).toEqual({ kind: 'permit2', spender, deadline: '1800003600',
      tokens: [{ token: token.toLowerCase(), amount: '1000000', expiration: '1800086400' }] });
    expect(view.warnings).toEqual([]); expect(view.call).toBeNull();
    // The allowance Permit2 grants without limit is said so.
    expect((await reviewed(permitSingle(maxUint160))).view.warnings).toEqual(['unlimited-approval']);
  });

  it('decodes a forward request with its inner call', async () => {
    const { review, view } = await reviewed(forwardRequest());
    expect(review.sources).toEqual([{ source: 'first-party' }]);
    expect(view.facts).toMatchObject({ kind: 'forward-request', forwarder, deadline: '1800003600',
      call: { from: account.toLowerCase(), to: terminal.toLowerCase(), value: '0', data: payData() } });
    expect(view.call!.model.calls[0]).toMatchObject({ functionName: 'pay', to: getAddress(terminal) });
    // A request from someone else is not this account's call: every field is shown under the warning instead.
    expect((await reviewed(forwardRequest(otherSafe))).view.facts.kind).toBe('typed-data');
  });

  it('decodes a SafeTx for another Safe with its inner call and warns on DELEGATECALL', async () => {
    const abis: EtherscanAbiSource = { abiFor: vi.fn(async () => ({ ok: false as const, reason: 'no-abi' as const })) };
    const { review, view } = await reviewed(safeTx(otherSafe, 1, '0x12345678'), consistent, abis);
    expect(view.facts).toMatchObject({ kind: 'safe-tx', safe: otherSafe, nonce: '3', operation: 1, refund: false,
      call: { from: otherSafe, to: spender, data: '0x12345678' } });
    expect(review.sources).toEqual([{ source: 'raw', lookup: 'no-abi' }]);
    expect(view.warnings).toEqual(['delegatecall']);
  });

  it('shows a message as its exact text', async () => {
    const message = 'example.com wants you to sign in with your Ethereum account:\n0xabc\n\nURI: https://example.com\nNonce: 32891756';
    const { review, view } = await reviewed({ kind: 'message', chainId: 8453, message });
    expect(view.facts).toEqual({ kind: 'message', text: message }); expect(view.warnings).toEqual([]);
    const draft = draftOf(review);
    expect(draft.signing.requestDigest).toBe(hashMessage(message));
  });

  it('refuses SafeTx typed data whose verifying contract is the account', async () => {
    expect(await refusal(safeTx(account))).toBe('account-self-administration');
    expect(await refusal(safeTx(account.toLowerCase() as Address))).toBe('account-self-administration');
    // Signa's own authority documents and a SmartSession enable are refused too, whatever they are addressed to.
    expect(await refusal(typed({ domain: { name: 'Juicebox Center REST', version: '1', chainId: 8453 }, types: { M: [{ name: 'a', type: 'uint256' }] },
      primaryType: 'M', message: { a: 1 } }))).toBe('account-self-administration');
    expect(await refusal(typed({ domain: { name: 'SmartSession', version: '1' }, types: { M: [{ name: 'a', type: 'uint256' }] },
      primaryType: 'M', message: { a: 1 } }))).toBe('account-self-administration');
    // The refusal is read before any decode, and a stored review that turns into one is no longer valid.
    const { review } = await reviewed(safeTx(otherSafe));
    expect(recognizeReviewedSignature({ ...review, request: safeTx(account) }, account)).toBeNull();
  });

  it('shows unknown typed data field by field with a warning and allows approval', async () => {
    const request = typed({ domain: { name: 'Mail', version: '1', chainId: 8453, verifyingContract: otherSafe },
      types: { Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
        Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person[]' }, { name: 'contents', type: 'string' }] },
      primaryType: 'Mail', message: { from: { name: 'Cow', wallet: spender }, to: [{ name: 'Bob', wallet: otherSafe }], contents: 'Hello, Bob!' } });
    const { review, view } = await reviewed(request);
    expect(view.warnings).toEqual(['unknown-typed-data']);
    expect(view.facts).toEqual({ kind: 'typed-data', fields: [['domain.name', 'Mail'], ['domain.version', '1'], ['domain.chainId', '8453'],
      ['domain.verifyingContract', otherSafe], ['from.name', 'Cow'], ['from.wallet', spender], ['to[0].name', 'Bob'], ['to[0].wallet', otherSafe],
      ['contents', 'Hello, Bob!']] });
    // Approval: one passkey assertion over the SafeMessage digest is the account's ERC-1271 signature over the typed data.
    const draft = draftOf(review);
    const requestDigest = hashTypedData((request as Extract<SignatureRequest, { kind: 'typed-data' }>).typedData as never);
    expect(draft.signing).toEqual({ requestDigest, digest: safe7579MessageSigningPayload({ safe: account, chainId: 8453, requestDigest }).digest });
    const proof = verifyWalletPaymentReviewProof(draft, signGet({ ...credential, rpId, origin: issuer, challenge: draft.signing.digest }));
    expect(proof.signedCommitment).toBe(requestDigest);
    expect(decodeSafe7579MessageSignature(proof.signature, 1)).toMatchObject([{ kind: 'contract', owner: expect.stringMatching(new RegExp(draft.authority.signer, 'i')) }]);
    // An assertion over the request digest itself, or another review's, is not this approval.
    expect(() => verifyWalletPaymentReviewProof(draft, signGet({ ...credential, rpId, origin: issuer, challenge: requestDigest }))).toThrow();
  });

  it('refuses a domain chainId that differs from the request', async () => {
    const request = permitSingle();
    if (request.kind !== 'typed-data') throw new Error('typed');
    expect(await refusal({ ...request, typedData: { ...request.typedData, domain: { ...request.typedData.domain, chainId: 1 } } })).toBe('chain-mismatch');
    const { chainId: _chainId, ...chainless } = request.typedData.domain;
    expect(await refusal({ ...request, typedData: { ...request.typedData, domain: chainless } })).toBe('chain-mismatch');
  });

  it('refuses on a chain whose owners diverge', async () => {
    expect(await refusal(permitSingle(), { ...consistent, owners: async () => 'diverged' })).toBe('owners-diverged');
    expect(await refusal(permitSingle(), { ...consistent, deployed: async () => false })).toBe('account-not-deployed');
    // Owners that could not be read are never consistent.
    await expect(reviewSignature({ account, request: permitSingle(), chain: { ...consistent, owners: async () => 'unknown' }, abis: noLookups }))
      .rejects.toMatchObject({ code: 'WALLET_OWNERS_UNKNOWN' });
  });

  it('reads typed data exactly: missing, extra or inexact fields are refused', () => {
    const request = permitSingle();
    if (request.kind !== 'typed-data') throw new Error('typed');
    const message = request.typedData.message as Record<string, unknown>;
    for (const changed of [{ ...message, extra: 1 }, { spender, sigDeadline: '1' }, { ...message, sigDeadline: 2 ** 60 }, { ...message, spender: 'bob' }])
      expect(() => typed({ ...request.typedData, message: changed })).toThrow();
    expect(() => signatureRequestOf({ kind: 'message', chainId: 8453, message: '' })).toThrow();
  });

  it('keeps a signature review exact: the stored request, sources and digests are re-derived', async () => {
    const { review } = await reviewed(forwardRequest());
    const draft = draftOf(review);
    expect(validateWalletAnyReviewDraft(structuredClone(draft))).toEqual(draft);
    const other = draftOf((await reviewed(permitSingle())).review);
    for (const changed of [{ ...draft, signing: other.signing }, { ...draft, review: { ...draft.review, sources: [{ source: 'raw', lookup: 'no-abi' }] } },
      { ...draft, review: other.review }, { ...draft, operationId: randomUUID() }])
      expect(() => validateWalletSignatureReviewDraft(changed)).toThrow();
    // The app's view carries the request and, once approved, the signature; the page's view adds what it re-derives.
    const view = { draft, status: 'pending' as const, approvedAtMs: null, cancelledAtMs: null, operationState: null, approvers: [draft.authority.credential.credentialId] };
    const app = publicWalletPaymentAppReview({ ...view, approval: null }) as unknown as Record<string, unknown>;
    expect(Object.keys(app).sort()).toEqual(['accountId', 'app', 'approval', 'approvedAtMs', 'cancelledAtMs', 'chainId', 'createdAtMs', 'expiresAtMs',
      'id', 'issuer', 'review', 'signing', 'state', 'status', 'version']);
    const central = publicWalletPaymentCentralReview(view) as WalletSignatureCentralPublic;
    expect(central.reviewedSignature.facts.kind).toBe('forward-request');
    expect(central.passkey.challenge).toBe(Buffer.from(draft.signing.digest.slice(2), 'hex').toString('base64url'));
  });
});
