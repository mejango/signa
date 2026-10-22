import { beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, hashTypedData, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { createWalletAuthorityContextFixture, lastFixturePrimary } from './fixtures/wallet-authority-context.js';
import { createRegistration, signGet } from './fixtures/wallet-enrollment-crypto.js';
import { decodeSafeOwnerSignatures } from '../src/rest/smartAccounts/passkeySignatures.js';
import { createWalletDeviceIntent, prepareWalletDeviceCandidate, prepareWalletDeviceAddition, verifyWalletDeviceAddition,
  verifyWalletDevicePossession, walletDeviceAdditionDocument, walletDeviceDocument, type WalletDeviceCandidate } from '../src/rest/wallet/deviceAddition.js';
import type { WalletAuthorityContext } from '../src/rest/wallet/authority.js';

const now = 1_800_000_120_000;
let context: WalletAuthorityContext, candidate: WalletDeviceCandidate, device: ReturnType<typeof createRegistration>;
let primary: NonNullable<typeof lastFixturePrimary>;
const safeAbi = parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
  'function addOwnerWithThreshold(address owner,uint256 _threshold)']);
beforeAll(async () => {
  context = await createWalletAuthorityContextFixture(now); primary = lastFixturePrimary!;
  const intent = createWalletDeviceIntent(context, { rpId: context.credential.rpId, origin: context.enrollment.intent.origin, nowMs: now, expiresAtMs: now + 120000 });
  device = createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
  candidate = prepareWalletDeviceCandidate(intent, device.response);
});
const owners = () => [context.binding.state.ownerProfile!.signer.address, context.enrollment.intent.recoveryOwner] as Address[];
const rpc = () => ({ rpId: context.credential.rpId, origin: context.enrollment.intent.origin });
const primaryPasskey = () => ({ credentialId: context.credential.credentialId, userHandle: context.credential.userHandle,
  publicKey: context.credential.publicKey, backupEligible: context.credential.backupEligible });

describe('adding a device', () => {
  it('captures the primary and the account, and the new device proves possession of its own passkey', () => {
    expect(candidate.intent).toMatchObject({ accountId: context.accountId, primarySigner: context.binding.state.ownerProfile!.signer.address.toLowerCase(),
      recoveryOwner: context.enrollment.intent.recoveryOwner.toLowerCase(), existingSigners: [], userHandle: context.enrollment.intent.userHandle });
    expect(candidate.signerAddress).not.toBe(candidate.intent.primarySigner);
    const proof = verifyWalletDevicePossession(candidate, signGet({ ...device, challenge: hashTypedData(walletDeviceDocument(candidate)), ...rpc() }), now + 1000);
    expect(proof).toMatchObject({ deviceId: candidate.intent.id, accountId: context.accountId, verifiedAtMs: now + 1000 });
    // The primary's passkey cannot stand in for the device, and the deadline holds.
    expect(() => verifyWalletDevicePossession(candidate, signGet({ ...primary, challenge: hashTypedData(walletDeviceDocument(candidate)), ...rpc() }), now + 1000)).toThrow();
    expect(() => verifyWalletDevicePossession(candidate, signGet({ ...device, challenge: hashTypedData(walletDeviceDocument(candidate)), ...rpc() }), now + 120000)).toThrow();
  });
  it('the primary passkey approves one exact addOwnerWithThreshold at one Safe nonce, packed as a contract-owner signature', () => {
    const review = prepareWalletDeviceAddition(candidate, { owners: owners(), threshold: 1, safeNonce: '4' });
    expect(review).toMatchObject({ deviceSigner: candidate.signerAddress, primarySigner: candidate.intent.primarySigner, safeNonce: '4' });
    expect(decodeFunctionData({ abi: safeAbi, data: review.addOwner.data })).toEqual({ functionName: 'addOwnerWithThreshold', args: [candidate.signerAddress, 1n] });
    const document = walletDeviceAdditionDocument(review), safeTxHash = hashTypedData(document);
    expect(document.message).toMatchObject({ to: review.walletAddress, data: review.addOwner.data, nonce: 4n, operation: 0 });
    const assertion = signGet({ ...primary, challenge: safeTxHash, ...rpc() });
    const calls = verifyWalletDeviceAddition(candidate, review, assertion, primaryPasskey());
    expect(calls.safeTxHash).toBe(safeTxHash); expect(calls.createSigner).toEqual(review.createSigner);
    const execution = decodeFunctionData({ abi: safeAbi, data: calls.addOwner.data });
    expect(execution.args!.slice(0, 9)).toEqual([review.walletAddress, 0n, review.addOwner.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress]);
    const packed = decodeSafeOwnerSignatures(execution.args![9] as Hex, 1);
    expect(packed).toHaveLength(1);
    expect(packed[0]).toMatchObject({ kind: 'contract', owner: context.binding.state.ownerProfile!.signer.address });
    // A device's own assertion, a changed nonce, or a review for other owners is refused.
    expect(() => verifyWalletDeviceAddition(candidate, review, signGet({ ...device, challenge: safeTxHash, ...rpc() }), primaryPasskey())).toThrow();
    expect(() => verifyWalletDeviceAddition(candidate, { ...review, safeNonce: '5' }, assertion, primaryPasskey())).toThrow();
    expect(() => prepareWalletDeviceAddition(candidate, { owners: [...owners(), candidate.signerAddress], threshold: 1, safeNonce: '4' })).toThrow();
    expect(() => prepareWalletDeviceAddition(candidate, { owners: owners(), threshold: 2, safeNonce: '4' })).toThrow();
    // An owner the account has not recorded (an earlier addition mined but never activated) blocks any new review.
    expect(() => prepareWalletDeviceAddition(candidate, { owners: [`0x${'ee'.repeat(20)}`, ...owners()], threshold: 1, safeNonce: '4' })).toThrow();
    expect(() => prepareWalletDeviceAddition(candidate, { owners: [owners()[0]!], threshold: 1, safeNonce: '4' })).toThrow();
  });
  it('each other chain gets its own addition, signed for that chain only', () => {
    const base = prepareWalletDeviceAddition(candidate, { owners: owners(), threshold: 1, safeNonce: '0' });
    const optimism = prepareWalletDeviceAddition(candidate, { owners: owners(), threshold: 1, safeNonce: '0' }, 10);
    expect(base).not.toHaveProperty('chainId'); expect(optimism.chainId).toBe(10);
    expect(walletDeviceAdditionDocument(optimism).domain.chainId).toBe(10);
    const challenge = hashTypedData(walletDeviceAdditionDocument(optimism));
    expect(challenge).not.toBe(hashTypedData(walletDeviceAdditionDocument(base)));
    const assertion = signGet({ ...primary, challenge, ...rpc() });
    expect(verifyWalletDeviceAddition(candidate, optimism, assertion, primaryPasskey()).safeTxHash).toBe(challenge);
    // Base's approval cannot stand for another chain, nor another chain's for Base.
    expect(() => verifyWalletDeviceAddition(candidate, base, assertion, primaryPasskey())).toThrow();
    expect(() => verifyWalletDeviceAddition(candidate, { ...optimism, chainId: 42161 }, assertion, primaryPasskey())).toThrow();
    expect(() => walletDeviceAdditionDocument({ ...base, chainId: 8453 })).toThrow();
  });
});
