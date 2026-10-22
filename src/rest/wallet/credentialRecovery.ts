import { isAddress, type Address, type Hex } from 'viem';
import { RestError, type RestBlockEvidence } from '../core.js';
import { predictPasskeySignerAddress } from '../smartAccounts/passkeyCreation.js';
import { assertVerifiedWalletEnrollment, enrollmentDigest, type WalletEnrollment } from './enrollment.js';
import type { WalletRegistrationCandidate } from './registration.js';
import type { WalletAuthorityCredential } from './authority.js';
import { SIGNA_HOME_CHAIN_ID } from './chains.js';

/** Immutable storage lineage. Shape is not provenance: only the atomic recovery store
 * may insert it after accepted owner proof, fresh setup and canonical observation. */
export interface WalletCredentialRecovery {
  version: 'center-wallet-credential-recovery-v1'; id: string; accountId: string; enrollmentId: string;
  enrollmentDigest: string; priorCredentialDigest: string; priorBindingDigest: Hex; priorSigner: Address;
  signerAddress: Address; credential: WalletRegistrationCandidate; rpId: string; origin: string;
  initializerHash: Hex; proofDigest: string; bindingDigest: Hex; anchor: RestBlockEvidence;
  verifiedAtMs: number; acceptedAtMs: number;
}
function invalid(): never { throw new RestError(400, 'WALLET_AUTHORITY_INVALID', 'Current credential lineage does not match the original wallet.'); }
const same = (a: unknown, b: unknown) => enrollmentDigest(a) === enrollmentDigest(b);
function fields(value: any, required: string[], optional: string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
const word = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) !== 0n;
const digest = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const clock = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const quantity = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;

/** Validation occurs outside row locks; unchanged genesis remains verifiable forever. */
export function assertWalletAuthorityCredential(c: WalletAuthorityCredential, e: WalletEnrollment) {
  enrollmentDigest(c); assertVerifiedWalletEnrollment(e);
  fields(c, ['accountId', 'enrollmentId', 'rpId', 'credentialId', 'userHandle', 'publicKey', 'backupEligible', 'verifiedAtMs', 'supersededAtMs'], ['recovery']);
  fields(c.publicKey, ['x', 'y']);
  if (c.accountId !== e.receipt!.accountId || c.enrollmentId !== e.intent.id || c.rpId !== e.intent.rpId
    || c.userHandle !== e.intent.userHandle || c.supersededAtMs !== null || !clock(c.verifiedAtMs)) invalid();
  if (!Object.hasOwn(c, 'recovery')) {
    if (c.credentialId !== e.candidate!.credentialId || !same(c.publicKey, e.candidate!.publicKey)
      || c.backupEligible !== e.candidate!.backupEligible || c.verifiedAtMs !== e.receipt!.verifiedAt) invalid();
    return;
  }
  const r = c.recovery!;
  fields(r, ['version', 'id', 'accountId', 'enrollmentId', 'enrollmentDigest', 'priorCredentialDigest', 'priorBindingDigest',
    'priorSigner', 'signerAddress', 'credential', 'rpId', 'origin', 'initializerHash', 'proofDigest', 'bindingDigest', 'anchor', 'verifiedAtMs', 'acceptedAtMs']);
  if (r.version !== 'center-wallet-credential-recovery-v1' || typeof r.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.id)
    || r.accountId !== c.accountId || r.enrollmentId !== c.enrollmentId || r.enrollmentDigest !== enrollmentDigest(e)
    || !digest(r.priorCredentialDigest) || !digest(r.proofDigest) || !word(r.priorBindingDigest) || !word(r.bindingDigest)
    || r.priorBindingDigest === r.bindingDigest || r.rpId !== c.rpId || r.origin !== e.intent.origin
    || r.initializerHash !== e.creation!.initializerHash || r.verifiedAtMs !== c.verifiedAtMs
    || !clock(r.acceptedAtMs) || r.acceptedAtMs < r.verifiedAtMs || !isAddress(r.priorSigner) || BigInt(r.priorSigner) <= 1n
    || !isAddress(r.signerAddress) || r.signerAddress.toLowerCase() === r.priorSigner.toLowerCase()
    || r.signerAddress.toLowerCase() === e.intent.recoveryOwner.toLowerCase()
    || r.signerAddress !== predictPasskeySignerAddress({ manifest: e.intent.manifest, publicKey: c.publicKey })) invalid();
  const k = r.credential;
  fields(k, ['credentialId', 'userHandle', 'publicKey', 'signCount', 'backupEligible', 'backedUp', 'aaguid']);
  fields(k.publicKey, ['x', 'y']);
  if (typeof k.credentialId !== 'string' || !/^[A-Za-z0-9_-]{1,1364}$/.test(k.credentialId)
    || Buffer.from(k.credentialId, 'base64url').length > 1023 || Buffer.from(k.credentialId, 'base64url').toString('base64url') !== k.credentialId
    || k.credentialId !== c.credentialId || k.userHandle !== c.userHandle || !same(k.publicKey, c.publicKey)
    || typeof k.backupEligible !== 'boolean' || k.backupEligible !== c.backupEligible || typeof k.backedUp !== 'boolean'
    || k.backedUp && !k.backupEligible || !Number.isInteger(k.signCount) || k.signCount < 0 || k.signCount > 0xffffffff
    || typeof k.aaguid !== 'string' || !/^0x[0-9a-f]{32}$/.test(k.aaguid)) invalid();
  const a = r.anchor;
  fields(a, ['chainId', 'blockNumber', 'blockHash', 'timestamp', 'source']);
  if (a.chainId !== SIGNA_HOME_CHAIN_ID || a.source !== 'onchain' || !quantity(a.blockNumber) || !word(a.blockHash) || !quantity(a.timestamp)
    || BigInt(a.timestamp) * 1000n > BigInt(r.acceptedAtMs) + 30000n
    || BigInt(a.timestamp) * 1000n + 300000n <= BigInt(r.acceptedAtMs)) invalid();
}
