import { beforeAll, describe, expect, it } from 'vitest';
import { hashTypedData, zeroAddress } from 'viem';
import { createWalletAuthorityContextFixture } from './fixtures/wallet-authority-context.js';
import { createRegistration } from './fixtures/wallet-enrollment-crypto.js';
import { createWalletRecoveryIntent, prepareWalletRecoveryCandidate, type WalletRecoveryCandidate } from '../src/rest/wallet/recovery.js';
import { prepareWalletRecoveryRotation, walletRecoveryRotationDocument } from '../src/rest/wallet/recoveryRotation.js';
import { assertWalletRecoveryRotationReview, WALLET_PASSKEY_PROFILE, walletPasskeyPublicKey, walletPasskeySigner, type WalletRecoveryReviewSelection } from '../src/rest/web/walletRecoveryReview.js';
import { generateKeyPairSync } from 'node:crypto';
import { preparePasskeyDependencyDeployment } from '../src/rest/smartAccounts/passkeyProfile.js';
import { predictPasskeySignerAddress } from '../src/rest/smartAccounts/passkeyCreation.js';

let candidate: WalletRecoveryCandidate;
beforeAll(async () => {
  const context = await createWalletAuthorityContextFixture(1_800_000_120_000);
  const intent = createWalletRecoveryIntent(context, { rpId: context.credential.rpId, origin: context.enrollment.intent.origin,
    nowMs: 1_800_000_120_000, expiresAtMs: 1_800_000_240_000 });
  const key = createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
  candidate = prepareWalletRecoveryCandidate(intent, key.response);
});
function fixture() {
  const review = prepareWalletRecoveryRotation(candidate, { owners: [candidate.intent.priorSigner, candidate.intent.recoveryOwner], threshold: 1, safeNonce: '5' });
  const selected: WalletRecoveryReviewSelection = { id: review.recoveryId, candidateDigest: review.candidateDigest,
    walletAddress: review.walletAddress, initializerHash: review.initializerHash, recoveryOwner: review.recoveryOwner,
    priorSigner: review.priorSigner, replacementSigner: review.replacementSigner, rotationContext: {
      publicKey: candidate.credential.publicKey, signerFactory: candidate.intent.manifest.ownerProfile!.signerFactory.address,
      verifiers: candidate.intent.manifest.ownerProfile!.p256Verifier.address } };
  const document = walletRecoveryRotationDocument(review);
  const response = JSON.parse(JSON.stringify({ review, document }, (_key, value) => typeof value === 'bigint' ? String(value) : value));
  return { selected, response, document };
}
describe('browser recovery rotation review', () => {
  it('rebuilds the exact server review from public selected identity and returns standard SafeTx signing data', () => {
    const value = fixture();
    expect(hashTypedData(assertWalletRecoveryRotationReview(value.response, value.selected))).toBe(hashTypedData(value.document));
  });
  it('accepts a device passkey as the previous owner once the account has devices, and rejects the rotating signers there', () => {
    const device = `0x${'ab'.repeat(20)}` as const;
    const review = prepareWalletRecoveryRotation(candidate, { owners: [device, candidate.intent.priorSigner, candidate.intent.recoveryOwner], threshold: 1, safeNonce: '5' });
    expect(review.previousOwner.toLowerCase()).toBe(device);
    const { selected } = fixture(), document = walletRecoveryRotationDocument(review);
    const response = JSON.parse(JSON.stringify({ review, document }, (_key, value) => typeof value === 'bigint' ? String(value) : value));
    expect(hashTypedData(assertWalletRecoveryRotationReview(response, selected))).toBe(hashTypedData(document));
    for (const previous of [selected.priorSigner, selected.replacementSigner, zeroAddress, '0xab', 'ab'.repeat(20)]) {
      const changed = structuredClone(response); changed.review.previousOwner = previous;
      expect(() => assertWalletRecoveryRotationReview(changed, selected)).toThrow();
    }
  });
  it('rejects wrong Safe, generation, signer, factory, extra calls and appended calldata', () => {
    const { selected, response } = fixture();
    for (const mutate of [
      (r: typeof response) => { r.review.walletAddress = zeroAddress; },
      (r: typeof response) => { r.review.candidateDigest = '11'.repeat(32); },
      (r: typeof response) => { r.review.replacementSigner = selected.recoveryOwner; },
      (r: typeof response) => { r.review.createSigner.to = zeroAddress; },
      (r: typeof response) => { r.review.createSigner.data += '00'; },
      (r: typeof response) => { r.review.swapOwner.data += '00'; },
      (r: typeof response) => { r.review.swapOwner.operation = 1; },
      (r: typeof response) => { r.review.previousOwner = zeroAddress; },
      (r: typeof response) => { r.approved = true; },
    ]) { const changed = structuredClone(response); mutate(changed); expect(() => assertWalletRecoveryRotationReview(changed, selected)).toThrow(); }
  });
  it('rejects redirected typed data, changed nonce, refunds, types or extra fields before signing', () => {
    const { selected, response } = fixture();
    for (const mutate of [
      (d: typeof response.document) => { d.domain.verifyingContract = selected.recoveryOwner; },
      (d: typeof response.document) => { d.domain.name = 'Safe'; },
      (d: typeof response.document) => { d.message.to = selected.recoveryOwner; },
      (d: typeof response.document) => { d.message.nonce = '6'; },
      (d: typeof response.document) => { d.message.operation = 1; },
      (d: typeof response.document) => { d.message.refundReceiver = selected.recoveryOwner; },
      (d: typeof response.document) => { d.message.gasPrice = '1'; },
      (d: typeof response.document) => { d.message.value = 0; },
      (d: typeof response.document) => { d.types.SafeTx[0].type = 'bytes32'; },
      (d: typeof response.document) => { d.types.Unused = []; },
    ]) { const changed = structuredClone(response); mutate(changed.document); expect(() => assertWalletRecoveryRotationReview(changed, selected)).toThrow(); }
  });
  it('refuses excessive nesting or accessor data without running application code', () => {
    const { selected, response } = fixture(); let invoked = false;
    Object.defineProperty(response.review, 'candidateDigest', { get() { invoked = true; return selected.candidateDigest; }, enumerable: true });
    expect(() => assertWalletRecoveryRotationReview(response, selected)).toThrow(); expect(invoked).toBe(false);
    expect(() => assertWalletRecoveryRotationReview({ ...fixture().response, extra: 'x'.repeat(20000) }, selected)).toThrow();
  });
});

describe('browser passkey signer', () => {
  it('derives the same signer as the server from the built-in profile and a new passkey key', async () => {
    const { profile } = await preparePasskeyDependencyDeployment();
    expect(WALLET_PASSKEY_PROFILE).toEqual({ signerFactory: profile.signerFactory.address, signerSingleton: profile.signerSingleton.address, p256Verifier: profile.p256Verifier.address });
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), spki = publicKey.export({ format: 'der', type: 'spki' });
    const key = walletPasskeyPublicKey(spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.length) as ArrayBuffer, -7), jwk = publicKey.export({ format: 'jwk' });
    expect(key).toEqual({ x: `0x${Buffer.from(jwk.x!, 'base64url').toString('hex')}`, y: `0x${Buffer.from(jwk.y!, 'base64url').toString('hex')}` });
    expect(walletPasskeySigner(key).replacementSigner).toBe(predictPasskeySignerAddress({ manifest: { ...candidate.intent.manifest, ownerProfile: profile }, publicKey: key }));
    expect(() => walletPasskeyPublicKey(spki.buffer as ArrayBuffer, -257)).toThrow();
    expect(() => walletPasskeySigner({ x: key.x, y: `0x${'00'.repeat(32)}` })).toThrow();
  });
});
