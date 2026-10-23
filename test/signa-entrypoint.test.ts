import { spawn } from "node:child_process";
import { get } from "node:http";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, expect, it, vi } from "vitest";

it("boots the real dormant entrypoint without database, RPC, or signing configuration", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    // Deliberately omit DATABASE_URL and every provider/treasury secret. A
    // dormant deployment must not construct the account runtime to become live.
    env: { PATH: process.env.PATH, NODE_ENV: "production", PORT: "0", SIGNA_RUNTIME_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  try {
    let port: number | undefined;
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(`Signa exited before listening: ${errors}`);
      for (const line of output.split("\n").slice(0, -1)) {
        const event = JSON.parse(line) as { event?: string; port?: number; mode?: string };
        if (event.event === "listening" && event.mode === "dormant") port = event.port;
      }
      return port;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    for (const [host, path, status] of [
      ["127.0.0.1", "/healthz", 200], ["127.0.0.1", "/readyz", 503],
      ["api.signa.center", "/api/v1", 503], ["signa.center", "/", 503],
    ] as const) {
      const actual = await new Promise<number | undefined>((resolve, reject) => {
        get({ hostname: "127.0.0.1", port, path, headers: { host } }, response => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
          response.once("error", reject);
        }).once("error", reject);
      });
      expect(actual).toBe(status);
    }
    expect(output).not.toContain('"runtime_ready"');
    expect(errors).toBe("");
  } finally {
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { expect(await exited).toBe(0); }
    finally { clearTimeout(deadline); }
  }
}, 20_000);

const keys = { WALLET_CREATION_SIGNER_KEY: `0x${"11".repeat(32)}`, WALLET_RECOVERY_SIGNER_KEY: `0x${"22".repeat(32)}`,
  WALLET_NETWORKS_PAYER_KEY: `0x${"33".repeat(32)}` } as const;
const received = vi.hoisted(() => ({ hosts: new Map<string, { signer?: unknown }>(), networksPayer: undefined as unknown }));

vi.mock("../src/keepAlive.js", () => ({ keepUpstreamConnections: () => {} }));
vi.mock("../src/db/migrate.js", () => ({ migrate: async () => {} }));
vi.mock("../src/db/postgres.js", () => ({ createPool: () => ({ end: async () => {} }), PostgresStore: class { health = async () => true; } }));
vi.mock("../src/rpc.js", () => ({ createRpcGateway: () => ({}), dwellirRpcUpstreams: () => new Map(), DWELLIR_RPC_HOSTS: { 8453: "base.test" } }));
vi.mock("../src/signaProtocol.js", () => ({ createSignaProtocol: () => ({ services: {}, config: {} }) }));
vi.mock("../src/rest/wallet/productionStack.js", () => ({ createBaseWalletProductionStack: async () => ({ manifest: {}, utility: {} }) }));
vi.mock("../src/rest/executionConfig.js", () => ({ readRestExecutionConfiguration: async () => ({}) }));
vi.mock("../src/rest/site.js", () => ({ mountRestSite: () => {} }));
vi.mock("../src/signaApp.js", () => ({ createSignaApp: () => ({ fetch: () => new Response() }) }));
vi.mock("../src/signaServer.js", () => ({ createSignaServer: () => ({ listen: async () => ({ port: 0 }), close: async () => {} }) }));
vi.mock("../src/rest/wallet/baseHost.js", () => ({
  createBaseWalletSignupHost: (_context: unknown, options: { signer?: unknown }) => { received.hosts.set("creation", options); },
  createBaseWalletRecoveryHost: (_context: unknown, options: { signer?: unknown }) => { received.hosts.set("recovery", options); },
  createBaseWalletDeviceHost: (_context: unknown, options: { signer?: unknown }) => { received.hosts.set("device", options); },
}));
vi.mock("../src/rest/runtime.js", () => ({
  createRestRuntime: async (options: { walletNetworksPayer?: unknown; walletSignup?: (context: unknown) => unknown;
    walletRecovery?: (context: unknown) => unknown; walletDevices?: (context: unknown) => unknown }) => {
    received.networksPayer = options.walletNetworksPayer;
    for (const host of [options.walletSignup, options.walletRecovery, options.walletDevices]) await host?.({});
    return { site: { wallet: {}, walletOrigins: [] }, stop: async () => {} };
  },
}));

const saved = { ...process.env };
afterAll(() => { process.env = saved; });

it("every server key reaches its host as a ServerSigner", async () => {
  Object.assign(process.env, keys, { SIGNA_RUNTIME_ENABLED: "true", DATABASE_URL: "postgres://unused", PORT: "0",
    WALLET_CREATION_POOL_ID: "pool", WALLET_CREATION_ALLOCATION_WEI: "1", WALLET_CREATION_INITIAL_NONCE: "0",
    WALLET_RECOVERY_MAX_OPERATIONS: "1", WALLET_RECOVERY_MAX_COST_WEI: "1" });
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try { await import("../src/index.js"); }
  finally { info.mockRestore(); }
  const signers = { creation: received.hosts.get("creation")?.signer, recovery: received.hosts.get("recovery")?.signer,
    device: received.hosts.get("device")?.signer, networks: received.networksPayer };
  const transaction = { type: "eip1559", chainId: 8453, nonce: 0, to: `0x${"44".repeat(20)}`, value: 1n, gas: 21_000n,
    maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } as const;
  for (const [name, key] of [["creation", keys.WALLET_CREATION_SIGNER_KEY], ["recovery", keys.WALLET_RECOVERY_SIGNER_KEY],
    ["device", keys.WALLET_RECOVERY_SIGNER_KEY], ["networks", keys.WALLET_NETWORKS_PAYER_KEY]] as const) {
    const signer = signers[name] as { address: string; signTransaction(value: typeof transaction): Promise<string> };
    const account = privateKeyToAccount(key);
    expect(Object.keys(signer).sort(), name).toEqual(["address", "signTransaction"]);
    expect(signer.address, name).toBe(account.address);
    expect(await signer.signTransaction(transaction), name).toBe(await account.signTransaction(transaction));
  }
});
