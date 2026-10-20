import { toHex, type Address, type Hex } from 'viem';
import type { RestActor } from '../core.js';
import { assertActor, assertText, type ActiveActorGuard } from '../transactions/store.js';
import { MemoryTransportReservations } from '../transactions/transport-reservations.js';
import type { UserOperationObservation } from './types.js';
import {
  USER_OPERATION_LIMITS,
  assertClaim,
  assertLimit,
  assertNew,
  canRead,
  claimed,
  clone,
  conflict,
  defaultCodec,
  dispatchRecord,
  fail,
  isRecoverable,
  key,
  missing,
  nonceKey,
  observed,
  owns,
  preparationKey,
  readCursor,
  assertRetiredChecked,
  retiring,
  same,
  settled,
  type UserOperationClaim,
  type UserOperationRecord,
  type UserOperationStore,
} from './store.js';

export interface MemoryUserOperationOptions {
  /** Synchronous, fail-closed plan/binding/session check inside the same account mutex.
   * For the actual stored plan, call assertPlan and the session store's
   * assertUserOperationLifecyclePlan; setup/revocation drafts need durable lifecycle admission.
   */
  assertBindingAndSession(record: UserOperationRecord, nowSeconds: number): void;
  now?: () => number;
}
/** Local/test persistence. Production must use the database implementation. */
export class MemoryUserOperationStore implements UserOperationStore {
  private readonly records = new Map<string, UserOperationRecord>();
  private readonly preparations = new Map<string, string>();
  private readonly submissions = new Map<string, string>();
  private readonly nonces = new Map<string, { id: string; commitment: Hex }>();
  constructor(
    private readonly authority: ActiveActorGuard,
    private readonly transports: MemoryTransportReservations,
    private readonly options: MemoryUserOperationOptions,
  ) {
    if (typeof options?.assertBindingAndSession !== 'function')
      fail(
        'USER_OPERATION_AUTHORITY_NOT_CONFIGURED',
        'A synchronous current binding/session guard is required.',
        503,
      );
  }
  private clock() {
    return (this.options.now ?? Date.now)();
  }
  private required(actor: RestActor, id: string) {
    assertActor(actor);
    assertText(id);
    const record = this.records.get(id);
    return record && owns(record, actor) ? record : missing();
  }
  async find(actor: RestActor, preparation: string, inputHash: Hex) {
    assertActor(actor);
    key(preparation);
    const id = this.preparations.get(preparationKey(actor, preparation));
    if (!id) return undefined;
    const record = this.required(actor, id);
    if (!same(record.inputHash, inputHash)) conflict();
    return clone(record);
  }
  async create(input: UserOperationRecord, now: number) {
    assertNew(input, now, defaultCodec);
    const record = clone(input);
    return this.authority.withActiveActor(
      record.actor,
      ['plan'],
      Math.floor(this.clock() / 1000),
      async () => {
        const previous = this.preparations.get(preparationKey(record.actor, record.preparationKey));
        if (previous) {
          const stored = this.required(record.actor, previous);
          if (!same(stored.inputHash, record.inputHash)) conflict();
          return clone(stored);
        }
        assertNew(record, this.clock(), defaultCodec);
        this.options.assertBindingAndSession(record, Math.floor(this.clock() / 1000));
        if (this.records.has(record.id)) conflict();
        if (
          [...this.records.values()].filter(
            (value) => value.actor.accountId === record.actor.accountId,
          ).length >= USER_OPERATION_LIMITS.recordsPerAccount
        )
          fail(
            'USER_OPERATION_STORAGE_LIMIT',
            'Account UserOperation record capacity reached.',
            429,
          );
        this.preparations.set(preparationKey(record.actor, record.preparationKey), record.id);
        this.records.set(record.id, record);
        return clone(record);
      },
    );
  }
  async get(actor: RestActor, id: string) {
    assertActor(actor);
    assertText(id);
    const record = this.records.get(id);
    return record && canRead(record, actor) ? clone(record) : undefined;
  }
  async claim(input: UserOperationClaim) {
    assertClaim(input);
    input = clone(input);
    return this.authority.withActiveActor(
      input.actor,
      ['relay'],
      Math.floor(this.clock() / 1000),
      async () => {
        const record = this.required(input.actor, input.id);
        const used = this.submissions.get(preparationKey(input.actor, input.key));
        if (used && used !== input.id) conflict();
        let result = claimed(record, { ...input, now: this.clock() }, defaultCodec);
        if (!result.dispatch) return result;
        assertRetiredChecked(record, input, this.unsettled(record.chainId, record.sender));
        this.options.assertBindingAndSession(
          dispatchRecord(record, input),
          Math.floor(this.clock() / 1000),
        );
        const reservation = this.nonces.get(nonceKey(record));
        if (
          reservation &&
          (reservation.id !== record.id || !same(reservation.commitment, input.signedCommitment))
        )
          fail(
            'USER_OPERATION_NONCE_CONFLICT',
            'The full sender nonce is permanently reserved by another UserOperation.',
          );
        // All fallible work, including cloning, must precede the synchronous shared reservation.
        result = claimed(record, { ...input, now: this.clock() }, defaultCodec);
        const stored = clone(result.record);
        this.transports.claim(record.planId, record.stepIndexes, 'erc4337', record.id);
        this.nonces.set(nonceKey(record), { id: record.id, commitment: input.signedCommitment });
        this.submissions.set(preparationKey(input.actor, input.key), record.id);
        this.records.set(record.id, stored);
        return result;
      },
    );
  }
  async settle(id: string, commitment: Hex, state: 'pending' | 'submission_unknown') {
    assertText(id);
    const next = settled(this.records.get(id) ?? missing(), commitment, state);
    this.records.set(id, next);
    return clone(next);
  }
  async observe(id: string, revision: number, observation: UserOperationObservation) {
    assertText(id);
    const next = observed(this.records.get(id) ?? missing(), revision, clone(observation));
    if (next.state === 'expired') this.nonces.delete(nonceKey(next));
    this.records.set(id, next);
    return clone(next);
  }
  async retire(actor: RestActor, id: string) {
    return this.authority.withActiveActor(actor, ['relay'], Math.floor(this.clock() / 1000), async () => {
      const next = retiring(this.required(actor, id));
      this.records.set(id, next);
      return clone(next);
    });
  }
  private unsettled(chainId: number, sender: Address) {
    return [...this.records.values()].filter((record) => record.state === 'retired' && record.retiredSettledAt === undefined &&
      record.chainId === chainId && same(record.sender, sender));
  }
  async retired(chainId: number, sender: Address) {
    return clone(this.unsettled(chainId, sender));
  }
  async settleRetired(id: string) {
    const record = this.records.get(id);
    if (record?.state === 'retired' && record.retiredSettledAt === undefined)
      this.records.set(id, { ...record, retiredSettledAt: this.clock(), revision: record.revision + 1 });
  }
  async nonceHolder(chainId: number, sender: Address, nonce: bigint) {
    const held = this.nonces.get(nonceKey({ chainId, sender, operation: { nonce: toHex(nonce) } }));
    const record = held && this.records.get(held.id);
    return record ? clone(record) : undefined;
  }
  async recoverable(limit: number, cursor?: string) {
    assertLimit(limit);
    const after = readCursor(cursor);
    return clone(
      [...this.records.values()]
        .filter(
          (record) =>
            isRecoverable(record) &&
            (!after ||
              record.createdAt > after.createdAt ||
              (record.createdAt === after.createdAt && record.id > after.id)),
        )
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit),
    );
  }
}
