import { createHash, randomUUID } from "node:crypto";
import { canonical as canonicalValue } from "./sponsorship/validation.js";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Address, Hex } from "viem";
import type { ProtocolOperations } from "@juicebox/mcp/host";
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
import {
  ContractCatalog,
  functionInputJsonSchema,
  functionOutputJsonSchema,
  type ContractCategory,
} from "./contracts/catalog.js";
import { RestError, type RestActor, type RestBlockEvidence, type RestPlanDraft } from "./core.js";
import {
  restRequest,
  setOwnerApproval,
  setSponsorshipOwnerApproval,
  setRestAuthority,
  timedAuthPhase,
  withRestRequest,
} from "./context.js";
import type { IndexerReadInput, IndexerReadService } from "./indexer/index.js";
import type {
  createProtocolReadService,
  PrepareInput,
  ReadInput,
  ResolveInput,
} from "./protocol/index.js";
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
  jsonValue,
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
  /** Omit standalone protocol reference routes while retaining account execution. */
  surface?: "wallet";
  auth: RestAuth;
  quota: Pick<Store, "consumeRequest">;
  contracts: ContractCatalog;
  protocol: ReturnType<typeof createProtocolReadService>;
  indexer: IndexerReadService;
  operations: ProtocolOperations;
  transactions: TransactionService;
  sponsorship?: RelayrSponsorshipService;
  smartAccounts?: ReturnType<typeof createSmartAccountService>;
  sessionReviewer?: ReturnType<typeof createSessionPolicyReviewer>;
  sessions?: SessionService;
  userOperations?: UserOperationService;
  walletPayments?: Pick<PostgresWalletPaymentReviewStore, 'prepare' | 'getForApp'>;
  omnichain?: {
    getProjectGroup(
      project: { chainId: number; projectId: string; version: 6 },
      options: { source: "onchain" | "bendystraw"; maxMembers?: number },
      signal?: AbortSignal,
    ): Promise<unknown>;
  };
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
const page = (params: URLSearchParams) => ({
  offset: integer(params.get("offset") ?? "0", "offset", 100_000),
  limit: integer(params.get("limit") ?? "25", "limit", 100),
});
const nonTransactionPreparations = new Set([
  "prepare_project_metadata",
  "prepare_intent",
]);
const statelessPlanOperations = new Set([
  "inspect_plan",
  "simulate_plan",
  "verify_plan",
]);

export function operationDescriptors(operations: ProtocolOperations) {
  return operations
    .list()
    .filter(
      (operation) =>
        !operation.effects.externalMutation &&
        !statelessPlanOperations.has(operation.id),
    )
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
      method: operation.transaction ? "POST" : "GET",
      path: operation.transaction
        ? `${REST_PREFIX}/operations/${operation.id}/plans`
        : `${REST_PREFIX}/operations/${operation.id}`,
    }));
}

function source(params: URLSearchParams): "onchain" | "bendystraw" {
  const value = required(params, "source");
  if (value !== "onchain" && value !== "bendystraw")
    throw new RestError(
      400,
      "INVALID_SOURCE",
      "Choose onchain or bendystraw explicitly",
    );
  return value;
}

function protocolInput(params: URLSearchParams, read: true): ReadInput;
function protocolInput(params: URLSearchParams, read: false): ResolveInput;
function protocolInput(
  params: URLSearchParams,
  read: boolean,
): ReadInput | ResolveInput {
  const common = {
    chainId: integer(required(params, "chainId"), "chainId"),
    contractId: required(params, "contractId"),
    ...(params.has("address") ? { address: required(params, "address") } : {}),
    ...(params.has("projectId")
      ? { projectId: required(params, "projectId") }
      : {}),
    ...(params.has("blockNumber")
      ? { blockNumber: required(params, "blockNumber") }
      : {}),
  };
  if (!read) return common;
  const args = jsonValue(required(params, "args"), "args");
  if (!Array.isArray(args))
    throw new RestError(
      400,
      "INVALID_ARGUMENTS",
      "Function arguments must be a JSON array",
    );
  return { ...common, function: required(params, "function"), args };
}

function indexerInput(params: URLSearchParams): IndexerReadInput {
  const value: Record<string, unknown> = {
    network: required(params, "network"),
  };
  for (const key of ["chainId", "limit"])
    if (params.has(key)) value[key] = integer(required(params, key), key);
  for (const key of ["projectId", "cursor"])
    if (params.has(key)) value[key] = required(params, key);
  for (const key of ["id", "filters", "fields", "orderBy"])
    if (params.has(key)) value[key] = jsonValue(required(params, key), key);
  return value as unknown as IndexerReadInput;
}

/** An admission slower than this logs which phase waited. */
const SLOW_AUTH_MS = 300;

/** Mount at /api/v1. Owner and grant requests are signed; bounded public setup
 * inspection cannot mutate authority and finalization has its own exact proof. */

export function createRestApp(deps: RestDependencies): Hono<RestEnv> {
  const app = new Hono<RestEnv>();
  const reference = deps.surface === "wallet" ? undefined : app;
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
    if (!byId.get(id)?.transaction)
      throw new RestError(
        404,
        "TRANSACTION_OPERATION_NOT_FOUND",
        deps.surface === "wallet" ? "Choose a transaction operation from the API reference" : "Choose a transaction operation from the catalog",
      );
    const draft = await deps.operations.prepare(id, input, {
      source: "onchain",
      signal,
      ...(at ? { at: { chainId: at.chainId as 8453, blockNumber: at.blockNumber, blockHash: at.blockHash, timestamp: at.timestamp, source: "rpc" } } : {}),
    });
    return {
      ...draft,
      evidence: draft.evidence.map((item) => ({ ...item, source: "onchain" })),
    };
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
      ...(deps.surface === "wallet" ? { protocolReference: "https://juicebox.center/api" } : {}),
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
      ...(deps.surface === "wallet" ? { protocolReference: "https://juicebox.center/api" } : {
        omnichain: {
          available: Boolean(deps.omnichain),
          atomicAcrossChains: false,
          receiptConfirmsBridgeSettlement: false,
        },
        sources: {
          onchain: { canonicalBlockHash: true },
          bendystraw: {
            canonicalBlockHash: false,
            pagination: "cursor",
            protocolVersion: 6,
          },
        },
        catalogs: {
          contracts: `${REST_PREFIX}/catalog/contracts`,
          indexer: `${REST_PREFIX}/catalog/indexer`,
          operations: `${REST_PREFIX}/catalog/operations`,
        },
      }),
    });
  });
  reference?.get("/catalog/contracts", (context) => {
    const params = query(context, [
      "packageId",
      "category",
      "chainId",
      "deployedOnly",
      "executableOnly",
      "offset",
      "limit",
    ]);
    for (const key of ["deployedOnly", "executableOnly"])
      if (params.has(key) && !["true", "false"].includes(params.get(key)!))
        throw new RestError(
          400,
          "INVALID_BOOLEAN",
          `${key} must be true or false`,
        );
    const category = params.get("category");
    if (
      category &&
      !["contract", "abstract", "interface", "library", "script"].includes(
        category,
      )
    )
      throw new RestError(
        400,
        "INVALID_CATEGORY",
        "Choose a catalog contract category",
      );
    const all = deps.contracts.list({
      ...(params.has("packageId")
        ? { packageId: required(params, "packageId") }
        : {}),
      ...(category ? { category: category as ContractCategory } : {}),
      ...(params.has("chainId")
        ? { chainId: integer(required(params, "chainId"), "chainId") }
        : {}),
      deployedOnly: params.get("deployedOnly") === "true",
      executableOnly: params.get("executableOnly") === "true",
    });
    const { offset, limit } = page(params);
    if (limit < 1)
      throw new RestError(400, "INVALID_LIMIT", "Page limit must be positive");
    return response(context, {
      protocolVersion: 6,
      provenance: deps.contracts.data.deploymentManifest,
      packages: deps.contracts.data.packages,
      exclusions: deps.contracts.data.exclusions,
      items: all.slice(offset, offset + limit).map((item) => ({
        id: item.id,
        name: item.name,
        packageId: item.packageId,
        category: item.category,
        executable: item.executable,
        methodCounts: {
          read: item.methods.filter((method) => method.kind === "read").length,
          write: item.methods.filter((method) => method.kind === "write")
            .length,
        },
        chains: item.deployments.map((deployment) => ({
          chainId: deployment.chainId,
          status: deployment.status,
          addresses: deployment.instances.map((instance) => instance.address),
          instances: deployment.instances.map(({ address, retired, generation }) => ({
            address, retired, ...(generation ? { generation } : {}),
          })),
        })),
      })),
      total: all.length,
      nextOffset: offset + limit < all.length ? offset + limit : null,
    });
  });
  reference?.get("/catalog/contract", (context) => {
    const params = query(context, ["id"]);
    return response(context, deps.contracts.get(required(params, "id")));
  });
  reference?.get("/catalog/method", (context) => {
    const params = query(context, ["contractId", "signature", "abiHash"]);
    const method = deps.contracts.method(
      required(params, "contractId"),
      required(params, "signature"),
      params.get("abiHash") ?? undefined,
    );
    return response(context, {
      ...method,
      inputJsonSchema: functionInputJsonSchema(method),
      outputJsonSchema: functionOutputJsonSchema(method),
    });
  });
  reference?.get("/catalog/indexer", (context) => {
    query(context, []);
    return response(context, deps.indexer.catalog());
  });
  reference?.get("/catalog/operations", (context) => {
    query(context, []);
    return response(context, { operations: descriptors });
  });
  reference?.get("/catalog/operations/:id", (context) => {
    query(context, []);
    const descriptor = byId.get(context.req.param("id"));
    if (!descriptor)
      throw new RestError(
        404,
        "OPERATION_NOT_FOUND",
        "Choose an operation from the catalog",
      );
    return response(context, descriptor);
  });

  app.route(
    "/",
    createRestAuthRouter(deps.auth, {
      requestTarget,
      onError: problem,
      onAuthenticated: accountBudget,
    }),
  );

  reference?.get("/protocol/resolve", async (context) => {
    const params = query(context, [
      "chainId",
      "contractId",
      "address",
      "projectId",
      "blockNumber",
    ]);
    await authenticate(context, ["read"]);
    return response(
      context,
      await deps.protocol.resolve(
        protocolInput(params, false),
        context.get("restSignal"),
      ),
    );
  });
  reference?.get("/protocol/read", async (context) => {
    const params = query(context, [
      "chainId",
      "contractId",
      "address",
      "projectId",
      "blockNumber",
      "function",
      "args",
    ]);
    await authenticate(context, ["read"]);
    return response(
      context,
      await deps.protocol.read(
        protocolInput(params, true),
        context.get("restSignal"),
      ),
    );
  });
  reference?.get("/indexer/status", async (context) => {
    const params = query(context, ["network"]);
    await authenticate(context, ["read"]);
    return response(
      context,
      await deps.indexer.status(
        { network: required(params, "network") as "mainnet" | "testnet" },
        context.get("restSignal"),
      ),
    );
  });
  reference?.get("/indexer/:entity/record", async (context) => {
    const params = query(context, [
      "network",
      "chainId",
      "projectId",
      "id",
      "fields",
    ]);
    await authenticate(context, ["read"]);
    return response(
      context,
      await deps.indexer.read(
        context.req.param("entity"),
        indexerInput(params),
        context.get("restSignal"),
      ),
    );
  });
  reference?.get("/indexer/:entity", async (context) => {
    const params = query(context, [
      "network",
      "chainId",
      "projectId",
      "filters",
      "fields",
      "orderBy",
      "limit",
      "cursor",
    ]);
    await authenticate(context, ["read"]);
    return response(
      context,
      await deps.indexer.list(
        context.req.param("entity"),
        indexerInput(params),
        context.get("restSignal"),
      ),
    );
  });
  reference?.get("/projects/:chainId/:projectId", async (context) => {
    const selected = source(query(context, ["source"]));
    await authenticate(context, ["read"]);
    return response(
      context,
      await deps.operations.execute(
        "get_project",
        {
          project: {
            chainId: integer(context.req.param("chainId"), "chainId"),
            projectId: context.req.param("projectId"),
            version: 6,
          },
        },
        {
          source: selected === "bendystraw" ? "indexer" : "onchain",
          signal: context.get("restSignal"),
        },
      ),
    );
  });
  reference?.get("/projects/:chainId/:projectId/omnichain", async (context) => {
    const params = query(context, ["source", "maxMembers"]);
    const selected = source(params);
    await authenticate(context, ["read"]);
    if (!deps.omnichain)
      throw new RestError(
        503,
        "OMNICHAIN_UNAVAILABLE",
        "The omnichain reader is not configured",
      );
    return response(
      context,
      await deps.omnichain.getProjectGroup(
        {
          chainId: integer(context.req.param("chainId"), "chainId"),
          projectId: context.req.param("projectId"),
          version: 6,
        },
        {
          source: selected,
          ...(params.has("maxMembers")
            ? {
                maxMembers: integer(
                  required(params, "maxMembers"),
                  "maxMembers",
                  8,
                ),
              }
            : {}),
        },
        context.get("restSignal"),
      ),
    );
  });
  reference?.get("/operations/:id", async (context) => {
    const params = query(context, ["input", "source"]);
    const id = context.req.param("id");
    const descriptor = byId.get(id);
    if (
      !descriptor ||
      descriptor.transaction ||
      (descriptor.kind === "prepare" && !nonTransactionPreparations.has(id))
    )
      throw new RestError(
        404,
        "READ_OPERATION_NOT_FOUND",
        "Choose a read operation from the catalog",
      );
    const selectable = descriptor.sources.filter(
      (source) => source === "onchain" || source === "bendystraw",
    );
    const selected = params.has("source") ? source(params) : undefined;
    if (selectable.length > 1 && !selected)
      throw new RestError(
        400,
        "SOURCE_REQUIRED",
        "Choose onchain or bendystraw explicitly",
      );
    await authenticate(context, ["read"]);
    return response(
      context,
      await deps.operations.execute(
        id,
        jsonValue(params.get("input") ?? "{}"),
        {
          signal: context.get("restSignal"),
          ...(selected
            ? { source: selected === "bendystraw" ? "indexer" : "onchain" }
            : {}),
        },
      ),
    );
  });
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
    const draft =
      body.operation === "contract_calls"
        ? await deps.protocol.prepare(
            object(body.input) as unknown as PrepareInput,
            context.get("restSignal"),
          )
        : await draftFor(body.operation, body.input, context.get("restSignal"));
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
    const draft =
      body.operation === "contract_calls"
        ? await deps.protocol.prepare(object(body.input) as unknown as PrepareInput, signal)
        : await draftFor(body.operation, body.input, signal, at);
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
