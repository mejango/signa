import type { Pool, PoolClient } from 'pg';
import type { Hex } from 'viem';
import type { ServerSigner } from '../signer.js';
import { RestError } from '../core.js';
import type { ContractPin, SmartAccountManifest } from '../smartAccounts/types.js';
import { stable } from '../smartAccounts/service.js';
import { enrollmentDigest } from './enrollment.js';
import { assertWalletDeviceCandidate, prepareWalletDeviceAddition, verifyWalletDeviceAddition, type WalletDeviceAddition, type WalletDeviceCandidate,
  type WalletDeviceIntent, type WalletDevicePossessionProof, type WalletDevicePrimary } from './deviceAddition.js';
import type { WalletAssertion } from './webauthn.js';
import { createWalletOwnerRelay, type LocalWalletOwnerStatus, type WalletOwnerRelaySource, type WalletRecoveryRelayAdapter } from './ownerRelay.js';

export interface WalletDeviceRecord {
  intent: WalletDeviceIntent; candidate: WalletDeviceCandidate | null; proof: WalletDevicePossessionProof | null; activation: unknown | null; session_id: string;
}
type Record = WalletDeviceRecord & { candidate: WalletDeviceCandidate; proof: WalletDevicePossessionProof };
/** The primary's approval as kept beside the review: the exact calls and the assertion that produced them. */
export type WalletDeviceApproval = { createSigner: WalletDeviceAddition['createSigner']; addOwner: { to: `0x${string}`; value: '0'; data: Hex }; safeTxHash: Hex; proofDigest: string;
  assertion: { credentialId: string; userHandle: string | null; authenticatorData: string; clientDataJSON: string; signature: string } };
export type LocalWalletDeviceStatus = LocalWalletOwnerStatus;
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const addressSame = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
function conflict(): never { throw new RestError(409, 'WALLET_DEVICE_DISPATCH_CONFLICT', 'The reviewed device addition or relay state changed.'); }
const wire = (assertion: WalletAssertion) => ({ credentialId: assertion.credentialId, userHandle: assertion.userHandle === null ? null : Buffer.from(assertion.userHandle).toString('base64url'),
  authenticatorData: Buffer.from(assertion.authenticatorData).toString('base64url'), clientDataJSON: Buffer.from(assertion.clientDataJSON).toString('base64url'),
  signature: Buffer.from(assertion.signature).toString('base64url') });

/** Adding a device through the shared owner-change relay: the primary passkey approves an owner
 * addition; afterwards the primary is unchanged and the new signer is one of the profile's devices. */
export function createWalletDeviceRelay(options: {
  pool: Pool; adapter: WalletRecoveryRelayAdapter; signer: ServerSigner;
  manifest: SmartAccountManifest; utility: ContractPin; maximumOperations: number; maximumCostWei: string;
}) {
  const source: WalletOwnerRelaySource<Record, WalletDeviceAddition, WalletDeviceApproval> = {
    kind: 'device',
    tables: { dispatch: 'rest_wallet_device_dispatch', transactions: 'rest_wallet_device_transactions', idColumn: 'device_id', activeColumn: 'active_device' },
    async load(id) {
      const value = (await options.pool.query<WalletDeviceRecord>('SELECT intent,candidate,proof,activation,session_id FROM rest_wallet_devices WHERE id=$1', [id])).rows[0];
      if (!value?.candidate || !value.proof) conflict(); assertWalletDeviceCandidate(value.candidate);
      if (!same(value.candidate.intent, value.intent) || value.proof.candidateDigest !== enrollmentDigest(value.candidate)
        || value.proof.intentDigest !== enrollmentDigest(value.intent) || value.proof.deviceId !== id) conflict();
      return value as Record;
    },
    current: (record, context) => enrollmentDigest(context.enrollment) === record.intent.enrollmentDigest
      && enrollmentDigest(context.credential) === record.intent.primaryCredentialDigest
      && context.binding.authorization.digest === record.intent.bindingDigest && !record.activation,
    devices: record => record.intent.existingSigners,
    candidate: record => record.candidate,
    expectedSigner: record => record.intent.primarySigner,
    changed: (record, profile) => (profile.devices ?? []).some(device => addressSame(device.address, record.candidate.signerAddress)
      && addressSame(device.x, record.candidate.credential.publicKey.x) && addressSame(device.y, record.candidate.credential.publicKey.y)),
    review: (record, state) => prepareWalletDeviceAddition(record.candidate, state),
    reviewId: review => review.deviceId,
    async verify(record, review, approval) {
      const input = approval as { assertion: WalletAssertion; primary: WalletDevicePrimary } | null;
      if (!input || typeof input !== 'object' || !input.assertion || !input.primary) conflict();
      const calls = verifyWalletDeviceAddition(record.candidate, review, input.assertion, input.primary);
      return { createSigner: calls.createSigner, ownerChange: calls.addOwner,
        record: { createSigner: calls.createSigner, addOwner: calls.addOwner, safeTxHash: calls.safeTxHash, proofDigest: calls.proofDigest, assertion: wire(input.assertion) } };
    },
    calls: approval => ({ createSigner: approval.createSigner, ownerChange: approval.addOwner }),
    async continuation(client: PoolClient, id, sessionId) {
      // The approving session is the one that began adding the device, and it is still live.
      const row = (await client.query<{ session_id: string }>('SELECT session_id FROM rest_wallet_devices WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row || typeof sessionId !== 'string' || row.session_id !== sessionId) conflict();
      const live = (await client.query('SELECT 1 FROM rest_wallet_logins WHERE session_id=$1 AND revoked_at_ms IS NULL AND session_expires_at_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint', [sessionId])).rowCount;
      if (!live) conflict();
    },
  };
  return createWalletOwnerRelay(options, source);
}
