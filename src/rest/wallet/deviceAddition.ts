import { randomBytes, randomUUID } from 'node:crypto';
import { encodeFunctionData, getAddress, hashTypedData, isAddress, parseAbi, type Address, type Hex } from 'viem';
import { RestError } from '../core.js';
import type { SmartAccountManifest } from '../smartAccounts/types.js';
import { encodeSafeOwnerSignatures } from '../smartAccounts/passkeySignatures.js';
import { maximumPasskeySigners } from '../smartAccounts/passkeyProfile.js';
import { predictPasskeySignerAddress, validatePasskeyCreationManifest } from '../smartAccounts/passkeyCreation.js';
import { validateWalletAuthorityContext, type WalletAuthorityContext, type WalletAuthorityCredential } from './authority.js';
import { enrollmentDigest } from './enrollment.js';
import { assertWalletCeremonyDraft, createWalletCeremony, type WalletCeremonyDraft } from './ceremonies.js';
import { parseWalletRegistration, type WalletRegistrationCandidate, type WalletRegistrationResponse } from './registration.js';
import { validateWalletRpConfiguration, verifyWalletAssertion, type WalletAssertion } from './webauthn.js';
import { copyWalletEnrollmentRegistration } from './enrollmentPostgres.js';
import { copyWalletSignupAssertion } from './signupPostgres.js';
import { walletOwnerChangeSafeTx } from '../web/walletRecoveryReview.js';
import { SIGNA_HOME_CHAIN_ID } from './chains.js';

/** Adding a device: a second device registers its own passkey for an existing account, proves it
 * holds it, and the account's primary passkey approves adding the device's signer as a Safe owner.
 * Captured from the primary's signed-in context; never authority on its own. */
export interface WalletDeviceIntent {
  version: 'center-wallet-device-v1'; id: string; accountId: string; enrollmentId: string;
  enrollmentDigest: string; primaryCredentialDigest: string; bindingDigest: Hex;
  manifest: SmartAccountManifest; initializerHash: Hex; primarySigner: Address; recoveryOwner: Address; existingSigners: Address[];
  userHandle: string; rpId: string; origin: string; issuedAtMs: number; expiresAtMs: number;
  registration: WalletCeremonyDraft;
}
export interface WalletDeviceCandidate {
  intent: WalletDeviceIntent; credential: WalletRegistrationCandidate; signerAddress: Address;
  nonce: Hex; possession: WalletCeremonyDraft;
}
/** The new device proved it holds its passkey; still no authority over the account. */
export interface WalletDevicePossessionProof {
  deviceId: string; accountId: string; intentDigest: string; candidateDigest: string; verificationDigest: string; verifiedAtMs: number;
}
export interface WalletDeviceCall { to: Address; value: '0'; data: Hex }
/** The exact owner addition the primary passkey reviews: one Safe transaction at one nonce. */
export interface WalletDeviceAddition {
  version: 'center-wallet-device-addition-v1'; deviceId: string; candidateDigest: string;
  walletAddress: Address; initializerHash: Hex; primarySigner: Address; deviceSigner: Address; safeNonce: string;
  createSigner: WalletDeviceCall; addOwner: WalletDeviceCall;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/, word = /^0x[0-9a-f]{64}$/;
const factoryAbi = parseAbi(['function createSigner(uint256 x,uint256 y,uint176 verifiers) returns(address)']);
const safeAbi = parseAbi([
  'function addOwnerWithThreshold(address owner,uint256 _threshold)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)',
]);
const intentFields = ['version', 'id', 'accountId', 'enrollmentId', 'enrollmentDigest', 'primaryCredentialDigest', 'bindingDigest', 'manifest',
  'initializerHash', 'primarySigner', 'recoveryOwner', 'existingSigners', 'userHandle', 'rpId', 'origin', 'issuedAtMs', 'expiresAtMs', 'registration'];
function invalid(): never { throw new RestError(400, 'WALLET_DEVICE_INVALID', 'Device fields or the selected account context are invalid.'); }
function unauthorized(): never { throw new RestError(403, 'WALLET_DEVICE_PROOF_INVALID', 'Adding a device requires the exact new passkey and the account\'s primary passkey.'); }
function fields(value: unknown, names: string[]) {
  enrollmentDigest(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
}
function bytes(value: unknown, maximum: number, minimum = maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length < minimum || decoded.length > maximum || decoded.toString('base64url') !== value) invalid();
}
const account = (value: unknown): value is string => typeof value === 'string' && new RegExp(`^eip155:${SIGNA_HOME_CHAIN_ID}:0x[0-9a-f]{40}$`).test(value) && BigInt(value.slice(12)) > 1n;
const owner = (value: unknown): value is Address => typeof value === 'string' && isAddress(value) && BigInt(value) > 1n && value === value.toLowerCase();
function nonce(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) invalid();
}
function base(intent: WalletDeviceIntent) { const { registration: _registration, ...value } = intent; return value; }
const ceremonyAccount = (intent: WalletDeviceIntent) => 'wallet-device:' + intent.id;

export function assertWalletDeviceIntent(value: WalletDeviceIntent): void {
  try {
    fields(value, intentFields); validateWalletRpConfiguration(value); validatePasskeyCreationManifest(value.manifest);
    if (value.version !== 'center-wallet-device-v1' || !uuid.test(value.id) || !uuid.test(value.enrollmentId) || !account(value.accountId)
      || !digest.test(value.enrollmentDigest) || !digest.test(value.primaryCredentialDigest) || !word.test(value.bindingDigest)
      || !word.test(value.initializerHash) || !owner(value.primarySigner) || !owner(value.recoveryOwner) || value.primarySigner === value.recoveryOwner
      || !Array.isArray(value.existingSigners) || value.existingSigners.length > maximumPasskeySigners - 2 || value.existingSigners.some(entry => !owner(entry))
      || new Set([value.primarySigner, value.recoveryOwner, ...value.existingSigners]).size !== 2 + value.existingSigners.length
      || !Number.isSafeInteger(value.issuedAtMs) || value.issuedAtMs < 1 || !Number.isSafeInteger(value.expiresAtMs)
      || value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs > value.issuedAtMs + 300000) invalid();
    bytes(value.userHandle, 32); assertWalletCeremonyDraft(value.registration);
    if (value.registration.accountId !== ceremonyAccount(value) || value.registration.purpose !== 'registration'
      || value.registration.contextDigest !== enrollmentDigest(base(value)) || value.registration.expiresAt !== value.expiresAtMs) invalid();
  } catch { invalid(); }
}
/** From the primary passkey's signed-in context. The intent lives five minutes, like recovery. */
export function createWalletDeviceIntent(inputContext: WalletAuthorityContext, options: { rpId: string; origin: string; nowMs: number; expiresAtMs: number }): WalletDeviceIntent {
  fields(options, ['rpId', 'origin', 'nowMs', 'expiresAtMs']);
  const context = validateWalletAuthorityContext(inputContext), profile = context.binding.state.ownerProfile!;
  const value = { version: 'center-wallet-device-v1' as const, id: randomUUID(), accountId: context.accountId,
    enrollmentId: context.enrollment.intent.id, enrollmentDigest: enrollmentDigest(context.enrollment),
    primaryCredentialDigest: enrollmentDigest(context.credential), bindingDigest: context.binding.authorization.digest,
    manifest: structuredClone(context.enrollment.intent.manifest), initializerHash: context.enrollment.creation!.initializerHash,
    primarySigner: profile.signer.address.toLowerCase() as Address, recoveryOwner: context.enrollment.intent.recoveryOwner.toLowerCase() as Address,
    existingSigners: (profile.devices ?? []).map(device => device.address.toLowerCase() as Address),
    userHandle: context.enrollment.intent.userHandle, rpId: options.rpId, origin: options.origin,
    issuedAtMs: options.nowMs, expiresAtMs: options.expiresAtMs };
  const intent = { ...value, registration: createWalletCeremony({ accountId: 'wallet-device:' + value.id, purpose: 'registration',
    contextDigest: enrollmentDigest(value), expiresAt: value.expiresAtMs }) };
  assertWalletDeviceIntent(intent); return intent;
}
function checkedCredential(intent: WalletDeviceIntent, credential: WalletRegistrationCandidate) {
  fields(credential, ['credentialId', 'userHandle', 'publicKey', 'signCount', 'backupEligible', 'backedUp', 'aaguid']);
  fields(credential.publicKey, ['x', 'y']); bytes(credential.credentialId, 1023, 1);
  if (credential.userHandle !== intent.userHandle || !word.test(credential.publicKey.x) || !word.test(credential.publicKey.y)
    || !Number.isInteger(credential.signCount) || credential.signCount < 0 || credential.signCount > 0xffffffff
    || typeof credential.backupEligible !== 'boolean' || typeof credential.backedUp !== 'boolean' || credential.backedUp && !credential.backupEligible
    || typeof credential.aaguid !== 'string' || !/^0x[0-9a-f]{32}$/.test(credential.aaguid)) invalid();
}
const types = { WalletDevice: [
  { name: 'purpose', type: 'string' }, { name: 'deviceId', type: 'string' }, { name: 'accountId', type: 'string' },
  { name: 'enrollmentId', type: 'string' }, { name: 'enrollmentDigest', type: 'bytes32' }, { name: 'primaryCredentialDigest', type: 'bytes32' },
  { name: 'bindingDigest', type: 'bytes32' }, { name: 'initializerHash', type: 'bytes32' }, { name: 'manifestCommitment', type: 'bytes32' },
  { name: 'primarySigner', type: 'address' }, { name: 'deviceSigner', type: 'address' }, { name: 'deviceCredentialDigest', type: 'bytes32' },
  { name: 'rpId', type: 'string' }, { name: 'origin', type: 'string' }, { name: 'nonce', type: 'bytes32' },
  { name: 'issuedAtMs', type: 'uint64' }, { name: 'expiresAtMs', type: 'uint64' },
] } as const;
function document(value: Pick<WalletDeviceCandidate, 'intent' | 'credential' | 'nonce' | 'signerAddress'>) {
  const intent = value.intent;
  return { domain: { name: 'Juicebox Center Wallet Device', version: '1', chainId: SIGNA_HOME_CHAIN_ID, verifyingContract: getAddress(intent.accountId.slice(12)) },
    types, primaryType: 'WalletDevice' as const,
    message: { purpose: 'add-device', deviceId: intent.id, accountId: intent.accountId, enrollmentId: intent.enrollmentId,
      enrollmentDigest: `0x${intent.enrollmentDigest}` as Hex, primaryCredentialDigest: `0x${intent.primaryCredentialDigest}` as Hex,
      bindingDigest: intent.bindingDigest, initializerHash: intent.initializerHash, manifestCommitment: `0x${enrollmentDigest(intent.manifest)}` as Hex,
      primarySigner: intent.primarySigner, deviceSigner: value.signerAddress, deviceCredentialDigest: `0x${enrollmentDigest(value.credential)}` as Hex,
      rpId: intent.rpId, origin: intent.origin, nonce: value.nonce, issuedAtMs: BigInt(intent.issuedAtMs), expiresAtMs: BigInt(intent.expiresAtMs) } };
}
function candidateBase(value: WalletDeviceCandidate) { const { possession: _possession, ...result } = value; return result; }
export function assertWalletDeviceCandidate(value: WalletDeviceCandidate) {
  fields(value, ['intent', 'credential', 'nonce', 'signerAddress', 'possession']);
  assertWalletDeviceIntent(value.intent); checkedCredential(value.intent, value.credential);
  const taken = [value.intent.primarySigner, value.intent.recoveryOwner, ...value.intent.existingSigners];
  if (!word.test(value.nonce) || BigInt(value.nonce) === 0n || !isAddress(value.signerAddress) || taken.includes(value.signerAddress.toLowerCase() as Address)
    || value.signerAddress !== predictPasskeySignerAddress({ manifest: value.intent.manifest, publicKey: value.credential.publicKey })) invalid();
  assertWalletCeremonyDraft(value.possession);
  if (value.possession.accountId !== ceremonyAccount(value.intent) || value.possession.purpose !== 'device'
    || value.possession.expiresAt !== value.intent.expiresAtMs || value.possession.contextDigest !== enrollmentDigest(candidateBase(value))
    || value.possession.challenge !== Buffer.from(hashTypedData(document(value)).slice(2), 'hex').toString('base64url')) invalid();
}
export function prepareWalletDeviceCandidate(input: WalletDeviceIntent, response: WalletRegistrationResponse): WalletDeviceCandidate {
  assertWalletDeviceIntent(input); const intent = structuredClone(input), registration = copyWalletEnrollmentRegistration(response);
  const credential = parseWalletRegistration(registration, { rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
  const value = { intent, credential, signerAddress: predictPasskeySignerAddress({ manifest: intent.manifest, publicKey: credential.publicKey }),
    nonce: `0x${randomBytes(32).toString('hex')}` as Hex };
  const result = { ...value, possession: { ...createWalletCeremony({ accountId: ceremonyAccount(intent), purpose: 'device',
    contextDigest: enrollmentDigest(value), expiresAt: intent.expiresAtMs }), challenge: Buffer.from(hashTypedData(document(value)).slice(2), 'hex').toString('base64url') } };
  assertWalletDeviceCandidate(result); return result;
}
export function walletDeviceDocument(value: WalletDeviceCandidate) { assertWalletDeviceCandidate(value); return document(value); }
/** The new device's own assertion over the device document. */
export function verifyWalletDevicePossession(input: WalletDeviceCandidate, inputAssertion: WalletAssertion, nowMs: number): WalletDevicePossessionProof {
  assertWalletDeviceCandidate(input); const value = structuredClone(input), intent = value.intent;
  if (!Number.isSafeInteger(nowMs) || nowMs < intent.issuedAtMs || nowMs >= intent.expiresAtMs)
    throw new RestError(410, 'WALLET_DEVICE_EXPIRED', 'Start adding the device again. The previous deadline cannot be extended.');
  let assertion: WalletAssertion;
  try { assertion = copyWalletSignupAssertion(inputAssertion); } catch { return unauthorized(); }
  const challenge = hashTypedData(document(value));
  try {
    verifyWalletAssertion(assertion, { purpose: 'device', challenge, rpId: intent.rpId, origin: intent.origin, requireUserHandle: true,
      credential: { id: value.credential.credentialId, userHandle: intent.userHandle, publicKey: value.credential.publicKey, backupEligible: value.credential.backupEligible } });
  } catch { return unauthorized(); }
  const identity = { deviceId: intent.id, accountId: intent.accountId, intentDigest: enrollmentDigest(intent), candidateDigest: enrollmentDigest(value) };
  return { ...identity, verifiedAtMs: nowMs, verificationDigest: enrollmentDigest({ ...identity, challenge }) };
}

/** The exact addition at one Safe nonce, rebuilt from the captured candidate and the observed owners. */
export function prepareWalletDeviceAddition(input: WalletDeviceCandidate, inputState: { owners: Address[]; threshold: number; safeNonce: string }): WalletDeviceAddition {
  assertWalletDeviceCandidate(input); enrollmentDigest(inputState);
  const candidate = structuredClone(input), state = structuredClone(inputState), intent = candidate.intent;
  if (Object.keys(state).sort().join(',') !== 'owners,safeNonce,threshold' || !Array.isArray(state.owners) || state.threshold !== 1
    || state.owners.length < 2 || state.owners.length > maximumPasskeySigners || state.owners.some(entry => typeof entry !== 'string' || !isAddress(entry))) invalid();
  nonce(state.safeNonce);
  const owners = state.owners.map(entry => entry.toLowerCase());
  // Exactly the recorded owners: primary, recovery owner and the devices this intent captured. An
  // owner the account has not recorded (an addition mined but not activated) blocks any new review.
  const expected = [intent.primarySigner, intent.recoveryOwner, ...intent.existingSigners].map(entry => entry.toLowerCase());
  if (new Set(owners).size !== owners.length || owners.length !== expected.length || expected.some(entry => !owners.includes(entry))
    || owners.includes(candidate.signerAddress.toLowerCase())) invalid();
  const walletAddress = getAddress(intent.accountId.slice(12));
  return { version: 'center-wallet-device-addition-v1', deviceId: intent.id, candidateDigest: enrollmentDigest(candidate),
    walletAddress, initializerHash: intent.initializerHash, primarySigner: intent.primarySigner, deviceSigner: candidate.signerAddress, safeNonce: state.safeNonce,
    createSigner: { to: getAddress(intent.manifest.ownerProfile!.signerFactory.address), value: '0',
      data: encodeFunctionData({ abi: factoryAbi, functionName: 'createSigner', args: [BigInt(candidate.credential.publicKey.x),
        BigInt(candidate.credential.publicKey.y), BigInt(intent.manifest.ownerProfile!.p256Verifier.address)] }) },
    addOwner: { to: walletAddress, value: '0', data: encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [candidate.signerAddress, 1n] }) } };
}
/** Standard Safe 1.4.1 SafeTx the primary passkey signs (its challenge is the SafeTx hash). */
export function walletDeviceAdditionDocument(input: WalletDeviceAddition) {
  enrollmentDigest(input); const review = structuredClone(input); nonce(review.safeNonce);
  if (Object.keys(review).sort().join(',') !== 'addOwner,candidateDigest,createSigner,deviceId,deviceSigner,initializerHash,primarySigner,safeNonce,version,walletAddress'
    || review.version !== 'center-wallet-device-addition-v1' || !isAddress(review.walletAddress) || !review.addOwner
    || Object.keys(review.addOwner).sort().join(',') !== 'data,to,value' || review.addOwner.to !== review.walletAddress || review.addOwner.value !== '0'
    || typeof review.addOwner.data !== 'string' || !/^0x[0-9a-f]{136}$/.test(review.addOwner.data)) invalid();
  return walletOwnerChangeSafeTx(review.walletAddress, review.addOwner.data, review.safeNonce);
}
export type WalletDevicePrimary = Pick<WalletAuthorityCredential, 'credentialId' | 'userHandle' | 'publicKey' | 'backupEligible'>;
/** Rebuild the addition from the captured candidate, verify the primary passkey's assertion over
 * its SafeTx hash, and hand dispatch only the exact factory and Safe calls, the passkey's
 * contract-owner signature packed the way Safe's legacy ERC-1271 check expects. */
export function verifyWalletDeviceAddition(input: WalletDeviceCandidate, inputReview: WalletDeviceAddition, inputAssertion: WalletAssertion, primary: WalletDevicePrimary) {
  assertWalletDeviceCandidate(input); enrollmentDigest(inputReview);
  const candidate = structuredClone(input), review = structuredClone(inputReview);
  // Only the nonce is read from the review; every owner fact is rebuilt from the candidate.
  const expected = prepareWalletDeviceAddition(candidate, { owners: [candidate.intent.primarySigner, candidate.intent.recoveryOwner, ...candidate.intent.existingSigners], threshold: 1, safeNonce: review.safeNonce });
  if (enrollmentDigest(expected) !== enrollmentDigest(review)) invalid();
  const document = walletDeviceAdditionDocument(review), safeTxHash = hashTypedData(document);
  let assertion: WalletAssertion;
  try { assertion = copyWalletSignupAssertion(inputAssertion); } catch { return unauthorized(); }
  let contractSignature: Hex;
  try {
    ({ contractSignature } = verifyWalletAssertion(assertion, { purpose: 'device', challenge: safeTxHash, rpId: candidate.intent.rpId, origin: candidate.intent.origin,
      requireUserHandle: false, credential: { id: primary.credentialId, userHandle: primary.userHandle, publicKey: primary.publicKey, backupEligible: primary.backupEligible } }));
  } catch { return unauthorized(); }
  const signatures = encodeSafeOwnerSignatures([{ kind: 'contract', owner: getAddress(candidate.intent.primarySigner), signature: contractSignature }]);
  const data = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [review.walletAddress, 0n, review.addOwner.data, 0, 0n, 0n, 0n,
    '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', signatures] });
  return { createSigner: review.createSigner, addOwner: { to: review.walletAddress, value: '0' as const, data }, safeTxHash,
    proofDigest: enrollmentDigest({ deviceId: candidate.intent.id, candidateDigest: enrollmentDigest(candidate), safeTxHash, primary: primary.credentialId }) };
}
