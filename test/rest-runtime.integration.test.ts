import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ProtocolOperations } from "../src/signaProtocol.js";
import { Hono } from "hono";
import { createSignaApp } from "../src/signaApp.js";
import { mountRestSite } from "../src/rest/site.js";
import type { JbcenterEnv } from "../src/types.js";
import type { Store } from "../src/store.js";
import { createRestApp } from "../src/rest/app.js";
import {
  createRestAuth,
  MemoryAccountStore,
  type BotGrant,
  type BotScope,
} from "../src/rest/auth/index.js";
import {
  accountIdFor,
  createBotRegistration,
  newRequestNonce,
  prepareSignedRequest,
  type ClientOptions,
  type PreparedRequest,
  type RequestOptions,
} from "../src/rest/client/index.js";
import { restRequest } from "../src/rest/context.js";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";
import type { RestActor, RestPlanDraft, RestRpc } from "../src/rest/core.js";
import type { RelayrSponsorshipService } from "../src/rest/sponsorship/index.js";
import { MemoryTransactionStore } from "../src/rest/transactions/memory.js";
import { TransactionService } from "../src/rest/transactions/service.js";

// Public fixture keys. Service boundaries are local stubs; no relay or network is contacted.
const owner = privateKeyToAccount(`0x${"19".repeat(32)}`);
const bot = privateKeyToAccount(`0x${"29".repeat(32)}`);
const outsider = privateKeyToAccount(`0x${"39".repeat(32)}`);
const audience = "https://api.signa.center";
const now = 1_900_000_000;
const accountId = accountIdFor(owner.address, 1);
const ownerActor: RestActor = { accountId, principalId: `owner:${accountId}` };
const target = "0x1111111111111111111111111111111111111111" as Address;
const blockHash = `0x${"ab".repeat(32)}` as Hex;

async function fixture() {
  const accounts = new MemoryAccountStore();
  const auth = createRestAuth({ store: accounts, audience, now: () => now });
  const transactionStore = new MemoryTransactionStore(accounts);
  const rpcRequest = vi.fn<RestRpc["request"]>(async (_chain, method) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") {
      return {
        hash: blockHash,
        number: "0x64",
        timestamp: `0x${now.toString(16)}`,
        baseFeePerGas: "0x1",
      };
    }
    throw new Error("Unexpected fake RPC; test dispatch is forbidden");
  });
  const rpc: RestRpc = { request: rpcRequest };
  const transactions = new TransactionService({
    store: transactionStore,
    rpc,
    now: () => now * 1000,
  });
  const draft: RestPlanDraft = {
    account: owner.address,
    operation: "relayr_bundle_funding",
    calls: [
      {
        chainId: 1,
        to: target,
        data: "0x12345678",
        value: "7",
        label: "Reviewed funding fixture",
        dependsOn: [],
        decoded: { bundleUuid: "reviewed-bundle" },
      },
    ],
    evidence: [
      {
        chainId: 1,
        blockNumber: "100",
        blockHash,
        timestamp: String(now),
        source: "onchain",
      },
    ],
    summary: { economicCompletion: false },
    warnings: [],
  };
  const prepare = vi.fn(
    async (
      _actor: RestActor,
      planId: string,
      _input: unknown,
      _key: string,
      _request: { signal?: AbortSignal },
    ) => ({ id: "sponsorship", planId, state: "prepared" }),
  );
  const get = vi.fn(async (_actor: RestActor, id: string) => ({
    id,
    state: "prepared",
  }));
  const refresh = vi.fn(
    async (
      _actor: RestActor,
      id: string,
      _request: { signal?: AbortSignal },
    ) => ({
      id,
      state: "prepared",
    }),
  );
  const submit = vi.fn(
    async (
      _actor: RestActor,
      id: string,
      _input: { signatures: Hex[] },
      _key: string,
      _request: { signal?: AbortSignal },
    ) => ({ id, state: "submitting" }),
  );
  const prepareFunding = vi.fn(
    async (
      _actor: RestActor,
      _id: string,
      _input: { chainId: number; payer: Address },
      _request: { signal?: AbortSignal },
    ): Promise<RestPlanDraft> => structuredClone(draft),
  );
  // Deliberately stub the sponsorship boundary: its cryptographic/provider behavior has separate tests.
  const sponsorship = {
    capabilities: () => ({ enabled: true }),
    prepare,
    get,
    refresh,
    submit,
    prepareFunding,
  } as unknown as RelayrSponsorshipService;
  const operations: ProtocolOperations = {
    list: () => [],
    prepare: async () => {
      throw new Error("Unexpected operation preparation");
    },
  };
  const quotas = new Map<string, number>();
  const store: Store = {
    health: async () => {},
    consumeRequest: async (key, limit) => {
      const count = (quotas.get(key) ?? 0) + 1;
      quotas.set(key, count);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
    },
    cleanupRateLimits: async () => 0,

  };
  const contracts = await getContractCatalog();
  const rest = createRestApp({
    auth,
    quota: store,
    contracts,
    operations,
    transactions,
    sponsorship,
  });
  const api = new Hono<JbcenterEnv>();
  mountRestSite(api, {
    app: rest,
    audience,
    accountsScript: "",
    docsHtml: "",
    docsCss: "",
    documents: new Map(),
  });
  const app = createSignaApp({
    apiAudience: audience,
    walletOrigin: "https://signa.center",
    currentRuntime: () => ({ api, wallet: new Hono(), ready: store.health }),
  });
  const ownerConfig: ClientOptions = {
    audience,
    accountId,
    signer: owner,
    now: () => now,
  };
  const sendPrepared = (
    request: PreparedRequest,
    signal?: AbortSignal,
    body = request.body,
  ) =>
    app.request(request.url, {
      method: request.method,
      headers: request.headers,
      ...(body.length ? { body: body as BodyInit } : {}),
      ...(signal ? { signal } : {}),
    });
  const send = async (
    options: RequestOptions,
    config = ownerConfig,
    signal?: AbortSignal,
  ) => sendPrepared(await prepareSignedRequest(config, options), signal);
  expect(
    (
      await send({
        method: "POST",
        requestTarget: "/api/v1/accounts/enroll",
        json: {},
      })
    ).status,
  ).toBe(200);
  const register = async (scopes: BotScope[]) => {
    const proof = await createBotRegistration(
      audience,
      {
        accountId,
        botAddress: bot.address,
        scopes,
        label: "Runtime boundary fixture",
        expiresAt: now + 3600,
        ownerRequestNonce: newRequestNonce(),
      },
      bot,
    );
    const response = await send({
      method: "POST",
      requestTarget: "/api/v1/accounts/me/bots",
      json: proof.registration,
      nonce: proof.ownerRequestNonce,
    });
    expect(response.status).toBe(201);
    const grant = ((await response.json()) as { bot: BotGrant }).bot;
    return {
      grant,
      actor: { accountId, principalId: `bot:${grant.id}` },
      config: {
        ...ownerConfig,
        signer: bot,
        grantId: grant.id,
      } satisfies ClientOptions,
    };
  };
  return {
    app,
    send,
    sendPrepared,
    ownerConfig,
    register,
    prepare,
    get,
    refresh,
    submit,
    prepareFunding,
    transactions,
    transactionStore,
    draft,
    rpcRequest,
    quotas,
  };
}

describe("Signa sponsorship REST integration", () => {
  it("serves discovery at the documented mount without a shadowed redirect", async () => {
    const f = await fixture();
    const response = await f.app.request(`${audience}/api/v1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toMatchObject({
      version: "1",
      protocolVersion: 6,
      documentation: "/api",
    });
    expect((await f.app.request(`${audience}/api/v1?unknown=1`)).status).toBe(
      400,
    );
  });
  it("requires signed requests and the specific read, plan, or relay scope before sponsorship work", async () => {
    const f = await fixture();
    const routes = [
      { method: "GET", requestTarget: "/api/v1/sponsorships/one" },
      { method: "GET", requestTarget: "/api/v1/sponsorships/one?refresh=true" },
      {
        method: "POST",
        requestTarget: "/api/v1/sponsorships",
        json: { planId: "one" },
      },
      {
        method: "POST",
        requestTarget: "/api/v1/sponsorships/one/submissions",
        json: { signatures: ["0x11"] },
      },
      {
        method: "POST",
        requestTarget: "/api/v1/sponsorships/one/funding-plans",
        json: { chainId: 1, payer: owner.address },
      },
    ];
    for (const route of routes) {
      const response = await f.app.request(
        `${audience}${route.requestTarget}`,
        {
          method: route.method,
        },
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    }
    const reader = await f.register(["read"]);
    expect((await f.send(routes[0]!, reader.config)).status).toBe(200);
    expect((await f.send(routes[1]!, reader.config)).status).toBe(200);
    expect(f.get.mock.calls[0]?.[0]).toEqual(reader.actor);
    expect(f.refresh.mock.calls[0]?.[0]).toEqual(reader.actor);
    for (const [index, route] of routes.slice(2).entries()) {
      expect(
        (
          await f.send(
            { ...route, idempotencyKey: `denied:${index}` },
            reader.config,
          )
        ).status,
      ).toBe(403);
    }
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.prepareFunding).not.toHaveBeenCalled();
    const planner = await f.register(["read", "plan"]);
    expect(
      (
        await f.send(
          { ...routes[2]!, idempotencyKey: "planner-prepare" },
          planner.config,
        )
      ).status,
    ).toBe(201);
    expect(f.prepare.mock.calls[0]?.[0]).toEqual(planner.actor);
    expect(
      (
        await f.send(
          { ...routes[3]!, idempotencyKey: "planner-submit" },
          planner.config,
        )
      ).status,
    ).toBe(403);
    const executor = await f.register(["read", "plan", "relay"]);
    expect(
      (
        await f.send(
          { ...routes[3]!, idempotencyKey: "executor-submit" },
          executor.config,
        )
      ).status,
    ).toBe(202);
    expect(f.submit.mock.calls[0]?.[0]).toEqual(executor.actor);
    expect(f.rpcRequest).not.toHaveBeenCalled();
  });

  it("requires signed idempotency keys and rejects body fields that bypass the sponsorship schema", async () => {
    const f = await fixture();
    const posts = [
      { requestTarget: "/api/v1/sponsorships", json: { planId: "one" } },
      {
        requestTarget: "/api/v1/sponsorships/one/submissions",
        json: { signatures: ["0x11"] },
      },
      {
        requestTarget: "/api/v1/sponsorships/one/funding-plans",
        json: { chainId: 1, payer: owner.address },
      },
    ];
    for (const [index, post] of posts.entries()) {
      const noKey = await f.send({ ...post, method: "POST" });
      expect(noKey.status).toBe(400);
      expect(await noKey.json()).toMatchObject({
        code: "IDEMPOTENCY_REQUIRED",
      });
      const extra = await f.send({
        ...post,
        method: "POST",
        idempotencyKey: `unexpected:${index}`,
        json: { ...post.json, rawSignedTransaction: "0x11" },
      });
      expect(extra.status).toBe(400);
      expect(await extra.json()).toMatchObject({ code: "UNKNOWN_FIELD" });
    }
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.prepareFunding).not.toHaveBeenCalled();
  });

  it("keeps signed owner approvals and principals isolated across concurrent sponsorship submissions", async () => {
    const f = await fixture();
    const executor = await f.register(["read", "plan", "relay"]);
    const approvals = {
      first: { signature: "owner-approval-a", expiresAt: now + 60 },
      second: { signature: "owner-approval-b", expiresAt: now + 30 },
    };
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: Array<{
      id: string;
      principalId: string | undefined;
      approval: unknown;
      body: unknown;
      input: unknown;
    }> = [];
    f.submit.mockImplementation(async (_actor, id, input) => {
      if (++arrived === 2) release();
      await barrier;
      const context = restRequest();
      observed.push({
        id,
        principalId: context?.authority?.principal.principalId,
        approval: context?.sponsorshipOwnerApproval,
        body: JSON.parse(
          new TextDecoder().decode(context!.authority!.input.body),
        ),
        input,
      });
      return { id, state: "submitting" };
    });
    const [first, second] = await Promise.all([
      f.send({
        method: "POST",
        requestTarget: "/api/v1/sponsorships/first/submissions",
        idempotencyKey: "approval-first",
        json: { signatures: ["0x11"], ownerApproval: approvals.first },
      }),
      f.send(
        {
          method: "POST",
          requestTarget: "/api/v1/sponsorships/second/submissions",
          idempotencyKey: "approval-second",
          json: { signatures: ["0x22"], ownerApproval: approvals.second },
        },
        executor.config,
      ),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(observed).toEqual(
      expect.arrayContaining([
        {
          id: "first",
          principalId: ownerActor.principalId,
          approval: approvals.first,
          body: { signatures: ["0x11"], ownerApproval: approvals.first },
          input: { signatures: ["0x11"] },
        },
        {
          id: "second",
          principalId: executor.actor.principalId,
          approval: approvals.second,
          body: { signatures: ["0x22"], ownerApproval: approvals.second },
          input: { signatures: ["0x22"] },
        },
      ]),
    );
    expect(await first.text()).not.toContain("owner-approval");
    expect(await second.text()).not.toContain("owner-approval");
    expect(
      (
        await f.send({
          method: "POST",
          requestTarget: "/api/v1/sponsorships/third/submissions",
          idempotencyKey: "approval-absent",
          json: { signatures: ["0x33"] },
        })
      ).status,
    ).toBe(202);
    expect(observed.at(-1)?.approval).toBeUndefined();
    expect(restRequest()).toBeUndefined();
  });

  it("authenticates the exact ownerApproval body before passing it to dispatch authorization", async () => {
    const f = await fixture();
    const options = {
      method: "POST",
      requestTarget: "/api/v1/sponsorships/one/submissions",
      idempotencyKey: "signed-approval",
      json: { signatures: ["0x11"], ownerApproval: { signature: "original" } },
    };
    const prepared = await prepareSignedRequest(f.ownerConfig, options);
    const tampered = new TextEncoder().encode(
      JSON.stringify({
        ...options.json,
        ownerApproval: { signature: "replacement" },
      }),
    );
    const denied = await f.sendPrepared(prepared, undefined, tampered);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "INVALID_SIGNATURE" });
    expect(f.submit).not.toHaveBeenCalled();
    expect((await f.sendPrepared(prepared)).status).toBe(202);
  });

  it("requires the authenticated owner wallet as payer even when a bot prepares funding", async () => {
    const f = await fixture();
    const planner = await f.register(["read", "plan"]);
    for (const payer of [bot.address, outsider.address]) {
      const denied = await f.send(
        {
          method: "POST",
          requestTarget: "/api/v1/sponsorships/one/funding-plans",
          idempotencyKey: `wrong-payer:${payer}`,
          json: { chainId: 1, payer },
        },
        planner.config,
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        code: "FUNDING_PAYER_MISMATCH",
      });
    }
    expect(f.prepareFunding).not.toHaveBeenCalled();
    expect(f.rpcRequest).not.toHaveBeenCalled();
    const funded = await f.send(
      {
        method: "POST",
        requestTarget: "/api/v1/sponsorships/one/funding-plans",
        idempotencyKey: "owner-funding",
        json: { chainId: 1, payer: owner.address.toLowerCase() },
      },
      planner.config,
    );
    expect(funded.status).toBe(201);
    const dto = (await funded.json()) as { id: string; account: string };
    expect(dto.account.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(f.prepareFunding.mock.calls[0]?.slice(0, 3)).toEqual([
      planner.actor,
      "one",
      { chainId: 1, payer: owner.address.toLowerCase() },
    ]);
    expect(
      (await f.transactionStore.get(planner.actor, dto.id))?.actor,
    ).toEqual(planner.actor);
    expect(
      f.rpcRequest.mock.calls.every(
        (call) => call[1] !== "eth_sendRawTransaction",
      ),
    ).toBe(true);
  });

  it("returns an idempotent funding plan before rechecking an unavailable quote and rejects changed funding intent", async () => {
    const f = await fixture();
    const options = {
      method: "POST",
      requestTarget: "/api/v1/sponsorships/one/funding-plans",
      idempotencyKey: "fund-once",
      json: { chainId: 1, payer: owner.address },
    };
    const original = await f.send(options);
    expect(original.status).toBe(201);
    const originalDto = await original.json();
    f.prepareFunding.mockRejectedValue(
      new Error("private provider https://relay.example/credential-secret"),
    );
    f.rpcRequest.mockRejectedValue(new Error("private RPC credential-secret"));
    const repeated = await f.send(options);
    expect(repeated.status).toBe(201);
    expect(await repeated.json()).toEqual(originalDto);
    expect(f.prepareFunding).toHaveBeenCalledOnce();
    for (const changed of [
      { ...options, json: { ...options.json, chainId: 10 } },
      { ...options, requestTarget: "/api/v1/sponsorships/two/funding-plans" },
    ]) {
      const conflict = await f.send(changed);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        code: "TRANSACTION_CONFLICT",
      });
    }
    expect(f.prepareFunding).toHaveBeenCalledOnce();
  });

  it.each(["prepare", "refresh", "submit", "funding"] as const)(
    "propagates client cancellation to sponsorship %s",
    async (operation) => {
      const f = await fixture();
      const controller = new AbortController();
      let entered!: () => void;
      const active = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const block = async (signal: AbortSignal | undefined): Promise<never> => {
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(restRequest()?.signal).toBe(signal);
        entered();
        return new Promise((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          });
        });
      };
      f.prepare.mockImplementation(async (_actor, _id, _input, _key, request) =>
        block(request.signal),
      );
      f.refresh.mockImplementation(async (_actor, _id, request) =>
        block(request.signal),
      );
      f.submit.mockImplementation(async (_actor, _id, _input, _key, request) =>
        block(request.signal),
      );
      f.prepareFunding.mockImplementation(
        async (_actor, _id, _input, request) => block(request.signal),
      );
      const requests: Record<typeof operation, RequestOptions> = {
        prepare: {
          method: "POST",
          requestTarget: "/api/v1/sponsorships",
          json: { planId: "one" },
          idempotencyKey: "cancel-prepare",
        },
        refresh: { requestTarget: "/api/v1/sponsorships/one?refresh=true" },
        submit: {
          method: "POST",
          requestTarget: "/api/v1/sponsorships/one/submissions",
          json: { signatures: ["0x11"] },
          idempotencyKey: "cancel-submit",
        },
        funding: {
          method: "POST",
          requestTarget: "/api/v1/sponsorships/one/funding-plans",
          json: { chainId: 1, payer: owner.address },
          idempotencyKey: "cancel-funding",
        },
      };
      const pending = f.send(
        requests[operation],
        f.ownerConfig,
        controller.signal,
      );
      await active;
      controller.abort();
      const result = await pending;
      expect(result.status).toBe(504);
      expect(await result.json()).toMatchObject({ code: "REQUEST_TIMEOUT" });
      expect(f.rpcRequest).not.toHaveBeenCalled();
      expect(
        (await f.transactionStore.list(ownerActor, { limit: 10 })).items,
      ).toHaveLength(0);
    },
  );

  it("does not serve Center intent, pinning or public RPC routes", async () => {
    const f = await fixture();
    expect(
      (await f.send({ requestTarget: "/api/v1/sponsorships/one" })).status,
    ).toBe(200);
    for (const [path, method] of [
      ["/v1/intents/one", "GET"],
      ["/v1/pins/json", "POST"],
      ["/v1/rpc/1", "POST"],
    ] as const) {
      expect((await f.app.request(`${audience}${path}`, { method })).status).toBe(404);
    }
    expect(f.rpcRequest).not.toHaveBeenCalled();
  });
});
