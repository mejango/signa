import {
  CenterClient,
  DomainError,
  consumeRequest,
  createServices,
  loadConfig,
  type Config,
  type FetchJsonOptions,
  type PinProjectLogo,
  type PinProjectMetadataJson,
  type Services,
  upstreamErrorCode,
} from "@juicebox/mcp/host";
import { getAddress } from "viem";
import { environmentName, originsForEnvironment } from "./firstParty.js";
import { isIpfsCid, type PinningService } from "./ipfs.js";
import {
  parseRpcRequest,
  RPC_BODY_LIMIT,
  RPC_RESPONSE_LIMIT,
  RpcBadRequest,
  type RpcGateway,
} from "./rpc.js";
import type { SearchFilters, Store } from "./store.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const METADATA_LIMIT = 64 * 1024;
const LOGO_LIMIT = 1024 * 1024;
const READ_RESPONSE_LIMIT = 2 * 1024 * 1024;
/** An intent echo is an intent: writes answer under the same bound as reads. */
const WRITE_RESPONSE_LIMIT = READ_RESPONSE_LIMIT;

export const MCP_BACKEND_LIMITS = {
  readsPerMinute: 600,
  rpcPerMinute: 5_000,
  rpcSitePerMinute: 20_000,
  pinsPerWindow: 10,
  pinsSitePerWindow: 200,
  pinWindowSeconds: 600,
  writesPerMinute: 60,
} as const;

function invalidRequest(): never {
  throw new DomainError(
    "INVALID_INPUT",
    "This internal backend route or request is not supported.",
  );
}

function cancelled(): DomainError {
  return new DomainError(
    "UPSTREAM_TIMEOUT",
    "The upstream operation was cancelled or timed out.",
    {
      retryable: true,
    },
  );
}

function signalFor(options: FetchJsonOptions): AbortSignal {
  const timeout = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
    invalidRequest();
  const contextSignal = consumeRequest();
  return AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...[options.signal, contextSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    ),
  ]);
}

/** Stop waiting on a disconnected tool, and never start the next backend operation after abort. */
async function cancellable<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw cancelled();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    // Store has no cancellation parameter. An already-started query finishes there,
    // but a cancelled tool cannot start further backend work through this bridge.
    void Promise.resolve()
      .then(() => {
        if (signal.aborted) throw cancelled();
        return work();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function quota(
  store: Store,
  key: string,
  limit: number,
  windowSeconds: number,
  signal: AbortSignal,
): Promise<void> {
  const budget = await cancellable(signal, () =>
    store.consumeRequest(key, limit, windowSeconds),
  );
  if (!budget.allowed) {
    throw new DomainError(
      "RATE_LIMITED",
      "The shared MCP backend budget is spent. Retry later.",
      {
        retryable: true,
        details: { retryAfterSeconds: windowSeconds },
      },
    );
  }
}

function safeFailure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw cancelled();
  if (error instanceof DomainError) throw error;
  throw new DomainError(
    "UPSTREAM_UNAVAILABLE",
    "The configured backend could not complete the operation.",
    {
      retryable: true,
    },
  );
}

function boundedResult(
  value: unknown,
  requestedLimit: number | undefined,
  maximum: number,
): unknown {
  const limit = requestedLimit ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    invalidRequest();
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new DomainError(
      "UPSTREAM_INVALID_RESPONSE",
      "The backend returned an invalid JSON result.",
    );
  }
  if (Buffer.byteLength(encoded) > limit) {
    throw new DomainError(
      "UPSTREAM_RESPONSE_TOO_LARGE",
      "The backend response exceeded its size limit. Narrow the query.",
    );
  }
  // Match an actual HTTP JSON boundary (plain values, no shared mutable store objects).
  return JSON.parse(encoded) as unknown;
}

function targetUrl(value: string | URL, base: URL): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    invalidRequest();
  }
  if (
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.hash
  )
    invalidRequest();
  return target;
}

function baseUrl(value: string): URL {
  const base = new URL(value);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new DomainError(
      "INVALID_CONFIG",
      "The internal Center endpoint must be a plain HTTP(S) base URL.",
    );
  }
  return base;
}

/** Only the two Center read routes exist here. No HTTP request or browser Origin is fabricated. */
export function createCenterReadFetcher(store: Store, centerUrl: string) {
  const base = baseUrl(centerUrl);
  const prefix = base.pathname.replace(/\/$/u, "");
  return async (
    url: string | URL,
    options: FetchJsonOptions = {},
  ): Promise<unknown> => {
    const target = targetUrl(url, base);
    if ((options.method ?? "GET") !== "GET" || options.body !== undefined)
      invalidRequest();
    const pathname = target.pathname;
    let read: () => Promise<unknown>;
    if (pathname === `${prefix}/v1/search`) {
      const params = target.searchParams;
      if (
        [...params.keys()].some(
          (key) =>
            !["q", "limit", "cursor", "owner", "publisher"].includes(key) ||
            params.getAll(key).length !== 1,
        )
      )
        invalidRequest();
      const query = (params.get("q") ?? "").trim();
      const limitText = params.get("limit") ?? "20";
      const cursorText = params.get("cursor") ?? "0";
      const limit = Number(limitText);
      const offset = Number(cursorText);
      if (
        query.length > 200 ||
        !/^[1-9]\d{0,2}$/u.test(limitText) ||
        limit > 100 ||
        !/^\d{1,16}$/u.test(cursorText) ||
        !Number.isSafeInteger(offset)
      )
        invalidRequest();
      const filters: SearchFilters = {};
      for (const key of ["owner", "publisher"] as const) {
        const value = params.get(key);
        if (value === null) continue;
        if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) invalidRequest();
        filters[key] = getAddress(value);
      }
      read = () => store.search(query, limit, offset, filters);
    } else if (pathname.startsWith(`${prefix}/v1/intents/`)) {
      const id = pathname.slice(`${prefix}/v1/intents/`.length);
      if (!UUID.test(id) || target.search) invalidRequest();
      read = async () => {
        const intent = await store.getIntent(id);
        if (!intent)
          throw new DomainError(
            "NOT_FOUND",
            "The requested JB Center intent was not found.",
          );
        return intent;
      };
    } else invalidRequest();
    const signal = signalFor(options);
    try {
      await quota(
        store,
        "center:mcp:reads",
        MCP_BACKEND_LIMITS.readsPerMinute,
        60,
        signal,
      );
      return boundedResult(
        await cancellable(signal, read),
        options.maxBytes,
        READ_RESPONSE_LIMIT,
      );
    } catch (error) {
      safeFailure(error, signal);
    }
  };
}

export type CenterFetch = (request: Request) => Response | Promise<Response>;

function writePath(pathname: string, prefix: string): boolean {
  if (pathname === `${prefix}/v1/intents`) return true;
  const intents = `${prefix}/v1/intents/`;
  const suffix = "/deploy";
  if (!pathname.startsWith(intents) || !pathname.endsWith(suffix)) return false;
  return UUID.test(pathname.slice(intents.length, pathname.length - suffix.length));
}

function refusal(status: number, body: string): DomainError {
  const code = upstreamErrorCode(body);
  return new DomainError(
    "UPSTREAM_HTTP_ERROR",
    `The internal Center route returned HTTP ${status}.`,
    {
      retryable: status === 429 || status >= 500,
      details: { status, ...(code === undefined ? {} : { code }) },
    },
  );
}

/**
 * Reads run against the store; the two intent writes run through the Hono app itself, so
 * signature verification, publish limits and sponsor policy have exactly one implementation.
 * The app admits the request on the in-process marker `centerFetch` carries, so no browser
 * Origin is fabricated and no caller header decides the identity.
 */
export function createCenterFetcher(
  store: Store,
  centerUrl: string,
  options: { centerFetch?: CenterFetch } = {},
) {
  const base = baseUrl(centerUrl);
  const prefix = base.pathname.replace(/\/$/u, "");
  const read = createCenterReadFetcher(store, centerUrl);
  return async (url: string | URL, fetchOptions: FetchJsonOptions = {}): Promise<unknown> => {
    const method = fetchOptions.method ?? (fetchOptions.body === undefined ? "GET" : "POST");
    if (method === "GET") return read(url, fetchOptions);
    const target = targetUrl(url, base);
    const { centerFetch } = options;
    if (method !== "POST" || !centerFetch || target.search) invalidRequest();
    if (!writePath(target.pathname, prefix)) invalidRequest();
    let body: string | undefined;
    try {
      body = JSON.stringify(fetchOptions.body ?? {});
    } catch {
      invalidRequest();
    }
    if (body === undefined) invalidRequest();
    const signal = signalFor(fetchOptions);
    try {
      await quota(store, "center:mcp:writes", MCP_BACKEND_LIMITS.writesPerMinute, 60, signal);
      const response = await cancellable(signal, () =>
        Promise.resolve(
          // The adapter's operator headers stay with the adapter: in process the app reads the
          // caller from its own marker and from the publisher the signature already proved.
          centerFetch(
            new Request(target, {
              method: "POST",
              headers: { accept: "application/json", "content-type": "application/json" },
              body,
            }),
          ),
        ),
      );
      const text = await response.text();
      if (Buffer.byteLength(text) > WRITE_RESPONSE_LIMIT)
        throw new DomainError(
          "UPSTREAM_RESPONSE_TOO_LARGE",
          "The backend response exceeded its size limit. Narrow the query.",
        );
      if (!response.ok) throw refusal(response.status, text);
      let payload: unknown = null;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = null;
      }
      return boundedResult(payload, fetchOptions.maxBytes, WRITE_RESPONSE_LIMIT);
    } catch (error) {
      safeFailure(error, signal);
    }
  };
}

/** Retain the shared read-only gateway's provider failover, sanitization and streaming cap. */
export function createCenterRpcFetcher(
  store: Store,
  rpc: RpcGateway,
  rpcUrls: Config["rpcUrls"],
  siteLimitPerMinute: number = MCP_BACKEND_LIMITS.rpcSitePerMinute,
) {
  if (!Number.isSafeInteger(siteLimitPerMinute) || siteLimitPerMinute < 1) {
    throw new DomainError(
      "INVALID_CONFIG",
      "The shared RPC quota must be a positive safe integer.",
    );
  }
  const chainsByUrl = new Map<string, number>();
  for (const [chain, value] of Object.entries(rpcUrls)) {
    if (!value) continue;
    const target = baseUrl(value);
    if (
      target.pathname !== `/v1/rpc/${chain}` ||
      !rpc.supports(Number(chain))
    ) {
      throw new DomainError(
        "INVALID_CONFIG",
        "The MCP RPC endpoint must identify a supported internal chain route.",
      );
    }
    if (chainsByUrl.has(target.href))
      throw new DomainError("INVALID_CONFIG", "Duplicate MCP RPC endpoint.");
    chainsByUrl.set(target.href, Number(chain));
  }
  return async (
    url: string | URL,
    options: FetchJsonOptions = {},
  ): Promise<unknown> => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      invalidRequest();
    }
    const chain = chainsByUrl.get(target.href);
    if (
      !chain ||
      target.username ||
      target.password ||
      target.hash ||
      target.search ||
      (options.method ?? "POST") !== "POST"
    )
      invalidRequest();
    let request;
    try {
      const encoded =
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
      if (!encoded || Buffer.byteLength(encoded) > RPC_BODY_LIMIT)
        invalidRequest();
      request = parseRpcRequest(JSON.parse(encoded));
    } catch (error) {
      if (error instanceof RpcBadRequest || error instanceof SyntaxError)
        invalidRequest();
      throw error;
    }
    const signal = signalFor(options);
    try {
      await quota(
        store,
        "rpc:mcp",
        MCP_BACKEND_LIMITS.rpcPerMinute,
        60,
        signal,
      );
      await quota(store, "rpc:site", siteLimitPerMinute, 60, signal);
      const value = await cancellable(signal, () =>
        rpc.request(chain, request, signal),
      );
      return boundedResult(value, options.maxBytes, RPC_RESPONSE_LIMIT);
    } catch (error) {
      safeFailure(error, signal);
    }
  };
}

/** Both MCP pin bridges spend the same anonymous budgets; the browser routes have their own. */
async function centerPin(
  store: Store,
  pinning: PinningService,
  blob: Blob,
  filename: string,
  callerSignal: AbortSignal | undefined,
): Promise<{ cid: string; status: "queued" }> {
  const signal = signalFor({
    ...(callerSignal ? { signal: callerSignal } : {}),
    timeoutMs: 60_000,
  });
  try {
    await quota(
      store,
      "pin:mcp",
      MCP_BACKEND_LIMITS.pinsPerWindow,
      MCP_BACKEND_LIMITS.pinWindowSeconds,
      signal,
    );
    await quota(
      store,
      "pin:site",
      MCP_BACKEND_LIMITS.pinsSitePerWindow,
      MCP_BACKEND_LIMITS.pinWindowSeconds,
      signal,
    );
    const result = await cancellable(signal, () =>
      pinning.pin(blob, filename, signal),
    );
    if (result.status !== "queued" || !isIpfsCid(result.cid)) {
      throw new DomainError(
        "UPSTREAM_INVALID_RESPONSE",
        "The pinning backend returned an invalid CID or status.",
      );
    }
    return { cid: result.cid, status: "queued" };
  } catch (error) {
    safeFailure(error, signal);
  }
}

/** Called only after the metadata service verifies the exact reviewed V6 document and approval. */
export function createCenterPinJson(
  store: Store,
  pinning: PinningService,
): PinProjectMetadataJson {
  return async (jsonText, callerSignal) => {
    if (
      Buffer.byteLength(jsonText) < 2 ||
      Buffer.byteLength(jsonText) > METADATA_LIMIT
    )
      invalidRequest();
    let document: unknown;
    try {
      document = JSON.parse(jsonText);
    } catch {
      invalidRequest();
    }
    if (!document || typeof document !== "object" || Array.isArray(document))
      invalidRequest();
    return centerPin(
      store,
      pinning,
      new Blob([jsonText], { type: "application/json" }),
      "metadata.json",
      callerSignal,
    );
  };
}

/** Called only after the metadata service has decoded, sniffed and size-checked the image. */
export function createCenterPinLogo(
  store: Store,
  pinning: PinningService,
): PinProjectLogo {
  return async (image, callerSignal) => {
    if (image.bytes.byteLength < 1 || image.bytes.byteLength > LOGO_LIMIT)
      invalidRequest();
    return centerPin(
      store,
      pinning,
      new Blob([Buffer.from(image.bytes)], { type: image.contentType }),
      image.filename,
      callerSignal,
    );
  };
}

export function createCenterMcp(
  store: Store,
  options: {
    rpc: RpcGateway;
    pinning?: PinningService;
    env?: NodeJS.ProcessEnv;
    rpcSiteLimitPerMinute?: number;
    /** The Hono app's own fetch. Without it the MCP has reads only. */
    centerFetch?: CenterFetch;
  },
): { config: Config; services: Services } {
  const env = options.env ?? process.env;
  const publicOrigin = env.MCP_PUBLIC_ORIGIN ?? "https://juicebox.center";
  const allowedOrigins = [
    ...originsForEnvironment(environmentName(env) ?? "production"),
    ...(env.MCP_ALLOWED_ORIGINS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []),
  ].join(",");
  // Namespace every MCP setting; the host's credentials/config never become adapter headers.
  const config = loadConfig({
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    HOST: env.HOST,
    PUBLIC_ORIGIN: publicOrigin,
    JBCENTER_URL: publicOrigin,
    PLAN_SECRET: env.MCP_PLAN_SECRET,
    PLAN_TTL_SECONDS: env.MCP_PLAN_TTL_SECONDS,
    ALLOWED_HOSTS: env.MCP_ALLOWED_HOSTS,
    ALLOWED_ORIGINS: allowedOrigins,
    BENDYSTRAW_MAINNET_URL: env.MCP_BENDYSTRAW_MAINNET_URL,
    BENDYSTRAW_TESTNET_URL: env.MCP_BENDYSTRAW_TESTNET_URL,
    KNOWLEDGE_PATH: env.MCP_KNOWLEDGE_PATH,
    MAX_CONCURRENT_REQUESTS: env.MCP_MAX_CONCURRENT_REQUESTS,
  });
  // An in-process write is routed by its own URL, so the bridge base has to be this service's own
  // origin. A foreign Center could never answer it, and the marker must not travel off-process.
  if (options.centerFetch && new URL(config.centerUrl).origin !== new URL(publicOrigin).origin) {
    throw new DomainError(
      "INVALID_CONFIG",
      "The in-process Center bridge requires the Center URL to be this service's own origin.",
    );
  }
  const center = new CenterClient({
    baseUrl: config.centerUrl,
    fetchJson: createCenterFetcher(
      store,
      config.centerUrl,
      options.centerFetch ? { centerFetch: options.centerFetch } : {},
    ),
  });
  const services = createServices(config, {
    rpcFetchJson: createCenterRpcFetcher(
      store,
      options.rpc,
      config.rpcUrls,
      options.rpcSiteLimitPerMinute,
    ),
    center,
    ...(options.pinning
      ? {
          pinJson: createCenterPinJson(store, options.pinning),
          pinLogo: createCenterPinLogo(store, options.pinning),
        }
      : {}),
  });
  return { config, services };
}
