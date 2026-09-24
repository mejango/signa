import { paymentProjectionFixture } from './fixtures/wallet-payment-projection.js';
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { DomainError, type PlanDraft, type ProtocolOperation, type ProtocolOperations } from "@juicebox/mcp/host";
import { createRestApp, type RestDependencies } from "../src/rest/app.js";
import { timedAuthPhase } from "../src/rest/context.js";
import { createRestAuth, MemoryAccountStore, type BotScope, type BotGrant, type RestPrincipal } from "../src/rest/auth/index.js";
import {
  accountIdFor, createBotRegistration, newRequestNonce, prepareSignedRequest,
  type ClientOptions, type PreparedRequest, type RequestOptions,
} from "../src/rest/client/index.js";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";
import { createIndexerReadService } from "../src/rest/indexer/index.js";
import { createProtocolReadService } from "../src/rest/protocol/index.js";
import { type RestActor, type RestPlanDraft, type RestRpc, RestError } from "../src/rest/core.js";
import { MemoryTransactionStore } from "../src/rest/transactions/memory.js";
import { TransactionService } from "../src/rest/transactions/service.js";

// Public test keys. Every RPC is a local fake which rejects any broadcast.
const owner = privateKeyToAccount(`0x${"06".padStart(64, "0")}`);
const bot = privateKeyToAccount(`0x${"07".padStart(64, "0")}`);
const outsider = privateKeyToAccount(`0x${"08".padStart(64, "0")}`);
const audience = "https://juicebox.center";
const now = 1_900_000_000;
const accountId = accountIdFor(owner.address, 1);
const target = "0x1111111111111111111111111111111111111111" as Address;
const blockHash = `0x${"ab".repeat(32)}` as Hex;
const block = { hash: blockHash, number: "0x64", timestamp: `0x${now.toString(16)}`, baseFeePerGas: "0x1" };
const ownerActor: RestActor = { accountId, principalId: `owner:${accountId}` };
const appPrincipal = (): RestPrincipal & { kind: "wallet-app" } => ({
  kind: "wallet-app", principalId: "app:11111111-1111-4111-8111-111111111111:1",
  walletApp: { origin: "https://beep.biz", audience, incarnation: "1" },
  account: { id: accountIdFor(target, 8453), ownerAddress: target, authorityChainId: 8453,
    profile: { displayName: "", bio: "", avatarUri: null }, createdAt: now, updatedAt: now },
  signer: bot.address, grantId: "11111111-1111-4111-8111-111111111111", isOwner: false,
  scopes: ["read", "plan", "relay"], requestNonce: newRequestNonce(), idempotencyKey: null,
});

function descriptor(id: string, transaction: boolean): ProtocolOperation {
  return {
    id, transaction, kind: transaction ? "prepare" : "read",
    description: `HTTP integration fixture for ${id}`,
    sources: transaction ? ["onchain"] : ["onchain", "indexer"],
    schema: z.object({}).passthrough(), inputJsonSchema: { type: "object" },
    effects: { externalMutation: false, idempotent: true },
    handler: async () => undefined,
  };
}

async function fixture(overrides: Partial<RestDependencies> = {}) {
  const clock = { now };
  const accounts = new MemoryAccountStore();
  const auth = createRestAuth({ store: accounts, audience, now: () => clock.now });
  const transactionStore = new MemoryTransactionStore(accounts);
  const rpcCalls: Array<{ chainId: number; method: string; params: readonly unknown[] }> = [];
  const rpc: RestRpc = { request: async (chainId, method, params) => {
    rpcCalls.push({ chainId, method, params });
    if (method === "eth_getBlockByNumber") return block;
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getTransactionReceipt" || method === "eth_getTransactionByHash") return null;
    throw new Error(`Unexpected fake RPC method; no network access is permitted: ${method}`);
  } };
  const transactions = new TransactionService({ store: transactionStore, rpc, now: () => clock.now * 1000 });
  const draft: RestPlanDraft = {
    account: owner.address, operation: "contract_calls",
    calls: [{ chainId: 1, to: target, data: "0x12345678", value: "0", label: "Review fixture call", dependsOn: [], decoded: { functionName: "fixture", args: [] } }],
    evidence: [{ chainId: 1, blockNumber: "100", blockHash, timestamp: String(now), source: "onchain" }],
    summary: { description: "Unsigned local test plan" }, warnings: [],
  };
  const catalog = await getContractCatalog();
  const protocol = createProtocolReadService({ catalog, rpc });
  const prepare = vi.spyOn(protocol, "prepare").mockImplementation(async () => structuredClone(draft));
  const entries = [descriptor("get_project", false), descriptor("prepare_pay", true)];
  const execute = vi.fn<ProtocolOperations["execute"]>(async (_id, input, options) => ({ source: options?.source, input }));
  const semanticPrepare = vi.fn<ProtocolOperations["prepare"]>(async () => ({
    account: draft.account, operation: "prepare_pay", summary: structuredClone(draft.summary), warnings: [...draft.warnings],
    calls: [{ ...structuredClone(draft.calls[0]!), chainId: 1, decoded: { functionName: "fixture", args: [] } }],
    evidence: [{ chainId: 1, blockNumber: "100", blockHash, timestamp: String(now), source: "rpc" }],
  } satisfies PlanDraft));
  const operations: ProtocolOperations = {
    list: () => entries, get: (id) => entries.find((entry) => entry.id === id)!,
    execute, prepare: semanticPrepare,
  };
  const quotas = new Map<string, number>();
  const quota: RestDependencies["quota"] = { consumeRequest: async (key, limit) => {
    const count = (quotas.get(key) ?? 0) + 1;
    quotas.set(key, count);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } };
  const app = new Hono();
  app.route("/api/v1", createRestApp({
    auth, quota, contracts: catalog, protocol, indexer: createIndexerReadService(),
    operations, transactions, openapi: { openapi: "3.1.0", paths: {} }, ...overrides,
  }));
  const ownerConfig: ClientOptions = { audience, accountId, signer: owner, now: () => clock.now };
  const prepared = (options: RequestOptions, config = ownerConfig) => prepareSignedRequest(config, options);
  const sendPrepared = (request: PreparedRequest, url = request.url) => app.request(url, {
    method: request.method, headers: request.headers,
    ...(request.body.length ? { body: request.body as BodyInit } : {}),
  });
  const send = async (options: RequestOptions, config = ownerConfig) => sendPrepared(await prepared(options, config));
  const enrolled = await send({ requestTarget: "/api/v1/accounts/enroll", method: "POST", json: {} });
  expect(enrolled.status).toBe(200);
  const register = async (scopes: BotScope[] = ["read"]) => {
    const proof = await createBotRegistration(audience, {
      accountId, botAddress: bot.address, scopes, label: "Integration bot",
      expiresAt: now + 3600, ownerRequestNonce: newRequestNonce(),
    }, bot);
    const response = await send({ method: "POST", requestTarget: "/api/v1/accounts/me/bots", json: proof.registration, nonce: proof.ownerRequestNonce });
    expect(response.status).toBe(201);
    const grant = (await response.json() as { bot: BotGrant }).bot;
    return { grant, config: { ...ownerConfig, signer: bot, grantId: grant.id } satisfies ClientOptions };
  };
  return { app, accounts, auth, transactionStore, transactions, draft, catalog, rpcCalls, quotas, clock,
    execute, semanticPrepare, prepare, ownerConfig, prepared, sendPrepared, send, register };
}

describe("wallet and account API surface", () => {
  it("omits standalone Center reference reads without invoking their services or authentication", async () => {
    const f = await fixture({ surface: "wallet" });
    const authenticate = vi.spyOn(f.auth, "authenticate");
    const paths = [
      "/catalog/contracts", "/catalog/contract", "/catalog/method", "/catalog/indexer", "/catalog/operations", "/catalog/operations/get_project",
      "/protocol/resolve", "/protocol/read", "/indexer/status", "/indexer/projects", "/indexer/projects/record",
      "/projects/1/1?source=onchain", "/projects/1/1/omnichain?source=onchain", "/operations/get_project?source=onchain",
    ];
    for (const path of paths) {
      expect((await f.app.request(`${audience}/api/v1${path}`)).status, path).toBe(404);
      expect((await f.send({ requestTarget: `/api/v1${path}` })).status, path).toBe(404);
    }
    expect(authenticate).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled(); expect(f.semanticPrepare).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("keeps actual account, grant and transaction planning journeys with their signed authorization", async () => {
    const f = await fixture({ surface: "wallet" });
    expect((await f.send({ requestTarget: "/api/v1/accounts/me" })).status).toBe(200);
    const ownerPlan = await f.send({ method: "POST", requestTarget: "/api/v1/plans", json: { operation: "contract_calls", input: {} }, idempotencyKey: "wallet-owner-plan" });
    expect(ownerPlan.status).toBe(201); expect(f.prepare).toHaveBeenCalledTimes(1);
    const { grant, config } = await f.register(["read", "plan"]);
    const prepared = await f.send({ method: "POST", requestTarget: "/api/v1/operations/prepare_pay/plans", json: {}, idempotencyKey: "wallet-bot-plan" }, config);
    expect(prepared.status).toBe(201); expect(f.semanticPrepare).toHaveBeenCalledTimes(1);
    const plan = await prepared.json();
    expect((await f.send({ requestTarget: `/api/v1/plans/${plan.id}` }, config)).status).toBe(200);
    // A plan grant still cannot relay, and revoked grants cannot read their old plans.
    const relay = await f.send({ method: "POST", requestTarget: `/api/v1/plans/${plan.id}/steps/0/submissions`, json: { rawSignedTransaction: "0x01" }, idempotencyKey: "wallet-forbidden-relay" }, config);
    expect(relay.status).toBe(403);
    expect((await f.send({ method: "DELETE", requestTarget: `/api/v1/accounts/me/bots/${grant.id}` })).status).toBe(200);
    expect((await f.send({ requestTarget: `/api/v1/plans/${plan.id}` }, config)).status).toBe(403);
    expect(f.rpcCalls.some(call => call.method === "eth_sendRawTransaction")).toBe(false);
  });

  it("keeps execution routes protected and points discovery at Center's protocol reference", async () => {
    const f = await fixture({ surface: "wallet" });
    for (const path of ["/plans", "/sponsorships", "/smart-accounts/binding-challenges", "/smart-accounts/sessions", "/user-operations", "/wallet/payment-reviews"]) {
      expect((await f.app.request(`${audience}/api/v1${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, path).toBe(401);
    }
    const capabilities = await (await f.app.request(`${audience}/api/v1/capabilities`)).json();
    expect(capabilities).toMatchObject({ audience, protocolReference: "https://juicebox.center/api", authentication: expect.any(Object), transactions: expect.any(Object), smartAccounts: expect.any(Object) });
    for (const field of ["catalogs", "sources", "omnichain"]) expect(capabilities).not.toHaveProperty(field);
    expect(await (await f.app.request(`${audience}/api/v1`)).json()).toMatchObject({ protocolReference: "https://juicebox.center/api", accounts: "/accounts" });
  });

  it("retains the existing full reference surface when no wallet profile is selected", async () => {
    const f = await fixture();
    expect((await f.app.request(`${audience}/api/v1/catalog/contracts`)).status).toBe(200);
    const catalog = await (await f.app.request(`${audience}/api/v1/catalog/operations`)).json();
    expect(catalog.operations.map((entry: { id: string }) => entry.id)).toEqual(["get_project", "prepare_pay"]);
    expect((await f.send({ requestTarget: "/api/v1/projects/1/1?source=onchain" })).status).toBe(200);
    const capabilities = await (await f.app.request(`${audience}/api/v1/capabilities`)).json();
    expect(capabilities).toHaveProperty("catalogs"); expect(capabilities).toHaveProperty("sources"); expect(capabilities).toHaveProperty("omnichain");
    expect(capabilities).not.toHaveProperty("protocolReference");
  });
});

describe('slow admission logging', () => {
  it('names the phases that waited when authentication passes 300 ms', async () => {
    const f = await fixture({ walletPayments: { prepare: vi.fn(), getForApp: vi.fn(async () => paymentProjectionFixture()) } as never });
    vi.spyOn(f.auth, 'authenticate').mockImplementation(() =>
      timedAuthPhase('admitMs', () => new Promise(resolve => setTimeout(() => resolve(appPrincipal()), 320))));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      expect((await f.send({ requestTarget: '/api/v1/wallet/payment-reviews/review-id' })).status).not.toBe(401);
      const line = info.mock.calls.map(([text]) => JSON.parse(String(text))).find(entry => entry.action === 'slow_auth');
      expect(line).toMatchObject({ service: 'rest', authMs: expect.any(Number), admitMs: expect.any(Number), quotaMs: expect.any(Number) });
      expect(line.admitMs).toBeGreaterThanOrEqual(300);
      expect(Object.keys(line).sort()).toEqual(['action', 'admitMs', 'authMs', 'quotaMs', 'service']);
    } finally { info.mockRestore(); }
  });
});

describe('signed wallet payment review controller', () => {
  function reviews() { return { prepare: vi.fn(async()=>paymentProjectionFixture()), getForApp: vi.fn(async()=>paymentProjectionFixture()) }; }
  it('requires signed app authority and preserves its exact actor and idempotency key',async()=>{
    const walletPayments=reviews(), f=await fixture({walletPayments});
    const principal={...appPrincipal(),idempotencyKey:'payment-review-attempt'};
    // Controller-only app authority; actual app signature, PG authority and ceremony proof
    // are exercised by their separate real HTTP/PG journey tests.
    vi.spyOn(f.auth,'authenticate').mockResolvedValue(principal);
    const body={operationId:'operation-id',state:'app-state'};
    const response=await f.send({method:'POST',requestTarget:'/api/v1/wallet/payment-reviews',json:body,idempotencyKey:'payment-review-attempt'});
    expect(response.status).toBe(201);
    expect(f.auth.authenticate).toHaveBeenCalledWith(expect.anything(),['plan']);
    expect(walletPayments.prepare).toHaveBeenCalledWith({accountId:principal.account.id,principalId:principal.principalId},body,'payment-review-attempt');
    const result=await response.json();expect(result).toMatchObject({id:'review-id',operationId:'operation-id'});
    expect(result).not.toHaveProperty('approval');expect(JSON.stringify(result)).not.toContain('private-');
    const read=await f.send({requestTarget:'/api/v1/wallet/payment-reviews/review-id'});
    expect(read.status).toBe(200);expect((await read.json()).approval).toEqual({signature:'0x1234',signedCommitment:'0x4321'});
    expect(walletPayments.getForApp).toHaveBeenCalledWith({accountId:principal.account.id,principalId:principal.principalId},'review-id');
  });
  it('rejects genuine signed legacy owner and bot principals without treating them as app grants',async()=>{
    const walletPayments=reviews(),f=await fixture({walletPayments}),bot=await f.register(['read','plan','relay']);
    for(const config of [f.ownerConfig,bot.config]) {
      const response=await f.send({method:'POST',requestTarget:'/api/v1/wallet/payment-reviews',json:{operationId:'operation-id',state:'app-state'},idempotencyKey:'payment-review-attempt'},config);
      expect(response.status).toBe(403);
      expect((await f.send({requestTarget:'/api/v1/wallet/payment-reviews/review-id'},config)).status).toBe(403);
    }
    expect(walletPayments.prepare).not.toHaveBeenCalled();expect(walletPayments.getForApp).not.toHaveBeenCalled();
  });
  it('rejects unsigned, missing-idempotency and authority-injecting requests before review work',async()=>{
    const walletPayments=reviews(),f=await fixture({walletPayments});
    expect((await f.app.request(audience+'/api/v1/wallet/payment-reviews/review-id')).status).toBe(401);
    const principal=appPrincipal();vi.spyOn(f.auth,'authenticate').mockResolvedValue(principal);
    const send=(json:unknown)=>f.send({method:'POST',requestTarget:'/api/v1/wallet/payment-reviews',json});
    expect((await send({operationId:'operation-id',state:'app-state'})).status).toBe(400);
    principal.idempotencyKey='payment-review-attempt';
    for(const extra of [{accountId:'other'},{sessionId:'other'},{callbackUri:'https://attacker.test'},{payment:{amount:'1'}}])
      expect((await send({operationId:'operation-id',state:'app-state',...extra})).status).toBe(400);
    expect(walletPayments.prepare).not.toHaveBeenCalled();
  });
  it('keeps payment reviews unavailable unless the trusted host explicitly configured them',async()=>{
    const f=await fixture();vi.spyOn(f.auth,'authenticate').mockResolvedValue({...appPrincipal(),idempotencyKey:'payment-review-attempt'});
    const response=await f.send({method:'POST',requestTarget:'/api/v1/wallet/payment-reviews',json:{operationId:'operation-id',state:'app-state'},idempotencyKey:'payment-review-attempt'});
    expect(response.status).toBe(503);expect((await response.json()).code).toBe('WALLET_PAYMENTS_UNAVAILABLE');
  });
});

describe("mounted signed REST API", () => {
  it("keeps discovery public and requires a signature for live reads", async () => {
    const f = await fixture();
    const capabilities = await f.app.request(`${audience}/api/v1/capabilities`);
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({ protocolVersion: 6, authentication: { staticCredentials: false } });
    const catalog = await f.app.request(`${audience}/api/v1/catalog/contracts?limit=1`);
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ protocolVersion: 6, items: expect.any(Array) });
    const routers = await f.app.request(`${audience}/api/v1/catalog/contracts?packageId=%40bananapus%2Frouter-terminal-v6&category=contract&limit=100`);
    expect(await routers.json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
      name: "JBRouterTerminal", chains: expect.arrayContaining([expect.objectContaining({ chainId: 11155111,
        instances: expect.arrayContaining([
          expect.objectContaining({ generation: "current", retired: false }),
          expect.objectContaining({ generation: "previous", retired: true }),
          expect.objectContaining({ generation: "v1", retired: true }),
        ]),
      })]),
    })]) });
    const unsigned = await f.app.request(`${audience}/api/v1/projects/1/1?source=onchain`);
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("enforces cumulative read, plan, and relay profiles at the HTTP boundary", async () => {
    const f = await fixture();
    const readBot = await f.register();
    expect((await f.send({ requestTarget: "/api/v1/projects/1/1?source=onchain" }, readBot.config)).status).toBe(200);
    const planInput = { method: "POST", requestTarget: "/api/v1/plans", json: { operation: "contract_calls", input: {} }, idempotencyKey: "read-cannot-plan" };
    expect((await f.send(planInput, readBot.config)).status).toBe(403);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.semanticPrepare).not.toHaveBeenCalled();
    const planner = await f.register(["read", "plan"]);
    const planResponse = await f.send({ ...planInput, idempotencyKey: "planner" }, planner.config);
    expect(planResponse.status).toBe(201);
    const plan = await planResponse.json() as { id: string; account: string };
    expect(plan.account.toLowerCase()).toBe(owner.address.toLowerCase());
    expect((await f.send({ requestTarget: `/api/v1/plans/${plan.id}` })).status).toBe(200);
    expect((await f.send({ requestTarget: "/api/v1/projects/1/1?source=onchain" }, planner.config)).status).toBe(200);
    const relay = await f.send({ method: "POST", requestTarget: `/api/v1/plans/${plan.id}/steps/0/submissions`, json: { rawSignedTransaction: "0x01" }, idempotencyKey: "planner-cannot-relay" }, planner.config);
    expect(relay.status).toBe(403);
    const executor = await f.register(["read", "plan", "relay"]);
    expect((await f.send({ requestTarget: `/api/v1/plans/${plan.id}` }, executor.config)).status).toBe(404);
    expect((await f.send({ method: "POST", requestTarget: `/api/v1/plans/${plan.id}/steps/0/submissions`, json: { rawSignedTransaction: "0x01" }, idempotencyKey: "relay-cannot-take-plan" }, executor.config)).status).toBe(404);
    const executablePlan = await (await f.send({ ...planInput, idempotencyKey: "executor-plan" }, executor.config)).json() as { id: string };
    const submit = vi.spyOn(f.transactions, "submitStep");
    const invalidTransaction = await f.send({ method: "POST", requestTarget: `/api/v1/plans/${executablePlan.id}/steps/0/submissions`, json: { rawSignedTransaction: "0x01" }, idempotencyKey: "relay-validation" }, executor.config);
    expect(invalidTransaction.status).toBe(400);
    expect(await invalidTransaction.json()).toMatchObject({ code: "INVALID_SIGNED_TRANSACTION" });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]?.[0]).toEqual({ accountId, principalId: `bot:${executor.grant.id}` });
    expect(f.rpcCalls.every((call) => call.method !== "eth_sendRawTransaction")).toBe(true);
  });

  it("binds profile and grant management to the owner even when a bot has all scopes", async () => {
    const f = await fixture();
    const { grant, config } = await f.register(["read", "plan", "relay"]);
    for (const options of [
      { method: "POST", requestTarget: "/api/v1/accounts/enroll", json: {} },
      { method: "PATCH", requestTarget: "/api/v1/accounts/me", json: { displayName: "Bot takeover" } },
      { method: "DELETE", requestTarget: `/api/v1/accounts/me/bots/${grant.id}` },
      { requestTarget: "/api/v1/accounts/me/bots" },
    ]) expect((await f.send(options, config)).status).toBe(403);
    expect((await f.send({ method: "DELETE", requestTarget: `/api/v1/accounts/me/bots/${grant.id}` })).status).toBe(200);
    expect((await f.send({ requestTarget: "/api/v1/projects/1/1?source=onchain" }, config)).status).toBe(403);
  });

  it("separates owner quota from a bot's exhausted request budget", async () => {
    const f = await fixture();
    const { grant, config } = await f.register();
    f.quotas.set(`rest:account:${accountId}:bots`, 300);
    expect((await f.send({ requestTarget: "/api/v1/accounts/me" }, config)).status).toBe(429);
    const revoked = await f.send({ method: "DELETE", requestTarget: `/api/v1/accounts/me/bots/${grant.id}` });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("ratelimit-remaining")).not.toBe("0");
  });

  it("keeps app quota stable across grant renewal and separate by account/origin without bypassing the site cap", async () => {
    const f = await fixture(), principal = appPrincipal(), appAccountId = principal.account.id;
    // The auth boundary is tested independently; observe the real mounted HTTP quota behavior here.
    vi.spyOn(f.auth, "authenticate").mockImplementation(async () => principal);
    const read = () => f.send({ requestTarget: "/api/v1/projects/1/1?source=onchain" });
    f.quotas.set(`rest:account:${appAccountId}:bots`, 300);
    expect((await read()).status).toBe(200);
    const bucket = [...f.quotas.keys()].find(key => key.includes(appAccountId) && !key.endsWith(":bots"))!;
    expect(bucket).toContain("https://beep.biz");
    f.quotas.set(bucket, 300);
    principal.grantId = "22222222-2222-4222-8222-222222222222";
    principal.principalId = `app:${principal.grantId}:2`; principal.walletApp.incarnation = "2";
    expect((await read()).status).toBe(429);
    principal.walletApp.origin = "https://juicebox.money";
    expect((await read()).status).toBe(200);
    principal.account = { ...principal.account, id: accountIdFor(outsider.address, 8453), ownerAddress: outsider.address };
    expect((await read()).status).toBe(200);
    f.quotas.set("rest:site", 100_000);
    expect((await read()).status).toBe(429);
  });

  it("rejects app session review before invoking the session policy path", async () => {
    const f = await fixture();
    vi.spyOn(f.auth, "authenticate").mockResolvedValue(appPrincipal());
    const result = await f.send({ method: "POST", requestTarget: "/api/v1/smart-accounts/session-reviews", json: {} });
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ code: "SESSION_APP_UNAVAILABLE" });
  });

  it("requires explicit project source and never retries a failed source as another source", async () => {
    const f = await fixture();
    const omitted = await f.send({ requestTarget: "/api/v1/projects/1/1" });
    expect(omitted.status).toBe(400);
    const onchain = await f.send({ requestTarget: "/api/v1/projects/1/1?source=onchain" });
    expect(await onchain.json()).toMatchObject({ source: "onchain", input: { project: { chainId: 1, projectId: "1", version: 6 } } });
    const indexed = await f.send({ requestTarget: "/api/v1/projects/1/1?source=bendystraw" });
    expect(await indexed.json()).toMatchObject({ source: "indexer" });
    f.execute.mockRejectedValueOnce(new DomainError("RPC_UNAVAILABLE", "The configured source is unavailable", { retryable: true }));
    const callsBefore = f.execute.mock.calls.length;
    const failed = await f.send({ requestTarget: "/api/v1/projects/1/1?source=onchain" });
    expect(failed.status).toBe(502);
    expect(f.execute.mock.calls.slice(callsBefore)).toHaveLength(1);
    expect(f.execute.mock.calls.at(-1)?.[2]?.source).toBe("onchain");
    expect((await f.send({ requestTarget: "/api/v1/operations/get_project?input=%7B%7D" })).status).toBe(400);
  });

  it("rejects duplicate and unknown query parameters on public and signed routes", async () => {
    const f = await fixture();
    for (const path of [
      "/api/v1?unknown=1", "/api/v1/capabilities?unknown=1",
      "/api/v1/catalog/contracts?limit=1&limit=2",
      "/api/v1/projects/1/1?source=onchain&source=bendystraw",
      "/api/v1/accounts/me?unknown=1",
    ]) expect((await f.send({ requestTarget: path })).status).toBe(400);
  });

  it("binds equivalent query encodings and their exact order", async () => {
    const f = await fixture();
    const canonical = "/api/v1/operations/get_project?source=onchain&input=%7B%22tag%22%3A%22a%2Fb%22%7D";
    const request = await f.prepared({ requestTarget: canonical });
    const changed = await f.sendPrepared(request, request.url.replace("%2F", "%2f"));
    expect(changed.status).toBe(401);
    expect(await changed.json()).toMatchObject({ code: "INVALID_SIGNATURE" });
    expect((await f.sendPrepared(request)).status).toBe(200);
    const reordered = await f.prepared({ requestTarget: canonical });
    expect((await f.sendPrepared(reordered, `${audience}/api/v1/operations/get_project?input=%7B%22tag%22%3A%22a%2Fb%22%7D&source=onchain`)).status).toBe(401);
  });

  it("uses the Node raw target to reject normalization before routing or authentication", async () => {
    const f = await fixture();
    const request = await f.prepared({ requestTarget: "/api/v1/projects/1/1?source=onchain" });
    const response = await f.app.request(request.url, { method: request.method, headers: request.headers }, {
      incoming: { url: "/api/v1/ignored/../projects/1/1?source=onchain" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "NONCANONICAL_REQUEST_TARGET" });
    expect(f.execute).not.toHaveBeenCalled();
    expect((await f.sendPrepared(request)).status).toBe(200);
  });

  it.each(["/api/v1/plans", "/api/v1/operations/prepare_pay/plans"])("returns an existing idempotent plan before upstream work on %s", async (path) => {
    const f = await fixture();
    const json = path === "/api/v1/plans" ? { operation: "contract_calls", input: {} } : {};
    const options = { method: "POST", requestTarget: path, json, idempotencyKey: "repeat-exact-request" };
    const first = await f.send(options);
    expect(first.status).toBe(201);
    const original = await first.json() as { id: string };
    f.prepare.mockRejectedValue(new Error("private RPC URL https://private.example/credential"));
    f.semanticPrepare.mockRejectedValue(new Error("private RPC URL https://private.example/credential"));
    const again = await f.send(options);
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ id: original.id });
    expect(f.prepare.mock.calls.length + f.semanticPrepare.mock.calls.length).toBe(1);
  });

  it("rejects idempotency reuse across a changed body or route before preparing again", async () => {
    const f = await fixture();
    const options = { method: "POST", requestTarget: "/api/v1/plans", json: { operation: "contract_calls", input: {} }, idempotencyKey: "one-meaning" };
    expect((await f.send(options)).status).toBe(201);
    for (const changed of [
      { ...options, json: { operation: "contract_calls", input: { changed: true } } },
      { ...options, requestTarget: "/api/v1/operations/prepare_pay/plans", json: {} },
    ]) {
      const response = await f.send(changed);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "TRANSACTION_CONFLICT" });
    }
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.semanticPrepare).not.toHaveBeenCalled();
  });

  it("never allows one account to read another account's plans", async () => {
    const f = await fixture();
    const created = await f.send({ method: "POST", requestTarget: "/api/v1/plans", json: { operation: "contract_calls", input: {} }, idempotencyKey: "owner-plan" });
    const plan = await created.json() as { id: string };
    const other: ClientOptions = { ...f.ownerConfig, accountId: accountIdFor(outsider.address, 1), signer: outsider };
    expect((await f.send({ method: "POST", requestTarget: "/api/v1/accounts/enroll", json: {} }, other)).status).toBe(200);
    const inaccessible = await f.send({ requestTarget: `/api/v1/plans/${plan.id}` }, other);
    expect(inaccessible.status).toBe(404);
    expect(await inaccessible.json()).toMatchObject({ code: "PLAN_NOT_FOUND" });
  });

  it("serializes tracked transaction DTOs without stored raw transaction bytes", async () => {
    const f = await fixture();
    const response = await f.send({ method: "POST", requestTarget: "/api/v1/plans", json: { operation: "contract_calls", input: {} }, idempotencyKey: "tracked-plan" });
    const plan = await response.json() as { id: string; revision: number };
    const raw = await owner.signTransaction({ chainId: 1, type: "eip1559", nonce: 0, to: target, data: "0x12345678", value: 0n, gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    await f.transactionStore.claimSubmission({
      actor: ownerActor, planId: plan.id, stepIndex: 0, expectedRevision: plan.revision,
      now: now * 1000, dispatch: false,
      idempotency: { key: "preseed-known-hash", requestHash: "ab".repeat(32), operation: `submit:${plan.id}:0` },
      attempt: { hash: keccak256(raw), rawTransaction: raw, sender: owner.address, chainId: 1, nonce: "0", type: "eip1559", gas: "100000", maximumFeePerGas: "2", maximumCost: "200000", reservedAt: now * 1000, leaseToken: "local-fixture-lease", leaseUntil: now * 1000 + 30000, dispatchCount: 0 },
    });
    const read = await f.send({ requestTarget: `/api/v1/plans/${plan.id}` });
    const text = await read.text();
    expect(read.status).toBe(200);
    expect(text).toContain(keccak256(raw));
    expect(text).not.toContain(raw);
    expect(text).not.toContain("rawTransaction");
    expect(text).not.toContain("leaseToken");
    expect(f.rpcCalls.every((call) => call.method !== "eth_sendRawTransaction")).toBe(true);
  });

  it("returns RFC9457 errors with request IDs, CORS, and no upstream credentials", async () => {
    const f = await fixture();
    f.execute.mockRejectedValue(new Error("private credential https://upstream.example/super-secret rawTransaction=0xabcdef"));
    const prepared = await f.prepared({ requestTarget: "/api/v1/projects/1/1?source=onchain" });
    prepared.headers.set("Origin", "https://another-agent.example");
    prepared.headers.set("X-Request-Id", "caller-controlled");
    const response = await f.sendPrepared(prepared);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    const text = await response.text();
    const problem = JSON.parse(text);
    expect(problem).toMatchObject({ status: 500, code: "INTERNAL_ERROR", retryable: false });
    expect(problem.requestId).toBe(response.headers.get("x-request-id"));
    expect(problem.requestId).not.toBe("caller-controlled");
    expect(text).not.toMatch(/super-secret|upstream\.example|rawTransaction|abcdef/);
    const preflight = await f.app.request(`${audience}/api/v1/accounts/enroll`, { method: "OPTIONS", headers: { origin: "https://another-agent.example", "access-control-request-method": "POST", "access-control-request-headers": "x-juicebox-signature,content-type" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-juicebox-signature");
  });

  it("rejects declared GET bodies on public discovery and protected routes", async () => {
    const f = await fixture();
    for (const path of ["/api/v1/capabilities", "/api/v1/accounts/me", "/api/v1/projects/1/1?source=onchain"]) {
      const request = await f.prepared({ requestTarget: path });
      request.headers.set("content-length", "1");
      expect((await f.sendPrepared(request)).status).toBe(400);
    }
  });

  it("rejects revoked grant principals before live service work", async () => {
    const f = await fixture();
    const { grant, config } = await f.register(["read", "plan", "relay"]);
    await f.accounts.revokeBot(accountId, grant.id, now);
    const request = await f.send({ requestTarget: "/api/v1/projects/1/1?source=onchain" }, config);
    expect(request.status).toBe(403);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("prepares a sponsored payment in one call: the plan on its own key, the operation over every step, the plan alone when the voucher does not cover it", async () => {
    const prepare = vi.fn(async () => ({ id: "op-one", state: "prepared" }));
    const head = { chainId: 1, blockNumber: "100", blockHash, timestamp: String(now), source: "onchain" as const };
    const headAhead = vi.fn((_principal: unknown, bindingId: string) => ({ bindingId, nonceKey: 0n, head: Promise.resolve(head), reads: Promise.resolve({}) }));
    const f = await fixture({ userOperations: { prepare, headAhead } as never });
    const bindingId = `0x${"11".repeat(32)}`;
    const plan = { id: "plan-one", draft: { ...f.draft, calls: [f.draft.calls[0]!, { ...f.draft.calls[0]!, data: "0x9abcdef0" }] } };
    const createPlan = vi.spyOn(f.transactions, "createSmartAccountPlan").mockResolvedValue(plan as never);
    const findPlan = vi.spyOn(f.transactions, "findPlanByIdempotency").mockResolvedValue(undefined);
    const body = { plan: { bindingId, operation: "prepare_pay", input: { project: { chainId: 1, projectId: "1" } }, idempotencyKey: "beep-center-plan:attempt" }, sponsorAuthorization: "voucher" };
    const request = () => f.send({ method: "POST", requestTarget: "/api/v1/user-operations", idempotencyKey: "beep:attempt", json: body });
    const first = await request();
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ plan, operation: { id: "op-one", state: "prepared" }, sponsorship: "accepted" });
    // The plan is created with the head it drafted at, which the preparation proves canonical itself.
    expect(createPlan).toHaveBeenCalledWith(expect.anything(), bindingId, expect.anything(), "beep-center-plan:attempt", expect.stringMatching(/^0x[0-9a-f]{64}$/), head);
    // The head reads start beside the plan's draft and reach the preparation; the draft pins its reads at that head.
    expect(headAhead).toHaveBeenCalledWith(expect.anything(), bindingId, expect.anything());
    expect(f.semanticPrepare).toHaveBeenLastCalledWith("prepare_pay", expect.anything(),
      expect.objectContaining({ at: { chainId: 1, blockNumber: "100", blockHash, timestamp: String(now), source: "rpc" } }));
    expect(prepare).toHaveBeenCalledWith(expect.anything(), { planId: "plan-one", stepIndexes: [0, 1], sponsorAuthorization: "voucher" }, "beep:attempt", expect.stringMatching(/^0x[0-9a-f]{64}$/), expect.anything(),
      expect.objectContaining({ bindingId, nonceKey: 0n }));
    // A retry finds the plan by its key and does not draft again; a voucher the plan does not fit leaves the plan to be sponsored on its own.
    findPlan.mockResolvedValue(plan as never);
    prepare.mockRejectedValueOnce(new RestError(403, "SPONSOR_AUTHORIZATION_INVALID", "The sponsorship authorization is invalid or expired."));
    const refused = await request();
    expect(refused.status).toBe(201);
    expect(await refused.json()).toEqual({ plan, sponsorship: "refused" });
    expect(createPlan).toHaveBeenCalledTimes(1);
    // The form is strict: a binding, an operation, an input, a plan key and a sponsorship, nothing else.
    for (const broken of [{ ...body, plan: { ...body.plan, idempotencyKey: "" } }, { ...body, sponsorAuthorization: 1 }, { ...body, extra: true }, { plan: { ...body.plan, bindingId: "0x12" }, sponsorAuthorization: "v" }])
      expect((await f.send({ method: "POST", requestTarget: "/api/v1/user-operations", idempotencyKey: "beep:attempt", json: broken })).status).toBe(400);
  });

  it("rejects expired grants even with a newly valid request signature", async () => {
    const f = await fixture();
    const { grant, config } = await f.register();
    f.clock.now = grant.expiresAt;
    const request = await f.send({ requestTarget: "/api/v1/projects/1/1?source=onchain" }, config);
    expect(request.status).toBe(403);
    expect(f.execute).not.toHaveBeenCalled();
  });
});
