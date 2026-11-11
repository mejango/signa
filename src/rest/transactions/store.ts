import type { Address } from "viem";
import { isDeepStrictEqual } from "node:util";
import { RestError, type RestActor } from "../core.js";
import type { BotScope } from "../auth/store.js";
import type {
  IdempotencyClaim,
  SignedAttempt,
  StepState,
  StoredPlan,
  StoredStep,
  SubmissionClaim,
  ExternalStepObservation,
} from "./types.js";
import type { TransportReservation } from "./transport-reservations.js";

export interface TransactionStore {
  create(
    plan: StoredPlan,
    idempotency: IdempotencyClaim,
    now: number,
  ): Promise<StoredPlan>;
  findIdempotentPlan(
    actor: RestActor,
    idempotency: IdempotencyClaim,
  ): Promise<StoredPlan | undefined>;
  get(actor: RestActor, id: string): Promise<StoredPlan | undefined>;
  list(
    actor: RestActor,
    options: { account?: Address; limit: number; cursor?: string },
  ): Promise<{ items: StoredPlan[]; nextCursor?: string }>;
  claimSubmission(
    claim: SubmissionClaim,
  ): Promise<{ plan: StoredPlan; dispatch: boolean }>;
  reserveExternalExecution(
    actor: RestActor,
    planId: string,
    stepIndexes: readonly number[],
    bindingId: string,
  ): Promise<StoredPlan>;
  saveExternalExecution(
    actor: RestActor,
    planId: string,
    expectedRevision: number,
    bindingId: string,
    updates: readonly ExternalStepObservation[],
  ): Promise<StoredPlan>;
  /** Recover the gap between durable sponsorship admission and tagging the original journey. */
  syncExternalExecutions(actor: RestActor, planId: string): Promise<StoredPlan>;
  save(
    actor: RestActor,
    id: string,
    expectedRevision: number,
    steps: StoredStep[],
  ): Promise<StoredPlan>;
  settleSubmission(
    actor: RestActor,
    id: string,
    index: number,
    leaseToken: string,
    patch: SubmissionPatch,
  ): Promise<StoredPlan>;
  /** Internal recovery discovery only. This can expose signed transaction bytes. */
  recoverable(limit: number, cursor?: string): Promise<StoredPlan[]>;
}

export interface SubmissionPatch {
  state: StepState;
  broadcastAt?: number;
  lastError?: { code: string; message: string };
}
export interface ActiveActorGuard {
  withActiveActor<T>(
    actor: RestActor,
    scopes: BotScope[],
    now: number,
    operation: () => Promise<T>,
  ): Promise<T>;
}
export interface StoredIdempotency extends IdempotencyClaim {
  planId: string;
  stepIndex: number | null;
}
export const TRANSACTION_STORAGE_LIMITS = {
  maximumPlanBytes: 1_048_576,
  maximumSteps: 32,
  plansPerAccount: 10_000,
  idempotencyPerAccount: 10_000,
} as const;
const states: readonly StepState[] = [
  "waiting",
  "reserved",
  "submitted",
  "unknown",
  "confirming",
  "confirmed",
  "reverted",
  "reorged",
];
const recoverableStates: readonly StepState[] = [
  "reserved",
  "submitted",
  "unknown",
  "confirming",
  "reorged",
];

export function conflict(message: string): never {
  throw new RestError(409, "TRANSACTION_CONFLICT", message);
}
export function invalid(message: string): never {
  throw new RestError(400, "INVALID_INPUT", message);
}
export function missingPlan(): never {
  throw new RestError(404, "PLAN_NOT_FOUND", "Transaction plan was not found.");
}
export function storageLimit(): never {
  throw new RestError(
    429,
    "STORAGE_LIMIT",
    "Transaction storage limit exceeded.",
  );
}
export function assertText(value: string, maximum = 192): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value) > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    invalid("Invalid storage identifier.");
}
export function assertActor(actor: RestActor): void {
  assertText(actor.accountId);
  assertText(actor.principalId, 256);
}
export function assertTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    invalid("Invalid transaction timestamp.");
}
export function assertRevision(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    invalid("Invalid plan revision.");
}
export function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000)
    invalid("Page limit must be between 1 and 1000.");
}
export function actorKey(actor: RestActor): string {
  return JSON.stringify([actor.accountId, actor.principalId]);
}
export function owns(plan: StoredPlan, actor: RestActor): boolean {
  return actorKey(plan.actor) === actorKey(actor);
}
export function canRead(plan: StoredPlan, actor: RestActor): boolean {
  return (
    owns(plan, actor) ||
    (actor.accountId === plan.actor.accountId &&
      actor.principalId === `owner:${actor.accountId}`)
  );
}
export function idemKey(actor: RestActor, key: string): string {
  return JSON.stringify([actor.accountId, actor.principalId, key]);
}
export function nonceKey(attempt: SignedAttempt): string {
  return JSON.stringify([
    attempt.chainId,
    attempt.sender.toLowerCase(),
    attempt.nonce,
  ]);
}
export function assertIdempotency(value: IdempotencyClaim): void {
  if (
    !value ||
    typeof value.key !== "string" ||
    !/^[\x21-\x7e]{1,128}$/.test(value.key)
  )
    invalid("Invalid idempotency key.");
  assertText(value.requestHash);
  assertText(value.operation, 128);
}
export function checkIdempotency(
  existing: StoredIdempotency | undefined,
  claim: IdempotencyClaim,
  target?: { planId: string; stepIndex: number },
): void {
  assertIdempotency(claim);
  if (
    existing &&
    (existing.requestHash !== claim.requestHash ||
      existing.operation !== claim.operation ||
      (target &&
        (existing.planId !== target.planId ||
          existing.stepIndex !== target.stepIndex)))
  )
    conflict("Idempotency key was already used for another request.");
}
export function boundedClone<T>(value: T): T {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value));
  } catch {
    return invalid("Transaction records must contain JSON values.");
  }
  if (bytes > TRANSACTION_STORAGE_LIMITS.maximumPlanBytes) storageLimit();
  return structuredClone(value);
}
export function assertNewPlan(plan: StoredPlan, now: number): void {
  assertActor(plan.actor);
  assertText(plan.id);
  assertTime(now);
  assertTime(plan.createdAt);
  assertTime(plan.expiresAt);
  if (
    plan.createdAt > now ||
    plan.expiresAt <= now ||
    plan.expiresAt <= plan.createdAt ||
    plan.revision !== 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(plan.commitment) ||
    !/^0x[0-9a-fA-F]{40}$/.test(plan.draft.account) ||
    !Array.isArray(plan.steps) ||
    plan.steps.length < 1 ||
    plan.steps.length > TRANSACTION_STORAGE_LIMITS.maximumSteps ||
    plan.steps.length !== plan.draft.calls.length ||
    plan.steps.some(
      (step, index) =>
        step.index !== index ||
        step.state !== "waiting" ||
        step.attempt ||
        step.externalExecution ||
        step.receipt ||
        step.semantic,
    )
  )
    invalid("Invalid initial transaction plan.");
  boundedClone(plan);
}
export function assertAttempt(value: SignedAttempt): void {
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(value.hash) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value.rawTransaction) ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.sender) ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId < 1 ||
    !["legacy", "eip2930", "eip1559"].includes(value.type)
  )
    invalid("Invalid signed transaction reservation.");
  for (const amount of [
    value.nonce,
    value.gas,
    value.maximumFeePerGas,
    value.maximumCost,
  ]) {
    if (
      typeof amount !== "string" ||
      !/^(?:0|[1-9][0-9]{0,77})$/.test(amount) ||
      BigInt(amount) >= 2n ** 256n
    )
      invalid("Invalid transaction integer.");
  }
  assertTime(value.reservedAt);
  assertTime(value.leaseUntil);
  assertText(value.leaseToken);
  if (!Number.isSafeInteger(value.dispatchCount) || value.dispatchCount < 0)
    invalid("Invalid dispatch count.");
}
function attemptIdentity(attempt: SignedAttempt): string {
  return JSON.stringify([
    attempt.hash.toLowerCase(),
    attempt.rawTransaction.toLowerCase(),
    attempt.sender.toLowerCase(),
    attempt.chainId,
    attempt.nonce,
    attempt.type,
    attempt.gas,
    attempt.maximumFeePerGas,
    attempt.maximumCost,
  ]);
}
export function sameAttempt(a: SignedAttempt, b: SignedAttempt): boolean {
  return attemptIdentity(a) === attemptIdentity(b);
}
export function assertSavedSteps(plan: StoredPlan, steps: StoredStep[]): void {
  if (!Array.isArray(steps) || steps.length !== plan.steps.length)
    invalid("Plan steps cannot be added or removed.");
  for (const [index, step] of steps.entries()) {
    const previous = plan.steps[index]!;
    if (step.index !== index || !states.includes(step.state))
      invalid("Invalid transaction step.");
    if (
      (step.externalExecution || previous.externalExecution) &&
      !isDeepStrictEqual(step, previous)
    )
      conflict(
        "External execution observations require their bound transport update.",
      );
    if (!isDeepStrictEqual(step.attempt, previous.attempt))
      conflict(
        "Signed transaction reservations can only be changed through submission claims.",
      );
  }
  boundedClone({ ...plan, steps });
}
export function prepareClaim(
  plan: StoredPlan,
  claim: SubmissionClaim,
): { plan: StoredPlan; dispatch: boolean; changed: boolean } {
  assertRevision(claim.expectedRevision);
  assertTime(claim.now);
  assertAttempt(claim.attempt);
  if (
    !Number.isSafeInteger(claim.stepIndex) ||
    claim.stepIndex < 0 ||
    claim.stepIndex >= plan.steps.length
  )
    invalid("Invalid transaction step index.");
  const step = plan.steps[claim.stepIndex]!;
  if (step.externalExecution)
    conflict("This step is bound to an external execution transport.");
  if (step.attempt && !sameAttempt(step.attempt, claim.attempt))
    conflict(
      "A different signed transaction is already reserved for this step.",
    );
  if (!step.attempt && plan.revision !== claim.expectedRevision)
    conflict("Transaction plan changed; inspect it before retrying.");
  if (!step.attempt && !claim.dispatch) {
    const next = boundedClone(plan);
    next.steps[claim.stepIndex] = {
      index: claim.stepIndex,
      state: "submitted",
      attempt: { ...claim.attempt, leaseUntil: 0, dispatchCount: 0 },
    };
    next.revision++;
    return { plan: boundedClone(next), dispatch: false, changed: true };
  }
  if (
    !claim.dispatch ||
    step.state === "confirmed" ||
    step.state === "reverted" ||
    (step.attempt && step.attempt.leaseUntil > claim.now)
  )
    return { plan, dispatch: false, changed: false };
  if (plan.revision !== claim.expectedRevision)
    conflict("Transaction plan changed; inspect it before retrying.");
  if (plan.expiresAt <= claim.now)
    conflict("Transaction plan expired before the dispatch claim.");
  if (claim.authorization !== undefined) {
    const { issuedAt, expiresAt } = claim.authorization ?? {};
    const currentSeconds = Math.floor(claim.now / 1_000);
    if (
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      issuedAt < 0 ||
      expiresAt <= currentSeconds ||
      issuedAt > currentSeconds + 30 ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 300
    )
      throw new RestError(
        401,
        "AUTH_EXPIRED",
        "Dispatch authorization expired or has an invalid validity window. Sign a fresh request.",
      );
  }
  for (const dependency of plan.draft.calls[claim.stepIndex]!.dependsOn) {
    const required = plan.steps[dependency];
    if (
      !required ||
      required.state !== "confirmed" ||
      required.receipt?.canonical !== true ||
      required.receipt.status !== "success" ||
      !required.semantic ||
      !["verified", "unmodeled"].includes(required.semantic.status)
    )
      conflict(
        "Transaction dependencies are not confirmed with verified outcomes.",
      );
  }
  if (
    claim.attempt.leaseUntil <= claim.now ||
    claim.attempt.leaseUntil - claim.now > 120_000 ||
    claim.attempt.reservedAt > claim.now
  )
    invalid("Dispatch lease must be current.");
  if (step.attempt?.leaseToken === claim.attempt.leaseToken)
    conflict("A renewed dispatch lease must use a new token.");
  const next = boundedClone(plan);
  const nextStep = next.steps[claim.stepIndex]!;
  nextStep.attempt = step.attempt
    ? {
        ...step.attempt,
        leaseToken: claim.attempt.leaseToken,
        leaseUntil: claim.attempt.leaseUntil,
        dispatchCount: step.attempt.dispatchCount + 1,
      }
    : { ...claim.attempt, dispatchCount: 1 };
  nextStep.state = "reserved";
  next.revision++;
  return { plan: boundedClone(next), dispatch: true, changed: true };
}
export function settle(
  plan: StoredPlan,
  index: number,
  leaseToken: string,
  patch: SubmissionPatch,
): StoredPlan {
  if (!Number.isSafeInteger(index) || index < 0 || index >= plan.steps.length)
    invalid("Invalid transaction step index.");
  assertText(leaseToken);
  if (!states.includes(patch.state)) invalid("Invalid transaction step state.");
  if (patch.broadcastAt !== undefined) assertTime(patch.broadcastAt);
  if (patch.lastError !== undefined) {
    assertText(patch.lastError.code, 128);
    assertText(patch.lastError.message, 2_000);
  }
  const current = plan.steps[index]!;
  if (!current.attempt || current.attempt.leaseToken !== leaseToken)
    return plan;
  const next = boundedClone(plan);
  const step = next.steps[index]!;
  // A late network response cannot roll back receipt reconciliation.
  if (
    !current.receipt &&
    !["confirmed", "reverted", "confirming", "reorged"].includes(current.state)
  )
    step.state = patch.state;
  if (patch.broadcastAt !== undefined)
    step.attempt!.broadcastAt = patch.broadcastAt;
  if (patch.lastError !== undefined)
    step.attempt!.lastError = boundedClone(patch.lastError);
  if (JSON.stringify(step) === JSON.stringify(current)) return plan;
  next.revision++;
  return boundedClone(next);
}
export function isRecoverableStep(step: StoredStep): boolean {
  return Boolean(
    (step.attempt || step.externalExecution) &&
      (recoverableStates.includes(step.state) ||
        (step.state === "confirmed" &&
          (!step.semantic || step.semantic.status === "unknown"))),
  );
}
export function isRecoverable(plan: StoredPlan): boolean {
  return plan.steps.some(isRecoverableStep);
}

export function assertExternalIndexes(
  plan: StoredPlan,
  indexes: readonly number[],
): void {
  if (
    !Array.isArray(indexes) ||
    indexes.length < 1 ||
    indexes.length > TRANSACTION_STORAGE_LIMITS.maximumSteps ||
    new Set(indexes).size !== indexes.length ||
    indexes.some(
      (index) =>
        !Number.isSafeInteger(index) || index < 0 || index >= plan.steps.length,
    )
  )
    invalid("Invalid external execution step indexes.");
}

export function attachExternalExecutions(
  plan: StoredPlan,
  bindings: readonly TransportReservation[],
): StoredPlan {
  const next = boundedClone(plan);
  let changed = false;
  for (const binding of bindings) {
    if (binding.transport !== "relayr" && binding.transport !== "erc4337")
      continue;
    assertExternalIndexes(plan, [binding.stepIndex]);
    assertText(binding.bindingId);
    const step = next.steps[binding.stepIndex]!;
    const chainId = plan.draft.calls[binding.stepIndex]!.chainId;
    if (step.attempt)
      conflict(
        "An owner-signed attempt cannot be replaced by a forwarded execution.",
      );
    if (step.externalExecution) {
      if (
        step.externalExecution.transport !== binding.transport ||
        step.externalExecution.bindingId !== binding.bindingId ||
        step.externalExecution.chainId !== chainId
      )
        conflict(
          "The external execution binding differs from its permanent reservation.",
        );
      continue;
    }
    if (step.state !== "waiting" || step.receipt || step.semantic)
      conflict("The unbound step already has execution observations.");
    step.externalExecution = {
      transport: binding.transport,
      bindingId: binding.bindingId,
      chainId,
    };
    step.state = "reserved";
    changed = true;
  }
  if (!changed) return plan;
  next.revision++;
  return boundedClone(next);
}

/** The caller separately proves each existing permanent transport reservation. */
export function applyExternalObservations(
  plan: StoredPlan,
  bindingId: string,
  updates: readonly ExternalStepObservation[],
): StoredPlan {
  assertText(bindingId);
  if (
    !Array.isArray(updates) ||
    updates.some(
      (update) =>
        !update || typeof update !== "object" || Array.isArray(update),
    )
  )
    invalid("Invalid external execution observations.");
  assertExternalIndexes(
    plan,
    updates.map((update) => update.index),
  );
  const next = boundedClone(plan);
  for (const update of updates) {
    if (
      Object.keys(update).some(
        (key) =>
          ![
            "index",
            "state",
            "transactionHash",
            "receipt",
            "semantic",
          ].includes(key),
      ) ||
      update.state === ("waiting" as StepState) ||
      !states.includes(update.state)
    )
      invalid("Invalid external execution observation.");
    const previous = plan.steps[update.index]!;
    const external = previous.externalExecution;
    if (
      previous.attempt ||
      !external ||
      !["relayr", "erc4337"].includes(external.transport) ||
      external.bindingId !== bindingId ||
      external.chainId !== plan.draft.calls[update.index]!.chainId
    )
      conflict(
        "The observation does not match its admitted external execution.",
      );
    if (
      update.transactionHash !== undefined &&
      !/^0x[0-9a-fA-F]{64}$/.test(update.transactionHash)
    )
      invalid("Invalid external transaction hash.");
    if (update.receipt) {
      const receipt = update.receipt;
      if (
        !update.transactionHash ||
        typeof receipt.transactionHash !== "string" ||
        receipt.transactionHash.toLowerCase() !==
          update.transactionHash.toLowerCase() ||
        !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) ||
        typeof receipt.blockNumber !== "string" ||
        !/^(0|[1-9][0-9]{0,77})$/.test(receipt.blockNumber) ||
        BigInt(receipt.blockNumber) >= 2n ** 256n ||
        !["success", "reverted"].includes(receipt.status) ||
        typeof receipt.canonical !== "boolean" ||
        !Number.isSafeInteger(receipt.confirmations) ||
        receipt.confirmations < 0 ||
        !Array.isArray(receipt.logs)
      )
        invalid("External receipt does not match its transaction.");
      assertTime(receipt.observedAt);
    }
    if (
      update.semantic &&
      !["verified", "failed", "unknown", "unmodeled"].includes(
        update.semantic.status,
      )
    )
      invalid("Invalid semantic execution outcome.");
    if (
      update.state === "confirmed" &&
      (!update.receipt ||
        !update.receipt.canonical ||
        update.receipt.status !== "success")
    )
      invalid(
        "Confirmed external execution requires a canonical successful receipt.",
      );
    // An external operation proven never to have reached the chain (expired) fails without a
    // receipt: there is no transaction to prove, only the absence of one.
    const neverPublished =
      update.state === "reverted" &&
      !update.receipt &&
      update.semantic?.status === "failed" &&
      update.transactionHash === undefined;
    if (
      update.state === "reverted" &&
      !neverPublished &&
      (!update.receipt ||
        !update.receipt.canonical ||
        (update.receipt.status !== "reverted" &&
          update.semantic?.status !== "failed"))
    )
      invalid(
        "Reverted external execution requires proof of transaction or inner-call failure.",
      );
    next.steps[update.index] = {
      index: update.index,
      state: update.state,
      externalExecution: {
        transport: external.transport,
        bindingId,
        chainId: external.chainId,
        ...(update.transactionHash
          ? { transactionHash: update.transactionHash }
          : {}),
      },
      ...(update.receipt ? { receipt: boundedClone(update.receipt) } : {}),
      ...(update.semantic ? { semantic: boundedClone(update.semantic) } : {}),
    };
  }
  if (isDeepStrictEqual(next.steps, plan.steps)) return plan;
  next.revision++;
  return boundedClone(next);
}
export type ListCursor = { createdAt: number; id: string };
export function encodeCursor(plan: StoredPlan): string {
  return Buffer.from(
    JSON.stringify({ createdAt: plan.createdAt, id: plan.id }),
  ).toString("base64url");
}
export function decodeCursor(
  cursor: string | undefined,
): ListCursor | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    invalid("Invalid transaction cursor.");
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as ListCursor;
    assertTime(value.createdAt);
    assertText(value.id);
    if (encodeCursor(value as StoredPlan) !== cursor)
      invalid("Invalid transaction cursor.");
    return value;
  } catch {
    return invalid("Invalid transaction cursor.");
  }
}
