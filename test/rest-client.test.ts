import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SignedRestClient, accountIdFor, createBotRegistration, exactRequestUrl, newRequestNonce,
  parseBotRegistration, prepareSignedRequest, type PreparedRequest, type RestSigner,
} from "../src/rest/client/index.js";
import {
  createRestAuth, createRestAuthRouter, MemoryAccountStore, readRequestClaims,
  REST_AUTH_HEADERS as H, verifyBotProof, verifyRequestSignature, type SignedRequestInput,
} from "../src/rest/auth/index.js";
import { accountsPage } from "../src/rest/web/page.js";
import type { BotScope } from "../src/rest/auth/store.js";

const owner = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const bot = privateKeyToAccount(`0x${"02".padStart(64, "0")}`);
const audience = "https://juicebox.center";
const accountId = accountIdFor(owner.address, 1);
const now = 1_900_000_000;
const config = { audience, accountId, signer: owner, now: () => now };
function input(request: PreparedRequest): SignedRequestInput {
  return { method: request.method, requestTarget: request.claims.requestTarget,
    contentType: request.headers.get("content-type") ?? "", body: request.body, headers: request.headers };
}

describe("signed REST client request binding", () => {
  it("sends exact query order, escape casing, content type, and raw UTF-8 body bytes", async () => {
    const bytes = new TextEncoder().encode('{ "memo": "café", "amount": "9007199254740993" }\n');
    const prepared = await prepareSignedRequest(config, { method: "POST", requestTarget: "/api/v1/test?z=%2f&z=%2F&a=+", body: bytes, contentType: "application/json; charset=utf-8", idempotencyKey: "job:123" });
    const parsed = readRequestClaims(input(prepared));
    await verifyRequestSignature(audience, parsed.claims, parsed.signature);
    expect(prepared.url).toBe(`${audience}/api/v1/test?z=%2f&z=%2F&a=+`);
    expect(parsed.claims.bodyHash).toBe(keccak256(bytes));
    for (const change of [
      { requestTarget: "/api/v1/test?a=+&z=%2f&z=%2F" },
      { requestTarget: "/api/v1/test?z=%2F&z=%2F&a=+" },
      { method: "PUT" },
      { body: new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)))) },
    ]) {
      const changed = readRequestClaims({ ...input(prepared), ...change });
      await expect(verifyRequestSignature(audience, changed.claims, changed.signature)).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    }
  });

  it.each(["//elsewhere.example/path", "/a/../b", "/%2e%2e/b", "/a\\b", "/a#secret", "/a?", "/a?space= ", "/a?bad=%q0"])("rejects a target the HTTP stack would alter: %s", (target) => {
    expect(() => exactRequestUrl(audience, target)).toThrow();
  });

  it("serializes JSON once, signs fresh nonces for retries, and retains the idempotency key", async () => {
    let serializations = 0;
    const requests: SignedRequestInput[] = [];
    const client = new SignedRestClient({ ...config, fetch: async (url, init) => {
      expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
      const request: SignedRequestInput = { method: String(init?.method), requestTarget: String(url).slice(audience.length), headers: new Headers(init?.headers), contentType: new Headers(init?.headers).get("content-type") ?? "", body: new Uint8Array(init?.body as Uint8Array) };
      requests.push(request);
      const parsed = readRequestClaims(request); await verifyRequestSignature(audience, parsed.claims, parsed.signature);
      return Response.json(requests.length === 1 ? { error: { code: "BUSY" } } : { done: true }, { status: requests.length === 1 ? 503 : 200 });
    } });
    expect(await client.request({ method: "POST", requestTarget: "/api/v1/jobs", json: { toJSON() { serializations++; return { amount: "42" }; } }, idempotencyKey: "same-job", retries: 1 })).toEqual({ done: true });
    expect(serializations).toBe(1); expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toEqual(requests[1]!.body);
    expect(requests[0]!.headers.get(H.nonce)).not.toBe(requests[1]!.headers.get(H.nonce));
    expect(requests.map((request) => request.headers.get(H.idempotencyKey))).toEqual(["same-job", "same-job"]);
  });

  it("copies raw request bytes before asynchronous signing", async () => {
    const bytes = new TextEncoder().encode("original");
    const signer: RestSigner = {
      address: owner.address,
      signTypedData: async (data) => {
        bytes.fill(0);
        return data.primaryType === "CenterRequest" ? owner.signTypedData(data) : owner.signTypedData(data);
      },
    };
    const prepared = await prepareSignedRequest({ ...config, signer }, { method: "POST", requestTarget: "/api/v1/test", body: bytes });
    expect(new TextDecoder().decode(prepared.body)).toBe("original");
    const parsed = readRequestClaims(input(prepared)); await verifyRequestSignature(audience, parsed.claims, parsed.signature);
  });

  it("does not retry mutations without idempotency or proof-bound owner nonces", async () => {
    const client = new SignedRestClient({ ...config, fetch: async () => { throw new Error("Must not fetch"); } });
    await expect(client.request({ method: "POST", requestTarget: "/api/v1/test", json: {}, retries: 1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.request({ method: "POST", requestTarget: "/api/v1/accounts/me/bots", json: {}, retries: 1, nonce: newRequestNonce(), idempotencyKey: "registration" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("times out an in-flight fetch and reports unknown outcome without upstream details", async () => {
    const client = new SignedRestClient({ ...config, timeoutMs: 5, fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("secret upstream material")), { once: true });
    }) });
    await expect(client.request({ requestTarget: "/api/v1/accounts/me" })).rejects.toMatchObject({ code: "TIMEOUT", message: "The request timed out; its outcome may be unknown" });
  });

  it("lets one request outlive the client's bound when it says so, up to a minute", async () => {
    const aborted: number[] = [];
    const started = Date.now();
    const client = new SignedRestClient({ ...config, timeoutMs: 5, fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted.push(Date.now() - started); reject(new Error("upstream")); }, { once: true });
    }) });
    await expect(client.request({ requestTarget: "/api/v1/accounts/me", timeoutMs: 40 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(aborted[0]).toBeGreaterThanOrEqual(35);
    await expect(client.request({ requestTarget: "/api/v1/accounts/me", timeoutMs: 60_001 })).rejects.toThrow();
  });

  it("times out a stalled response body even when its cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const client = new SignedRestClient({ ...config, timeoutMs: 5, fetch: async () =>
      new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }) });
    await expect(client.request({ requestTarget: "/api/v1/accounts/me" })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retries a rejected response without waiting for its cancellation hook", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let requests = 0;
    const client = new SignedRestClient({ ...config, fetch: async () => ++requests === 1
      ? new Response(new ReadableStream({ cancel }), { status: 503 }) : Response.json({ ready: true }) });
    await expect(client.request({ requestTarget: "/api/v1/accounts/me", retries: 1 })).resolves.toEqual({ ready: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("identifies an initial API signing failure as unsent while preserving wallet cancellation details", async () => {
    let sends = 0;
    const rejection = Object.freeze(Object.assign(new Error("Wallet disconnected."), { name: "CenterWalletError", code: 4900 }));
    const client = new SignedRestClient({ ...config,
      signer: { address: owner.address, signTypedData: async () => { throw rejection; } },
      fetch: async () => { sends++; return Response.json({}); },
    });
    await expect(client.request({ method: "POST", requestTarget: "/api/v1/user-operations/test/submissions", json: {}, idempotencyKey: "same-send" }))
      .rejects.toMatchObject({ name: "CenterWalletError", code: 4900, message: "Wallet disconnected.", requestNotSent: true });
    expect(sends).toBe(0);
    expect(rejection).not.toHaveProperty("requestNotSent");
  });

  it("keeps an earlier uncertain send when the next retry's signature fails", async () => {
    let signatures = 0, sends = 0;
    const client = new SignedRestClient({ ...config,
      signer: { address: owner.address, signTypedData: async document => {
        if (++signatures > 1) throw Object.assign(new Error("Canceled"), { code: 4001, requestNotSent: true });
        return document.primaryType === "CenterRequest" ? owner.signTypedData(document) : owner.signTypedData(document);
      } },
      fetch: async () => { sends++; throw new Error("Lost response"); },
    });
    await expect(client.request({ method: "POST", requestTarget: "/api/v1/user-operations/test/submissions", json: {}, idempotencyKey: "same-send", retries: 1 }))
      .rejects.toMatchObject({ code: 4001, requestNotSent: false });
    expect(sends).toBe(1);
  });

  it("does not accept a remote claim that an admitted request was unsent", async () => {
    const client = new SignedRestClient({ ...config,
      fetch: async () => Response.json({ code: "DENIED", requestNotSent: true }, { status: 403 }),
    });
    const error = await client.request({ requestTarget: "/api/v1/accounts/me" }).catch(error => error);
    expect(error).toMatchObject({ code: "DENIED" });
    expect(error).not.toHaveProperty("requestNotSent");
  });

  it("bounds response bytes and never echoes server error messages", async () => {
    const oversized = new SignedRestClient({ ...config, maxResponseBytes: 8, fetch: async () => Response.json({ data: "x".repeat(50) }) });
    await expect(oversized.request({ requestTarget: "/api/v1/accounts/me" })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    const failure = new SignedRestClient({ ...config, fetch: async () => Response.json({ error: { code: "DENIED", message: "private upstream token" } }, { status: 403 }) });
    await expect(failure.request({ requestTarget: "/api/v1/accounts/me" })).rejects.toMatchObject({ message: "The service rejected this request (403, DENIED)" });
  });

  it("keeps a served payment failure reason in its exact shape, and nothing else", async () => {
    const payFailure = { reason: "TERMINAL_UNDER_MIN", received: "812", minimum: "900", message: "This payment would get fewer tokens than your minimum, so lower your minimum or try again." };
    const served = (body: unknown) => new SignedRestClient({ ...config, fetch: async () => Response.json(body, { status: 502 }) })
      .request({ requestTarget: "/api/v1/accounts/me" }).then(() => undefined, (error: { payFailure?: unknown }) => error);
    const refused = await served({ code: "USER_OPERATION_PROVIDER_REJECTED", payFailure });
    expect(refused).toMatchObject({ code: "USER_OPERATION_PROVIDER_REJECTED", payFailure });
    expect((await served({ code: "X", payFailure: { ...payFailure, detail: "https://node.example/key" } }))?.payFailure).toBeUndefined();
  });
});

describe("public bot registration workflow", () => {
  it.each([
    { scopes: ["read"] as BotScope[] }, { scopes: ["read", "plan"] as BotScope[] }, { scopes: ["read", "plan", "relay"] as BotScope[] },
  ])("preserves the selected cumulative profile $scopes", async ({ scopes }) => {
    const proof = await createBotRegistration(audience, { accountId, botAddress: bot.address, scopes, label: "test profile", expiresAt: now + 3600, ownerRequestNonce: newRequestNonce() }, bot);
    expect(proof.registration.scopes).toEqual(scopes);
    expect(parseBotRegistration(proof).registration.scopes).toEqual(scopes);
  });

  it("rejects noncanonical scope arrays before signing or forwarding without expanding them", async () => {
    let signatures = 0;
    const signer: RestSigner = { address: bot.address, signTypedData: async () => { signatures++; throw new Error("Must not sign invalid scope intent"); } };
    const valid = await createBotRegistration(audience, { accountId, botAddress: bot.address, scopes: ["read"], label: "test", expiresAt: now + 3600, ownerRequestNonce: newRequestNonce() }, bot);
    for (const scopes of [[], ["plan"], ["relay"], ["read", "relay"], ["plan", "read"], ["read", "relay", "plan"], ["read", "read"], ["read", , "relay"]] as BotScope[][]) {
      await expect(createBotRegistration(audience, { accountId, botAddress: bot.address, scopes, label: "test", expiresAt: now + 3600, ownerRequestNonce: newRequestNonce() }, signer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(() => parseBotRegistration({ ...valid, registration: { ...valid.registration, scopes } })).toThrow();
    }
    expect(signatures).toBe(0);
  });

  it("enrolls, registers a locally-held bot key with the owner's exact nonce, and uses its grant", async () => {
    const auth = createRestAuth({ store: new MemoryAccountStore(), audience, now: () => now });
    const app = new Hono();
    app.route("/api/v1", createRestAuthRouter(auth, { requestTarget: (context) => { const url = new URL(context.req.url); return url.pathname + url.search; } }));
    const calls: string[] = [];
    const localFetch: typeof fetch = async (url, init) => {
      const bytes = init?.body instanceof Uint8Array ? init.body : new Uint8Array(); calls.push(new TextDecoder().decode(bytes));
      return app.request(String(url), init);
    };
    const client = new SignedRestClient({ ...config, fetch: localFetch });
    await client.request({ method: "POST", requestTarget: "/api/v1/accounts/enroll", json: {} });
    const proof = await createBotRegistration(audience, { accountId, botAddress: bot.address, scopes: ["read"], label: "test bot", expiresAt: now + 3600, ownerRequestNonce: newRequestNonce() }, bot);
    const result = await client.request<{ bot: { id: string } }>({ method: "POST", requestTarget: "/api/v1/accounts/me/bots", json: proof.registration, nonce: proof.ownerRequestNonce });
    const botClient = new SignedRestClient({ ...config, signer: bot, grantId: result.bot.id, fetch: localFetch });
    expect(await botClient.request({ requestTarget: "/api/v1/accounts/me" })).toMatchObject({ account: { id: accountId } });
    expect(calls.join("")).not.toContain('"privateKey"');
    expect(calls.join("")).not.toContain("0".repeat(63) + "2");
    await expect(verifyBotProof(audience, { accountId, botAddress: bot.address, scopes: ["read"], label: "test bot", expiresAt: now + 3600, ownerRequestNonce: newRequestNonce() }, proof.registration.proofSignature)).rejects.toMatchObject({ code: "INVALID_BOT_PROOF" });
  });

  it("rejects private-key fields instead of forwarding them from pasted registration JSON", async () => {
    const proof = await createBotRegistration(audience, { accountId, botAddress: bot.address, scopes: ["read"], label: "test", expiresAt: now + 3600, ownerRequestNonce: newRequestNonce() }, bot);
    expect(() => parseBotRegistration({ ...proof, privateKey: "do-not-upload" })).toThrow();
    expect(() => parseBotRegistration({ ...proof, registration: { ...proof.registration, privateKey: "do-not-upload" } })).toThrow();
    expect(parseBotRegistration(JSON.parse(JSON.stringify(proof)))).toEqual(proof);
  });

  it("escapes server configuration in the account page", () => {
    const html = accountsPage({ audience: '"><script>alert(1)</script>' });
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain("·");
  });
});
