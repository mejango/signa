// Actual HTTP controllers, signed REST authentication, PostgreSQL lifecycle stores and P256.
// Readiness and stored V6 execution plans are explicitly synthetic fixtures. No EVM/provider,
// physical passkey, browser cookie enforcement or payment settlement is claimed by this suite.
import { createServer, request as httpRequest, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from 'viem/accounts';
import { walletHandoffLaunchDocument } from '../src/rest/wallet/handoff.js';
import { migrate } from "../src/db/migrate.js";
import { PostgresStore } from "../src/db/postgres.js";
import { createRestApp, type RestDependencies } from "../src/rest/app.js";
import { createRestAuth } from "../src/rest/auth/service.js";
import { PostgresAccountStore } from "../src/rest/auth/postgres.js";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";
import { TransactionService } from "../src/rest/transactions/service.js";
import { PostgresTransactionStore } from "../src/rest/transactions/postgres.js";
import { createCenterWalletClient } from "../src/rest/client/index.js";
import { createWalletSite } from "../src/rest/wallet/site.js";
import { walletFlowCookie, walletSessionCookie, walletLaunchCookie } from "../src/rest/wallet/http.js";
import { PostgresWalletLoginStore } from "../src/rest/wallet/loginPostgres.js";
import { PostgresWalletHandoffStore } from "../src/rest/wallet/handoffPostgres.js";
import { PostgresWalletPolicyStore } from "../src/rest/wallet/policyPostgres.js";
import { PostgresWalletAuthorityStore } from "../src/rest/wallet/authorityPostgres.js";
import { PostgresWalletAuthorityRefreshQueue } from "../src/rest/wallet/authorityRefreshPostgres.js";
import { createWalletAuthorityRefresh } from "../src/rest/wallet/authorityRefresh.js";
import { walletAuthorityContextDigest, walletAuthorityExpectedAnchor } from "../src/rest/wallet/authority.js";
import { PostgresWalletPaymentReviewStore } from "../src/rest/wallet/paymentReviewsPostgres.js";
import { walletAppPrincipalId, type WalletAppGrant } from "../src/rest/wallet/appGrants.js";
import type { WalletPaymentAppPublic, WalletPaymentCentralPublic } from "../src/rest/wallet/paymentPublic.js";
import { verifyWalletAssertion, type WalletAssertion } from "../src/rest/wallet/webauthn.js";
import { encodeSafe7579PasskeyOwnerSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import { userOperationCommitment } from "../src/rest/userOperations/codec.js";
import { createWalletLoginSetup, walletLoginFixtureOrigin as issuer, walletLoginFixtureRpId as rpId } from "./fixtures/wallet-login-setup.js";
import { signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { prepareWalletPaymentFixtureOperation, walletPaymentFixtureManifest as manifest,
  walletPaymentFixtureToken as token, walletPaymentFixtureTerminal as terminal } from "./fixtures/wallet-payment-setup.js";

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const schema = `wallet_payment_http_${randomUUID().replaceAll("-", "")}`;
const audience = "https://juicebox.center", appOrigin = "https://beep.biz", otherOrigin = "https://juicebox.money";
const reviewPath = "/api/v1/wallet/payment-reviews";
let admin: Pool, pool: Pool;
const servers: Server[] = [], workers: ReturnType<typeof createWalletAuthorityRefresh>[] = [];

class CookieJar {
  private readonly values = new Map<string, string>();
  accept(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0]!, separator = pair.indexOf("="), name = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (/;\s*Max-Age=0(?:;|$)/i.test(raw)) this.values.delete(name); else this.values.set(name, value);
    }
  }
  value(name: string) { return this.values.get(name) ?? null; }
  header() { return [walletFlowCookie, walletSessionCookie, walletLaunchCookie].flatMap(name => this.values.has(name) ? [`${name}=${this.values.get(name)}`] : []).join("; "); }
}
/** Native HTTP preserves the configured TLS proxy Host. Cookie/Origin headers are explicit
 * in this fixture; Chromium separately proves browser behavior. Dropped bodies destroy the
 * actual incoming socket stream after response headers, never replace a successful mock. */
function httpFetch(url: string, init: RequestInit = {}, dropBody = false): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)),
      signal: init.signal ?? AbortSignal.timeout(15_000) }, response => {
      const headers = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
      if (dropBody) {
        response.destroy();
        resolve(new Response(new ReadableStream({ start(controller) { controller.error(new Error("Fixture response disconnected")); } }),
          { status: response.statusCode!, headers })); return;
      }
      let bytes = 0; const chunks: Buffer[] = [];
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 65_536) request.destroy(new Error("Fixture response exceeded bound")); else chunks.push(Buffer.from(chunk)); });
      response.on("error", reject);
      response.on("end", () => resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode!, headers })));
    });
    request.on("error", reject);
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== "string" && !(init.body instanceof Uint8Array)) { request.destroy(); reject(new Error("Unexpected fixture body")); return; }
      request.write(init.body);
    }
    request.end();
  });
}
async function listen(app: Hono) {
  const server = createServer(getRequestListener(app.fetch)); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture listener failed");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture server did not close")), 5000);
    server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
  });
}
function encodeAssertion(assertion: WalletAssertion) {
  return { ...assertion, authenticatorData: Buffer.from(assertion.authenticatorData).toString("base64url"),
    clientDataJSON: Buffer.from(assertion.clientDataJSON).toString("base64url"), signature: Buffer.from(assertion.signature).toString("base64url") };
}
async function counts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM rest_wallet_payment_reviews) AS reviews,
    (SELECT count(*)::int FROM rest_wallet_payment_reviews WHERE status='approved') AS approved,
    (SELECT count(*)::int FROM rest_wallet_ceremonies WHERE purpose='payment' AND consumed_at IS NOT NULL) AS consumed,
    (SELECT count(*)::int FROM rest_user_operation_nonces) AS nonces`)).rows[0];
}
async function start() {
  const setup = await createWalletLoginSetup(pool, { manifest }), policy = new PostgresWalletPolicyStore(pool);
  await policy.activate({ expectedRevision: 0, nextRevision: 1, configuration: { version: "center-wallet-policy-v1",
    applications: [appOrigin, otherOrigin].map(origin => ({ origin, walletCallbacks: [`${origin}/wallet/callback`] })) } });
  const authority = new PostgresWalletAuthorityStore(pool);
  let observations = 0;
  const refresh = createWalletAuthorityRefresh({ queue: new PostgresWalletAuthorityRefreshQueue(pool), concurrency: 1,
    // Only this canonical-observer boundary is synthetic; queue leases and reconciliation are real.
    service: { async refreshAuthority(accountId) {
      const context = await authority.loadContext(accountId), observedAtMs = Date.now();
      const expected = walletAuthorityExpectedAnchor(context), identity = context.prior?.identity;
      if (!identity) throw new Error("Synthetic observer requires genuinely enrolled identity");
      const blockNumber = (BigInt(context.prior?.highestObservedBlock ?? "100") + 1n).toString(); observations++;
      return authority.reconcile(context, { version: "center-wallet-authority-observation-v1", accountId,
        contextDigest: walletAuthorityContextDigest(context), observedAtMs, validUntilMs: observedAtMs + 30_000,
        head: { chainId: 8453, blockNumber, blockHash: keccak256(toHex(`payment-http-synthetic-${blockNumber}`)),
          timestamp: String(Math.floor(observedAtMs / 1000)), source: "onchain" },
        priorAnchor: { status: expected ? "same" : "none", expected, observed: expected }, identity, eligibility: "matched", reason: null });
    } } }); workers.push(refresh);
  const payments = new PostgresWalletPaymentReviewStore(pool, { issuer, audience, token, directV6Terminal: terminal, manifestFor: () => manifest });
  const events: Array<{ action: string; outcome: string; code?: string }> = [];
  const site = createWalletSite({ origin: issuer, audience, browserScript: "", policy, refresh, payments,
    login: new PostgresWalletLoginStore(pool, { rpId, origin: issuer }), handoff: new PostgresWalletHandoffStore(pool, { issuer, audience }),
    onEvent: event => events.push(event) });
  const central = await listen(site), contracts = await getContractCatalog();
  const rpc = { async request(): Promise<never> { throw new Error("No chain/provider calls are permitted in this HTTP fixture"); } };
  const unavailable = (): never => { throw new Error("Unrelated protocol operation is not part of this fixture"); };
  const operations: RestDependencies["operations"] = { list: () => [], prepare: async () => unavailable() };
  const api = await listen(new Hono().route("/api/v1", createRestApp({
    auth: createRestAuth({ store: new PostgresAccountStore(pool), audience }), quota: new PostgresStore(pool), contracts,
    operations,
    transactions: new TransactionService({ store: new PostgresTransactionStore(pool), rpc }), walletPayments: payments,
  })));
  const post = (path: string, body: unknown, jar?: CookieJar, headers: Record<string, string> = {}, dropBody = false) => httpFetch(central + path, {
    method: "POST", headers: { host: new URL(issuer).host, origin: issuer, "sec-fetch-site": "same-origin",
      "x-center-wallet-request": "1", "content-type": "application/json", ...(jar?.header() ? { cookie: jar.header() } : {}), ...headers },
    body: JSON.stringify(body) }, dropBody);
  const get = (path: string, jar?: CookieJar) => httpFetch(central + path, { headers: { host: new URL(issuer).host,
    ...(jar?.header() ? { cookie: jar.header() } : {}) } });
  async function login(identity = setup) {
    const jar = new CookieJar(), begun = await post("/wallet/login/begin", {}, jar);
    expect(begun.status).toBe(201); jar.accept(begun); const challenge = await begun.json();
    const assertion = signGet({ ...identity.credential, rpId, origin: issuer,
      challenge: `0x${Buffer.from(challenge.publicKey.challenge, "base64url").toString("hex")}` });
    const response = await post("/wallet/login/complete", { loginId: challenge.loginId, assertion: encodeAssertion(assertion) }, jar,
      { "x-center-wallet-csrf": challenge.csrfToken });
    expect(response.status).toBe(200); jar.accept(response); const body = await response.json();
    expect(body.session.accountId).toBe(identity.accountId);
    return { jar, csrf: body.csrfToken as string, identity };
  }
  const requests: Array<{ method: string; path: string; origin: string; cookie: boolean }> = [];
  async function connect(session: Awaited<ReturnType<typeof login>>, origin = appOrigin) {
    const storage = new Map<string, string>(), callbackUri = `${origin}/wallet/callback`;
    let location = callbackUri;
    const transport: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      if (![issuer, audience].includes(target.origin)) throw new Error("Unconfigured fixture transport origin");
      expect(init?.credentials).toBe("omit");
      const headers = new Headers(init?.headers); headers.set("host", target.host); headers.set("origin", origin);
      headers.set("sec-fetch-site", "cross-site");
      expect(headers.has("cookie")).toBe(false);
      requests.push({ method: init?.method ?? "GET", path: target.pathname, origin, cookie: headers.has("cookie") });
      return httpFetch((target.origin === issuer ? central : api) + target.pathname + target.search, { ...init, headers });
    };
    const wallet = createCenterWalletClient({ issuer, audience, callbackUri, fetch: transport,
      storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: key => { storage.delete(key); } },
      location: { href: () => location, replace: value => { location = value; } } });
    const prepared = await wallet.prepareConnection();
    // Native HTTP models the form transport; real Chromium covers the SDK's DOM launch.
    const pending = JSON.parse([...storage.values()][0]!);
    const signature = await privateKeyToAccount(pending.key).signTypedData(walletHandoffLaunchDocument({request:pending.request,intentId:prepared.intentId}));
    const launched = await httpFetch(central+'/wallet/launch',{method:'POST',headers:{host:new URL(issuer).host,origin,
      'sec-fetch-mode':'navigate','sec-fetch-dest':'document','content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({intentId:prepared.intentId,signature}).toString()});
    expect(launched.status).toBe(303);session.jar.accept(launched);
    const issued = await post("/wallet/authorize/issue", { intentId: prepared.intentId }, session.jar, { "x-center-wallet-csrf": session.csrf });
    expect(issued.status).toBe(200); const redirect = (await issued.json()).redirectUri as string;
    location = redirect; const connection = await wallet.completeConnection(redirect);
    expect(location).toBe(callbackUri); expect(connection.accountId).toBe(session.identity.accountId);
    // Public grant receipt selected after real HTTP exchange, solely for modeled row ownership.
    const grant = JSON.parse([...storage.values()][0]!).grant as WalletAppGrant;
    return { wallet, connection, payments: wallet.payments(), grant, actor: { accountId: connection.accountId, principalId: walletAppPrincipalId(grant) },
      location: () => location, navigate: (url: string) => { location = url; }, callbackUri };
  }
  return { setup, login, connect, post, get, events, requests, observations: () => observations };
}
async function reviewing(value: Awaited<ReturnType<typeof start>>, session: Awaited<ReturnType<Awaited<ReturnType<typeof start>>["login"]>>) {
  const app = await value.connect(session), prepared = await prepareWalletPaymentFixtureOperation(pool, app.actor, session.identity.binding);
  const pending = await app.payments.preparePayment(prepared.clientInput); expect(pending.status).toBe("reviewing");
  expect(pending.reviewId).not.toBeNull();
  const central = await value.get(`/wallet/payment-reviews/${pending.reviewId}`, session.jar); expect(central.status).toBe(200);
  const review = await central.json() as WalletPaymentCentralPublic;
  const assertion = signGet({ ...session.identity.credential, challenge: review.signing.digest, rpId, origin: issuer });
  return { ...app, ...prepared, pending, review, assertion };
}

suite("HTTP payment review with real PostgreSQL authority and the packaged wallet client", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    expect(Math.floor(Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10_000)).toBe(16);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=10000`,
      connectionTimeoutMillis: 5000, query_timeout: 10_000 }); await migrate(pool);
  }, 20_000);
  beforeEach(async () => {
    await pool.query("TRUNCATE rest_wallet_payment_reviews,rest_wallet_authority_refresh_jobs,rest_accounts,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies,rest_wallet_policy,rate_limits CASCADE");
  });
  afterEach(async () => {
    const stopped = await Promise.allSettled(workers.splice(0).map(worker => worker.stop()));
    const closed = await Promise.allSettled(servers.splice(0).map(close));
    for (const result of [...stopped, ...closed]) if (result.status === "rejected") throw result.reason;
  });
  afterAll(async () => {
    try { await pool?.end(); }
    finally { if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); } } }
  }, 15_000);

  it("connects through genuine HTTP handoff, prepares signed review, approves it by passkey with no Center session, and returns the exact P256 envelope only to the original app", async () => {
    const value = await start(), session = await value.login(), app = await reviewing(value, session);
    const path = `/wallet/payment-reviews/${app.pending.reviewId}/approve`;
    expect((await value.post(path, { assertion: encodeAssertion(app.assertion) }, undefined, { origin: appOrigin, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await counts()).toMatchObject({ reviews: 1, approved: 0, consumed: 0, nonces: 0 });
    // The page carries no cookie and no CSRF token: the review id and the passkey are the whole approval.
    const approved = await value.post(path, { assertion: encodeAssertion(app.assertion) });
    expect(approved.status).toBe(200); const receipt = await approved.json();
    app.navigate(receipt.redirectUri); expect(new URL(app.location()).searchParams.get("review")).toBe(app.pending.reviewId);
    expect((await app.payments.completePayment()).status).toBe("approved"); expect(app.location()).toBe(app.callbackUri);
    const result = await app.connection.client.request<WalletPaymentAppPublic>({ requestTarget: `${reviewPath}/${app.pending.reviewId}` });
    const proof = verifyWalletAssertion(app.assertion, { purpose: "payment", challenge: app.review.signing.digest, rpId, origin: issuer,
      credential: { id: value.setup.credential.credentialId, publicKey: value.setup.credential.publicKey,
        userHandle: value.setup.credential.userHandle, backupEligible: true }, requireUserHandle: true });
    const signature = encodeSafe7579PasskeyOwnerSignature({ ...app.review.signing,
      signatures: [{ kind: "contract", owner: value.setup.state.ownerProfile!.signer.address, signature: proof.contractSignature }] });
    expect(result.approval).toEqual({ signature, signedCommitment: userOperationCommitment({ ...app.record.operation, signature }, app.record.entryPoint, 8453) });
    for (const internal of ["authority", "credentialId", "userHandle", "sessionId", "proofDigest", "passkey"]) expect(result).not.toHaveProperty(internal);
    expect(value.observations()).toBeGreaterThan(0);
    expect(value.requests.some(request => request.path === reviewPath && request.method === "POST" && !request.cookie)).toBe(true);
    expect(await counts()).toEqual({ reviews: 1, approved: 1, consumed: 1, nonces: 0 });
  }, 15_000);

  it("recovers a genuinely lost approval response and preserves the original envelope across exact and fresh-assertion retries", async () => {
    const value = await start(), session = await value.login(), app = await reviewing(value, session);
    const path = `/wallet/payment-reviews/${app.pending.reviewId}/approve`, headers = { "x-center-wallet-csrf": session.csrf };
    const lost = await value.post(path, { assertion: encodeAssertion(app.assertion) }, session.jar, headers, true);
    expect(lost.status).toBe(200); await expect(lost.json()).rejects.toThrow("Fixture response disconnected");
    const original = await app.connection.client.request<WalletPaymentAppPublic>({ requestTarget: `${reviewPath}/${app.pending.reviewId}` });
    const exact = await value.post(path, { assertion: encodeAssertion(app.assertion) }, session.jar, headers);
    expect(exact.status).toBe(200); expect((await exact.json()).replayed).toBe(true);
    const fresh = signGet({ ...session.identity.credential, challenge: app.review.signing.digest, rpId, origin: issuer, signCount: 9 });
    expect(Buffer.from(fresh.signature).equals(Buffer.from(app.assertion.signature))).toBe(false);
    const retried = await value.post(path, { assertion: encodeAssertion(fresh) }, session.jar, headers);
    expect(retried.status).toBe(200); const body = await retried.json(); expect(body.replayed).toBe(true);
    app.navigate(body.redirectUri);
    expect((await app.payments.completePayment()).status).toBe("approved"); expect(app.location()).toBe(app.callbackUri);
    expect((await app.connection.client.request<WalletPaymentAppPublic>({ requestTarget: `${reviewPath}/${app.pending.reviewId}` })).approval).toEqual(original.approval);
    expect(await counts()).toEqual({ reviews: 1, approved: 1, consumed: 1, nonces: 0 });
  }, 15_000);

  it("keeps cancellation terminal across a fresh client helper, later HTTP approval and packaged submission", async () => {
    const value = await start(), session = await value.login(), app = await reviewing(value, session);
    const path = `/wallet/payment-reviews/${app.pending.reviewId}`;
    expect((await value.post(`${path}/cancel`, {}, session.jar, { "x-center-wallet-csrf": session.csrf })).status).toBe(200);
    const reloaded = app.wallet.payments();
    expect((await reloaded.refreshPayment()).status).toBe("cancelled");
    await expect(reloaded.submitPayment()).rejects.toMatchObject({ code: "WALLET_PAYMENT_NOT_APPROVED" });
    expect((await value.post(`${path}/approve`, { assertion: encodeAssertion(app.assertion) }, session.jar,
      { "x-center-wallet-csrf": session.csrf })).status).toBe(409);
    const result = await app.connection.client.request<WalletPaymentAppPublic>({ requestTarget: `${reviewPath}/${app.pending.reviewId}` });
    expect(result).toMatchObject({ status: "cancelled", approval: null });
    expect(value.requests.some(request => request.path.endsWith("/submissions"))).toBe(false);
    expect(await counts()).toEqual({ reviews: 1, approved: 0, consumed: 0, nonces: 0 });
  }, 15_000);

  it("rejects other live central accounts and other same-account grants through actual authenticated HTTP", async () => {
    const value = await start(), session = await value.login(), app = await reviewing(value, session);
    const otherIdentity = await createWalletLoginSetup(pool, { manifest }), otherSession = await value.login(otherIdentity);
    const path = `/wallet/payment-reviews/${app.pending.reviewId}`;
    // The review id admits any reader; only the account's own passkeys approve.
    expect((await value.get(path, otherSession.jar)).status).toBe(200);
    const foreign = signGet({ ...otherSession.identity.credential, challenge: app.review.signing.digest, rpId, origin: issuer });
    expect((await value.post(`${path}/approve`, { assertion: encodeAssertion(foreign) }, otherSession.jar,
      { "x-center-wallet-csrf": otherSession.csrf })).status).toBe(403);
    for (const origin of [appOrigin, otherOrigin]) {
      const otherGrant = await value.connect(session, origin);
      expect(otherGrant.connection.accountId).toBe(app.connection.accountId); expect(otherGrant.grant.id).not.toBe(app.grant.id);
      await expect(otherGrant.connection.client.request({ requestTarget: `${reviewPath}/${app.pending.reviewId}` })).rejects.toMatchObject({ status: 403 });
      await expect(otherGrant.connection.client.request({ method: "POST", requestTarget: reviewPath,
        json: { operationId: app.record.id, state: app.review.state }, idempotencyKey: `foreign:${randomUUID()}` })).rejects.toMatchObject({ status: 404 });
    }
    expect(await counts()).toEqual({ reviews: 1, approved: 0, consumed: 0, nonces: 0 });
  }, 15_000);

  it("logout after approval blocks retrieval, stale-cookie reuse and the signed submission route", async () => {
    const value = await start(), session = await value.login(), app = await reviewing(value, session);
    const path = `/wallet/payment-reviews/${app.pending.reviewId}/approve`;
    const approved = await value.post(path, { assertion: encodeAssertion(app.assertion) }, session.jar, { "x-center-wallet-csrf": session.csrf });
    expect(approved.status).toBe(200); app.navigate((await approved.json()).redirectUri);
    expect((await app.payments.completePayment()).status).toBe("approved");
    const staleCookie = session.jar.header();
    const logout = await value.post("/wallet/logout", {}, session.jar, { "x-center-wallet-csrf": session.csrf });
    expect(logout.status).toBe(200); session.jar.accept(logout); expect(session.jar.value(walletSessionCookie)).toBeNull();
    await expect(app.connection.client.request({ requestTarget: `${reviewPath}/${app.pending.reviewId}` })).rejects.toMatchObject({ status: 403 });
    expect((await value.post(path, { assertion: encodeAssertion(app.assertion) }, undefined,
      { "x-center-wallet-csrf": session.csrf, cookie: staleCookie })).status).toBe(403);
    await expect(app.payments.submitPayment()).rejects.toMatchObject({ status: 403 });
    expect(value.requests.some(request => request.method === "POST" && request.path === `/api/v1/user-operations/${app.record.id}/submissions`)).toBe(true);
    expect(app.payments.pendingPayment()?.status).toBe("unknown");
    expect(await counts()).toEqual({ reviews: 1, approved: 1, consumed: 1, nonces: 0 });
  }, 15_000);
});
