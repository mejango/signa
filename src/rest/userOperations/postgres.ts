import type { Pool, PoolClient } from 'pg';
import type { Address, Hex } from 'viem';
import type { RestActor } from '../core.js';
import { assertRestActorActive } from '../auth/postgres.js';
import { assertActor, assertText } from '../transactions/store.js';
import { claimPostgresTransport } from '../transactions/transport-reservations.js';
import type { StoredPlan } from '../transactions/types.js';
import type { SmartAccountBinding } from '../smartAccounts/types.js';
import {
  assertUserOperationLifecyclePlan,
  assertUserOperationSession,
} from '../sessions/postgres.js';
import type { UserOperationObservation } from './types.js';
import {
  USER_OPERATION_LIMITS,
  assertClaim,
  assertLimit,
  assertNew,
  assertPlan,
  claimed,
  clone,
  conflict,
  defaultCodec,
  dispatchRecord,
  fail,
  key,
  missing,
  observed,
  assertRetiredChecked,
  owns,
  readCursor,
  retiring,
  same,
  settled,
  type UserOperationClaim,
  type UserOperationRecord,
  type UserOperationStore,
} from './store.js';

async function databaseNow(client: PoolClient): Promise<number> {
  const result = await client.query<{ now: string }>(
    'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now',
  );
  return Number(result.rows[0]!.now);
}
/** Account -> operation -> current session/plan -> global nonce, all inside one transaction. */
export class PostgresUserOperationStore implements UserOperationStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  private async required(client: PoolClient, id: string): Promise<UserOperationRecord> {
    assertText(id);
    const result = await client.query<{ document: UserOperationRecord }>(
      'SELECT document FROM rest_user_operations WHERE id=$1 FOR UPDATE',
      [id],
    );
    return result.rows[0] ? clone(result.rows[0].document) : missing();
  }
  private async save(
    client: PoolClient,
    record: UserOperationRecord,
  ): Promise<UserOperationRecord> {
    const copy = clone(record);
    await client.query(
      'UPDATE rest_user_operations SET document=$2::jsonb,revision=$3,submission_key=$4 WHERE id=$1',
      [copy.id, JSON.stringify(copy), copy.revision, copy.submission?.key ?? null],
    );
    return copy;
  }
  private async currentAuthority(
    client: PoolClient,
    record: UserOperationRecord,
    now: number,
  ): Promise<void> {
    const binding = await client.query<{ document: SmartAccountBinding }>(
      'SELECT document FROM rest_smart_account_bindings WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL',
      [record.actor.accountId, record.accountBindingId],
    );
    const current = binding.rows[0]?.document;
    if (
      !current ||
      current.wallet.chainId !== record.chainId ||
      !same(current.wallet.address, record.sender) ||
      !same(current.state.stateHash, record.accountStateHash) ||
      // Account binding certifies the exact owner/module configuration. Execution
      // verification belongs to this signed operation's canonical preflight.
      !current.state.moduleConfigurationVerified
    ) {
      fail(
        'USER_OPERATION_BINDING_STALE',
        'The current verified smart account binding changed or was revoked.',
        403,
      );
    }
    if (record.session)
      await assertUserOperationSession(
        client,
        record.actor,
        record.session,
        record.accountBindingId,
        record.chainId,
        record.sender,
        Math.floor(now / 1000),
      );
    const result = await client.query<{ document: StoredPlan }>(
      'SELECT document FROM rest_transaction_plans WHERE id=$1 AND account_id=$2 AND principal_id=$3 FOR UPDATE',
      [record.planId, record.actor.accountId, record.actor.principalId],
    );
    if (!result.rows[0]) missing();
    const plan = result.rows[0]!.document;
    assertPlan(record, plan, await databaseNow(client));
    await assertUserOperationLifecyclePlan(
      client,
      record.actor,
      plan,
      Math.floor((await databaseNow(client)) / 1000),
    );
  }
  async find(actor: RestActor, preparation: string, inputHash: Hex) {
    assertActor(actor);
    key(preparation);
    const result = await this.pool.query<{ document: UserOperationRecord }>(
      'SELECT document FROM rest_user_operations WHERE account_id=$1 AND principal_id=$2 AND preparation_key=$3',
      [actor.accountId, actor.principalId, preparation],
    );
    const record = result.rows[0]?.document;
    if (record && !same(record.inputHash, inputHash)) conflict();
    return record ? clone(record) : undefined;
  }
  async create(input: UserOperationRecord, now: number) {
    assertNew(input, now, defaultCodec);
    const record = clone(input);
    return this.transaction(async (client) => {
      // The account lock serialises competing preparations of one key (the second sees the
      // first's record). Then the replay lookup, the account's record count and the clock in one
      // round trip; the actor is asserted once on each path, at the end, so that no wait outlives
      // the authority.
      await client.query('SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE', [record.actor.accountId]);
      const read = (await client.query<{ document: UserOperationRecord | null; count: string; now: string }>(
        `SELECT (SELECT document FROM rest_user_operations WHERE account_id=$1 AND principal_id=$2 AND preparation_key=$3) AS document,
          (SELECT count(*) FROM rest_user_operations WHERE account_id=$1)::text AS count,
          floor(extract(epoch FROM clock_timestamp())*1000)::text AS now`,
        [record.actor.accountId, record.actor.principalId, record.preparationKey],
      )).rows[0]!;
      if (read.document) {
        if (!same(read.document.inputHash, record.inputHash)) conflict();
        await assertRestActorActive(client, record.actor, ['plan'], Math.floor(now / 1000));
        return clone(read.document);
      }
      const clock = Number(read.now);
      assertNew(record, clock, defaultCodec);
      await this.currentAuthority(client, record, clock);
      if (Number(read.count) >= USER_OPERATION_LIMITS.recordsPerAccount)
        fail('USER_OPERATION_STORAGE_LIMIT', 'Account UserOperation record capacity reached.', 429);
      assertNew(record, await databaseNow(client), defaultCodec);
      await client.query(
        'INSERT INTO rest_user_operations(id,account_id,principal_id,plan_id,preparation_key,created_at,revision,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
        [
          record.id,
          record.actor.accountId,
          record.actor.principalId,
          record.planId,
          record.preparationKey,
          record.createdAt,
          record.revision,
          JSON.stringify(record),
        ],
      );
      // Plan and insert waits must not outlive the authority that admitted this preparation.
      await assertRestActorActive(client, record.actor, ['plan'], Math.floor(now / 1000));
      return clone(record);
    });
  }
  async get(actor: RestActor, id: string) {
    assertActor(actor);
    assertText(id);
    const result = await this.pool.query<{ document: UserOperationRecord }>(
      'SELECT document FROM rest_user_operations WHERE id=$1 AND account_id=$2 AND (principal_id=$3 OR $4::boolean)',
      [id, actor.accountId, actor.principalId, actor.principalId === `owner:${actor.accountId}`],
    );
    return result.rows[0] ? clone(result.rows[0].document) : undefined;
  }
  async claim(input: UserOperationClaim) {
    assertClaim(input);
    input = clone(input);
    return this.transaction(async (client) => {
      await assertRestActorActive(client, input.actor, ['relay'], Math.floor(input.now / 1000));
      const record = await this.required(client, input.id);
      const duplicate = await client.query(
        'SELECT 1 FROM rest_user_operations WHERE account_id=$1 AND principal_id=$2 AND submission_key=$3 AND id<>$4',
        [input.actor.accountId, input.actor.principalId, input.key, input.id],
      );
      if (duplicate.rowCount) conflict();
      input.now = await databaseNow(client);
      const initial = claimed(record, input, defaultCodec);
      if (!initial.dispatch) return initial;
      // Serialized with a retirement of the same sender's other approvals by the sender's advisory lock.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`user-operation-sender:${record.chainId}:${record.sender.toLowerCase()}`]);
      assertRetiredChecked(record, input, await this.retiredIn(client, record.chainId, record.sender));
      await this.currentAuthority(client, dispatchRecord(record, input), input.now);
      await claimPostgresTransport(client, record.planId, record.stepIndexes, 'erc4337', record.id);
      const nonce = BigInt(record.operation.nonce).toString();
      await client.query(
        'INSERT INTO rest_user_operation_nonces(chain_id,sender,nonce,entry_point,operation_hash,signed_commitment,user_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(chain_id,sender,nonce) DO NOTHING',
        [
          record.chainId,
          record.sender.toLowerCase(),
          nonce,
          record.entryPoint.toLowerCase(),
          record.operationHash.toLowerCase(),
          input.signedCommitment.toLowerCase(),
          record.id,
        ],
      );
      const reserved = await client.query<{
        user_operation_id: string;
        signed_commitment: string;
        operation_hash: string;
        entry_point: string;
      }>(
        'SELECT user_operation_id,signed_commitment,operation_hash,entry_point FROM rest_user_operation_nonces WHERE chain_id=$1 AND sender=$2 AND nonce=$3 FOR UPDATE',
        [record.chainId, record.sender.toLowerCase(), nonce],
      );
      const row = reserved.rows[0];
      if (
        !row ||
        row.user_operation_id !== record.id ||
        !same(row.signed_commitment, input.signedCommitment) ||
        !same(row.operation_hash, record.operationHash) ||
        !same(row.entry_point, record.entryPoint)
      )
        fail(
          'USER_OPERATION_NONCE_CONFLICT',
          'The full sender nonce is permanently reserved by another UserOperation.',
        );
      // Recheck the database clock, current grant, binding and session AFTER every possible wait.
      await assertRestActorActive(client, input.actor, ['relay'], Math.floor(input.now / 1000));
      await this.currentAuthority(client, dispatchRecord(record, input), await databaseNow(client));
      input.now = await databaseNow(client);
      const result = claimed(record, input, defaultCodec);
      result.record = await this.save(client, result.record);
      return result;
    });
  }
  async settle(id: string, commitment: Hex, state: 'pending' | 'submission_unknown') {
    return this.transaction(async (client) =>
      this.save(client, settled(await this.required(client, id), commitment, state)),
    );
  }
  async observe(id: string, revision: number, observation: UserOperationObservation) {
    observation = clone(observation);
    return this.transaction(async (client) => {
      const next = observed(await this.required(client, id), revision, observation);
      // Proven never to execute: the nonce it held is free for a fresh operation. Its plan steps
      // stay claimed; a redo is a new plan, and the step settles as failed on its own.
      if (next.state === 'expired')
        await client.query('DELETE FROM rest_user_operation_nonces WHERE user_operation_id=$1', [next.id]);
      return this.save(client, next);
    });
  }
  async retire(actor: RestActor, id: string) {
    assertActor(actor);
    return this.transaction(async (client) => {
      // The claim's own row lock: whichever of the two commits first, the other sees it.
      const record = await this.required(client, id);
      if (!owns(record, actor)) missing();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`user-operation-sender:${record.chainId}:${record.sender.toLowerCase()}`]);
      const next = retiring(record);
      return next.revision === record.revision ? next : this.save(client, next);
    });
  }
  private async retiredIn(client: Pick<PoolClient, 'query'>, chainId: number, sender: Address) {
    // Across every API account: one Safe can be bound under several, and its nonce is the chain's.
    const result = await client.query<{ document: UserOperationRecord }>(
      `SELECT document FROM rest_user_operations WHERE document->>'state'='retired' AND NOT document ? 'retiredSettledAt'
       AND (document->>'chainId')::bigint=$1 AND lower(document->>'sender')=$2`,
      [chainId, sender.toLowerCase()],
    );
    return result.rows.map((row) => clone(row.document));
  }
  async retired(chainId: number, sender: Address) {
    return this.retiredIn(this.pool, chainId, sender);
  }
  async settleRetired(id: string) {
    await this.transaction(async (client) => {
      const record = await this.required(client, id);
      if (record.state !== 'retired' || record.retiredSettledAt !== undefined) return;
      await this.save(client, { ...record, retiredSettledAt: await databaseNow(client), revision: record.revision + 1 });
    });
  }
  async nonceHolder(chainId: number, sender: Address, nonce: bigint) {
    const result = await this.pool.query<{ document: UserOperationRecord }>(
      `SELECT o.document FROM rest_user_operation_nonces n JOIN rest_user_operations o ON o.id=n.user_operation_id
       WHERE n.chain_id=$1 AND n.sender=$2 AND n.nonce=$3`,
      [chainId, sender.toLowerCase(), nonce.toString()],
    );
    return result.rows[0] ? clone(result.rows[0].document) : undefined;
  }
  async recoverable(limit: number, cursor?: string) {
    assertLimit(limit);
    const after = readCursor(cursor);
    const result = await this.pool.query<{ document: UserOperationRecord }>(
      `SELECT document FROM rest_user_operations WHERE document ? 'submission'
       AND document->>'state' IN ('submitting','submission_unknown','pending','unknown','confirming')
       AND ($1::bigint IS NULL OR created_at>$1 OR (created_at=$1 AND id COLLATE "C">$2 COLLATE "C"))
       ORDER BY created_at,id COLLATE "C" LIMIT $3`,
      [after?.createdAt ?? null, after?.id ?? null, limit],
    );
    return result.rows.map((row) => clone(row.document));
  }
}
