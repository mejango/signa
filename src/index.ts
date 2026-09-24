import { Hono } from "hono";
import type { Pool } from "pg";
import type { Hex } from "viem";
import { keepUpstreamConnections } from "./keepAlive.js";
import { migrate } from "./db/migrate.js";
import { createPool, PostgresStore } from "./db/postgres.js";
import { createRpcGateway, dwellirRpcUpstreams, DWELLIR_RPC_HOSTS } from "./rpc.js";
import { createSignaProtocol } from "./signaProtocol.js";
import { createRestRuntime, type RestWalletConfiguration } from "./rest/runtime.js";
import { mountRestSite } from "./rest/site.js";
import type { JbcenterEnv } from "./types.js";
import { createBaseWalletProductionStack } from "./rest/wallet/productionStack.js";
import { createBaseWalletDeviceHost, createBaseWalletRecoveryHost, createBaseWalletSignupHost } from "./rest/wallet/baseHost.js";
import { validateWalletPolicyOrigin } from "./rest/wallet/policy.js";
import { readRestExecutionConfiguration } from "./rest/executionConfig.js";
import { Metrics } from "./observability.js";
import { createSignaApp, type SignaHttpRuntime } from "./signaApp.js";
import { createSignaServer } from "./signaServer.js";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function origins(name: string): string[] {
  return (process.env[name] ?? "").split(",").map(value => value.trim()).filter(Boolean).map(validateWalletPolicyOrigin);
}
function configuredGroup(names: readonly string[]): boolean {
  const present = names.filter(name => process.env[name]);
  if (present.length && present.length !== names.length) throw new Error(`${names.join(", ")} must be configured together`);
  return present.length > 0;
}
function signer(name: string): Hex | undefined {
  const value = process.env[name];
  if (value && !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a 32-byte hex private key`);
  return value as Hex | undefined;
}

const enabled = process.env.SIGNA_RUNTIME_ENABLED ?? "false";
if (enabled !== "true" && enabled !== "false") throw new Error("SIGNA_RUNTIME_ENABLED must be true or false");
const audience = validateWalletPolicyOrigin(process.env.REST_PUBLIC_ORIGIN ?? "https://api.signa.center");
const origin = validateWalletPolicyOrigin(process.env.WALLET_ORIGIN ?? "https://signa.center");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PORT is invalid");

let accountRuntime: Awaited<ReturnType<typeof createRestRuntime>> | undefined;
let pool: Pool | undefined;
let httpRuntime: SignaHttpRuntime | undefined;
let starting: Promise<void> | undefined;
let shuttingDown = false;
const app = createSignaApp({ apiAudience: audience, walletOrigin: origin, currentRuntime: () => httpRuntime });
const server = createSignaServer(app.fetch, { port, shutdownGraceMs: positiveInteger("SHUTDOWN_GRACE_MS", 25_000) });

async function activate(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required when Signa is enabled");
  const creation = configuredGroup(["WALLET_CREATION_SIGNER_KEY", "WALLET_CREATION_POOL_ID", "WALLET_CREATION_ALLOCATION_WEI", "WALLET_CREATION_INITIAL_NONCE"]);
  const recovery = configuredGroup(["WALLET_RECOVERY_SIGNER_KEY", "WALLET_RECOVERY_MAX_OPERATIONS", "WALLET_RECOVERY_MAX_COST_WEI"]);
  const creationKey = signer("WALLET_CREATION_SIGNER_KEY");
  const recoveryKey = signer("WALLET_RECOVERY_SIGNER_KEY");
  const networksPayerKey = signer("WALLET_NETWORKS_PAYER_KEY");
  const frameableAppOrigins = origins("WALLET_FRAMEABLE_APP_ORIGINS");
  keepUpstreamConnections();
  const upstreams = dwellirRpcUpstreams(process.env.DWELLIR_API_KEY);
  const rpcSiteLimitPerMinute = positiveInteger("RPC_SITE_LIMIT_PER_MINUTE", 20_000);
  pool = createPool(connectionString);
  await migrate(pool);
  if (shuttingDown) return;
  const store = new PostgresStore(pool);
  // These are protocol planning/evidence libraries only. Signa mounts no MCP transport or Center app.
  const protocol = createSignaProtocol(store, { rpc: createRpcGateway(upstreams), rpcSiteLimitPerMinute, audience });
  const stack = await createBaseWalletProductionStack();
  const wallet: RestWalletConfiguration = { origin, frameableAppOrigins,
    manifest: stack.manifest, utility: stack.utility, basePath: "", payments: stack.payments,
    ...(networksPayerKey ? { networksPayerKey } : {}) };
  const rpcUrl = `https://${DWELLIR_RPC_HOSTS[8453]}/${process.env.DWELLIR_API_KEY}`;
  accountRuntime = await createRestRuntime({
    surface: "wallet",
    pool, store, services: protocol.services, config: protocol.config, upstreams, audience, wallet,
    rpcSiteLimitPerMinute, metrics: new Metrics(), executionConfiguration: await readRestExecutionConfiguration(process.env),
    ...(creation ? { walletSignup: (context: Parameters<typeof createBaseWalletSignupHost>[0]) => createBaseWalletSignupHost(context, {
      url: rpcUrl, signerKey: creationKey!, poolId: process.env.WALLET_CREATION_POOL_ID!,
      allocationWei: process.env.WALLET_CREATION_ALLOCATION_WEI!, initialNonce: process.env.WALLET_CREATION_INITIAL_NONCE!,
      manifest: stack.manifest, utility: stack.utility,
      onEvent: event => { if (event.stage !== "worker" || event.outcome !== "pass") console.info(JSON.stringify({ service: "signa", action: "creation", ...event })); },
    }) } : {}),
    ...(recovery ? {
      walletRecovery: (context: Parameters<typeof createBaseWalletRecoveryHost>[0]) => createBaseWalletRecoveryHost(context, {
        url: rpcUrl, signerKey: recoveryKey!, maximumOperations: positiveInteger("WALLET_RECOVERY_MAX_OPERATIONS", 1),
        maximumCostWei: process.env.WALLET_RECOVERY_MAX_COST_WEI!, manifest: stack.manifest, utility: stack.utility,
        onEvent: event => console.info(JSON.stringify({ service: "signa", action: "recovery", ...event })),
      }),
      walletDevices: (context: Parameters<typeof createBaseWalletDeviceHost>[0]) => createBaseWalletDeviceHost(context, {
        url: rpcUrl, signerKey: recoveryKey!, maximumOperations: positiveInteger("WALLET_RECOVERY_MAX_OPERATIONS", 1),
        maximumCostWei: process.env.WALLET_RECOVERY_MAX_COST_WEI!, manifest: stack.manifest, utility: stack.utility,
        onDeviceEvent: event => console.info(JSON.stringify({ service: "signa", action: "device", ...event })),
      }),
    } : {}),
  });
  if (shuttingDown) return;
  const { wallet: walletApp, walletOrigins: _walletOrigins, ...apiSite } = accountRuntime.site;
  if (!walletApp) throw new Error("Signa wallet runtime is unavailable");
  const api = new Hono<JbcenterEnv>();
  mountRestSite(api, apiSite);
  httpRuntime = { api, wallet: walletApp,
    ready: () => store.health() };
  console.info(JSON.stringify({ service: "signa", event: "runtime_ready" }));
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  httpRuntime = undefined;
  try { await server.close(); }
  finally {
    await starting?.catch(() => {});
    try { await accountRuntime?.stop(); }
    finally { await pool?.end(); }
  }
}
const stop = () => void shutdown().catch(() => {
  console.error(JSON.stringify({ service: "signa", code: "SHUTDOWN_FAILED" }));
  process.exitCode = 1;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const address = await server.listen();
console.info(JSON.stringify({ service: "signa", event: "listening", port: address.port, mode: enabled === "true" ? "starting" : "dormant" }));
// A dormant deployment never constructs account factories, database clients, signers or workers.
if (enabled === "true") {
  starting = activate();
  try { await starting; }
  catch {
    console.error(JSON.stringify({ service: "signa", code: "STARTUP_FAILED" }));
    await shutdown();
    process.exitCode = 1;
  }
}
