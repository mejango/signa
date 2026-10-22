import { CENTER_DEPLOY_REFUSALS, CenterClient } from "@juicebox/mcp/host";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  createCenterFetcher,
  createCenterMcp,
  createCenterPinJson,
  createCenterPinLogo,
  createCenterReadFetcher,
  createCenterRpcFetcher,
  MCP_BACKEND_LIMITS,
} from "../src/mcp.js";
import { createApp } from "../src/app.js";
import { originsForEnvironment } from "../src/firstParty.js";
import { contentHash, signingMessage } from "../src/intent.js";
import { readSponsorPolicy } from "../src/sponsor/policy.js";
import { MemoryStore } from "./support/memoryStore.js";
import { createRpcGateway, type RpcGateway } from "../src/rpc.js";
import type { PinningService } from "../src/ipfs.js";
import type { Store } from "../src/store.js";
import type { Intent, IntentEnvelope } from "../src/types.js";

const ORIGIN = "https://juicebox.center";
const CID = "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR";
const INTENT_ID = "a7396c7e-b13f-4ca8-9f06-96f36ab22c3a";
const REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "eth_chainId",
  params: [],
} as const;
const RPC_URLS = { 1: `${ORIGIN}/v1/rpc/1` };

const INTENT_FIXTURE = {
  id: INTENT_ID,
  status: "undeployed",
  contentHash: contentHash({
    format: "juicebox.money/v1",
    deploymentVersion: "6",
    chainIds: [84532],
    deploymentCalls: [
      { chainId: 84532, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
    ],
    jb: { v: 1, name: "Bridged", chains: [84532] },
  } as IntentEnvelope),
  envelope: {
    format: "juicebox.money/v1",
    deploymentVersion: "6",
    chainIds: [84532],
    deploymentCalls: [
      { chainId: 84532, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
    ],
    jb: { v: 1, name: "Bridged", chains: [84532] },
  },
  name: "Bridged",
  description: null,
  tagline: null,
  tags: [],
  logoUri: null,
  owner: null,
  createdAt: "2026-09-21T00:00:00.000Z",
  deployments: [],
  deploys: [],
} as const;

function storeMock() {
  const counts = new Map<string, number>();
  return {
    counts,
    health: vi.fn(async () => {}),
    consumeRequest: vi.fn(async (key: string, limit: number, _window = 60) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
    }),
    search: vi
      .fn<Store["search"]>()
      .mockResolvedValue({ items: [], totalCount: 0, nextCursor: null }),
    getIntent: vi.fn<Store["getIntent"]>().mockResolvedValue(null),
    createIntent: vi.fn<Store["createIntent"]>(),
    recordDeployment: vi.fn<Store["recordDeployment"]>(),
    cleanupRateLimits: vi.fn<Store["cleanupRateLimits"]>().mockResolvedValue(0),
    queueDeploys: vi.fn<Store["queueDeploys"]>(),
    listDeploys: vi.fn<Store["listDeploys"]>(),
    claimQueuedDeploys: vi.fn<Store["claimQueuedDeploys"]>(),
    updateDeploy: vi.fn<Store["updateDeploy"]>(),
    releaseClaim: vi.fn<Store["releaseClaim"]>(),
    sponsoredWeiSince: vi.fn<Store["sponsoredWeiSince"]>(),
  } satisfies Store & { counts: Map<string, number> };
}

function rpcMock() {
  return {
    supports: vi.fn(() => true),
    request: vi
      .fn<RpcGateway["request"]>()
      .mockResolvedValue({ jsonrpc: "2.0", id: 1, result: "0x1" }),
  };
}

function pinningMock() {
  return {
    pin: vi
      .fn<PinningService["pin"]>()
      .mockResolvedValue({ cid: CID, status: "queued" }),
    pinStream: vi.fn<PinningService["pinStream"]>(),
  };
}

describe("co-hosted MCP configuration", () => {
  it("uses Center-local backends without fabricating an approved browser Origin", async () => {
    const store = storeMock();
    const rpc = rpcMock();
    const { config, services } = createCenterMcp(store, {
      rpc,
      env: {
        NODE_ENV: "production",
        MCP_PLAN_SECRET: "mcp-secret-for-tests-with-32-bytes",
      },
    });
    expect(config.publicOrigin).toBe(ORIGIN);
    expect(config.centerOrigin).toBeUndefined();
    expect(config.allowedOrigins).toContain(ORIGIN);
    expect(config.allowedOrigins).toContain("https://juicebox.money");
    expect(config.allowedOrigins).toContain("https://homerun.money");
    expect(config.rpcUrls[8453]).toBe(`${ORIGIN}/v1/rpc/8453`);
    await expect(services.center.search({ query: "example" })).resolves.toEqual(
      { items: [], totalCount: 0, nextCursor: null },
    );
    expect(store.search).toHaveBeenCalledWith("example", 20, 0, {});
    await expect(services.rpc.client(1).getChainId()).resolves.toBe(1);
    expect(rpc.request).toHaveBeenCalledOnce();
  });

  it("requires the MCP's own stable production secret and explicit namespaced endpoints", () => {
    const rpc = rpcMock();
    expect(() =>
      createCenterMcp(storeMock(), {
        rpc,
        env: {
          NODE_ENV: "production",
          PLAN_SECRET: "a-host-secret-must-not-be-inherited",
        },
      }),
    ).toThrow(/PLAN_SECRET/u);
    const { config } = createCenterMcp(storeMock(), {
      rpc,
      env: {
        NODE_ENV: "production",
        RAILWAY_ENVIRONMENT_NAME: "dev",
        MCP_PLAN_SECRET: "mcp-secret-for-tests-with-32-bytes",
        MCP_PUBLIC_ORIGIN: "https://dev.juicebox.center",
        MCP_BENDYSTRAW_MAINNET_URL: "https://indexer.example/mainnet",
        MCP_BENDYSTRAW_TESTNET_URL: "https://indexer.example/testnet",
        BENDYSTRAW_MAINNET_URL: "https://unrelated.example",
        MCP_ALLOWED_HOSTS: "internal.example",
      },
    });
    expect(config.publicOrigin).toBe("https://dev.juicebox.center");
    expect(config.allowedOrigins).toContain("https://dev.juicebox.money");
    expect(config.allowedOrigins).not.toContain("https://juicebox.money");
    expect(config.allowedHosts).toContain("internal.example");
    expect(config.bendystrawMainnetUrl).toBe("https://indexer.example/mainnet");
    expect(config.bendystrawTestnetUrl).toBe("https://indexer.example/testnet");
  });
});

describe("Center database read bridge", () => {
  it("preserves pagination and read results without invoking a write", async () => {
    const store = storeMock();
    const fetcher = createCenterReadFetcher(store, ORIGIN);
    await expect(
      fetcher(`${ORIGIN}/v1/search?q=+Public+goods+&limit=3&cursor=21`),
    ).resolves.toEqual({ items: [], totalCount: 0, nextCursor: null });
    expect(store.search).toHaveBeenCalledWith("Public goods", 3, 21, {});
    expect(store.consumeRequest).toHaveBeenCalledWith(
      "center:mcp:reads",
      600,
      60,
    );
    expect(store.createIntent).not.toHaveBeenCalled();
    expect(store.recordDeployment).not.toHaveBeenCalled();
  });

  it.each([
    ["https://untrusted.example/v1/search", {}],
    [`${ORIGIN}/v1/pins/json`, {}],
    [`${ORIGIN}/v1/intents/${INTENT_ID}/deployments`, {}],
    [`${ORIGIN}/v1/intents/%2f${INTENT_ID}`, {}],
    [`${ORIGIN}/v1/search#fragment`, {}],
    [`https://secret@juicebox.center/v1/search`, {}],
    [`${ORIGIN}/v1/search`, { method: "POST", body: {} }],
    [`${ORIGIN}/v1/search`, { method: "GET", body: {} }],
    [`${ORIGIN}/v1/search?limit=101`, {}],
    [`${ORIGIN}/v1/search?cursor=9007199254740992`, {}],
    [`${ORIGIN}/v1/search?q=a&q=b`, {}],
    [`${ORIGIN}/v1/search?externalUrl=https://untrusted.example`, {}],
    [`${ORIGIN}/v1/search?q=${"a".repeat(201)}`, {}],
  ])(
    "rejects route escapes and malformed parameters %#",
    async (url, options) => {
      const store = storeMock();
      await expect(
        createCenterReadFetcher(store, ORIGIN)(url, options),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(store.consumeRequest).not.toHaveBeenCalled();
      expect(store.search).not.toHaveBeenCalled();
      expect(store.getIntent).not.toHaveBeenCalled();
    },
  );

  it("retains CenterClient's real signed-envelope verification", async () => {
    const store = storeMock();
    const account = privateKeyToAccount(`0x${"12".repeat(32)}`);
    const envelope: IntentEnvelope = {
      format: "juicebox/project-v1",
      deploymentVersion: "6",
      chainIds: [1],
      deploymentCalls: [
        { chainId: 1, to: account.address, data: "0x12345678" },
      ],
      jb: { name: "Review fixture", chainIds: [1] },
    };
    const hash = contentHash(envelope);
    const intent: Intent = {
      id: INTENT_ID,
      status: "undeployed",
      envelope,
      contentHash: hash,
      publisher: account.address,
      signature: await account.signMessage({ message: signingMessage(hash) }),
      createdAt: "2026-09-06T00:00:00.000Z",
      name: "Review fixture",
      description: null,
      tagline: null,
      tags: [],
      logoUri: null,
      owner: null,
      deployments: [],
      deploys: [],
    };
    store.getIntent.mockResolvedValue(intent);
    const center = new CenterClient({
      baseUrl: ORIGIN,
      fetchJson: createCenterReadFetcher(store, ORIGIN),
    });
    await expect(center.getIntent(INTENT_ID)).resolves.toEqual(intent);
    store.getIntent.mockResolvedValue({
      ...intent,
      envelope: { ...envelope, jb: { name: "Tampered" } },
    });
    await expect(center.getIntent(INTENT_ID)).rejects.toMatchObject({
      code: "UPSTREAM_INVALID_RESPONSE",
    });
  });

  it("bounds database reads and response bytes and suppresses database details", async () => {
    const store = storeMock();
    const fetcher = createCenterReadFetcher(store, ORIGIN);
    store.counts.set("center:mcp:reads", MCP_BACKEND_LIMITS.readsPerMinute);
    await expect(fetcher(`${ORIGIN}/v1/search`)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(store.search).not.toHaveBeenCalled();
    store.counts.clear();
    await expect(
      fetcher(`${ORIGIN}/v1/search`, { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: "UPSTREAM_RESPONSE_TOO_LARGE" });
    store.search.mockRejectedValue(
      new Error("postgres://secret:credential@database.example"),
    );
    await expect(fetcher(`${ORIGIN}/v1/search`)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      message: "The configured backend could not complete the operation.",
    });
    await expect(
      fetcher(`${ORIGIN}/v1/intents/${INTENT_ID}`),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cancels while waiting for a database quota without starting a read", async () => {
    const store = storeMock();
    let finish!: (value: { allowed: boolean; remaining: number }) => void;
    store.consumeRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const work = createCenterReadFetcher(store, ORIGIN)(`${ORIGIN}/v1/search`, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(store.consumeRequest).toHaveBeenCalledOnce());
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    finish({ allowed: true, remaining: 1 });
    await Promise.resolve();
    expect(store.search).not.toHaveBeenCalled();
  });
});

describe("shared read-only RPC bridge", () => {
  it("honors the host's lower shared RPC quota", async () => {
    const store = storeMock();
    const rpc = rpcMock();
    store.counts.set("rpc:site", 10);
    const { services } = createCenterMcp(store, {
      rpc,
      rpcSiteLimitPerMinute: 10,
      env: {},
    });
    await expect(services.rpc.client(1).getChainId()).rejects.toThrow(
      "shared MCP backend budget",
    );
    expect(store.consumeRequest).toHaveBeenCalledWith("rpc:site", 10, 60);
    expect(rpc.request).not.toHaveBeenCalled();
  });

  it("uses the gateway's fallback and both MCP and shared site quotas", async () => {
    const store = storeMock();
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }),
      );
    const rpc = createRpcGateway(
      new Map([
        [1, ["https://primary.example/secret", "https://fallback.example"]],
      ]),
      upstream,
    );
    const fetcher = createCenterRpcFetcher(store, rpc, RPC_URLS);
    await expect(
      fetcher(RPC_URLS[1], { method: "POST", body: REQUEST }),
    ).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(store.consumeRequest.mock.calls).toEqual([
      ["rpc:mcp", 5000, 60],
      ["rpc:site", 20000, 60],
    ]);
  });

  it.each([
    ["https://evil.example/v1/rpc/1", REQUEST],
    [`${ORIGIN}/v1/rpc/2`, REQUEST],
    [`${ORIGIN}/v1/rpc/1?route=other`, REQUEST],
    [`${ORIGIN}/v1/rpc/1`, { ...REQUEST, method: "eth_sendRawTransaction" }],
    [`${ORIGIN}/v1/rpc/1`, [REQUEST]],
    [`${ORIGIN}/v1/rpc/1`, { ...REQUEST, method: "eth_getLogs", params: [{}] }],
    [`${ORIGIN}/v1/rpc/1`, "{"],
  ])(
    "rejects unconfigured routes and non-read RPC before quotas %#",
    async (url, body) => {
      const store = storeMock();
      const rpc = rpcMock();
      await expect(
        createCenterRpcFetcher(store, rpc, RPC_URLS)(url, { body }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(store.consumeRequest).not.toHaveBeenCalled();
      expect(rpc.request).not.toHaveBeenCalled();
    },
  );

  it.each(["rpc:mcp", "rpc:site"])(
    "enforces the %s quota before contacting providers",
    async (key) => {
      const store = storeMock();
      const rpc = rpcMock();
      store.counts.set(key, key === "rpc:mcp" ? 5000 : 20000);
      await expect(
        createCenterRpcFetcher(
          store,
          rpc,
          RPC_URLS,
        )(RPC_URLS[1], { body: REQUEST }),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      expect(rpc.request).not.toHaveBeenCalled();
    },
  );

  it("passes cancellation through to the gateway and does not expose provider failures", async () => {
    const store = storeMock();
    const rpc = rpcMock();
    const controller = new AbortController();
    rpc.request.mockImplementation(
      async (_chain, _request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("https://upstream.example/secret")),
            { once: true },
          );
        }),
    );
    const work = createCenterRpcFetcher(
      store,
      rpc,
      RPC_URLS,
    )(RPC_URLS[1], { body: REQUEST, signal: controller.signal });
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledOnce());
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(rpc.request.mock.calls[0]?.[2]?.aborted).toBe(true);
    rpc.request.mockRejectedValue(new Error("https://upstream.example/secret"));
    await expect(
      createCenterRpcFetcher(
        store,
        rpc,
        RPC_URLS,
      )(RPC_URLS[1], { body: REQUEST }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      message: "The configured backend could not complete the operation.",
    });
  });

  it("caps response bytes even for an injected gateway", async () => {
    const rpc = rpcMock();
    rpc.request.mockResolvedValue({ result: "x".repeat(200) });
    await expect(
      createCenterRpcFetcher(
        storeMock(),
        rpc,
        RPC_URLS,
      )(RPC_URLS[1], { body: REQUEST, maxBytes: 100 }),
    ).rejects.toMatchObject({ code: "UPSTREAM_RESPONSE_TOO_LARGE" });
  });
});

describe("reviewed JSON pinning bridge", () => {
  it("pins a sniffed logo under the same anonymous MCP quotas", async () => {
    const store = storeMock();
    const pinning = pinningMock();
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await expect(
      createCenterPinLogo(
        store,
        pinning,
      )({ bytes, contentType: "image/png", filename: "logo.png" }),
    ).resolves.toEqual({ cid: CID, status: "queued" });
    const [blob, filename] = pinning.pin.mock.calls[0]!;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(blob.type).toBe("image/png");
    expect(filename).toBe("logo.png");
    expect(store.consumeRequest.mock.calls).toEqual([
      ["pin:mcp", 10, 600],
      ["pin:site", 200, 600],
    ]);
    await expect(
      createCenterPinLogo(
        store,
        pinning,
      )({
        bytes: new Uint8Array(1024 * 1024 + 1),
        contentType: "image/png",
        filename: "logo.png",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(pinning.pin).toHaveBeenCalledOnce();
  });

  it("pins exactly the reviewed UTF-8 JSON as metadata.json under both quotas", async () => {
    const store = storeMock();
    const pinning = pinningMock();
    const jsonText = '{"description":"Public goods 🌱","name":"Example"}';
    await expect(
      createCenterPinJson(store, pinning)(jsonText),
    ).resolves.toEqual({ cid: CID, status: "queued" });
    const [blob, filename, signal] = pinning.pin.mock.calls[0]!;
    expect(await blob.text()).toBe(jsonText);
    expect(blob.type).toBe("application/json");
    expect(filename).toBe("metadata.json");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(store.consumeRequest.mock.calls).toEqual([
      ["pin:mcp", 10, 600],
      ["pin:site", 200, 600],
    ]);
    expect(pinning.pinStream).not.toHaveBeenCalled();
  });

  it.each(["pin:mcp", "pin:site"])(
    "enforces the %s quota before uploading",
    async (key) => {
      const store = storeMock();
      const pinning = pinningMock();
      store.counts.set(key, key === "pin:mcp" ? 10 : 200);
      await expect(
        createCenterPinJson(store, pinning)("{}"),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      expect(pinning.pin).not.toHaveBeenCalled();
    },
  );

  it.each([
    "{",
    "[]",
    "null",
    JSON.stringify({ description: "x".repeat(64 * 1024) }),
  ])(
    "rejects invalid or oversized document %# before quotas",
    async (jsonText) => {
      const store = storeMock();
      const pinning = pinningMock();
      await expect(
        createCenterPinJson(store, pinning)(jsonText),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(store.consumeRequest).not.toHaveBeenCalled();
      expect(pinning.pin).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid provider results and sanitizes provider failures", async () => {
    const pinning = pinningMock();
    pinning.pin.mockResolvedValue({ cid: "not-a-cid", status: "queued" });
    await expect(
      createCenterPinJson(storeMock(), pinning)("{}"),
    ).rejects.toMatchObject({ code: "UPSTREAM_INVALID_RESPONSE" });
    pinning.pin.mockRejectedValue(new Error("pinata-secret-token"));
    await expect(
      createCenterPinJson(storeMock(), pinning)("{}"),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      message: "The configured backend could not complete the operation.",
    });
  });

  it("propagates cancellation to a pending provider upload", async () => {
    const pinning = pinningMock();
    const controller = new AbortController();
    pinning.pin.mockImplementation(
      (_blob, _filename, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const work = createCenterPinJson(storeMock(), pinning)(
      "{}",
      controller.signal,
    );
    await vi.waitFor(() => expect(pinning.pin).toHaveBeenCalledOnce());
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(pinning.pin.mock.calls[0]?.[2]?.aborted).toBe(true);
  });
});

describe("Center intent write bridge", () => {
  const envelope: IntentEnvelope = {
    format: "juicebox.money/v1",
    deploymentVersion: "6",
    chainIds: [84532],
    deploymentCalls: [
      { chainId: 84532, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
    ],
    jb: { v: 1, name: "Bridged", chains: [84532] },
  };

  it("publishes and requests a deploy through the app on the in-process marker", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const signature = await account.signMessage({
      message: signingMessage(contentHash(envelope)),
    });
    const seen: { origin: string | null; method: string; path: string }[] = [];
    const store = storeMock();
    const centerFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      seen.push({
        origin: request.headers.get("origin"),
        method: request.method,
        path: url.pathname,
      });
      if (url.pathname === "/v1/intents")
        return Response.json({ ...INTENT_FIXTURE, publisher: account.address, signature }, { status: 201 });
      return Response.json(
        {
          deploys: [
            {
              chainId: 84532,
              status: "queued",
              transactionHash: null,
              bundleUuid: null,
              error: null,
              createdAt: "2026-09-21T00:00:00.000Z",
              updatedAt: "2026-09-21T00:00:00.000Z",
            },
          ],
        },
        { status: 202 },
      );
    });
    const { services } = createCenterMcp(store, {
      rpc: rpcMock(),
      centerFetch,
      env: { NODE_ENV: "production", MCP_PLAN_SECRET: "mcp-secret-for-tests-with-32-bytes" },
    });

    const published = await services.center.publishIntent({
      ...envelope,
      publisher: account.address,
      signature,
    });
    expect(published.id).toBe(INTENT_ID);
    const deploys = await services.center.requestDeploy(INTENT_ID);
    expect(deploys.deploys[0]?.status).toBe("queued");
    // No browser Origin is fabricated; the app admits the call on its in-process marker instead.
    expect(seen).toEqual([
      { origin: null, method: "POST", path: "/v1/intents" },
      { origin: null, method: "POST", path: `/v1/intents/${INTENT_ID}/deploy` },
    ]);
  });

  it("refuses to publish a signature that does not match the envelope", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const signature = await account.signMessage({ message: "a different message" });
    const centerFetch = vi.fn(async () => Response.json({}, { status: 201 }));
    const { services } = createCenterMcp(storeMock(), {
      rpc: rpcMock(),
      centerFetch,
      env: { NODE_ENV: "production", MCP_PLAN_SECRET: "mcp-secret-for-tests-with-32-bytes" },
    });
    await expect(
      services.center.publishIntent({ ...envelope, publisher: account.address, signature }),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    expect(centerFetch).not.toHaveBeenCalled();
  });

  it("maps Center's sponsored-deploy refusals to fixed sentences", async () => {
    for (const [status, code, expected] of [
      [429, "sponsor_quota", "SPONSOR_QUOTA"],
      [429, "sponsor_budget", "SPONSOR_BUDGET"],
      [429, "rate_limit", "RATE_LIMITED"],
      [503, "unavailable", "SPONSOR_UNAVAILABLE"],
      [400, "bad_request", "NOT_SPONSORABLE"],
      [404, "not_found", "NOT_FOUND"],
    ] as const) {
      const { services } = createCenterMcp(storeMock(), {
        rpc: rpcMock(),
        centerFetch: async () =>
          Response.json(
            { error: { code, message: "upstream prose at https://secret.example/key" } },
            { status },
          ),
        env: { NODE_ENV: "production", MCP_PLAN_SECRET: "mcp-secret-for-tests-with-32-bytes" },
      });
      const failure = await services.center.requestDeploy(INTENT_ID).catch((error) => error);
      expect(failure.code).toBe(expected);
      if (expected !== "NOT_FOUND")
        expect(failure.message).toBe(
          CENTER_DEPLOY_REFUSALS[expected as keyof typeof CENTER_DEPLOY_REFUSALS],
        );
      expect(failure.message).not.toContain("upstream prose");
      expect(failure.message).not.toContain("secret.example");
    }
  });

  it("carries a publish far larger than a quarter megabyte through the bridge", async () => {
    const large: IntentEnvelope = {
      ...envelope,
      jb: { ...envelope.jb, notes: "x".repeat(600 * 1024) },
    };
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const hash = contentHash(large);
    const signature = await account.signMessage({ message: signingMessage(hash) });
    const { services } = createCenterMcp(storeMock(), {
      rpc: rpcMock(),
      centerFetch: async () =>
        Response.json(
          {
            ...INTENT_FIXTURE,
            contentHash: hash,
            envelope: large,
            publisher: account.address,
            signature,
          },
          { status: 201 },
        ),
      env: { NODE_ENV: "production", MCP_PLAN_SECRET: "mcp-secret-for-tests-with-32-bytes" },
    });
    const published = await services.center.publishIntent({
      ...large,
      publisher: account.address,
      signature,
    });
    expect(published.contentHash).toBe(hash);
    expect(JSON.stringify(published).length).toBeGreaterThan(600 * 1024);
  });

  it("rejects any write route other than the two intent writes", async () => {
    const centerFetch = vi.fn(async () => Response.json({}, { status: 200 }));
    const fetcher = createCenterFetcher(storeMock(), ORIGIN, { centerFetch });
    for (const path of ["v1/pins/json", "v1/intents/not-a-uuid/deploy", `v1/intents/${INTENT_ID}`]) {
      await expect(fetcher(`${ORIGIN}/${path}`, { method: "POST", body: {} })).rejects.toBeInstanceOf(
        Error,
      );
    }
    expect(centerFetch).not.toHaveBeenCalled();
  });
});

describe("Center intent writes through the real app", () => {
  const envelope: IntentEnvelope = {
    format: "juicebox.money/v1",
    deploymentVersion: "6",
    chainIds: [84532],
    deploymentCalls: [
      { chainId: 84532, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
    ],
    jb: { v: 1, name: "In process", chains: [84532] },
  };

  function bridged(store: MemoryStore, options: { paused?: boolean; publishPerIpPerHour?: number } = {}) {
    const sponsor = { policy: { ...readSponsorPolicy({}), paused: options.paused ?? false }, kick: vi.fn() };
    const app = createApp(store, {
      sponsor,
      allowedOrigins: originsForEnvironment("production"),
      ...(options.publishPerIpPerHour === undefined
        ? {}
        : { publishPerIpPerHour: options.publishPerIpPerHour }),
    });
    const { services } = createCenterMcp(store, {
      rpc: rpcMock(),
      centerFetch: (request) => app.fetch(request, { internal: "mcp" }),
      env: { NODE_ENV: "production", MCP_PLAN_SECRET: "mcp-secret-for-tests-with-32-bytes" },
    });
    return { app, sponsor, center: services.center };
  }

  async function signed(key = "22") {
    const account = privateKeyToAccount(`0x${key.repeat(32)}`);
    return {
      publisher: account.address,
      signature: await account.signMessage({
        message: signingMessage(contentHash(envelope)),
      }),
    };
  }

  it("publishes and queues a sponsored deploy against the real routes", async () => {
    const store = new MemoryStore();
    const { center, sponsor } = bridged(store);
    const published = await center.publishIntent({ ...envelope, ...(await signed()) });
    expect(published.contentHash).toBe(contentHash(envelope));
    // The publisher gets its own hourly key, but the storage identity stays shared.
    const stored = store.intents[0]! as Intent & { submittedBy?: string };
    expect(stored.submittedBy).toBe("mcp");
    expect([...store.requests.keys()]).toEqual(
      expect.arrayContaining([`publish:mcp:${published.publisher.toLowerCase()}`, "publish:mcp"]),
    );
    const queued = await center.requestDeploy(published.id);
    expect(queued.deploys.map((deploy) => deploy.chainId)).toEqual([84532]);
    expect(sponsor.kick).toHaveBeenCalledTimes(1);
  });

  it("surfaces a paused sponsor as the fixed unavailable sentence", async () => {
    const store = new MemoryStore();
    const { center } = bridged(store, { paused: true });
    const published = await center.publishIntent({ ...envelope, ...(await signed()) });
    await expect(center.requestDeploy(published.id)).rejects.toMatchObject({
      code: "SPONSOR_UNAVAILABLE",
      message: CENTER_DEPLOY_REFUSALS.SPONSOR_UNAVAILABLE,
    });
  });

  it("admits only the in-process marker, never a header a network caller could send", async () => {
    const store = new MemoryStore();
    const { app } = bridged(store);
    const body = JSON.stringify({ ...envelope, ...(await signed()) });
    expect((await app.request("/v1/search", {}, { internal: "mcp" })).status).toBe(200);
    for (const headers of [
      { internal: "mcp" },
      { "x-internal": "mcp" },
      { "x-real-ip": "mcp" },
      { origin: ORIGIN },
      { origin: "https://juicebox.center", "content-type": "application/json" },
    ]) {
      expect((await app.request("/v1/search", { headers })).status).toBe(403);
      expect(
        (await app.request("/v1/intents", { method: "POST", headers, body })).status,
      ).toBe(403);
    }
    expect((await store.search("", 10, 0, {})).totalCount).toBe(0);
  });

  it("holds every publisher behind one shared hourly bucket and one storage identity", async () => {
    const store = new MemoryStore();
    const { center } = bridged(store, { publishPerIpPerHour: 2 });
    const first = await center.publishIntent({ ...envelope, ...(await signed("22")) });
    const second = await center.publishIntent({ ...envelope, ...(await signed("33")) });
    expect(first.publisher).not.toBe(second.publisher);
    // A publisher key is free to mint, so a third publish from a third key still exhausts it.
    const failure = await center
      .publishIntent({ ...envelope, ...(await signed("44")) })
      .catch((error) => error);
    expect(failure.code).toBe("UPSTREAM_HTTP_ERROR");
    expect(failure.details).toMatchObject({ status: 429, code: "publish_limit" });
    expect(store.requests.get("publish:mcp")).toBe(3);
    expect(
      store.intents.map((intent) => (intent as Intent & { submittedBy?: string }).submittedBy),
    ).toEqual(["mcp", "mcp"]);
  });

  it("keeps a network caller claiming the MCP's address out of the MCP's budgets", async () => {
    const store = new MemoryStore();
    const { app } = bridged(store);
    const response = await app.request("/v1/intents", {
      method: "POST",
      headers: {
        origin: "https://juicebox.money",
        "content-type": "application/json",
        "x-real-ip": "mcp",
      },
      body: JSON.stringify({ ...envelope, ...(await signed("55")) }),
    });
    expect(response.status).toBe(201);
    const keys = [...store.requests.keys()];
    expect(keys).toContain("publish:ip:mcp");
    expect(keys).not.toContain("publish:mcp");
    expect(keys.some((key) => key.startsWith("publish:mcp:"))).toBe(false);
    expect((store.intents[0] as Intent & { submittedBy?: string }).submittedBy).not.toBe("mcp");
  });
});
