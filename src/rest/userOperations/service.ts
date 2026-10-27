import type {UserOperationSponsorRoutes} from './sponsorRoutes.js';
import { randomUUID } from "node:crypto";
import { decodeFunctionData, toHex, type Address, type Hex } from "viem";
import { detachedFromRequest } from "../context.js";
import type { RestPrincipal } from "../auth/store.js";
import {
  RestError,
  type RestActor,
  type RestBlockEvidence,
  type RestRpc,
} from "../core.js";
import { exactObject } from "../protocol/abi.js";
import type { SessionService } from "../sessions/service.js";
import type {
  StoredSession,
  UserOperationSessionBinding,
} from "../sessions/types.js";
import {
  encodeLegacyUseSignature,
  encodeSafe7579Execution,
  encodeSafe7579OwnerSignature,
  legacySessionSigningPayload,
  safe7579NonceKey,
  safe7579OwnerSigningPayload,
  verifyLegacySessionSignature,
  verifySafe7579OwnerSignature,
} from "../smartAccounts/accountExecution.js";
import type {
  SmartAccountBinding,
  SmartAccountManifest,
} from "../smartAccounts/types.js";
import { assertCompiledSessionCall } from "../smartAccounts/compiler.js";
import type { TransactionStore } from "../transactions/store.js";
import type { TransactionService } from "../transactions/service.js";
import type {
  SemanticVerifier,
  StoredPlan,
  StoredReceipt,
  ExternalExecutionObservation,
} from "../transactions/types.js";
import { UserOperationChain } from "./chain.js";
import {
  applyUserOperationEstimate,
  assertUserOperationGasPolicy,
  getUserOperationHash,
  normalizeUserOperation,
  uoCanonical,
  uoHash,
  uoQuantity,
  userOperationCommitment,
  userOperationMaximumCost,
} from "./codec.js";
import type { ReviewGas, SponsorCapStore } from "../sponsorCaps.js";
import { observeUserOperation } from "./execution.js";
import { terminalAbi, walletV6UsdcPaymentDomain, verifyWalletV6UsdcPaymentEffects, type WalletV6UsdcPaymentConfig } from "./semantics.js";
import { passkeyPayMetadataSteps } from "./userPayMetadata.js";
import { explainedRefusal, tracedPayFailure } from "./payFailure.js";
import { UserOperationProvider } from "./provider.js";
import { createSessionGasEstimation } from "./estimation.js";
import { passkeyDummySignature, passkeyEstimateProvider } from "./passkeyEstimation.js";
import { assertPasskeyUserOperationEnvelope, userOperationPasskeyProfile, verifyPasskeyUserOperation } from "./passkeyVerification.js";
import { safe7579PasskeyOwnerSigningPayload } from "../smartAccounts/passkeySignatures.js";
import { createPasskeyContractSignatureVerifier } from "../smartAccounts/passkeyContractVerifier.js";
import { finalizeUserOperationSponsorship } from "./sponsorship.js";
import { assertOwnersConsistent, observeWalletOwners, type WalletOwnerStateStore } from "../wallet/ownerState.js";
import {
  digest,
  isRecoverable,
  recoveryCursor,
  retiredFailure,
  type UserOperationRecord,
  type UserOperationStore,
} from "./store.js";
import type {
  UserOperationExecutionBinding,
  UserOperationGasPolicy,
  UserOperationObservation,
  UserOperationV07,
} from "./types.js";
import { SIGNA_HOME_CHAIN_ID } from "../wallet/chains.js";

export interface UserOperationChainPolicy {
  chainId: number;
  gas: UserOperationGasPolicy;
  confirmations: number;
}
/** Head reads started before a plan is drafted, for the preparation that follows it. */
export interface UserOperationHeadAhead {
  bindingId: Hex;
  nonceKey: bigint;
  /** The head itself, as soon as it is read: a plan drafted meanwhile pins its quote there. */
  head: Promise<RestBlockEvidence>;
  reads: Promise<{ head: { nonce: Hex; evidence: RestBlockEvidence; baseFeePerGas: unknown }; nodePriority: unknown;
    /** The bundler answered ready and its fee floor, read beside the head: every sponsor route
     * shares the bundler, so they hold for whichever provider prepares. */
    ready: true; floor: Awaited<ReturnType<UserOperationProvider["gasPrice"]>>;
    chainId: number; sender: Address; entryPoint: Address; readAt: number }>;
}
export interface UserOperationServiceDependencies {
  rpc: RestRpc;
  provider: UserOperationProvider;
  sponsorRoutes?: Pick<UserOperationSponsorRoutes, "authorize" | "stored">;
  store: UserOperationStore;
  transactionStore: TransactionStore;
  transactions: TransactionService;
  sessions?: SessionService;
  policies: readonly UserOperationChainPolicy[];
  currentBinding(
    accountId: string,
    id: Hex,
    signal?: AbortSignal,
  ): Promise<SmartAccountBinding>;
  currentBindingAt(
    accountId: string,
    id: Hex,
    evidence: RestBlockEvidence,
    signal?: AbortSignal,
  ): Promise<SmartAccountBinding>;
  manifestFor(binding: SmartAccountBinding): SmartAccountManifest;
  manifestForPlan(plan: StoredPlan): SmartAccountManifest;
  verifyHistoricalAccount(
    plan: StoredPlan,
    evidence: RestBlockEvidence,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Called when the bundler refuses an admitted operation: the account's verified state is not trusted again until read in full. */
  forgetAccountState?(plan: StoredPlan): void;
  /** Whether the owner approved this operation in a payment review: only such an approval is retired. */
  approvedReview?(operationId: string): Promise<boolean>;
  verificationBudgetMs?: number;
  authorizeRequest(
    actor: RestActor,
    id: string,
    signature: Hex,
  ): Promise<{ issuedAt: number; expiresAt: number }>;
  semanticVerifier: SemanticVerifier;
  /** Optional reviewed host profile; absent configuration retains generic batch uncertainty. */
  v6UsdcPayment?: WalletV6UsdcPaymentConfig;
  /** The last owner observation per chain, reused while its block is still the head. */
  ownerStates?: WalletOwnerStateStore;
  /** Per-account daily limits on the operator's Pimlico sponsorship. With them, an owner operation
   * the cap or the sponsor refuses is prepared for the account to pay, shown in the same review. */
  sponsorCaps?: SponsorCapStore;
  now?: () => number;
}
export interface UserOperationPreparationInput {
  sponsorAuthorization?: string;
  planId: string;
  stepIndexes: number[];
  sessionId?: string;
}
const actorOf = (p: RestPrincipal): RestActor => ({
  accountId: p.account.id,
  principalId: p.principalId,
});
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const dummySignature = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;
/** Speculated admission checks: taken by an approval within a minute (about thirty Base blocks) of
 * the head they were made at; refreshed by a review page read when older than fifteen seconds. */
export const speculationMaxAgeMs = 60_000, speculationRefreshMs = 15_000, speculationCap = 1_000;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
/** The most a sponsored operation at this fee can cost under its gas policy, reserved before the
 * sponsor is asked; the final operation's own maximum replaces it. */
function sponsoredCeiling(operation: UserOperationV07, gas: UserOperationGasPolicy): bigint {
  const limits = gas.maximumCallGas + gas.maximumVerificationGas + gas.maximumPreVerificationGas
    + gas.maximumPaymasterVerificationGas + gas.maximumPaymasterPostOpGas;
  const ceiling = limits * BigInt(operation.maxFeePerGas);
  return ceiling < gas.maximumCost ? ceiling : gas.maximumCost;
}
function fail(code: string, message: string, status = 409): never {
  throw new RestError(status, code, message);
}
function exactActor(actor: RestActor, record: { actor: RestActor }) {
  if (
    actor.accountId !== record.actor.accountId ||
    actor.principalId !== record.actor.principalId
  )
    fail(
      "USER_OPERATION_NOT_FOUND",
      "The preparation belongs to another principal.",
      404,
    );
}
function appOperation(principal: RestPrincipal, chainId: number, hasSession: boolean): void {
  if (principal.kind !== "wallet-app") return;
  if (hasSession)
    fail("USER_OPERATION_APP_SESSION_UNAVAILABLE", "Apps require fresh wallet owner approval for each operation.", 403);
  if (chainId !== SIGNA_HOME_CHAIN_ID || principal.account.authorityChainId !== SIGNA_HOME_CHAIN_ID)
    fail("USER_OPERATION_APP_CHAIN_UNAVAILABLE", "App wallet operations are available only on Base.", 403);
}

/** Prepares, verifies and relays externally signed operations. It never holds a signing key. */
/** Whether a new observation says nothing the stored one did not. */
function sameObservation(a: UserOperationObservation, b: UserOperationObservation) {
  return a.state === b.state && (a.transactionHash ?? null) === (b.transactionHash ?? null)
    && (a.receipt?.blockHash ?? null) === (b.receipt?.blockHash ?? null) && (a.receipt?.confirmations ?? null) === (b.receipt?.confirmations ?? null)
    && (a.semantic?.status ?? null) === (b.semantic?.status ?? null) && (a.verifiedAtBlock ?? null) === (b.verifiedAtBlock ?? null)
    && (a.reason ?? null) === (b.reason ?? null);
}
export class UserOperationService {
  private readonly now: () => number;
  private recoveryCursor: string | undefined;
  constructor(private readonly options: UserOperationServiceDependencies) {
    this.now = options.now ?? Date.now;
    if (
      new Set(options.policies.map((p) => p.chainId)).size !==
        options.policies.length ||
      options.policies.some(
        (p) =>
          !Number.isSafeInteger(p.confirmations) ||
          p.confirmations < 1 ||
          p.confirmations > 1024,
      )
    )
      fail(
        "USER_OPERATION_POLICY_INVALID",
        "Each configured chain requires one bounded confirmation policy.",
        500,
      );
  }
  capabilities() {
    const providers = this.options.provider.capabilities();
    return {
      transport: "eip4337-user-operation",
      version: "0.7",
      providers,
      preparation: providers.length > 0,
      relay: providers.length > 0,
      privateKeysStored: false,
      automaticResubmission: false,
      sessionMaximumCallsPerOperation: 1,
      ownerMaximumCallsPerOperation: 16,
      freshOwnerApprovalOutsideSession: true,
      activationRequirements: [
        "verified-account-creation-and-authority-history",
        "reviewed-per-chain-runtime-pins",
        "configured-hosted-bundler-and-paymaster",
        "deployed-session-guard-for-recurring-authority",
      ],
    };
  }
  private chain(signal?: AbortSignal) {
    return new UserOperationChain(this.options.rpc, {
      now: this.now,
      ...(signal ? { signal } : {}),
    });
  }
  /** Every selected call that pays the reviewed token through the reviewed terminal carries only
   * metadata a payment review can describe, whatever the plan is labeled and whichever path prepares
   * or submits it. */
  private passkeyPayMetadata(plan: StoredPlan, stepIndexes: readonly number[]): void {
    const config = this.options.v6UsdcPayment;
    if (!config) return;
    for (const index of stepIndexes) {
      const call = plan.draft.calls[index];
      if (!call || call.chainId !== config.chainId || !same(call.to, config.directV6Terminal)) continue;
      let args: readonly unknown[] | undefined;
      try {
        const decoded = decodeFunctionData({ abi: terminalAbi, data: call.data as Hex });
        if (decoded.functionName === "pay") args = decoded.args;
      } catch { continue; }
      if (!args || !same(args[1] as string, config.token)) continue;
      try { passkeyPayMetadataSteps(args[6] as string); }
      catch { fail("USER_OPERATION_PAYMENT_METADATA_UNSUPPORTED", "A passkey payment carries empty or Juicebox hook metadata.", 422); }
    }
  }

  private policy(chainId: number) {
    return (
      this.options.policies.find((p) => p.chainId === chainId) ??
      fail(
        "USER_OPERATION_CHAIN_UNAVAILABLE",
        "No reviewed execution policy is configured for this chain.",
        503,
      )
    );
  }
  private async plan(actor: RestActor, id: string, fresh: boolean) {
    if (fresh) await this.options.transactions.getPlan(actor, id);
    const plan = await this.options.transactionStore.get(actor, id);
    if (!plan)
      return fail(
        "PLAN_NOT_FOUND",
        "The plan was not found for this principal.",
        404,
      );
    exactActor(actor, plan);
    if (!plan.smartAccount)
      fail(
        "USER_OPERATION_SMART_PLAN_REQUIRED",
        "Prepare the plan through its verified smart-account binding.",
      );
    if (fresh && plan.expiresAt <= this.now())
      fail(
        "PLAN_EXPIRED",
        "Prepare a fresh plan before requesting another operation.",
      );
    return plan;
  }
  /** A passkey account acts on a chain only while that chain carries Base's owners and threshold one. */
  private async owners(plan: StoredPlan, signal?: AbortSignal): Promise<void> {
    if (!this.options.manifestForPlan(plan).ownerProfile) return;
    const chainId = plan.smartAccount!.chainId;
    assertOwnersConsistent(await observeWalletOwners({ account: plan.draft.account, chains: [chainId], rpc: this.options.rpc, now: this.now,
      ...(this.options.ownerStates ? { store: this.options.ownerStates } : {}), ...(signal ? { signal } : {}) }), chainId);
  }
  private async account(plan: StoredPlan, signal?: AbortSignal, at?: RestBlockEvidence) {
    const approved = plan.smartAccount!;
    const binding = at
      ? await this.options.currentBindingAt(plan.actor.accountId, approved.bindingId, at, signal)
      : await this.options.currentBinding(plan.actor.accountId, approved.bindingId, signal);
    if (
      !binding.state.moduleConfigurationVerified ||
      !same(binding.state.stateHash, approved.stateHash) ||
      binding.wallet.chainId !== approved.chainId ||
      !same(binding.wallet.address, plan.draft.account) ||
      !same(binding.state.manifestRevision, approved.manifestRevision)
    )
      fail(
        "USER_OPERATION_ACCOUNT_CHANGED",
        "The plan's reviewed owner or module configuration changed.",
      );
    const manifest = this.options.manifestFor(binding);
    if (manifest.mode !== "execution-candidate" || !manifest.entryPoint)
      fail(
        "USER_OPERATION_STACK_UNAVAILABLE",
        "This account manifest supports ownership binding but not verified execution.",
        503,
      );
    const provider = this.options.provider.configuration(
      binding.wallet.chainId,
    );
    if (
      !same(provider.entryPoint.address, manifest.entryPoint.address) ||
      !same(
        provider.entryPoint.runtimeCodeHash,
        manifest.entryPoint.runtimeCodeHash,
      )
    )
      fail(
        "USER_OPERATION_PROVIDER_MISMATCH",
        "The bundler and account must use the same reviewed EntryPoint.",
      );
    return { binding, manifest };
  }

  /** The head reads a preparation waits on longest (the account's nonce at the head and the node's
   * priority fee), started before the plan is drafted so they wait on nothing. The preparation uses
   * them only for the binding, nonce key and EntryPoint it reads them for; a rejection surfaces
   * there, not here. */
  headAhead(principal: RestPrincipal, bindingId: Hex, signal?: AbortSignal): UserOperationHeadAhead {
    const binding = this.options.currentBinding(principal.account.id, bindingId, signal);
    const latest = binding.then((found) => this.chain(signal).head(found.wallet.chainId));
    const reads = (async () => {
      const found = await binding, manifest = this.options.manifestFor(found), chain = this.chain(signal);
      const [head, nodePriority, , floor] = await Promise.all([
        chain.nonce(found.wallet.chainId, found.wallet.address, 0n, manifest.entryPoint!, latest),
        chain.request(found.wallet.chainId, "eth_maxPriorityFeePerGas", []),
        this.options.provider.readiness(found.wallet.chainId, signal),
        this.options.provider.gasPrice(found.wallet.chainId, signal),
      ]);
      return { head, nodePriority, ready: true as const, floor, chainId: found.wallet.chainId, sender: found.wallet.address,
        entryPoint: manifest.entryPoint!.address, readAt: Date.now() };
    })();
    const head = latest.then((read) => read.evidence);
    for (const promise of [latest, reads, head]) promise.catch(() => undefined);
    return { bindingId, nonceKey: 0n, head, reads };
  }
  async prepare(
    principal: RestPrincipal,
    input: UserOperationPreparationInput,
    key: string,
    requestHash: Hex,
    signal?: AbortSignal,
    ahead?: UserOperationHeadAhead,
  ) {
    if (!principal.scopes.includes("plan"))
      fail(
        "USER_OPERATION_SCOPE_REQUIRED",
        "Preparation requires plan scope.",
        403,
      );
    exactObject(
      input,
      ["planId", "stepIndexes", "sessionId", "sponsorAuthorization"],
      "user operation",
    );
    appOperation(principal, principal.account.authorityChainId, Object.hasOwn(input, "sessionId"));
    if (
      Object.hasOwn(input, "sessionId") &&
      (typeof input.sessionId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          input.sessionId,
        ))
    )
      fail(
        "USER_OPERATION_SESSION_INVALID",
        "A supplied sessionId must be an exact session UUID.",
        400,
      );
    const actor = actorOf(principal),
      inputHash = uoHash(requestHash, "request hash");
    const existing = await this.options.store.find(actor, key, inputHash);
    if (existing) {
      appOperation(principal, existing.chainId, existing.session !== undefined);
      return this.view(existing);
    }
    const plan = await this.plan(actor, input.planId, true);
    appOperation(principal, plan.smartAccount!.chainId, false);
    await this.options.sessions?.assertOwnerPlan(principal, plan);
    if (
      !Array.isArray(input.stepIndexes) ||
      input.stepIndexes.length < 1 ||
      input.stepIndexes.length > 16 ||
      input.stepIndexes.some(
        (index, i) =>
          !Number.isSafeInteger(index) ||
          !plan.steps[index] ||
          (i > 0 && index <= input.stepIndexes[i - 1]!),
      )
    )
      fail(
        "USER_OPERATION_STEPS_INVALID",
        "Select 1–16 distinct steps in their original order.",
        400,
      );
    if (input.sessionId && input.stepIndexes.length !== 1)
      fail(
        "SESSION_SINGLE_EXECUTION_REQUIRED",
        "The reviewed session guard permits one exact action per UserOperation.",
        400,
      );
    const selected = new Set(input.stepIndexes);
    for (const index of selected) {
      const step = plan.steps[index]!;
      if (step.state !== "waiting" || step.attempt || step.externalExecution)
        fail(
          "USER_OPERATION_STEP_RESERVED",
          "A selected step already has an execution transport.",
        );
      for (const dependency of plan.draft.calls[index]!.dependsOn) {
        if (selected.has(dependency)) continue;
        const prerequisite = plan.steps[dependency]!;
        if (
          prerequisite.state !== "confirmed" ||
          !prerequisite.receipt?.canonical ||
          prerequisite.receipt.status !== "success" ||
          !prerequisite.semantic ||
          !["verified", "unmodeled"].includes(prerequisite.semantic.status)
        )
          fail(
            "USER_OPERATION_DEPENDENCIES_UNCONFIRMED",
            "Prerequisites outside this atomic operation need verified canonical results.",
          );
      }
    }
    const stages: Record<string, number> = {};
    const stage = ((last) => (name: string) => { const now = Date.now(); stages[name] = now - last; last = now; })(Date.now());
    // The owner reads start beside the account's and are awaited with the head reads; an account
    // refused here reports its owner divergence first, when it has one.
    const owners = this.owners(plan, signal);
    owners.catch(() => undefined);
    let account: Awaited<ReturnType<typeof this.account>>, passkeyProfile: ReturnType<typeof userOperationPasskeyProfile>;
    try { account = await this.account(plan, signal); passkeyProfile = userOperationPasskeyProfile(account.binding, account.manifest); }
    catch (error) { await owners; throw error; }
    const { binding, manifest } = account;
    stage("accountMs");
    if (passkeyProfile && input.sessionId)
      fail("USER_OPERATION_PASSKEY_SESSION_UNAVAILABLE", "The passkey pilot requires fresh owner approval for every operation.", 422);
    if (passkeyProfile) this.passkeyPayMetadata(plan, input.stepIndexes);
    const policy = this.policy(binding.wallet.chainId);
    if (input.sessionId && input.sponsorAuthorization !== undefined)
      fail('SPONSOR_OWNER_REQUIRED', 'Application sponsorship requires fresh owner approval.', 403);
    const provider = input.sponsorAuthorization === undefined ? this.options.provider :
      this.options.sponsorRoutes?.authorize(input.sponsorAuthorization, {
        accountId: actor.accountId, planId: plan.id, chainId: binding.wallet.chainId,
        stepIndexes: input.stepIndexes, idempotencyKey: key,
        // A voucher bound by content is checked against the whole plan: every call, under its manifest.
        manifestRevision: plan.smartAccount!.manifestRevision,
        calls: plan.draft.calls.map((call) => ({ chainId: call.chainId, to: call.to, data: call.data, value: call.value })),
      }) ?? fail('SPONSOR_ROUTE_UNAVAILABLE', 'Application sponsorship is not configured.', 403);
    let session: UserOperationSessionBinding | undefined;
    let gasSession: StoredSession | undefined;
    if (input.sessionId) {
      const verified = await this.session(principal, input.sessionId, signal);
      if (verified.record.compiled.bindingId !== binding.id)
        fail(
          "SESSION_ACCOUNT_MISMATCH",
          "The session belongs to another wallet.",
        );
      session = verified.binding;
      gasSession = verified.record;
      for (const index of input.stepIndexes) {
        const call = plan.draft.calls[index]!;
        assertCompiledSessionCall(verified.record.compiled, {
          target: call.to,
          value: call.value,
          callData: call.data,
        });
      }
    }
    const chain = this.chain(signal);
    const nonceKey = session
      ? BigInt(safe7579NonceKey(manifest.smartSessions.address))
      : 0n;
    // The bundler's readiness, the nonce at the head (which carries the base fee) and the two fee
    // quotes are independent: they go out together.
    // Each read's own time, since the head stage is the slowest of the four.
    const timed = <T>(name: string, work: Promise<T>) => { const from = Date.now(); return work.finally(() => { stages[name] = Date.now() - from; }); };
    // Reads started ahead of the plan are used when they are for exactly this binding, key and
    // EntryPoint and no older than a few seconds; the canonical check beside the sponsorship still
    // proves their head.
    const early = ahead && ahead.bindingId === binding.id && ahead.nonceKey === nonceKey
      ? ahead.reads.then((reads) => reads.chainId === binding.wallet.chainId && same(reads.sender, binding.wallet.address)
          && same(reads.entryPoint, manifest.entryPoint!.address) && Date.now() - reads.readAt <= 10_000 ? reads : undefined)
      : Promise.resolve(undefined);
    const [, , { nonce, evidence, baseFeePerGas }, nodePriority, floor] = await Promise.all([
      timed("ownersMs", owners),
      timed("readinessMs", early.then((reads) => reads?.ready ? undefined : provider.readiness(binding.wallet.chainId, signal))),
      timed("nonceMs", early.then((reads) => reads?.head ?? chain.nonce(binding.wallet.chainId, binding.wallet.address, nonceKey, manifest.entryPoint!))),
      timed("priorityMs", early.then((reads) => reads?.nodePriority ?? chain.request(binding.wallet.chainId, "eth_maxPriorityFeePerGas", []))),
      timed("gasPriceMs", early.then((reads) => reads ? reads.floor : provider.gasPrice(binding.wallet.chainId, signal))),
    ]);
    if (ahead) stages.aheadUsed = (await early) ? 1 : 0;
    stage("headMs");
    await this.retiredClear(binding.wallet.chainId, binding.wallet.address, manifest.entryPoint!.address, BigInt(nonce), evidence, signal);
    // Never below the bundler's floor: a cheaper operation is accepted, then waits until it expires.
    const priority = max(uoQuantity(nodePriority, "priority fee"), floor?.maxPriorityFeePerGas ?? 0n);
    const fee = max(uoQuantity(baseFeePerGas, "base fee") * 2n + priority, floor?.maxFeePerGas ?? 0n);
    if (
      fee > policy.gas.maximumFeePerGas ||
      priority > policy.gas.maximumPriorityFeePerGas
    )
      fail(
        "USER_OPERATION_FEE_LIMIT",
        "Current network fees exceed the operator's approved gas policy.",
      );
    let operation: UserOperationV07 = {
      sender: binding.wallet.address,
      nonce,
      signature: "0x",
      callData: encodeSafe7579Execution(
        input.stepIndexes.map((index) => {
          const call = plan.draft.calls[index]!;
          return { target: call.to, value: call.value, callData: call.data };
        }),
      ),
      callGasLimit: toHex(policy.gas.maximumCallGas),
      verificationGasLimit: toHex(policy.gas.maximumVerificationGas),
      preVerificationGas: toHex(policy.gas.maximumPreVerificationGas),
      maxFeePerGas: toHex(fee),
      maxPriorityFeePerGas: toHex(priority),
    };
    // The bundler simulates the calls; a payment it refuses says why when the calls do.
    const explained = <T>(work: Promise<T>) => work.catch(async (error: unknown) => {
      throw await explainedRefusal(error, chain, binding.wallet.chainId, operation.sender, operation.callData);
    });
    const createdAt = this.now();
    let expiresAt = Math.min(plan.expiresAt, createdAt + 300_000);
    const dummy = (expiry = expiresAt) =>
      session
        ? encodeLegacyUseSignature(session.permissionId, dummySignature)
        : passkeyProfile
        ? passkeyDummySignature({ signer: passkeyProfile.signer.address,
            validAfter: String(Math.floor(createdAt / 1000)), validUntil: String(Math.floor(expiry / 1000)) })
        : encodeSafe7579OwnerSignature({
            validAfter: String(Math.floor(createdAt / 1000)),
            validUntil: String(Math.floor(expiry / 1000)),
            signatures: `0x${dummySignature.slice(2).repeat(binding.state.threshold)}`,
          });
    const providerConfig = provider.configuration(
      binding.wallet.chainId,
    );
    const sponsorable = Boolean(providerConfig.paymasterPolicy);
    if ((session || policy.gas.requirePaymaster) && !sponsorable)
      fail(
        "USER_OPERATION_PAYMASTER_REQUIRED",
        "This operation requires the reviewed gas-only sponsor.",
        503,
      );
    // Signa meters the operator's Pimlico sponsorship per account and chain; an app's own sponsor
    // route is the app's to meter. An owner operation the cap or the sponsor refuses is prepared for
    // the account to pay, before the passkey signs; one that must be sponsored is refused instead.
    const caps = sponsorable && input.sponsorAuthorization === undefined ? this.options.sponsorCaps : undefined;
    const fallback = caps !== undefined && !session && !policy.gas.requirePaymaster;
    const id = randomUUID();
    const gasEstimation = gasSession
      ? await createSessionGasEstimation(gasSession, policy.gas, operation)
      : undefined;
    if (gasEstimation) operation = gasEstimation.fit(operation, true);
    let refused: Extract<ReviewGas, { payer: "account" }>["reason"] | undefined;
    if (caps) {
      const reserved = await caps.reserve({ chainId: binding.wallet.chainId, accountId: actor.accountId, operationId: id,
        reservationWei: sponsoredCeiling(operation, policy.gas), expiresAt });
      if (!reserved.ok) refused = reserved.reason;
    }
    if (refused && !fallback)
      fail("USER_OPERATION_SPONSOR_UNAVAILABLE", refused === "paused"
        ? "Gas sponsorship is paused. Try again later." : "This account's sponsored gas for today is used. Try again tomorrow.", 429);
    const estimateProvider = passkeyProfile ? passkeyEstimateProvider(provider, policy.gas.maximumVerificationGas) : provider;
    const unpriced = operation;
    const priced = async (sponsored: boolean) => {
      let operation = unpriced, until = expiresAt;
      const stub = sponsored
        ? await explained(provider.stub(
            binding.wallet.chainId,
            operation,
            signal,
          ))
        : undefined;
      stage("stubMs");
      if (stub) operation = stub.operation;
      if (gasEstimation && !stub?.isFinal)
        operation = gasEstimation.fit(operation);
      gasEstimation?.assert(operation);
      const estimate = await explained(estimateProvider.estimate(
        binding.wallet.chainId,
        { ...operation, signature: dummy(until) },
        signal,
        gasEstimation,
      ));
      if (stub?.isFinal) {
        // A final stub binds its exact supplied gas fields. Keep them if they cover the independent estimate.
        for (const [field, amount] of Object.entries(estimate))
          if (
            BigInt(amount) >
            BigInt(operation[field as keyof UserOperationV07] ?? "0x0")
          )
            fail(
              "USER_OPERATION_SPONSOR_GAS_CHANGED",
              "The final stub cannot cover the current gas estimate. Prepare a fresh sponsored operation.",
            );
        until = Math.min(until, stub.proof.validUntil * 1000);
      } else operation = applyUserOperationEstimate(operation, estimate);
      stage("estimateMs");
      gasEstimation?.assert(operation);
      // The head is checked canonical one last time beside the final sponsorship, the last network
      // step, rather than after it; a head that moved fails the preparation either way.
      const [funded] = await Promise.all([
        sponsored && !stub?.isFinal
          ? explained(finalizeUserOperationSponsorship({
              chainId: binding.wallet.chainId,
              operation,
              gasPolicy: policy.gas,
              profile: providerConfig.paymasterPolicy?.profile,
              expiresAt: until,
              dummySignature: dummy,
              provider: estimateProvider,
              sessionGas: gasEstimation,
              signal,
              // The passkey margins (calldata bytes and verification headroom) cover a same-size sponsorship.
              marginsCoverSameSizeSponsorship: passkeyProfile !== undefined,
            }))
          : Promise.resolve(null),
        chain.canonical(evidence),
        // The plan's own evidence is proved here when it is not this head (a stale ahead read, or a
        // plan stored before a refused sponsorship): the quote it pinned must stand on a canonical block.
        ...plan.draft.evidence
          .filter((e) => e.chainId === binding.wallet.chainId
            && (BigInt(e.blockNumber) !== BigInt(evidence.blockNumber) || !same(e.blockHash, evidence.blockHash)))
          .map((e) => chain.canonical(e)),
      ]);
      if (funded) {
        operation = funded.operation;
        until = funded.expiresAt;
      }
      stage("sponsorMs");
      // The reservation becomes this operation's own maximum gas cost.
      if (sponsored && caps) {
        const reserved = await caps.reserve({ chainId: binding.wallet.chainId, accountId: actor.accountId, operationId: id,
          reservationWei: userOperationMaximumCost(operation), expiresAt: until });
        if (!reserved.ok) fail("USER_OPERATION_SPONSOR_UNAVAILABLE", "This account's sponsored gas for today is used. Try again tomorrow.", 429);
      }
      return { operation, expiresAt: until };
    };
    const sponsored = sponsorable && refused === undefined;
    let result: Awaited<ReturnType<typeof priced>>;
    try {
      result = await priced(sponsored);
    } catch (error) {
      if (sponsored && caps) await caps.release({ operationId: id });
      // A sponsor that refuses or fails leaves the account to pay, in the same review.
      if (!sponsored || !fallback || signal?.aborted) throw error;
      refused = "sponsor-refused";
      result = await priced(false);
    }
    ({ operation, expiresAt } = result);
    let gas: ReviewGas | undefined;
    if (operation.paymaster) gas = { payer: "pimlico", chainId: binding.wallet.chainId, paymaster: operation.paymaster.toLowerCase() as Address };
    else if (refused) {
      // Read before the review is served: the passkey never signs an operation its account cannot prefund.
      const balance = uoQuantity(await chain.request(binding.wallet.chainId, "eth_getBalance", [binding.wallet.address, chain.tag(evidence)]),
        "account native balance");
      const maximum = userOperationMaximumCost(operation);
      gas = { payer: "account", chainId: binding.wallet.chainId, maximumWei: maximum.toString(), reason: refused,
        balanceWei: balance.toString(), funded: balance >= maximum };
    }
    assertUserOperationGasPolicy(operation, policy.gas);
    gasEstimation?.assert(operation);
    operation = normalizeUserOperation(operation);
    const operationHash = getUserOperationHash(
      operation,
      manifest.entryPoint!.address,
      binding.wallet.chainId,
    );
    const record: UserOperationRecord = {
      id,
      actor,
      planId: plan.id,
      planCommitment: plan.commitment,
      stepIndexes: [...input.stepIndexes],
      chainId: binding.wallet.chainId,
      entryPoint: manifest.entryPoint!.address,
      sender: binding.wallet.address,
      operation,
      operationHash,
      preparationKey: key,
      inputHash,
      commitment: digest({
        planId: plan.id,
        planCommitment: plan.commitment,
        operation,
        operationHash,
        accountBindingId: binding.id,
        accountStateHash: binding.state.stateHash,
        ...(session ? { session } : {}),
        gasPolicyId: policy.gas.id,
        providerId: providerConfig.providerId,
        createdAt,
        expiresAt,
      }),
      accountBindingId: binding.id,
      accountStateHash: binding.state.stateHash,
      ...(session ? { session } : {}),
      gasPolicyId: policy.gas.id,
      providerId: providerConfig.providerId,
      createdAt,
      expiresAt,
      revision: 0,
      state: "prepared",
      ...(gas ? { gas } : {}),
    };
    const view = this.view(await this.options.store.create(record, this.now()));
    stage("storeMs");
    // Where a preparation's time goes, for the production log; the request line only has the total.
    console.info(JSON.stringify({ service: "user-operations", action: "prepare_stages", ...stages }));
    return view;
  }

  /** A retired approval's signed bytes are still out there (its app holds them), and so are those of
   * an operation whose whole bundle reverted, which rolled its nonce back. Until the chain settles
   * one, Signa prepares or admits another operation from the same sender only at its very nonce, so
   * the EntryPoint runs at most one of the two. It settles when its nonce is unchanged on a canonical
   * head two minutes of blocks past its enforceable deadline (it never ran and never can), or when
   * Signa's own operation at that nonce, the reverted one included, executed in a successful outer
   * transaction. A nonce that moved any other way may have been the operation itself: nothing is
   * prepared over it. Returns the operations checked, which the claim requires to be all there are. */
  private async retiredClear(chainId: number, sender: Address, entryPoint: Address, nonce: bigint, head: RestBlockEvidence, signal?: AbortSignal) {
    const checked: string[] = [];
    for (const old of await this.options.store.retired(chainId, sender)) {
      checked.push(old.id);
      const used = BigInt(old.operation.nonce);
      if (used === nonce) continue;
      const current = await this.chain(signal).readNonce(chainId, sender, used >> 64n, entryPoint, head);
      let settled = false;
      if (current === used) {
        const deadline = this.executionDeadline(old);
        settled = deadline !== undefined && BigInt(head.timestamp) > BigInt(deadline) + 120n;
        if (!settled) fail("USER_OPERATION_RETIRED_OPEN",
          "An earlier payment from this wallet can still execute. Pay again from the same review flow, or wait until it ends.", 409);
      } else {
        // Each execution is rechecked against the chain here: a reorged block is no evidence.
        // Every operation Signa sent at that nonce, settled ones and the old one itself included: one
        // canonical execution settles it, whatever another candidate's refresh does.
        const candidates = await this.options.store.sentAt(chainId, sender, used);
        const results = await Promise.allSettled(candidates.map((candidate) => this.refresh(candidate, signal)));
        const seen = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        settled = seen.some((record) => (record.state === "confirmed" || record.state === "reverted") && record.observation?.receipt?.status === "success");
        const failed = results.find((result) => result.status === "rejected");
        if (!settled && failed) throw failed.reason;
        if (!settled && seen.some(isRecoverable)) fail("USER_OPERATION_RETIRED_CONFIRMING",
          "The payment that replaced an earlier one is still confirming. Try again in a few seconds.", 409);
        if (!settled) fail("USER_OPERATION_RETIRED_NONCE_USED",
          "An earlier payment's nonce was used outside Signa. Check that payment before paying again.", 409);
      }
      await this.options.store.settleRetired(old.id);
    }
    return checked;
  }

  /** When the EntryPoint stops accepting this operation, in seconds. An owner signature binds the
   * preparation's validity. A session signature binds none, so only its sponsor's signed window ends
   * it (a session operation is always sponsored); without a readable one, nothing ends it. */
  private executionDeadline(record: UserOperationRecord): number | undefined {
    if (!record.session) return Math.floor(record.expiresAt / 1000);
    try {
      return this.providerForRecord(record).configuration(record.chainId).paymasterPolicy?.inspect(record.operation, "final").validUntil;
    } catch {
      return undefined;
    }
  }

  private session(
    principal: RestPrincipal,
    id: string,
    signal?: AbortSignal,
    evidence?: RestBlockEvidence,
  ) {
    appOperation(principal, principal.account.authorityChainId, true);
    if (!this.options.sessions)
      return fail(
        "SESSIONS_UNAVAILABLE",
        "No reviewed session execution stack is configured.",
        503,
      );
    return this.options.sessions.executionBinding(
      principal,
      id,
      signal,
      evidence,
    );
  }

  async submit(
    principal: RestPrincipal,
    id: string,
    signature: Hex,
    key: string,
    signal?: AbortSignal,
  ) {
    const actor = actorOf(principal);
    const record =
      (await this.options.store.get(actor, id)) ??
      fail(
        "USER_OPERATION_NOT_FOUND",
        "UserOperation preparation was not found.",
        404,
      );
    exactActor(actor, record);
    appOperation(principal, record.chainId, record.session !== undefined);
    const operation = normalizeUserOperation({
      ...record.operation,
      signature,
    });
    const signedCommitment = userOperationCommitment(
      operation,
      record.entryPoint,
      record.chainId,
    );
    if (record.submission) return this.replayed(record, signedCommitment, signal);
    if (record.state === "retired") retiredFailure();
    const requestAuthority = await this.options.authorizeRequest(
      actor,
      id,
      signature,
    );
    const plan = await this.plan(actor, record.planId, true);
    await this.options.sessions?.assertOwnerPlan(principal, plan);
    return this.dispatch({ actor, principal, record, plan, operation, signedCommitment, key, authority: requestAuthority, signal });
  }

  /** An approval Signa refused is retired before a fresh one is reviewed: under the claim's own row
   * lock, so no replica claims it afterwards and no reopened approval page resends it. One a claim
   * already took comes back as that submission, to be followed instead. */
  async retire(principal: RestPrincipal, id: string, signal?: AbortSignal) {
    const actor = actorOf(principal);
    const record = (await this.options.store.get(actor, id)) ??
      fail("USER_OPERATION_NOT_FOUND", "UserOperation preparation was not found.", 404);
    exactActor(actor, record);
    appOperation(principal, record.chainId, record.session !== undefined);
    // An operation the owner never approved would hold the wallet's nonce for nothing.
    if (!record.submission && !(await this.options.approvedReview?.(id)))
      fail("USER_OPERATION_NOT_RETIRABLE", "Only an operation the owner approved can be retired.", 409);
    const current = await this.options.store.retire(actor, id);
    // Retired unsent: it never ran and never will through Signa, so its sponsorship is released.
    if (current.state === "retired") await this.meter(current);
    return this.view(current.submission ? await this.refresh(current, signal) : current);
  }

  /** The same signed bytes are published once: a second caller carrying them under another
   * publication key (the approval's own submission and the app's hand-back) observes the first. */
  private async replayed(record: UserOperationRecord, signedCommitment: Hex, signal?: AbortSignal) {
    if (record.submission!.commitment !== signedCommitment)
      fail(
        "USER_OPERATION_CONFLICT",
        "A different signed operation is already reserved.",
      );
    return this.view(await this.refresh(record, signal));
  }

  /** Submission on a payment review's own authority: the app asked for exactly this operation to be
   * reviewed with a signed request, and the owner approved it with the passkey. Every gate before
   * the send is the one an app-signed submission passes; only the request-level authorization is
   * replaced by the review's, and the grant's relay scope is still required at the claim. */
  async submitApproved(
    input: { actor: RestActor; operationId: string; signature: Hex; key: string; authority: { issuedAt: number; expiresAt: number } },
    signal?: AbortSignal,
  ) {
    const record =
      (await this.options.store.get(input.actor, input.operationId)) ??
      fail("USER_OPERATION_NOT_FOUND", "UserOperation preparation was not found.", 404);
    exactActor(input.actor, record);
    if (record.session)
      fail("USER_OPERATION_PASSKEY_SESSION_UNAVAILABLE", "The passkey pilot requires fresh owner approval for every operation.", 422);
    if (record.chainId !== SIGNA_HOME_CHAIN_ID) fail("USER_OPERATION_APP_CHAIN_UNAVAILABLE", "App wallet operations are available only on Base.", 403);
    const operation = normalizeUserOperation({ ...record.operation, signature: input.signature });
    const signedCommitment = userOperationCommitment(operation, record.entryPoint, record.chainId);
    if (record.submission) return this.replayed(record, signedCommitment, signal);
    if (record.state === "retired") retiredFailure();
    const plan = await this.plan(input.actor, record.planId, true);
    return this.dispatch({ actor: input.actor, principal: undefined, record, plan, operation, signedCommitment, key: input.key, authority: input.authority, signal });
  }

  private async dispatch(input: {
    actor: RestActor; principal: RestPrincipal | undefined; record: UserOperationRecord; plan: StoredPlan; operation: UserOperationV07;
    signedCommitment: Hex; key: string; authority: { issuedAt: number; expiresAt: number }; signal: AbortSignal | undefined;
  }) {
    const { actor, record, signedCommitment, signal } = input;
    // The approval's own submission and the app's hand-back carry the same bytes moments apart. A
    // second caller in this process joins the one in flight rather than checking everything twice;
    // one on another replica, or one whose checks fail against an operation the other already
    // published, observes the submission that landed instead of reporting a failure.
    const running = this.inflight.get(record.id);
    if (running && same(running.commitment, signedCommitment)) {
      await running.done;
      const current = await this.options.store.get(actor, record.id);
      if (current?.submission && same(current.submission.commitment, signedCommitment)) return this.view(await this.refresh(current, signal));
    }
    const publication = this.publish(input);
    this.inflight.set(record.id, { commitment: signedCommitment, done: publication.then(() => undefined, () => undefined) });
    try { return await publication; }
    finally { if (this.inflight.get(record.id)?.commitment === signedCommitment) this.inflight.delete(record.id); }
  }

  private async publish(input: {
    actor: RestActor; principal: RestPrincipal | undefined; record: UserOperationRecord; plan: StoredPlan; operation: UserOperationV07;
    signedCommitment: Hex; key: string; authority: { issuedAt: number; expiresAt: number }; signal: AbortSignal | undefined;
  }) {
    const { actor, record, signedCommitment, signal } = input;
    const stages: Record<string, number> = {};
    const stage = ((last) => (name: string) => { const now = Date.now(); stages[name] = now - last; last = now; })(Date.now());
    let claim: Awaited<ReturnType<UserOperationServiceDependencies["store"]["claim"]>>;
    try { claim = await this.admit(input, stages); }
    catch (error) {
      const current = await this.options.store.get(actor, record.id);
      if (current?.submission && same(current.submission.commitment, signedCommitment)) return this.view(await this.refresh(current, signal));
      // The chain's or bundler's simulation of the signed calls refused it: say why, when the calls do.
      throw await explainedRefusal(error, this.chain(signal), record.chainId, input.operation.sender, input.operation.callData);
    }
    stage("admitMs");
    if (!claim.dispatch)
      return this.view(await this.refresh(claim.record, signal));
    // Admission permanently reserves both plan transport and nonce before the only publication attempt.
    let state: "pending" | "submission_unknown" = "pending";
    try {
      await this.providerForRecord(record).send(record.chainId, input.operation, signal);
    } catch {
      state = "submission_unknown";
      this.options.forgetAccountState?.(input.plan);
    }
    stage("sendMs");
    const submitted = await this.options.store.settle(
      record.id,
      signedCommitment,
      state,
    );
    stage("settleMs");
    // Where a submission's time goes, for the production log.
    console.info(JSON.stringify({ service: "user-operations", action: "submit_stages", outcome: state, ...stages }));
    return this.view(submitted);
  }

  /** Submissions whose gates are running now, by operation: a same-bytes caller joins instead of repeating them. */
  private readonly inflight = new Map<string, { commitment: Hex; done: Promise<void> }>();
  /** Every gate before the nonce claim, then the claim itself. */
  private async admit(input: {
    actor: RestActor; principal: RestPrincipal | undefined; record: UserOperationRecord; plan: StoredPlan; operation: UserOperationV07;
    signedCommitment: Hex; key: string; authority: { issuedAt: number; expiresAt: number }; signal: AbortSignal | undefined;
  }, stages: Record<string, number> = {}) {
    const { actor, principal, record, plan, operation, signedCommitment, key, authority: requestAuthority, signal } = input;
    const stage = ((last) => (name: string) => { const now = Date.now(); stages[name] = now - last; last = now; })(Date.now());
    const id = record.id;
    const policy = this.policy(record.chainId);
    const provider = this.providerForRecord(record);
    if (
      record.expiresAt <= this.now() ||
      record.gasPolicyId !== policy.gas.id ||
      provider.configuration(record.chainId).providerId !==
        record.providerId
    )
      fail(
        "USER_OPERATION_PREPARATION_EXPIRED",
        "The operation expired or its provider policy changed.",
      );
    // The plan's manifest is the binding's: the account check requires the same revision.
    const planManifest = this.options.manifestForPlan(plan);
    // A passkey profile requires threshold one; the account check below enforces it.
    if (planManifest.ownerProfile && !record.session) assertPasskeyUserOperationEnvelope({ operation, threshold: 1,
      validAfter: String(Math.floor(record.createdAt / 1000)), validUntil: String(Math.floor(record.expiresAt / 1000)) });
    // The head-bound checks were run ahead of the approval when the review was created or read
    // (`speculate`); an approval within their window takes them and does only what needs the
    // signature. Otherwise they run here, as they always did.
    const held = this.speculated.get(record.id);
    this.speculated.delete(record.id);
    const carried = held && held.revision === record.revision && this.now() - held.at <= speculationMaxAgeMs ? held : undefined;
    if (carried) { stages.speculatedAgeMs = this.now() - carried.at; stages.speculatedHead = Number(carried.head.blockNumber); }
    const { head, binding, manifest, preflight } = carried ?? await this.verifyAtHead({ record, plan, operation, policy, provider, planManifest, signal }, stage);
    if (manifest.id !== planManifest.id || manifest.revision !== planManifest.revision)
      fail("USER_OPERATION_ACCOUNT_CHANGED", "The plan's reviewed owner or module configuration changed.");
    const passkeyProfile = userOperationPasskeyProfile(binding, manifest);
    if (passkeyProfile && record.session)
      fail("USER_OPERATION_PASSKEY_SESSION_UNAVAILABLE", "The passkey pilot requires fresh owner approval for every operation.", 422);
    if (passkeyProfile) this.passkeyPayMetadata(plan, record.stepIndexes);
    let sessionObservationHash: Hex | undefined;
    let validAfter = Math.floor(record.createdAt / 1000),
      validUntil = Math.floor(record.expiresAt / 1000);
    if (record.session) {
      if (!principal) fail("USER_OPERATION_APP_SESSION_UNAVAILABLE", "Session operations need the requesting principal.", 403);
      const fresh = await this.session(principal, record.session.id, signal);
      const { observationHash: _old, ...priorIdentity } = record.session;
      const { observationHash, ...freshIdentity } = fresh.binding;
      if (uoCanonical(priorIdentity) !== uoCanonical(freshIdentity))
        fail(
          "SESSION_GENERATION_CHANGED",
          "The exact installed session generation changed.",
        );
      sessionObservationHash = observationHash;
      await verifyLegacySessionSignature({
        operation,
        chainId: record.chainId,
        entryPoint: record.entryPoint,
        smartSessions: manifest.smartSessions.address,
        permissionId: record.session.permissionId,
        sessionKey: record.session.sessionKey,
      });
      validAfter = Math.max(validAfter, fresh.record.compiled.validAfter);
      validUntil = Math.min(validUntil, fresh.record.compiled.validUntil);
    } else if (passkeyProfile) {
      // The signature check and the signed estimate both need only the verified account, so they
      // run together. The bundler sees the signed bytes only after the account check passed. The
      // dummy margin covers ordinary calldata bytes, not Base L1 compression fees or every FCL
      // verification path: the exact signed operation is checked before claim. This is
      // point-in-time provider evidence; later fee changes remain possible.
      const admission = await Promise.allSettled([
        // Carried from a speculation: the owners are read again now, beside the signature checks.
        carried ? this.owners(plan, signal) : undefined,
        // Carried from a speculation: the EntryPoint's validation of the exact signed bytes, the
        // one head-bound check that needs the signature, runs now at that same head.
        carried ? this.chain(signal).validateSigned(this.execution(record, operation, plan, planManifest), carried.head, carried.preflight.validationOrigin ?? "0x000000000000000000000000000000000000dEaD") : undefined,
        verifyPasskeyUserOperation({ operation, binding, manifest, chain: this.chain(signal),
          validAfter: String(validAfter), validUntil: String(validUntil),
          verifyContractSignature: createPasskeyContractSignatureVerifier({ state: binding.state, manifest,
            rpc: this.options.rpc, now: this.now, ...(signal ? { signal } : {}) }) }),
        provider.estimate(record.chainId, operation, signal).then((signedEstimate) => {
          for (const [field, amount] of Object.entries(signedEstimate))
            if (BigInt(amount) > BigInt(operation[field as keyof UserOperationV07] ?? "0x0"))
              fail("USER_OPERATION_SIGNED_GAS_CHANGED",
                "The exact signed operation requires more gas than was approved. Prepare and approve a fresh operation.");
        }),
      ]);
      stage("signatureMs");
      for (const check of admission) if (check.status === "rejected") { this.options.forgetAccountState?.(plan); throw check.reason; }
    } else {
      await verifySafe7579OwnerSignature({
        operation,
        chainId: record.chainId,
        entryPoint: record.entryPoint,
        safe7579: manifest.safe7579.address,
        validAfter: String(validAfter),
        validUntil: String(validUntil),
        owners: binding.state.owners,
        threshold: binding.state.threshold,
      });
    }
    if (record.session) {
      const fresh = await this.session(
        principal!,
        record.session.id,
        signal,
        preflight.evidence,
      );
      const { observationHash: _old, ...priorIdentity } = record.session;
      const { observationHash, ...freshIdentity } = fresh.binding;
      if (uoCanonical(priorIdentity) !== uoCanonical(freshIdentity))
        fail(
          "SESSION_GENERATION_CHANGED",
          "The session changed during canonical preflight.",
        );
      sessionObservationHash = observationHash;
    }
    const authorization = {
      issuedAt: Math.max(requestAuthority.issuedAt, validAfter),
      expiresAt: Math.min(requestAuthority.expiresAt, validUntil),
    };
    // A preparation made before an approval was retired is held to the same rule here, and the claim
    // refuses if another one was retired meanwhile.
    const retiredChecked = await this.retiredClear(record.chainId, record.sender, record.entryPoint, BigInt(operation.nonce), head, signal);
    // Signed and about to be claimed: its sponsorship reservation no longer lapses.
    if (record.operation.paymaster) await this.options.sponsorCaps?.hold({ operationId: id });
    const claimed = await this.options.store.claim({
      actor,
      id,
      key,
      operation,
      signedCommitment,
      authorization,
      retiredChecked,
      ...(sessionObservationHash ? { sessionObservationHash } : {}),
      now: this.now(),
    });
    stage("claimMs");
    return claimed;
  }

  /** One canonical head for the whole submission. The account verification, the EntryPoint
   * preflight and the owner reads on every chain are independent, so they run together; all must
   * pass before the signature check, the signed estimate and the nonce claim. */
  private async verifyAtHead(input: {
    record: UserOperationRecord; plan: StoredPlan; operation: UserOperationV07; policy: ReturnType<UserOperationService["policy"]>;
    provider: UserOperationProvider; planManifest: SmartAccountManifest; signal: AbortSignal | undefined;
    /** Ahead of the signature: everything but the EntryPoint's validation of the signed bytes. */
    signed?: boolean;
  }, stage: (name: string) => void) {
    const { record, plan, operation, policy, provider, planManifest, signal } = input;
    const head = await this.chain(signal).snapshot(record.chainId);
    stage("headMs");
    const checks = await Promise.allSettled([
      this.account(plan, signal, head),
      this.chain(signal).preflight(this.execution(record, operation, plan, planManifest), policy.gas, provider, head, { signed: input.signed !== false }),
      this.owners(plan, signal),
    ]);
    stage("checksMs");
    // All finished; an owner divergence is named first, as at preparation, then the account and the simulation.
    const [accountCheck, preflightCheck, ownersCheck] = checks;
    for (const check of [ownersCheck, accountCheck, preflightCheck]) if (check.status === "rejected") throw check.reason;
    const { binding, manifest } = (accountCheck as PromiseFulfilledResult<Awaited<ReturnType<typeof this.account>>>).value;
    const preflight = (preflightCheck as PromiseFulfilledResult<Awaited<ReturnType<UserOperationChain["preflight"]>>>).value;
    return { head, binding, manifest, preflight };
  }
  /** The admission's head-bound checks, run ahead of the approval and held per operation: keyed by the
   * operation and the head they were made at, taken by an admission of the same record revision within
   * `speculationMaxAgeMs`, dropped otherwise. The operation bytes are fixed at preparation, so only the
   * signature is new at the approval; the checks here see a dummy signature and depend on none. */
  private readonly speculated = new Map<string, { at: number; revision: number } & Awaited<ReturnType<UserOperationService["verifyAtHead"]>>>();
  /** One speculation per operation at a time: the page reads that arrive meanwhile add nothing. */
  private readonly speculating = new Map<string, Promise<void>>();
  speculate(actor: RestActor, operationId: string): Promise<void> {
    const running = this.speculating.get(operationId);
    if (running) return running;
    const work = this.runSpeculation(actor, operationId).finally(() => { if (this.speculating.get(operationId) === work) this.speculating.delete(operationId); });
    this.speculating.set(operationId, work);
    return work;
  }
  private async runSpeculation(actor: RestActor, operationId: string): Promise<void> {
    const stages: Record<string, number> = {};
    const stage = ((last) => (name: string) => { const now = Date.now(); stages[name] = now - last; last = now; })(Date.now());
    let record: UserOperationRecord | undefined;
    try {
      record = await this.options.store.get(actor, operationId);
      if (!record || record.submission || record.session || record.state !== "prepared" || record.expiresAt <= this.now()) return;
      const held = this.speculated.get(record.id);
      if (held && held.revision === record.revision && this.now() - held.at < speculationRefreshMs) return;
      const policy = this.policy(record.chainId), provider = this.providerForRecord(record);
      if (record.gasPolicyId !== policy.gas.id || provider.configuration(record.chainId).providerId !== record.providerId) return;
      const plan = await this.plan(actor, record.planId, true), planManifest = this.options.manifestForPlan(plan);
      // Only a passkey account's admission takes a speculation (its signature path runs the signed validation itself).
      if (!planManifest.ownerProfile) return;
      const operation = normalizeUserOperation({ ...record.operation, signature: dummySignature });
      // Aged from before the head snapshot: "at most a minute old" is measured from the head.
      const at = this.now();
      const result = await this.verifyAtHead({ record, plan, operation, policy, provider, planManifest, signal: undefined, signed: false }, stage);
      // Bounded: stale entries go on every write, and the map never outgrows its cap.
      for (const [id, entry] of this.speculated) if (this.now() - entry.at > speculationMaxAgeMs) this.speculated.delete(id);
      if (this.speculated.size >= speculationCap) this.speculated.delete(this.speculated.keys().next().value!);
      this.speculated.set(record.id, { ...result, at, revision: record.revision });
      console.info(JSON.stringify({ service: "user-operations", action: "speculate_stages", operation: record.id, head: Number(result.head.blockNumber), ...stages }));
    } catch (error) {
      console.info(JSON.stringify({ service: "user-operations", action: "speculate_failed", operation: operationId,
        code: String((error as { code?: unknown } | null)?.code ?? (error as { message?: unknown } | null)?.message ?? "error").slice(0, 80), ...stages }));
    }
  }

  /** A read; with `wait`, one that answers as soon as the record moves past the revision the caller
   * has (or reaches a final state), observing every couple of seconds meanwhile, until its deadline. */
  async get(principal: RestPrincipal, id: string, signal?: AbortSignal, wait?: { since: number; untilMs: number }) {
    if (!principal.scopes.includes("read"))
      fail(
        "USER_OPERATION_SCOPE_REQUIRED",
        "Reading operations requires read scope.",
        403,
      );
    for (;;) {
      const record =
        (await this.options.store.get(actorOf(principal), id)) ??
        fail("USER_OPERATION_NOT_FOUND", "The UserOperation was not found.", 404);
      appOperation(principal, record.chainId, record.session !== undefined);
      const current = record.submission ? await this.refresh(record, signal, true) : record;
      const remaining = wait ? wait.untilMs - Date.now() : 0;
      if (!wait || current.revision !== wait.since || !isRecoverable(current) || remaining <= 0) return this.view(current);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(UserOperationService.observationReuseMs, remaining));
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    }
  }

  private execution(
    record: UserOperationRecord,
    operation: UserOperationV07,
    plan: StoredPlan,
    manifest: SmartAccountManifest,
  ): UserOperationExecutionBinding {
    return {
      chainId: record.chainId,
      entryPoint: manifest.entryPoint!,
      accountCode: {
        address: record.sender,
        runtimeCodeHash: manifest.proxyRuntimeCodeHash,
      },
      operation,
      operationHash: record.operationHash,
      calls: record.stepIndexes.map((index) => plan.draft.calls[index]!),
    };
  }

  private providerForRecord(record: UserOperationRecord) {
    if (this.options.provider.configuration(record.chainId).providerId === record.providerId) return this.options.provider;
    return this.options.sponsorRoutes?.stored(record.providerId) ?? fail('SPONSOR_ROUTE_UNAVAILABLE', 'The stored sponsorship route is unavailable.');
  }

  /** One observation per operation at a time: a poll that arrives meanwhile joins it. */
  private readonly observing = new Map<string, Promise<UserOperationRecord>>();
  /** When each operation was last observed here, whether or not that observation was written. */
  private readonly lastObserved = new Map<string, number>();
  /** How long an observation waits for the account verification at the execution block before
   * answering without it. */
  // Zero by default: at an execution block the operation's own EntryPoint event is ingress, so the
  // account can never be carried there and the verification is a full inspection every time.
  private get verificationBudgetMs() { return this.options.verificationBudgetMs ?? 0; }
  /** Account verifications at execution blocks: under way, landed, and failed (run again in front). */
  private readonly verifying = new Map<string, Promise<void>>();
  private readonly verified = new Set<string>();
  private readonly verificationFailed = new Set<string>();
  /** A poll this soon after an observation answers from it. Base makes a block every two seconds and
   * its Flashblocks land four times a block, so an in-flight submission is looked at every second. */
  private static readonly observationReuseMs = 1_000;
  private refresh(input: UserOperationRecord, signal?: AbortSignal, poll = false): Promise<UserOperationRecord> {
    // Expired was proven against the chain and released its nonce; it is never re-observed.
    if (!input.submission || input.state === "expired") return Promise.resolve(input);
    const record = { ...input, submission: input.submission };
    const previous = record.observation;
    const seen = this.lastObserved.get(record.id) ?? previous?.observedAt;
    if (poll && seen !== undefined && this.now() - seen < UserOperationService.observationReuseMs)
      return Promise.resolve(record);
    // A confirmed execution stays confirmed while its block is canonical: one block read, nothing
    // written; only a reorg sends it through a full observation again.
    if (previous?.state === "confirmed" && previous.receipt?.canonical && previous.transactionHash) {
      const receipt = previous.receipt;
      return this.chain(signal).request(record.chainId, "eth_getBlockByNumber", [toHex(BigInt(receipt.blockNumber)), false])
        .then((block) => same((block as { hash?: string })?.hash ?? "", receipt.blockHash) ? record : this.observation(record));
    }
    return this.observation(record);
  }
  private observation(record: UserOperationRecord & { submission: NonNullable<UserOperationRecord["submission"]> }) {
    const running = this.observing.get(record.id);
    if (running) return running;
    // Detached from the request that started it: the observation is persisted for everyone who
    // joins it, so one poller's abort or timeout must not cut it short. Only shutdown stops it.
    const observation = detachedFromRequest(() => this.observe(record)).catch(async (error: unknown) => {
      // Another replica observed it first: its observation is the answer, not a conflict.
      if (error instanceof RestError && error.code === "USER_OPERATION_CONFLICT")
        return (await this.options.store.get(record.actor, record.id)) ?? record;
      throw error;
    }).finally(() => { if (this.observing.get(record.id) === observation) this.observing.delete(record.id); });
    this.observing.set(record.id, observation);
    return observation;
  }
  private async observe(record: UserOperationRecord & { submission: NonNullable<UserOperationRecord["submission"]> }) {
    const previous = record.observation;
    const plan = await this.plan(record.actor, record.planId, false);
    const manifest = this.options.manifestForPlan(plan);
    if (
      !manifest.entryPoint ||
      !same(manifest.entryPoint.address, record.entryPoint)
    )
      fail(
        "USER_OPERATION_STACK_CHANGED",
        "The stored operation's reviewed EntryPoint is unavailable.",
      );
    // A confirmed execution only gets here once its block is no longer canonical (see `refresh`),
    // so the provider's hint is asked for again; a hint never replaces observed chain evidence.
    let transactionHash = record.observation?.transactionHash;
    const provider = this.providerForRecord(record);
    try {
      transactionHash =
        (
          await provider.receipt(
            record.chainId,
            record.operationHash,
            undefined,
          )
        )?.transactionHash ?? transactionHash;
    } catch {
      /* A provider outage cannot replace independently observed chain evidence. */
    }
    // No receipt yet and no hash known: the bundler's status names the bundle's transaction as soon
    // as it is submitted, and Base's Flashblocks show its receipt before its block is canonical.
    if (!transactionHash) {
      try { transactionHash = (await provider.status(record.chainId, record.operationHash, undefined))?.transactionHash; }
      catch { /* A bundler without the method, or one that is down, is what the receipt path was already. */ }
    }
    const deadline = this.executionDeadline(record);
    const observation = await observeUserOperation({
      chain: this.chain(),
      binding: this.execution(
        record,
        record.submission.operation,
        plan,
        manifest,
      ),
      signedCommitment: record.submission.commitment,
      ...(transactionHash ? { transactionHash } : {}),
      // Past its enforceable deadline the operation can only be redone; a session's is its sponsor's.
      ...(deadline !== undefined ? { validUntil: deadline } : {}),
      confirmations: this.policy(record.chainId).confirmations,
      now: this.now(),
      // The account is verified once per execution block, behind the answer: the observation that
      // first sees the execution reports it as confirming with its evidence, the verification runs
      // detached and observes the operation again when it lands, and only then is it confirmed. A
      // verification that failed is run again in front of the next observation, so its error shows.
      verifyAccountAtBlock: async (_execution, evidence) => {
        if (previous?.verifiedAtBlock && same(previous.verifiedAtBlock, evidence.blockHash)) return;
        const key = `${record.id}:${evidence.blockHash.toLowerCase()}`;
        if (this.verified.has(key)) return;
        if (this.verifying.has(key)) return "pending";
        // Once failed behind an answer, it runs in front of every observation until it passes.
        if (this.verificationFailed.has(key)) { await this.options.verifyHistoricalAccount(plan, evidence); this.verificationFailed.delete(key); this.verified.add(key); return; }
        const check = detachedFromRequest(() => this.options.verifyHistoricalAccount(plan, evidence));
        const verification = check.then(
          async () => {
            this.verified.add(key);
            const current = await this.options.store.get(record.actor, record.id);
            if (current) await this.refresh(current);
          },
          (error: unknown) => {
            this.verificationFailed.add(key);
            console.info(JSON.stringify({ service: "user-operations", action: "account_verification", outcome: "failed",
              code: error instanceof RestError ? error.code : "unknown" }));
          },
        ).finally(() => this.verifying.delete(key));
        this.verifying.set(key, verification);
        // A verification carried from the last full one lands within the budget and confirms at
        // once; a full inspection does not, and the answer goes out without it.
        const settled = await Promise.race([check.then(() => true, () => false), new Promise<false>((resolve) => setTimeout(resolve, this.verificationBudgetMs, false))]);
        if (!settled) return "pending";
        this.verified.add(key);
      },
      // Traced once per settled revert: a later observation of the same transaction in the same block
      // keeps what the first found; a reorg's re-inclusion, or a revert first seen confirming, is traced.
      payFailure: async (hash: Hex, blockHash: Hex) =>
        previous?.state === "reverted" && previous.semantic?.status === "failed" && previous.transactionHash && same(previous.transactionHash, hash)
          && previous.receipt && same(previous.receipt.blockHash, blockHash)
          ? previous.payFailure
          : tracedPayFailure(this.chain(), record.chainId, hash, record.sender, record.submission.operation.callData),
      verifySemantics: async (receipt: StoredReceipt) => {
        if (previous?.semantic && previous.receipt && same(previous.receipt.blockHash, receipt.blockHash)
          && same(previous.receipt.transactionHash, receipt.transactionHash)) return previous.semantic;
        // A pay of the configured token through the configured terminal is the strict Base pay
        // domain: a rejected one cannot downgrade into weaker legacy single-step economic
        // evidence. Pays in other tokens or to other terminals keep the generic verification.
        if (this.options.v6UsdcPayment && record.chainId === this.options.v6UsdcPayment.chainId
          && walletV6UsdcPaymentDomain(plan, this.options.v6UsdcPayment)) {
          return verifyWalletV6UsdcPaymentEffects(plan, record.stepIndexes, this.options.v6UsdcPayment, receipt);
        }
        const results = await Promise.all(
          record.stepIndexes.map((index) =>
            this.options.semanticVerifier.verify(
              plan,
              index,
              receipt,
              this.options.rpc,
            ),
          ),
        );
        const status = results.some((r) => r.status === "failed")
          ? "failed"
          : results.some((r) => r.status === "unknown")
            ? "unknown"
            : results.every((r) => r.status === "unmodeled")
              ? "unmodeled"
              : results.length === 1
                ? "verified"
                : "unknown";
        return {
          status,
          details: {
            steps: results,
            ...(results.length > 1 && status === "unknown"
              ? {
                  reason:
                    "Atomic invocation is proved, but per-call economic results need independent event assignment. Use one operation per modeled journey step.",
                }
              : {}),
          },
        };
      },
    });
    this.lastObserved.set(record.id, this.now());
    if (observation.verifiedAtBlock) this.verified.delete(`${record.id}:${observation.verifiedAtBlock.toLowerCase()}`);
    // An observation that found nothing new is not written: the revision moves only with the record.
    if (previous && sameObservation(previous, observation)) return record;
    const saved = await this.options.store.observe(record.id, record.revision, { ...observation, observedAt: this.now() });
    await this.meter(saved);
    return saved;
  }

  /** A sponsored operation's reservation follows its outcome: the canonical charge once the
   * EntryPoint reports one, released once it is proven never to run, kept while it is unknown. A
   * metering write that fails keeps the reservation, which only counts more. */
  private async meter(record: UserOperationRecord): Promise<void> {
    const caps = this.options.sponsorCaps;
    if (!caps || !record.operation.paymaster) return;
    try {
      // Only a charge at its confirmation depth replaces the reservation: a shallower block can be reorged away.
      if ((record.state === "confirmed" || record.state === "reverted") && record.observation?.actualGasCost !== undefined)
        await caps.settle({ operationId: record.id, spentWei: BigInt(record.observation.actualGasCost) });
      else if (record.state === "expired" || (record.state === "retired" && !record.submission))
        await caps.release({ operationId: record.id });
    } catch (error) {
      console.info(JSON.stringify({ service: "user-operations", action: "sponsor_meter", outcome: "failed", operation: record.id,
        code: error instanceof RestError ? error.code : "unknown" }));
    }
  }

  async observePlanStep(
    plan: StoredPlan,
    index: number,
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExternalExecutionObservation> {
    const record = await this.options.store.get(plan.actor, id);
    if (
      !record ||
      record.planId !== plan.id ||
      record.planCommitment !== plan.commitment ||
      !record.stepIndexes.includes(index)
    )
      fail(
        "USER_OPERATION_PLAN_MISMATCH",
        "The external execution does not bind this exact plan step.",
      );
    const updated = await this.refresh(record, options.signal);
    const observation = updated.observation;
    return {
      stepIndex: index,
      chainId: record.chainId,
      providerState: updated.state,
      state:
        observation?.state ??
        (updated.state === "submission_unknown" ? "unknown" : "pending"),
      ...(observation?.transactionHash
        ? { hash: observation.transactionHash }
        : {}),
      ...(observation?.receipt ? { receipt: observation.receipt } : {}),
      ...(observation?.semantic ? { semantic: observation.semantic } : {}),
      ...(observation?.reason ? { reason: observation.reason } : {}),
    };
  }

  async recoverPending(limit = 5) {
    const records = await this.options.store.recoverable(
      limit,
      this.recoveryCursor,
    );
    const results = [];
    let oldestPendingAt: number | null = null;
    for (const record of records) {
      let current = record;
      try {
        current = await this.refresh(record);
        results.push({
          id: record.id,
          state: current.state,
        });
      } catch {
        results.push({ id: record.id, state: "verification-unavailable" });
      }
      if (isRecoverable(current)) {
        oldestPendingAt = Math.min(oldestPendingAt ?? Infinity, current.submission!.startedAt);
      }
    }
    this.recoveryCursor =
      records.length === limit
        ? recoveryCursor(records[records.length - 1]!)
        : undefined;
    return { items: results, broadcastAttempted: false, oldestPendingAt };
  }

  private async view(record: UserOperationRecord) {
    const plan = await this.plan(record.actor, record.planId, false);
    const manifest = this.options.manifestForPlan(plan);
    const signing = record.session
      ? legacySessionSigningPayload({
          operation: record.operation,
          chainId: record.chainId,
          entryPoint: record.entryPoint,
          smartSessions: manifest.smartSessions.address,
          permissionId: record.session.permissionId,
        })
      : manifest.ownerProfile?.version === "center-passkey-v1"
      ? { ...safe7579PasskeyOwnerSigningPayload({
          operation: record.operation,
          chainId: record.chainId,
          entryPoint: record.entryPoint,
          safe7579: manifest.safe7579.address,
          validAfter: String(Math.floor(record.createdAt / 1000)),
          validUntil: String(Math.floor(record.expiresAt / 1000)),
        }), ownerProfile: manifest.ownerProfile.version }
      : safe7579OwnerSigningPayload({
          operation: record.operation,
          chainId: record.chainId,
          entryPoint: record.entryPoint,
          safe7579: manifest.safe7579.address,
          validAfter: String(Math.floor(record.createdAt / 1000)),
          validUntil: String(Math.floor(record.expiresAt / 1000)),
        });
    return {
      id: record.id,
      planId: record.planId,
      planCommitment: record.planCommitment,
      stepIndexes: record.stepIndexes,
      chainId: record.chainId,
      entryPoint: record.entryPoint,
      operation: { ...record.operation, signature: "0x" },
      operationHash: record.operationHash,
      commitment: record.commitment,
      accountBindingId: record.accountBindingId,
      accountStateHash: record.accountStateHash,
      ...(record.session ? { session: record.session } : {}),
      gasPolicyId: record.gasPolicyId,
      providerId: record.providerId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      revision: record.revision,
      state: record.state,
      signing,
      ...(record.submission
        ? {
            submission: {
              commitment: record.submission.commitment,
              startedAt: record.submission.startedAt,
            },
          }
        : {}),
      ...(record.observation ? { observation: record.observation } : {}),
    };
  }
}
