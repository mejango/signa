import type { Pool, PoolClient } from 'pg';
import type { Hex } from 'viem';
import type { ServerSigner } from '../signer.js';
import type { ContractPin, SmartAccountManifest } from '../smartAccounts/types.js';
import { RestError } from '../core.js';
import { stable } from '../smartAccounts/service.js';
import { enrollmentDigest } from './enrollment.js';
import { assertWalletRecoveryCandidate, type WalletRecoveryCandidate } from './recovery.js';
import { prepareWalletRecoveryRotation, verifyWalletRecoveryRotation, type WalletRecoveryRotation } from './recoveryRotation.js';
import type { WalletRecoveryRecord } from './recoveryPostgres.js';
import { assertRecoveryContinuationInTransaction } from './recoveryFlowPostgres.js';
import { createWalletOwnerRelay, type LocalWalletOwnerStatus, type WalletOwnerRelaySource } from './ownerRelay.js';
export type { WalletRecoveryFeeQuote, WalletRecoveryReceiptFees, WalletRecoveryRelayAdapter } from './ownerRelay.js';
import type { WalletRecoveryRelayAdapter } from './ownerRelay.js';

export interface LocalWalletRecoveryStatus {
  recoveryId: string; state: 'review' | 'unknown' | 'failed' | 'ready';
  transactions: { createSigner: Hex | null; rotateOwner: Hex | null }; reason: string | null;
}
type Record = WalletRecoveryRecord & { candidate: WalletRecoveryCandidate };
type Approval = Awaited<ReturnType<typeof verifyWalletRecoveryRotation>> & { backupSignature: Hex };
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const addressSame = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const legacy = (status: LocalWalletOwnerStatus): LocalWalletRecoveryStatus => ({ recoveryId: status.id, state: status.state,
  transactions: { createSigner: status.transactions.createSigner, rotateOwner: status.transactions.ownerChange }, reason: status.reason });

/** Recovery replaces the primary passkey's signer through the shared owner-change relay: the
 * backup owner approves a swap, the new signer must then be the profile's primary signer. */
export function createWalletRecoveryRelay(options: {
  pool: Pool; adapter: WalletRecoveryRelayAdapter; signer: ServerSigner;
  manifest: SmartAccountManifest; utility: ContractPin; maximumOperations: number; maximumCostWei: string;
}) {
  const source: WalletOwnerRelaySource<Record, WalletRecoveryRotation, Approval> = {
    kind: 'recovery',
    tables: { dispatch: 'rest_wallet_recovery_dispatch', transactions: 'rest_wallet_recovery_transactions', idColumn: 'recovery_id', activeColumn: 'active_recovery' },
    async load(id) {
      const value = (await options.pool.query<WalletRecoveryRecord>('SELECT intent,candidate,proof,activation FROM rest_wallet_recoveries WHERE id=$1', [id])).rows[0];
      if (!value?.candidate || !value.proof) conflict(); assertWalletRecoveryCandidate(value.candidate);
      if (!same(value.candidate.intent, value.intent) || value.proof.candidateDigest !== enrollmentDigest(value.candidate)
        || value.proof.intentDigest !== enrollmentDigest(value.intent) || value.proof.recoveryId !== id) conflict();
      return value as Record;
    },
    current: (record, context) => enrollmentDigest(context.enrollment) === record.intent.enrollmentDigest
      && enrollmentDigest(context.credential) === record.intent.priorCredentialDigest
      && context.binding.authorization.digest === record.intent.priorBindingDigest && !record.activation,
    devices: (_record, context) => (context.devices ?? []).map(entry => entry.device.signerAddress),
    candidate: record => record.candidate,
    expectedSigner: (record, after) => after ? record.candidate.signerAddress : record.intent.priorSigner,
    changed: (record, profile) => addressSame(profile.signer.x, record.candidate.credential.publicKey.x) && addressSame(profile.signer.y, record.candidate.credential.publicKey.y),
    review: (record, state) => prepareWalletRecoveryRotation(record.candidate, state),
    reviewId: review => review.recoveryId,
    async verify(record, review, approval) {
      if (typeof approval !== 'string') conflict();
      const approved = await verifyWalletRecoveryRotation(record.candidate, review, approval as Hex);
      return { createSigner: approved.createSigner, ownerChange: approved.rotateOwner, record: { ...approved, backupSignature: approval as Hex } };
    },
    calls: approval => ({ createSigner: approval.createSigner, ownerChange: approval.rotateOwner }),
    async continuation(client: PoolClient, id, flowToken) {
      const recovery = (await client.query<{ id: string; token_hash: string }>('SELECT id,token_hash FROM rest_wallet_recoveries WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
      // Browser continuations are rechecked under the same recovery→flow lock order as token
      // rotation. Host-only fixtures have no browser flow to authorize.
      if (flowToken !== undefined) await assertRecoveryContinuationInTransaction(client, recovery, flowToken as string);
      else if ((await client.query('SELECT 1 FROM rest_wallet_recovery_flows WHERE id=$1', [id])).rowCount) conflict();
    },
  };
  const relay = createWalletOwnerRelay(options, source);
  return {
    prepare: (id: string) => relay.prepare(id),
    approve: async (id: string, input: WalletRecoveryRotation, backupSignature: Hex, flowToken?: string) => legacy(await relay.approve(id, input, backupSignature, flowToken)),
    status: async (id: string, waitMs = 0) => legacy(await relay.status(id, waitMs)),
    tick: (signal?: AbortSignal) => relay.tick(signal),
  };
}
function conflict(): never { throw new RestError(409, 'WALLET_RECOVERY_DISPATCH_CONFLICT', 'The reviewed recovery or relay state changed.'); }
