import type { Address } from "viem";
import type { RestActor } from "../core.js";
import type {
  ExternalStepObservation,
  IdempotencyClaim,
  StoredPlan,
  StoredStep,
  SubmissionClaim,
} from "./types.js";
import { MemoryTransportReservations } from "./transport-reservations.js";
import {
  TRANSACTION_STORAGE_LIMITS,
  applyExternalObservations,
  assertExternalIndexes,
  attachExternalExecutions,
  assertActor,
  assertIdempotency,
  assertLimit,
  assertNewPlan,
  assertRevision,
  assertSavedSteps,
  assertText,
  boundedClone,
  canRead,
  checkIdempotency,
  conflict,
  decodeCursor,
  encodeCursor,
  idemKey,
  isRecoverable,
  missingPlan,
  nonceKey,
  owns,
  prepareClaim,
  settle,
  storageLimit,
  type ActiveActorGuard,
  type StoredIdempotency,
  type SubmissionPatch,
  type TransactionStore,
} from "./store.js";

/** Test/local implementation. Mutation callbacks never yield after checking shared account authority. */
export class MemoryTransactionStore implements TransactionStore {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly idempotency = new Map<
    string,
    StoredIdempotency & { accountId: string }
  >();
  private readonly nonces = new Map<
    string,
    { planId: string; stepIndex: number }
  >();
  constructor(
    private readonly authority: ActiveActorGuard,
    private readonly transports = new MemoryTransportReservations(),
  ) {}

  private require(actor: RestActor, id: string): StoredPlan {
    assertActor(actor);
    assertText(id);
    const plan = this.plans.get(id);
    if (!plan || !owns(plan, actor)) return missingPlan();
    return plan;
  }
  private reserveIdempotency(
    actor: RestActor,
    claim: IdempotencyClaim,
    planId: string,
    stepIndex: number | null,
  ): void {
    if (this.idempotency.has(idemKey(actor, claim.key))) return;
    this.assertIdempotencyCapacity(actor);
    this.idempotency.set(idemKey(actor, claim.key), {
      ...claim,
      planId,
      stepIndex,
      accountId: actor.accountId,
    });
  }
  private assertIdempotencyCapacity(actor: RestActor): void {
    if (
      [...this.idempotency.values()].filter(
        (entry) => entry.accountId === actor.accountId,
      ).length >= TRANSACTION_STORAGE_LIMITS.idempotencyPerAccount
    )
      storageLimit();
  }
  async create(
    input: StoredPlan,
    claim: IdempotencyClaim,
    now: number,
  ): Promise<StoredPlan> {
    assertNewPlan(input, now);
    assertIdempotency(claim);
    const plan = boundedClone(input);
    claim = structuredClone(claim);
    return this.authority.withActiveActor(
      plan.actor,
      ["plan"],
      Math.floor(now / 1_000),
      async () => {
        const existing = this.idempotency.get(idemKey(plan.actor, claim.key));
        checkIdempotency(existing, claim);
        if (existing)
          return boundedClone(this.require(plan.actor, existing.planId));
        if (this.plans.has(plan.id))
          conflict("Transaction plan ID already exists.");
        if (
          [...this.plans.values()].filter(
            (entry) => entry.actor.accountId === plan.actor.accountId,
          ).length >= TRANSACTION_STORAGE_LIMITS.plansPerAccount
        )
          storageLimit();
        this.reserveIdempotency(plan.actor, claim, plan.id, null);
        this.plans.set(plan.id, plan);
        return boundedClone(plan);
      },
    );
  }
  async get(actor: RestActor, id: string): Promise<StoredPlan | undefined> {
    assertActor(actor);
    assertText(id);
    const plan = this.plans.get(id);
    return plan && canRead(plan, actor) ? boundedClone(plan) : undefined;
  }
  async findIdempotentPlan(
    actor: RestActor,
    claim: IdempotencyClaim,
  ): Promise<StoredPlan | undefined> {
    assertActor(actor);
    assertIdempotency(claim);
    const existing = this.idempotency.get(idemKey(actor, claim.key));
    checkIdempotency(existing, claim);
    return existing
      ? boundedClone(this.require(actor, existing.planId))
      : undefined;
  }

  async list(
    actor: RestActor,
    options: { account?: Address; limit: number; cursor?: string },
  ): Promise<{ items: StoredPlan[]; nextCursor?: string }> {
    assertActor(actor);
    assertLimit(options.limit);
    const cursor = decodeCursor(options.cursor);
    const rows = [...this.plans.values()]
      .filter(
        (plan) =>
          canRead(plan, actor) &&
          (!options.account ||
            plan.draft.account.toLowerCase() ===
              options.account.toLowerCase()) &&
          (!cursor ||
            plan.createdAt < cursor.createdAt ||
            (plan.createdAt === cursor.createdAt &&
              Buffer.compare(Buffer.from(plan.id), Buffer.from(cursor.id)) <
                0)),
      )
      .sort(
        (a, b) =>
          b.createdAt - a.createdAt ||
          Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
      );
    const items = rows.slice(0, options.limit);
    return {
      items: structuredClone(items),
      ...(rows.length > options.limit
        ? { nextCursor: encodeCursor(items.at(-1)!) }
        : {}),
    };
  }
  async claimSubmission(
    claim: SubmissionClaim,
  ): Promise<{ plan: StoredPlan; dispatch: boolean }> {
    assertActor(claim.actor);
    assertIdempotency(claim.idempotency);
    claim = boundedClone(claim);
    const started = performance.now();
    return this.authority.withActiveActor(
      claim.actor,
      ["relay"],
      Math.floor(claim.now / 1_000),
      async () => {
        const current = this.require(claim.actor, claim.planId);
        checkIdempotency(
          this.idempotency.get(idemKey(claim.actor, claim.idempotency.key)),
          claim.idempotency,
          { planId: claim.planId, stepIndex: claim.stepIndex },
        );
        const result = prepareClaim(current, {
          ...claim,
          now: claim.now + Math.floor(performance.now() - started),
        });
        const reservation = this.nonces.get(nonceKey(claim.attempt));
        if (
          reservation &&
          (reservation.planId !== claim.planId ||
            reservation.stepIndex !== claim.stepIndex)
        )
          conflict(
            "Sender nonce is already reserved by another transaction step.",
          );
        if (!this.idempotency.has(idemKey(claim.actor, claim.idempotency.key)))
          this.assertIdempotencyCapacity(claim.actor);
        this.transports.claim(
          claim.planId,
          [claim.stepIndex],
          "direct",
          claim.attempt.hash.toLowerCase(),
        );
        this.reserveIdempotency(
          claim.actor,
          claim.idempotency,
          claim.planId,
          claim.stepIndex,
        );
        this.nonces.set(nonceKey(claim.attempt), {
          planId: claim.planId,
          stepIndex: claim.stepIndex,
        });
        if (result.changed) this.plans.set(claim.planId, result.plan);
        return { plan: boundedClone(result.plan), dispatch: result.dispatch };
      },
    );
  }
  async save(
    actor: RestActor,
    id: string,
    expectedRevision: number,
    steps: StoredStep[],
  ): Promise<StoredPlan> {
    assertRevision(expectedRevision);
    const plan = this.require(actor, id);
    if (plan.revision !== expectedRevision)
      conflict("Transaction plan changed; inspect it before retrying.");
    assertSavedSteps(plan, steps);
    const next = boundedClone({ ...plan, revision: plan.revision + 1, steps });
    this.plans.set(id, next);
    return boundedClone(next);
  }
  async reserveExternalExecution(
    actor: RestActor,
    planId: string,
    stepIndexes: readonly number[],
    bindingId: string,
  ): Promise<StoredPlan> {
    const current = this.require(actor, planId);
    assertExternalIndexes(current, stepIndexes);
    this.transports.assertClaimed(planId, stepIndexes, "relayr", bindingId);
    const next = attachExternalExecutions(
      current,
      stepIndexes.map((stepIndex) => ({
        stepIndex,
        transport: "relayr",
        bindingId,
      })),
    );
    if (next.revision !== current.revision) this.plans.set(planId, next);
    return boundedClone(next);
  }
  async saveExternalExecution(
    actor: RestActor,
    planId: string,
    expectedRevision: number,
    bindingId: string,
    updates: readonly ExternalStepObservation[],
  ): Promise<StoredPlan> {
    assertRevision(expectedRevision);
    const current = this.require(actor, planId);
    if (current.revision !== expectedRevision)
      conflict("Transaction plan changed; inspect it before retrying.");
    const next = applyExternalObservations(current, bindingId, updates);
    for (const update of updates)
      this.transports.assertClaimed(
        planId,
        [update.index],
        current.steps[update.index]!.externalExecution!.transport,
        bindingId,
      );
    if (next.revision !== current.revision) this.plans.set(planId, next);
    return boundedClone(next);
  }
  async syncExternalExecutions(
    actor: RestActor,
    planId: string,
  ): Promise<StoredPlan> {
    assertActor(actor);
    assertText(planId);
    const current = this.plans.get(planId);
    if (!current || !canRead(current, actor)) return missingPlan();
    const next = attachExternalExecutions(
      current,
      this.transports.list(planId),
    );
    if (next.revision !== current.revision) this.plans.set(planId, next);
    return boundedClone(next);
  }
  async settleSubmission(
    actor: RestActor,
    id: string,
    index: number,
    leaseToken: string,
    patch: SubmissionPatch,
  ): Promise<StoredPlan> {
    const next = settle(this.require(actor, id), index, leaseToken, patch);
    this.plans.set(id, next);
    return boundedClone(next);
  }
  async recoverable(
    limit: number,
    cursorValue?: string,
  ): Promise<StoredPlan[]> {
    assertLimit(limit);
    const cursor = decodeCursor(cursorValue);
    return structuredClone(
      [...this.plans.values()]
        .filter(
          (plan) =>
            (isRecoverable(plan) ||
              this.transports
                .list(plan.id)
                .some(
                  (binding) =>
                    (binding.transport === "relayr" ||
                      binding.transport === "erc4337") &&
                    !plan.steps[binding.stepIndex]?.externalExecution,
                )) &&
            (!cursor ||
              plan.createdAt > cursor.createdAt ||
              (plan.createdAt === cursor.createdAt &&
                Buffer.compare(Buffer.from(plan.id), Buffer.from(cursor.id)) >
                  0)),
        )
        .sort(
          (a, b) =>
            a.createdAt - b.createdAt ||
            Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
        )
        .slice(0, limit),
    );
  }
}
