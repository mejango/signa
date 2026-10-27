import { randomUUID } from "node:crypto";
import { encodeFunctionData, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createApp, originsForEnvironment } from "../src/app.js";
import { JUICESCAN } from "../src/journeyGraph.js";
import { DeploymentVerificationError } from "../src/deploymentVerifier.js";
import { SAFE_ABI, SAFE_FACTORY, SAFE_FALLBACK, SAFE_SINGLETON } from "../src/safe.js";
import { LaneError } from "../src/sponsor/chain.js";
import type { SponsorRuntime } from "../src/sponsor/policy.js";
import { readSponsorPolicy, reservationWei, type SponsorPolicy } from "../src/rest/sponsorCaps.js";
import type { RpcGateway } from "../src/rpc.js";
import type { Store } from "../src/store.js";
import type { Intent, IntentDeploy, RelayRequest, SearchPage } from "../src/types.js";
import { MemoryStore } from "./support/memoryStore.js";

describe('reserved production credential origin during rollout', () => {
  it.each(['/', '/accounts', '/assets/accounts.js', '/wallet', '/ipfs/bafytest'])('keeps %s closed before the wallet host is configured', async path => {
    const response = await createApp(new MemoryStore()).request('https://wallet.juicebox.center' + path);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain('<script');
  });
  it('protects the actual Host header without trusting forwarded-host claims', async () => {
    const app = createApp(new MemoryStore());
    expect((await app.request('http://localhost/accounts', { headers: { Host: 'WALLET.JUICEBOX.CENTER:8080' } })).status).toBe(503);
    expect((await app.request('https://juicebox.center/', { headers: { 'X-Forwarded-Host': 'wallet.juicebox.center' } })).status).toBe(200);
  });
  it.each([
    ['https://signa.center', 'SIGNA.CENTER:443', 'https://signa.center:8443'],
    ['https://signa.center:8443', 'SIGNA.CENTER:8443', 'https://signa.center:9443'],
    ['http://[::1]:3000', '[::1]:3000', 'http://[::1]:3001'],
  ])('reserves configured credential origin %s without swallowing another port', async (origin, host, other) => {
    const app = createApp(new MemoryStore(), { walletOrigins: [origin] });
    for (const path of ['/', '/accounts', '/assets/accounts.js', '/ipfs/bafytest', '/mcp']) {
      expect((await app.request(origin + path)).status).toBe(503);
      expect((await app.request('https://juicebox.center' + path, { headers: { Host: host } })).status).toBe(503);
    }
    expect((await app.request(other + '/')).status).toBe(200);
    expect((await app.request(origin + '/', { headers: { Host: 'juicebox.center' } })).status).toBe(503);
    expect((await app.request('https://juicebox.center/', { headers: { 'X-Forwarded-Host': host } })).status).toBe(200);
  });
});

const account = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);
const trusted = {
  origin: "https://juicebox.money",
  "content-type": "application/json",
};
/** A relay-paid deployment: the committed call came from the canonical forwarder. */
const verifier = { verify: vi.fn(async () => ({ forwarded: true })) };
/** A wallet-paid deployment: the payer sent the committed call itself. */
const walletVerifier = { verify: vi.fn(async () => ({ forwarded: false })) };
const envelope = {
  format: "juicebox.money/v1",
  deploymentVersion: "6",
  chainIds: [1],
  deploymentCalls: [
    {
      chainId: 1,
      to: "0x3333333333333333333333333333333333333333",
      data: "0x12345678",
    },
  ],
  jb: {
    v: 1,
    name: "Public goods garden",
    description: "Fund climate work",
    tagline: "Grow something useful",
    tags: ["climate", "public-goods"],
    chains: [1],
    stages: [{}],
    owner: account.address,
  },
};

const testnetEnvelope = {
  ...envelope,
  chainIds: [84532, 421614],
  deploymentCalls: [
    {
      chainId: 84532,
      to: "0x3333333333333333333333333333333333333333",
      data: "0x12345678",
    },
    {
      chainId: 421614,
      to: "0x3333333333333333333333333333333333333333",
      data: "0x12345678",
    },
  ],
  jb: { ...envelope.jb, chains: [84532, 421614] },
};

async function publishWith(
  app: ReturnType<typeof createApp>,
  envelopeLike: Record<string, unknown>,
) {
  const preparedResponse = await app.request("/v1/intents/message", {
    method: "POST",
    headers: trusted,
    body: JSON.stringify(envelopeLike),
  });
  const prepared = (await preparedResponse.json()) as { message: string };
  const signature = await account.signMessage({ message: prepared.message });
  return app.request("/v1/intents", {
    method: "POST",
    headers: trusted,
    body: JSON.stringify({ ...envelopeLike, publisher: account.address, signature }),
  });
}

async function publish(app: ReturnType<typeof createApp>) {
  return publishWith(app, envelope);
}

/** The co-hosted MCP's publish: the same routes, reached on the in-process marker. */
async function publishInternally(
  app: ReturnType<typeof createApp>,
  envelopeLike: Record<string, unknown>,
) {
  const preparedResponse = await app.request(
    "/v1/intents/message",
    { method: "POST", headers: trusted, body: JSON.stringify(envelopeLike) },
    { internal: "mcp" },
  );
  const prepared = (await preparedResponse.json()) as { message: string };
  const signature = await account.signMessage({ message: prepared.message });
  return app.request(
    "/v1/intents",
    {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({ ...envelopeLike, publisher: account.address, signature }),
    },
    { internal: "mcp" },
  );
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("JB Center API", () => {
  it("admits the co-hosted MCP on its in-process marker, and keeps Center's own origin out", async () => {
    const app = createApp(new MemoryStore());
    const marked = await app.request("/v1/search", {}, { internal: "mcp" });
    expect(marked.status).toBe(200);
    // Hono only ever receives bindings from the in-process caller, so no request can claim this.
    for (const headers of [
      { origin: "https://juicebox.center" },
      { origin: "https://dev.juicebox.center" },
      { internal: "mcp" },
      { "x-internal": "mcp" },
    ]) {
      const refused = await app.request("/v1/search", { headers });
      expect(refused.status).toBe(403);
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("serves the public directory without a database or browser-origin dependency", async () => {
    const store = new Proxy({} as Store, {
      get() { throw new Error("The directory must not access storage"); },
    });
    const app = createApp(store);
    const response = await app.request("/", { headers: { origin: "https://example.com" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toContain('href="https://github.com/Bananapus/version-6"');
    expect(html).toContain("https://juicebox.center/mcp");
    const stylesheet = html.match(/<link rel="stylesheet" href="([^"]+)"/);
    expect(stylesheet).not.toBeNull();
    const css = await app.request(stylesheet![1]!);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await css.text()).length).toBeGreaterThan(0);
    const script = html.match(/<script defer src="([^"]+)"/);
    expect(script).not.toBeNull();
    const js = await app.request(script![1]!);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("application/javascript");
    expect((await js.text()).length).toBeGreaterThan(0);
    const head = await app.request("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(await head.text()).toBe("");
    expect((await app.request("/", { method: "POST" })).status).toBe(404);
    expect((await app.request("/missing-page")).status).toBe(404);
    expect((await app.request("/v1/search")).status).toBe(403);
  });

  it("requires a trusted browser origin", async () => {
    const response = await createApp(new MemoryStore()).request("/v1/search");
    expect(response.status).toBe(403);
  });

  it("serves agent discovery without credentials and preserves project identity in inspection links", async () => {
    const app = createApp(new MemoryStore());
    const index = await app.request("/llms.txt");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/plain");
    expect(await index.text()).toContain("https://juicebox.center/api/v1/capabilities");
    const discovery = await (await app.request("/llms.txt")).text();
    expect(discovery).toContain("https://juicebox.center/api/docs/project-intents");
    expect(discovery).toContain("Create a project without a transaction");
    expect(discovery).toContain("create its Safes and then launch");
    expect(discovery).toContain("any chain the payer sends itself");
    for (const chain of ["eth", "op", "base", "arb", "sep", "opsep", "basesep", "arbsep"]) {
      const result = await app.request(`/inspect/${chain}/42`);
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe(`${JUICESCAN}#${chain}:42`);
    }
    for (const path of ["/inspect/wrong/1", "/inspect/base/0", "/inspect/base/01", "/inspect/base/9007199254740992", "/inspect/base/1%23other", "/inspect/base/1e3"]) {
      const result = await app.request(path);
      expect(result.status).toBe(400);
      expect(result.headers.has("location")).toBe(false);
    }
    expect((await app.request("/v1/search")).status).toBe(403);
  });

  it("separates liveness, readiness, and protected metrics", async () => {
    const app = createApp(new MemoryStore(), { metricsToken: "metrics-secret" });
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/readyz")).status).toBe(200);
    expect((await app.request("/metrics")).status).toBe(404);
    const metrics = await app.request("/metrics", {
      headers: { authorization: "Bearer metrics-secret" },
    });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("cache-control")).toBe("no-store");
    expect(await metrics.text()).toContain("jbcenter_http_requests_total");
  });

  it("accepts the configured production browser origins", async () => {
    const app = createApp(new MemoryStore());
    const rejected = await app.request("/v1/search", {
      headers: { ...trusted, origin: "https://example.com" },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("cache-control")).toBe("no-store");

    for (const origin of originsForEnvironment("production")) {
      const accepted = await app.request("/v1/search", { headers: { ...trusted, origin } });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("isolates the dev browser origin from production", async () => {
    expect(originsForEnvironment("production")).toEqual([
      "https://juicebox.money",
      "https://revnet.money",
      "https://eth.shop",
      "https://succulent.money",
      "https://homerun.money",
      "https://beep.biz",
    ]);
    const devOrigins = originsForEnvironment("dev");
    expect(devOrigins).toEqual([
      "https://dev.juicebox.money",
      "https://dev.revnet.money",
      "http://localhost:3001",
      "http://localhost:3002",
      "https://dev.eth.shop",
      "http://localhost:3003",
      "https://dev.succulent.money",
      "http://localhost:3004",
      "http://localhost:3010",
      "http://localhost:3014",
      "http://127.0.0.1:8787",
    ]);

    const app = createApp(new MemoryStore(), { allowedOrigins: devOrigins });
    for (const origin of devOrigins) {
      const accepted = await app.request("/v1/search", { headers: { ...trusted, origin } });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("access-control-allow-origin")).toBe(origin);
    }
    for (const origin of originsForEnvironment("production")) {
      const rejected = await app.request("/v1/search", {
        headers: { ...trusted, origin },
      });
      expect(rejected.status).toBe(403);
    }

    const productionApp = createApp(new MemoryStore(), {
      allowedOrigins: originsForEnvironment("production"),
    });
    for (const origin of devOrigins) {
      const rejected = await productionApp.request("/v1/search", {
        headers: { ...trusted, origin },
      });
      expect(rejected.status).toBe(403);
    }
  });

  it("publishes idempotently, searches, reads, and retires a deployed intent", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { deploymentVerifier: verifier });
    const created = await publish(app);
    expect(created.status).toBe(201);
    const intent = (await created.json()) as Intent;
    expect(intent.name).toBe("Public goods garden");
    expect(intent.owner).toBe(account.address);

    const repeated = await publish(app);
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as Intent).id).toBe(intent.id);

    const search = await app.request("/v1/search?q=climate", { headers: trusted });
    const results = (await search.json()) as SearchPage;
    expect(results.items).toHaveLength(1);
    expect(results.items[0]?.source).toBe("jbcenter");

    const reconciled = await app.request(`/v1/intents/${intent.id}/deployments`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        chainId: 1,
        projectId: "42",
        transactionHash: `0x${"12".repeat(32)}`,
      }),
    });
    expect(reconciled.status).toBe(201);
    expect(verifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({ call: envelope.deploymentCalls[0] }),
    );
    const after = (await (
      await app.request("/v1/search?q=climate", { headers: trusted })
    ).json()) as SearchPage;
    expect(after.items).toHaveLength(0);

    const fetched = await app.request(`/v1/intents/${intent.id}`, { headers: trusted });
    const deployed = (await fetched.json()) as Intent;
    expect(deployed.status).toBe("deployed");
    expect(deployed.deployments[0]?.projectId).toBe("42");
  });

  it("publishes an intent whose chain creates a Safe before it launches", async () => {
    const app = createApp(new MemoryStore());
    const target = "0x3333333333333333333333333333333333333333";
    const setup = {
      chainId: 84532,
      to: SAFE_FACTORY,
      data: encodeFunctionData({
        abi: SAFE_ABI,
        functionName: "createProxyWithNonce",
        args: [
          SAFE_SINGLETON,
          encodeFunctionData({
            abi: SAFE_ABI,
            functionName: "setup",
            args: [
              ["0x1111111111111111111111111111111111111111"],
              1n,
              zeroAddress,
              "0x",
              SAFE_FALLBACK,
              zeroAddress,
              0n,
              zeroAddress,
            ],
          }),
          1n,
        ],
      }),
    };
    const launch = { chainId: 84532, to: target, data: "0x12345678" };
    const withSetup = {
      ...envelope,
      chainIds: [84532],
      deploymentCalls: [setup, launch],
      jb: { ...envelope.jb, chains: [84532] },
    };
    const published = await publishWith(app, withSetup);
    expect(published.status).toBe(201);
    const body = (await published.json()) as Intent;
    expect(body.envelope.deploymentCalls.map((call) => call.to)).toEqual([SAFE_FACTORY, target]);

    // The envelope is normalized before the signature is checked, so the refusal
    // reaches a publish that carries any signature at all.
    const refused = await app.request("/v1/intents", {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        ...withSetup,
        deploymentCalls: [{ ...setup, to: target }, launch],
        publisher: account.address,
        signature: `0x${"11".repeat(65)}`,
      }),
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: unknown }).error).toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("deploymentCalls[0].to"),
    });
  });

  it("filters search by owner and publisher, case-insensitively", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { deploymentVerifier: verifier });
    await publish(app);
    const owner = account.address;
    const other = "0x4444444444444444444444444444444444444444";

    const page = async (query: string) =>
      (await (await app.request(`/v1/search?${query}`, { headers: trusted })).json()) as SearchPage;

    expect((await page(`owner=${owner.toLowerCase()}`)).items).toHaveLength(1);
    expect((await page(`owner=${owner.toUpperCase().replace("0X", "0x")}`)).items).toHaveLength(1);
    expect((await page(`publisher=${owner.toLowerCase()}`)).items).toHaveLength(1);
    expect((await page(`q=climate&owner=${owner}`)).items).toHaveLength(1);
    expect((await page(`q=climate&owner=${other}`)).items).toHaveLength(0);
    expect((await page(`owner=${other}`)).totalCount).toBe(0);
    expect((await page(`publisher=${other}`)).items).toHaveLength(0);

    const invalid = await app.request("/v1/search?owner=not-an-address", { headers: trusted });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("rejects a signature after the signed content is changed", async () => {
    const store = new MemoryStore();
    const app = createApp(store);
    const prepared = (await (
      await app.request("/v1/intents/message", {
        method: "POST",
        headers: trusted,
        body: JSON.stringify(envelope),
      })
    ).json()) as { message: string };
    const signature = await account.signMessage({ message: prepared.message });
    const response = await app.request("/v1/intents", {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        ...envelope,
        jb: { ...envelope.jb, name: "Tampered" },
        publisher: account.address,
        signature,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a signature after committed deployment calldata is changed", async () => {
    const app = createApp(new MemoryStore());
    const prepared = (await (
      await app.request("/v1/intents/message", {
        method: "POST",
        headers: trusted,
        body: JSON.stringify(envelope),
      })
    ).json()) as { message: string };
    const signature = await account.signMessage({ message: prepared.message });
    const response = await app.request("/v1/intents", {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        ...envelope,
        deploymentCalls: [{ ...envelope.deploymentCalls[0], data: "0x87654321" }],
        publisher: account.address,
        signature,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("enforces per-origin caller request limits", async () => {
    const store = new MemoryStore();
    const app = createApp(store, {
      deploymentVerifier: verifier,
      requestLimitPerMinute: 1,
    });
    const first = await app.request("/v1/search", { headers: trusted });
    const limited = await app.request("/v1/search", { headers: trusted });
    expect(first.status).toBe(200);
    expect(limited.status).toBe(429);
  });

  it("keeps search, RPC and pin caller budgets independent", async () => {
    const app = createApp(new MemoryStore(), {
      requestLimitPerMinute: 1,
      rpcRequestLimitPerMinute: 1,
      rpc: { supports: () => true, request: async (_chain, request) => ({ jsonrpc: "2.0", id: request.id, result: "0x1" }) },
      pinning: { pin: async () => ({ cid: "fixture", status: "queued" }), pinStream: async () => { throw new Error("Unexpected stream"); } },
    });
    expect((await app.request("/v1/search", { headers: trusted })).status).toBe(200);
    const rpc = () => app.request("/v1/rpc/1", { method: "POST", headers: trusted,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }) });
    expect((await rpc()).status).toBe(200);
    expect((await rpc()).status).toBe(429);
    for (let index = 0; index < 10; index++) {
      expect((await app.request("/v1/pins/json", { method: "POST", headers: trusted, body: "{}" })).status).toBe(201);
    }
    const pin = await app.request("/v1/pins/json", { method: "POST", headers: trusted, body: "{}" });
    expect(pin.status).toBe(429);
    expect(pin.headers.get("retry-after")).toBe("600");
    expect((await app.request("/v1/search", { headers: trusted })).status).toBe(429);
  });

  it("does not expose internal failures that resemble validation messages", async () => {
    const store = new MemoryStore();
    store.search = async () => { throw new Error("request provider token=private-marker"); };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createApp(store).request("/v1/search", { headers: trusted });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    } finally { log.mockRestore(); }
  });

  it.each(["json", "file", "media"])("cancels %s provider work when the HTTP caller aborts", async (kind) => {
    let providerSignal: AbortSignal | undefined;
    const waitForAbort = (signal?: AbortSignal) => {
      providerSignal = signal;
      return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const app = createApp(new MemoryStore(), { pinning: {
      pin: async (_content, _filename, signal) => waitForAbort(signal),
      pinStream: async (_content, _filename, _type, signal) => waitForAbort(signal),
    } });
    const controller = new AbortController();
    const form = new FormData();
    form.set("file", new File(["image"], "image.png", { type: "image/png" }));
    const response = app.request(`/v1/pins/${kind}`, { method: "POST", signal: controller.signal,
      headers: kind === "json" ? trusted : { origin: trusted.origin }, body: kind === "json" ? "{}" : form });
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort();
    expect(providerSignal!.aborted).toBe(true);
    expect((await response).ok).toBe(false);
  });

  it("aborts streamed provider work when a later multipart field invalidates the upload", async () => {
    let providerSignal: AbortSignal | undefined;
    const app = createApp(new MemoryStore(), { pinning: {
      pin: async () => { throw new Error("Unexpected buffered upload"); },
      pinStream: async (content, _filename, _type, signal) => {
        providerSignal = signal;
        for await (const _chunk of content) { /* Consume the streamed file before the extra field. */ }
        return { cid: "fixture", status: "queued" };
      },
    } });
    const form = new FormData();
    form.set("file", new File(["image"], "image.png", { type: "image/png" }));
    form.set("unexpected", "field");
    const response = await app.request("/v1/pins/media", { method: "POST", headers: { origin: trusted.origin }, body: form });
    expect(response.status).toBe(400);
    expect(providerSignal?.aborted).toBe(true);
  });

  it("rejects unsupported streamed files without an unhandled parser error", async () => {
    const pinStream = vi.fn(async () => ({ cid: "fixture", status: "queued" as const }));
    const app = createApp(new MemoryStore(), { pinning: { pin: pinStream, pinStream } });
    const form = new FormData();
    form.set("file", new File(["executable"], "file.bin", { type: "application/octet-stream" }));
    expect((await app.request("/v1/pins/media", { method: "POST", headers: { origin: trusted.origin }, body: form })).status).toBe(415);
    expect(pinStream).not.toHaveBeenCalled();
    await new Promise(resolve => setImmediate(resolve));
  });

  it("serves RPC reads to any origin keyless, and everything else to trusted origins only", async () => {
    const rpc: RpcGateway = {
      supports: (chainId: number) => chainId === 1,
      request: async (chainId, request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: `0x${chainId.toString(16)}`,
      }),
    };
    const app = createApp(new MemoryStore(), { rpc });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] });

    const anonymous = await app.request("/v1/rpc/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("access-control-allow-origin")).toBe("*");

    const ipfs = await app.request("/v1/rpc/1", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://bafy.ipfs.inbrowser.link" },
      body,
    });
    expect(ipfs.status).toBe(200);
    expect(ipfs.headers.get("access-control-allow-origin")).toBe("*");
    await expect(ipfs.json()).resolves.toEqual({ jsonrpc: "2.0", id: 7, result: "0x1" });

    const preflight = await app.request("/v1/rpc/1", {
      method: "OPTIONS",
      headers: {
        origin: "https://bafy.ipfs.inbrowser.link",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

    const search = await app.request("/v1/search", {
      headers: { origin: "https://bafy.ipfs.inbrowser.link" },
    });
    expect(search.status).toBe(403);
    expect(search.headers.get("access-control-allow-origin")).toBeNull();

    for (const origin of originsForEnvironment("production")) {
      const accepted = await app.request("/v1/rpc/1", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body,
      });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("access-control-allow-origin")).toBe(origin);
      await expect(accepted.json()).resolves.toEqual({ jsonrpc: "2.0", id: 7, result: "0x1" });
    }
  });

  it("enforces independent caller and site RPC budgets", async () => {
    const store = new MemoryStore();
    const app = createApp(store, {
      rpc: {
        supports: () => true,
        request: async (_chainId, request) => ({ jsonrpc: "2.0", id: request.id, result: "0x1" }),
      },
      rpcRequestLimitPerMinute: 1,
      rpcSiteLimitPerMinute: 2,
    });
    const request = (origin: string, ip: string) =>
      app.request("/v1/rpc/1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
      });

    expect((await request("https://juicebox.money", "1.1.1.1")).status).toBe(200);
    expect((await request("https://juicebox.money", "1.1.1.1")).status).toBe(429);
    expect((await request("https://revnet.money", "2.2.2.2")).status).toBe(200);
    expect((await request("https://revnet.money", "3.3.3.3")).status).toBe(429);
  });

  it("budgets keyless RPC per IP and apart from the trusted sites", async () => {
    const store = new MemoryStore();
    const app = createApp(store, {
      rpc: {
        supports: () => true,
        request: async (_chainId, request) => ({ jsonrpc: "2.0", id: request.id, result: "0x1" }),
      },
      rpcRequestLimitPerMinute: 5,
      rpcSiteLimitPerMinute: 5,
      rpcPublicRequestLimitPerMinute: 1,
      rpcPublicSiteLimitPerMinute: 2,
    });
    const request = (origin: string | undefined, ip: string) =>
      app.request("/v1/rpc/1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
      });

    const first = await request("https://bafy.ipfs.inbrowser.link", "1.1.1.1");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-limit")).toBe("1");
    expect((await request(undefined, "1.1.1.1")).status).toBe(429);
    expect((await request("https://example.com", "2.2.2.2")).status).toBe(200);
    expect((await request("https://example.com", "3.3.3.3")).status).toBe(429);
    // The public budget being spent leaves the trusted sites untouched.
    expect((await request("https://juicebox.money", "4.4.4.4")).status).toBe(200);
  });

  it("fails closed when RPC cannot verify a deployment", async () => {
    const store = new MemoryStore();
    const app = createApp(store, {
      deploymentVerifier: {
        verify: async () => {
          throw new DeploymentVerificationError("receipt unavailable");
        },
      },
    });
    const created = (await (await publish(app)).json()) as Intent;
    const response = await app.request(`/v1/intents/${created.id}/deployments`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        chainId: 1,
        projectId: "42",
        transactionHash: `0x${"12".repeat(32)}`,
      }),
    });
    expect(response.status).toBe(422);
    expect(store.intents[0]?.status).toBe("undeployed");
  });

  it("keeps concurrent duplicate publications idempotent", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { publishPerPublisherPerDay: 10_000 });
    const responses = await Promise.all(Array.from({ length: 25 }, () => publish(app)));
    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(24);
    expect(store.intents).toHaveLength(1);
  });

  it("publishing is capped per publisher per day and per ip per hour", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { publishPerPublisherPerDay: 1, publishPerIpPerHour: 5 });
    expect((await publish(app)).status).toBe(201);
    const again = await publishWith(app, { ...envelope, jb: { ...envelope.jb, name: "second" } });
    expect(again.status).toBe(429);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("publish_limit");
    expect(again.headers.get("Retry-After")).toBe("86400");
  });

  it("publishes per-ip limit with correct Retry-After header", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { publishPerIpPerHour: 1, publishPerPublisherPerDay: 100 });
    expect((await publish(app)).status).toBe(201);
    const again = await publishWith(app, { ...envelope, jb: { ...envelope.jb, name: "second" } });
    expect(again.status).toBe(429);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("publish_limit");
    expect(again.headers.get("Retry-After")).toBe("3600");
  });

  it("measures MCP publishes against the assistant's own storage caps", async () => {
    const store = new MemoryStore();
    const app = createApp(store, {
      maxIntentsPerClient: 1,
      mcpMaxIntents: 3,
      publishPerPublisherPerDay: 100,
      publishPerIpPerHour: 100,
    });
    const named = (name: string) => ({ ...envelope, jb: { ...envelope.jb, name } });
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: string) => {
      warnings.push(line);
    });
    for (const name of ["first", "second", "third"]) {
      expect((await publishInternally(app, named(name))).status).toBe(201);
    }
    // Four fifths of a cap is worth an operator's attention before the next publish refuses.
    expect(warnings.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ message: "storage_near_limit", client: "mcp", intents: 3 }),
    );
    const refused = await publishInternally(app, named("fourth"));
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("storage_limit");
    // A browser client keeps its own, far smaller pair of caps.
    expect((await publishWith(app, named("browser first"))).status).toBe(201);
    const browserRefused = await publishWith(app, named("browser second"));
    expect(browserRefused.status).toBe(429);
    expect(await errorCode(browserRefused)).toBe("storage_limit");
    warn.mockRestore();
  });
});

describe("sponsored deploy requests", () => {
  let sponsor: { policy: SponsorPolicy; kick: Mock<SponsorRuntime["kick"]> };

  beforeEach(() => {
    sponsor = { policy: readSponsorPolicy({}), kick: vi.fn() };
  });

  it("queues every chain once and is idempotent", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor });
    const intent = (await (await publishWith(app, testnetEnvelope)).json()) as Intent;
    const first = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
    });
    expect(first.status).toBe(202);
    expect(
      ((await first.json()) as { deploys: IntentDeploy[] }).deploys.map((d) => d.chainId),
    ).toEqual([84532, 421614]);
    expect(sponsor.kick).toHaveBeenCalledTimes(1);
    const second = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
    });
    expect(second.status).toBe(200);
    expect(sponsor.kick).toHaveBeenCalledTimes(1);
  });

  it("refuses unsponsorable chains, spent budgets and a paused policy", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor });
    const mainnet = (await (await publish(app)).json()) as Intent;
    expect(
      (await app.request(`/v1/intents/${mainnet.id}/deploy`, { method: "POST", headers: trusted }))
        .status,
    ).toBe(400);

    const tight = createApp(store, {
      sponsor: { ...sponsor, policy: { ...sponsor.policy, dailyBudgetWei: 1n } },
    });
    const testnet = (await (await publishWith(tight, testnetEnvelope)).json()) as Intent;
    const budget = await tight.request(`/v1/intents/${testnet.id}/deploy`, {
      method: "POST",
      headers: trusted,
    });
    expect(budget.status).toBe(429);
    expect(budget.headers.get("Retry-After")).toBe("86400");
    expect(((await budget.json()) as { error: { code: string } }).error.code).toBe(
      "sponsor_budget",
    );
    // A budget refusal costs the requester nothing: the quota is consumed after that check.
    expect([...store.requests.keys()].filter((key) => key.startsWith("deploy:"))).toEqual([]);

    const paused = createApp(store, {
      sponsor: { ...sponsor, policy: { ...sponsor.policy, paused: true } },
    });
    const pausedResponse = await paused.request(`/v1/intents/${testnet.id}/deploy`, {
      method: "POST",
      headers: trusted,
    });
    expect(pausedResponse.status).toBe(503);
  });

  it("holds MCP deploys to the assistant's slice while browser deploys keep the shared day", async () => {
    const store = new MemoryStore();
    const oneChain = {
      ...testnetEnvelope,
      chainIds: [84532],
      deploymentCalls: [testnetEnvelope.deploymentCalls[0]!],
      jb: { ...testnetEnvelope.jb, chains: [84532] },
    };
    const app = createApp(store, {
      publishPerPublisherPerDay: 100,
      sponsor: {
        ...sponsor,
        policy: { ...sponsor.policy, mcpDailyBudgetWei: reservationWei(sponsor.policy, 1) },
      },
    });
    const named = (name: string) => ({ ...oneChain, jb: { ...oneChain.jb, name } });
    const first = (await (await publishInternally(app, named("mcp first"))).json()) as Intent;
    const second = (await (await publishInternally(app, named("mcp second"))).json()) as Intent;
    const browser = (await (await publishWith(app, named("browser"))).json()) as Intent;
    const deploy = (id: string, env?: { internal: string }) =>
      app.request(`/v1/intents/${id}/deploy`, { method: "POST", headers: trusted }, env);

    expect((await deploy(first.id, { internal: "mcp" })).status).toBe(202);
    const refused = await deploy(second.id, { internal: "mcp" });
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("sponsor_budget");
    expect(refused.headers.get("Retry-After")).toBe("86400");
    // The shared day is untouched: only the assistant's own slice is spent.
    expect((await deploy(browser.id)).status).toBe(202);
  });

  it("is unavailable with no sponsor configured", async () => {
    const store = new MemoryStore();
    const app = createApp(store);
    const intent = (await (await publish(app)).json()) as Intent;
    const response = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "unavailable",
    );
  });

  it("rejects an invalid intent id and reports a missing intent", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor });
    const invalid = await app.request("/v1/intents/not-a-uuid/deploy", {
      method: "POST",
      headers: trusted,
    });
    expect(invalid.status).toBe(400);
    const missing = await app.request(`/v1/intents/${randomUUID()}/deploy`, {
      method: "POST",
      headers: trusted,
    });
    expect(missing.status).toBe(404);
  });

  it("deploys the chains it is given and leaves the rest of the intent alone", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor });
    const intent = (await (await publishWith(app, testnetEnvelope)).json()) as Intent;
    const first = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({ chainIds: [421614] }),
    });
    expect(first.status).toBe(202);
    expect(
      ((await first.json()) as { deploys: IntentDeploy[] }).deploys.map((row) => row.chainId),
    ).toEqual([421614]);

    // The second request adds the other chain and reports only that one.
    const second = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({ chainIds: [84532] }),
    });
    expect(second.status).toBe(202);
    expect(
      ((await second.json()) as { deploys: IntentDeploy[] }).deploys.map((row) => row.chainId),
    ).toEqual([84532]);

    // Asking again for a queued chain returns its row and queues nothing.
    const again = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({ chainIds: [84532] }),
    });
    expect(again.status).toBe(200);
    expect(
      ((await again.json()) as { deploys: IntentDeploy[] }).deploys.map((row) => row.chainId),
    ).toEqual([84532]);
    expect(sponsor.kick).toHaveBeenCalledTimes(2);
    expect((await store.getIntent(intent.id))!.deploys.map((row) => row.chainId)).toEqual([
      84532, 421614,
    ]);
  });

  it("re-queues a named chain that failed and leaves an unnamed one as it is", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor });
    const intent = (await (await publishWith(app, testnetEnvelope)).json()) as Intent;
    const deploy = (target: ReturnType<typeof createApp>, chainIds?: number[]) =>
      target.request(`/v1/intents/${intent.id}/deploy`, {
        method: "POST",
        headers: trusted,
        ...(chainIds ? { body: JSON.stringify({ chainIds }) } : {}),
      });
    const rowOf = (chainId: number) =>
      (
        store.intents.find((item) => item.id === intent.id)!.deploys as unknown as {
          chainId: number;
          attempts: number;
          leaseUntil: number | null;
          reservedWei: bigint;
        }[]
      ).find((row) => row.chainId === chainId)!;

    expect((await deploy(app, [84532])).status).toBe(202);
    await store.claimQueuedDeploys(30, 10);
    await store.updateDeploy(intent.id, 84532, {
      status: "failed",
      error: "RELAYR_FUNDING_LIMIT",
    });

    // A request that names no chain queues the rest of the intent and leaves the failure standing.
    const whole = await deploy(app);
    expect(whole.status).toBe(202);
    expect(
      ((await whole.json()) as { deploys: IntentDeploy[] }).deploys.map((row) => [
        row.chainId,
        row.status,
      ]),
    ).toEqual([
      [84532, "failed"],
      [421614, "queued"],
    ]);

    // The retry is budgeted like a first request, so a spent day refuses it and changes nothing.
    const tight = createApp(store, {
      sponsor: { ...sponsor, policy: { ...sponsor.policy, dailyBudgetWei: 1n } },
    });
    const refused = await deploy(tight, [84532]);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("sponsor_budget");
    expect(rowOf(84532).attempts).toBe(1);

    const retry = await deploy(app, [84532]);
    expect(retry.status).toBe(202);
    expect(((await retry.json()) as { deploys: IntentDeploy[] }).deploys).toEqual([
      expect.objectContaining({
        chainId: 84532,
        status: "queued",
        error: null,
        bundleUuid: null,
        transactionHash: null,
      }),
    ]);
    expect(rowOf(84532)).toMatchObject({
      attempts: 0,
      leaseUntil: null,
      reservedWei: reservationWei(sponsor.policy, 1),
    });
    // Three requests reached the quota: the budget refusal in between drew nothing.
    expect(
      [...store.requests.entries()].find(([key]) => key.startsWith("deploy:"))?.[1],
    ).toBe(3);
  });

  it("sponsors the sponsored chains of an intent that also names Ethereum", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor });
    const mixed = {
      ...envelope,
      chainIds: [1, 8453],
      deploymentCalls: [
        { chainId: 1, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
        { chainId: 8453, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
      ],
      jb: { ...envelope.jb, chains: [1, 8453] },
    };
    const intent = (await (await publishWith(app, mixed)).json()) as Intent;
    const response = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
    });
    expect(response.status).toBe(202);
    expect(
      ((await response.json()) as { deploys: IntentDeploy[] }).deploys.map((row) => row.chainId),
    ).toEqual([8453]);
    // One chain is queued, so the reservation is one chain's worth.
    const stored = store.intents.find((item) => item.id === intent.id)!;
    expect((stored.deploys as unknown as { reservedWei: bigint }[])[0]!.reservedWei).toBe(
      reservationWei(sponsor.policy, 1),
    );

    const unsponsored = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({ chainIds: [1] }),
    });
    expect(unsponsored.status).toBe(400);
    expect(await errorCode(unsponsored)).toBe("bad_request");
  });

  it("keeps sponsoring after a relayed chain and stops after a wallet-sent one", async () => {
    const record = (app: ReturnType<typeof createApp>, id: string, chainId: number) =>
      app.request(`/v1/intents/${id}/deployments`, {
        method: "POST",
        headers: trusted,
        body: JSON.stringify({
          chainId,
          projectId: "42",
          transactionHash: `0x${"12".repeat(32)}`,
        }),
      });
    const deploy = (app: ReturnType<typeof createApp>, id: string) =>
      app.request(`/v1/intents/${id}/deploy`, { method: "POST", headers: trusted });

    const relayed = createApp(new MemoryStore(), { sponsor, deploymentVerifier: verifier });
    const first = (await (await publishWith(relayed, testnetEnvelope)).json()) as Intent;
    expect((await deploy(relayed, first.id)).status).toBe(202);

    const forwarded = createApp(new MemoryStore(), { sponsor, deploymentVerifier: verifier });
    const second = (await (await publishWith(forwarded, testnetEnvelope)).json()) as Intent;
    expect((await record(forwarded, second.id, 84532)).status).toBe(201);
    expect((await deploy(forwarded, second.id)).status).toBe(202);

    const wallet = createApp(new MemoryStore(), { sponsor, deploymentVerifier: walletVerifier });
    const third = (await (await publishWith(wallet, testnetEnvelope)).json()) as Intent;
    const recorded = await record(wallet, third.id, 84532);
    expect(((await recorded.json()) as { forwarded: boolean }).forwarded).toBe(false);
    const refused = await deploy(wallet, third.id);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("mixed_sender");
  });

  it("refuses a chain outside the intent, a deployed chain, and an intent with nothing left", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor, deploymentVerifier: verifier });
    const intent = (await (await publishWith(app, testnetEnvelope)).json()) as Intent;
    const outside = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({ chainIds: [10] }),
    });
    expect(outside.status).toBe(400);

    await app.request(`/v1/intents/${intent.id}/deployments`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        chainId: 84532,
        projectId: "42",
        transactionHash: `0x${"12".repeat(32)}`,
      }),
    });
    const deployed = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({ chainIds: [84532] }),
    });
    expect(deployed.status).toBe(400);

    // The rest of the intent is still deployable, and only that chain comes back.
    const rest = await app.request(`/v1/intents/${intent.id}/deploy`, {
      method: "POST",
      headers: trusted,
    });
    expect(rest.status).toBe(202);
    expect(
      ((await rest.json()) as { deploys: IntentDeploy[] }).deploys.map((row) => row.chainId),
    ).toEqual([421614]);

    const mainnetOnly = (await (await publish(app)).json()) as Intent;
    expect(
      (
        await app.request(`/v1/intents/${mainnetOnly.id}/deploy`, {
          method: "POST",
          headers: trusted,
        })
      ).status,
    ).toBe(400);
  });

  it("enforces the per-requester daily quota", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor: { ...sponsor, policy: { ...sponsor.policy, perRequesterPerDay: 1 } } });
    const first = (await (await publishWith(app, testnetEnvelope)).json()) as Intent;
    expect(
      (await app.request(`/v1/intents/${first.id}/deploy`, { method: "POST", headers: trusted }))
        .status,
    ).toBe(202);
    const second = (await (
      await publishWith(app, { ...testnetEnvelope, jb: { ...testnetEnvelope.jb, name: "second" } })
    ).json()) as Intent;
    const quota = await app.request(`/v1/intents/${second.id}/deploy`, {
      method: "POST",
      headers: trusted,
    });
    expect(quota.status).toBe(429);
    expect(quota.headers.get("Retry-After")).toBe("86400");
    expect(((await quota.json()) as { error: { code: string } }).error.code).toBe(
      "sponsor_quota",
    );
  });

  it("reserves the budget split evenly across chains", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor });
    const intent = (await (await publishWith(app, testnetEnvelope)).json()) as Intent;
    await app.request(`/v1/intents/${intent.id}/deploy`, { method: "POST", headers: trusted });
    const stored = store.intents.find((item) => item.id === intent.id)!;
    const reservedWei = (stored.deploys as unknown as { reservedWei: bigint }[]).map(
      (deploy) => deploy.reservedWei,
    );
    const expectedTotal = 2n * (sponsor.policy.maximumGas * sponsor.policy.maximumFeePerGas + 100_000_000_000_000n);
    expect(reservedWei).toEqual([expectedTotal / 2n, expectedTotal / 2n]);
  });
});

describe("relay requests", () => {
  const relayed: RelayRequest = {
    chainId: 1,
    to: "0x3bA60b60933916a7C87D0860DcEE62a0CE34E3e2",
    data: "0x4715378212345678",
    value: "100000000000000",
    gas: "404761",
    deadline: 1_700_001_800,
    setup: [],
  };
  let sponsor: {
    policy: SponsorPolicy;
    kick: Mock<SponsorRuntime["kick"]>;
    relay: Mock<NonNullable<SponsorRuntime["relay"]>>;
  };

  beforeEach(() => {
    sponsor = {
      policy: readSponsorPolicy({}),
      kick: vi.fn(),
      relay: vi.fn<NonNullable<SponsorRuntime["relay"]>>(async () => relayed),
    };
  });

  const relay = (app: ReturnType<typeof createApp>, id: string, body: unknown) =>
    app.request(`/v1/intents/${id}/relay`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify(body),
    });

  it("returns a signed request for a chain Center does not sponsor", async () => {
    const app = createApp(new MemoryStore(), { sponsor });
    const intent = (await (await publish(app)).json()) as Intent;
    const response = await relay(app, intent.id, { chainId: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(relayed);
    expect(sponsor.relay).toHaveBeenCalledWith(expect.objectContaining({ id: intent.id }), 1);
  });

  it("refuses a sponsored chain, a foreign chain, a bad id and a missing intent", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor });
    const mainnet = (await (await publish(app)).json()) as Intent;
    const testnet = (await (await publishWith(app, testnetEnvelope)).json()) as Intent;

    const sponsored = await relay(app, testnet.id, { chainId: 84532 });
    expect(sponsored.status).toBe(400);
    expect(await errorCode(sponsored)).toBe("sponsored_chain");

    const foreign = await relay(app, mainnet.id, { chainId: 8453 });
    expect(foreign.status).toBe(400);
    expect(await errorCode(foreign)).toBe("bad_request");

    expect((await relay(app, "not-a-uuid", { chainId: 1 })).status).toBe(400);
    expect((await relay(app, randomUUID(), { chainId: 1 })).status).toBe(404);
    expect((await relay(app, mainnet.id, {})).status).toBe(400);
    expect(sponsor.relay).not.toHaveBeenCalled();
  });

  it("refuses a chain that already has a deployment", async () => {
    const app = createApp(new MemoryStore(), { sponsor, deploymentVerifier: verifier });
    const intent = (await (await publish(app)).json()) as Intent;
    await app.request(`/v1/intents/${intent.id}/deployments`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        chainId: 1,
        projectId: "42",
        transactionHash: `0x${"12".repeat(32)}`,
      }),
    });
    const response = await relay(app, intent.id, { chainId: 1 });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
    expect(sponsor.relay).not.toHaveBeenCalled();
  });

  it("signs after a relayed chain and refuses once a wallet deployed one", async () => {
    const mixed = {
      ...envelope,
      chainIds: [1, 8453],
      deploymentCalls: [
        { chainId: 1, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
        { chainId: 8453, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
      ],
      jb: { ...envelope.jb, chains: [1, 8453] },
    };
    const record = (app: ReturnType<typeof createApp>, id: string) =>
      app.request(`/v1/intents/${id}/deployments`, {
        method: "POST",
        headers: trusted,
        body: JSON.stringify({
          chainId: 8453,
          projectId: "42",
          transactionHash: `0x${"12".repeat(32)}`,
        }),
      });

    const forwarded = createApp(new MemoryStore(), { sponsor, deploymentVerifier: verifier });
    const first = (await (await publishWith(forwarded, mixed)).json()) as Intent;
    expect((await relay(forwarded, first.id, { chainId: 1 })).status).toBe(200);
    expect((await record(forwarded, first.id)).status).toBe(201);
    expect((await relay(forwarded, first.id, { chainId: 1 })).status).toBe(200);

    const wallet = createApp(new MemoryStore(), { sponsor, deploymentVerifier: walletVerifier });
    const second = (await (await publishWith(wallet, mixed)).json()) as Intent;
    expect((await record(wallet, second.id)).status).toBe(201);
    const refused = await relay(wallet, second.id, { chainId: 1 });
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("mixed_sender");
  });

  it("spends an hourly bucket of its own and leaves the sponsored quota alone", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor });
    const intent = (await (await publish(app)).json()) as Intent;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await relay(app, intent.id, { chainId: 1 })).status).toBe(200);
    }
    const refused = await relay(app, intent.id, { chainId: 1 });
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("relay_limit");
    expect(refused.headers.get("Retry-After")).toBe("3600");
    expect([...store.requests.keys()].filter((key) => key.startsWith("deploy:"))).toEqual([]);
  });

  it("answers 503 with no lane configured and when the lane cannot reach the chain", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { sponsor: { policy: sponsor.policy, kick: sponsor.kick } });
    const intent = (await (await publish(app)).json()) as Intent;
    const missing = await relay(app, intent.id, { chainId: 1 });
    expect(missing.status).toBe(503);
    expect(await errorCode(missing)).toBe("unavailable");

    const failing = createApp(store, {
      sponsor: {
        ...sponsor,
        relay: vi.fn(async () => {
          throw new LaneError("chain 1 is not configured", "CHAIN_UNCONFIGURED");
        }),
      },
    });
    const response = await relay(failing, intent.id, { chainId: 1 });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe("relay_unavailable");
    expect(body).not.toContain("not configured");
  });
});
