import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/postgres.js';
import { PostgresAccountStore, assertRestActorActive } from '../src/rest/auth/postgres.js';
import type { Account, BotGrant } from '../src/rest/auth/store.js';
import type { RestActor } from '../src/rest/core.js';
import { PostgresTransactionStore } from '../src/rest/transactions/postgres.js';
import { encodeCursor } from '../src/rest/transactions/store.js';
import { claimPostgresTransport } from '../src/rest/transactions/transport-reservations.js';
import type {
  ExternalStepObservation,
  SignedAttempt,
  StoredPlan,
  StoredReceipt,
  SubmissionClaim,
} from '../src/rest/transactions/types.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_transactions_test_${randomUUID().replaceAll('-', '')}`;
const admin = connectionString ? createPool(connectionString) : null;
let pool: Pool;
let accounts: PostgresAccountStore;
let store: PostgresTransactionStore;
// Public fixture key; transactions are encoded and persisted, never broadcast.
const wallet = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const target = '0x2222222222222222222222222222222222222222' as Address;
const now = Math.floor(Date.now() / 1_000) * 1_000;
const account: Account = {
  id: `eip155:1:${wallet.address.toLowerCase()}`,
  ownerAddress: wallet.address,
  authorityChainId: 1,
  profile: { displayName: '', bio: '', avatarUri: null },
  createdAt: now / 1_000,
  updatedAt: now / 1_000,
};
const owner: RestActor = { accountId: account.id, principalId: `owner:${account.id}` };
const grant = (id: string): BotGrant => ({
  id,
  accountId: account.id,
  botAddress: target,
  scopes: ['read', 'plan', 'relay'],
  label: '',
  createdAt: now / 1_000,
  expiresAt: now / 1_000 + 1_000,
  revokedAt: null,
});
const idem = (key: string, operation = 'prepare', requestHash = `hash:${key}`) => ({
  key,
  operation,
  requestHash,
});
const plan = (id: string, actor = owner): StoredPlan => ({
  id,
  actor,
  commitment: `0x${'ab'.repeat(32)}`,
  createdAt: now,
  expiresAt: now + 60_000,
  revision: 0,
  draft: {
    operation: 'fixture',
    account: wallet.address,
    calls: [
      {
        chainId: 1,
        to: target,
        data: '0x',
        value: '1',
        label: 'Fixture',
        dependsOn: [],
        decoded: {},
      },
    ],
    evidence: [],
    summary: {},
    warnings: [],
  },
  steps: [{ index: 0, state: 'waiting' }],
});
async function attempt(nonce: number): Promise<SignedAttempt> {
  const rawTransaction = await wallet.signTransaction({
    chainId: 1,
    type: 'eip1559',
    nonce,
    gas: 21_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    to: target,
    value: 1n,
  });
  return {
    hash: keccak256(rawTransaction),
    rawTransaction,
    sender: wallet.address,
    chainId: 1,
    nonce: String(nonce),
    type: 'eip1559',
    gas: '21000',
    maximumFeePerGas: '2',
    maximumCost: '42001',
    reservedAt: now,
    leaseToken: 'lease-1',
    leaseUntil: now + 10_000,
    dispatchCount: 1,
  };
}
const claim = (
  id: string,
  signed: SignedAttempt,
  overrides: Partial<SubmissionClaim> = {},
): SubmissionClaim => ({
  actor: owner,
  planId: id,
  stepIndex: 0,
  expectedRevision: 0,
  attempt: signed,
  idempotency: idem(`submit:${id}`, 'submit'),
  now,
  dispatch: true,
  ...overrides,
});

async function seedSponsoredBinding(
  value: StoredPlan,
  indexes: readonly number[],
  bindingId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertRestActorActive(client, value.actor, ['relay'], now / 1_000);
    await claimPostgresTransport(client, value.id, indexes, 'relayr', bindingId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const externalHash = (byte: string): Hex => `0x${byte.repeat(32)}`;
const externalReceipt = (
  transactionHash: Hex,
  overrides: Partial<StoredReceipt> = {},
): StoredReceipt => ({
  transactionHash,
  blockHash: externalHash('cd'),
  blockNumber: '100',
  status: 'success',
  confirmations: 2,
  canonical: true,
  observedAt: now,
  logs: [],
  ...overrides,
});
const confirmedExternal = (index = 0, hash = externalHash('ee')): ExternalStepObservation => ({
  index,
  state: 'confirmed',
  transactionHash: hash,
  receipt: externalReceipt(hash),
  semantic: { status: 'verified' },
});

function multiStepPlan(id: string, actor = owner): StoredPlan {
  const value = plan(id, actor);
  value.draft.calls.push({ ...value.draft.calls[0]!, dependsOn: [0] });
  value.steps.push({ index: 1, state: 'waiting' });
  return value;
}

async function databaseSeconds(client: Pool | PoolClient): Promise<number> {
  const result = await client.query<{ now: string }>(
    'SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now',
  );
  return Number(result.rows[0]!.now);
}

async function waitForDatabaseLock(lock: PoolClient, backendPid: number, statement: RegExp): Promise<void> {
  const deadline = performance.now() + 500;
  for (;;) {
    await lock.query('SELECT pg_stat_clear_snapshot()');
    const blocked = await lock.query<{ query: string }>(
      'SELECT query FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))',
      [backendPid],
    );
    // Keep polling until activity text and the live blocker identify the same stage.
    if (blocked.rows.some((row) => statement.test(row.query))) return;
    if (performance.now() >= deadline)
      throw new Error('Submission did not wait for its fixture lock.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForDatabaseExpiry(lock: PoolClient, expiresAt: number): Promise<void> {
  // At most one second: use PostgreSQL's wall clock, not the test process clock.
  await lock.query(
    'SELECT pg_sleep(GREATEST(0, $1::double precision - extract(epoch FROM clock_timestamp())::double precision + 0.005))',
    [expiresAt],
  );
  expect(await databaseSeconds(lock)).toBeGreaterThanOrEqual(expiresAt);
}

async function expectUnreservedSubmission(value: StoredPlan, signed: SignedAttempt): Promise<void> {
  expect(await store.get(value.actor, value.id)).toEqual(value);
  expect(
    await store.findIdempotentPlan(value.actor, idem(`submit:${value.id}`, 'submit')),
  ).toBeUndefined();
  expect(
    (await pool.query('SELECT 1 FROM rest_transaction_transports WHERE plan_id = $1', [value.id]))
      .rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        'SELECT 1 FROM rest_transaction_nonces WHERE chain_id = $1 AND sender = $2 AND nonce = $3',
        [signed.chainId, signed.sender.toLowerCase(), signed.nonce],
      )
    ).rowCount,
  ).toBe(0);
}

suite('PostgreSQL transaction persistence', () => {
  beforeAll(async () => {
    await admin!.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrate(pool);
    accounts = new PostgresAccountStore(pool);
    store = new PostgresTransactionStore(pool);
    await accounts.enroll(account, {
      accountId: account.id,
      signer: wallet.address,
      grantId: null,
      nonce: `0x${'01'.repeat(32)}`,
      issuedAt: now / 1_000,
      expiresAt: now / 1_000 + 60,
      idempotencyKey: null,
      requiredScopes: [],
      ownerOnly: true,
      now: now / 1_000,
    });
  });
  afterAll(async () => {
    await pool?.end();
    await admin!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin!.end();
  });


  it('deduplicates preparation across replicas and reads the durable result after reconstruction', async () => {
    const copies = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        new PostgresTransactionStore(pool).create(
          plan(`copy-${index}`),
          idem('prepare-concurrent'),
          now,
        ),
      ),
    );
    expect(new Set(copies.map((value) => value.id)).size).toBe(1);
    const fresh = new PostgresTransactionStore(pool);
    expect(await fresh.findIdempotentPlan(owner, idem('prepare-concurrent'))).toEqual(copies[0]);
    await expect(
      fresh.findIdempotentPlan(owner, idem('prepare-concurrent', 'prepare', 'changed')),
    ).rejects.toMatchObject({ status: 409 });
    expect((await fresh.list(owner, { limit: 1 })).items).toHaveLength(1);
  });

  it('admits one competing dispatch, retains raw bytes on restart, and uses token CAS for stale replies', async () => {
    await store.create(plan('leases'), idem('leases'), now);
    const signed = await attempt(1);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        new PostgresTransactionStore(pool).claimSubmission(claim('leases', signed)),
      ),
    );
    expect(outcomes.filter((value) => value.dispatch)).toHaveLength(1);
    const fresh = new PostgresTransactionStore(pool);
    expect((await fresh.get(owner, 'leases'))!.steps[0]!.attempt!.rawTransaction).toBe(
      signed.rawTransaction,
    );
    expect((await fresh.recoverable(100)).some((value) => value.id === 'leases')).toBe(true);
    const skewed = await fresh.claimSubmission(
      claim(
        'leases',
        { ...signed, leaseToken: 'skewed', leaseUntil: now + 3_630_000 },
        {
          now: now + 3_600_000,
          expectedRevision: 1,
        },
      ),
    );
    expect(skewed.dispatch).toBe(false);
    // Expire only this test fixture's lease using SQL; advancing an app clock must not do it.
    await pool.query(
      "UPDATE rest_transaction_plans SET document = jsonb_set(document, '{steps,0,attempt,leaseUntil}', '0'::jsonb) WHERE id = 'leases'",
    );
    const renewed = await fresh.claimSubmission(
      claim(
        'leases',
        { ...signed, leaseToken: 'lease-2', leaseUntil: now + 30_000 },
        { now: now + 11_000, expectedRevision: 1 },
      ),
    );
    expect(renewed.dispatch).toBe(true);
    expect(renewed.plan.steps[0]!.attempt!.leaseUntil).toBeLessThan(Date.now() + 20_000);
    const stale = await fresh.settleSubmission(owner, 'leases', 0, 'lease-1', { state: 'unknown' });
    expect(stale.revision).toBe(renewed.plan.revision);
    expect(stale.steps[0]!.attempt!.leaseToken).toBe('lease-2');
    const updates = await Promise.allSettled(
      Array.from({ length: 5 }, () => fresh.save(owner, 'leases', stale.revision, stale.steps)),
    );
    expect(updates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('enforces global nonce reservations and rolls back conflicting claims completely', async () => {
    const botGrant = grant('nonce-bot');
    await accounts.registerBot(botGrant);
    const bot: RestActor = { accountId: account.id, principalId: `bot:${botGrant.id}` };
    await store.create(plan('nonce-owner'), idem('nonce-owner'), now);
    await store.create(plan('nonce-bot', bot), idem('nonce-bot'), now);
    const signed = await attempt(2);
    const competing = await Promise.allSettled([
      store.claimSubmission(claim('nonce-owner', signed)),
      store.claimSubmission(claim('nonce-bot', signed, { actor: bot })),
    ]);
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const values = await Promise.all([
      store.get(owner, 'nonce-owner'),
      store.get(bot, 'nonce-bot'),
    ]);
    expect(values.filter((value) => value!.steps[0]!.attempt)).toHaveLength(1);
    const loser = values.find((value) => !value!.steps[0]!.attempt)!;
    expect(loser!.revision).toBe(0);
    const transport = await pool.query(
      'SELECT 1 FROM rest_transaction_transports WHERE plan_id = $1',
      [loser!.id],
    );
    expect(transport.rowCount).toBe(0);
    expect(
      await store.findIdempotentPlan(loser!.actor, idem(`submit:${loser!.id}`, 'submit')),
    ).toBeUndefined();
    const counts = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM rest_transaction_nonces WHERE nonce = 2',
    );
    expect(counts.rows[0]!.count).toBe('1');
  });

  it('linearizes revocation with claims using the same account row lock', async () => {
    const botGrant = grant('revoked-bot');
    await accounts.registerBot(botGrant);
    const bot: RestActor = { accountId: account.id, principalId: `bot:${botGrant.id}` };
    await store.create(plan('revoked-plan', bot), idem('revoked-plan'), now);
    const lock = await pool.connect();
    const signed = await attempt(3);
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM rest_accounts WHERE id = $1 FOR UPDATE', [account.id]);
      const pending = store.claimSubmission(claim('revoked-plan', signed, { actor: bot }));
      // Revoke under the acquired account lock before releasing the competing claim.
      await lock.query(
        'UPDATE rest_bot_grants SET revoked_at = floor(extract(epoch FROM clock_timestamp())) WHERE id = $1',
        [botGrant.id],
      );
      await lock.query('COMMIT');
      await expect(pending).rejects.toMatchObject({ status: 403 });
      expect((await store.get(bot, 'revoked-plan'))!.steps[0]!.attempt).toBeUndefined();
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('rejects request authorization that expires behind the account lock without leaving reservations', async () => {
    const value = plan('authorization-account-lock');
    await store.create(value, idem(value.id), now);
    const signed = await attempt(40);
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM rest_accounts WHERE id = $1 FOR UPDATE', [account.id]);
      const pid = await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const issuedAt = await databaseSeconds(lock);
      const authorization = { issuedAt, expiresAt: issuedAt + 1 };
      const pending = store.claimSubmission(claim(value.id, signed, { authorization })).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await waitForDatabaseLock(lock, pid.rows[0]!.pid, /FROM rest_accounts.*FOR UPDATE/);
      await waitForDatabaseExpiry(lock, authorization.expiresAt);
      await lock.query('COMMIT');
      expect(await pending).toMatchObject({ error: { status: 401, code: 'AUTH_EXPIRED' } });
      await expectUnreservedSubmission(value, signed);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('rechecks request authorization after nonce I/O and atomically rolls back the entire claim', async () => {
    const value = plan('authorization-nonce-lock');
    await store.create(value, idem(value.id), now);
    const blockerPlan = plan('authorization-nonce-fixture');
    await store.create(blockerPlan, idem(blockerPlan.id), now);
    const signed = await attempt(41);
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      // This uncommitted duplicate blocks only the nonce insertion, after the first auth check.
      await lock.query(
        'INSERT INTO rest_transaction_nonces (chain_id, sender, nonce, transaction_hash, plan_id, step_index) VALUES ($1,$2,$3,$4,$5,0)',
        [signed.chainId, signed.sender.toLowerCase(), signed.nonce, signed.hash, blockerPlan.id],
      );
      const pid = await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const issuedAt = await databaseSeconds(lock);
      const authorization = { issuedAt, expiresAt: issuedAt + 1 };
      const pending = store.claimSubmission(claim(value.id, signed, { authorization })).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await waitForDatabaseLock(lock, pid.rows[0]!.pid, /^INSERT INTO rest_transaction_nonces/);
      await waitForDatabaseExpiry(lock, authorization.expiresAt);
      // Remove the fixture nonce; the claimant can insert it, then must undo its own writes.
      await lock.query('ROLLBACK');
      expect(await pending).toMatchObject({ error: { status: 401, code: 'AUTH_EXPIRED' } });
      await expectUnreservedSubmission(value, signed);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('admits fresh authorization while expired replays cannot acquire a new dispatch lease', async () => {
    const value = plan('authorization-replay');
    await store.create(value, idem(value.id), now);
    const signed = await attempt(42);
    const issuedAt = await databaseSeconds(pool);
    const authorization = { issuedAt, expiresAt: issuedAt + 60 };
    const admitted = await store.claimSubmission(claim(value.id, signed, { authorization }));
    expect(admitted.dispatch).toBe(true);
    const expired = { issuedAt: issuedAt - 2, expiresAt: issuedAt - 1 };
    const replay = await store.claimSubmission(
      claim(value.id, signed, {
        authorization: expired,
        expectedRevision: admitted.plan.revision,
      }),
    );
    expect(replay).toEqual({ plan: admitted.plan, dispatch: false });
    await pool.query(
      "UPDATE rest_transaction_plans SET document = jsonb_set(document, '{steps,0,attempt,leaseUntil}', '0'::jsonb) WHERE id = $1",
      [value.id],
    );
    const beforeRenewal = (await store.get(owner, value.id))!;
    await expect(
      store.claimSubmission(
        claim(
          value.id,
          {
            ...signed,
            leaseToken: 'authorization-renewed',
          },
          {
            authorization: expired,
            expectedRevision: beforeRenewal.revision,
          },
        ),
      ),
    ).rejects.toMatchObject({ status: 401, code: 'AUTH_EXPIRED' });
    expect(await store.get(owner, value.id)).toEqual(beforeRenewal);
    const monitor = await store.claimSubmission(
      claim(value.id, signed, {
        authorization: expired,
        expectedRevision: beforeRenewal.revision,
        dispatch: false,
      }),
    );
    expect(monitor).toEqual({ plan: beforeRenewal, dispatch: false });
    const renewed = await store.claimSubmission(
      claim(
        value.id,
        {
          ...signed,
          leaseToken: 'authorization-renewed',
        },
        {
          authorization,
          expectedRevision: beforeRenewal.revision,
        },
      ),
    );
    expect(renewed.dispatch).toBe(true);
    expect(renewed.plan.steps[0]!.attempt!.dispatchCount).toBe(2);
  });

  it('lets owners inspect bot plans without borrowing bot mutation authority or idempotency namespace', async () => {
    const bot: RestActor = { accountId: account.id, principalId: 'bot:nonce-bot' };
    expect((await store.get(owner, 'nonce-bot'))!.actor).toEqual(bot);
    expect(
      (await store.list(owner, { limit: 100, account: wallet.address })).items.some(
        (value) => value.id === 'nonce-bot',
      ),
    ).toBe(true);
    expect(await store.get(bot, 'nonce-owner')).toBeUndefined();
    expect(await store.findIdempotentPlan(owner, idem('nonce-bot'))).toBeUndefined();
    await expect(store.claimSubmission(claim('nonce-bot', await attempt(4)))).rejects.toMatchObject(
      { status: 404 },
    );
  });

  it('supports exact cursor continuation and monitor-only reservations', async () => {
    await store.create(plan('monitor'), idem('monitor'), now);
    const signed = await attempt(5);
    const monitored = await store.claimSubmission(
      claim('monitor', { ...signed, leaseUntil: 0, dispatchCount: 0 }, { dispatch: false }),
    );
    expect(monitored.dispatch).toBe(false);
    expect(monitored.plan.steps[0]!.attempt!.dispatchCount).toBe(0);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list(owner, { limit: 2, ...(cursor ? { cursor } : {}) });
      ids.push(...page.items.map((value) => value.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('monitor');
  });

  it('preserves a fresh plan stamped by a faster app clock without changing its committed expiry', async () => {
    const databaseNow = (await databaseSeconds(pool)) * 1000;
    const appNow = databaseNow + 10_000;
    const value = { ...plan('clock-ahead'), createdAt: appNow, expiresAt: appNow + 60_000 };
    expect(await store.create(value, idem('clock-ahead'), appNow)).toEqual(value);
    expect(await store.get(owner, value.id)).toEqual(value);
    expect(await store.findIdempotentPlan(owner, idem('clock-ahead'))).toEqual(value);
    await expect(store.create({ ...value, id: 'clock-invalid', createdAt: appNow + 1 }, idem('clock-invalid'), appNow))
      .rejects.toMatchObject({ status: 400 });
    expect(await store.findIdempotentPlan(owner, idem('clock-invalid'))).toBeUndefined();
  });

  it('uses database time to reject preparation that only appears unexpired on a slow replica', async () => {
    const expired = { ...plan('clock-expired'), createdAt: now - 120_000, expiresAt: now - 30_000 };
    await expect(store.create(expired, idem('clock-expired'), now - 60_000)).rejects.toMatchObject({
      status: 400,
    });
    expect(await store.get(owner, 'clock-expired')).toBeUndefined();
    expect(await store.findIdempotentPlan(owner, idem('clock-expired'))).toBeUndefined();
  });

  it.each(['direct', 'relayr'] as const)('recovers confirmed %s calls with unresolved semantic outcomes after restart', async (transport) => {
    const value = await store.create(plan(`semantic-recovery:${transport}`), idem(`semantic-recovery:${transport}`), now);
    let current: StoredPlan;
    if (transport === 'direct') {
      current = (await store.claimSubmission(claim(value.id, await attempt(20_001)))).plan;
    } else {
      await seedSponsoredBinding(value, [0], 'semantic-recovery-binding');
      current = await store.syncExternalExecutions(owner, value.id);
    }
    for (const status of [undefined, 'unknown', 'verified', 'unmodeled', 'failed'] as const) {
      const semantic = status === undefined ? {} : { semantic: { status } };
      if (transport === 'direct') {
        const { semantic: _previous, ...step } = current.steps[0]!;
        current = await store.save(owner, value.id, current.revision, [{
          ...step, state: 'confirmed', receipt: externalReceipt(step.attempt!.hash), ...semantic,
        }]);
      } else {
        const { semantic: _previous, ...observation } = confirmedExternal();
        current = await store.saveExternalExecution(owner, value.id, current.revision,
          'semantic-recovery-binding', [{ ...observation, ...semantic }]);
      }
      const recovered = await new PostgresTransactionStore(pool).recoverable(1_000);
      expect(recovered.some((entry) => entry.id === value.id)).toBe(status === undefined || status === 'unknown');
    }
  });

  it('continues recovery past unchanged oldest records without mutating their observations', async () => {
    const expected = await store.recoverable(100);
    expect(expected.length).toBeGreaterThan(1);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await store.recoverable(1, cursor);
      if (!page.length) break;
      seen.push(page[0]!.id);
      cursor = encodeCursor(page[0]!);
    }
    expect(seen).toEqual(expected.map((value) => value.id));
    expect(await store.recoverable(100)).toEqual(expected);
  });

  it('admits exactly one transport for racing direct and sponsored claims across database clients', async () => {
    await store.create(plan('transport-race'), idem('transport-race'), now);
    const signed = await attempt(10);
    const sponsorship = async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await assertRestActorActive(client, owner, ['relay'], now / 1_000);
        await claimPostgresTransport(
          client,
          'transport-race',
          [0],
          'relayr',
          'sponsorship-preparation',
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const outcomes = await Promise.allSettled([
      sponsorship(),
      new PostgresTransactionStore(pool).claimSubmission(claim('transport-race', signed)),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409, code: 'TRANSPORT_CONFLICT' },
    });
    const rows = await pool.query<{ transport: string; binding_id: string }>(
      'SELECT transport, binding_id FROM rest_transaction_transports WHERE plan_id = $1',
      ['transport-race'],
    );
    expect(rows.rows).toHaveLength(1);
    const current = (await store.get(owner, 'transport-race'))!;
    expect(current.revision).toBe(rows.rows[0]!.transport === 'direct' ? 1 : 0);
    if (rows.rows[0]!.transport === 'relayr') {
      expect(
        await store.findIdempotentPlan(owner, idem('submit:transport-race', 'submit')),
      ).toBeUndefined();
      const nonce = await pool.query('SELECT 1 FROM rest_transaction_nonces WHERE nonce = 10');
      expect(nonce.rowCount).toBe(0);
    }
  });

  it('rolls back every insertion in a conflicting multi-step transport claim even when caught', async () => {
    const twoStep = plan('transport-atomic');
    twoStep.draft.calls.push({ ...twoStep.draft.calls[0]!, dependsOn: [0] });
    twoStep.steps.push({ index: 1, state: 'waiting' });
    await store.create(twoStep, idem('transport-atomic'), now);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertRestActorActive(client, owner, ['relay'], now / 1_000);
      await claimPostgresTransport(client, twoStep.id, [1], 'relayr', 'existing');
      await expect(
        claimPostgresTransport(client, twoStep.id, [0, 1], 'direct', `0x${'ab'.repeat(32)}`),
      ).rejects.toMatchObject({ code: 'TRANSPORT_CONFLICT' });
      await claimPostgresTransport(client, twoStep.id, [0], 'relayr', 'other');
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const rows = await pool.query<{ step_index: number; transport: string; binding_id: string }>(
      'SELECT step_index, transport, binding_id FROM rest_transaction_transports WHERE plan_id = $1 ORDER BY step_index',
      [twoStep.id],
    );
    expect(rows.rows).toEqual([
      { step_index: 0, transport: 'relayr', binding_id: 'other' },
      { step_index: 1, transport: 'relayr', binding_id: 'existing' },
    ]);
  });

  it('attaches only existing exact sponsored bindings without creating or partially tagging claims', async () => {
    const value = multiStepPlan('external-existing');
    value.draft.calls[1]!.chainId = 8453;
    await store.create(value, idem(value.id), now);
    await expect(
      store.reserveExternalExecution(owner, value.id, [0], 'missing-binding'),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await pool.query('SELECT 1 FROM rest_transaction_transports WHERE plan_id = $1', [value.id]))
        .rowCount,
    ).toBe(0);
    await seedSponsoredBinding(value, [0], 'first-binding');
    await seedSponsoredBinding(value, [1], 'second-binding');
    await expect(
      store.reserveExternalExecution(owner, value.id, [0, 1], 'first-binding'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.get(owner, value.id)).toEqual(value);
    const tagged = await store.reserveExternalExecution(owner, value.id, [1], 'second-binding');
    expect(tagged.steps).toEqual([
      { index: 0, state: 'waiting' },
      {
        index: 1,
        state: 'reserved',
        externalExecution: { transport: 'relayr', bindingId: 'second-binding', chainId: 8453 },
      },
    ]);
    expect(await store.reserveExternalExecution(owner, value.id, [1], 'second-binding')).toEqual(
      tagged,
    );
    const rows = await pool.query<{ step_index: number; binding_id: string }>(
      'SELECT step_index, binding_id FROM rest_transaction_transports WHERE plan_id = $1 ORDER BY step_index',
      [value.id],
    );
    expect(rows.rows).toEqual([
      { step_index: 0, binding_id: 'first-binding' },
      { step_index: 1, binding_id: 'second-binding' },
    ]);
  });

  it('keeps external mutation authority scoped to the original principal after revocation', async () => {
    const ownGrant = grant('external-observer');
    const otherGrant = grant('external-other');
    await accounts.registerBot(ownGrant);
    await accounts.registerBot(otherGrant);
    const bot: RestActor = { accountId: account.id, principalId: `bot:${ownGrant.id}` };
    const other: RestActor = { accountId: account.id, principalId: `bot:${otherGrant.id}` };
    const value = plan('external-scope', bot);
    await store.create(value, idem(value.id), now);
    await seedSponsoredBinding(value, [0], 'scope-binding');
    await accounts.revokeBot(account.id, ownGrant.id, now / 1_000);
    for (const denied of [owner, other, { ...owner, accountId: 'different-account' }]) {
      await expect(
        store.reserveExternalExecution(denied, value.id, [0], 'scope-binding'),
      ).rejects.toMatchObject({ status: 404 });
    }
    const tagged = await store.reserveExternalExecution(bot, value.id, [0], 'scope-binding');
    for (const denied of [owner, other]) {
      await expect(
        store.saveExternalExecution(denied, value.id, tagged.revision, 'scope-binding', [
          confirmedExternal(),
        ]),
      ).rejects.toMatchObject({ status: 404 });
    }
    const observed = await store.saveExternalExecution(
      bot,
      value.id,
      tagged.revision,
      'scope-binding',
      [confirmedExternal()],
    );
    expect(observed.steps[0]!.state).toBe('confirmed');
    expect(await store.get(owner, value.id)).toEqual(observed);
    expect(await store.get(other, value.id)).toBeUndefined();
  });

  it('preserves permanent direct and sponsored collisions without reserving rejected nonces or keys', async () => {
    const sponsored = plan('external-permanent');
    await store.create(sponsored, idem(sponsored.id), now);
    await seedSponsoredBinding(sponsored, [0], 'permanent-binding');
    const tagged = await store.reserveExternalExecution(
      owner,
      sponsored.id,
      [0],
      'permanent-binding',
    );
    const observed = await store.saveExternalExecution(
      owner,
      sponsored.id,
      tagged.revision,
      'permanent-binding',
      [confirmedExternal()],
    );
    const signed = await attempt(30);
    await expect(
      store.claimSubmission(claim(sponsored.id, signed, { expectedRevision: observed.revision })),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.get(owner, sponsored.id)).toEqual(observed);
    expect(
      await store.findIdempotentPlan(owner, idem(`submit:${sponsored.id}`, 'submit')),
    ).toBeUndefined();
    expect(
      (await pool.query('SELECT 1 FROM rest_transaction_nonces WHERE nonce = 30')).rowCount,
    ).toBe(0);
    await expect(seedSponsoredBinding(sponsored, [0], 'replacement-binding')).rejects.toMatchObject(
      { code: 'TRANSPORT_CONFLICT' },
    );

    const direct = plan('external-direct');
    await store.create(direct, idem(direct.id), now);
    const directClaim = await store.claimSubmission(claim(direct.id, await attempt(31)));
    await expect(
      store.reserveExternalExecution(owner, direct.id, [0], 'fabricated-binding'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.get(owner, direct.id)).toEqual(directClaim.plan);
  });

  it('serializes competing external snapshots and rejects stale revisions without losing other steps', async () => {
    const value = multiStepPlan('external-cas');
    await store.create(value, idem(value.id), now);
    await seedSponsoredBinding(value, [0, 1], 'cas-binding');
    const tagged = await store.reserveExternalExecution(owner, value.id, [0, 1], 'cas-binding');
    const outcomes = await Promise.allSettled(
      [0, 1].map((index) =>
        new PostgresTransactionStore(pool).saveExternalExecution(
          owner,
          value.id,
          tagged.revision,
          'cas-binding',
          [confirmedExternal(index)],
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
    const current = (await store.get(owner, value.id))!;
    expect(current.revision).toBe(tagged.revision + 1);
    expect(current.steps.filter((step) => step.state === 'confirmed')).toHaveLength(1);
    const pendingIndex = current.steps.find((step) => step.state === 'reserved')!.index;
    const complete = await new PostgresTransactionStore(pool).saveExternalExecution(
      owner,
      value.id,
      current.revision,
      'cas-binding',
      [confirmedExternal(pendingIndex)],
    );
    expect(complete.steps.every((step) => step.state === 'confirmed')).toBe(true);
    await expect(
      store.saveExternalExecution(owner, value.id, current.revision, 'cas-binding', [
        { index: pendingIndex, state: 'unknown' },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.get(owner, value.id)).toEqual(complete);
  });

  it('rejects forged external tags, direct attempts, and ordinary edits to external observations', async () => {
    const signedFixture = await attempt(33);
    const value = multiStepPlan('external-save-boundary');
    await store.create(value, idem(value.id), now);
    const forged = structuredClone(value.steps);
    forged[0]!.externalExecution = { transport: 'relayr', bindingId: 'forged', chainId: 1 };
    await expect(store.save(owner, value.id, value.revision, forged)).rejects.toMatchObject({
      status: 409,
    });
    await seedSponsoredBinding(value, [0], 'save-binding');
    const tagged = await store.reserveExternalExecution(owner, value.id, [0], 'save-binding');
    const removedTag = structuredClone(tagged.steps);
    delete removedTag[0]!.externalExecution;
    for (const steps of [
      tagged.steps.map((step) =>
        step.index === 0 ? { ...step, state: 'confirmed' as const } : step,
      ),
      removedTag,
      tagged.steps.map((step) =>
        step.index === 0 ? { ...step, attempt: { ...signedFixture } } : step,
      ),
    ]) {
      await expect(store.save(owner, value.id, tagged.revision, steps)).rejects.toMatchObject({
        status: 409,
      });
    }
    await expect(
      store.saveExternalExecution(owner, value.id, tagged.revision, 'wrong-binding', [
        confirmedExternal(),
      ]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.saveExternalExecution(owner, value.id, tagged.revision, 'save-binding', [
        confirmedExternal(1),
      ]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.saveExternalExecution(owner, value.id, tagged.revision, 'save-binding', [
        { ...confirmedExternal(), attempt: signedFixture } as ExternalStepObservation,
      ]),
    ).rejects.toMatchObject({ status: 400 });
    expect(await store.get(owner, value.id)).toEqual(tagged);
  });

  it('replaces external hashes only with consistent receipts and removes obsolete snapshot evidence', async () => {
    const value = plan('external-snapshots');
    await store.create(value, idem(value.id), now);
    await seedSponsoredBinding(value, [0], 'snapshot-binding');
    let current = await store.reserveExternalExecution(owner, value.id, [0], 'snapshot-binding');
    const hash = externalHash('a1');
    const missingHash = confirmedExternal(0, hash);
    delete missingHash.transactionHash;
    const missingReceipt = confirmedExternal(0, hash);
    delete missingReceipt.receipt;
    for (const invalid of [
      { ...confirmedExternal(0, hash), transactionHash: externalHash('a2') },
      missingHash,
      { ...confirmedExternal(0, hash), receipt: externalReceipt(hash, { canonical: false }) },
      { ...confirmedExternal(0, hash), receipt: externalReceipt(hash, { status: 'reverted' }) },
      missingReceipt,
    ]) {
      await expect(
        store.saveExternalExecution(owner, value.id, current.revision, 'snapshot-binding', [
          invalid,
        ]),
      ).rejects.toMatchObject({ status: 400 });
      expect(await store.get(owner, value.id)).toEqual(current);
    }
    current = await store.saveExternalExecution(
      owner,
      value.id,
      current.revision,
      'snapshot-binding',
      [confirmedExternal(0, hash)],
    );
    const replacement = externalHash('a3');
    current = await store.saveExternalExecution(
      owner,
      value.id,
      current.revision,
      'snapshot-binding',
      [confirmedExternal(0, replacement)],
    );
    expect(current.steps[0]!.externalExecution!.transactionHash).toBe(replacement);
    expect(current.steps[0]!.receipt!.transactionHash).toBe(replacement);
    current = await store.saveExternalExecution(
      owner,
      value.id,
      current.revision,
      'snapshot-binding',
      [{ index: 0, state: 'reorged' }],
    );
    expect(current.steps[0]).toEqual({
      index: 0,
      state: 'reorged',
      externalExecution: { transport: 'relayr', bindingId: 'snapshot-binding', chainId: 1 },
    });
  });

  it('unlocks direct dependencies only after canonical successful external execution evidence', async () => {
    const value = multiStepPlan('external-dependency');
    await store.create(value, idem(value.id), now);
    await seedSponsoredBinding(value, [0], 'dependency-binding');
    let current = await store.reserveExternalExecution(owner, value.id, [0], 'dependency-binding');
    const signed = await attempt(32);
    const dispatch = () =>
      store.claimSubmission(
        claim(value.id, signed, {
          stepIndex: 1,
          expectedRevision: current.revision,
        }),
      );
    await expect(dispatch()).rejects.toMatchObject({ status: 409 });
    const hash = externalHash('b1');
    current = await store.saveExternalExecution(
      owner,
      value.id,
      current.revision,
      'dependency-binding',
      [
        {
          index: 0,
          state: 'reverted',
          transactionHash: hash,
          receipt: externalReceipt(hash),
          semantic: { status: 'failed' },
        },
      ],
    );
    expect(current.steps[0]!.receipt!.status).toBe('success');
    await expect(dispatch()).rejects.toMatchObject({ status: 409 });
    current = await store.saveExternalExecution(
      owner,
      value.id,
      current.revision,
      'dependency-binding',
      [
        {
          ...confirmedExternal(),
          state: 'confirming',
          semantic: { status: 'unknown' },
        },
      ],
    );
    await expect(dispatch()).rejects.toMatchObject({ status: 409 });
    current = await store.saveExternalExecution(
      owner,
      value.id,
      current.revision,
      'dependency-binding',
      [confirmedExternal()],
    );
    const admitted = await dispatch();
    expect(admitted.dispatch).toBe(true);
    expect(admitted.plan.steps[0]).toEqual(current.steps[0]);
    expect(admitted.plan.steps[1]!.attempt!.hash).toBe(signed.hash);
  });

  it('discovers untagged sponsored jobs and synchronizes them after revocation with owner read scope', async () => {
    const ownGrant = grant('external-recovery');
    await accounts.registerBot(ownGrant);
    const bot: RestActor = { accountId: account.id, principalId: `bot:${ownGrant.id}` };
    const other: RestActor = { accountId: account.id, principalId: 'bot:external-other' };
    const value = multiStepPlan('external-recovery');
    value.actor = bot;
    await store.create(value, idem(value.id), now);
    await seedSponsoredBinding(value, [0], 'recovery-first');
    await seedSponsoredBinding(value, [1], 'recovery-second');
    const tagged = await store.reserveExternalExecution(bot, value.id, [0], 'recovery-first');
    const observed = await store.saveExternalExecution(
      bot,
      value.id,
      tagged.revision,
      'recovery-first',
      [confirmedExternal()],
    );
    await accounts.revokeBot(account.id, ownGrant.id, now / 1_000);
    expect(
      (await new PostgresTransactionStore(pool).recoverable(100)).some(
        (row) => row.id === value.id,
      ),
    ).toBe(true);
    await expect(store.syncExternalExecutions(other, value.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      store.syncExternalExecutions({ ...owner, accountId: 'different-account' }, value.id),
    ).rejects.toMatchObject({ status: 404 });
    const synced = await new PostgresTransactionStore(pool).syncExternalExecutions(owner, value.id);
    expect(synced.steps[0]).toEqual(observed.steps[0]);
    expect(synced.steps[1]).toEqual({
      index: 1,
      state: 'reserved',
      externalExecution: { transport: 'relayr', bindingId: 'recovery-second', chainId: 1 },
    });
    expect(synced.revision).toBe(observed.revision + 1);
    expect(await store.syncExternalExecutions(bot, value.id)).toEqual(synced);
    expect((await store.recoverable(100)).some((row) => row.id === value.id)).toBe(true);
    const complete = await store.saveExternalExecution(
      bot,
      value.id,
      synced.revision,
      'recovery-second',
      [confirmedExternal(1)],
    );
    expect(complete.steps.every((step) => step.state === 'confirmed')).toBe(true);
    expect((await store.recoverable(100)).some((row) => row.id === value.id)).toBe(false);
  });

  it('backfills permanent direct bindings for pre-sponsorship monitor and terminal attempts', async () => {
    const legacySchema = `rest_transport_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin!.query(`CREATE SCHEMA "${legacySchema}"`);
    const legacy = new Pool({ connectionString, options: `-c search_path=${legacySchema}` });
    try {
      for (const filename of [
        '001_initial.sql',
        '002_committed_deployments.sql',
        '003_single_intent_format.sql',
        '004_rest_accounts.sql',
        '005_rest_transactions.sql',
      ]) {
        await legacy.query(
          await readFile(new URL(`../src/db/migrations/${filename}`, import.meta.url), 'utf8'),
        );
      }
      const legacyAccounts = new PostgresAccountStore(legacy);
      await legacyAccounts.enroll(account, {
        accountId: account.id,
        signer: wallet.address,
        grantId: null,
        nonce: `0x${'01'.repeat(32)}`,
        issuedAt: now / 1_000,
        expiresAt: now / 1_000 + 60,
        idempotencyKey: null,
        requiredScopes: [],
        ownerOnly: true,
        now: now / 1_000,
      });
      const legacyPlans = new PostgresTransactionStore(legacy);
      const expected: { plan_id: string; transport: string; binding_id: string }[] = [];
      for (const [index, state] of (['submitted', 'confirmed', 'reverted'] as const).entries()) {
        const original = await legacyPlans.create(
          plan(`legacy-${state}`),
          idem(`legacy-${state}`),
          now,
        );
        const signed = await attempt(20 + index);
        original.revision = 1;
        original.steps[0] = {
          index: 0,
          state,
          attempt: { ...signed, dispatchCount: state === 'submitted' ? 0 : 1, leaseUntil: 0 },
        };
        await legacy.query(
          'UPDATE rest_transaction_plans SET revision = 1, document = $2::jsonb WHERE id = $1',
          [original.id, JSON.stringify(original)],
        );
        await legacy.query(
          'INSERT INTO rest_transaction_nonces (chain_id, sender, nonce, transaction_hash, plan_id, step_index) VALUES ($1,$2,$3,$4,$5,0)',
          [signed.chainId, signed.sender.toLowerCase(), signed.nonce, signed.hash, original.id],
        );
        expected.push({ plan_id: original.id, transport: 'direct', binding_id: signed.hash });
      }
      await legacy.query(
        await readFile(
          new URL('../src/db/migrations/006_rest_sponsorship.sql', import.meta.url),
          'utf8',
        ),
      );
      const bindings = await legacy.query<{
        plan_id: string;
        transport: string;
        binding_id: string;
      }>('SELECT plan_id, transport, binding_id FROM rest_transaction_transports ORDER BY plan_id');
      expect(bindings.rows).toEqual(expected.sort((a, b) => a.plan_id.localeCompare(b.plan_id)));
    } finally {
      await legacy.end();
      await admin!.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`);
    }
  });
});
