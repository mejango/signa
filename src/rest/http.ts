import { createHash, randomUUID } from "node:crypto";
import type { Context } from "hono";
import { DomainError } from "@juicebox/mcp/host";
import { RestAuthError, type SignedRequestInput } from "./auth/index.js";
import { ContractCatalogError } from "./contracts/catalog.js";
import { RestError } from "./core.js";
import { IndexerError } from "./indexer/index.js";

export const REST_PREFIX = "/api/v1";
export const REST_LIMITS = Object.freeze({
  bodyBytes: 1_048_576,
  responseBytes: 5_242_880,
  targetBytes: 4096,
  timeoutMs: 60_000,
  requestsPerMinute: 300,
  siteRequestsPerMinute: 10_000,
  maxConcurrentRequests: 64,
});

export function requestTarget(context: Context): string {
  const incoming = (context.env as { incoming?: { url?: string } } | undefined)
    ?.incoming;
  if (incoming?.url !== undefined) return incoming.url;
  // Unit tests and non-Node adapters have no IncomingMessage. Production always
  // uses the raw Node request target so signatures never rely on URL rewriting.
  const url = new URL(context.req.url);
  return url.pathname + url.search;
}

export function validateTarget(raw: string): void {
  if (
    raw.length > REST_LIMITS.targetBytes ||
    !raw.startsWith(REST_PREFIX) ||
    /[\s\\#\u0000-\u001f]/.test(raw)
  ) {
    throw new RestError(
      400,
      "INVALID_REQUEST_TARGET",
      "The request target is invalid or too long",
    );
  }
  const path = raw.split("?")[0]!;
  if (/%(?:2f|5c)/i.test(path) || /%(?![0-9a-f]{2})/i.test(raw)) {
    throw new RestError(
      400,
      "INVALID_REQUEST_TARGET",
      "Encoded path separators and malformed escapes are unsupported",
    );
  }
  const url = new URL(raw, "https://juicebox.center");
  if (url.pathname + url.search !== raw) {
    throw new RestError(
      400,
      "NONCANONICAL_REQUEST_TARGET",
      "Use the exact request path and query that the HTTP client will send",
    );
  }
}

export function query(
  context: Context,
  allowed: readonly string[],
): URLSearchParams {
  const params = new URLSearchParams(
    requestTarget(context).split("?").slice(1).join("?"),
  );
  for (const name of params.keys()) {
    if (!allowed.includes(name) || params.getAll(name).length !== 1) {
      throw new RestError(
        400,
        "INVALID_QUERY",
        "Query parameters must be supported and appear exactly once",
        { parameter: name },
      );
    }
  }
  return params;
}

export function required(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null || value === "")
    throw new RestError(
      400,
      "MISSING_PARAMETER",
      `The ${name} parameter is required`,
    );
  return value;
}

export function integer(
  value: string,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > maximum
  ) {
    throw new RestError(
      400,
      "INVALID_INTEGER",
      `The ${name} parameter must be an exact bounded integer`,
    );
  }
  return Number(value);
}

export function jsonValue(value: string, name = "input"): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RestError(
      400,
      "INVALID_JSON",
      `The ${name} value must be valid JSON`,
    );
  }
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 30_000 || depth > 32)
      throw new RestError(
        400,
        "JSON_TOO_COMPLEX",
        "JSON nesting or complexity exceeds the supported limit",
      );
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value)))
    ) {
      throw new RestError(
        400,
        "UNSAFE_JSON_NUMBER",
        "Use decimal strings for exact amounts and large integers",
      );
    }
    if (value && typeof value === "object") {
      if (Array.isArray(value))
        for (const item of value) visit(item, depth + 1);
      else
        for (const [key, item] of Object.entries(value)) {
          if (["__proto__", "constructor", "prototype"].includes(key))
            throw new RestError(
              400,
              "RESERVED_JSON_KEY",
              "Reserved object keys are unsupported",
            );
          visit(item, depth + 1);
        }
    }
  };
  visit(parsed, 0);
  return parsed;
}

export function object(
  value: unknown,
  allowed?: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RestError(400, "INVALID_OBJECT", "Expected a JSON object");
  if (allowed && Object.keys(value).some((key) => !allowed.includes(key)))
    throw new RestError(
      400,
      "UNKNOWN_FIELD",
      "The request contains an unsupported field",
    );
  return value as Record<string, unknown>;
}

export function jsonBody(input: SignedRequestInput): Record<string, unknown> {
  if (
    input.contentType.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new RestError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "This endpoint requires application/json",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.body);
  } catch {
    throw new RestError(400, "INVALID_UTF8", "JSON must use valid UTF-8");
  }
  return object(jsonValue(text));
}

/** Stable operation identity excludes the per-attempt nonce and signature. */
export function requestHash(input: SignedRequestInput): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([input.method, input.requestTarget, input.contentType]),
  );
  hash.update(new Uint8Array([0]));
  hash.update(input.body);
  return hash.digest("hex");
}

export function response(
  context: Context,
  value: unknown,
  status = 200,
): Response {
  const body = JSON.stringify(value, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  if (Buffer.byteLength(body) > REST_LIMITS.responseBytes)
    throw new RestError(
      502,
      "RESPONSE_TOO_LARGE",
      "Narrow the query or request a smaller page",
    );
  return context.newResponse(body, status as 200, {
    "Content-Type": "application/json; charset=utf-8",
  });
}

export function problem(error: Error, context: Context): Response {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let detail = "The operation could not be completed";
  let retryable = false;
  let payFailure: unknown;
  if (
    error instanceof RestError ||
    error instanceof RestAuthError ||
    error instanceof IndexerError
  ) {
    ({ status, code } = error);
    detail = error.message;
    // A payment's failure reason is built only from decoded revert data (userOperations/payFailure.ts).
    if (error instanceof RestError) payFailure = (error.details as { payFailure?: unknown } | undefined)?.payFailure;
    retryable =
      error instanceof IndexerError
        ? error.retryable
        : status === 429 || status >= 502;
  } else if (error instanceof ContractCatalogError) {
    code = error.code;
    status = /NOT_FOUND/.test(code) ? 404 : /CATALOG_/.test(code) ? 500 : 400;
    detail = status === 500 ? detail : error.message;
  } else if (error instanceof DomainError) {
    code = error.code;
    status = /NOT_FOUND/.test(code)
      ? 404
      : code === "RATE_LIMITED"
        ? 429
        : /UPSTREAM|RPC|INDEXER/.test(code)
          ? 502
          : /UNSUPPORTED|NOT_SUPPORTED|UNVERIFIED|UNAVAILABLE/.test(code)
            ? 422
            : 400;
    detail = error.message;
    retryable = error.retryable;
  } else if (error.name === "ZodError") {
    status = 400;
    code = "INVALID_INPUT";
    detail = "Input does not match the operation schema; see its catalog entry";
  } else if (error.name === "AbortError" || error.name === "TimeoutError") {
    status = 504;
    code = "REQUEST_TIMEOUT";
    detail = "The request was cancelled or exceeded its deadline";
    retryable = true;
  }
  const requestId = context.res.headers.get("X-Request-Id") ?? randomUUID();
  context.set("errorCode", code);
  // A user-operation codec message names only the field it refused; it carries no request data.
  if (code.startsWith("INVALID_USER_OPERATION")) context.set("errorDetail", detail);
  if (status === 429) context.header("Retry-After", "60");
  // Error details may contain calldata, signatures, or upstream request data.
  // Typed public error codes and bounded messages are the portable contract.
  return context.newResponse(
    JSON.stringify({
      type: `https://juicebox.center/api#${code.toLowerCase()}`,
      title: code.replaceAll("_", " ").toLowerCase(),
      status,
      detail,
      code,
      requestId,
      retryable,
      ...(payFailure ? { payFailure } : {}),
    }),
    status as 400,
    {
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  );
}
