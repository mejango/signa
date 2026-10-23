import { bodyLimit } from "hono/body-limit";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import Busboy from "busboy";
import { Readable, Transform } from "node:stream";
import { isHex, size, verifyMessage, type Address, type Hex } from "viem";
import { authenticate } from "./auth.js";
import { FAVICON_SVG } from "./branding.js";
import {
  DeploymentVerificationError,
  type DeploymentVerifier,
} from "./deploymentVerifier.js";
import {
  address,
  callsForChain,
  contentHash,
  IntentValidationError,
  normalizeEnvelope,
  signingMessage,
} from "./intent.js";
import { extractMetadata } from "./metadata.js";
import {
  HOMEPAGE_CSS,
  HOMEPAGE_CSS_PATH,
  HOMEPAGE_HEADERS,
  HOMEPAGE_HTML,
  HOMEPAGE_JS_PATH,
} from "./homepage.js";
import { HOMEPAGE_JS } from "./directoryClient.js";
import { Metrics } from "./observability.js";
import { createIpfsGateway } from "./ipfsGateway.js";
import type { IpfsDiskCache } from "./ipfsCache.js";
import {
  parseRpcRequest,
  RPC_BODY_LIMIT,
  RpcBadRequest,
  type RpcGateway,
  RpcUnavailable,
} from "./rpc.js";
import {
  PIN_LIMITS,
  type PinResult,
  type PinningService,
} from "./ipfs.js";
import {
  ConflictError,
  StorageLimitError,
  type StorageLimits,
  type StorageUsage,
  type Store,
} from "./store.js";
import { LaneError } from "./sponsor/chain.js";
import {
  isSponsoredChain,
  sponsoredChains,
  sponsorFamily,
  type SponsorRuntime,
} from "./sponsor/policy.js";
import { reservationWei } from "./rest/sponsorCaps.js";
import type { Intent, JbcenterEnv } from "./types.js";
import { mountRestSite, type RestSite } from "./rest/site.js";
import { createWalletHostMatcher } from "./walletHosts.js";
import { llmsIndex } from "./llms.js";
import { JUICESCAN } from "./journeyGraph.js";
import { originsForEnvironment } from "./firstParty.js";
export { originsForEnvironment } from "./firstParty.js";

const MAX_BODY_BYTES = 16_800_000;

export const ALLOWED_ORIGINS = originsForEnvironment();
const PIN_WINDOW_SECONDS = 10 * 60;
const PIN_PER_CALLER = 10;
const PIN_PER_SITE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TX_HASH = /^0x[0-9a-f]{64}$/iu;
/** Both sponsored-deploy refusals reset on a rolling day. */
const RETRY_AFTER_SECONDS = "86400";
/** A relay costs Center one RPC pass, so it has its own hourly allowance. */
const RELAY_PER_REQUESTER_PER_HOUR = 30;
const RETRY_AFTER_HOUR = "3600";

class BadRequest extends Error {}
class PayloadTooLarge extends Error {}
class UnsupportedMedia extends Error {}
class PinFailed extends Error {}

export type AppOptions = {
  rest?: RestSite;
  /** Reserve credential origins even before their wallet runtime is enabled. */
  walletOrigins?: readonly string[];
  allowedOrigins?: readonly string[];
  deploymentVerifier?: DeploymentVerifier;
  requestLimitPerMinute?: number;
  maxIntentsPerClient?: number;
  maxStorageBytesPerClient?: number;
  /** The co-hosted MCP stores under one identity, so it carries its own lifetime caps. */
  mcpMaxIntents?: number;
  mcpMaxStorageBytes?: number;
  metricsToken?: string;
  metrics?: Metrics;
  pinning?: PinningService;
  gatewayFetch?: typeof fetch;
  ipfsCache?: IpfsDiskCache;
  maxMediaBytes?: number;
  rpc?: RpcGateway;
  rpcRequestLimitPerMinute?: number;
  rpcSiteLimitPerMinute?: number;
  /** Keyless RPC from any origin (IPFS-hosted sites like juicescan): per-IP and shared budgets. */
  rpcPublicRequestLimitPerMinute?: number;
  rpcPublicSiteLimitPerMinute?: number;
  publishPerPublisherPerDay?: number;
  publishPerIpPerHour?: number;
  sponsor?: SponsorRuntime;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequest("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function json(c: Context): Promise<Record<string, unknown>> {
  try {
    return record(await c.req.json());
  } catch (error) {
    if (error instanceof BadRequest) throw error;
    throw new BadRequest("Request body must be valid JSON");
  }
}

/** A route whose body is optional: an empty request is an empty object. */
async function optionalJson(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.text();
  if (!body.trim()) return {};
  try {
    return record(JSON.parse(body));
  } catch (error) {
    if (error instanceof BadRequest) throw error;
    throw new BadRequest("Request body must be valid JSON");
  }
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) {
    throw new BadRequest(`${name} must be a positive safe integer`);
  }
  return Number(parsed);
}

/** Every chain of one intent is deployed by one sender. Center signs each chain it deploys
 * or relays as a forward request from its sponsor, so a deployment that was not forwarded
 * came from a wallet, and no chain of that intent can be signed by the sponsor any more. */
function walletDeployed(intent: Intent): boolean {
  return intent.deployments.some((deployment) => !deployment.forwarded);
}

const MIXED_SENDER = {
  error: {
    code: "mixed_sender",
    message: "A wallet already deployed a chain of this intent; deploy the rest from it",
  },
} as const;

function optionalChainIds(value: unknown, within: number[]): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new BadRequest("chainIds must contain between 1 and 16 chains");
  }
  const chainIds = value.map((chainId) => positiveInteger(chainId, "chainIds"));
  if (new Set(chainIds).size !== chainIds.length) {
    throw new BadRequest("chainIds must contain unique chains");
  }
  if (chainIds.some((chainId) => !within.includes(chainId))) {
    throw new BadRequest("chainIds must be part of this intent");
  }
  return chainIds;
}

function projectId(value: unknown): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d{0,77}$/u.test(text)) {
    throw new BadRequest("projectId must be a positive decimal string");
  }
  return text;
}

function signature(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value) || ![64, 65].includes(size(value))) {
    throw new BadRequest("signature must be a 64- or 65-byte hex signature");
  }
  return value;
}

function cursor(value: string | undefined): number {
  if (!value) return 0;
  if (!/^\d+$/u.test(value)) throw new BadRequest("cursor is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new BadRequest("cursor is invalid");
  return parsed;
}

function optionalAddress(value: string | undefined, name: string): Address | undefined {
  if (value === undefined) return undefined;
  try {
    return address(value, name);
  } catch {
    throw new BadRequest(`${name} must be an Ethereum address`);
  }
}

/** Four fifths of either lifetime cap is the operator's cue to raise it before publishes refuse. */
function reportStorageUsage(client: string, usage: StorageUsage, limits: StorageLimits): void {
  if (usage.intents * 5 < limits.maxIntents * 4 && usage.bytes * 5 < limits.maxBytes * 4) return;
  console.warn(JSON.stringify({
    level: "warn",
    service: "center",
    message: "storage_near_limit",
    client,
    intents: usage.intents,
    maxIntents: limits.maxIntents,
    bytes: usage.bytes,
    maxBytes: limits.maxBytes,
  }));
}

/** The co-hosted MCP's in-process caller identity, and the shared requester its deploys spend. */
export const MCP_CLIENT = "mcp";
/**
 * True only for the co-hosted MCP's in-process call. Hono hands the second `app.fetch` argument
 * through as `c.env`; the Node adapter supplies its own bindings, so a network request cannot
 * carry this marker however it shapes its headers.
 */
function internalCall(c: Context<JbcenterEnv>): boolean {
  return c.env?.internal === MCP_CLIENT;
}

const pinPath = (path: string) => path.startsWith("/v1/pins/");
const rpcPath = (path: string) => path.startsWith("/v1/rpc/");
function callerIp(c: Context): string {
  return (
    c.req.header("x-real-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  ).slice(0, 128);
}

function pinPayload(result: PinResult) {
  return {
    ...result,
    uri: `ipfs://${result.cid}`,
    gatewayUrl: `/ipfs/${result.cid}`,
  };
}

async function multipartFile(c: Context, maxBytes: number): Promise<File> {
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new BadRequest("Request body must be multipart form data");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new BadRequest("A file field is required");
  if (file.size < 1 || file.size > maxBytes) {
    throw new PayloadTooLarge(`file must contain 1-${maxBytes} bytes`);
  }
  return file;
}

function mediaAllowed(type: string, name: string): boolean {
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type === "application/pdf" ||
    type.startsWith("text/") ||
    /\.(?:md|markdown|txt)$/iu.test(name)
  );
}

async function streamMedia(
  c: Context,
  pinning: PinningService,
  maxBytes: number,
): Promise<PinResult> {
  const body = c.req.raw.body;
  if (!body) throw new BadRequest("A multipart request body is required");

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: Object.fromEntries(c.req.raw.headers.entries()),
      // Busboy emits `limit` when the configured byte count is reached. Give it
      // one sentinel byte so an exactly-at-limit file remains valid.
      // The count-limit events fire when the configured count is reached, so
      // use one sentinel slot and enforce the single `file` part ourselves.
      limits: { files: 2, fields: 1, parts: 2, fileSize: maxBytes + 1 },
    });
  } catch {
    throw new BadRequest("Request body must be multipart form data");
  }

  const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
  const uploadController = new AbortController();
  const signal = AbortSignal.any([c.req.raw.signal, uploadController.signal]);
  return new Promise<PinResult>((resolve, reject) => {
    let fileSeen = false;
    let fileBytes = 0;
    let settled = false;
    let upload: Promise<PinResult> | null = null;
    let counted: Transform | undefined;
    const abort = () => fail(new BadRequest("Request was cancelled"));

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      uploadController.abort(error);
      source.unpipe(parser);
      source.destroy();
      // Busboy still uses its current file after emitting events such as `limit`.
      // Destroy it once that callback has returned, while aborting the upload now.
      queueMicrotask(() => parser.destroy(error));
      counted?.destroy(error);
      reject(error);
    };

    parser.on("file", (field, file, info) => {
      file.once("error", (error) => {
        counted?.destroy(error);
        fail(new BadRequest("Invalid multipart body"));
      });
      if (settled) {
        file.resume();
        return;
      }
      if (field !== "file" || fileSeen) {
        file.resume();
        fail(new BadRequest("Exactly one file field is required"));
        return;
      }
      fileSeen = true;
      if (!mediaAllowed(info.mimeType, info.filename)) {
        file.resume();
        fail(new UnsupportedMedia("Images, video, audio, PDF, or text only"));
        return;
      }
      // Count bytes inside the pipeline rather than with a `data` listener: a
      // listener would put the part into flowing mode and drain it before the
      // uploader starts pulling, so Filebase would receive an empty body.
      counted = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          fileBytes += chunk.byteLength;
          callback(null, chunk);
        },
      });
      counted.once("error", fail);
      file.once("limit", () => {
        const error = new PayloadTooLarge(`file must not exceed ${maxBytes} bytes`);
        file.destroy(error);
        counted!.destroy(error);
        fail(error);
      });
      file.pipe(counted);
      upload = pinning.pinStream(counted, "media", info.mimeType, signal);
      void upload.catch(() => fail(new PinFailed("Failed to pin media")));
    });
    parser.on("field", () => fail(new BadRequest("Only the file field is allowed")));
    parser.once("filesLimit", () => fail(new BadRequest("Exactly one file is allowed")));
    parser.once("fieldsLimit", () => fail(new BadRequest("Only the file field is allowed")));
    parser.once("partsLimit", () => fail(new BadRequest("Exactly one file field is required")));
    parser.once("error", () => fail(new BadRequest("Invalid multipart body")));
    source.once("error", (error) => fail(error));
    parser.once("close", async () => {
      if (settled) return;
      if (!fileSeen || !upload) {
        fail(new BadRequest("A file field is required"));
        return;
      }
      if (fileBytes === 0) {
        fail(new PayloadTooLarge(`file must contain 1-${maxBytes} bytes`));
        return;
      }
      try {
        const result = await upload;
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(result);
      } catch (error) {
        fail(error instanceof PinFailed ? error : new PinFailed("Failed to pin media"));
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else source.pipe(parser);
  });
}

export function createApp(
  store: Store,
  options: AppOptions = {},
): Hono<JbcenterEnv> {
  const app = new Hono<JbcenterEnv>();
  const metrics = options.metrics ?? new Metrics();
  const allowedOrigins = options.allowedOrigins ?? ALLOWED_ORIGINS;

  app.onError((error, c) => {
    if (error instanceof BadRequest || error instanceof IntentValidationError) {
      return c.json({ error: { code: "bad_request", message: error.message } }, 400);
    }
    if (error instanceof PayloadTooLarge) {
      return c.json({ error: { code: "body_too_large", message: error.message } }, 413);
    }
    if (error instanceof UnsupportedMedia) {
      return c.json({ error: { code: "unsupported_media", message: error.message } }, 415);
    }
    if (error instanceof PinFailed) {
      return c.json({ error: { code: "pin_failed", message: error.message } }, 502);
    }
    if (error instanceof RpcBadRequest) {
      return c.json({ error: { code: "rpc_bad_request", message: error.message } }, 400);
    }
    if (error instanceof RpcUnavailable) {
      return c.json({ error: { code: "rpc_unavailable", message: error.message } }, 502);
    }
    if (error instanceof ConflictError) {
      return c.json({ error: { code: "conflict", message: error.message } }, 409);
    }
    if (error instanceof DeploymentVerificationError) {
      return c.json({ error: { code: "deployment_unverified", message: error.message } }, 422);
    }
    if (error instanceof StorageLimitError) {
      return c.json({ error: { code: "storage_limit", message: error.message } }, 429);
    }
    console.error(JSON.stringify({ level: "error", message: "request_failed", error: error.message }));
    return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
  });

  app.use("*", metrics.middleware());
  // Dynamic responses stay out of intermediary caches; public assets opt in below.
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  const walletOrigins = [...(options.rest?.walletOrigins ?? []), ...(options.walletOrigins ?? [])];
  const walletHost = createWalletHostMatcher(walletOrigins);
  // DNS may be attached before the wallet runtime is activated. Reserve its credential
  // origin even then: legacy Accounts and IPFS must never execute on this host.
  app.use('*', async (c, next) => {
    if (!options.rest?.wallet && (walletHost(new URL(c.req.url).host) || walletHost(c.req.header('Host')))) {
      return c.text('Juicebox wallet setup is in progress. Please try again later.', 503, {
        'Cache-Control': 'no-store', 'Retry-After': '60', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
    }
    await next();
  });

  if (options.rest) mountRestSite(app, { ...options.rest, walletOrigins });

  app.get("/", (c) => c.html(HOMEPAGE_HTML, 200, HOMEPAGE_HEADERS));
  app.get("/favicon.svg", (c) => c.body(FAVICON_SVG, 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  }));
  app.get("/llms.txt", (c) => c.text(llmsIndex(options.rest?.audience), 200, {
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  }));
  // Stable cross-site links follow the same reviewed deployment as the directory.
  app.get("/inspect/:chain/:project", (c) => {
    const chain = c.req.param("chain");
    const project = c.req.param("project");
    if (!["eth", "op", "base", "arb", "sep", "opsep", "basesep", "arbsep"].includes(chain)
      || !/^[1-9]\d{0,15}$/.test(project)
      || !Number.isSafeInteger(Number(project))) {
      return c.text("Use a supported chain slug and a positive safe-integer project ID.", 400);
    }
    c.header("Cache-Control", "public, max-age=300");
    return c.redirect(`${JUICESCAN}#${chain}:${project}`, 302);
  });
  app.get(HOMEPAGE_CSS_PATH, (c) => c.body(HOMEPAGE_CSS, 200, {
    ...HOMEPAGE_HEADERS,
    "Content-Type": "text/css; charset=UTF-8",
  }));
  app.get(HOMEPAGE_JS_PATH, (c) => c.body(HOMEPAGE_JS, 200, {
    ...HOMEPAGE_HEADERS,
    "Content-Type": "application/javascript; charset=UTF-8",
  }));

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/readyz", async (c) => {
    await store.health();
    return c.json({ ok: true });
  });

  app.get("/metrics", (c) => {
    if (
      !options.metricsToken ||
      !authenticate(options.metricsToken, c.req.header("authorization"))
    ) {
      return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    }
    return c.text(metrics.render(), 200, { "Content-Type": "text/plain; version=0.0.4" });
  });

  const ipfsGateway = createIpfsGateway({
    ...(options.gatewayFetch ? { fetcher: options.gatewayFetch } : {}),
    ...(options.ipfsCache ? { cache: options.ipfsCache } : {}),
  });
  app.on(["GET", "HEAD"], "/ipfs/*", (c) => ipfsGateway(c.req.raw));

  app.use("/v1/*", async (c, next) => {
    if (internalCall(c)) {
      // A publish refines this to the verified publisher; a sponsored deploy spends the shared bucket.
      c.set("client", MCP_CLIENT);
      await next();
      return;
    }
    const origin = c.req.header("origin");
    const trustedOrigin = origin && allowedOrigins.some((allowed) => allowed === origin);
    if (!trustedOrigin) {
      // The read-only RPC gateway is open to any origin — sites served from IPFS have no stable
      // origin to allowlist — under its own tighter budgets, keyed by IP.
      if (rpcPath(c.req.path)) {
        c.set("client", `public:${callerIp(c)}`);
        await next();
        return;
      }
      return c.json(
        { error: { code: "forbidden_origin", message: "Origin is not allowed" } },
        403,
      );
    }
    c.set("client", `browser:${new URL(origin!).hostname}:${callerIp(c)}`);
    await next();
  });
  app.use(
    "/v1/*",
    cors({
      origin: (origin, c) =>
        allowedOrigins.some((allowed) => allowed === origin)
          ? origin
          : rpcPath(c.req.path)
            ? "*"
            : null,
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      maxAge: 86_400,
    }),
  );
  const intentBodyLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ error: { code: "body_too_large", message: "Request body is too large" } }, 413),
  });
  app.use("/v1/intents", intentBodyLimit);
  app.use("/v1/intents/*", intentBodyLimit);
  app.use(
    "/v1/pins/json",
    bodyLimit({
      maxSize: PIN_LIMITS.json,
      onError: (c) =>
        c.json({ error: { code: "body_too_large", message: "Request body is too large" } }, 413),
    }),
  );
  app.use(
    "/v1/pins/file",
    bodyLimit({
      maxSize: PIN_LIMITS.image + PIN_LIMITS.multipartOverhead,
      onError: (c) =>
        c.json({ error: { code: "body_too_large", message: "Request body is too large" } }, 413),
    }),
  );
  app.use(
    "/v1/rpc/*",
    bodyLimit({
      maxSize: RPC_BODY_LIMIT,
      onError: (c) =>
        c.json({ error: { code: "body_too_large", message: "Request body is too large" } }, 413),
    }),
  );
  app.use("/v1/*", async (c, next) => {
    const pin = pinPath(c.req.path);
    const rpc = rpcPath(c.req.path);
    const publicRpc = rpc && c.get("client").startsWith("public:");
    const limit = pin
      ? PIN_PER_CALLER
      : publicRpc
        ? (options.rpcPublicRequestLimitPerMinute ?? 120)
        : rpc
          ? (options.rpcRequestLimitPerMinute ?? 600)
          : (options.requestLimitPerMinute ?? 600);
    const client = c.get("client");
    const windowSeconds = pin ? PIN_WINDOW_SECONDS : 60;
    const result = await store.consumeRequest(pin ? `pin:${client}` : rpc ? `rpc:${client}` : client, limit, windowSeconds);
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      c.header("Retry-After", String(windowSeconds));
      return c.json(
        { error: { code: "rate_limit", message: "Request limit exceeded" } },
        429,
      );
    }
    if (pin) {
      const site = await store.consumeRequest("pin:site", PIN_PER_SITE, PIN_WINDOW_SECONDS);
      if (!site.allowed) {
        c.header("Retry-After", String(PIN_WINDOW_SECONDS));
        return c.json(
          { error: { code: "pin_budget", message: "The shared pin budget is spent" } },
          429,
        );
      }
    }
    if (rpc) {
      // Public traffic spends its own shared budget so it can never starve the trusted sites.
      const site = await store.consumeRequest(
        publicRpc ? "rpc:public" : "rpc:site",
        publicRpc
          ? (options.rpcPublicSiteLimitPerMinute ?? 5_000)
          : (options.rpcSiteLimitPerMinute ?? 20_000),
        60,
      );
      if (!site.allowed) {
        c.header("Retry-After", "60");
        return c.json(
          { error: { code: "rpc_budget", message: "The shared RPC budget is spent" } },
          429,
        );
      }
    }
    await next();
  });

  app.post("/v1/rpc/:chainId", async (c) => {
    if (!options.rpc) {
      return c.json({ error: { code: "unavailable", message: "RPC gateway is unavailable" } }, 503);
    }
    let value: unknown;
    try {
      value = await c.req.json();
    } catch {
      throw new RpcBadRequest("Request body must be valid JSON");
    }
    const request = parseRpcRequest(value);
    const result = await options.rpc.request(positiveInteger(c.req.param("chainId"), "chainId"), request);
    return c.body(JSON.stringify(result), 200, { "Content-Type": "application/json" });
  });

  app.post("/v1/pins/json", async (c) => {
    if (!options.pinning) {
      return c.json({ error: { code: "unavailable", message: "IPFS pinning is unavailable" } }, 503);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new BadRequest("Request body must be valid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequest("Request body must be a JSON object");
    }
    try {
      const result = await options.pinning.pin(
        new Blob([bytes], { type: "application/json" }),
        "metadata.json",
        c.req.raw.signal,
      );
      return c.json(pinPayload(result), 201);
    } catch {
      return c.json({ error: { code: "pin_failed", message: "Failed to pin JSON" } }, 502);
    }
  });

  app.post("/v1/pins/file", async (c) => {
    if (!options.pinning) {
      return c.json({ error: { code: "unavailable", message: "IPFS pinning is unavailable" } }, 503);
    }
    const file = await multipartFile(c, PIN_LIMITS.image);
    if (!file.type.startsWith("image/")) {
      return c.json({ error: { code: "unsupported_media", message: "Only images are allowed" } }, 415);
    }
    try {
      return c.json(pinPayload(await options.pinning.pin(file, "image", c.req.raw.signal)), 201);
    } catch {
      return c.json({ error: { code: "pin_failed", message: "Failed to pin image" } }, 502);
    }
  });

  app.post("/v1/pins/media", async (c) => {
    if (!options.pinning) {
      return c.json({ error: { code: "unavailable", message: "IPFS pinning is unavailable" } }, 503);
    }
    return c.json(
      pinPayload(
        await streamMedia(c, options.pinning, options.maxMediaBytes ?? PIN_LIMITS.media),
      ),
      201,
    );
  });

  app.post("/v1/intents/message", async (c) => {
    const envelope = normalizeEnvelope(await json(c));
    const hash = contentHash(envelope);
    return c.json({ contentHash: hash, message: signingMessage(hash), envelope });
  });

  app.post("/v1/intents", async (c) => {
    const body = await json(c);
    const envelope = normalizeEnvelope(body);
    const hash = contentHash(envelope);
    const publisher = address(body.publisher, "publisher");
    const signed = signature(body.signature);
    const valid = await verifyMessage({
      address: publisher,
      message: signingMessage(hash),
      signature: signed,
    });
    if (!valid) throw new BadRequest("signature does not match publisher and project intent");
    // The co-hosted MCP is one caller of the publish and deploy budgets, not a browser per visitor.
    // In process there is no caller address to charge and a publisher key is free to mint, so an
    // internal publish spends a shared hourly bucket as well as a per-publisher one: the shared
    // bucket, and the shared storage identity below, bound the whole MCP surface.
    const internal = internalCall(c);
    if (internal) c.set("client", `${MCP_CLIENT}:${publisher.toLowerCase()}`);
    const hourly = internal
      ? [`publish:${MCP_CLIENT}:${publisher.toLowerCase()}`, `publish:${MCP_CLIENT}`]
      : [`publish:ip:${callerIp(c)}`];
    const spent = await Promise.all(
      hourly.map((key) => store.consumeRequest(key, options.publishPerIpPerHour ?? 60, 3600)),
    );
    const who = await store.consumeRequest(`publish:${publisher.toLowerCase()}`, options.publishPerPublisherPerDay ?? 20, 86_400);
    if (spent.some((budget) => !budget.allowed) || !who.allowed) {
      c.header("Retry-After", who.allowed ? "3600" : "86400");
      return c.json({ error: { code: "publish_limit", message: "Publish limit reached; try again later" } }, 429);
    }
    // One storage identity for every internal publish, so the lifetime intent and byte caps
    // bound the MCP as a whole rather than one free-to-mint publisher key at a time. That whole
    // is wider than one browser client, so it is measured against its own pair of caps.
    const submittedBy = internal ? MCP_CLIENT : c.get("client");
    const limits: StorageLimits = internal
      ? {
          maxIntents: options.mcpMaxIntents ?? 100_000,
          maxBytes: options.mcpMaxStorageBytes ?? 10_737_418_240,
        }
      : {
          maxIntents: options.maxIntentsPerClient ?? 10_000,
          maxBytes: options.maxStorageBytesPerClient ?? 1_073_741_824,
        };
    const result = await store.createIntent({
      ...extractMetadata(envelope.jb),
      contentHash: hash,
      envelope,
      publisher,
      signature: signed,
      submittedBy,
      jbBytes: Buffer.byteLength(JSON.stringify(envelope)),
    }, limits);
    if (result.usage) reportStorageUsage(submittedBy, result.usage, limits);
    return c.json(result.intent, result.created ? 201 : 200);
  });

  app.get("/v1/intents/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new BadRequest("intent id is invalid");
    const intent = await store.getIntent(id);
    return intent
      ? c.json(intent)
      : c.json({ error: { code: "not_found", message: "Intent not found" } }, 404);
  });

  app.get("/v1/search", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (query.length > 200) throw new BadRequest("q must not exceed 200 characters");
    const rawLimit = c.req.query("limit") ?? "20";
    const limit = positiveInteger(rawLimit, "limit");
    if (limit > 100) throw new BadRequest("limit must not exceed 100");
    const owner = optionalAddress(c.req.query("owner"), "owner");
    const publisher = optionalAddress(c.req.query("publisher"), "publisher");
    return c.json(
      await store.search(query, limit, cursor(c.req.query("cursor")), {
        ...(owner ? { owner } : {}),
        ...(publisher ? { publisher } : {}),
      }),
    );
  });

  app.post("/v1/intents/:id/deployments", async (c) => {
    if (!options.deploymentVerifier) {
      return c.json(
        { error: { code: "unavailable", message: "Deployment verification is not configured" } },
        503,
      );
    }
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new BadRequest("intent id is invalid");
    const intent = await store.getIntent(id);
    if (!intent) return c.json({ error: { code: "not_found", message: "Intent not found" } }, 404);
    const body = await json(c);
    const chainId = positiveInteger(body.chainId, "chainId");
    if (!intent.envelope.chainIds.includes(chainId)) {
      throw new BadRequest("chainId is not part of this intent");
    }
    // A self-paid claim proves the launch transaction; earlier calls only create Safes.
    const call = callsForChain(intent.envelope.deploymentCalls, chainId).launch;
    if (!call) {
      throw new DeploymentVerificationError("Intent has no deployment call for this chain");
    }
    if (typeof body.transactionHash !== "string" || !TX_HASH.test(body.transactionHash)) {
      throw new BadRequest("transactionHash must be a 32-byte hex value");
    }
    const claim = {
      chainId,
      projectId: projectId(body.projectId),
      transactionHash: body.transactionHash as Hex,
      deploymentVersion: intent.envelope.deploymentVersion,
      call,
    };
    const { forwarded } = await options.deploymentVerifier.verify(claim);
    const deployment = await store.recordDeployment(id, {
      chainId,
      projectId: claim.projectId,
      transactionHash: claim.transactionHash,
      forwarded,
    });
    return c.json(deployment, 201);
  });

  app.post("/v1/intents/:id/relay", async (c) => {
    const sponsor = options.sponsor;
    if (!sponsor?.relay || sponsor.policy.paused) {
      return c.json({ error: { code: "unavailable", message: "Relay requests are paused" } }, 503);
    }
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new BadRequest("intent id is invalid");
    const intent = await store.getIntent(id);
    if (!intent) return c.json({ error: { code: "not_found", message: "Intent not found" } }, 404);
    const chainId = positiveInteger((await json(c)).chainId, "chainId");
    if (!intent.envelope.chainIds.includes(chainId)) {
      throw new BadRequest("chainId is not part of this intent");
    }
    if (intent.deployments.some((deployment) => deployment.chainId === chainId)) {
      throw new BadRequest("chainId already has a deployment");
    }
    if (walletDeployed(intent)) return c.json(MIXED_SENDER, 409);
    // Center deploys a sponsored chain itself. Handing out a second signed request for one
    // would put a visitor and the sponsor lane on the same forwarder nonce.
    if (isSponsoredChain(chainId)) {
      return c.json(
        {
          error: {
            code: "sponsored_chain",
            message: "Center deploys this chain; request a deploy",
          },
        },
        400,
      );
    }
    const allowance = await store.consumeRequest(
      `relay:${c.get("client")}`,
      RELAY_PER_REQUESTER_PER_HOUR,
      3600,
    );
    if (!allowance.allowed) {
      return c.json(
        { error: { code: "relay_limit", message: "Relay request limit reached; try again later" } },
        429,
        { "Retry-After": RETRY_AFTER_HOUR },
      );
    }
    try {
      return c.json(await sponsor.relay(intent, chainId), 200);
    } catch (error) {
      // Node and forwarder failures carry request URLs and signed bytes; only the code travels.
      console.warn(JSON.stringify({
        level: "warn",
        service: "center",
        message: "relay_unavailable",
        chainId,
        error: error instanceof LaneError ? (error.code ?? "lane error") : "relay error",
      }));
      return c.json(
        { error: { code: "relay_unavailable", message: "Center could not prepare this chain" } },
        503,
      );
    }
  });

  app.post("/v1/intents/:id/deploy", async (c) => {
    const sponsor = options.sponsor;
    if (!sponsor || sponsor.policy.paused) {
      return c.json(
        { error: { code: "unavailable", message: "Sponsored deploys are paused" } },
        503,
      );
    }
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new BadRequest("intent id is invalid");
    const intent = await store.getIntent(id);
    if (!intent) return c.json({ error: { code: "not_found", message: "Intent not found" } }, 404);
    if (walletDeployed(intent)) return c.json(MIXED_SENDER, 409);
    const requested = optionalChainIds((await optionalJson(c)).chainIds, intent.envelope.chainIds);
    const deployed = new Set(intent.deployments.map((deployment) => deployment.chainId));
    if (requested?.some((chainId) => deployed.has(chainId))) {
      throw new BadRequest("chainIds must name chains with no deployment");
    }
    if (requested?.some((chainId) => !isSponsoredChain(chainId))) {
      throw new BadRequest("chainIds must name chains Center sponsors");
    }
    // A chain Center does not sponsor is deployed through the relay route, and a chain that is
    // already deployed is done: either way it is nothing this request can queue.
    const selected = sponsoredChains(requested ?? intent.envelope.chainIds).filter(
      (chainId) => !deployed.has(chainId),
    );
    if (!selected.length) throw new BadRequest("intent has no sponsored chain left to deploy");
    if (!sponsorFamily(selected)) throw new BadRequest("intent chains are not sponsorable");
    const queued = intent.deploys.filter((deploy) => selected.includes(deploy.chainId));
    // A named chain that failed is asked for again, so its row counts as absent and the retry is
    // reserved, budgeted and rated like a first request. An unnamed one keeps its failure.
    const retryable = (chainId: number) =>
      requested !== undefined &&
      intent.deploys.some((deploy) => deploy.chainId === chainId && deploy.status === "failed");
    const fresh = selected.filter(
      (chainId) =>
        !intent.deploys.some((deploy) => deploy.chainId === chainId) || retryable(chainId),
    );
    if (!fresh.length) return c.json({ deploys: queued }, 200);
    const requester = c.get("client");
    const reserved = reservationWei(
      sponsor.policy,
      intent.envelope.deploymentCalls.filter((call) => fresh.includes(call.chainId)).length,
    );
    const since = new Date(Date.now() - 86_400_000);
    const budgetSpent = { error: { code: "sponsor_budget", message: "The daily sponsorship budget is spent" } };
    // The co-hosted MCP is one requester with no caller to charge, so it draws on its own slice of
    // the day's budget first: a busy assistant cannot spend what first-party apps are waiting for.
    if (requester === MCP_CLIENT) {
      const mcpSpent = await store.sponsoredWeiSince(since, MCP_CLIENT);
      if (mcpSpent + reserved > sponsor.policy.mcpDailyBudgetWei) {
        return c.json(budgetSpent, 429, { "Retry-After": RETRY_AFTER_SECONDS });
      }
    }
    const spent = await store.sponsoredWeiSince(since);
    // The budget is checked before the quota so a budget refusal costs the requester nothing.
    if (spent + reserved > sponsor.policy.dailyBudgetWei) {
      return c.json(budgetSpent, 429, { "Retry-After": RETRY_AFTER_SECONDS });
    }
    const quota = await store.consumeRequest(
      `deploy:${requester}`,
      sponsor.policy.perRequesterPerDay,
      86_400,
    );
    if (!quota.allowed) {
      return c.json(
        { error: { code: "sponsor_quota", message: "Daily sponsored deploy quota reached" } },
        429,
        { "Retry-After": RETRY_AFTER_SECONDS },
      );
    }
    const deploys = await store.queueDeploys(
      id,
      fresh,
      requester,
      reserved / BigInt(fresh.length),
      requested !== undefined,
    );
    sponsor.kick();
    return c.json({ deploys: deploys.filter((deploy) => selected.includes(deploy.chainId)) }, 202);
  });

  return app;
}
