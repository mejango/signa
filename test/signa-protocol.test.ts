import { createProtocolOperations } from "@juicebox/mcp/host";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentHash, signingMessage } from "../src/intent.js";
import { operationDescriptors } from "../src/rest/app.js";
import { createSignaProtocol } from "../src/signaProtocol.js";
import type { RpcGateway } from "../src/rpc.js";
import type { Intent, IntentEnvelope } from "../src/types.js";
import { MemoryStore } from "./support/memoryStore.js";

const audience = "https://api.signa.center";
const id = "a7396c7e-b13f-4ca8-9f06-96f36ab22c3a";
const env = { NODE_ENV: "production", MCP_PLAN_SECRET: "signa-test-secret-with-at-least-32-bytes" };
const rpc = () => ({ supports: () => true,
  request: vi.fn<RpcGateway["request"]>().mockResolvedValue({ jsonrpc: "2.0", id: 1, result: "0x1" }) });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Signa protocol dependencies", () => {
  it("reads Center search and verified intents remotely without consulting the fresh account store", async () => {
    const store = new MemoryStore();
    const localSearch = vi.spyOn(store, "search"), localIntent = vi.spyOn(store, "getIntent");
    const publisher = privateKeyToAccount(`0x${"12".repeat(32)}`);
    const envelope: IntentEnvelope = { format: "juicebox/project-v1", deploymentVersion: "6", chainIds: [1],
      deploymentCalls: [{ chainId: 1, to: publisher.address, data: "0x12345678" }], jb: { name: "Center reference", chainIds: [1] } };
    const hash = contentHash(envelope);
    const metadata = { name: "Center reference", description: null, tagline: null, tags: [], logoUri: null, owner: null };
    const intent: Intent = { ...metadata, id, status: "undeployed", envelope, contentHash: hash, publisher: publisher.address,
      signature: await publisher.signMessage({ message: signingMessage(hash) }), createdAt: "2026-09-06T00:00:00.000Z", deployments: [], deploys: [] };
    const page = { items: [{ ...metadata, source: "jbcenter", status: "undeployed", intentId: id, contentHash: hash,
      format: envelope.format, deploymentVersion: "6", chainIds: [1], publisher: publisher.address, createdAt: intent.createdAt }], totalCount: 1, nextCursor: null };
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(page)).mockResolvedValueOnce(Response.json(intent));
    vi.stubGlobal("fetch", transport);
    const { services } = createSignaProtocol(store, { rpc: rpc(), audience,
      env: { ...env, MCP_PUBLIC_ORIGIN: "https://ignored.example", JBCENTER_URL: "https://ignored.example" } });

    await expect(services.center.search({ query: " Center reference ", limit: 3, cursor: "21" })).resolves.toEqual(page);
    const operations = createProtocolOperations(services);
    await expect(operations.execute("get_intent", { id })).resolves.toEqual(intent);
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://juicebox.center/v1/search?q=Center+reference&limit=3&cursor=21", `https://juicebox.center/v1/intents/${id}`,
    ]);
    for (const [, options] of transport.mock.calls) {
      expect(options?.method).toBe("GET");
      expect(new Headers(options?.headers).get("origin")).toBe(audience);
      expect(options?.redirect).toBe("manual");
      expect(options?.body).toBeUndefined();
    }
    expect(localSearch).not.toHaveBeenCalled();
    expect(localIntent).not.toHaveBeenCalled();
    const exposed = operationDescriptors(operations).map(operation => operation.id);
    expect(exposed).toContain("get_intent");
    for (const operation of ["publish_intent", "deploy_intent", "pin_project_logo", "pin_project_metadata"])
      expect(exposed).not.toContain(operation);
  });

  it("retains namespaced planning configuration and sends RPC directly through the injected gateway", async () => {
    const transport = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", transport);
    const gateway = rpc();
    const { config, services } = createSignaProtocol(new MemoryStore(), { rpc: gateway, audience,
      env: { ...env, MCP_PLAN_TTL_SECONDS: "600", MCP_MAX_CONCURRENT_REQUESTS: "8",
        MCP_BENDYSTRAW_MAINNET_URL: "https://indexer.example/mainnet", MCP_BENDYSTRAW_TESTNET_URL: "https://indexer.example/testnet" } });
    expect(config).toMatchObject({ publicOrigin: audience, centerOrigin: audience, centerUrl: "https://juicebox.center",
      planSecret: env.MCP_PLAN_SECRET, planTtlSeconds: 600, maxConcurrentRequests: 8,
      bendystrawMainnetUrl: "https://indexer.example/mainnet", bendystrawTestnetUrl: "https://indexer.example/testnet" });
    await expect(services.rpc.client(1).getChainId()).resolves.toBe(1);
    expect(gateway.request).toHaveBeenCalledOnce();
    expect(gateway.request.mock.calls[0]?.[0]).toBe(1);
    expect(transport).not.toHaveBeenCalled();
  });
});
