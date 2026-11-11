import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Address } from "viem";
import { assertRestActorActive } from "../auth/postgres.js";
import type { RestActor } from "../core.js";
import type {
  ExternalStepObservation,
  IdempotencyClaim,
  StoredPlan,
  StoredStep,
  SubmissionClaim,
} from "./types.js";
import {
  assertPostgresTransport,
  claimPostgresTransport,
  getPostgresTransports,
} from "./transport-reservations.js";
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
  assertTime,
  boundedClone,
  checkIdempotency,
  conflict,
  decodeCursor,
  encodeCursor,
  missingPlan,
  invalid,
  prepareClaim,
  settle,
  storageLimit,
  type StoredIdempotency,
  type SubmissionPatch,
  type TransactionStore,
} from "./store.js";

type PlanRow = QueryResultRow & { document: StoredPlan };
type IdempotencyRow = QueryResultRow & {
  key: string;
  request_hash: string;
  operation: string;
  plan_id: string;
  step_index: number | null;
};
const selectPlan = "SELECT document FROM rest_transaction_plans";

async function databaseMilliseconds(client: PoolClient): Promise<number> {
  const result = await client.query<{ now: string }>(
    "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now",
  );
  return Number(result.rows[0]!.now);
}

/** PostgreSQL is the coordination authority; no process-local mutex or network work occurs here. */
export class PostgresTransactionStore implements TransactionStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Preserve the original storage failure. */
      }
      throw error;
    } finally {
      client.release();
    }
  }
  private async require(
    client: PoolClient,
    actor: RestActor,
    id: string,
  ): Promise<StoredPlan> {
    assertActor(actor);
    assertText(id);
    const result = await client.query<PlanRow>(
      `${selectPlan} WHERE id = $1 AND account_id = $2 AND principal_id = $3 FOR UPDATE`,
      [id, actor.accountId, actor.principalId],
    );
    return result.rows[0]
      ? boundedClone(result.rows[0].document)
      : missingPlan();
  }
  private async idempotency(
    client: PoolClient,
    actor: RestActor,
    claim: IdempotencyClaim,
  ): Promise<StoredIdempotency | undefined> {
    const result = await client.query<IdempotencyRow>(
      "SELECT key, request_hash, operation, plan_id, step_index FROM rest_transaction_idempotency WHERE account_id = $1 AND principal_id = $2 AND key = $3",
      [actor.accountId, actor.principalId, claim.key],
    );
    const row = result.rows[0];
    return row
      ? {
          key: row.key,
          requestHash: row.request_hash,
          operation: row.operation,
          planId: row.plan_id,
          stepIndex: row.step_index,
        }
      : undefined;
  }
  private async reserveIdempotency(
    client: PoolClient,
    actor: RestActor,
    claim: IdempotencyClaim,
    planId: string,
    stepIndex: number | null,
    existing: StoredIdempotency | undefined,
  ): Promise<void> {
    if (existing) return;
    const usage = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rest_transaction_idempotency WHERE account_id = $1",
      [actor.accountId],
    );
    if (
      Number(usage.rows[0]!.count) >=
      TRANSACTION_STORAGE_LIMITS.idempotencyPerAccount
    )
      storageLimit();
    await client.query(
      "INSERT INTO rest_transaction_idempotency (account_id, principal_id, key, request_hash, operation, plan_id, step_index) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        actor.accountId,
        actor.principalId,
        claim.key,
        claim.requestHash,
        claim.operation,
        planId,
        stepIndex,
      ],
    );
  }
  private async update(client: PoolClient, plan: StoredPlan): Promise<void> {
    boundedClone(plan);
    await client.query(
      "UPDATE rest_transaction_plans SET revision = $2, document = $3::jsonb WHERE id = $1",
      [plan.id, plan.revision, JSON.stringify(plan)],
    );
  }
  async create(
    input: StoredPlan,
    claim: IdempotencyClaim,
    now: number,
  ): Promise<StoredPlan> {
    assertNewPlan(input, now);
    assertIdempotency(claim);
    const plan = boundedClone(input);
    const idempotency = structuredClone(claim);
    return this.transaction(async (client) => {
      await assertRestActorActive(
        client,
        plan.actor,
        ["plan"],
        Math.floor(now / 1_000),
      );
      const existing = await this.idempotency(client, plan.actor, idempotency);
      checkIdempotency(existing, idempotency);
      if (existing) return this.require(client, plan.actor, existing.planId);
      // createdAt was validated on the app clock that stamped it. Recheck
      // expiry against both clocks without requiring millisecond clock equality.
      assertNewPlan(plan, Math.max(now, await databaseMilliseconds(client)));
      const usage = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rest_transaction_plans WHERE account_id = $1",
        [plan.actor.accountId],
      );
      if (
        Number(usage.rows[0]!.count) >=
        TRANSACTION_STORAGE_LIMITS.plansPerAccount
      )
        storageLimit();
      const inserted = await client.query(
        "INSERT INTO rest_transaction_plans (id, account_id, principal_id, account_address, created_at, expires_at, revision, document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id",
        [
          plan.id,
          plan.actor.accountId,
          plan.actor.principalId,
          plan.draft.account.toLowerCase(),
          plan.createdAt,
          plan.expiresAt,
          plan.revision,
          JSON.stringify(plan),
        ],
      );
      if (!inserted.rowCount) conflict("Transaction plan ID already exists.");
      await this.reserveIdempotency(
        client,
        plan.actor,
        idempotency,
        plan.id,
        null,
        existing,
      );
      await assertRestActorActive(
        client,
        plan.actor,
        ["plan"],
        Math.floor(now / 1_000),
      );
      assertNewPlan(plan, Math.max(now, await databaseMilliseconds(client)));
      return boundedClone(plan);
    });
  }
  async get(actor: RestActor, id: string): Promise<StoredPlan | undefined> {
    assertActor(actor);
    assertText(id);
    const result = await this.pool.query<PlanRow>(
      `${selectPlan} WHERE id = $1 AND account_id = $2 AND (principal_id = $3 OR $4::boolean)`,
      [
        id,
        actor.accountId,
        actor.principalId,
        actor.principalId === `owner:${actor.accountId}`,
      ],
    );
    return result.rows[0] ? boundedClone(result.rows[0].document) : undefined;
  }
  async findIdempotentPlan(
    actor: RestActor,
    claim: IdempotencyClaim,
  ): Promise<StoredPlan | undefined> {
    assertActor(actor);
    assertIdempotency(claim);
    const result = await this.pool.query<IdempotencyRow & PlanRow>(
      "SELECT i.key, i.request_hash, i.operation, i.plan_id, i.step_index, p.document FROM rest_transaction_idempotency i JOIN rest_transaction_plans p ON p.id = i.plan_id WHERE i.account_id = $1 AND i.principal_id = $2 AND i.key = $3",
      [actor.accountId, actor.principalId, claim.key],
    );
    const row = result.rows[0];
    checkIdempotency(
      row
        ? {
            key: row.key,
            requestHash: row.request_hash,
            operation: row.operation,
            planId: row.plan_id,
            stepIndex: row.step_index,
          }
        : undefined,
      claim,
    );
    return row ? boundedClone(row.document) : undefined;
  }

  async list(
    actor: RestActor,
    options: { account?: Address; limit: number; cursor?: string },
  ): Promise<{ items: StoredPlan[]; nextCursor?: string }> {
    assertActor(actor);
    assertLimit(options.limit);
    const cursor = decodeCursor(options.cursor);
    const result = await this.pool.query<PlanRow>(
      `${selectPlan} WHERE account_id = $1 AND (principal_id = $2 OR $7::boolean) AND ($3::text IS NULL OR account_address = $3) AND ($4::bigint IS NULL OR (created_at, id COLLATE "C") < ($4::bigint, $5::text COLLATE "C")) ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $6`,
      [
        actor.accountId,
        actor.principalId,
        options.account?.toLowerCase() ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        options.limit + 1,
        actor.principalId === `owner:${actor.accountId}`,
      ],
    );
    const items = result.rows
      .slice(0, options.limit)
      .map((row) => boundedClone(row.document));
    return {
      items,
      ...(result.rows.length > options.limit
        ? { nextCursor: encodeCursor(items.at(-1)!) }
        : {}),
    };
  }
  async claimSubmission(
    input: SubmissionClaim,
  ): Promise<{ plan: StoredPlan; dispatch: boolean }> {
    assertActor(input.actor);
    assertIdempotency(input.idempotency);
    const claim = boundedClone(input);
    assertTime(claim.now);
    return this.transaction(async (client) => {
      // This lock is shared with grant revocation. Commit the durable job before any dispatch.
      await assertRestActorActive(
        client,
        claim.actor,
        ["relay"],
        Math.floor(claim.now / 1_000),
      );
      const current = await this.require(client, claim.actor, claim.planId);
      const existing = await this.idempotency(
        client,
        claim.actor,
        claim.idempotency,
      );
      checkIdempotency(existing, claim.idempotency, {
        planId: claim.planId,
        stepIndex: claim.stepIndex,
      });
      // All replicas compare leases against one clock. Preserve only the requested duration,
      // never an application instance's possibly skewed absolute lease deadline.
      const databaseNow = await databaseMilliseconds(client);
      const duration = claim.attempt.leaseUntil - claim.now;
      if (
        claim.dispatch &&
        (!Number.isSafeInteger(duration) || duration < 1 || duration > 120_000)
      )
        invalid(
          "Dispatch lease duration must be between 1 and 120000 milliseconds.",
        );
      let result = prepareClaim(current, {
        ...claim,
        now: databaseNow,
        attempt: {
          ...claim.attempt,
          reservedAt: databaseNow,
          leaseUntil: claim.dispatch ? databaseNow + duration : 0,
        },
      });
      const attempt = claim.attempt;
      await claimPostgresTransport(
        client,
        claim.planId,
        [claim.stepIndex],
        "direct",
        attempt.hash.toLowerCase(),
      );
      await client.query(
        "INSERT INTO rest_transaction_nonces (chain_id, sender, nonce, transaction_hash, plan_id, step_index) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (chain_id, sender, nonce) DO NOTHING",
        [
          attempt.chainId,
          attempt.sender.toLowerCase(),
          attempt.nonce,
          attempt.hash.toLowerCase(),
          claim.planId,
          claim.stepIndex,
        ],
      );
      const reservation = await client.query<{
        transaction_hash: string;
        plan_id: string;
        step_index: number;
      }>(
        "SELECT transaction_hash, plan_id, step_index FROM rest_transaction_nonces WHERE chain_id = $1 AND sender = $2 AND nonce = $3",
        [attempt.chainId, attempt.sender.toLowerCase(), attempt.nonce],
      );
      const reserved = reservation.rows[0];
      if (
        !reserved ||
        reserved.plan_id !== claim.planId ||
        reserved.step_index !== claim.stepIndex ||
        reserved.transaction_hash !== attempt.hash.toLowerCase()
      )
        conflict(
          "Sender nonce is already reserved by another transaction step.",
        );
      await this.reserveIdempotency(
        client,
        claim.actor,
        claim.idempotency,
        claim.planId,
        claim.stepIndex,
        existing,
      );
      if (result.dispatch) {
        // A conflicting global nonce insertion may have waited for another account's
        // transaction. Recheck expiry and mint the lease only after those waits finish.
        await assertRestActorActive(
          client,
          claim.actor,
          ["relay"],
          Math.floor(claim.now / 1_000),
        );
        const committedAt = await databaseMilliseconds(client);
        result = prepareClaim(current, {
          ...claim,
          now: committedAt,
          attempt: {
            ...claim.attempt,
            reservedAt: committedAt,
            leaseUntil: committedAt + duration,
          },
        });
      }
      if (result.changed) await this.update(client, result.plan);
      return { plan: boundedClone(result.plan), dispatch: result.dispatch };
    });
  }
  async save(
    actor: RestActor,
    id: string,
    expectedRevision: number,
    input: StoredStep[],
  ): Promise<StoredPlan> {
    assertRevision(expectedRevision);
    const steps = boundedClone(input);
    return this.transaction(async (client) => {
      const current = await this.require(client, actor, id);
      if (current.revision !== expectedRevision)
        conflict("Transaction plan changed; inspect it before retrying.");
      assertSavedSteps(current, steps);
      const next = boundedClone({
        ...current,
        revision: current.revision + 1,
        steps,
      });
      await this.update(client, next);
      return next;
    });
  }
  async settleSubmission(
    actor: RestActor,
    id: string,
    index: number,
    leaseToken: string,
    input: SubmissionPatch,
  ): Promise<StoredPlan> {
    const patch = boundedClone(input);
    return this.transaction(async (client) => {
      const current = await this.require(client, actor, id);
      const next = settle(current, index, leaseToken, patch);
      if (next.revision !== current.revision) await this.update(client, next);
      return boundedClone(next);
    });
  }
  async reserveExternalExecution(
    actor: RestActor,
    planId: string,
    input: readonly number[],
    bindingId: string,
  ): Promise<StoredPlan> {
    const indexes = structuredClone(input);
    return this.transaction(async (client) => {
      const current = await this.require(client, actor, planId);
      assertExternalIndexes(current, indexes);
      await assertPostgresTransport(
        client,
        planId,
        indexes,
        "relayr",
        bindingId,
      );
      const next = attachExternalExecutions(
        current,
        indexes.map((stepIndex) => ({
          stepIndex,
          transport: "relayr",
          bindingId,
        })),
      );
      if (next.revision !== current.revision) await this.update(client, next);
      return boundedClone(next);
    });
  }
  async saveExternalExecution(
    actor: RestActor,
    planId: string,
    expectedRevision: number,
    bindingId: string,
    input: readonly ExternalStepObservation[],
  ): Promise<StoredPlan> {
    assertRevision(expectedRevision);
    const updates = boundedClone(input);
    return this.transaction(async (client) => {
      const current = await this.require(client, actor, planId);
      if (current.revision !== expectedRevision)
        conflict("Transaction plan changed; inspect it before retrying.");
      const next = applyExternalObservations(current, bindingId, updates);
      for (const transport of ["relayr", "erc4337"] as const) {
        const indexes = updates
          .filter(
            (update) => current.steps[update.index]!.externalExecution!.transport === transport,
          )
          .map((update) => update.index);
        if (indexes.length)
          await assertPostgresTransport(
            client, planId, indexes, transport, bindingId,
          );
      }
      if (next.revision !== current.revision) await this.update(client, next);
      return boundedClone(next);
    });
  }
  async syncExternalExecutions(
    actor: RestActor,
    planId: string,
  ): Promise<StoredPlan> {
    assertActor(actor);
    assertText(planId);
    return this.transaction(async (client) => {
      const result = await client.query<PlanRow>(
        `${selectPlan} WHERE id = $1 AND account_id = $2 AND (principal_id = $3 OR $4::boolean) FOR UPDATE`,
        [
          planId,
          actor.accountId,
          actor.principalId,
          actor.principalId === `owner:${actor.accountId}`,
        ],
      );
      const current = result.rows[0]?.document ?? missingPlan();
      const next = attachExternalExecutions(
        current,
        await getPostgresTransports(client, planId),
      );
      if (next.revision !== current.revision) await this.update(client, next);
      return boundedClone(next);
    });
  }
  async recoverable(
    limit: number,
    cursorValue?: string,
  ): Promise<StoredPlan[]> {
    assertLimit(limit);
    const cursor = decodeCursor(cursorValue);
    const result = await this.pool.query<PlanRow>(
      `${selectPlan} p WHERE (jsonb_path_exists(document, '$.steps[*] ? ((exists(@.attempt) || exists(@.externalExecution)) && (@.state == "reserved" || @.state == "submitted" || @.state == "unknown" || @.state == "confirming" || @.state == "reorged" || (@.state == "confirmed" && (!exists(@.semantic.status) || @.semantic.status == "unknown"))))') OR EXISTS (SELECT 1 FROM rest_transaction_transports t WHERE t.plan_id = p.id AND t.transport IN ('relayr', 'erc4337') AND p.document->'steps'->t.step_index->'externalExecution' IS NULL)) AND ($2::bigint IS NULL OR (created_at, id COLLATE "C") > ($2::bigint, $3::text COLLATE "C")) ORDER BY created_at, id COLLATE "C" LIMIT $1`,
      [limit, cursor?.createdAt ?? null, cursor?.id ?? null],
    );
    return result.rows.map((row) => boundedClone(row.document));
  }
}
