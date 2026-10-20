import { getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import {
  buildBotProofTypedData, buildRequestTypedData, newRequestNonce, parseAccountId,
  REST_AUTH_HEADERS as H, validateAudience, type BotProof, type RequestClaims,
} from "../auth/signatures.js";
import { isCanonicalGrantScopes, type BotScope } from "../auth/shared.js";
import type { PayFailure } from "../userOperations/types.js";

export { accountIdFor, newRequestNonce, REST_AUTH_HEADERS } from "../auth/signatures.js";
export { isCanonicalGrantScopes } from "../auth/shared.js";
export {
  buildTransactionApprovalTypedData, buildSponsorshipApprovalTypedData, sponsorshipSubmissionHash,
  type TransactionApproval, type TransactionApprovalBinding, type TransactionApprovalClaims,
  type SponsorshipApproval, type SponsorshipApprovalBinding, type SponsorshipApprovalClaims,
} from "../approvals.js";
export type TypedDocument = ReturnType<typeof buildRequestTypedData> | ReturnType<typeof buildBotProofTypedData>;
export * from "./smartAccounts.js";
export type { CenterWalletExpectedPayment, CenterWalletPaymentInput, CenterWalletPaymentState, CenterWalletPaymentStatus } from './walletPayments.js';
export { userOperationMaximumCost } from '../userOperations/codec.js';
export type RestSigner = {
  address: Address;
  /** Required only for locally signing operations under an activated bot wallet permission. */
  signMessage?(input: { message: { raw: Hex } }): Promise<Hex>;
  signTypedData: {
    (document: ReturnType<typeof buildRequestTypedData>): Promise<Hex>;
    (document: ReturnType<typeof buildBotProofTypedData>): Promise<Hex>;
  };
};
export type RequestOptions = {
  method?: string;
  /** Exact ASCII origin-form path including its already-encoded query. */
  requestTarget: string;
  json?: unknown;
  /** Raw bytes and json are mutually exclusive. Bytes are copied before signing. */
  body?: Uint8Array;
  contentType?: string;
  idempotencyKey?: string;
  /** Reserved for a bot proof bound to this owner's nonce. Such requests cannot auto-retry. */
  nonce?: Hex;
  retries?: number;
  /** A request the server holds on purpose (a waiting read) gets its own bound, at most 60 s. */
  timeoutMs?: number;
};
export type ClientOptions = {
  audience: string;
  accountId: string;
  signer: RestSigner;
  grantId?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
};
export class RestClientError extends Error {
  /** Why a payment the service refused would revert, when its calls say: the payer can adjust and retry. */
  readonly payFailure?: PayFailure;
  constructor(readonly code: string, message: string, readonly status?: number, payFailure?: PayFailure) {
    super(message); this.name = "RestClientError";
    if (payFailure) this.payFailure = payFailure;
  }
}
const amount = (value: unknown) => value === undefined
  || (typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n);
/** A served payment failure reason, kept only in its exact shape: an SDK reason, its plain sentence
 * (letters and punctuation only, so no URL, hex or node text can pass) and integer amounts. */
export function payFailureOf(value: unknown): PayFailure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { reason, received, minimum, message, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || typeof reason !== "string" || !/^[A-Z][A-Z_]{0,63}$/.test(reason) || typeof message !== "string"
    || !/^[A-Za-z][A-Za-z ,.'’]{0,299}$/.test(message) || !amount(received) || !amount(minimum)) return undefined;
  return { reason, message, ...(received === undefined ? {} : { received: received as string }),
    ...(minimum === undefined ? {} : { minimum: minimum as string }) };
}
function invalid(message: string): never { throw new RestClientError("INVALID_INPUT", message); }
export function clientAudience(value: string): string {
  const audience = validateAudience(value);
  const url = new URL(audience);
  if (url.origin !== audience) return invalid("Use the exact service origin as the audience");
  return audience;
}
export function exactRequestUrl(audience: string, requestTarget: string): string {
  if (requestTarget.length > 4096 || !/^\/(?!\/)[\x21-\x7e]*$/.test(requestTarget)
    || /[#\\]/.test(requestTarget) || /%(?![0-9a-fA-F]{2})/.test(requestTarget)) {
    return invalid("Use an exact encoded path and query without a fragment");
  }
  const url = `${clientAudience(audience)}${requestTarget}`;
  const parsed = new URL(url);
  // Fetch applies WHATWG URL parsing. Reject a target it would change BEFORE signing.
  if (parsed.origin !== audience || `${parsed.pathname}${parsed.search}` !== requestTarget) {
    return invalid("The request target would be normalized by the HTTP client");
  }
  return url;
}
function documentBytes(options: RequestOptions): { body: Uint8Array; contentType: string; method: string } {
  if (options.json !== undefined && options.body !== undefined) return invalid("Supply JSON or raw bytes, not both");
  const method = options.method ?? "GET";
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) return invalid("Use an uppercase HTTP method");
  let body: Uint8Array;
  if (options.json !== undefined) {
    const encoded = JSON.stringify(options.json);
    if (encoded === undefined) return invalid("The JSON body cannot be encoded");
    body = new TextEncoder().encode(encoded);
  } else body = options.body?.slice() ?? new Uint8Array();
  if (body.byteLength > 2 * 1024 * 1024) return invalid("Request body exceeds the client limit");
  if ((method === "GET" || method === "HEAD") && body.length) return invalid("GET and HEAD requests cannot carry a body");
  const contentType = options.contentType ?? (options.json === undefined ? "" : "application/json");
  if (contentType.length > 256 || /[\r\n\0]/.test(contentType) || new Headers({ "content-type": contentType }).get("content-type") !== contentType) {
    return invalid("Invalid exact content type");
  }
  return { body, contentType, method };
}
export type PreparedRequest = {
  url: string; method: string; headers: Headers; body: Uint8Array; claims: RequestClaims;
};
async function signBytes(config: ClientOptions, options: RequestOptions, bytes: ReturnType<typeof documentBytes>): Promise<PreparedRequest> {
  const audience = clientAudience(config.audience);
  const url = exactRequestUrl(audience, options.requestTarget);
  parseAccountId(config.accountId);
  if (!isAddress(config.signer.address)) return invalid("Invalid signer address");
  const issuedAt = config.now?.() ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 1) return invalid("Invalid client clock");
  const nonce = options.nonce ?? newRequestNonce();
  if (!/^0x[0-9a-f]{64}$/.test(nonce)) return invalid("Invalid request nonce");
  const idempotencyKey = options.idempotencyKey ?? "";
  if (idempotencyKey && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) return invalid("Invalid idempotency key");
  const grantId = config.grantId ?? "";
  if (grantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grantId)) return invalid("Invalid bot grant ID");
  const claims: RequestClaims = {
    accountId: config.accountId, signer: getAddress(config.signer.address), grantId,
    method: bytes.method, requestTarget: options.requestTarget, contentType: bytes.contentType,
    bodyHash: keccak256(bytes.body), issuedAt, expiresAt: issuedAt + 300, nonce, idempotencyKey,
  };
  const signature = await config.signer.signTypedData(buildRequestTypedData(audience, claims));
  const headers = new Headers({
    [H.account]: claims.accountId, [H.signer]: claims.signer, [H.issuedAt]: String(issuedAt),
    [H.expiresAt]: String(claims.expiresAt), [H.nonce]: nonce, [H.signature]: signature,
    accept: "application/json",
  });
  if (bytes.contentType) headers.set("content-type", bytes.contentType);
  if (grantId) headers.set(H.grant, grantId);
  if (idempotencyKey) headers.set(H.idempotencyKey, idempotencyKey);
  return { url, method: bytes.method, body: bytes.body, headers, claims };
}
/** Produces one signed request. The caller must send these exact bytes and URL. */
export async function prepareSignedRequest(config: ClientOptions, options: RequestOptions): Promise<PreparedRequest> {
  return signBytes(config, options, documentBytes(options));
}
async function boundedJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) {
    void response.body?.cancel().catch(() => undefined);
    throw new RestClientError("RESPONSE_TOO_LARGE", "Response exceeds the client limit");
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
    void response.body?.cancel().catch(() => undefined);
    throw new RestClientError("INVALID_RESPONSE", "Expected a JSON response", response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RestClientError("INVALID_RESPONSE", "The response body is missing", response.status);
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new RestClientError("RESPONSE_TOO_LARGE", "Response exceeds the client limit");
      chunks.push(value);
    }
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RestClientError("INVALID_RESPONSE", "The response is not valid JSON", response.status); }
}
/** Reads public discovery endpoints without asking the wallet for an authentication signature. */
export async function readPublicRestJson<T>(audience: string, requestTarget: string, transport: typeof fetch = fetch): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await transport(exactRequestUrl(clientAudience(audience), requestTarget), {
      headers: { accept: "application/json" }, redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
    });
    const result = await boundedJson(response, 2 * 1024 * 1024, controller.signal);
    if (!response.ok) throw new RestClientError("DISCOVERY_UNAVAILABLE", "This host has not enabled the requested wallet capability.", response.status);
    return result as T;
  } catch (error) {
    if (error instanceof RestClientError) throw error;
    throw new RestClientError("DISCOVERY_UNAVAILABLE", "Wallet discovery could not be loaded.");
  } finally { clearTimeout(timer); }
}
export class SignedRestClient {
  private readonly config: ClientOptions;
  constructor(config: ClientOptions) {
    this.config = { ...config, audience: clientAudience(config.audience) };
    parseAccountId(config.accountId);
  }
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const retries = options.retries ?? 0;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs ?? 15_000;
    const maxBytes = this.config.maxResponseBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 2 || (options.nonce !== undefined && retries > 0)) return invalid("Use at most two retries; proof-bound requests cannot auto-retry");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024) return invalid("Invalid client limits");
    // Serialize exactly once. Every retry signs a new nonce over the same body and idempotency key.
    const bytes = documentBytes(options);
    if (retries && !["GET", "HEAD"].includes(bytes.method) && !options.idempotencyKey) return invalid("Mutation retries require an idempotency key");
    for (let attempt = 0; ; attempt++) {
      let prepared: PreparedRequest;
      try { prepared = await signBytes(this.config, options, bytes); }
      catch (error) {
        // A later retry may follow an unknown send. Only the first signing failure proves no dispatch.
        const failure = error instanceof RestClientError
          ? new RestClientError(error.code, error.message, error.status)
          : new Error(error instanceof Error ? error.message : "The API request could not be signed.");
        if (error && typeof error === "object") {
          if ("name" in error && typeof error.name === "string") failure.name = error.name;
          if ("code" in error && ["number", "string"].includes(typeof error.code))
            Object.defineProperty(failure, "code", { value: error.code, enumerable: true });
        }
        Object.defineProperty(failure, "requestNotSent", { value: attempt === 0, enumerable: true });
        throw failure;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await (this.config.fetch ?? fetch)(prepared.url, {
          method: prepared.method, headers: prepared.headers,
          ...(prepared.body.length ? { body: prepared.body as BodyInit } : {}),
          redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
        });
        if ([408, 429, 502, 503, 504].includes(response.status) && attempt < retries) {
          void response.body?.cancel().catch(() => undefined); continue;
        }
        const result = await boundedJson(response, maxBytes, controller.signal);
        if (!response.ok) {
          const error = result && typeof result === "object" && "error" in result ? result.error : result;
          const code = error && typeof error === "object" && "code" in error
            && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "REQUEST_FAILED";
          throw new RestClientError(code, `The service rejected this request (${response.status}, ${code})`, response.status,
            payFailureOf(error && typeof error === "object" && "payFailure" in error ? error.payFailure : undefined));
        }
        return result as T;
      } catch (error) {
        if (error instanceof RestClientError) throw error;
        if (attempt >= retries) throw new RestClientError(controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR", controller.signal.aborted ? "The request timed out; its outcome may be unknown" : "The request did not complete; its outcome may be unknown");
      } finally { clearTimeout(timer); }
    }
  }
}

export type BotRegistration = {
  format: "juicebox-center-bot-registration-v1";
  audience: string;
  accountId: string;
  ownerRequestNonce: Hex;
  registration: { botAddress: Address; scopes: BotScope[]; expiresAt: number; label: string; proofSignature: Hex };
};
export async function createBotRegistration(audience: string, proof: BotProof, signer: RestSigner): Promise<BotRegistration> {
  if (!isCanonicalGrantScopes(proof.scopes)) return invalid("Choose exactly read, read + plan, or read + plan + relay in that order");
  if (proof.botAddress.toLowerCase() !== signer.address.toLowerCase()) return invalid("The bot signer must match the registration address");
  const proofSignature = await signer.signTypedData(buildBotProofTypedData(audience, proof));
  return parseBotRegistration({
    format: "juicebox-center-bot-registration-v1", audience: clientAudience(audience),
    accountId: proof.accountId, ownerRequestNonce: proof.ownerRequestNonce,
    registration: { botAddress: proof.botAddress, scopes: [...proof.scopes], expiresAt: proof.expiresAt, label: proof.label, proofSignature },
  });
}
/** Accepts public proof documents only. Private key fields are rejected, never forwarded. */
export function parseBotRegistration(value: unknown): BotRegistration {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  if (!object(value) || Object.keys(value).some((key) => !["format", "audience", "accountId", "ownerRequestNonce", "registration"].includes(key))
    || value.format !== "juicebox-center-bot-registration-v1" || typeof value.audience !== "string" || typeof value.accountId !== "string"
    || typeof value.ownerRequestNonce !== "string" || !/^0x[0-9a-f]{64}$/.test(value.ownerRequestNonce) || !object(value.registration)) return invalid("Invalid public bot registration document");
  const r = value.registration;
  if (Object.keys(r).some((key) => !["botAddress", "scopes", "expiresAt", "label", "proofSignature"].includes(key))
    || typeof r.botAddress !== "string" || !isAddress(r.botAddress) || !isCanonicalGrantScopes(r.scopes)
    || !Number.isSafeInteger(r.expiresAt) || Number(r.expiresAt) < 1 || typeof r.label !== "string" || new TextEncoder().encode(r.label).length > 120
    || typeof r.proofSignature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(r.proofSignature)) return invalid("Invalid public bot proof fields");
  parseAccountId(value.accountId);
  return {
    format: "juicebox-center-bot-registration-v1", audience: clientAudience(value.audience), accountId: value.accountId,
    ownerRequestNonce: value.ownerRequestNonce as Hex,
    registration: { botAddress: getAddress(r.botAddress), scopes: [...r.scopes], expiresAt: Number(r.expiresAt), label: r.label, proofSignature: r.proofSignature as Hex },
  };
}

export { CenterClient, type Plan, type ActionSigner, type TransactionSubmission, type PrepaidPreparation, type PrepaidSubmission } from "./center.js";
export { parseConnection, connectionForBot, type BotConnection } from "./connection.js";
export { createCenterWalletClient, type CenterWalletClientOptions, type CenterWalletConnection,
  type CenterWalletPreparedConnection, type CenterWalletStorage } from "./wallet.js";
