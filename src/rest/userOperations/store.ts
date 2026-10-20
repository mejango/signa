import type { Address, Hex } from 'viem';
import type { RestActor } from '../core.js';
import { RestError } from '../core.js';
import type { StoredPlan } from '../transactions/types.js';
import { assertActor, assertText } from '../transactions/store.js';
import { assertDispatchAuthorization } from '../sponsorship/store.js';
import { canonical, digest } from '../sponsorship/validation.js';
import type { UserOperationObservation, UserOperationV07 } from './types.js';
import { normalizeUserOperation, getUserOperationHash, userOperationCommitment } from './codec.js';
import type { UserOperationSessionBinding } from '../sessions/types.js';
export type { UserOperationSessionBinding } from '../sessions/types.js';

export interface UserOperationRecord {
  id: string;
  actor: RestActor;
  planId: string;
  planCommitment: Hex;
  stepIndexes: number[];
  chainId: number;
  entryPoint: Address;
  sender: Address;
  operation: UserOperationV07;
  operationHash: Hex;
  preparationKey: string;
  inputHash: Hex;
  commitment: Hex;
  accountBindingId: Hex;
  accountStateHash: Hex;
  session?: UserOperationSessionBinding;
  gasPolicyId: string;
  providerId: string;
  createdAt: number;
  expiresAt: number;
  revision: number;
  /** `retired`: approved, never sent, and refused for good; nothing claims or resends it. */
  state: 'prepared' | 'submitting' | 'submission_unknown' | 'retired' | UserOperationObservation['state'];
  submission?: {
    key: string;
    commitment: Hex;
    operation: UserOperationV07;
    startedAt: number;
    sessionObservationHash?: Hex;
  };
  observation?: UserOperationObservation;
  /** When the chain settled a retired operation: it never ran and never can, or Signa's own operation took its nonce. */
  retiredSettledAt?: number;
}
export interface UserOperationClaim {
  actor: RestActor;
  id: string;
  key: string;
  operation: UserOperationV07;
  signedCommitment: Hex;
  authorization: { issuedAt: number; expiresAt: number };
  sessionObservationHash?: Hex;
  /** The unsettled retired operations of this sender the admission checked; any other with another nonce refuses the claim. */
  retiredChecked?: string[];
  now: number;
}
export interface UserOperationStore {
  find(actor: RestActor, key: string, inputHash: Hex): Promise<UserOperationRecord | undefined>;
  create(record: UserOperationRecord, now: number): Promise<UserOperationRecord>;
  get(actor: RestActor, id: string): Promise<UserOperationRecord | undefined>;
  claim(input: UserOperationClaim): Promise<{ record: UserOperationRecord; dispatch: boolean }>;
  settle(
    id: string,
    signedCommitment: Hex,
    state: 'pending' | 'submission_unknown',
  ): Promise<UserOperationRecord>;
  observe(
    id: string,
    revision: number,
    observation: UserOperationObservation,
  ): Promise<UserOperationRecord>;
  recoverable(limit: number, cursor?: string): Promise<UserOperationRecord[]>;
  /** Retires an unsent operation under the claim's lock; one something already claimed comes back as it is. */
  retire(actor: RestActor, id: string): Promise<UserOperationRecord>;
  /** Every unsettled retired operation from `sender` on `chainId`, under any account. */
  retired(chainId: number, sender: Address): Promise<UserOperationRecord[]>;
  settleRetired(id: string): Promise<void>;
  /** The operation holding the full sender nonce, once one claimed it. */
  nonceHolder(chainId: number, sender: Address, nonce: bigint): Promise<UserOperationRecord | undefined>;
}

/** The codec is a trusted pure local dependency; it never calls a bundler. */
export interface UserOperationCodec {
  parse(input: unknown): UserOperationV07;
  hash(operation: UserOperationV07, chainId: number, entryPoint: Address): Hex;
  signedCommitment(operation: UserOperationV07, chainId: number, entryPoint: Address): Hex;
}
export const defaultCodec: UserOperationCodec = {
  parse: normalizeUserOperation,
  hash: (operation, chainId, entryPoint) => getUserOperationHash(operation, entryPoint, chainId),
  signedCommitment: (operation, chainId, entryPoint) =>
    userOperationCommitment(operation, entryPoint, chainId),
};
export const USER_OPERATION_LIMITS = Object.freeze({ bytes: 1_048_576, recordsPerAccount: 1000 });
export function fail(code: string, message: string, status = 409): never {
  throw new RestError(status, code, message);
}
export const conflict = () =>
  fail(
    'USER_OPERATION_CONFLICT',
    'The UserOperation is already bound to different reviewed bytes.',
  );
export const missing = () =>
  fail(
    'USER_OPERATION_NOT_FOUND',
    'UserOperation preparation was not found for this principal.',
    404,
  );
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const owns = (record: UserOperationRecord, actor: RestActor) =>
  record.actor.accountId === actor.accountId && record.actor.principalId === actor.principalId;
export const canRead = (record: UserOperationRecord, actor: RestActor) =>
  owns(record, actor) ||
  (record.actor.accountId === actor.accountId && actor.principalId === `owner:${actor.accountId}`);
export function clone<T>(value: T): T {
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded) > USER_OPERATION_LIMITS.bytes)
    fail('USER_OPERATION_STORAGE_LIMIT', 'UserOperation data exceeds its storage bound.', 413);
  return JSON.parse(encoded) as T;
}
export function key(value: string): void {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value))
    fail('INVALID_USER_OPERATION', 'Use a bounded idempotency key.', 400);
}
const hash = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const address = (value: unknown): value is Address =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const time = (value: number) => Number.isSafeInteger(value) && value >= 0;
export function assertNew(
  record: UserOperationRecord,
  now: number,
  codec: UserOperationCodec,
): void {
  assertActor(record.actor);
  for (const id of [record.id, record.planId, record.gasPolicyId, record.providerId])
    assertText(id);
  key(record.preparationKey);
  if (
    ![
      record.planCommitment,
      record.operationHash,
      record.inputHash,
      record.commitment,
      record.accountBindingId,
      record.accountStateHash,
    ].every(hash) ||
    !address(record.entryPoint) ||
    !address(record.sender) ||
    !Number.isSafeInteger(record.chainId) ||
    record.chainId < 1 ||
    !time(now) ||
    !time(record.createdAt) ||
    !time(record.expiresAt) ||
    record.createdAt > now ||
    record.expiresAt <= now ||
    record.revision !== 0 ||
    record.state !== 'prepared' ||
    record.submission ||
    record.observation ||
    !Array.isArray(record.stepIndexes) ||
    record.stepIndexes.length < 1 ||
    record.stepIndexes.length > 32 ||
    new Set(record.stepIndexes).size !== record.stepIndexes.length ||
    record.stepIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 31)
  ) {
    fail('INVALID_USER_OPERATION', 'Invalid UserOperation preparation.', 400);
  }
  const operation = codec.parse(record.operation);
  if (
    canonical(operation) !== canonical(record.operation) ||
    !same(operation.sender, record.sender) ||
    !same(codec.hash(operation, record.chainId, record.entryPoint), record.operationHash)
  )
    fail(
      'INVALID_USER_OPERATION',
      'UserOperation encoding or hash differs from the preparation.',
      400,
    );
  if (record.session) {
    const session = record.session;
    for (const id of [session.id, session.grantId]) assertText(id);
    if (
      ![
        session.policyHash,
        session.compiledHash,
        session.permissionId,
        session.observationHash,
      ].every(hash) ||
      !address(session.sessionKey) ||
      !/^[1-9][0-9]{0,77}$/.test(session.generation) ||
      BigInt(session.generation) >= 2n ** 256n
    )
      fail('INVALID_USER_OPERATION', 'Invalid exact session identity.', 400);
  }
  clone(record);
}
export function assertPlan(record: UserOperationRecord, plan: StoredPlan, now: number): void {
  if (
    !plan.smartAccount ||
    !same(plan.smartAccount.bindingId, record.accountBindingId) ||
    !same(plan.smartAccount.stateHash, record.accountStateHash) ||
    plan.smartAccount.chainId !== record.chainId ||
    !same(plan.smartAccount.address, record.sender) ||
    !owns(record, plan.actor) ||
    plan.id !== record.planId ||
    !same(plan.commitment, record.planCommitment) ||
    !same(plan.draft.account, record.sender) ||
    plan.expiresAt <= now ||
    record.expiresAt > plan.expiresAt ||
    record.stepIndexes.some(
      (index) => !plan.steps[index] || plan.draft.calls[index]?.chainId !== record.chainId,
    )
  )
    conflict();
  const selected = new Set(record.stepIndexes);
  for (const index of record.stepIndexes) {
    const step = plan.steps[index]!;
    if (
      step.attempt ||
      step.externalExecution ||
      step.state !== 'waiting' ||
      step.receipt ||
      step.semantic
    )
      conflict();
    for (const dependency of plan.draft.calls[index]!.dependsOn) {
      if (
        selected.has(dependency) &&
        record.stepIndexes.indexOf(dependency) < record.stepIndexes.indexOf(index)
      )
        continue;
      const prerequisite = plan.steps[dependency];
      if (
        prerequisite?.state !== 'confirmed' ||
        prerequisite.receipt?.canonical !== true ||
        prerequisite.receipt.status !== 'success' ||
        !prerequisite.semantic ||
        !['verified', 'unmodeled'].includes(prerequisite.semantic.status)
      )
        conflict();
    }
  }
}
export function assertClaim(input: UserOperationClaim): void {
  assertActor(input.actor);
  assertText(input.id);
  key(input.key);
  if (!hash(input.signedCommitment) || !time(input.now))
    fail('INVALID_USER_OPERATION', 'Invalid signed UserOperation claim.', 400);
  clone(input);
}
export function claimed(
  record: UserOperationRecord,
  input: UserOperationClaim,
  codec: UserOperationCodec,
): { record: UserOperationRecord; dispatch: boolean } {
  if (!owns(record, input.actor)) return missing();
  const operation = codec.parse(input.operation);
  const fullCommitment = codec.signedCommitment(operation, record.chainId, record.entryPoint);
  const { signature: ignoredOriginalSignature, ...original } = record.operation;
  const { signature, ...signed } = operation;
  if (
    canonical(operation) !== canonical(input.operation) ||
    signature === '0x' ||
    canonical(original) !== canonical(signed) ||
    !same(fullCommitment, input.signedCommitment) ||
    !same(codec.hash(operation, record.chainId, record.entryPoint), record.operationHash)
  )
    conflict();
  if (record.submission) {
    // The same signed bytes under another publication key observe the earlier submission.
    if (
      !same(record.submission.commitment, fullCommitment) ||
      canonical(record.submission.operation) !== canonical(operation)
    )
      conflict();
    return { record: clone(record), dispatch: false };
  }
  if (record.state === 'retired') retiredFailure();
  if (record.state !== 'prepared' || record.expiresAt <= input.now)
    fail('USER_OPERATION_EXPIRED', 'Prepare a fresh UserOperation before submission.');
  assertDispatchAuthorization(input.authorization, input.now);
  dispatchRecord(record, input);
  return {
    record: clone({
      ...record,
      revision: record.revision + 1,
      state: 'submitting',
      submission: {
        key: input.key,
        commitment: fullCommitment,
        operation,
        startedAt: input.now,
        ...(record.session ? { sessionObservationHash: input.sessionObservationHash! } : {}),
      },
    }),
    dispatch: true,
  };
}
/** A claim admitted before another approval from its sender was retired is checked again: the claim refuses it. */
export function assertRetiredChecked(record: UserOperationRecord, input: UserOperationClaim, retired: UserOperationRecord[]): void {
  if (retired.some((old) => old.id !== record.id && !(input.retiredChecked ?? []).includes(old.id) &&
    BigInt(old.operation.nonce) !== BigInt(record.operation.nonce)))
    fail('USER_OPERATION_RETIRED_CHANGED', 'Another approval from this wallet was retired meanwhile. Submit again.');
}
export const retiredFailure = () =>
  fail('USER_OPERATION_RETIRED', 'This approval was refused and retired. Review a fresh payment.');
/** An unsent operation becomes retired; a claimed one stays exactly as it is. */
export function retiring(record: UserOperationRecord): UserOperationRecord {
  if (record.submission || record.state === 'retired') return clone(record);
  if (record.state !== 'prepared') conflict();
  // A session signature has no signed deadline, so expiry could never settle it.
  if (record.session) fail('USER_OPERATION_NOT_RETIRABLE', 'Only an owner-approved operation can be retired.', 409);
  return clone({ ...record, state: 'retired', revision: record.revision + 1 });
}
/** Refresh observation evidence without changing the immutable compiled session or operation. */
export function dispatchRecord(
  record: UserOperationRecord,
  input: UserOperationClaim,
): UserOperationRecord {
  if (!record.session) return record;
  if (!hash(input.sessionObservationHash))
    fail('INVALID_USER_OPERATION', 'A fresh verified session observation hash is required.', 400);
  return {
    ...record,
    session: { ...record.session, observationHash: input.sessionObservationHash },
  };
}
export function settled(
  record: UserOperationRecord,
  commitment: Hex,
  state: 'pending' | 'submission_unknown',
): UserOperationRecord {
  if (!record.submission || !same(record.submission.commitment, commitment)) return conflict();
  if (!['pending', 'submission_unknown'].includes(state))
    fail('INVALID_USER_OPERATION', 'Invalid UserOperation settlement.', 400);
  if (record.observation || record.state === state) return clone(record);
  return clone({ ...record, state, revision: record.revision + 1 });
}
export function observed(
  record: UserOperationRecord,
  revision: number,
  observation: UserOperationObservation,
): UserOperationRecord {
  if (!Number.isSafeInteger(revision) || revision < 0)
    fail('INVALID_USER_OPERATION', 'Invalid observation revision.', 400);
  if (record.revision !== revision) return conflict();
  // Expired is proven against the chain and released its nonce; nothing moves it back.
  if (record.state === 'expired') return conflict();
  if (
    !record.submission ||
    !same(observation.operationHash, record.operationHash) ||
    !['pending', 'unknown', 'confirming', 'confirmed', 'reverted', 'expired'].includes(observation.state)
  )
    conflict();
  if (observation.state === 'expired' && (observation.transactionHash !== undefined || observation.receipt))
    fail('INVALID_USER_OPERATION', 'An expired operation has no execution evidence.', 400);
  if (observation.transactionHash !== undefined && !hash(observation.transactionHash))
    fail('INVALID_USER_OPERATION', 'Invalid transaction hash.', 400);
  if (
    observation.receipt &&
    (!observation.transactionHash ||
      !same(observation.receipt.transactionHash, observation.transactionHash))
  )
    fail('INVALID_USER_OPERATION', 'Receipt does not match the execution transaction.', 400);
  if (
    observation.state === 'confirmed' &&
    (!observation.receipt?.canonical || observation.receipt.status !== 'success')
  )
    fail(
      'INVALID_USER_OPERATION',
      'Confirmed execution requires a canonical successful outer receipt.',
      400,
    );
  if (
    observation.state === 'reverted' &&
    (!observation.receipt?.canonical ||
      (observation.receipt.status !== 'reverted' && observation.semantic?.status !== 'failed'))
  )
    fail('INVALID_USER_OPERATION', 'Reverted execution requires canonical failure evidence.', 400);
  return clone({ ...record, state: observation.state, revision: record.revision + 1, observation });
}
export function nonceKey(record: Pick<UserOperationRecord, 'chainId' | 'sender'> & { operation: { nonce: Hex } }): string {
  return canonical([
    record.chainId,
    record.sender.toLowerCase(),
    BigInt(record.operation.nonce).toString(),
  ]);
}
export const preparationKey = (actor: RestActor, value: string) =>
  canonical([actor.accountId, actor.principalId, value]);
export const isRecoverable = (record: UserOperationRecord) =>
  !!record.submission &&
  ['submitting', 'submission_unknown', 'pending', 'unknown', 'confirming'].includes(record.state);
export function recoveryCursor(record: Pick<UserOperationRecord, 'createdAt' | 'id'>): string {
  return Buffer.from(canonical({ createdAt: record.createdAt, id: record.id })).toString(
    'base64url',
  );
}
export function readCursor(value?: string): { createdAt: number; id: string } | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length > 512 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error();
    const result = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
      createdAt: number;
      id: string;
    };
    assertText(result.id);
    if (!time(result.createdAt) || recoveryCursor(result) !== value) throw new Error();
    return result;
  } catch {
    return fail('INVALID_USER_OPERATION', 'Invalid recovery cursor.', 400);
  }
}
export function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    fail('INVALID_USER_OPERATION', 'Use a recovery limit from 1 to 100.', 400);
}
export { digest };
