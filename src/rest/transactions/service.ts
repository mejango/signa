import { createHash, randomUUID } from "node:crypto";
import {
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  RestError,
  type RestActor,
  type RestBlockEvidence,
  type RestPlanDraft,
  type RestRpc,
} from "../core.js";
import { encodeCursor, isRecoverableStep, type TransactionStore } from "./store.js";
import type { SmartAccountBinding } from "../smartAccounts/types.js";
import type {
  ExternalExecutionObserver,
  ExternalStepObservation,
  RelayPolicy,
  SemanticVerifier,
  SignedAttempt,
  StoredPlan,
  StoredReceipt,
  StoredStep,
} from "./types.js";
import {
  validateSignedTransaction,
  type ValidatedSignedTransaction,
} from "./signed.js";

export const DEFAULT_RELAY_POLICY: RelayPolicy = {
  planTtlMs: 300_000,
  maximumPlanTtlMs: 900_000,
  leaseMs: 30_000,
  rpcTimeoutMs: 10_000,
  maximumRawBytes: 131_072,
  maximumGas: 20_000_000n,
  maximumFeePerGas: 1_000_000_000_000n,
  maximumTransactionCost: 1_000n * 10n ** 18n,
  confirmations: 2,
  allowedChainIds: [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614],
};

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && value)
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",") +
      "}"
    );
  throw new RestError(
    400,
    "INVALID_PLAN",
    "Plans must contain finite JSON values.",
  );
}
const digest = (value: unknown) =>
  `0x${createHash("sha256").update(canonical(value)).digest("hex")}` as Hex;
const hex = (value: bigint) => `0x${value.toString(16)}` as Hex;
function quantity(value: unknown, name: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)
  )
    throw new RestError(
      502,
      "INVALID_RPC_RESPONSE",
      `RPC returned an invalid ${name}.`,
    );
  return BigInt(value);
}
function hash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}
function idempotency(key: string, requestHash: string, operation: string) {
  if (
    !/^[\x21-\x7e]{1,128}$/.test(key) ||
    !/^(0x)?[0-9a-fA-F]{64}$/.test(requestHash)
  )
    throw new RestError(
      400,
      "INVALID_IDEMPOTENCY",
      "Use an idempotency key of 1–128 printable non-space characters and the request body digest.",
    );
  return {
    key,
    requestHash: requestHash.toLowerCase().replace(/^0x/, ""),
    operation,
  };
}

export class TransactionService {
  private readonly store: TransactionStore;
  private readonly rpc: RestRpc;
  private readonly verifier: SemanticVerifier | undefined;
  private readonly externalObservers: readonly ExternalExecutionObserver[];
  private readonly authorizeDispatch:
    | ((
        plan: StoredPlan,
        stepIndex: number,
        transactionHash: Hex,
      ) => Promise<{ issuedAt: number; expiresAt: number }>)
    | undefined;
  private readonly now: () => number;
  private readonly resolveSmartAccount:
    | ((actor: RestActor, bindingId: Hex) => Promise<SmartAccountBinding>)
    | undefined;
  private readonly smartAccountExecution: {
    chainIds: readonly number[];
    sessionChainIds: readonly number[];
  };
  private recoveryCursor: string | undefined;
  readonly policy: RelayPolicy;

  constructor(options: {
    store: TransactionStore;
    rpc: RestRpc;
    semanticVerifier?: SemanticVerifier;
    externalObserver?: ExternalExecutionObserver;
    externalObservers?: readonly ExternalExecutionObserver[];
    authorizeDispatch?: (
      plan: StoredPlan,
      stepIndex: number,
      transactionHash: Hex,
    ) => Promise<{ issuedAt: number; expiresAt: number }>;
    now?: () => number;
    policy?: Partial<RelayPolicy>;
    resolveSmartAccount?: (
      actor: RestActor,
      bindingId: Hex,
    ) => Promise<SmartAccountBinding>;
    smartAccountExecution?: {
      chainIds: readonly number[];
      sessionChainIds: readonly number[];
    };
  }) {
    this.smartAccountExecution = options.smartAccountExecution ?? {
      chainIds: [],
      sessionChainIds: [],
    };
    this.store = options.store;
    this.rpc = options.rpc;
    this.verifier = options.semanticVerifier;
    this.externalObservers = [
      ...(options.externalObserver ? [options.externalObserver] : []),
      ...(options.externalObservers ?? []),
    ];
    if (
      new Set(this.externalObservers.map((o) => o.kind)).size !==
      this.externalObservers.length
    )
      throw new RestError(
        500,
        "INVALID_RELAY_POLICY",
        "Each external execution transport needs one verifier.",
      );
    this.authorizeDispatch = options.authorizeDispatch;
    this.now = options.now ?? Date.now;
    this.resolveSmartAccount = options.resolveSmartAccount;
    this.policy = { ...DEFAULT_RELAY_POLICY, ...options.policy };
    if (
      [
        this.policy.planTtlMs,
        this.policy.maximumPlanTtlMs,
        this.policy.leaseMs,
        this.policy.rpcTimeoutMs,
        this.policy.maximumRawBytes,
      ].some((value) => !Number.isSafeInteger(value)) ||
      this.policy.maximumRawBytes < 1 ||
      this.policy.maximumRawBytes > 262_144 ||
      this.policy.planTtlMs <= 0 ||
      this.policy.planTtlMs > this.policy.maximumPlanTtlMs ||
      this.policy.maximumPlanTtlMs > 900_000 ||
      this.policy.rpcTimeoutMs <= 0 ||
      this.policy.rpcTimeoutMs > 30_000 ||
      this.policy.leaseMs <= this.policy.rpcTimeoutMs ||
      this.policy.maximumGas <= 0n ||
      this.policy.maximumFeePerGas <= 0n ||
      this.policy.maximumTransactionCost <= 0n
    ) {
      throw new RestError(
        500,
        "INVALID_RELAY_POLICY",
        "Relay policy has inconsistent lifetime or cost bounds.",
      );
    }
    for (const chain of this.policy.allowedChainIds) this.confirmations(chain);
  }

  capabilities() {
    return {
      transports: [
        {
          kind: "signed-eoa-transaction",
          supported: true,
          transactionTypes: ["legacy-eip155", "eip2930", "eip1559"],
          requiresWalletSignatureForEachTransaction: true,
        },
        {
          kind: "eip4337-user-operation",
          supported: this.smartAccountExecution.chainIds.length > 0,
          chainIds: [...this.smartAccountExecution.chainIds],
          preparationEndpoint: "/api/v1/user-operations",
          reason:
            this.smartAccountExecution.chainIds.length > 0
              ? "Use the configured UserOperation transport for verified smart-account plans."
              : "A hosted bundler and paymaster must be configured before execution.",
        },
      ],
      chains: this.policy.allowedChainIds.map((chainId) => ({
        chainId,
        confirmations: this.confirmations(chainId),
        sponsor: {
          available: this.smartAccountExecution.chainIds.includes(chainId),
          reason: this.smartAccountExecution.chainIds.includes(chainId)
            ? "Sponsored UserOperations require exact paymaster approval and gas limits."
            : "No hosted smart-account paymaster is configured for this chain.",
        },
      })),
      authorization: {
        apiSessionGrantsDoNotAuthorizeOnchainSigning: true,
        onchainSessionKeysSupported:
          this.smartAccountExecution.sessionChainIds.length > 0,
        sessionChainIds: [...this.smartAccountExecution.sessionChainIds],
        freshOwnerApprovalRequired: Boolean(this.authorizeDispatch),
        mode: this.authorizeDispatch
          ? "fresh-owner-approval-before-dispatch"
          : "trusted-internal-caller",
      },
      journeys: {
        maximumCalls: 32,
        atomicAcrossChains: false,
        bridgeReceiptProvesDestinationSettlement: false,
      },
      limits: {
        planTtlMs: this.policy.planTtlMs,
        maximumRawBytes: this.policy.maximumRawBytes,
        maximumGas: this.policy.maximumGas.toString(),
        maximumFeePerGas: this.policy.maximumFeePerGas.toString(),
        maximumTransactionCost: this.policy.maximumTransactionCost.toString(),
        costScope:
          "Native value plus gas limit times signed fee cap. Additional chain-specific data or operator fees are not included or capped by this relay.",
      },
    };
  }

  async createPlan(
    actor: RestActor,
    draft: RestPlanDraft,
    idempotencyKey: string,
    requestHash: string,
  ) {
    return this.createBoundPlan(actor, draft, idempotencyKey, requestHash);
  }

  /** Only this independently verified binding path can prepare a contract-wallet plan. */
  async createSmartAccountPlan(
    actor: RestActor,
    bindingId: Hex,
    draft: RestPlanDraft,
    idempotencyKey: string,
    requestHash: string,
    /** A head read moments ago that the operation prepared next proves canonical itself; the
     * draft's evidence at that exact block is not read again here. */
    proven?: RestBlockEvidence,
  ) {
    if (!this.resolveSmartAccount)
      throw new RestError(
        503,
        "SMART_ACCOUNTS_UNAVAILABLE",
        "A verified account binding adapter is required.",
      );
    const ownedDraft = JSON.parse(canonical(draft)) as RestPlanDraft;
    const binding = await this.resolveSmartAccount(actor, bindingId);
    if (
      binding.ownerAccountId !== actor.accountId ||
      binding.id !== bindingId ||
      !same(binding.wallet.address, ownedDraft.account) ||
      ownedDraft.calls.some((call) => call.chainId !== binding.wallet.chainId)
    )
      throw new RestError(
        403,
        "PLAN_ACCOUNT_MISMATCH",
        "Every call must use the exact bound smart wallet and its chain.",
      );
    return this.createBoundPlan(
      actor,
      ownedDraft,
      idempotencyKey,
      requestHash,
      {
        bindingId: binding.id,
        stateHash: binding.state.stateHash,
        chainId: binding.wallet.chainId,
        address: binding.wallet.address,
        manifestRevision: binding.state.manifestRevision,
      },
      proven,
    );
  }

  private async createBoundPlan(
    actor: RestActor,
    draft: RestPlanDraft,
    idempotencyKey: string,
    requestHash: string,
    smartAccount?: StoredPlan["smartAccount"],
    proven?: RestBlockEvidence,
  ) {
    const idem = idempotency(idempotencyKey, requestHash, "create-plan");
    const existing = await this.store.findIdempotentPlan(actor, idem);
    if (existing) return this.view(existing);
    // Own the bytes before any asynchronous evidence lookup. The caller may
    // retain its draft reference, but cannot change the already validated plan.
    draft = JSON.parse(canonical(draft)) as RestPlanDraft;
    this.validateDraft(actor, draft, smartAccount);
    const now = this.now();
    const evidenceTime = Math.min(
      ...draft.evidence.map((e) => Number(e.timestamp) * 1000),
    );
    const expiresAt = Math.min(
      now + this.policy.planTtlMs,
      evidenceTime + this.policy.planTtlMs,
    );
    if (expiresAt <= now)
      throw new RestError(
        409,
        "STALE_PLAN_EVIDENCE",
        "The preparation evidence is stale; prepare a fresh plan.",
      );
    const provenBy = (e: RestBlockEvidence) => proven !== undefined && proven.chainId === e.chainId
      && BigInt(proven.blockNumber) === BigInt(e.blockNumber) && same(proven.blockHash, e.blockHash)
      && BigInt(proven.timestamp) === BigInt(e.timestamp);
    await Promise.all(draft.evidence.filter((e) => !provenBy(e)).map((e) => this.assertEvidence(e)));
    const stored: StoredPlan = {
      id: randomUUID(),
      actor: { ...actor },
      draft,
      commitment: digest({
        actor,
        draft,
        expiresAt,
        ...(smartAccount ? { smartAccount } : {}),
      }),
      createdAt: now,
      expiresAt,
      revision: 0,
      ...(smartAccount ? { smartAccount } : {}),
      steps: draft.calls.map((_, index) => ({ index, state: "waiting" })),
    };
    return this.view(await this.store.create(stored, idem, now));
  }

  /** HTTP handlers call this before repeating upstream preparation work. */
  async findPlanByIdempotency(
    actor: RestActor,
    idempotencyKey: string,
    requestHash: string,
    operation = "create-plan",
  ) {
    const plan = await this.store.findIdempotentPlan(
      actor,
      idempotency(idempotencyKey, requestHash, operation),
    );
    return plan ? this.view(plan) : undefined;
  }

  async getPlan(actor: RestActor, id: string) {
    return this.view(await this.refreshStored(await this.required(actor, id)));
  }
  async listPlans(
    actor: RestActor,
    input: { account?: Address; limit?: number; cursor?: string } = {},
  ) {
    const limit = input.limit ?? 20;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (input.cursor?.length ?? 0) > 256
    )
      throw new RestError(
        400,
        "INVALID_PAGINATION",
        "List 1–100 plans at a time.",
      );
    const page = await this.store.list(actor, { ...input, limit });
    return { ...page, items: page.items.map((plan) => this.view(plan)) };
  }

  async simulateStep(actor: RestActor, id: string, stepIndex: number) {
    const plan = await this.refreshStored(await this.required(actor, id));
    this.requireStep(plan, stepIndex);
    this.assertFresh(plan);
    this.assertDependencies(plan, stepIndex);
    const result = await this.preflight(plan, stepIndex);
    return {
      planId: plan.id,
      commitment: plan.commitment,
      stepIndex,
      ...result,
      limitations: [
        "Simulation observes canonical state at the reported block. State can change before inclusion.",
        "Simulation does not prove bridge settlement or future cross-chain calls.",
      ],
    };
  }

  async submitStep(
    actor: RestActor,
    id: string,
    stepIndex: number,
    rawSignedTransaction: Hex,
    idempotencyKey: string,
    requestHash: string,
  ) {
    const idem = idempotency(
      idempotencyKey,
      requestHash,
      `submit:${id}:${stepIndex}`,
    );
    let plan = await this.required(actor, id);
    this.requireStep(plan, stepIndex);
    const signed = await validateSignedTransaction(
      rawSignedTransaction,
      plan.draft.calls[stepIndex]!,
      plan.draft.account,
      this.policy,
    );
    if (
      plan.steps[stepIndex]?.attempt &&
      !same(plan.steps[stepIndex]!.attempt!.hash, signed.hash)
    ) {
      throw new RestError(
        409,
        "STEP_ALREADY_BOUND",
        "This step already reserves another signed transaction. Reconcile its hash; changing calldata, nonce, or fees requires a new plan.",
      );
    }
    plan = await this.refreshStored(plan);
    if (plan.steps[stepIndex]!.externalExecution)
      throw new RestError(
        409,
        "TRANSPORT_CONFLICT",
        "This step is already bound to an external execution transport. Reconcile that binding; a direct transaction cannot replace it.",
      );
    const known = await this.knownTransaction(signed.chainId, signed.hash);
    const dispatch =
      !known && (plan.steps[stepIndex]!.attempt?.leaseUntil ?? 0) <= this.now();
    if (dispatch) {
      this.assertFresh(plan);
      this.assertDependencies(plan, stepIndex);
      if (
        plan.steps[stepIndex]!.state === "confirmed" ||
        plan.steps[stepIndex]!.state === "reverted"
      )
        throw new RestError(
          409,
          "TRANSACTION_STATE_UNCERTAIN",
          "A previously confirmed hash is unavailable. Reconcile canonical receipt evidence before proceeding.",
        );
      await this.preflight(plan, stepIndex, signed);
    }
    const authorization =
      dispatch && this.authorizeDispatch
        ? await this.authorizeDispatch(plan, stepIndex, signed.hash)
        : undefined;
    const now = this.now();
    if (
      dispatch &&
      this.authorizeDispatch &&
      (!authorization ||
        !Number.isSafeInteger(authorization.issuedAt) ||
        !Number.isSafeInteger(authorization.expiresAt) ||
        authorization.issuedAt > Math.floor(now / 1000) + 30 ||
        authorization.expiresAt <= Math.floor(now / 1000) ||
        authorization.expiresAt <= authorization.issuedAt ||
        authorization.expiresAt - authorization.issuedAt > 300)
    )
      throw new RestError(
        401,
        "AUTH_EXPIRED",
        "A fresh owner approval bound to this exact transaction is required at dispatch.",
      );
    const {
      priorityFeePerGas: _priority,
      gasPrice: _gasPrice,
      accessList: _accessList,
      ...storedSigned
    } = signed;
    const attempt: SignedAttempt = {
      ...storedSigned,
      reservedAt: now,
      leaseToken: randomUUID(),
      leaseUntil: dispatch ? now + this.policy.leaseMs : 0,
      dispatchCount: 0,
    };
    const claim = await this.store.claimSubmission({
      actor,
      planId: id,
      stepIndex,
      expectedRevision: plan.revision,
      attempt,
      idempotency: idem,
      now,
      dispatch,
      ...(authorization ? { authorization } : {}),
    });
    if (!claim.dispatch) {
      return {
        plan: this.view(await this.refreshStored(claim.plan)),
        dispatch: {
          status: known ? "already-observed" : "in-flight",
          hash: signed.hash,
        },
      };
    }
    // Authorization is linearized with the durable claim under the account row
    // lock. No transaction is held over RPC. A revocation stops new claims;
    // this already claimed, bounded in-flight dispatch may finish.
    let state: "submitted" | "unknown" = "submitted";
    let lastError: { code: string; message: string } | undefined;
    try {
      const returned = await this.request(
        signed.chainId,
        "eth_sendRawTransaction",
        [rawSignedTransaction],
      );
      if (typeof returned !== "string" || !same(returned, signed.hash))
        throw new Error("Unexpected relay hash");
    } catch {
      state = "unknown";
      lastError = {
        code: "BROADCAST_UNCERTAIN",
        message:
          "The relay response is unavailable. This hash may already be pending or confirmed; reconcile it before any retry.",
      };
    }
    let settled: StoredPlan;
    try {
      settled = await this.store.settleSubmission(
        actor,
        id,
        stepIndex,
        attempt.leaseToken,
        { state, broadcastAt: this.now(), ...(lastError ? { lastError } : {}) },
      );
    } catch {
      throw new RestError(
        503,
        "BROADCAST_PERSISTENCE_UNCERTAIN",
        "A durable reservation exists and broadcast may have occurred. Retrieve the plan and reconcile this exact hash.",
        { planId: id, stepIndex, transactionHash: signed.hash },
      );
    }
    return {
      plan: this.view(settled),
      dispatch: {
        status: state,
        hash: signed.hash,
        ...(lastError ? { error: lastError } : {}),
      },
    };
  }

  async submitBundle(
    actor: RestActor,
    id: string,
    submissions: readonly { stepIndex: number; rawSignedTransaction: Hex }[],
    idempotencyKey: string,
    requestHash: string,
  ) {
    idempotency(idempotencyKey, requestHash, `bundle:${id}`);
    if (
      !submissions.length ||
      submissions.length > 32 ||
      new Set(submissions.map((s) => s.stepIndex)).size !== submissions.length
    )
      throw new RestError(
        400,
        "INVALID_BUNDLE",
        "Supply 1–32 distinct, ordered step submissions.",
      );
    const results: unknown[] = [];
    for (const [position, submission] of submissions.entries()) {
      const key = createHash("sha256")
        .update(`${idempotencyKey}:${position}`)
        .digest("hex");
      try {
        results.push(
          await this.submitStep(
            actor,
            id,
            submission.stepIndex,
            submission.rawSignedTransaction,
            key,
            requestHash,
          ),
        );
      } catch (error) {
        const safe =
          error instanceof RestError
            ? { code: error.code, message: error.message }
            : {
                code: "RELAY_UNAVAILABLE",
                message:
                  "The operation could not be verified; reconcile existing transaction hashes.",
              };
        return {
          atomic: false,
          complete: false,
          results,
          stoppedAt: position,
          error: safe,
          remainingStepIndices: submissions
            .slice(position)
            .map((item) => item.stepIndex),
          plan: await this.getPlan(actor, id),
        };
      }
    }
    return {
      atomic: false,
      complete: true,
      results,
      plan: await this.getPlan(actor, id),
      note: "All supplied submissions were processed; transaction confirmations and bridge settlement remain separate.",
    };
  }

  async refresh(actor: RestActor, id: string) {
    return this.view(await this.refreshStored(await this.required(actor, id)));
  }
  async recoverPending(input: { limit?: number; cursor?: string } = {}) {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RestError(
        400,
        "INVALID_RECOVERY_LIMIT",
        "Recover 1–100 pending plans at a time.",
      );
    const plans = await this.store.recoverable(
      limit,
      input.cursor ?? this.recoveryCursor,
    );
    const results: unknown[] = [];
    let oldestPendingAt: number | null = null;
    for (const plan of plans) {
      let current = plan;
      try {
        current = await this.refreshStored(plan);
        results.push(this.view(current));
      } catch {
        results.push({ planId: plan.id, status: "reconciliation-unavailable" });
      }
      for (const step of current.steps) {
        if (step.attempt && isRecoverableStep(step)) {
          oldestPendingAt = Math.min(oldestPendingAt ?? Infinity, step.attempt.reservedAt);
        }
      }
    }
    const nextCursor =
      plans.length === limit
        ? encodeCursor(plans[plans.length - 1]!)
        : undefined;
    this.recoveryCursor = nextCursor;
    return {
      reconciled: results,
      broadcastAttempted: false,
      oldestPendingAt,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  private validateDraft(
    actor: RestActor,
    draft: RestPlanDraft,
    smartAccount?: StoredPlan["smartAccount"],
  ) {
    const owner = actor.accountId.split(":");
    if (
      owner.length !== 3 ||
      owner[0] !== "eip155" ||
      !isAddress(owner[2]!) ||
      !same(smartAccount?.address ?? owner[2]!, draft.account)
    )
      throw new RestError(
        403,
        "PLAN_ACCOUNT_MISMATCH",
        "The planned wallet must belong to the authenticated account. Bot API credentials cannot substitute their signer for the owner wallet.",
      );
    if (
      !isAddress(draft.account) ||
      !draft.operation ||
      draft.operation.length > 128 ||
      !Array.isArray(draft.calls) ||
      draft.calls.length < 1 ||
      draft.calls.length > 32
    )
      throw new RestError(
        400,
        "INVALID_PLAN",
        "Provide a named plan with 1–32 calls and its wallet account.",
      );
    if (Buffer.byteLength(canonical(draft)) > 1_048_576)
      throw new RestError(413, "PLAN_TOO_LARGE", "The plan exceeds one MiB.");
    const chains = new Set<number>();
    for (const [index, call] of draft.calls.entries()) {
      if (
        !this.policy.allowedChainIds.includes(call.chainId) ||
        !isAddress(call.to) ||
        !/^0x(?:[a-fA-F0-9]{2})*$/.test(call.data) ||
        (call.data.length - 2) / 2 > this.policy.maximumRawBytes ||
        !/^(0|[1-9][0-9]*)$/.test(call.value) ||
        call.value.length > 78 ||
        BigInt(call.value) >= 1n << 256n ||
        !Array.isArray(call.dependsOn) ||
        new Set(call.dependsOn).size !== call.dependsOn.length ||
        call.dependsOn.some(
          (dep) => !Number.isInteger(dep) || dep < 0 || dep >= index,
        )
      ) {
        throw new RestError(
          400,
          "INVALID_PLAN_CALL",
          "Calls require supported chains, exact byte/value fields, and dependencies on distinct earlier steps.",
        );
      }
      chains.add(call.chainId);
    }
    if (
      !Array.isArray(draft.evidence) ||
      draft.evidence.length !== chains.size ||
      new Set(draft.evidence.map((e) => e.chainId)).size !== chains.size ||
      draft.evidence.some(
        (e) =>
          e.source !== "onchain" ||
          !chains.has(e.chainId) ||
          !hash(e.blockHash) ||
          e.blockNumber.length > 78 ||
          !/^(0|[1-9][0-9]*)$/.test(e.blockNumber) ||
          !/^(0|[1-9][0-9]*)$/.test(e.timestamp) ||
          !Number.isSafeInteger(Number(e.timestamp)) ||
          Number(e.timestamp) * 1000 > this.now() + 30_000,
      )
    ) {
      throw new RestError(
        400,
        "INVALID_PLAN_EVIDENCE",
        "Provide one bounded canonical block observation for every planned chain.",
      );
    }
  }

  private async assertEvidence(evidence: RestBlockEvidence) {
    const block = await this.request(evidence.chainId, "eth_getBlockByNumber", [
      hex(BigInt(evidence.blockNumber)),
      false,
    ]);
    if (
      !object(block) ||
      !hash(block.hash) ||
      !same(block.hash, evidence.blockHash) ||
      quantity(block.number, "block number") !== BigInt(evidence.blockNumber) ||
      quantity(block.timestamp, "block timestamp") !==
        BigInt(evidence.timestamp)
    ) {
      throw new RestError(
        409,
        "PLAN_EVIDENCE_REORGED",
        "The preparation block is no longer the verified canonical block. Prepare a fresh plan.",
      );
    }
  }
  private assertFresh(plan: StoredPlan) {
    if (this.now() >= plan.expiresAt)
      throw new RestError(
        409,
        "PLAN_EXPIRED",
        "This plan expired. Pending hashes remain tracked; new broadcasts need a fresh plan and signatures.",
      );
  }
  private requireStep(plan: StoredPlan, index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= plan.steps.length)
      throw new RestError(
        404,
        "STEP_NOT_FOUND",
        "The planned step does not exist.",
      );
  }
  private async required(actor: RestActor, id: string) {
    const plan = await this.store.get(actor, id);
    if (!plan)
      throw new RestError(
        404,
        "PLAN_NOT_FOUND",
        "The plan was not found for this principal.",
      );
    return plan;
  }
  private satisfied(step: StoredStep) {
    return (
      step.state === "confirmed" &&
      step.receipt?.canonical === true &&
      step.receipt.status === "success" &&
      (step.semantic?.status === "verified" ||
        step.semantic?.status === "unmodeled")
    );
  }
  private assertDependencies(plan: StoredPlan, index: number) {
    const blocked = plan.draft.calls[index]!.dependsOn.filter(
      (dep) => !this.satisfied(plan.steps[dep]!),
    );
    if (blocked.length)
      throw new RestError(
        409,
        "DEPENDENCIES_UNCONFIRMED",
        "Prerequisite transactions need canonical confirmations and any modeled semantic proof before this step can execute.",
        { blockedBy: blocked },
      );
  }
  private confirmations(chainId: number) {
    const count =
      typeof this.policy.confirmations === "number"
        ? this.policy.confirmations
        : this.policy.confirmations[chainId];
    if (!Number.isInteger(count) || count! < 1 || count! > 1024)
      throw new RestError(
        500,
        "INVALID_CONFIRMATION_POLICY",
        "Each enabled chain needs a confirmation count between 1 and 1024.",
      );
    return count!;
  }

  private async preflight(
    plan: StoredPlan,
    index: number,
    signed?: ValidatedSignedTransaction,
  ) {
    const call = plan.draft.calls[index]!;
    await this.assertEvidence(
      plan.draft.evidence.find((e) => e.chainId === call.chainId)!,
    );
    const [chain, block] = await Promise.all([
      this.request(call.chainId, "eth_chainId", []),
      this.request(call.chainId, "eth_getBlockByNumber", ["latest", false]),
    ]);
    if (
      quantity(chain, "chain ID") !== BigInt(call.chainId) ||
      !object(block) ||
      !hash(block.hash)
    )
      throw new RestError(
        502,
        "RPC_CHAIN_MISMATCH",
        "The configured RPC did not prove the planned chain and canonical block.",
      );
    const blockNumber = quantity(block.number, "block number");
    for (const dep of call.dependsOn) {
      const previous = plan.steps[dep]!;
      if (
        plan.draft.calls[dep]!.chainId === call.chainId &&
        previous.receipt &&
        blockNumber < BigInt(previous.receipt.blockNumber)
      )
        throw new RestError(
          503,
          "RPC_BEHIND_PREREQUISITE",
          "The simulation node has not reached the prerequisite receipt block.",
        );
    }
    const transaction: Record<string, unknown> = {
      from: plan.draft.account,
      to: call.to,
      data: call.data,
      value: hex(BigInt(call.value)),
      gas: hex(signed ? BigInt(signed.gas) : this.policy.maximumGas),
    };
    if (signed) {
      const [latestNonce, pendingNonce, balance] = await Promise.all([
        this.request(call.chainId, "eth_getTransactionCount", [
          plan.draft.account,
          "latest",
        ]),
        this.request(call.chainId, "eth_getTransactionCount", [
          plan.draft.account,
          "pending",
        ]),
        this.request(call.chainId, "eth_getBalance", [
          plan.draft.account,
          hex(blockNumber),
        ]),
      ]);
      if (
        quantity(latestNonce, "latest nonce") > BigInt(signed.nonce) ||
        quantity(pendingNonce, "pending nonce") !== BigInt(signed.nonce)
      )
        throw new RestError(
          409,
          "NONCE_NOT_READY",
          "The signed nonce must be the current pending nonce. Replacements and future nonce queues require a new reviewed plan.",
        );
      if (quantity(balance, "balance") < BigInt(signed.maximumCost))
        throw new RestError(
          422,
          "INSUFFICIENT_SIGNED_COST_BALANCE",
          "The account cannot cover the signed native value and execution-gas envelope at the simulation block.",
        );
      if (
        block.baseFeePerGas !== undefined &&
        quantity(block.baseFeePerGas, "base fee") >
          BigInt(signed.maximumFeePerGas)
      )
        throw new RestError(
          422,
          "SIGNED_FEE_BELOW_BASE_FEE",
          "The signed fee cap is below the current base fee.",
        );
      if (signed.type === "eip1559") {
        transaction.maxFeePerGas = hex(BigInt(signed.maximumFeePerGas));
        transaction.maxPriorityFeePerGas = hex(signed.priorityFeePerGas!);
      } else transaction.gasPrice = hex(signed.gasPrice!);
      if (signed.accessList) transaction.accessList = signed.accessList;
    }
    let result: unknown;
    let estimate: unknown;
    try {
      [result, estimate] = await Promise.all([
        this.request(call.chainId, "eth_call", [transaction, hex(blockNumber)]),
        this.request(call.chainId, "eth_estimateGas", [
          transaction,
          hex(blockNumber),
        ]),
      ]);
    } catch {
      throw new RestError(
        422,
        "SIMULATION_UNAVAILABLE",
        "The exact planned call could not be simulated and estimated from the stated account. No transaction was relayed.",
      );
    }
    if (typeof result !== "string" || !/^0x(?:[a-fA-F0-9]{2})*$/.test(result))
      throw new RestError(
        502,
        "INVALID_SIMULATION_RESPONSE",
        "The simulation returned invalid bytes.",
      );
    const estimatedGas = quantity(estimate, "gas estimate");
    if (estimatedGas > (signed ? BigInt(signed.gas) : this.policy.maximumGas))
      throw new RestError(
        422,
        "SIGNED_GAS_TOO_LOW",
        "The exact call exceeds the allowed or signed gas limit.",
      );
    const current = await this.request(call.chainId, "eth_getBlockByNumber", [
      hex(blockNumber),
      false,
    ]);
    if (
      !object(current) ||
      !hash(current.hash) ||
      !same(current.hash, block.hash)
    )
      throw new RestError(
        409,
        "SIMULATION_REORGED",
        "The simulation block changed before relay admission. Retry with canonical state.",
      );
    return {
      simulated: true,
      blockNumber: blockNumber.toString(),
      blockHash: block.hash,
      result,
      estimatedGas: estimatedGas.toString(),
    };
  }

  private async knownTransaction(chainId: number, transactionHash: Hex) {
    const [receipt, transaction] = await Promise.all([
      this.request(chainId, "eth_getTransactionReceipt", [transactionHash]),
      this.request(chainId, "eth_getTransactionByHash", [transactionHash]),
    ]);
    if (
      receipt !== null &&
      (!object(receipt) ||
        typeof receipt.transactionHash !== "string" ||
        !same(receipt.transactionHash, transactionHash))
    )
      throw new RestError(
        502,
        "INVALID_RPC_RESPONSE",
        "RPC returned a receipt for a different hash.",
      );
    if (
      transaction !== null &&
      (!object(transaction) ||
        typeof transaction.hash !== "string" ||
        !same(transaction.hash, transactionHash))
    )
      throw new RestError(
        502,
        "INVALID_RPC_RESPONSE",
        "RPC returned a transaction for a different hash.",
      );
    return receipt !== null || transaction !== null;
  }

  private async refreshStored(
    plan: StoredPlan,
    retries = 2,
  ): Promise<StoredPlan> {
    plan = await this.store.syncExternalExecutions(plan.actor, plan.id);
    if (!plan.steps.some((step) => step.attempt || step.externalExecution))
      return plan;
    const steps: StoredStep[] = [];
    for (let start = 0; start < plan.steps.length; start += 4) {
      steps.push(
        ...(await Promise.all(
          plan.steps
            .slice(start, start + 4)
            .map((step) =>
              step.externalExecution
                ? this.refreshExternalStep(plan, step)
                : this.refreshStep(plan, step),
            ),
        )),
      );
    }
    if (canonical(steps) === canonical(plan.steps)) return plan;
    try {
      const direct = steps.map((step, index) =>
        step.externalExecution ? plan.steps[index]! : step,
      );
      let saved =
        canonical(direct) === canonical(plan.steps)
          ? plan
          : await this.store.save(plan.actor, plan.id, plan.revision, direct);
      const bindings = new Map<string, ExternalStepObservation[]>();
      for (const step of steps) {
        if (
          !step.externalExecution ||
          canonical(step) === canonical(plan.steps[step.index])
        )
          continue;
        const updates = bindings.get(step.externalExecution.bindingId) ?? [];
        updates.push({
          index: step.index,
          state: step.state === "waiting" ? "reserved" : step.state,
          ...(step.externalExecution.transactionHash
            ? { transactionHash: step.externalExecution.transactionHash }
            : {}),
          ...(step.receipt ? { receipt: step.receipt } : {}),
          ...(step.semantic ? { semantic: step.semantic } : {}),
        });
        bindings.set(step.externalExecution.bindingId, updates);
      }
      for (const [bindingId, updates] of bindings)
        saved = await this.store.saveExternalExecution(
          saved.actor,
          saved.id,
          saved.revision,
          bindingId,
          updates,
        );
      return saved;
    } catch (error) {
      if (error instanceof RestError && error.status === 409 && retries > 0)
        return this.refreshStored(
          await this.required(plan.actor, plan.id),
          retries - 1,
        );
      throw error;
    }
  }

  private async refreshStep(
    plan: StoredPlan,
    step: StoredStep,
  ): Promise<StoredStep> {
    const attempt = step.attempt;
    if (!attempt) return step;
    try {
      const observed = await this.observeReceipt(attempt.chainId, attempt.hash);
      if (observed === null) {
        if (step.receipt) {
          const block = await this.request(
            attempt.chainId,
            "eth_getBlockByNumber",
            [hex(BigInt(step.receipt.blockNumber)), false],
          );
          if (
            object(block) &&
            hash(block.hash) &&
            !same(block.hash, step.receipt.blockHash)
          )
            return {
              ...step,
              state: "reorged",
              receipt: {
                ...step.receipt,
                canonical: false,
                confirmations: 0,
                observedAt: this.now(),
              },
              semantic: { status: "unknown" },
            };
          return {
            ...step,
            state: "unknown",
            semantic: {
              status: "unknown",
              details: "The previously observed receipt is unavailable.",
            },
          };
        }
        return step;
      }
      // Semantic verification receives the full bounded log list. Persistence
      // keeps canonical evidence and its deterministic commitment, avoiding a
      // growing receipt-log payload across a 32-transaction journey.
      const compact = this.compactReceipt(observed);
      if (!observed.canonical)
        return {
          ...step,
          state: "reorged",
          receipt: compact,
          semantic: { status: "unknown" },
        };
      if (observed.confirmations < this.confirmations(attempt.chainId))
        return {
          ...step,
          state: "confirming",
          receipt: compact,
          semantic: { status: "unknown" },
        };
      if (observed.status === "reverted")
        return {
          ...step,
          state: "reverted",
          receipt: compact,
          semantic: {
            status: "failed",
            details: "The transaction reverted on the canonical chain.",
          },
        };
      const semantic = await this.verifySemantics(plan, step.index, observed);
      if (Buffer.byteLength(canonical(semantic)) > 8192)
        throw new Error("Semantic evidence exceeds persistence bound");
      return { ...step, state: "confirmed", receipt: compact, semantic };
    } catch {
      return {
        ...step,
        state: "unknown",
        semantic: {
          status: "unknown",
          details:
            "Canonical receipt or semantic evidence could not be verified.",
        },
      };
    }
  }

  private async observeReceipt(
    chainId: number,
    transactionHash: Hex,
  ): Promise<StoredReceipt | null> {
    const [receipt, chain] = await Promise.all([
      this.request(chainId, "eth_getTransactionReceipt", [transactionHash]),
      this.request(chainId, "eth_chainId", []),
    ]);
    if (quantity(chain, "receipt chain ID") !== BigInt(chainId))
      throw new Error("Receipt chain mismatch");
    if (receipt === null) return null;
    if (
      !object(receipt) ||
      !hash(receipt.transactionHash) ||
      !same(receipt.transactionHash, transactionHash) ||
      !hash(receipt.blockHash) ||
      (receipt.status !== "0x1" && receipt.status !== "0x0") ||
      !Array.isArray(receipt.logs) ||
      receipt.logs.length > 2048 ||
      Buffer.byteLength(canonical(receipt.logs)) > 524288
    )
      throw new Error("Invalid receipt");
    const blockNumber = quantity(receipt.blockNumber, "receipt block");
    const [block, head] = await Promise.all([
      this.request(chainId, "eth_getBlockByNumber", [hex(blockNumber), false]),
      this.request(chainId, "eth_blockNumber", []),
    ]);
    if (
      !object(block) ||
      !hash(block.hash) ||
      quantity(block.number, "canonical receipt block") !== blockNumber
    )
      throw new Error("Unavailable canonical block");
    const canonicalReceipt = same(block.hash, receipt.blockHash);
    const headNumber = quantity(head, "head block");
    const count =
      canonicalReceipt && headNumber >= blockNumber
        ? headNumber - blockNumber + 1n
        : 0n;
    return {
      transactionHash,
      blockNumber: blockNumber.toString(),
      blockHash: receipt.blockHash,
      status: receipt.status === "0x1" ? "success" : "reverted",
      canonical: canonicalReceipt,
      confirmations: Number(
        count > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : count,
      ),
      observedAt: this.now(),
      logs: receipt.logs,
    };
  }

  private compactReceipt(receipt: StoredReceipt): StoredReceipt {
    return {
      ...receipt,
      logs: [],
      logsStored: false,
      logCount: receipt.logs.length,
      logsHash: keccak256(stringToHex(canonical(receipt.logs))),
    };
  }

  private async refreshExternalStep(
    plan: StoredPlan,
    step: StoredStep,
  ): Promise<StoredStep> {
    const external = step.externalExecution!;
    const unknown = (details: string): StoredStep => ({
      ...step,
      state: "unknown",
      semantic: { status: "unknown", details },
    });
    const observer = this.externalObservers.find(
      (candidate) => candidate.kind === external.transport,
    );
    if (!observer)
      return unknown("The bound external execution verifier is unavailable.");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new Error("External verification deadline"));
          },
          Math.min(30_000, this.policy.rpcTimeoutMs * 3),
        );
      });
      const observation = await Promise.race([
        observer.observePlanStep(plan, step.index, external.bindingId, {
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (
        observation.stepIndex !== step.index ||
        observation.chainId !== external.chainId ||
        external.chainId !== plan.draft.calls[step.index]!.chainId ||
        (observation.hash !== undefined && !hash(observation.hash))
      )
        throw new Error("External observation binding mismatch");
      // An expired verdict comes from the chain; a bundler hint stored earlier no longer means anything.
      const transactionHash = observation.state === "expired" ? undefined : (observation.hash ?? external.transactionHash);
      if (
        transactionHash &&
        external.transactionHash &&
        !same(transactionHash, external.transactionHash) &&
        step.state === "confirmed" &&
        step.receipt?.canonical
      ) {
        const prior = await this.observeReceipt(
          external.chainId,
          external.transactionHash,
        );
        if (
          prior?.canonical &&
          prior.status === "success" &&
          same(prior.blockHash, step.receipt.blockHash)
        ) {
          // The previously verified inner execution still occupies the exact
          // canonical block. A later provider retry must not replace its result.
          const semantic =
            external.transport === "erc4337"
              ? (step.semantic ?? { status: "unknown" as const })
              : this.verifier
                ? await this.verifySemantics(plan, step.index, prior)
                : (step.semantic ?? { status: "unknown" as const });
          if (Buffer.byteLength(canonical(semantic)) > 8192)
            throw new Error(
              "External semantic evidence exceeds persistence bound",
            );
          return {
            ...step,
            state:
              prior.confirmations < this.confirmations(external.chainId)
                ? "confirming"
                : "confirmed",
            receipt: this.compactReceipt(prior),
            semantic,
          };
        }
      }
      const base: StoredStep = {
        ...step,
        externalExecution: {
          ...external,
          ...(transactionHash ? { transactionHash } : {}),
        },
      };
      if (
        base.receipt &&
        (!transactionHash ||
          !same(base.receipt.transactionHash, transactionHash))
      )
        delete base.receipt;
      if (!transactionHash) {
        delete base.receipt;
        // Expired: the chain proved nothing executed; the step is settled as failed, not retried.
        if (observation.state === "expired") {
          const { transactionHash: _hint, ...never } = base.externalExecution!;
          return {
            ...base,
            externalExecution: never,
            state: "reverted",
            semantic: { status: "failed", details: "The operation expired before inclusion; nothing executed." },
          };
        }
        return {
          ...base,
          state: observation.state === "pending" ? "reserved" : "unknown",
          semantic: { status: "unknown" },
        };
      }
      const receipt = await this.observeReceipt(
        external.chainId,
        transactionHash,
      );
      if (!receipt) {
        if (base.receipt) {
          const block = await this.request(
            external.chainId,
            "eth_getBlockByNumber",
            [hex(BigInt(base.receipt.blockNumber)), false],
          );
          if (
            object(block) &&
            hash(block.hash) &&
            !same(block.hash, base.receipt.blockHash)
          )
            return {
              ...base,
              state: "reorged",
              receipt: {
                ...base.receipt,
                canonical: false,
                confirmations: 0,
                observedAt: this.now(),
              },
              semantic: { status: "unknown" },
            };
        }
        return {
          ...base,
          state:
            base.receipt || observation.state !== "pending"
              ? "unknown"
              : "submitted",
          semantic: { status: "unknown" },
        };
      }
      const compact = this.compactReceipt(receipt);
      if (!receipt.canonical)
        return {
          ...base,
          state: "reorged",
          receipt: compact,
          semantic: { status: "unknown" },
        };
      if (receipt.confirmations < this.confirmations(external.chainId))
        return {
          ...base,
          state: "confirming",
          receipt: compact,
          semantic: { status: "unknown" },
        };
      if (receipt.status === "reverted")
        return {
          ...base,
          state: "reverted",
          receipt: compact,
          semantic: {
            status: "failed",
            details:
              "The external transaction reverted on the canonical chain.",
          },
        };
      const proof = observation.receipt;
      const matchesProof =
        proof &&
        proof.canonical &&
        proof.status === "success" &&
        same(proof.transactionHash, transactionHash) &&
        same(proof.blockHash, receipt.blockHash) &&
        proof.blockNumber === receipt.blockNumber;
      if (
        !matchesProof ||
        (observation.state !== "confirmed" && observation.state !== "reverted")
      )
        return {
          ...base,
          state: "unknown",
          receipt: compact,
          semantic: {
            status: "unknown",
            details:
              "The outer transaction succeeded, but the exact bound inner execution has not been verified.",
          },
        };
      if (observation.state === "reverted")
        return {
          ...base,
          state: "reverted",
          receipt: compact,
          semantic: {
            status: "failed",
            details: "The bound forwarded inner execution failed.",
          },
        };
      const semantic =
        external.transport === "erc4337"
          ? (observation.semantic ?? {
              status: "unknown" as const,
              details: "Operation-scoped semantic evidence is required.",
            })
          : observation.semantic?.status === "failed" ||
              observation.semantic?.status === "unknown"
            ? observation.semantic
            : this.verifier
              ? await this.verifySemantics(plan, step.index, receipt)
              : (observation.semantic ?? { status: "unmodeled" as const });
      if (Buffer.byteLength(canonical(semantic)) > 8192)
        throw new Error("External semantic evidence exceeds persistence bound");
      return { ...base, state: "confirmed", receipt: compact, semantic };
    } catch {
      return unknown(
        "Canonical receipt or bound inner execution could not be verified.",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private view(plan: StoredPlan) {
    const steps = plan.steps.map((step) => ({
      index: step.index,
      state: step.state,
      ...(step.externalExecution
        ? {
            execution: {
              transport:
                step.externalExecution.transport === "erc4337"
                  ? "eip4337-user-operation"
                  : "relayr-prepaid-erc2771",
              bindingId: step.externalExecution.bindingId,
              chainId: step.externalExecution.chainId,
              ...(step.externalExecution.transactionHash
                ? { hash: step.externalExecution.transactionHash }
                : {}),
            },
          }
        : {}),
      ...(step.attempt
        ? {
            transaction: {
              hash: step.attempt.hash,
              sender: step.attempt.sender,
              chainId: step.attempt.chainId,
              nonce: step.attempt.nonce,
              type: step.attempt.type,
              gas: step.attempt.gas,
              maximumFeePerGas: step.attempt.maximumFeePerGas,
              maximumCost: step.attempt.maximumCost,
              costScope:
                "Native value plus gas limit times signed fee cap; excludes additional chain-specific data or operator fees.",
              dispatchCount: step.attempt.dispatchCount,
              reservedAt: step.attempt.reservedAt,
              ...(step.attempt.broadcastAt
                ? { broadcastAt: step.attempt.broadcastAt }
                : {}),
              ...(step.attempt.lastError
                ? { lastError: step.attempt.lastError }
                : {}),
            },
          }
        : {}),
      ...(step.receipt ? { receipt: step.receipt } : {}),
      ...(step.semantic ? { semantic: step.semantic } : {}),
      blockedBy: plan.draft.calls[step.index]!.dependsOn.filter(
        (dep) => !this.satisfied(plan.steps[dep]!),
      ),
    }));
    const confirmed = plan.steps.filter((step) => this.satisfied(step)).length;
    const anyAttempt = plan.steps.some(
      (step) => step.attempt || step.externalExecution,
    );
    const status =
      confirmed === steps.length
        ? "transactions_confirmed"
        : plan.steps.some(
              (step) =>
                step.state === "reverted" || step.semantic?.status === "failed",
            )
          ? "blocked"
          : plan.steps.some((step) => step.state === "reorged")
            ? "reorged"
            : confirmed > 0
              ? "partial"
              : anyAttempt
                ? "pending"
                : this.now() >= plan.expiresAt
                  ? "expired"
                  : "prepared";
    return {
      id: plan.id,
      account: plan.draft.account,
      operation: plan.draft.operation,
      draft: plan.draft,
      commitment: plan.commitment,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      revision: plan.revision,
      ...(plan.smartAccount ? { smartAccount: plan.smartAccount } : {}),
      status,
      steps,
      confirmationScope:
        "Only these exact planned calls and verified transport executions; cross-chain bridge settlement and unmodeled effects are not established.",
    };
  }

  private async verifySemantics(
    plan: StoredPlan,
    index: number,
    receipt: StoredReceipt,
  ) {
    if (!this.verifier) return { status: "unmodeled" as const };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Semantic verification deadline")),
        Math.min(30_000, this.policy.rpcTimeoutMs * 3),
      );
    });
    try {
      return await Promise.race([
        this.verifier.verify(plan, index, receipt, {
          request: (chain, method, params) =>
            this.request(chain, method, params),
        }),
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async request(
    chainId: number,
    method: string,
    params: readonly unknown[],
  ) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new RestError(
            504,
            "RPC_TIMEOUT",
            "The configured chain RPC did not answer within the relay deadline.",
          ),
        );
      }, this.policy.rpcTimeoutMs);
    });
    try {
      return await Promise.race([
        this.rpc.request(chainId, method, params, controller.signal),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
