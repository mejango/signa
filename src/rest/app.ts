import { createHash, randomUUID } from "node:crypto";
import { canonical as canonicalValue } from "./sponsorship/validation.js";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Address, Hex } from "viem";
import type { ProtocolOperations } from "../signaProtocol.js";
import type { Store } from "../store.js";
import {
  createRestAuthRouter,
  readSignedRequest,
  REST_AUTH_HEADERS,
  type BotScope,
  type RestAuth,
  type RestPrincipal,
  type SignedRequestInput,
} from "./auth/index.js";
import type { ContractCatalog } from "./contracts/catalog.js";
import { RestError, type RestActor, type RestBlockEvidence, type RestPlanDraft } from "./core.js";
import {
  restRequest,
  setOwnerApproval,
  setSponsorshipOwnerApproval,
  setRestAuthority,
  timedAuthPhase,
  withRestRequest,
} from "./context.js";
import type { TransactionService } from "./transactions/service.js";
import type { RelayrSponsorshipService } from "./sponsorship/index.js";
import type { SessionService } from "./sessions/service.js";
import type {
  UserOperationService,
  UserOperationPreparationInput,
} from "./userOperations/service.js";
import type { PostgresWalletPaymentReviewStore } from './wallet/paymentReviewsPostgres.js';
import { publicWalletPaymentReview, publicWalletPaymentAppReview } from './wallet/paymentPublic.js';
import type {
  createSmartAccountService,
  createSessionPolicyReviewer,
  BindingChallengeInput,
  SessionPolicyInput,
} from "./smartAccounts/index.js";
import {
  integer,
  jsonBody,
  object,
  problem,
  query,
  required,
  requestHash,
  requestTarget,
  response,
  REST_LIMITS,
  REST_PREFIX,
  validateTarget,
} from "./http.js";

export interface RestDependencies {
  auth: RestAuth;
  quota: Pick<Store, "consumeRequest">;
  contracts: ContractCatalog;
  operations: ProtocolOperations;
  transactions: TransactionService;
  sponsorship?: RelayrSponsorshipService;
  smartAccounts?: ReturnType<typeof createSmartAccountService>;
  sessionReviewer?: ReturnType<typeof createSessionPolicyReviewer>;
  sessions?: SessionService;
  userOperations?: UserOperationService;
  walletPayments?: Pick<PostgresWalletPaymentReviewStore, 'prepare' | 'getForApp'>;
  openapi?: unknown;
  maxConcurrentRequests?: number;
}

type RestEnv = {
  Variables: { requestId: string; restSignal: AbortSignal };
  Bindings: { incoming?: { url?: string } };
};
const actor = (principal: RestPrincipal): RestActor => ({
  accountId: principal.account.id,
  principalId: principal.principalId,
});
export function operationDescriptors(operations: ProtocolOperations) {
  return operations
    .list()
    .filter((operation) => operation.transaction && !operation.effects.externalMutation)
    .map((operation) => ({
      id: operation.id,
      description: operation.description,
      kind: operation.kind,
      sources: operation.sources.map((source) =>
        source === "indexer" ? "bendystraw" : source,
      ),
      transaction: operation.transaction,
      effects: operation.effects,
      inputJsonSchema: operation.inputJsonSchema,
      method: "POST",
      path: `${REST_PREFIX}/operations/${operation.id}/plans`,
    }));
}

/** An admission slower than this logs which phase waited. */
const SLOW_AUTH_MS = 300;

/** Mount at /api/v1. Owner and grant requests are signed; bounded public setup
 * inspection cannot mutate authority and finalization has its own exact proof. */

export function createRestApp(deps: RestDependencies): Hono<RestEnv> {
  const app = new Hono<RestEnv>();
  const descriptors = operationDescriptors(deps.operations);
  const byId = new Map(descriptors.map((entry) => [entry.id, entry]));
  let active = 0;
  const maximum =
    deps.maxConcurrentRequests ?? REST_LIMITS.maxConcurrentRequests;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error("Invalid REST concurrency limit");

  app.onError(problem);
  app.use(
    "*",
    cors({
      origin: "*",
      credentials: false,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [...Object.values(REST_AUTH_HEADERS), "Content-Type"],
      exposeHeaders: [
        "X-Request-Id",
        "Retry-After",
        "RateLimit-Limit",
        "RateLimit-Remaining",
        "Location",
      ],
      maxAge: 600,
    }),
  );
  app.use("*", async (context, next) => {
    const id = randomUUID();
    context.set("requestId", id);
    context.header("X-Request-Id", id);
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    validateTarget(requestTarget(context));
    if (
      ["GET", "HEAD"].includes(context.req.method) &&
      (context.req.header("transfer-encoding") ||
        Number(context.req.header("content-length") ?? 0) !== 0)
    ) {
      throw new RestError(
        400,
        "GET_BODY_UNSUPPORTED",
        "GET reads must put their input in the query string",
      );
    }
    if (active >= maximum)
      throw new RestError(
        429,
        "SERVICE_BUSY",
        "The service has reached its concurrent request limit",
      );
    active++;
    try {
      const quota = await deps.quota.consumeRequest(
        "rest:site",
        REST_LIMITS.siteRequestsPerMinute,
        60,
      );
      if (!quota.allowed)
        throw new RestError(
          429,
          "RATE_LIMITED",
          "The REST service request budget is spent; retry later",
        );
      const signal = AbortSignal.any([
        context.req.raw.signal,
        AbortSignal.timeout(REST_LIMITS.timeoutMs),
      ]);
      context.set("restSignal", signal);
      await withRestRequest(signal, next);
      signal.throwIfAborted();
    } finally {
      active--;
    }
  });

  const accountBudget = async (
    principal: RestPrincipal,
    context: Context,
  ): Promise<void> => {
    // Grant renewal must not reset an app's budget or spend owner/bot capacity.
    const bucket = principal.kind === "wallet-app"
      ? `app:${principal.walletApp.origin}`
      : principal.isOwner ? "owner" : "bots";
    const budget = await deps.quota.consumeRequest(
      `rest:account:${principal.account.id}:${bucket}`,
      REST_LIMITS.requestsPerMinute,
      60,
    );
    context.header("RateLimit-Limit", String(REST_LIMITS.requestsPerMinute));
    context.header("RateLimit-Remaining", String(budget.remaining));
    if (!budget.allowed)
      throw new RestError(
        429,
        "RATE_LIMITED",
        "The account request budget is spent; retry later",
      );
  };
  const authenticate = async (
    context: Context,
    scopes: BotScope[],
  ): Promise<{ input: SignedRequestInput; principal: RestPrincipal }> => {
    const input = await readSignedRequest(
      context.req.raw,
      requestTarget(context),
      REST_LIMITS.bodyBytes,
    );
    if (
      (input.method === "GET" || input.method === "HEAD") &&
      input.body.length
    )
      throw new RestError(
        400,
        "GET_BODY_UNSUPPORTED",
        "GET reads must put their input in the query string",
      );
    const started = performance.now();
    const principal = await deps.auth.authenticate(input, scopes);
    await timedAuthPhase("quotaMs", () => accountBudget(principal, context));
    const authMs = Math.round(performance.now() - started);
    context.set("authMs", authMs);
    // A slow admission names the phase that waited (grant, context, admit, refresh, finish,
    // quota; the remainder is signature verification). Durations only, never request data.
    if (authMs > SLOW_AUTH_MS)
      console.info(JSON.stringify({ ...restRequest()?.authPhases, service: "rest", action: "slow_auth", authMs }));
    setRestAuthority(principal, input);
    return { input, principal };
  };
  const idempotency = (principal: RestPrincipal): string => {
    if (!principal.idempotencyKey)
      throw new RestError(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Transaction requests require a signed Idempotency-Key header",
      );
    return principal.idempotencyKey;
  };
  const draftFor = async (
    id: string,
    input: unknown,
    signal: AbortSignal,
    /** A head read moments ago: the draft's reads are pinned there instead of reading one. */
    at?: RestBlockEvidence,
  ): Promise<RestPlanDraft> => {
    if (id !== "contract_calls" && id !== "protocol-contract-calls" && !byId.get(id)?.transaction)
      throw new RestError(
        404,
        "TRANSACTION_OPERATION_NOT_FOUND",
        "Choose a transaction operation from the API reference",
      );
    const draft = await deps.operations.prepare(id, input, {
      signal,
      ...(at ? { at } : {}),
    });
    return draft;
  };

  app.get("/", (context) => {
    query(context, []);
    return response(context, {
      version: "1",
      protocolVersion: 6,
      documentation: "/api",
      openapi: `${REST_PREFIX}/openapi.json`,
      accounts: "/accounts",
      capabilities: `${REST_PREFIX}/capabilities`,
      protocolReference: "https://juicebox.center/api",
    });
  });
  app.get("/openapi.json", (context) => {
    query(context, []);
    if (!deps.openapi)
      throw new RestError(
        503,
        "SPECIFICATION_UNAVAILABLE",
        "The API specification is unavailable",
      );
    return response(context, deps.openapi);
  });
  app.get("/capabilities", async (context) => {
    query(context, []);
    return response(context, {
      version: "1",
      protocolVersion: 6,
      audience: deps.auth.audience,
      authentication: {
        scheme: "eip712-request-signature",
        enrollment: `${REST_PREFIX}/accounts/enroll`,
        scopeProfiles: [["read"], ["read", "plan"], ["read", "plan", "relay"]],
        staticCredentials: false,
        planOwnership: "account-and-grant",
      },
      chains: deps.contracts.data.chains,
      limits: REST_LIMITS,
      transactions: deps.transactions.capabilities(),
      sponsorship: deps.sponsorship?.capabilities() ?? { state: "unavailable" },
      userOperations: deps.userOperations?.capabilities() ?? {
        state: "unavailable",
      },
      sessions: deps.sessions?.capabilities() ?? { state: "unavailable" },
      smartAccounts: deps.smartAccounts
        ? await deps.smartAccounts.capabilities()
        : { state: "unavailable" },
      protocolReference: "https://juicebox.center/api",
    });
  });
  app.route(
    "/",
    createRestAuthRouter(deps.auth, {
      requestTarget,
      onError: problem,
      onAuthenticated: accountBudget,
    }),
  );

  app.post("/operations/:id/plans", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["plan"]);
    const key = idempotency(principal);
    const existing = await deps.transactions.findPlanByIdempotency(
      actor(principal),
      key,
      requestHash(input),
    );
    if (existing) return response(context, existing, 201);
    const draft = await draftFor(
      context.req.param("id"),
      jsonBody(input),
      context.get("restSignal"),
    );
    return response(
      context,
      await deps.transactions.createPlan(
        actor(principal),
        draft,
        key,
        requestHash(input),
      ),
      201,
    );
  });
  app.post("/plans", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["plan"]);
    const key = idempotency(principal);
    const existing = await deps.transactions.findPlanByIdempotency(
      actor(principal),
      key,
      requestHash(input),
    );
    if (existing) return response(context, existing, 201);
    const body = object(jsonBody(input), ["operation", "input"]);
    if (typeof body.operation !== "string")
      throw new RestError(
        400,
        "OPERATION_REQUIRED",
        "Choose a transaction operation or contract_calls",
      );
    const draft = await draftFor(body.operation, body.input, context.get("restSignal"));
    return response(
      context,
      await deps.transactions.createPlan(
        actor(principal),
        draft,
        key,
        requestHash(input),
      ),
      201,
    );
  });
  app.get("/plans", async (context) => {
    const params = query(context, ["account", "limit", "cursor"]);
    const { principal } = await authenticate(context, ["read"]);
    const account = params.get("account");
    if (account && !/^0x[0-9a-fA-F]{40}$/.test(account))
      throw new RestError(
        400,
        "INVALID_ACCOUNT",
        "The transaction account must be an address",
      );
    return response(
      context,
      await deps.transactions.listPlans(actor(principal), {
        ...(account ? { account: account as Address } : {}),
        limit: integer(params.get("limit") ?? "20", "limit", 100),
        ...(params.has("cursor") ? { cursor: required(params, "cursor") } : {}),
      }),
    );
  });
  app.get("/plans/:id", async (context) => {
    const params = query(context, ["refresh"]);
    if (
      params.has("refresh") &&
      !["true", "false"].includes(params.get("refresh")!)
    )
      throw new RestError(
        400,
        "INVALID_BOOLEAN",
        "refresh must be true or false",
      );
    const { principal } = await authenticate(context, ["read"]);
    return response(
      context,
      params.get("refresh") === "true"
        ? await deps.transactions.refresh(
            actor(principal),
            context.req.param("id"),
          )
        : await deps.transactions.getPlan(
            actor(principal),
            context.req.param("id"),
          ),
    );
  });
  app.get("/plans/:id/steps/:step/simulation", async (context) => {
    query(context, []);
    const { principal } = await authenticate(context, ["read"]);
    return response(
      context,
      await deps.transactions.simulateStep(
        actor(principal),
        context.req.param("id"),
        integer(context.req.param("step"), "step", 31),
      ),
    );
  });
  app.post("/plans/:id/steps/:step/submissions", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["relay"]);
    const key = idempotency(principal);
    const body = object(jsonBody(input), [
      "rawSignedTransaction",
      "ownerApproval",
    ]);
    if (typeof body.rawSignedTransaction !== "string")
      throw new RestError(
        400,
        "SIGNED_TRANSACTION_REQUIRED",
        "Supply serialized wallet-signed transaction bytes",
      );
    const step = integer(context.req.param("step"), "step", 31);
    if (body.ownerApproval !== undefined)
      setOwnerApproval(step, body.ownerApproval);
    return response(
      context,
      await deps.transactions.submitStep(
        actor(principal),
        context.req.param("id"),
        step,
        body.rawSignedTransaction as Hex,
        key,
        requestHash(input),
      ),
      202,
    );
  });
  app.post("/plans/:id/submissions", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["relay"]);
    const key = idempotency(principal);
    const body = object(jsonBody(input), ["submissions"]);
    if (
      !Array.isArray(body.submissions) ||
      !body.submissions.length ||
      body.submissions.length > 32
    )
      throw new RestError(
        400,
        "INVALID_SUBMISSIONS",
        "Supply between 1 and 32 signed submissions",
      );
    const submissions = body.submissions.map((entry) => {
      const value = object(entry, [
        "stepIndex",
        "rawSignedTransaction",
        "ownerApproval",
      ]);
      if (
        !Number.isSafeInteger(value.stepIndex) ||
        Number(value.stepIndex) < 0 ||
        Number(value.stepIndex) > 31 ||
        typeof value.rawSignedTransaction !== "string"
      )
        throw new RestError(
          400,
          "INVALID_SUBMISSION",
          "Each submission requires a step index and serialized signed transaction",
        );
      if (value.ownerApproval !== undefined)
        setOwnerApproval(Number(value.stepIndex), value.ownerApproval);
      return {
        stepIndex: Number(value.stepIndex),
        rawSignedTransaction: value.rawSignedTransaction as Hex,
      };
    });
    return response(
      context,
      await deps.transactions.submitBundle(
        actor(principal),
        context.req.param("id"),
        submissions,
        key,
        requestHash(input),
      ),
      202,
    );
  });
  const sponsorship = () => {
    if (!deps.sponsorship)
      throw new RestError(
        503,
        "SPONSORSHIP_UNAVAILABLE",
        "The sponsorship adapter is not configured",
      );
    return deps.sponsorship;
  };
  app.post("/sponsorships", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["plan"]);
    const key = idempotency(principal);
    const body = object(jsonBody(input), ["planId", "stepIndexes"]);
    if (typeof body.planId !== "string")
      throw new RestError(
        400,
        "PLAN_ID_REQUIRED",
        "Choose an existing transaction plan",
      );
    return response(
      context,
      await sponsorship().prepare(
        actor(principal),
        body.planId,
        {
          ...(body.stepIndexes !== undefined
            ? { stepIndexes: body.stepIndexes as number[] }
            : {}),
        },
        key,
        { signal: context.get("restSignal") },
      ),
      201,
    );
  });
  app.get("/sponsorships/:id", async (context) => {
    const params = query(context, ["refresh"]);
    if (
      params.has("refresh") &&
      !["true", "false"].includes(params.get("refresh")!)
    )
      throw new RestError(
        400,
        "INVALID_BOOLEAN",
        "refresh must be true or false",
      );
    const { principal } = await authenticate(context, ["read"]);
    const service = sponsorship();
    return response(
      context,
      params.get("refresh") === "true"
        ? await service.refresh(actor(principal), context.req.param("id"), {
            signal: context.get("restSignal"),
          })
        : await service.get(actor(principal), context.req.param("id")),
    );
  });
  app.post("/sponsorships/:id/submissions", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["relay"]);
    const key = idempotency(principal);
    const body = object(jsonBody(input), ["signatures", "ownerApproval"]);
    if (body.ownerApproval !== undefined)
      setSponsorshipOwnerApproval(body.ownerApproval);
    return response(
      context,
      await sponsorship().submit(
        actor(principal),
        context.req.param("id"),
        {
          signatures: body.signatures as Hex[],
        },
        key,
        { signal: context.get("restSignal") },
      ),
      202,
    );
  });
  app.post("/sponsorships/:id/funding-plans", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["plan"]);
    const key = idempotency(principal);
    const hash = requestHash(input);
    const existing = await deps.transactions.findPlanByIdempotency(
      actor(principal),
      key,
      hash,
    );
    if (existing) return response(context, existing, 201);
    const body = object(jsonBody(input), ["chainId", "payer"]);
    if (!Number.isSafeInteger(body.chainId) || typeof body.payer !== "string")
      throw new RestError(
        400,
        "INVALID_FUNDING_INPUT",
        "Provide a payment chain and the connected owner wallet as payer",
      );
    if (
      body.payer.toLowerCase() !== principal.account.ownerAddress.toLowerCase()
    )
      throw new RestError(
        403,
        "FUNDING_PAYER_MISMATCH",
        "The funding plan payer must be the authenticated account owner",
      );
    const draft = await sponsorship().prepareFunding(
      actor(principal),
      context.req.param("id"),
      {
        chainId: Number(body.chainId),
        payer: body.payer as Address,
      },
      { signal: context.get("restSignal") },
    );
    return response(
      context,
      await deps.transactions.createPlan(actor(principal), draft, key, hash),
      201,
    );
  });
  const smartAccounts = () => {
    if (!deps.smartAccounts)
      throw new RestError(
        503,
        "SMART_ACCOUNTS_UNAVAILABLE",
        "The smart account adapter is not configured",
      );
    return deps.smartAccounts;
  };
  app.get("/smart-accounts/capabilities", async (context) => {
    query(context, []);
    return response(context, await smartAccounts().capabilities());
  });
  app.post("/smart-accounts/binding-challenges", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, []);
    return response(
      context,
      await smartAccounts().challenge(
        principal,
        jsonBody(input) as unknown as BindingChallengeInput,
        context.get("restSignal"),
      ),
    );
  });
  app.post("/smart-accounts/onboarding-challenges", async (context) => {
    query(context, []);
    const input = await readSignedRequest(context.req.raw, requestTarget(context), REST_LIMITS.bodyBytes);
    return response(context, await smartAccounts().onboardingChallenge(jsonBody(input), context.get("restSignal")));
  });
  app.post("/smart-accounts/onboarding", async (context) => {
    query(context, []);
    const input = await readSignedRequest(context.req.raw, requestTarget(context), REST_LIMITS.bodyBytes);
    return response(context, await smartAccounts().finalizeOnboarding(jsonBody(input), context.get("restSignal")), 201);
  });
  app.post("/smart-accounts/bindings", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, []);
    return response(
      context,
      await smartAccounts().bind(
        principal,
        jsonBody(input) as unknown as BindingChallengeInput & {
          stateHash: Hex;
          signature: Hex;
        },
        context.get("restSignal"),
      ),
      201,
    );
  });
  app.get("/smart-accounts/bindings", async (context) => {
    query(context, []);
    const { principal } = await authenticate(context, ["read"]);
    return response(context, await smartAccounts().list(principal));
  });
  app.get("/smart-accounts/bindings/:id", async (context) => {
    query(context, []);
    const { principal } = await authenticate(context, ["read"]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(context.req.param("id")))
      throw new RestError(
        400,
        "INVALID_BINDING_ID",
        "Use the exact smart account binding identifier",
      );
    return response(
      context,
      await smartAccounts().current(
        principal.account.id,
        context.req.param("id") as Hex,
        context.get("restSignal"),
      ),
    );
  });
  app.delete("/smart-accounts/bindings/:id", async (context) => {
    query(context, []);
    const { principal } = await authenticate(context, []);
    return response(
      context,
      await smartAccounts().revoke(principal, context.req.param("id") as Hex),
    );
  });
  app.post("/smart-accounts/session-reviews", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["plan"]);
    if (principal.kind === "wallet-app")
      throw new RestError(403, "SESSION_APP_UNAVAILABLE", "Apps require fresh wallet owner approval for each operation");
    if (!deps.sessionReviewer)
      throw new RestError(
        503,
        "SESSION_REVIEW_UNAVAILABLE",
        "The session policy reviewer is not configured",
      );
    return response(
      context,
      await deps.sessionReviewer.review(
        principal,
        jsonBody(input) as unknown as SessionPolicyInput,
        context.get("restSignal"),
      ),
    );
  });
  app.post("/smart-accounts/creation-plans", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["plan"]);
    idempotency(principal);
    const creation = await smartAccounts().prepareCreation(
      principal,
      jsonBody(input) as unknown as Parameters<
        ReturnType<typeof createSmartAccountService>["prepareCreation"]
      >[1],
      context.get("restSignal"),
    );
    return response(context, { creation }, 201);
  });
  /** A smart-account plan from an operation or contract calls, idempotent on its key and request hash. */
  const smartAccountPlan = async (
    principal: RestPrincipal,
    bindingId: Hex,
    body: Record<string, unknown>,
    key: string,
    hash: string,
    signal: AbortSignal,
    /** A head being read ahead; a draft waits for it (a moment) rather than reading its own. */
    head?: Promise<RestBlockEvidence>,
  ) => {
    const started = Date.now();
    const existing = await deps.transactions.findPlanByIdempotency(actor(principal), key, hash);
    const looked = Date.now();
    if (existing) return existing;
    if (typeof body.operation !== "string")
      throw new RestError(
        400,
        "OPERATION_REQUIRED",
        "Choose a transaction operation or contract_calls.",
      );
    // A head that fails to read leaves the draft to read its own.
    const at = head ? await head.catch(() => undefined) : undefined;
    const draft = await draftFor(body.operation, body.input, signal, at);
    const drafted = Date.now();
    const plan = await deps.transactions.createSmartAccountPlan(actor(principal), bindingId, draft, key, hash, at);
    // Where a plan's time goes, for the production log; the request line only has the total.
    console.info(JSON.stringify({ service: "smart-accounts", action: "plan_stages", operation: body.operation,
      lookupMs: looked - started, draftMs: drafted - looked, accountMs: Date.now() - drafted }));
    return plan;
  };
  app.post("/smart-accounts/bindings/:id/plans", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["plan"]);
    const body = object(jsonBody(input), ["operation", "input"]);
    return response(
      context,
      await smartAccountPlan(principal, context.req.param("id") as Hex, body, idempotency(principal), requestHash(input), context.get("restSignal")),
      201,
    );
  });
  const sessions = () => {
    if (!deps.sessions)
      throw new RestError(
        503,
        "SESSIONS_UNAVAILABLE",
        "The reviewed onchain session execution stack is not configured.",
      );
    return deps.sessions;
  };
  app.post("/smart-accounts/sessions", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["plan"]);
    return response(
      context,
      await sessions().prepare(
        principal,
        jsonBody(input) as unknown as SessionPolicyInput,
        idempotency(principal),
        requestHash(input),
        context.get("restSignal"),
      ),
      201,
    );
  });
  app.get("/smart-accounts/sessions", async (context) => {
    const params = query(context, ["limit", "cursor"]);
    const { principal } = await authenticate(context, ["read"]);
    return response(
      context,
      await sessions().list(principal, {
        limit: integer(params.get("limit") ?? "25", "limit", 100),
        ...(params.has("cursor") ? { cursor: required(params, "cursor") } : {}),
      }),
    );
  });
  app.get("/smart-accounts/sessions/:id", async (context) => {
    const params = query(context, ["refresh"]);
    if (
      params.has("refresh") &&
      !["true", "false"].includes(params.get("refresh")!)
    )
      throw new RestError(
        400,
        "INVALID_REFRESH",
        "Choose refresh=true or refresh=false.",
      );
    const { principal } = await authenticate(context, ["read"]);
    return response(
      context,
      await sessions().get(
        principal,
        context.req.param("id"),
        params.get("refresh") !== "false",
        context.get("restSignal"),
      ),
    );
  });
  app.get("/smart-accounts/sessions/:id/quota", async (context) => {
    query(context, []);
    const { principal } = await authenticate(context, ["read"]);
    return response(
      context,
      await sessions().quota(
        principal,
        context.req.param("id"),
        context.get("restSignal"),
      ),
    );
  });
  for (const kind of ["activation", "revocation"] as const) {
    app.post(`/smart-accounts/sessions/:id/${kind}-plans`, async (context) => {
      query(context, []);
      const { input, principal } = await authenticate(context, ["plan"]);
      return response(
        context,
        await sessions().prepareOwnerPlan(
          principal,
          context.req.param("id"),
          kind,
          object(jsonBody(input), ["compiledHash"]) as { compiledHash: Hex },
          idempotency(principal),
          requestHash(input),
          context.get("restSignal"),
        ),
        201,
      );
    });
  }
  const walletPayments = (principal: RestPrincipal) => {
    if (principal.kind !== 'wallet-app')
      throw new RestError(403, 'WALLET_APP_REQUIRED', 'Connect a trusted app before preparing a wallet payment review.');
    if (!deps.walletPayments)
      throw new RestError(503, 'WALLET_PAYMENTS_UNAVAILABLE', 'Wallet payment reviews are not configured.');
    return deps.walletPayments;
  };
  app.post('/wallet/payment-reviews', async context => {
    query(context, []);
    const { input, principal } = await authenticate(context, ['plan']);
    const service = walletPayments(principal);
    const body = object(jsonBody(input), ['operationId', 'state', 'id']);
    if (typeof body.operationId !== 'string' || typeof body.state !== 'string' || (body.id !== undefined && typeof body.id !== 'string'))
      throw new RestError(400, 'WALLET_PAYMENT_REVIEW_INPUT', 'Choose the prepared operation and callback state.');
    const view = await service.prepare(actor(principal), { operationId: body.operationId, state: body.state, ...(body.id === undefined ? {} : { id: body.id }) }, idempotency(principal));
    return response(context, publicWalletPaymentReview(view), 201);
  });
  app.get('/wallet/payment-reviews/:id', async context => {
    query(context, []);
    const { principal } = await authenticate(context, ['read']);
    const view = await walletPayments(principal).getForApp(actor(principal), context.req.param('id'));
    return response(context, publicWalletPaymentAppReview(view));
  });
  const userOperations = () => {
    if (!deps.userOperations)
      throw new RestError(
        503,
        "USER_OPERATIONS_UNAVAILABLE",
        "The reviewed ERC-4337 execution transport is not configured.",
      );
    return deps.userOperations;
  };
  app.post("/user-operations", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["plan"]);
    const body = jsonBody(input);
    const key = idempotency(principal), hash = `0x${requestHash(input).replace(/^0x/, "")}` as Hex;
    // The one-call form: the plan is created here (idempotent on its own key) and the operation
    // prepared over every one of its steps, so a sponsored payment needs one round trip, not three.
    if (object(body) && Object.hasOwn(body, "plan")) {
      const request = object(body, ["plan", "sponsorAuthorization"]);
      const plan = object(request.plan, ["bindingId", "operation", "input", "idempotencyKey"]);
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(plan.bindingId)) || typeof plan.idempotencyKey !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(plan.idempotencyKey)
        || typeof request.sponsorAuthorization !== "string")
        throw new RestError(400, "INVALID_INPUT", "Name the binding, the operation, its input, a plan key and the sponsorship.");
      // The head reads the preparation waits on longest start now, beside the plan's draft.
      const ahead = userOperations().headAhead(principal, plan.bindingId as Hex, context.get("restSignal"));
      const created = await smartAccountPlan(principal, plan.bindingId as Hex, { operation: plan.operation, input: plan.input }, plan.idempotencyKey,
        `0x${createHash("sha256").update(canonicalValue({ bindingId: plan.bindingId, operation: plan.operation, input: plan.input })).digest("hex")}`, context.get("restSignal"), ahead.head);
      try {
        const operation = await userOperations().prepare(
          principal,
          { planId: created.id, stepIndexes: created.draft.calls.map((_, index) => index), sponsorAuthorization: request.sponsorAuthorization },
          key,
          hash,
          context.get("restSignal"),
          ahead,
        );
        console.info(JSON.stringify({ service: "user-operations", action: "sponsored_payment", outcome: "accepted", planId: created.id, operationId: operation.id }));
        return response(context, { plan: created, operation, sponsorship: "accepted" }, 201);
      } catch (error) {
        // The plan stands. A sponsorship the voucher does not cover (the plan differs from what it
        // was issued for) is answered with the plan alone, so the app can sponsor the plan it got.
        if (error instanceof RestError && error.code === "SPONSOR_AUTHORIZATION_INVALID") {
          console.info(JSON.stringify({ service: "user-operations", action: "sponsored_payment", outcome: "refused", planId: created.id }));
          return response(context, { plan: created, sponsorship: "refused" }, 201);
        }
        throw error;
      }
    }
    return response(
      context,
      await userOperations().prepare(
        principal,
        body as unknown as UserOperationPreparationInput,
        key,
        hash,
        context.get("restSignal"),
      ),
      201,
    );
  });
  app.post("/user-operations/:id/submissions", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["relay"]);
    const body = object(jsonBody(input), ["signature"]);
    return response(
      context,
      await userOperations().submit(
        principal,
        context.req.param("id"),
        body.signature as Hex,
        idempotency(principal),
        context.get("restSignal"),
      ),
      202,
    );
  });
  app.post("/user-operations/:id/retirement", async (context) => {
    query(context, []);
    const { input, principal } = await authenticate(context, ["relay"]);
    object(jsonBody(input), []);
    return response(context, await userOperations().retire(principal, context.req.param("id"), context.get("restSignal")));
  });
  app.get("/user-operations/:id", async (context) => {
    // `wait` (seconds, at most 20) holds the answer until the record moves past `since`.
    const params = query(context, ["wait", "since"]);
    const wait = params.get("wait"), since = params.get("since");
    if ((wait === null) !== (since === null) || (wait !== null && !/^(?:[1-9]|1[0-9]|20)$/.test(wait)) || (since !== null && !/^(?:0|[1-9][0-9]{0,8})$/.test(since)))
      throw new RestError(400, "INVALID_QUERY", "Wait 1–20 seconds past a revision you have seen", { parameter: wait === null ? "since" : "wait" });
    const { principal } = await authenticate(context, ["read"]);
    return response(
      context,
      await userOperations().get(
        principal,
        context.req.param("id"),
        context.get("restSignal"),
        wait === null ? undefined : { since: Number(since), untilMs: Date.now() + Number(wait) * 1000 },
      ),
    );
  });
  app.notFound((context) =>
    problem(
      new RestError(
        404,
        "ENDPOINT_NOT_FOUND",
        "Use the API specification to choose a supported endpoint",
      ),
      context,
    ),
  );
  return app;
}
