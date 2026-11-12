import { describe, expect, it } from 'vitest';
import { keccak256, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MemoryAccountStore } from '../src/rest/auth/memory.js';
import type { Account, BotGrant } from '../src/rest/auth/store.js';
import type { RestActor } from '../src/rest/core.js';
import { MemoryTransactionStore } from '../src/rest/transactions/memory.js';
import { encodeCursor } from '../src/rest/transactions/store.js';
import { MemoryTransportReservations } from '../src/rest/transactions/transport-reservations.js';
import { MemorySponsorshipStore } from '../src/rest/sponsorship/memory.js';
import type { SponsorshipRecord } from '../src/rest/sponsorship/types.js';
import type {
  ExternalStepObservation,
  StoredPlan,
  SignedAttempt,
  SubmissionClaim,
} from '../src/rest/transactions/types.js';

// Public deterministic fixture key. No request in this suite reaches an RPC endpoint.
const wallet = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const recipient = '0x2222222222222222222222222222222222222222' as Address;
const now = 2_000_000;
const account: Account = {
  id: `eip155:1:${wallet.address.toLowerCase()}`,
  ownerAddress: wallet.address,
  authorityChainId: 1,
  profile: { displayName: '', bio: '', avatarUri: null },
  createdAt: now / 1_000,
  updatedAt: now / 1_000,
};
const owner: RestActor = {
  accountId: account.id,
  principalId: `owner:${account.id}`,
};
const grant: BotGrant = {
  id: 'relay-bot',
  accountId: account.id,
  botAddress: recipient,
  scopes: ['read', 'plan', 'relay'],
  label: '',
  createdAt: now / 1_000,
  expiresAt: now / 1_000 + 1_000,
  revokedAt: null,
};
const bot: RestActor = {
  accountId: account.id,
  principalId: `bot:${grant.id}`,
};
const idem = (key: string, operation = 'prepare', requestHash = `hash:${key}`) => ({
  key,
  operation,
  requestHash,
});
function plan(id = 'plan-1', actor = owner): StoredPlan {
  return {
    id,
    actor,
    commitment: `0x${'ab'.repeat(32)}`,
    createdAt: now,
    expiresAt: now + 60_000,
    revision: 0,
    draft: {
      operation: 'fixture',
      account: wallet.address,
      evidence: [],
      summary: {},
      warnings: [],
      calls: [
        {
          chainId: 1,
          to: recipient,
          data: '0x',
          value: '1',
          label: 'Fixture transfer',
          dependsOn: [],
          decoded: {},
        },
      ],
    },
    steps: [{ index: 0, state: 'waiting' }],
  };
}
function sponsorshipRecord(): SponsorshipRecord {
  const original = plan();
  return {
    id: 'sponsorship-preparation',
    actor: owner,
    planId: original.id,
    planCommitment: original.commitment,
    preparationKey: 'sponsor-prepare',
    inputHash: `0x${'cd'.repeat(32)}`,
    commitment: `0x${'de'.repeat(32)}`,
    createdAt: now,
    expiresAt: now + 60_000,
    revision: 0,
    state: 'prepared',
    observations: [],
    requests: [
      {
        stepIndex: 0,
        chainId: 1,
        forwarder: recipient,
        forwarderCodeHash: `0x${'ef'.repeat(32)}`,
        targetCodeHash: `0x${'fa'.repeat(32)}`,
        domain: {
          name: 'Fixture',
          version: '1',
          chainId: 1,
          verifyingContract: recipient,
        },
        message: {
          from: wallet.address,
          to: recipient,
          value: '1',
          gas: '21000',
          nonce: '0',
          deadline: String(now / 1_000 + 60),
          data: '0x',
        },
        evidence: {
          chainId: 1,
          blockNumber: '100',
          blockHash: `0x${'bc'.repeat(32)}`,
          timestamp: String(now / 1_000),
          source: 'onchain',
        },
      },
    ],
  };
}
async function attempt(nonce = 0): Promise<SignedAttempt> {
  const rawTransaction = await wallet.signTransaction({
    chainId: 1,
    type: 'eip1559',
    nonce,
    gas: 21_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    to: recipient,
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
function claim(value: SignedAttempt, input: Partial<SubmissionClaim> = {}): SubmissionClaim {
  return {
    actor: owner,
    planId: 'plan-1',
    stepIndex: 0,
    expectedRevision: 0,
    attempt: value,
    idempotency: idem('submit', 'submit'),
    now,
    dispatch: true,
    ...input,
  };
}
function externalProof(
  index = 0,
  transactionHash: `0x${string}` = `0x${'cd'.repeat(32)}`,
): ExternalStepObservation {
  return {
    index,
    state: 'confirmed',
    transactionHash,
    receipt: {
      transactionHash,
      blockHash: `0x${'ef'.repeat(32)}`,
      blockNumber: '100',
      status: 'success',
      canonical: true,
      confirmations: 2,
      observedAt: now,
      logs: [],
    },
    semantic: { status: 'verified' },
  };
}
async function setup() {
  const accounts = new MemoryAccountStore();
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
  await accounts.registerBot(grant);
  const transports = new MemoryTransportReservations();
  const store = new MemoryTransactionStore(accounts, transports);
  return { accounts, store, transports };
}

describe('Memory transaction persistence', () => {

  it('rejects dispatch authorization that expires while waiting for the shared account lock', async () => {
    const { accounts, store, transports } = await setup();
    await store.create(plan(), idem('prepare'), now);
    const signed = await attempt();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocker = accounts.withActiveActor(owner, ['relay'], now / 1_000, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await started;
    const pending = store.claimSubmission(
      claim(signed, {
        now: now + 990,
        authorization: { issuedAt: now / 1_000, expiresAt: now / 1_000 + 1 },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await blocker;
    await expect(pending).rejects.toMatchObject({ status: 401, code: 'AUTH_EXPIRED' });
    expect((await store.get(owner, 'plan-1'))!.revision).toBe(0);
    expect(await store.findIdempotentPlan(owner, idem('submit', 'submit'))).toBeUndefined();
    expect(transports.list('plan-1')).toEqual([]);
    await store.create(plan('fresh-plan'), idem('fresh-plan'), now);
    expect(
      (
        await store.claimSubmission(
          claim(signed, {
            planId: 'fresh-plan',
            now: now + 1_050,
            authorization: { issuedAt: now / 1_000, expiresAt: now / 1_000 + 60 },
          }),
        )
      ).dispatch,
    ).toBe(true);
  });

  it('requires a fresh valid authorization for new leases, but not monitor-only or active-lease replay', async () => {
    const { store } = await setup();
    await store.create(plan(), idem('prepare'), now);
    const signed = await attempt();
    const authorization = { issuedAt: now / 1_000, expiresAt: now / 1_000 + 1 };
    expect((await store.claimSubmission(claim(signed, { authorization }))).dispatch).toBe(true);
    const replay = await store.claimSubmission(claim(signed, { authorization, now: now + 1_500 }));
    expect(replay.dispatch).toBe(false);
    expect(replay.plan.revision).toBe(1);
    await expect(
      store.claimSubmission(
        claim(
          { ...signed, leaseToken: 'expired-auth', leaseUntil: now + 30_000 },
          {
            authorization,
            expectedRevision: 1,
            now: now + 11_000,
          },
        ),
      ),
    ).rejects.toMatchObject({ status: 401, code: 'AUTH_EXPIRED' });
    const other = await setup();
    await other.store.create(plan(), idem('prepare'), now);
    expect(
      (
        await other.store.claimSubmission(
          claim(signed, { authorization, now: now + 1_500, dispatch: false }),
        )
      ).dispatch,
    ).toBe(false);
  });

  it('rejects malformed or overlong dispatch authorization windows before reserving any transport', async () => {
    const { store, transports } = await setup();
    await store.create(plan(), idem('prepare'), now);
    const signed = await attempt();
    const seconds = now / 1_000;
    for (const authorization of [
      { issuedAt: Number.NaN, expiresAt: seconds + 60 },
      { issuedAt: seconds, expiresAt: Number.POSITIVE_INFINITY },
      { issuedAt: seconds + 31, expiresAt: seconds + 60 },
      { issuedAt: seconds, expiresAt: seconds + 301 },
      { issuedAt: seconds, expiresAt: seconds },
      { issuedAt: seconds + 0.5, expiresAt: seconds + 60 },
    ]) {
      await expect(store.claimSubmission(claim(signed, { authorization }))).rejects.toMatchObject({
        status: 401,
        code: 'AUTH_EXPIRED',
      });
    }
    expect((await store.get(owner, 'plan-1'))!.revision).toBe(0);
    expect(transports.list('plan-1')).toEqual([]);
  });
  it('deduplicates concurrent preparation and isolates both account and bot principal reads', async () => {
    const { store } = await setup();
    const copies = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.create(plan(`plan-${i}`), idem('one'), now)),
    );
    expect(new Set(copies.map((value) => value.id)).size).toBe(1);
    const original = copies[0]!;
    original.draft.calls[0]!.value = '999';
    expect((await store.get(owner, original.id))!.draft.calls[0]!.value).toBe('1');
    expect(await store.get(bot, original.id)).toBeUndefined();
    expect(
      await store.get({ accountId: 'other', principalId: owner.principalId }, original.id),
    ).toBeUndefined();
    await expect(
      store.create(plan('different'), idem('one', 'prepare', 'different body'), now),
    ).rejects.toMatchObject({ status: 409 });
    expect((await store.list(owner, { limit: 10 })).items).toHaveLength(1);
  });

  it('shares idempotency keys across preparation and submission operations', async () => {
    const { store } = await setup();
    await store.create(plan(), idem('same-key'), now);
    await expect(
      store.claimSubmission(claim(await attempt(), { idempotency: idem('same-key', 'submit') })),
    ).rejects.toMatchObject({ status: 409 });
    expect((await store.get(owner, 'plan-1'))!.steps[0]!.attempt).toBeUndefined();
  });

  it('grants one dispatch lease for competing retries and retains exact signed bytes', async () => {
    const { store } = await setup();
    await store.create(plan(), idem('prepare'), now);
    const signed = await attempt();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.claimSubmission(claim(signed))),
    );
    expect(results.filter((result) => result.dispatch)).toHaveLength(1);
    expect((await store.get(owner, 'plan-1'))!.steps[0]!.attempt).toEqual(signed);
    await expect(
      store.claimSubmission(
        claim(await attempt(1), {
          expectedRevision: 1,
          idempotency: idem('new-bytes', 'submit'),
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await store.recoverable(10)).map((value) => value.id)).toEqual(['plan-1']);
  });

  it('reserves a sender nonce globally across actors and never releases it on failure', async () => {
    const { store, transports } = await setup();
    await store.create(plan(), idem('first'), now);
    await store.create(plan('bot-plan', bot), idem('first'), now);
    const signed = await attempt();
    await store.claimSubmission(claim(signed));
    const reserved = (await store.get(owner, 'plan-1'))!;
    reserved.steps[0]!.state = 'reverted';
    await store.save(owner, reserved.id, reserved.revision, reserved.steps);
    await expect(
      store.claimSubmission(claim(signed, { actor: bot, planId: 'bot-plan' })),
    ).rejects.toMatchObject({ status: 409 });
    expect((await store.get(bot, 'bot-plan'))!.revision).toBe(0);
    expect(() => transports.claim('bot-plan', [0], 'relayr', 'after-rejected-nonce')).not.toThrow();
  });

  it('uses revision CAS for observations and prevents changing reserved bytes through save', async () => {
    const { store } = await setup();
    await store.create(plan(), idem('prepare'), now);
    const reserved = await store.claimSubmission(claim(await attempt()));
    const updates = await Promise.allSettled([
      store.save(owner, 'plan-1', 1, reserved.plan.steps),
      store.save(owner, 'plan-1', 1, reserved.plan.steps),
    ]);
    expect(updates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const current = (await store.get(owner, 'plan-1'))!;
    current.steps[0]!.attempt!.rawTransaction = '0x01';
    await expect(
      store.save(owner, current.id, current.revision, current.steps),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('renews expired same-hash leases and ignores stale responses or reconciled terminal state', async () => {
    const { store } = await setup();
    await store.create(plan(), idem('prepare'), now);
    const signed = await attempt();
    await store.claimSubmission(claim(signed));
    const renewed = await store.claimSubmission(
      claim(
        { ...signed, leaseToken: 'lease-2', leaseUntil: now + 30_000 },
        { now: now + 11_000, expectedRevision: 1 },
      ),
    );
    expect(renewed.dispatch).toBe(true);
    expect(renewed.plan.steps[0]!.attempt!.dispatchCount).toBe(2);
    const stale = await store.settleSubmission(owner, 'plan-1', 0, 'lease-1', {
      state: 'unknown',
      lastError: { code: 'timeout', message: 'late response' },
    });
    expect(stale.revision).toBe(renewed.plan.revision);
    renewed.plan.steps[0]!.state = 'confirmed';
    renewed.plan.steps[0]!.receipt = externalProof(0, signed.hash).receipt!;
    renewed.plan.steps[0]!.semantic = { status: 'unmodeled' };
    const confirmed = await store.save(owner, 'plan-1', renewed.plan.revision, renewed.plan.steps);
    const late = await store.settleSubmission(owner, 'plan-1', 0, 'lease-2', {
      state: 'submitted',
      broadcastAt: now + 11_000,
    });
    expect(late.steps[0]).toMatchObject({
      state: 'confirmed', receipt: confirmed.steps[0]!.receipt, semantic: { status: 'unmodeled' },
    });
    const repeat = await store.claimSubmission(
      claim(
        { ...signed, leaseToken: 'lease-3', leaseUntil: now + 50_000 },
        { expectedRevision: confirmed.revision, now: now + 40_000 },
      ),
    );
    expect(repeat.dispatch).toBe(false);
    expect(await store.recoverable(10)).toEqual([]);
  });

  it('persists monitor-only submissions without acquiring or renewing a dispatch lease', async () => {
    const { store } = await setup();
    await store.create(plan(), idem('prepare'), now);
    const signed = await attempt();
    const monitored = await store.claimSubmission(
      claim({ ...signed, leaseUntil: 0, dispatchCount: 0 }, { dispatch: false }),
    );
    expect(monitored.dispatch).toBe(false);
    expect(monitored.plan.steps[0]).toMatchObject({
      state: 'submitted',
      attempt: { leaseUntil: 0, dispatchCount: 0 },
    });
    const repeated = await store.claimSubmission(
      claim(signed, {
        dispatch: false,
        expectedRevision: 1,
        idempotency: idem('retry-monitor', 'submit'),
      }),
    );
    expect(repeated.plan.revision).toBe(1);
    expect(repeated.plan.steps[0]!.attempt!.dispatchCount).toBe(0);
    expect(await store.recoverable(1)).toHaveLength(1);
  });

  it('rejects stale initial reservations and keeps a rejected request key reusable', async () => {
    const { store } = await setup();
    const initial = await store.create(plan(), idem('prepare'), now);
    await store.save(owner, initial.id, initial.revision, initial.steps);
    const submission = claim(await attempt());
    await expect(store.claimSubmission(submission)).rejects.toMatchObject({
      status: 409,
    });
    expect((await store.claimSubmission({ ...submission, expectedRevision: 1 })).dispatch).toBe(
      true,
    );
  });

  it('serializes bot revocation before a queued claim through the shared account mutex', async () => {
    const { accounts, store } = await setup();
    await store.create(plan('plan-1', bot), idem('prepare'), now);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocker = accounts.withActiveActor(owner, ['relay'], now / 1_000, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await started;
    const signed = await attempt();
    const revocation = accounts.revokeBot(account.id, grant.id, now / 1_000);
    const submission = store.claimSubmission(claim(signed, { actor: bot }));
    release();
    await blocker;
    await revocation;
    await expect(submission).rejects.toMatchObject({ status: 403 });
    expect((await store.get(bot, 'plan-1'))!.steps[0]!.attempt).toBeUndefined();
  });

  it('admits a durable claim before a queued revocation, then rejects subsequent dispatch claims', async () => {
    const { accounts, store } = await setup();
    await store.create(plan('plan-1', bot), idem('prepare'), now);
    const submission = store.claimSubmission(claim(await attempt(), { actor: bot }));
    const revocation = accounts.revokeBot(account.id, grant.id, now / 1_000);
    expect((await submission).dispatch).toBe(true);
    await revocation;
    await expect(
      store.claimSubmission(claim(await attempt(), { actor: bot, expectedRevision: 1 })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('paginates deterministically with stable same-timestamp ordering and validates cursors', async () => {
    const { store } = await setup();
    for (const id of ['a', 'b', 'c']) await store.create(plan(id), idem(id), now);
    const first = await store.list(owner, {
      limit: 2,
      account: wallet.address,
    });
    expect(first.items.map((value) => value.id)).toEqual(['c', 'b']);
    const last = await store.list(owner, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(last.items.map((value) => value.id)).toEqual(['a']);
    expect(last.nextCursor).toBeUndefined();
    await expect(store.list(owner, { limit: 2, cursor: 'invalid!' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(store.list(owner, { limit: 1_001 })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('allows account owners to inspect bot plans while preserving mutation and idempotency isolation', async () => {
    const { store } = await setup();
    await store.create(plan('bot-plan', bot), idem('bot-create'), now);
    expect((await store.get(owner, 'bot-plan'))!.actor).toEqual(bot);
    expect((await store.list(owner, { limit: 10 })).items.map((value) => value.id)).toEqual([
      'bot-plan',
    ]);
    expect(await store.findIdempotentPlan(owner, idem('bot-create'))).toBeUndefined();
    expect((await store.findIdempotentPlan(bot, idem('bot-create')))!.id).toBe('bot-plan');
    await expect(
      store.findIdempotentPlan(bot, idem('bot-create', 'prepare', 'changed')),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.claimSubmission(claim(await attempt(), { planId: 'bot-plan' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rechecks expiry and revision before every new dispatch lease', async () => {
    const { store } = await setup();
    await store.create(plan(), idem('prepare'), now);
    const signed = await attempt();
    const reserved = await store.claimSubmission(claim(signed));
    await store.save(owner, 'plan-1', reserved.plan.revision, reserved.plan.steps);
    await expect(
      store.claimSubmission(
        claim(
          { ...signed, leaseToken: 'next', leaseUntil: now + 30_000 },
          { expectedRevision: 1, now: now + 11_000 },
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.claimSubmission(
        claim(
          { ...signed, leaseToken: 'expired', leaseUntil: now + 80_000 },
          { expectedRevision: 2, now: now + 61_000 },
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await store.findIdempotentPlan(owner, idem('prepare')))!.id).toBe('plan-1');
  });

  it('requires canonical successful dependency receipts with acceptable semantic outcomes at claim time', async () => {
    const { store } = await setup();
    const twoStep = plan();
    twoStep.draft.calls.push({ ...twoStep.draft.calls[0]!, dependsOn: [0] });
    twoStep.steps.push({ index: 1, state: 'waiting' });
    await store.create(twoStep, idem('prepare'), now);
    await store.claimSubmission(claim(await attempt()));
    const second = claim(await attempt(1), {
      stepIndex: 1,
      expectedRevision: 1,
      idempotency: idem('second', 'submit'),
    });
    await expect(store.claimSubmission(second)).rejects.toMatchObject({
      status: 409,
    });
    const pending = (await store.get(owner, 'plan-1'))!;
    const first = pending.steps[0]!;
    first.state = 'confirmed';
    first.receipt = {
      transactionHash: first.attempt!.hash,
      blockHash: `0x${'cc'.repeat(32)}`,
      blockNumber: '100',
      status: 'success',
      canonical: true,
      confirmations: 2,
      observedAt: now,
      logs: [],
    };
    first.semantic = { status: 'unknown' };
    const uncertain = await store.save(owner, pending.id, pending.revision, pending.steps);
    await expect(
      store.claimSubmission({
        ...second,
        expectedRevision: uncertain.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    uncertain.steps[0]!.semantic = { status: 'verified' };
    const ready = await store.save(owner, uncertain.id, uncertain.revision, uncertain.steps);
    expect(
      (
        await store.claimSubmission({
          ...second,
          expectedRevision: ready.revision,
        })
      ).dispatch,
    ).toBe(true);
  });

  it('pages recovery without starving newer pending plans when older observations never change', async () => {
    const { store } = await setup();
    for (const [nonce, id] of ['a', 'b', 'c'].entries()) {
      await store.create(plan(id), idem(id), now);
      await store.claimSubmission(
        claim(await attempt(nonce), {
          planId: id,
          idempotency: idem(`submit-${id}`, 'submit'),
          dispatch: false,
        }),
      );
    }
    const first = (await store.recoverable(1))[0]!;
    const second = (await store.recoverable(1, encodeCursor(first)))[0]!;
    const third = (await store.recoverable(1, encodeCursor(second)))[0]!;
    expect([first.id, second.id, third.id]).toEqual(['a', 'b', 'c']);
    expect(await store.recoverable(1, encodeCursor(third))).toEqual([]);
    expect((await store.recoverable(1))[0]!.revision).toBe(first.revision);
  });

  it('serializes competing direct and sponsorship reservations under the same account mutex', async () => {
    for (const first of ['direct', 'relayr']) {
      const { accounts, store, transports } = await setup();
      await store.create(plan(), idem('prepare'), now);
      const sponsorship = new MemorySponsorshipStore(accounts, transports);
      await sponsorship.create(sponsorshipRecord(), now);
      const signed = await attempt();
      const direct = () => store.claimSubmission(claim(signed));
      const sponsored = () =>
        sponsorship.claim({
          actor: owner,
          id: 'sponsorship-preparation',
          key: 'sponsor-publish',
          hash: `0x${'fe'.repeat(32)}`,
          now,
          entries: [
            {
              chain: 1,
              target: recipient,
              data: '0x',
              value: '0',
              virtual_nonce: 0,
            },
          ],
        });
      const outcomes = await Promise.allSettled(
        first === 'direct' ? [direct(), sponsored()] : [sponsored(), direct()],
      );
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: { status: 409, code: 'TRANSPORT_CONFLICT' },
      });
      const current = (await store.get(owner, 'plan-1'))!;
      expect(current.revision).toBe(first === 'direct' ? 1 : 0);
      if (first === 'relayr')
        expect(await store.findIdempotentPlan(owner, idem('submit', 'submit'))).toBeUndefined();
      else {
        expect((await store.claimSubmission(claim(signed))).dispatch).toBe(false);
        expect((await sponsorship.get(owner, 'sponsorship-preparation'))!.state).toBe('prepared');
      }
    }
  });

  it('retains monitor-only and reverted direct bindings and rejects alternate sponsorship binding IDs', async () => {
    const { store, transports } = await setup();
    await store.create(plan(), idem('prepare'), now);
    const monitored = await store.claimSubmission(claim(await attempt(), { dispatch: false }));
    monitored.plan.steps[0]!.state = 'reverted';
    await store.save(owner, 'plan-1', monitored.plan.revision, monitored.plan.steps);
    expect(() => transports.claim('plan-1', [0], 'relayr', 'after-revert')).toThrow(
      expect.objectContaining({ code: 'TRANSPORT_CONFLICT' }),
    );
    transports.claim('another-plan', [0], 'relayr', 'original');
    transports.claim('another-plan', [0], 'relayr', 'original');
    expect(() => transports.claim('another-plan', [0], 'relayr', 'replacement')).toThrow(
      expect.objectContaining({ code: 'TRANSPORT_CONFLICT' }),
    );
  });

  it('makes multi-step transport reservations atomic when an existing step conflicts', async () => {
    const transports = new MemoryTransportReservations();
    transports.claim('plan', [1], 'relayr', 'existing');
    expect(() => transports.claim('plan', [0, 1], 'direct', `0x${'ab'.repeat(32)}`)).toThrow(
      expect.objectContaining({ code: 'TRANSPORT_CONFLICT' }),
    );
    expect(() => transports.claim('plan', [0], 'relayr', 'other')).not.toThrow();
  });

  it('attaches external execution only to existing exact transport bindings without making reservations', async () => {
    const { store, transports } = await setup();
    const original = plan();
    original.draft.calls.push({ ...original.draft.calls[0]!, chainId: 10 });
    original.steps.push({ index: 1, state: 'waiting' });
    await store.create(original, idem('prepare'), now);
    await expect(
      store.reserveExternalExecution(owner, original.id, [0], 'unclaimed'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.get(owner, original.id)).toEqual(original);
    transports.claim(original.id, [0], 'relayr', 'bound');
    await expect(
      store.reserveExternalExecution(owner, original.id, [0], 'wrong-binding'),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.reserveExternalExecution(owner, original.id, [0, 1], 'bound'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.get(owner, original.id)).toEqual(original);
    // The rejected multi-step operation must not reserve the unclaimed second step.
    expect(() => transports.claim(original.id, [1], 'relayr', 'different')).not.toThrow();
    const first = await store.reserveExternalExecution(owner, original.id, [0], 'bound');
    const both = await store.reserveExternalExecution(owner, original.id, [1], 'different');
    expect(first.steps[0]).toEqual({
      index: 0,
      state: 'reserved',
      externalExecution: {
        transport: 'relayr',
        bindingId: 'bound',
        chainId: 1,
      },
    });
    expect(both.steps[1]).toEqual({
      index: 1,
      state: 'reserved',
      externalExecution: {
        transport: 'relayr',
        bindingId: 'different',
        chainId: 10,
      },
    });
    await expect(
      store.claimSubmission(claim(await attempt(), { expectedRevision: both.revision })),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.findIdempotentPlan(owner, idem('submit', 'submit'))).toBeUndefined();
    expect(await store.get(owner, original.id)).toEqual(both);
  });

  it('forbids ordinary saves from forging, removing, or modifying external execution metadata and proof', async () => {
    const { store, transports } = await setup();
    const forgedInitial = plan('forged-initial');
    forgedInitial.steps[0]!.externalExecution = {
      transport: 'relayr',
      bindingId: 'forged',
      chainId: 1,
    };
    await expect(store.create(forgedInitial, idem('forged-initial'), now)).rejects.toMatchObject({
      status: 400,
    });
    expect(await store.get(owner, forgedInitial.id)).toBeUndefined();
    const original = await store.create(plan(), idem('prepare'), now);
    const forged = structuredClone(original.steps);
    forged[0]!.externalExecution = {
      transport: 'relayr',
      bindingId: 'forged',
      chainId: 1,
    };
    await expect(store.save(owner, original.id, original.revision, forged)).rejects.toMatchObject({
      status: 409,
    });
    expect(await store.get(owner, original.id)).toEqual(original);
    transports.claim(original.id, [0], 'relayr', 'external');
    const bound = await store.reserveExternalExecution(owner, original.id, [0], 'external');
    const signed = await attempt();
    for (const change of ['state', 'binding', 'chain', 'remove', 'attempt', 'receipt']) {
      const changed = structuredClone(bound.steps);
      const step = changed[0]!;
      if (change === 'state') step.state = 'confirmed';
      if (change === 'binding') step.externalExecution!.bindingId = 'replacement';
      if (change === 'chain') step.externalExecution!.chainId = 10;
      if (change === 'remove') delete step.externalExecution;
      if (change === 'attempt') step.attempt = signed;
      if (change === 'receipt') step.receipt = externalProof().receipt!;
      await expect(store.save(owner, original.id, bound.revision, changed)).rejects.toMatchObject({
        status: 409,
      });
      expect(await store.get(owner, original.id)).toEqual(bound);
    }
  });

  it('replaces external observation snapshots with revision CAS and matching transaction receipts', async () => {
    const { store, transports } = await setup();
    const original = await store.create(plan(), idem('prepare'), now);
    transports.claim(original.id, [0], 'relayr', 'external');
    const bound = await store.reserveExternalExecution(owner, original.id, [0], 'external');
    const proof = externalProof();
    const forgedProof = { ...proof, attempt: await attempt() };
    await expect(
      store.saveExternalExecution(owner, original.id, bound.revision, 'external', [forgedProof]),
    ).rejects.toMatchObject({ status: 400 });
    expect(await store.get(owner, original.id)).toEqual(bound);
    const confirmed = await store.saveExternalExecution(
      owner,
      original.id,
      bound.revision,
      'external',
      [proof],
    );
    expect(confirmed.steps[0]).toEqual({
      index: 0,
      state: 'confirmed',
      externalExecution: {
        transport: 'relayr',
        bindingId: 'external',
        chainId: 1,
        transactionHash: proof.transactionHash,
      },
      receipt: proof.receipt,
      semantic: proof.semantic,
    });
    await expect(
      store.saveExternalExecution(owner, original.id, bound.revision, 'external', [
        { index: 0, state: 'unknown' },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    const replacementHash = `0x${'ab'.repeat(32)}` as const;
    await expect(
      store.saveExternalExecution(owner, original.id, confirmed.revision, 'external', [
        { ...proof, transactionHash: replacementHash },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    expect(await store.get(owner, original.id)).toEqual(confirmed);
    const replaced = await store.saveExternalExecution(
      owner,
      original.id,
      confirmed.revision,
      'external',
      [externalProof(0, replacementHash)],
    );
    expect(replaced.steps[0]!.receipt!.transactionHash).toBe(replacementHash);
    const reorged = await store.saveExternalExecution(
      owner,
      original.id,
      replaced.revision,
      'external',
      [{ index: 0, state: 'reorged' }],
    );
    expect(reorged.steps[0]).toEqual({
      index: 0,
      state: 'reorged',
      externalExecution: {
        transport: 'relayr',
        bindingId: 'external',
        chainId: 1,
      },
    });
    expect(reorged.steps[0]!.attempt).toBeUndefined();
  });

  it('validates every selected external update before committing any observation', async () => {
    const { store, transports } = await setup();
    const original = plan();
    original.draft.calls.push({ ...original.draft.calls[0]! });
    original.steps.push({ index: 1, state: 'waiting' });
    await store.create(original, idem('prepare'), now);
    transports.claim(original.id, [0], 'relayr', 'first');
    transports.claim(original.id, [1], 'relayr', 'second');
    await store.reserveExternalExecution(owner, original.id, [0], 'first');
    const bound = await store.reserveExternalExecution(owner, original.id, [1], 'second');
    await expect(
      store.saveExternalExecution(owner, original.id, bound.revision, 'first', [
        externalProof(0),
        externalProof(1),
      ]),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.get(owner, original.id)).toEqual(bound);
    const first = await store.saveExternalExecution(owner, original.id, bound.revision, 'first', [
      externalProof(0),
    ]);
    expect(first.steps[1]).toEqual(bound.steps[1]);
    const forwardedFailure: ExternalStepObservation = {
      ...externalProof(1),
      state: 'reverted',
      semantic: {
        status: 'failed',
        details: { forwarderSucceeded: true, innerSucceeded: false },
      },
    };
    const failed = await store.saveExternalExecution(owner, original.id, first.revision, 'second', [
      forwardedFailure,
    ]);
    expect(failed.steps[1]!.state).toBe('reverted');
    expect(failed.steps[1]!.receipt!.status).toBe('success');
    expect(failed.steps[1]!.semantic!.status).toBe('failed');
  });

  it('unlocks dependent direct steps only after a canonical successful external result', async () => {
    const { store, transports } = await setup();
    const original = plan();
    original.draft.calls.push({ ...original.draft.calls[0]!, dependsOn: [0] });
    original.steps.push({ index: 1, state: 'waiting' });
    await store.create(original, idem('prepare'), now);
    transports.claim(original.id, [0], 'relayr', 'external');
    const bound = await store.reserveExternalExecution(owner, original.id, [0], 'external');
    const second = claim(await attempt(1), {
      stepIndex: 1,
      expectedRevision: bound.revision,
      idempotency: idem('dependent', 'submit'),
    });
    await expect(store.claimSubmission(second)).rejects.toMatchObject({
      status: 409,
    });
    const proof = externalProof();
    await expect(
      store.saveExternalExecution(owner, original.id, bound.revision, 'external', [
        { ...proof, receipt: { ...proof.receipt!, canonical: false } },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.saveExternalExecution(owner, original.id, bound.revision, 'external', [
        { ...proof, receipt: { ...proof.receipt!, status: 'reverted' } },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    const unknown = await store.saveExternalExecution(
      owner,
      original.id,
      bound.revision,
      'external',
      [{ ...proof, semantic: { status: 'unknown' } }],
    );
    await expect(
      store.claimSubmission({ ...second, expectedRevision: unknown.revision }),
    ).rejects.toMatchObject({ status: 409 });
    const verified = await store.saveExternalExecution(
      owner,
      original.id,
      unknown.revision,
      'external',
      [proof],
    );
    expect(
      (
        await store.claimSubmission({
          ...second,
          expectedRevision: verified.revision,
        })
      ).dispatch,
    ).toBe(true);
  });

  it('syncs admitted external bindings after revocation with owner read access and exact bot mutation scope', async () => {
    const { accounts, store, transports } = await setup();
    const original = await store.create(plan('bot-external', bot), idem('prepare'), now);
    transports.claim(original.id, [0], 'relayr', 'bot-binding');
    await accounts.revokeBot(account.id, grant.id, now / 1_000 + 1);
    expect((await store.recoverable(100)).map((value) => value.id)).toContain(original.id);
    await expect(
      store.reserveExternalExecution(owner, original.id, [0], 'bot-binding'),
    ).rejects.toMatchObject({ status: 404 });
    const stranger: RestActor = {
      accountId: account.id,
      principalId: 'bot:another',
    };
    await expect(store.syncExternalExecutions(stranger, original.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      store.syncExternalExecutions({ accountId: 'other', principalId: 'owner:other' }, original.id),
    ).rejects.toMatchObject({ status: 404 });
    const synchronized = await store.syncExternalExecutions(owner, original.id);
    expect(synchronized.actor).toEqual(bot);
    expect(synchronized.steps[0]).toEqual({
      index: 0,
      state: 'reserved',
      externalExecution: {
        transport: 'relayr',
        bindingId: 'bot-binding',
        chainId: 1,
      },
    });
    expect(await store.syncExternalExecutions(bot, original.id)).toEqual(synchronized);
    expect(await store.reserveExternalExecution(bot, original.id, [0], 'bot-binding')).toEqual(
      synchronized,
    );
    await expect(
      store.saveExternalExecution(owner, original.id, synchronized.revision, 'bot-binding', [
        externalProof(),
      ]),
    ).rejects.toMatchObject({ status: 404 });
    const observed = await store.saveExternalExecution(
      bot,
      original.id,
      synchronized.revision,
      'bot-binding',
      [{ ...externalProof(), state: 'confirming' }],
    );
    expect(await store.syncExternalExecutions(owner, original.id)).toEqual(observed);
    expect((await store.recoverable(100)).find((value) => value.id === original.id)).toEqual(
      observed,
    );
  });

  it('discovers untagged external bindings alongside active external-only plans during recovery', async () => {
    const { store, transports } = await setup();
    for (const id of ['external-a', 'external-b', 'unbound']) {
      await store.create(plan(id), idem(id), now);
    }
    transports.claim('external-a', [0], 'relayr', 'binding-a');
    transports.claim('external-b', [0], 'relayr', 'binding-b');
    const before = await store.recoverable(100);
    expect(before.map((value) => value.id)).toEqual(['external-a', 'external-b']);
    expect(before.every((value) => value.steps[0]!.externalExecution === undefined)).toBe(true);
    const active = await store.syncExternalExecutions(owner, 'external-a');
    const page = await store.recoverable(1);
    expect(page).toEqual([active]);
    expect((await store.recoverable(1, encodeCursor(active))).map((value) => value.id)).toEqual([
      'external-b',
    ]);
    expect(await store.syncExternalExecutions(owner, 'unbound')).toEqual(
      await store.get(owner, 'unbound'),
    );
    const confirmed = await store.saveExternalExecution(
      owner,
      active.id,
      active.revision,
      'binding-a',
      [externalProof()],
    );
    expect(confirmed.steps[0]!.state).toBe('confirmed');
    expect((await store.recoverable(100)).map((value) => value.id)).toEqual(['external-b']);
  });
});
