import { createServices, loadConfig, type Config, type Services } from "@juicebox/mcp/host";
import { createCenterRpcFetcher } from "./mcp.js";
import type { RpcGateway } from "./rpc.js";
import type { Store } from "./store.js";

/** Account state is local to Signa; published project intents remain Center reference data. */
export function createSignaProtocol(store: Store, options: {
  rpc: RpcGateway;
  audience: string;
  env?: NodeJS.ProcessEnv;
  rpcSiteLimitPerMinute?: number;
}): { config: Config; services: Services } {
  const env = options.env ?? process.env;
  const config = loadConfig({
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    HOST: env.HOST,
    PUBLIC_ORIGIN: options.audience,
    JBCENTER_URL: "https://juicebox.center",
    JBCENTER_ORIGIN: options.audience,
    PLAN_SECRET: env.MCP_PLAN_SECRET,
    PLAN_TTL_SECONDS: env.MCP_PLAN_TTL_SECONDS,
    BENDYSTRAW_MAINNET_URL: env.MCP_BENDYSTRAW_MAINNET_URL,
    BENDYSTRAW_TESTNET_URL: env.MCP_BENDYSTRAW_TESTNET_URL,
    KNOWLEDGE_PATH: env.MCP_KNOWLEDGE_PATH,
    MAX_CONCURRENT_REQUESTS: env.MCP_MAX_CONCURRENT_REQUESTS,
  });
  const services = createServices(config, {
    rpcFetchJson: createCenterRpcFetcher(store, options.rpc, config.rpcUrls, options.rpcSiteLimitPerMinute),
  });
  return { config, services };
}
