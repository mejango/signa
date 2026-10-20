import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/postgres.js';
import { PostgresAccountStore, assertRestActorActive } from '../src/rest/auth/postgres.js';
import { PostgresSmartAccountRegistry } from '../src/rest/smartAccounts/postgres.js';
import { PostgresTransactionStore } from '../src/rest/transactions/postgres.js';
import { claimPostgresTransport } from '../src/rest/transactions/transport-reservations.js';
import { PostgresUserOperationStore } from '../src/rest/userOperations/postgres.js';
import { getUserOperationHash } from '../src/rest/userOperations/codec.js';
import { PostgresWalletPolicyStore } from '../src/rest/wallet/policyPostgres.js';
import { PostgresWalletAppGrantStore } from '../src/rest/wallet/appGrantsPostgres.js';
import { walletAppPrincipalId } from '../src/rest/wallet/appGrants.js';
import { refreshTrustedWalletAuthority, seedTrustedWalletAuthority, trustedAuthorityNow } from './fixtures/wallet-authority-readiness.js';
import { PostgresSessionStore } from '../src/rest/sessions/postgres.js';
import { recoveryCursor, type UserOperationRecord } from '../src/rest/userOperations/store.js';
import type { RestActor } from '../src/rest/core.js';
import type { StoredPlan } from '../src/rest/transactions/types.js';
import type { SmartAccountBinding } from '../src/rest/smartAccounts/types.js';
import {
  sessionBinding,
  sessionClaim,
  sessionFixture,
  sessionObservation,
} from './fixtures/sessions.js';
import {
  account,
  binding,
  claim,
  h,
  owner,
  ownerKey,
  plan,
  record,
  safe,
  target,
} from './fixtures/user-operations.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_user_operations_test_${randomUUID().replaceAll('-', '')}`;
const admin = connectionString ? createPool(connectionString) : null;
let pool: Pool;
let accounts: PostgresAccountStore;
let registry: PostgresSmartAccountRegistry;
let plans: PostgresTransactionStore;
let store: PostgresUserOperationStore;
let actor: RestActor;
const bindings = new Map<string, SmartAccountBinding>();

async function enroll(authorityChain = 1) {
  const now = Date.now();
  const value = account(now, authorityChain);
  await accounts.enroll(value, {
    accountId: value.id,
    signer: ownerKey.address,
    grantId: null,
    nonce: h(`enroll:${authorityChain}`),
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 60,
    idempotencyKey: null,
    requiredScopes: [],
    ownerOnly: true,
    now: Math.floor(now / 1000),
  });
  const linked = binding(value, now);
  // Real SmartAccountService bindings keep execution evidence operation-specific.
  linked.state.executionVerified = false;
  await registry.bind(linked);
  bindings.set(value.id, linked);
  return owner(value);
}
async function prepare(id: string, nonce: bigint, principal = actor, steps = 1, persist = true) {
  const now = Date.now();
  const value = plan(id, principal, bindings.get(principal.accountId)!, now, steps);
  await plans.create(value, { key: `plan:${id}`, operation: 'prepare', requestHash: h(id) }, now);
  const operation = record(value, nonce);
  if (persist) await store.create(operation, now);
  return { plan: value, record: operation };
}
async function transportRows(id: string) {
  return (
    await pool.query(
      'SELECT step_index,transport,binding_id FROM rest_transaction_transports WHERE plan_id=$1 ORDER BY step_index',
      [id],
    )
  ).rows;
}
async function expectUnclaimed(value: { plan: StoredPlan; record: UserOperationRecord }) {
  expect(await store.get(value.record.actor, value.record.id)).toEqual(value.record);
  expect(await transportRows(value.plan.id)).toEqual([]);
  expect(
    (
      await pool.query('SELECT 1 FROM rest_user_operation_nonces WHERE user_operation_id=$1', [
        value.record.id,
      ])
    ).rowCount,
  ).toBe(0);
  const row = await pool.query(
    'SELECT submission_key,revision::text FROM rest_user_operations WHERE id=$1',
    [value.record.id],
  );
  expect(row.rows).toEqual([{ submission_key: null, revision: '0' }]);
  expect(await plans.get(value.plan.actor, value.plan.id)).toEqual(value.plan);
}
async function dbSeconds(client: PoolClient) {
  return Number(
    (
      await client.query<{ now: string }>(
        'SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now',
      )
    ).rows[0]!.now,
  );
}
async function waitUntilBlocked(client: PoolClient, pid: number, statement: RegExp) {
  const deadline = performance.now() + 5000;
  for (;;) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const result = await client.query<{ query: string }>(
      'SELECT query FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))',
      [pid],
    );
    // Activity text and the lock manager can sample opposite sides of a statement
    // transition. Observe the required statement as well as its blocker before returning.
    if (result.rows.some((row) => statement.test(row.query))) return result.rows.map((row) => row.query);
    if (performance.now() >= deadline)
      throw new Error('Claim did not reach the expected database wait.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('UserOperation database lock observation', () => {
  it('waits for the requested SQL stage when activity still shows the preceding statement', async () => {
    const expected = 'SELECT document FROM rest_transaction_plans WHERE id=$1 FOR UPDATE';
    const activity = [
      'SELECT document FROM rest_smart_account_bindings WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL',
      expected,
    ];
    const client = { query: async (sql: string) => ({ rows: sql === 'SELECT pg_stat_clear_snapshot()'
      ? [] : [{ query: activity.shift() ?? expected }] }) } as unknown as PoolClient;
    expect(await waitUntilBlocked(client, 1, /^SELECT document FROM rest_transaction_plans .*FOR UPDATE$/)).toEqual([expected]);
    expect(activity).toHaveLength(0);
  });
});

suite('PostgreSQL UserOperation persistence', () => {
  beforeAll(async () => {
    await admin!.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrate(pool);
    accounts = new PostgresAccountStore(pool);
    registry = new PostgresSmartAccountRegistry(pool);
    plans = new PostgresTransactionStore(pool);
    store = new PostgresUserOperationStore(pool);
    actor = await enroll();
  });
  afterAll(async () => {
    await pool?.end();
    await admin!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin!.end();
  });

  it('admits verified module bindings without claiming account-wide execution and rejects missing module proof', async () => {
    expect(bindings.get(actor.accountId)!.state).toMatchObject({ moduleConfigurationVerified: true, executionVerified: false });
    const value = await prepare('operation-specific-execution-evidence', 9001n);
    await pool.query(
      "UPDATE rest_smart_account_bindings SET document=jsonb_set(jsonb_set(document,'{state,moduleConfigurationVerified}','false'::jsonb),'{state,executionVerified}','true'::jsonb) WHERE account_id=$1 AND id=$2",
      [actor.accountId, value.record.accountBindingId],
    );
    try {
      await expect(store.claim(claim(value.record, Date.now()))).rejects.toMatchObject({ code: 'USER_OPERATION_BINDING_STALE' });
      await expectUnclaimed(value);
      const newValue = await prepare('missing-module-proof', 9002n, actor, 1, false);
      await expect(store.create(newValue.record, Date.now())).rejects.toMatchObject({ code: 'USER_OPERATION_BINDING_STALE' });
    } finally {
      await pool.query(
        "UPDATE rest_smart_account_bindings SET document=jsonb_set(jsonb_set(document,'{state,moduleConfigurationVerified}','true'::jsonb),'{state,executionVerified}','false'::jsonb) WHERE account_id=$1 AND id=$2",
        [actor.accountId, value.record.accountBindingId],
      );
    }
    expect((await store.claim(claim(value.record, Date.now()))).dispatch).toBe(true);
  });

  it('creates one immutable preparation across competing clients and rejects same-key changed input', async () => {
    const value = await prepare('create', 1n, actor, 1, false);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        new PostgresUserOperationStore(pool).create(
          { ...value.record, id: `create:${index}` },
          Date.now(),
        ),
      ),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await store.find(actor, value.record.preparationKey, value.record.inputHash)).toEqual(
      results[0],
    );
    await expect(
      store.create({ ...value.record, inputHash: h('changed') }, Date.now()),
    ).rejects.toMatchObject({ code: 'USER_OPERATION_CONFLICT' });
  });
  it('rolls back app preparation when its grant expires while waiting for the plan lock', async () => {
    const expiry = 'grant';
    const appAccountId = `eip155:8453:${safe}`, appOwner = { accountId: appAccountId, principalId: `owner:${appAccountId}` }, origin = 'https://app.example';
    // Trusted synthetic verified-readiness/live-binding fixture; this proves durable expiry handling,
    // not passkey enrollment, setup signatures or canonical authority production.
    await pool.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,avatar_uri,created_at,updated_at)
      VALUES($1,$2,8453,'','',NULL,1,1) ON CONFLICT(id) DO NOTHING`, [appAccountId, safe]);
    const exists = (await pool.query('SELECT 1 FROM rest_wallet_authority WHERE account_id=$1', [appAccountId])).rowCount;
    const trusted = exists ? await refreshTrustedWalletAuthority(pool, appAccountId) : await seedTrustedWalletAuthority(pool, appAccountId);
    const wallet = trusted.binding;
    await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 0, nextRevision: 1,
      configuration: { version: 'center-wallet-policy-v1', applications: [{ origin, walletCallbacks: [`${origin}/callback`] }] } });
    const lock = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const grant = await new PostgresWalletAppGrantStore(pool).insert({ accountId: appOwner.accountId,
        signerAddress: target, origin, callbackUri: `${origin}/callback`, audience: 'https://juicebox.center',
        expectedAppGeneration: 1, expectedAuthorityEpoch: '1', expectedSessionEpoch: '1',
        expiresAt: await dbSeconds(lock) + 6 });
      const appActor = { accountId: appOwner.accountId, principalId: walletAppPrincipalId(grant) };
      const id = `app-plan-wait-${expiry.replaceAll(' ', '-')}-expiry`;
      const value = plan(id, appActor, wallet, Date.now());
      value.smartAccount!.chainId = 8453;
      value.draft.calls.forEach(call => { call.chainId = 8453; });
      await plans.create(value, { key: id, operation: 'prepare', requestHash: h(id) }, Date.now());
      const operation = record(value, 9003n);
      operation.chainId = 8453;
      operation.operationHash = getUserOperationHash(operation.operation, operation.entryPoint, 8453);
      await lock.query('BEGIN');
      await lock.query("SET LOCAL statement_timeout='7000ms'");
      await lock.query('SELECT id FROM rest_transaction_plans WHERE id=$1 FOR UPDATE', [value.id]);
      const pid = Number((await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
      pending = store.create(operation, Date.now()).then(result => ({ result }), (error: unknown) => ({ error }));
      expect(await waitUntilBlocked(lock, pid, /^SELECT document FROM rest_transaction_plans .*FOR UPDATE$/)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^SELECT document FROM rest_transaction_plans .*FOR UPDATE$/),
      ]));
      const expiresAtMs = grant.expiresAt * 1000;
      expect(await trustedAuthorityNow(lock)).toBeLessThan(expiresAtMs);
      await lock.query(
        'SELECT pg_sleep(GREATEST(0,$1::double precision-extract(epoch FROM clock_timestamp())::double precision+0.005))',
        [expiresAtMs / 1000],
      );
      expect(await trustedAuthorityNow(lock)).toBeGreaterThanOrEqual(expiresAtMs);
      await lock.query('ROLLBACK');
      expect(await pending).toMatchObject({ error: { code: 'FORBIDDEN', status: 403 } });
      expect(await store.get(appActor, operation.id)).toBeUndefined();
      expect(await store.find(appActor, operation.preparationKey, operation.inputHash)).toBeUndefined();
      expect(await transportRows(value.id)).toEqual([]);
      expect((await pool.query('SELECT 1 FROM rest_user_operation_nonces WHERE user_operation_id=$1', [operation.id])).rowCount).toBe(0);
      expect(await plans.get(appActor, value.id)).toEqual(value);
    } finally {
      await lock.query('ROLLBACK'); lock.release();
      await pending;
    }
  }, 20000);
  it('denies an actual app UserOperation claim after its live setup binding is revoked', async () => {
    const accountId = `eip155:8453:${safe}`, origin = 'https://app.example';
    // Trusted synthetic readiness only; the existing claim path must enforce its live binding.
    await pool.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,avatar_uri,created_at,updated_at)
      VALUES($1,$2,8453,'','',NULL,1,1) ON CONFLICT(id) DO NOTHING`, [accountId, safe]);
    const exists = (await pool.query('SELECT 1 FROM rest_wallet_authority WHERE account_id=$1', [accountId])).rowCount;
    const trusted = exists ? await refreshTrustedWalletAuthority(pool, accountId) : await seedTrustedWalletAuthority(pool, accountId);
    await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 0, nextRevision: 1,
      configuration: { version: 'center-wallet-policy-v1', applications: [{ origin, walletCallbacks: [`${origin}/callback`] }] } });
    const grant = await new PostgresWalletAppGrantStore(pool).insert({ accountId, signerAddress: target, origin,
      callbackUri: `${origin}/callback`, audience: 'https://juicebox.center', expectedAppGeneration: 1,
      expectedAuthorityEpoch: '1', expectedSessionEpoch: '1', expiresAt: Math.floor(await trustedAuthorityNow(pool) / 1000) + 60 });
    const appActor = { accountId, principalId: walletAppPrincipalId(grant) }, id = 'app-revoked-binding-claim';
    const value = plan(id, appActor, trusted.binding, Date.now());
    value.smartAccount!.chainId = 8453; value.draft.calls.forEach(call => { call.chainId = 8453; });
    await plans.create(value, { key: id, operation: 'prepare', requestHash: h(id) }, Date.now());
    const operation = record(value, 9005n); operation.chainId = 8453;
    operation.operationHash = getUserOperationHash(operation.operation, operation.entryPoint, 8453);
    const prepared = await store.create(operation, Date.now());
    await registry.revoke(accountId, trusted.binding.id);
    expect(await trustedAuthorityNow(pool)).toBeLessThan(trusted.snapshot.validUntilMs!);
    await expect(store.claim(claim(prepared, Date.now()))).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expectUnclaimed({ plan: value, record: prepared });
  });
  it('dispatches once across replicas and never blindly resubmits an ambiguous durable operation', async () => {
    const value = await prepare('submit', 2n);
    const input = claim(value.record, Date.now());
    const results = await Promise.all(
      Array.from({ length: 20 }, () => new PostgresUserOperationStore(pool).claim(input)),
    );
    expect(results.filter((result) => result.dispatch)).toHaveLength(1);
    const unknown = await store.settle(
      value.record.id,
      input.signedCommitment,
      'submission_unknown',
    );
    expect(unknown.submission!.operation).toEqual(input.operation);
    expect(
      await new PostgresUserOperationStore(pool).claim({
        ...input,
        authorization: { issuedAt: 1, expiresAt: 2 },
      }),
    ).toEqual({ record: unknown, dispatch: false });
    expect(await transportRows(value.plan.id)).toEqual([
      { step_index: 0, transport: 'erc4337', binding_id: value.record.id },
    ]);
    expect((await store.recoverable(100)).some((record) => record.id === value.record.id)).toBe(
      true,
    );
  });
  it('retires an unclaimed operation under the claim lock: no replica claims it after, and one a claim took stays claimed', async () => {
    const first = await prepare('retire-first', 40n);
    const retired = await store.retire(actor, first.record.id);
    expect(retired).toMatchObject({ state: 'retired', revision: 1 }); expect(retired.submission).toBeUndefined();
    await expect(new PostgresUserOperationStore(pool).claim(claim(first.record, Date.now()))).rejects.toMatchObject({ code: 'USER_OPERATION_RETIRED' });
    expect(await store.retire(actor, first.record.id)).toEqual(retired);
    expect(await transportRows(first.plan.id)).toEqual([]);
    expect((await store.retired(first.record.chainId, first.record.sender)).map((record) => record.id)).toContain(first.record.id);
    // A retired row can never carry a submission, at the SQL boundary too.
    await expect(pool.query(`UPDATE rest_user_operations SET document=jsonb_set(document,'{submission}','{}'::jsonb) WHERE id=$1`,
      [first.record.id])).rejects.toMatchObject({ code: '23514' });
    // Settled once the chain shows it can never run; until then other claims from the sender must account for it.
    await store.settleRetired(first.record.id);
    expect((await store.get(actor, first.record.id))!.retiredSettledAt).toBeGreaterThan(0);
    const claimedFirst = await prepare('claim-first', 41n), input = claim(claimedFirst.record, Date.now());
    expect((await store.claim(input)).dispatch).toBe(true);
    const kept = await new PostgresUserOperationStore(pool).retire(actor, claimedFirst.record.id);
    expect(kept.state).toBe('submitting'); expect(kept.submission!.commitment).toBe(input.signedCommitment);
    expect((await store.nonceHolder(claimedFirst.record.chainId, claimedFirst.record.sender, 41n))!.id).toBe(claimedFirst.record.id);
    // Racing replicas: exactly one of retirement or a single dispatch wins, never both.
    for (const nonce of [42n, 43n, 44n]) {
      const value = await prepare(`race-${nonce}`, nonce), raced = claim(value.record, Date.now());
      const [retirement, ...claims] = await Promise.allSettled([new PostgresUserOperationStore(pool).retire(actor, value.record.id),
        ...Array.from({ length: 8 }, () => new PostgresUserOperationStore(pool).claim(raced))]);
      expect(retirement.status).toBe('fulfilled');
      const final = (retirement as PromiseFulfilledResult<UserOperationRecord>).value;
      const dispatched = claims.filter((result) => result.status === 'fulfilled' && result.value.dispatch);
      if (final.state === 'retired') {
        expect(dispatched).toHaveLength(0);
        expect((await store.get(actor, value.record.id))!.state).toBe('retired');
        expect(await store.nonceHolder(value.record.chainId, value.record.sender, nonce)).toBeUndefined();
        await store.settleRetired(value.record.id);
      } else {
        expect(dispatched).toHaveLength(1); expect(final.submission).toBeDefined();
      }
    }
    // The lookup spans every API account that binds the Safe: its nonce is the chain's.
    const alias = await enroll(2), aliased = await prepare('retire-alias', 45n, alias);
    await store.retire(alias, aliased.record.id);
    const unsettled = await store.retired(aliased.record.chainId, aliased.record.sender);
    expect(unsettled.map((record) => record.id)).toEqual([aliased.record.id]);
    // A claim whose admission did not check every unsettled retirement of its sender is refused.
    const late = await prepare('retire-late', 46n);
    await expect(store.claim(claim(late.record, Date.now()))).rejects.toMatchObject({ code: 'USER_OPERATION_RETIRED_CHANGED' });
    expect((await store.claim({ ...claim(late.record, Date.now()), retiredChecked: unsettled.map((record) => record.id) })).dispatch).toBe(true);
    for (const record of unsettled) await store.settleRetired(record.id);
    expect(await store.retired(aliased.record.chainId, aliased.record.sender)).toEqual([]);
  });
  it('rejects changed signatures and changed transaction fields against the immutable signed commitment', async () => {
    const value = await prepare('signed-identity', 3n);
    const input = claim(value.record, Date.now());
    await store.claim(input);
    await expect(store.claim(claim(value.record, Date.now(), '0x5678'))).rejects.toMatchObject({
      code: 'USER_OPERATION_CONFLICT',
    });
    await expect(
      store.claim({ ...input, operation: { ...input.operation, callData: '0xabcd' } }),
    ).rejects.toMatchObject({ code: 'USER_OPERATION_CONFLICT' });
    expect((await store.get(actor, value.record.id))!.submission!.operation).toEqual(
      input.operation,
    );
  });
  it('globally reserves the full uint256 sender nonce across account aliases and different plans', async () => {
    const alternate = await enroll(10);
    const nonce = (1n << 200n) + 42n;
    const values = await Promise.all([
      prepare('nonce-main', nonce),
      prepare('nonce-alias', nonce, alternate),
    ]);
    const outcomes = await Promise.allSettled(
      values.map((value) =>
        new PostgresUserOperationStore(pool).claim(claim(value.record, Date.now())),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const [index, result] of outcomes.entries())
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'USER_OPERATION_NONCE_CONFLICT', status: 409 });
        await expectUnclaimed(values[index]!);
      }
    const rows = await pool.query<{ nonce: string }>(
      'SELECT nonce FROM rest_user_operation_nonces WHERE chain_id=1 AND sender=$1 AND nonce=$2',
      [safe, nonce.toString()],
    );
    expect(rows.rows).toEqual([{ nonce: nonce.toString() }]);
    const next = await prepare('nonce-next', nonce + 1n);
    expect((await store.claim(claim(next.record, Date.now()))).dispatch).toBe(true);
  });
  it('rolls back all UserOperation transport steps and nonce writes when another transport already won', async () => {
    for (const [index, transport] of (['direct', 'relayr'] as const).entries()) {
      const value = await prepare(`transport:${transport}`, 100n + BigInt(index), actor, 2);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await assertRestActorActive(client, actor, ['relay'], Math.floor(Date.now() / 1000));
        await claimPostgresTransport(
          client,
          value.plan.id,
          [1],
          transport,
          transport === 'direct' ? h('direct') : 'relayr-binding',
        );
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      await expect(store.claim(claim(value.record, Date.now()))).rejects.toMatchObject({
        code: 'TRANSPORT_CONFLICT',
      });
      expect(await store.get(actor, value.record.id)).toEqual(value.record);
      expect(await transportRows(value.plan.id)).toHaveLength(1);
      expect(
        (
          await pool.query('SELECT 1 FROM rest_user_operation_nonces WHERE user_operation_id=$1', [
            value.record.id,
          ])
        ).rowCount,
      ).toBe(0);
      const retry = await prepare(`transport-retry:${transport}`, 100n + BigInt(index));
      expect((await store.claim(claim(retry.record, Date.now()))).dispatch).toBe(true);
    }
  });
  it('rejects revoked bots before admission while owner inspection cannot borrow bot mutation authority', async () => {
    const now = Math.floor(Date.now() / 1000);
    const botId = 'uo-revoked';
    const bot = { accountId: actor.accountId, principalId: `bot:${botId}` };
    await accounts.registerBot({
      id: botId,
      accountId: actor.accountId,
      botAddress: target,
      scopes: ['read', 'plan', 'relay'],
      label: '',
      createdAt: now,
      expiresAt: now + 300,
      revokedAt: null,
    });
    const value = await prepare('revoked-bot', 200n, bot);
    await expect(store.claim({ ...claim(value.record, Date.now()), actor })).rejects.toMatchObject({
      status: 404,
    });
    await accounts.revokeBot(actor.accountId, botId, now);
    await expect(store.claim(claim(value.record, Date.now()))).rejects.toMatchObject({
      status: 403,
    });
    await expect(store.retire(bot, value.record.id)).rejects.toMatchObject({ status: 403 });
    expect(await store.get(actor, value.record.id)).toEqual(value.record);
    await expectUnclaimed(value);
  });
  it('binds session generation, refreshes observation proof, and immediately rejects session revocation', async () => {
    const sessions = new PostgresSessionStore(pool);
    const fixture = sessionFixture(Date.now(), { generation: '73' });
    await accounts.registerBot(fixture.grant);
    const created = await sessions.create(
      fixture.record,
      { key: 'uo-session', requestHash: h('uo-session') },
      Date.now(),
    );
    const activationPlan = plan(randomUUID(), actor, bindings.get(actor.accountId)!, Date.now());
    activationPlan.draft.operation = 'activate_smart_account_session';
    activationPlan.draft.summary = {
      sessionId: created.id,
      compiledHash: created.compiled.compiledHash,
      setup: {},
    };
    await plans.create(
      activationPlan,
      { key: 'owner-activation', operation: 'fixture', requestHash: h('owner-activation') },
      Date.now(),
    );
    const activationOperation = record(activationPlan, 801n);
    await expect(store.create(activationOperation, Date.now())).rejects.toMatchObject({
      code: 'SESSION_LIFECYCLE_PLAN_UNADMITTED',
    });
    expect(await store.get(actor, activationOperation.id)).toBeUndefined();
    const activation = sessionClaim(created);
    activation.approval.planId = activationPlan.id;
    activation.approval.planCommitment = activationPlan.commitment;
    const installing = (await sessions.claimActivation(activation)).record;
    await store.create(activationOperation, Date.now());
    const active = (
      await sessions.observe({
        actor: fixture.actor,
        id: installing.id,
        expectedRevision: installing.revision,
        expectedObservationHash: null,
        observation: sessionObservation(installing),
        now: Date.now(),
      })
    ).record;
    expect(active.state).toBe('active');
    await expect(store.claim(claim(activationOperation, Date.now()))).rejects.toMatchObject({
      code: 'SESSION_LIFECYCLE_PLAN_UNADMITTED',
    });
    await expectUnclaimed({ plan: activationPlan, record: activationOperation });
    const originalBinding = sessionBinding(active);
    const pending = await prepare('session-proof', 810n, fixture.bot, 1, false);
    pending.record.session = originalBinding;
    await store.create(pending.record, Date.now());
    const forged = await prepare('session-generation', 811n, fixture.bot, 1, false);
    forged.record.session = { ...originalBinding, generation: '74' };
    await expect(store.create(forged.record, Date.now())).rejects.toMatchObject({
      code: 'SESSION_OPERATION_BINDING_MISMATCH',
    });
    expect(await store.get(fixture.bot, forged.record.id)).toBeUndefined();
    expect(await transportRows(forged.plan.id)).toEqual([]);

    const now = Date.now();
    const refreshed = (
      await sessions.observe({
        actor: fixture.actor,
        id: active.id,
        expectedRevision: active.revision,
        expectedObservationHash: active.observation!.proofHash,
        observation: sessionObservation(active, now, {
          evidence: {
            chainId: active.compiled.chainId,
            blockNumber: '101',
            blockHash: h('101'),
            timestamp: String(Math.floor(now / 1000)),
            source: 'onchain',
          },
        }),
        now,
      })
    ).record;
    const freshBinding = sessionBinding(refreshed);
    expect(freshBinding.observationHash).not.toBe(originalBinding.observationHash);
    await expect(
      store.claim({
        ...claim(pending.record, now),
        sessionObservationHash: originalBinding.observationHash,
      }),
    ).rejects.toMatchObject({
      code: 'SESSION_EXECUTION_UNAVAILABLE',
    });
    await expectUnclaimed(pending);
    const admittedInput = {
      ...claim(pending.record, Date.now()),
      sessionObservationHash: freshBinding.observationHash,
    };
    const admitted = await store.claim(admittedInput);
    expect(admitted.dispatch).toBe(true);
    expect(admitted.record.session).toEqual(originalBinding);
    expect(admitted.record.submission!.sessionObservationHash).toBe(freshBinding.observationHash);

    const revoked = await prepare('session-revocation', 812n, fixture.bot, 1, false);
    revoked.record.session = freshBinding;
    await store.create(revoked.record, Date.now());
    const revocationPlan = plan(randomUUID(), actor, bindings.get(actor.accountId)!, Date.now());
    revocationPlan.draft.operation = 'revoke_smart_account_session';
    revocationPlan.draft.summary = {
      sessionId: created.id,
      compiledHash: created.compiled.compiledHash,
      setup: {},
    };
    await plans.create(
      revocationPlan,
      { key: 'owner-revocation', operation: 'fixture', requestHash: h('owner-revocation') },
      Date.now(),
    );
    const revocationOperation = record(revocationPlan, 802n);
    await expect(store.create(revocationOperation, Date.now())).rejects.toMatchObject({
      code: 'SESSION_LIFECYCLE_PLAN_UNADMITTED',
    });
    const revocation = sessionClaim(refreshed, Date.now(), 'revocation');
    revocation.approval.planId = revocationPlan.id;
    revocation.approval.planCommitment = revocationPlan.commitment;
    const revoking = (await sessions.claimRevocation(revocation)).record;
    expect(revoking.state).toBe('revoking');
    await store.create(revocationOperation, Date.now());
    expect((await store.claim(claim(revocationOperation, Date.now()))).dispatch).toBe(true);
    await expect(
      store.claim({
        ...claim(revoked.record, Date.now()),
        sessionObservationHash: freshBinding.observationHash,
      }),
    ).rejects.toMatchObject({
      code: 'SESSION_EXECUTION_UNAVAILABLE',
    });
    await expectUnclaimed(revoked);
    expect((await store.claim(admittedInput)).dispatch).toBe(false);
    expect(
      (await store.settle(admitted.record.id, admittedInput.signedCommitment, 'submission_unknown'))
        .state,
    ).toBe('submission_unknown');
  });
  it('rejects changed smart-account state or a plain EOA plan before making reservations', async () => {
    const value = await prepare('binding-changed', 201n);
    await pool.query(
      "UPDATE rest_smart_account_bindings SET document=jsonb_set(document,'{state,stateHash}',to_jsonb($2::text)) WHERE account_id=$1",
      [actor.accountId, h('changed-state')],
    );
    await expect(store.claim(claim(value.record, Date.now()))).rejects.toMatchObject({
      code: 'USER_OPERATION_BINDING_STALE',
    });
    await expectUnclaimed(value);
    await pool.query(
      "UPDATE rest_smart_account_bindings SET document=jsonb_set(document,'{state,stateHash}',to_jsonb($2::text)) WHERE account_id=$1",
      [actor.accountId, bindings.get(actor.accountId)!.state.stateHash],
    );
    const plain = await prepare('plain-eoa', 202n, actor, 1, false);
    await pool.query(
      "UPDATE rest_transaction_plans SET document=document-'smartAccount' WHERE id=$1",
      [plain.plan.id],
    );
    await expect(store.create(plain.record, Date.now())).rejects.toMatchObject({
      code: 'USER_OPERATION_CONFLICT',
    });
    expect(await store.get(actor, plain.record.id)).toBeUndefined();
  });
  it('rechecks approval after a global nonce wait and rolls back transport, nonce, and submission together', async () => {
    const value = await prepare('expiry-nonce', 300n);
    const blocker = await prepare('expiry-blocker', 301n);
    const input = claim(value.record, Date.now());
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A different record avoids blocking the target's earlier FOR UPDATE through the FK.
      await client.query(
        'INSERT INTO rest_user_operation_nonces(chain_id,sender,nonce,entry_point,operation_hash,signed_commitment,user_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          value.record.chainId,
          safe,
          '300',
          value.record.entryPoint,
          value.record.operationHash,
          input.signedCommitment,
          blocker.record.id,
        ],
      );
      const pid = Number(
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const issuedAt = await dbSeconds(client);
      const expiresAt = issuedAt + 6;
      const pending = store.claim({ ...input, authorization: { issuedAt, expiresAt } }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      expect(await waitUntilBlocked(client, pid, /^INSERT INTO rest_user_operation_nonces/)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^INSERT INTO rest_user_operation_nonces/)]),
      );
      expect(await dbSeconds(client)).toBeLessThan(expiresAt);
      await client.query(
        'SELECT pg_sleep(GREATEST(0,$1::double precision-extract(epoch FROM clock_timestamp())::double precision+0.005))',
        [expiresAt],
      );
      expect(await dbSeconds(client)).toBeGreaterThanOrEqual(expiresAt);
      await client.query('ROLLBACK');
      expect(await pending).toMatchObject({ error: { code: 'AUTH_EXPIRED', status: 401 } });
      await expectUnclaimed(value);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('keeps observations revision-safe and recovers pending records without retaining stale proof', async () => {
    const value = await prepare('observe', 400n);
    const input = claim(value.record, Date.now());
    const admitted = await store.claim(input);
    const observation = {
      state: 'confirmed' as const,
      operationHash: value.record.operationHash,
      transactionHash: h('transaction'),
      receipt: {
        transactionHash: h('transaction'),
        blockHash: h('block'),
        blockNumber: '100',
        status: 'success' as const,
        canonical: true,
        confirmations: 2,
        observedAt: Date.now(),
        logs: [],
      },
      semantic: { status: 'verified' as const },
    };
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        new PostgresUserOperationStore(pool).observe(
          value.record.id,
          admitted.record.revision,
          observation,
        ),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const current = (await store.get(actor, value.record.id))!;
    await expect(
      store.observe(value.record.id, current.revision, {
        ...observation,
        transactionHash: h('other'),
      }),
    ).rejects.toMatchObject({ status: 400 });
    const pending = await store.observe(value.record.id, current.revision, {
      state: 'unknown',
      operationHash: value.record.operationHash,
    });
    expect(pending.observation!.receipt).toBeUndefined();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await store.recoverable(2, cursor);
      if (!page.length) break;
      seen.push(...page.map((record) => record.id));
      cursor = recoveryCursor(page.at(-1)!);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(value.record.id);
    expect(
      await store.settle(value.record.id, input.signedCommitment, 'submission_unknown'),
    ).toEqual(pending);
    // A never-included operation past its validity is stored as final and leaves recovery; the
    // nonce it held goes back into circulation (its plan step stays claimed), and nothing moves it off expired.
    const expired = await store.observe(value.record.id, pending.revision, {
      state: 'expired',
      operationHash: value.record.operationHash,
      reason: 'past validity',
    });
    expect(expired.state).toBe('expired');
    expect((await store.recoverable(50)).map((record) => record.id)).not.toContain(value.record.id);
    expect((await pool.query('SELECT 1 FROM rest_user_operation_nonces WHERE user_operation_id=$1', [value.record.id])).rowCount).toBe(0);
    expect(await transportRows(value.plan.id)).toHaveLength(1);
    await expect(store.observe(value.record.id, expired.revision, { state: 'pending', operationHash: value.record.operationHash }))
      .rejects.toMatchObject({ status: 409 });
    const again = await prepare('observe-again', 400n);
    const reclaimed = await store.claim(claim(again.record, Date.now()));
    expect(reclaimed.dispatch).toBe(true);
  });
  it('releases the nonce of an operation whose whole bundle reverted, and keeps its wallet on that nonce until it settles', async () => {
    const reverted = (id: `0x${string}`, status: 'reverted' | 'success') => ({
      state: 'reverted' as const, operationHash: id, transactionHash: h(`bundle:${id}`),
      receipt: { transactionHash: h(`bundle:${id}`), blockHash: h('block'), blockNumber: '100', status, canonical: true,
        confirmations: 2, observedAt: Date.now(), logs: [] },
      semantic: { status: 'failed' as const, details: 'The entire EntryPoint bundle reverted.' },
    });
    const nonceRows = async (id: string) => (await pool.query('SELECT 1 FROM rest_user_operation_nonces WHERE user_operation_id=$1', [id])).rowCount;
    const first = await prepare('bundle-reverted', 500n);
    const admitted = await store.claim(claim(first.record, Date.now()));
    const released = await store.observe(first.record.id, admitted.record.revision, reverted(first.record.operationHash, 'reverted'));
    expect(released.state).toBe('reverted'); expect(released.nonceReleasedAt).toBeGreaterThan(0);
    expect(await nonceRows(first.record.id)).toBe(0);
    const unsettled = await store.retired(first.record.chainId, first.record.sender);
    expect(unsettled.map((record) => record.id)).toEqual([first.record.id]);
    // Another nonce is refused at the claim while it is unsettled; its very nonce is free for a fresh payment.
    const other = await prepare('bundle-other-nonce', 501n);
    await expect(store.claim(claim(other.record, Date.now()))).rejects.toMatchObject({ code: 'USER_OPERATION_RETIRED_CHANGED' });
    const fresh = await prepare('bundle-fresh', 500n);
    expect((await store.claim({ ...claim(fresh.record, Date.now()), retiredChecked: [first.record.id] })).dispatch).toBe(true);
    expect((await store.nonceHolder(fresh.record.chainId, fresh.record.sender, 500n))!.id).toBe(fresh.record.id);
    // Settlement looks at every operation sent at the nonce, under any account, settled or not.
    expect((await store.sentAt(fresh.record.chainId, fresh.record.sender, 500n)).map((record) => record.id).sort())
      .toEqual([first.record.id, fresh.record.id].sort());
    // A reorg of the revert keeps it unsettled, and its later expiry never drops the fresh payment's reservation.
    const reorged = await store.observe(first.record.id, released.revision, { state: 'pending', operationHash: first.record.operationHash });
    expect((await store.retired(first.record.chainId, first.record.sender)).map((record) => record.id)).toEqual([first.record.id]);
    await store.observe(first.record.id, reorged.revision, { state: 'expired', operationHash: first.record.operationHash, reason: 'past validity' });
    expect((await store.nonceHolder(fresh.record.chainId, fresh.record.sender, 500n))!.id).toBe(fresh.record.id);
    // A failed account execution inside a successful bundle consumed its nonce: nothing is released.
    const inner = await prepare('bundle-inner', 502n), innerClaim = await store.claim({ ...claim(inner.record, Date.now()), retiredChecked: [first.record.id] });
    const innerFailed = await store.observe(inner.record.id, innerClaim.record.revision, reverted(inner.record.operationHash, 'success'));
    expect(innerFailed.nonceReleasedAt).toBeUndefined(); expect(await nonceRows(inner.record.id)).toBe(1);
    await store.settleRetired(first.record.id);
    expect(await store.retired(first.record.chainId, first.record.sender)).toEqual([]);
    // A release waits on the sender lock a claim holds from its check of the unsettled set to its commit.
    const raced = await prepare('bundle-raced', 503n), racedClaim = await store.claim({ ...claim(raced.record, Date.now()), retiredChecked: [first.record.id] });
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`user-operation-sender:${raced.record.chainId}:${raced.record.sender.toLowerCase()}`]);
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const releasing = store.observe(raced.record.id, racedClaim.record.revision, reverted(raced.record.operationHash, 'reverted'));
      await waitUntilBlocked(holder, pid, /pg_advisory_xact_lock/);
      expect(await nonceRows(raced.record.id)).toBe(1);
      await holder.query('COMMIT');
      expect((await releasing).nonceReleasedAt).toBeGreaterThan(0);
    } finally { holder.release(); }
    expect(await nonceRows(raced.record.id)).toBe(0);
    await store.settleRetired(raced.record.id);
    // The migration releases rows reverted this way before the fix, each held unsettled until the chain settles it.
    const migration = (await import('node:fs/promises')).readFile(new URL('../src/db/migrations/062_user_operation_reverted_bundle_release.sql', import.meta.url), 'utf8');
    const backfill = (await migration).split(';').map((statement) => statement.trim()).filter((statement) => /^(?:--[^\n]*\n\s*)*(SELECT|UPDATE|DELETE)/.test(statement));
    expect(backfill).toHaveLength(3);
    const stuck = async (id: string, nonce: bigint, expiresAt?: number) => {
      const value = await prepare(id, nonce), claimed = await store.claim(claim(value.record, Date.now()));
      await store.observe(value.record.id, claimed.record.revision, reverted(value.record.operationHash, 'reverted'));
      await pool.query(`UPDATE rest_user_operations SET document=document - 'nonceReleasedAt' || jsonb_build_object('expiresAt', $2::bigint) WHERE id=$1`,
        [value.record.id, expiresAt ?? value.record.expiresAt]);
      await pool.query('INSERT INTO rest_user_operation_nonces(chain_id,sender,nonce,entry_point,operation_hash,signed_commitment,user_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [value.record.chainId, value.record.sender.toLowerCase(), nonce.toString(), value.record.entryPoint.toLowerCase(),
          value.record.operationHash.toLowerCase(), claimed.record.submission!.commitment.toLowerCase(), value.record.id]);
      return value.record.id;
    };
    const old = await stuck('bundle-stuck-old', 511n, Date.now() - 7_200_000);
    for (const statement of backfill) await pool.query(statement);
    expect(await nonceRows(old)).toBe(0);
    const oldRow = (await pool.query('SELECT document, revision FROM rest_user_operations WHERE id=$1', [old])).rows[0];
    expect(oldRow.document.nonceReleasedAt).toBeGreaterThan(0); expect(oldRow.document.retiredSettledAt).toBeUndefined();
    expect(Number(oldRow.document.revision)).toBe(Number(oldRow.revision));
    expect((await store.retired(first.record.chainId, first.record.sender)).map((record) => record.id)).toEqual([old]);
    await store.settleRetired(old);
  });
});
