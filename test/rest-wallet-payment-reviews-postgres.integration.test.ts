// Real PostgreSQL coordination and genuine login/app possession. The modeled Safe operation and
// canonical-readiness observation below are explicit DB-boundary fixtures, not live EVM evidence.
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, type Hex } from "viem";
import { migrate } from "../src/db/migrate.js";
import type { RestActor } from "../src/rest/core.js";
import { PostgresUserOperationStore } from "../src/rest/userOperations/postgres.js";
import { getUserOperationHash } from "../src/rest/userOperations/codec.js";
import { PostgresWalletPolicyStore } from "../src/rest/wallet/policyPostgres.js";
import { PostgresWalletHandoffStore } from "../src/rest/wallet/handoffPostgres.js";
import { walletHandoffRequestDocument, walletHandoffExchangeDocument, walletHandoffCodeHash, walletHandoffLaunchDocument,
  walletHandoffPkceChallenge, type WalletHandoffRequest } from "../src/rest/wallet/handoff.js";
import { walletAppPrincipalId } from "../src/rest/wallet/appGrants.js";
import { addWalletLoginDevice, completeWalletLoginFixture, walletLoginFixtureOrigin, walletLoginFixtureRpId } from "./fixtures/wallet-login-setup.js";
import { signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { digest } from "../src/rest/sponsorship/validation.js";
import { PostgresWalletPaymentReviewStore, type WalletPaymentReviewStoreOptions } from "../src/rest/wallet/paymentReviewsPostgres.js";
import { verifyWalletPaymentReviewProof } from "../src/rest/wallet/paymentReviews.js";
import { PostgresWalletLoginStore } from "../src/rest/wallet/loginPostgres.js";
import { decodeSafe7579PasskeyOwnerSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import type { WalletAssertion } from "../src/rest/wallet/webauthn.js";
import { userOperationCommitment } from "../src/rest/userOperations/codec.js";

import { prepareWalletPaymentFixtureOperation, walletPaymentFixtureManifest as manifest,
  walletPaymentFixtureToken as usdc, walletPaymentFixtureTerminal as terminal } from "./fixtures/wallet-payment-setup.js";

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const schema = `wallet_payment_review_${randomUUID().replaceAll("-", "")}`;
const issuer = walletLoginFixtureOrigin, audience = "https://juicebox.center", origin = "https://beep.biz";
const appKey = privateKeyToAccount(`0x${"73".repeat(32)}`);
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string): Hex => keccak256(toHex(value));
const children = new Set<ChildProcess>();
let admin: Pool, pool: Pool;
type Options = Pick<WalletPaymentReviewStoreOptions, "maxRecords" | "maxAccountRecords" | "receiptRetentionMs" | "frameableAppOrigins">;
const options = (extra: Options = {}): WalletPaymentReviewStoreOptions => ({ issuer, audience, token: usdc,
  directV6Terminal: terminal, manifestFor: () => manifest, ...extra });
const policy = (origins = [origin]) => ({ version: "center-wallet-policy-v1" as const,
  applications: origins.map(value => ({ origin: value, walletCallbacks: [`${value}/wallet/callback`] })) });

async function nowMs() {
  return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
}
async function appContext(readinessLifetimeMs = 30_000, existingLogin?: Awaited<ReturnType<typeof completeWalletLoginFixture>>) {
  const login = existingLogin ?? await completeWalletLoginFixture(pool, { lifetimeMs: readinessLifetimeMs, manifest });
  const issuedAtMs = await nowMs(), verifier = token();
  const request: WalletHandoffRequest = { version: "center-wallet-handoff-request-v1", issuer, audience, origin,
    callbackUri: `${origin}/wallet/callback`, appGeneration: 1, requestKey: appKey.address, state: token(),
    codeChallenge: walletHandoffPkceChallenge(verifier), nonce: hash(randomUUID()), issuedAtMs, expiresAtMs: issuedAtMs + 120_000 };
  const handoff = new PostgresWalletHandoffStore(pool, { issuer, audience });
  const intent = await handoff.prepare({ request, signature: await appKey.signTypedData(walletHandoffRequestDocument(request)) }, origin);
  const issued = await handoff.issue(intent.id, login.session.id,
    await appKey.signTypedData(walletHandoffLaunchDocument({request,intentId:intent.id})));
  const { grant } = await handoff.exchange({ request, intentId: intent.id, code: issued.code, verifier,
    signature: await appKey.signTypedData(walletHandoffExchangeDocument({ request, intentId: intent.id,
      codeHash: walletHandoffCodeHash(issued.code) })) }, origin);
  const actor: RestActor = { accountId: login.accountId, principalId: walletAppPrincipalId(grant) };
  return { login, grant, actor };
}
type AppContext = Awaited<ReturnType<typeof appContext>>;

async function preparedOperation(context: AppContext, lifetimeMs = 120_000, nonce = 1n) {
  return prepareWalletPaymentFixtureOperation(pool, context.actor, context.login.binding, lifetimeMs, nonce);
}

function message(child: ChildProcess, kind: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Payment fixture did not emit ${kind}`)), 12_000);
    const receive = (value: unknown) => {
      if (value && typeof value === "object" && "kind" in value && value.kind === kind) finish(undefined, value as Record<string, unknown>);
    };
    const exited = () => finish(new Error(`Payment fixture exited before ${kind}`));
    const failed = () => finish(new Error("Payment fixture process failed"));
    function finish(error?: Error, value?: Record<string, unknown>) {
      clearTimeout(timer); child.off("message", receive); child.off("exit", exited); child.off("error", failed);
      if (error) reject(error); else resolve(value!);
    }
    child.on("message", receive); child.once("exit", exited); child.once("error", failed);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Payment fixture did not terminate")), 5000);
    const exited = () => finish(), failed = () => finish(new Error("Payment fixture termination failed"));
    function finish(error?: Error) {
      clearTimeout(timeout); child.off("exit", exited); child.off("error", failed); children.delete(child);
      if (error) reject(error); else resolve();
    }
    child.once("exit", exited); child.once("error", failed); child.kill("SIGKILL");
  });
}
async function waitingForLock(backendPid: number) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const row = (await pool.query("SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1", [backendPid])).rows[0];
    if (row?.wait_event_type === "Lock" && row.blockers.length > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected a real PostgreSQL payment lock wait");
}
async function waitPast(deadline: number, maximumWaitMs = 6000) {
  const remaining = deadline - await nowMs();
  if (remaining > maximumWaitMs) throw new Error("Fixture deadline is not short and bounded");
  await pool.query("SELECT pg_sleep($1)", [Math.max(0, remaining + 30) / 1000]);
  expect(await nowMs()).toBeGreaterThan(deadline);
}
async function worker(extra: Options = {}, prefix = "", poolWaitMs = 5000) {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-payment-review-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_PAYMENT_TEST_SCHEMA: schema,
      WALLET_PAYMENT_TEST_OPTIONS: JSON.stringify(extra), WALLET_PAYMENT_TEST_PREFIX_SCHEMA: prefix,
      WALLET_PAYMENT_TEST_POOL_WAIT_MS: String(poolWaitMs) },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child); child.stderr?.resume();
  const ready = await message(child, "ready");
  return { child, backendPid: Number(ready.backendPid), request: async (body: Record<string, any>) => {
    const value = body.assertion ? { ...body, assertion: { ...body.assertion,
      authenticatorData: Buffer.from(body.assertion.authenticatorData).toString("base64url"),
      clientDataJSON: Buffer.from(body.assertion.clientDataJSON).toString("base64url"),
      signature: Buffer.from(body.assertion.signature).toString("base64url") } } : body;
    const response = await fetch(`http://127.0.0.1:${ready.port}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(12_000) });
    return { status: response.status, body: await response.json() as any };
  } };
}
async function pendingReview(extra: Options = {}, lifetimeMs = 120_000, readinessLifetimeMs = 30_000) {
  const context = await appContext(readinessLifetimeMs), prepared = await preparedOperation(context, lifetimeMs);
  const store = new PostgresWalletPaymentReviewStore(pool, options(extra)), state = token(), key = `review:${prepared.plan.id}`;
  const view = await store.prepare(context.actor, { operationId: prepared.record.id, state }, key);
  const assertion = signGet({ ...context.login.credential, challenge: view.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer });
  return { ...context, ...prepared, store, view, assertion, state, key };
}
async function reviewRow(id: string) { return (await pool.query("SELECT * FROM rest_wallet_payment_reviews WHERE id=$1", [id])).rows[0]; }
async function counts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM rest_wallet_payment_reviews) AS reviews,
    (SELECT count(*)::int FROM rest_wallet_payment_reviews WHERE status='approved') AS approved,
    (SELECT count(*)::int FROM rest_wallet_ceremonies WHERE purpose='payment') AS ceremonies,
    (SELECT count(*)::int FROM rest_wallet_ceremonies WHERE purpose='payment' AND consumed_at IS NOT NULL) AS consumed,
    (SELECT count(*)::int FROM rest_user_operations) AS operations,
    (SELECT count(*)::int FROM rest_user_operation_nonces) AS nonces`)).rows[0];
}
async function reachedBarrier(process: ReturnType<typeof worker> extends Promise<infer V> ? V : never, response: Promise<unknown>) {
  return Promise.race([message(process.child, "barrier"), response.then(() => { throw new Error("Request ended before expected payment write barrier"); })]);
}
async function holdAccount(accountId: string) {
  const client = await pool.connect(); await client.query("BEGIN");
  await client.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId]);
  return async () => { try { await client.query("ROLLBACK"); } finally { client.release(); } };
}

suite("PostgreSQL payment reviews with genuine passkey login and app grants", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    expect(Math.floor(Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10_000)).toBe(16);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=10000`,
      max: 12, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    await migrate(pool);
  }, 20_000);
  beforeEach(async () => {
    await pool.query("TRUNCATE rest_wallet_payment_reviews,rest_accounts,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies,rest_wallet_policy CASCADE");
    await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 0, nextRevision: 1, configuration: policy() });
  });
  afterEach(async () => {
    const results = await Promise.allSettled([...children].map(kill));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });
  afterAll(async () => {
    try { await pool?.end(); }
    finally { if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); } } }
  }, 15_000);

  it("creates an immutable review for an app-owned modeled V6 USDC operation", async () => {
    const context = await appContext(), prepared = await preparedOperation(context), store = new PostgresWalletPaymentReviewStore(pool, options());
    const state = token(), view = await store.prepare(context.actor, { operationId: prepared.record.id, state }, `review:${prepared.plan.id}`);
    expect(view.status).toBe("pending");
    expect(view.draft).toMatchObject({ state, operationId: prepared.record.id, operationHash: prepared.record.operationHash,
      planCommitment: prepared.plan.commitment, grant: context.grant, operation: prepared.record.operation, stepIndexes: [0, 1] });
    expect(await store.get(view.draft.id)).toEqual(view);
    expect(await store.getForApp(context.actor, view.draft.id)).toEqual({ ...view, approval: null });
  });

  it("refuses a review for an operation whose full nonce another publication already holds", async () => {
    const context = await appContext(), held = await preparedOperation(context, 120_000, 7n), fresh = await preparedOperation(context, 120_000, 7n);
    // The claim writes the sender lowercase and the nonce in decimal; the review must look it up the same way.
    await pool.query("INSERT INTO rest_user_operation_nonces(chain_id,sender,nonce,entry_point,operation_hash,signed_commitment,user_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [held.record.chainId, held.record.sender.toLowerCase(), "7", held.record.entryPoint.toLowerCase(), held.record.operationHash.toLowerCase(), held.record.operationHash.toLowerCase(), held.record.id]);
    const store = new PostgresWalletPaymentReviewStore(pool, options());
    await expect(store.prepare(context.actor, { operationId: fresh.record.id, state: token() }, `review:${fresh.plan.id}`)).rejects.toMatchObject({ status: 409 });
  });
  it("creates a review under the id the app chose, once, and replays it whatever id a retry names", async () => {
    const value = await pendingReview();
    const second = await preparedOperation(value, 120_000, 2n), chosen = "7d2c1f5e-3b7a-4c9e-8f21-0a6d5e4c3b2a";
    const state = token(), view = await value.store.prepare(value.actor, { operationId: second.record.id, state, id: chosen }, "review:chosen");
    expect(view.draft.id).toBe(chosen);
    // The same key replays the review it created, whatever id (or none) the retry names.
    expect((await value.store.prepare(value.actor, { operationId: second.record.id, state, id: "1e4f2a6b-9c8d-4e7f-a1b2-c3d4e5f60718" }, "review:chosen")).draft.id).toBe(chosen);
    // An id already taken is a conflict for another key; a malformed one is invalid.
    const third = await preparedOperation(value, 120_000, 3n);
    await expect(value.store.prepare(value.actor, { operationId: third.record.id, state: token(), id: chosen }, "review:taken")).rejects.toMatchObject({ status: 409 });
    await expect(value.store.prepare(value.actor, { operationId: third.record.id, state: token(), id: "not-a-uuid" }, "review:bad")).rejects.toMatchObject({ status: 400 });
  });
  it("retries preparation with the original tuple and rejects changed state or operation", async () => {
    const value = await pendingReview();
    expect(await value.store.prepare(value.actor, { operationId: value.record.id, state: value.state }, value.key)).toEqual(value.view);
    await expect(value.store.prepare(value.actor, { operationId: value.record.id, state: token() }, value.key)).rejects.toMatchObject({ status: 409 });
    const second = await preparedOperation(value, 120_000, 2n);
    await expect(value.store.prepare(value.actor, { operationId: second.record.id, state: value.state }, value.key)).rejects.toMatchObject({ status: 409 });
    expect(await counts()).toMatchObject({ reviews: 1, ceremonies: 1, consumed: 0, operations: 2, nonces: 0 });
  });

  it("records one genuine SafeOp approval and recovers the same original envelope with a fresh signature", async () => {
    const value = await pendingReview(), firstProof = verifyWalletPaymentReviewProof(value.view.draft, value.assertion);
    const approved = await value.store.approve(value.view.draft.id, value.assertion);
    expect(approved.replayed).toBe(false); expect(approved.view.status).toBe("approved");
    const original = await value.store.getForApp(value.actor, value.view.draft.id);
    expect(original.approval).toEqual({ signature: firstProof.signature, signedCommitment: firstProof.signedCommitment });
    const fresh = signGet({ ...value.login.credential, challenge: value.view.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer, signCount: 2 });
    expect(Buffer.from(fresh.signature).equals(Buffer.from(value.assertion.signature))).toBe(false);
    expect(verifyWalletPaymentReviewProof(value.view.draft, fresh).signature).not.toBe(firstProof.signature);
    expect(await value.store.approve(value.view.draft.id, fresh)).toEqual({ view: approved.view, replayed: true });
    expect(await value.store.getForApp(value.actor, value.view.draft.id)).toEqual(original);
    expect(await counts()).toMatchObject({ reviews: 1, approved: 1, ceremonies: 1, consumed: 1, nonces: 0 });
  });

  it("hands a fresh approval to the operation's submission on the review's own authority, and again on a replay while the operation is still prepared", async () => {
    const value = await pendingReview(), submissions: unknown[] = [];
    value.store.attachSubmission(async input => { submissions.push(input); return {}; });
    const approved = await value.store.approve(value.view.draft.id, value.assertion);
    expect(approved.replayed).toBe(false);
    await vi.waitFor(() => expect(submissions).toHaveLength(1));
    const row = await reviewRow(value.view.draft.id), issuedAt = Math.floor(Number(row.approved_at_ms) / 1000);
    expect(submissions[0]).toEqual({ actor: value.actor, operationId: value.record.id, signature: row.signature, key: `review:${value.view.draft.id}`,
      authority: { issuedAt, expiresAt: Math.min(Math.floor(Number(row.expires_at_ms) / 1000), issuedAt + 300) } });
    // A reload of the approval page (the same proof again) retries the submission while nothing was published.
    expect((await value.store.approve(value.view.draft.id, value.assertion)).replayed).toBe(true);
    await vi.waitFor(() => expect(submissions).toHaveLength(2));
    // The approval page reloading (a session read of the approved review) retries too; a throwing
    // submission, even a synchronous one, never fails the read or the approval.
    value.store.attachSubmission(() => { throw new Error("submission failed"); });
    expect((await value.store.get(value.view.draft.id)).status).toBe("approved");
    value.store.attachSubmission(async input => { submissions.push(input); return {}; });
    await value.store.get(value.view.draft.id);
    await vi.waitFor(() => expect(submissions).toHaveLength(3));
    // Once the operation left `prepared`, neither a replay nor a read sends again.
    const record = { ...value.record, state: "submitting" };
    await pool.query("UPDATE rest_user_operations SET document=$2::jsonb WHERE id=$1", [value.record.id, JSON.stringify(record)]);
    expect((await value.store.approve(value.view.draft.id, value.assertion)).replayed).toBe(true);
    await value.store.get(value.view.draft.id);
    await new Promise(resolve => setTimeout(resolve, 50)); expect(submissions).toHaveLength(3);
  });

  it("never resends, approves or reviews again an operation retired after Signa refused its approval", async () => {
    const value = await pendingReview(), submissions: unknown[] = [], operations = new PostgresUserOperationStore(pool);
    value.store.attachSubmission(async input => { submissions.push(input); return {}; });
    await value.store.approve(value.view.draft.id, value.assertion);
    await vi.waitFor(() => expect(submissions).toHaveLength(1));
    expect((await operations.retire(value.actor, value.record.id)).state).toBe("retired");
    // The approval page reopened: the same proof again, and a read of the approved review. Neither sends.
    expect((await value.store.approve(value.view.draft.id, value.assertion)).replayed).toBe(true);
    expect((await value.store.get(value.view.draft.id)).operationState).toBe("retired");
    expect((await value.store.getForApp(value.actor, value.view.draft.id)).operationState).toBe("retired");
    await new Promise(resolve => setTimeout(resolve, 50)); expect(submissions).toHaveLength(1);
    // A pending review of a retired operation is never approved, and a retired operation gets no new review.
    const pending = await preparedOperation(value, 120_000, 2n), state = token();
    const view = await value.store.prepare(value.actor, { operationId: pending.record.id, state }, "review:retire-pending");
    await operations.retire(value.actor, pending.record.id);
    const assertion = signGet({ ...value.login.credential, challenge: view.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer, signCount: 3 });
    await expect(value.store.approve(view.draft.id, assertion)).rejects.toMatchObject({ status: 409 });
    const unreviewed = await preparedOperation(value, 120_000, 3n);
    await operations.retire(value.actor, unreviewed.record.id);
    await expect(value.store.prepare(value.actor, { operationId: unreviewed.record.id, state: token() }, "review:retired")).rejects.toMatchObject({ status: 409 });
    expect(submissions).toHaveLength(1);
  });

  it("asks the operation's admission checks to run ahead when a review is created and when its page is read, never for a settled review, never failing either", async () => {
    const context = await appContext(30_000), prepared = await preparedOperation(context, 120_000);
    const store = new PostgresWalletPaymentReviewStore(pool, options()), speculations: unknown[] = [];
    store.attachSpeculation(async (actor, operationId) => { speculations.push({ actor, operationId }); });
    const view = await store.prepare(context.actor, { operationId: prepared.record.id, state: token() }, `review:${prepared.plan.id}`);
    await vi.waitFor(() => expect(speculations).toEqual([{ actor: context.actor, operationId: prepared.record.id }]));
    store.attachSpeculation(() => { throw new Error("speculation failed"); });
    expect((await store.get(view.draft.id)).status).toBe("pending");
    store.attachSpeculation(async (actor, operationId) => { speculations.push({ actor, operationId }); });
    await store.get(view.draft.id);
    await vi.waitFor(() => expect(speculations).toHaveLength(2));
    // An approved review has nothing to speculate: its approval is the admission.
    const assertion = signGet({ ...context.login.credential, challenge: view.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer });
    await store.approve(view.draft.id, assertion); await store.get(view.draft.id);
    await new Promise(resolve => setTimeout(resolve, 50)); expect(speculations).toHaveLength(2);
  });

  it("accepts an approval made inside the app's frame only for an app admitted to frame, naming that app as the top origin", async () => {
    const context = await appContext(30_000), prepared = await preparedOperation(context, 120_000);
    const framed = (extra: Options = {}) => new PostgresWalletPaymentReviewStore(pool, options(extra));
    const admitted = framed({ frameableAppOrigins: [origin] }), plain = framed();
    const view = await admitted.prepare(context.actor, { operationId: prepared.record.id, state: token() }, `review:${prepared.plan.id}`);
    const assertion = (topOrigin?: string) => signGet({ ...context.login.credential, challenge: view.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer, ...(topOrigin ? { topOrigin } : {}) });
    // Not admitted: a framed assertion is refused; admitted: another top origin is refused.
    await expect(plain.approve(view.draft.id, assertion(origin))).rejects.toMatchObject({ code: "WALLET_PAYMENT_REVIEW_PROOF_INVALID" });
    await expect(admitted.approve(view.draft.id, assertion("https://other.example"))).rejects.toMatchObject({ code: "WALLET_PAYMENT_REVIEW_PROOF_INVALID" });
    expect((await admitted.get(view.draft.id)).status).toBe("pending");
    expect((await admitted.approve(view.draft.id, assertion(origin))).view.status).toBe("approved");
  });

  it("lets a device passkey approve a review prepared for the account, signing as its own owner", async () => {
    // The device joins first: a review is a promise about the authority it was prepared under.
    const first = await completeWalletLoginFixture(pool, { lifetimeMs: 30_000, manifest });
    const added = await addWalletLoginDevice(pool, first, { origin: issuer, rpId: walletLoginFixtureRpId });
    // Adding a device rebinds the account, so every earlier session is over; the primary signs in again.
    const logins = new PostgresWalletLoginStore(pool, { rpId: walletLoginFixtureRpId, origin: issuer });
    await expect(logins.readSession(first.sessionToken)).resolves.toBeNull();
    const primaryBegun = await logins.begin(), primaryLogin = await logins.complete({ loginId: primaryBegun.login.id, flowToken: primaryBegun.flowToken,
      assertion: signGet({ ...first.credential, challenge: primaryBegun.login.challenge, rpId: walletLoginFixtureRpId, origin: issuer }) });
    const login = { ...first, ...primaryLogin, binding: added.binding, state: added.state };
    const context = await appContext(30_000, login), prepared = await preparedOperation(context);
    const store = new PostgresWalletPaymentReviewStore(pool, options()), key = `review:${prepared.plan.id}`;
    const view = await store.prepare(context.actor, { operationId: prepared.record.id, state: token() }, key);
    const value = { ...context, ...prepared, store, view, assertion: signGet({ ...login.credential, challenge: view.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer }) };
    // No sign-in takes part: the assertion names the passkey, and the review stays the one the app prepared.
    const assertion = signGet({ ...added.device, challenge: value.view.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer });
    // The device's signature under the primary's credential id is refused, as is a credential id of neither.
    await expect(value.store.approve(value.view.draft.id, { ...assertion, credentialId: value.assertion.credentialId })).rejects.toMatchObject({ status: 403 });
    await expect(value.store.approve(value.view.draft.id, { ...assertion, credentialId: "AAAA" })).rejects.toMatchObject({ status: 403, code: "WALLET_PAYMENT_REVIEW_PROOF_INVALID" });
    const approved = await value.store.approve(value.view.draft.id, assertion);
    expect(approved.view.status).toBe("approved");
    const original = await value.store.getForApp(value.actor, value.view.draft.id);
    const owners = decodeSafe7579PasskeyOwnerSignature({ signature: original.approval!.signature, validAfter: value.view.draft.signing.validAfter,
      validUntil: value.view.draft.signing.validUntil, threshold: 1 });
    expect(owners.map(entry => entry.kind === "contract" ? entry.owner.toLowerCase() : entry.kind)).toEqual([added.signerAddress]);
    expect(await counts()).toMatchObject({ reviews: 1, approved: 1 });
  });

  it("serializes twenty competing genuine approvals across two processes and retains the first winning envelope", async () => {
    // All twenty requests still contend on one connection per process. This case
    // observes their serialization, so queued checkout may outlast the usual 5s.
    const poolWaitMs = 10_000;
    const value = await pendingReview(), first = await worker({}, "", poolWaitMs), second = await worker({}, "", poolWaitMs);
    const assertions = Array.from({ length: 20 }, (_, index) => signGet({ ...value.login.credential,
      challenge: value.view.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer, signCount: index + 1 }));
    const winning = first.request({ action: "approve", id: value.view.draft.id,
      assertion: assertions[0], barrier: "after-review-write" });
    await reachedBarrier(first, winning);
    const competing = assertions.slice(1).map((assertion, index) => (index % 2 ? first : second).request({
      action: "approve", id: value.view.draft.id, assertion }));
    await waitingForLock(second.backendPid); first.child.send("release");
    const replies = await Promise.all([winning, ...competing]);
    expect(replies.filter(reply => reply.status !== 200)).toEqual([]);
    expect(replies.filter(reply => reply.body.replayed === false)).toHaveLength(1);
    const winner = replies.findIndex(reply => reply.body.replayed === false), expected = verifyWalletPaymentReviewProof(value.view.draft, assertions[winner]!);
    expect((await value.store.getForApp(value.actor, value.view.draft.id)).approval).toEqual({ signature: expected.signature, signedCommitment: expected.signedCommitment });
    expect(await counts()).toMatchObject({ approved: 1, consumed: 1, nonces: 0 });
  });

  it.each(["approve", "cancel"] as const)("makes %s win a controlled approval/cancellation race without reviving the loser", async winner => {
    const value = await pendingReview(), first = await worker(), second = await worker();
    const firstRequest = first.request({ action: winner, id: value.view.draft.id,
      assertion: value.assertion, barrier: "after-review-write" });
    await reachedBarrier(first, firstRequest);
    const loser = winner === "approve" ? "cancel" : "approve";
    const secondRequest = second.request({ action: loser, id: value.view.draft.id, assertion: value.assertion });
    await waitingForLock(second.backendPid); first.child.send("release");
    expect((await firstRequest).status).toBe(200); expect((await secondRequest).status).toBe(409);
    const view = await value.store.getForApp(value.actor, value.view.draft.id);
    expect(view.status).toBe(winner === "approve" ? "approved" : "cancelled");
    expect(view.approval === null).toBe(winner === "cancel");
    expect(await counts()).toMatchObject({ approved: winner === "approve" ? 1 : 0, consumed: winner === "approve" ? 1 : 0, nonces: 0 });
  });

  it.each(["after-review-write", "after-commit"])("recovers process death %s without replacing an already committed signature", async stage => {
    const value = await pendingReview(), first = await worker(), second = await worker();
    const request = first.request({ action: "approve", id: value.view.draft.id,
      assertion: value.assertion, barrier: stage }).then(value => ({ value }), error => ({ error }));
    await reachedBarrier(first, request); await kill(first.child); expect(await request).toHaveProperty("error");
    expect(await counts()).toMatchObject({ approved: stage === "after-commit" ? 1 : 0, consumed: stage === "after-commit" ? 1 : 0 });
    const fresh = signGet({ ...value.login.credential, challenge: value.view.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer, signCount: 4 });
    const retry = await second.request({ action: "approve", id: value.view.draft.id, assertion: fresh });
    expect(retry.status).toBe(200); expect(retry.body.replayed).toBe(stage === "after-commit");
    const expected = verifyWalletPaymentReviewProof(value.view.draft, stage === "after-commit" ? value.assertion : fresh);
    expect((await value.store.getForApp(value.actor, value.view.draft.id)).approval?.signature).toBe(expected.signature);
  });

  it("rolls back both preparation and payment ceremony when its process dies after the review insert", async () => {
    const value = await appContext(), prepared = await preparedOperation(value), first = await worker(), second = await worker();
    const input = { operationId: prepared.record.id, state: token() }, key = `review:${prepared.plan.id}`;
    const request = first.request({ action: "prepare", actor: value.actor, input, key, barrier: "after-review-write" }).catch(error => ({ error }));
    await reachedBarrier(first, request); await kill(first.child); expect(await request).toHaveProperty("error");
    expect(await counts()).toMatchObject({ reviews: 0, ceremonies: 0, operations: 1 });
    expect((await second.request({ action: "prepare", actor: value.actor, input, key })).status).toBe(200);
    expect(await counts()).toMatchObject({ reviews: 1, ceremonies: 1, consumed: 0 });
  });

  it("needs no Center sign-in: a review is read, approved and replayed after the session that opened the app ended", async () => {
    const value = await pendingReview(), logins = new PostgresWalletLoginStore(pool, { rpId: walletLoginFixtureRpId, origin: issuer });
    // The session ends on its own (a logout is an authority rotation, refused below like any other).
    await pool.query(`UPDATE rest_wallet_logins SET revoked_at_ms=t.ms, session_document=jsonb_set(session_document,'{revokedAtMs}',to_jsonb(t.ms))
      FROM (SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms) t WHERE session_id=$1`, [value.login.session.id]);
    await expect(logins.readSession(value.login.sessionToken)).resolves.toBeNull();
    expect((await value.store.get(value.view.draft.id)).status).toBe("pending");
    expect((await value.store.approve(value.view.draft.id, value.assertion)).view.status).toBe("approved");
    expect((await value.store.approve(value.view.draft.id, value.assertion)).replayed).toBe(true);
    expect(await counts()).toMatchObject({ approved: 1, consumed: 1 });
  });
  it.each(["logout", "rotation", "credential", "binding", "policy-aba", "grant"])("rejects current-authority change %s for pending and already approved review receipts", async change => {
    const value = await pendingReview(), second = await preparedOperation(value, 120_000, 2n);
    const pending = await value.store.prepare(value.actor, { operationId: second.record.id, state: token() }, `review:${second.plan.id}`);
    const pendingAssertion = signGet({ ...value.login.credential, challenge: pending.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer });
    await value.store.approve(value.view.draft.id, value.assertion);
    if (change === "logout") await new PostgresWalletLoginStore(pool, { rpId: walletLoginFixtureRpId, origin: issuer }).logout(value.login.sessionToken);
    else if (change === "rotation") await pool.query("UPDATE rest_wallet_authority SET authority_epoch=authority_epoch+1,session_epoch=session_epoch+1 WHERE account_id=$1", [value.login.accountId]);
    else if (change === "credential") await pool.query("UPDATE rest_wallet_credentials SET superseded_at=$2 WHERE account_id=$1", [value.login.accountId, await nowMs()]);
    else if (change === "binding") await pool.query("UPDATE rest_smart_account_bindings SET revoked_at=$2 WHERE account_id=$1", [value.login.accountId, Math.floor(await nowMs() / 1000)]);
    else if (change === "grant") {
      await pool.query("UPDATE rest_wallet_app_grants SET revoked_at=floor(extract(epoch FROM clock_timestamp())) WHERE id=$1", [value.grant.id]);
      expect(await new PostgresWalletLoginStore(pool, { rpId: walletLoginFixtureRpId, origin: issuer }).readSession(value.login.sessionToken)).not.toBeNull();
    } else {
      const policies = new PostgresWalletPolicyStore(pool);
      await policies.activate({ expectedRevision: 1, nextRevision: 2, configuration: policy([]) });
      await policies.activate({ expectedRevision: 2, nextRevision: 3, configuration: policy() });
    }
    await expect(value.store.approve(pending.draft.id, pendingAssertion)).rejects.toMatchObject({ status: 403 });
    await expect(value.store.approve(value.view.draft.id, value.assertion)).rejects.toMatchObject({ status: 403 });
    await expect(value.store.getForApp(value.actor, value.view.draft.id)).rejects.toMatchObject({ status: 403 });
    expect(await counts()).toMatchObject({ reviews: 2, approved: 1, consumed: 1, nonces: 0 });
  });

  it("rejects login proof, wrong digest, wrong user handle and missing user verification without consuming payment intent", async () => {
    const value = await pendingReview();
    const missingUv: WalletAssertion = { ...value.assertion, authenticatorData: Buffer.from(value.assertion.authenticatorData) };
    missingUv.authenticatorData[32] = missingUv.authenticatorData[32]! & ~4;
    missingUv.signature = sign("sha256", Buffer.concat([Buffer.from(missingUv.authenticatorData),
      createHash("sha256").update(missingUv.clientDataJSON).digest()]), value.login.credential.key);
    for (const assertion of [value.login.input.assertion, missingUv, { ...value.assertion, userHandle: token() },
      signGet({ ...value.login.credential, challenge: hash("wrong-payment"), rpId: walletLoginFixtureRpId, origin: issuer })]) {
      await expect(value.store.approve(value.view.draft.id, assertion)).rejects.toMatchObject({ status: 403 });
    }
    expect(await counts()).toMatchObject({ approved: 0, consumed: 0 });
    expect((await value.store.approve(value.view.draft.id, value.assertion)).view.status).toBe("approved");
  });

  it("does not authorize an app actor or a different real central account to use another app's payment review", async () => {
    const value = await pendingReview(), other = await appContext();
    await expect(value.store.getForApp(other.actor, value.view.draft.id)).rejects.toMatchObject({ status: 403, code: "WALLET_PAYMENT_REVIEW_INACTIVE" });
    await expect(value.store.getForApp(value.actor, randomUUID())).rejects.toMatchObject({ status: 404, code: "WALLET_PAYMENT_REVIEW_NOT_FOUND" });
    // Another account's passkey cannot approve it, whatever it holds.
    const foreign = signGet({ ...other.login.credential, challenge: value.view.draft.signing.digest, rpId: walletLoginFixtureRpId, origin: issuer });
    await expect(value.store.approve(value.view.draft.id, foreign)).rejects.toMatchObject({ status: 403, code: "WALLET_PAYMENT_REVIEW_PROOF_INVALID" });
    await expect(value.store.get(value.actor.principalId)).rejects.toMatchObject({ status: 400 });
    expect(await counts()).toMatchObject({ approved: 0, consumed: 0 });
  });

  it("does not transfer a review to a replacement grant for the same account, request key and app origin", async () => {
    const value = await pendingReview();
    await pool.query("UPDATE rest_wallet_app_grants SET revoked_at=floor(extract(epoch FROM clock_timestamp())) WHERE id=$1", [value.grant.id]);
    const replacement = await appContext(30_000, value.login);
    expect(replacement.grant).toMatchObject({ accountId: value.grant.accountId, signerAddress: value.grant.signerAddress, origin: value.grant.origin });
    expect(replacement.actor.principalId).not.toBe(value.actor.principalId);
    await expect(value.store.getForApp(replacement.actor, value.view.draft.id)).rejects.toMatchObject({ status: 403 });
    await expect(value.store.prepare(replacement.actor, { operationId: value.record.id, state: token() }, `replacement:${value.plan.id}`))
      .rejects.toMatchObject({ status: 404 });
    await expect(value.store.approve(value.view.draft.id, value.assertion)).rejects.toMatchObject({ status: 403 });
    const prepared = await preparedOperation(replacement, 120_000, 2n);
    expect((await value.store.prepare(replacement.actor, { operationId: prepared.record.id, state: token() }, `review:${prepared.plan.id}`)).status).toBe("pending");
    expect(await counts()).toMatchObject({ reviews: 2, approved: 0, consumed: 0 });
  });

  it("snapshots caller-owned proof buffers before awaiting the first review lookup", async () => {
    const value = await pendingReview();
    const assertion: WalletAssertion = { ...value.assertion, signature: Uint8Array.from(value.assertion.signature) };
    const index = assertion.signature.length - 1, original = assertion.signature[index]!;
    assertion.signature[index] = original ^ 1;
    let seen!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { seen = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const connection = Object.create(pool) as Pool;
    connection.connect = pool.connect.bind(pool);
    let paused = false;
    connection.query = (async (...args: any[]) => {
      if (!paused && args[0] === "SELECT * FROM rest_wallet_payment_reviews WHERE id=$1") {
        paused = true; seen(); await held;
      }
      return (pool.query as any)(...args);
    }) as Pool["query"];
    const store = new PostgresWalletPaymentReviewStore(connection, options());
    const result = store.approve(value.view.draft.id, assertion).then(view => ({ view }), error => ({ error }));
    const timeout = new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Proof snapshot fixture lookup did not pause")), 5000); void reached.finally(() => clearTimeout(timer)); });
    try { await Promise.race([reached, timeout]); assertion.signature[index] = original; }
    finally { release(); }
    expect(await result).toMatchObject({ error: { status: 403 } });
    expect(await counts()).toMatchObject({ approved: 0, consumed: 0 });
  });

  it("checks the real database deadline after an account lock wait", async () => {
    // The approving process waits on the held account row for the whole deadline, so the
    // deliberate hold stays well inside the fixture's own lock and statement budgets.
    const process = await worker(), value = await pendingReview({}, 3000), release = await holdAccount(value.login.accountId);
    const request = process.request({ action: "approve", id: value.view.draft.id, assertion: value.assertion });
    try { await waitingForLock(process.backendPid); await waitPast(value.view.draft.expiresAtMs); }
    finally { await release(); }
    expect(await request).toMatchObject({ status: 410 }); expect(await counts()).toMatchObject({ approved: 0, consumed: 0 });
  });

  it("rolls back approval and ceremony consumption when the operation expires after the approval write", async () => {
    // Start the worker before issuing short-lived evidence. This case must
    // reach the write barrier, then expire against the real database clock.
    const process = await worker();
    const value = await pendingReview({}, 5000);
    const request = process.request({ action: "approve", id: value.view.draft.id,
      assertion: value.assertion, barrier: "after-review-write" });
    await reachedBarrier(process, request);
    await waitPast(value.view.draft.expiresAtMs);
    process.child.send("release");
    expect((await request).status).toBe(410);
    expect(await counts()).toMatchObject({ approved: 0, consumed: 0 });
  });

  it("reads and approves a review on a lapsed readiness window: the approval is verified on chain at submission", async () => {
    const value = await pendingReview({}, 120_000, 700);
    await waitPast(value.login.observation.validUntilMs!);
    expect((await value.store.get(value.view.draft.id)).status).toBe("pending");
    const approved = await value.store.approve(value.view.draft.id, value.assertion);
    expect(approved.replayed).toBe(false); expect(approved.view.status).toBe("approved");
    expect(await counts()).toMatchObject({ approved: 1, consumed: 1 });
  });

  it("keeps immutable review fields and the first approved envelope protected at the SQL boundary", async () => {
    const value = await pendingReview();
    for (const sql of ["UPDATE rest_wallet_payment_reviews SET draft=draft-'authority' WHERE id=$1",
      "UPDATE rest_wallet_payment_reviews SET draft=jsonb_set(draft,'{operationHash}','null'::jsonb) WHERE id=$1",
      "UPDATE rest_wallet_payment_reviews SET operation_id='other-operation' WHERE id=$1",
      "UPDATE rest_wallet_payment_reviews SET expires_at_ms=expires_at_ms+1 WHERE id=$1",
      "DELETE FROM rest_wallet_payment_reviews WHERE id=$1"])
      await expect(pool.query(sql, [value.view.draft.id])).rejects.toMatchObject({ code: "23514" });
    await value.store.approve(value.view.draft.id, value.assertion);
    const approved = await reviewRow(value.view.draft.id);
    for (const sql of ["UPDATE rest_wallet_payment_reviews SET signature='0x1234' WHERE id=$1",
      "UPDATE rest_wallet_payment_reviews SET proof_digest=NULL WHERE id=$1",
      "UPDATE rest_wallet_payment_reviews SET status='pending' WHERE id=$1"])
      await expect(pool.query(sql, [value.view.draft.id])).rejects.toMatchObject({ code: "23514" });
    expect(await reviewRow(value.view.draft.id)).toEqual(approved);
  });

  it("prevents SQL NULL escaping a required review context during independent INSERT, with a valid-row positive control", async () => {
    const value = await pendingReview(), original = await reviewRow(value.view.draft.id);
    const clone = () => {
      const row = structuredClone(original), id = randomUUID(), ceremonyId = randomUUID();
      row.id = id; row.operation_id = randomUUID(); row.preparation_key = `sql-boundary:${id}`; row.ceremony_id = ceremonyId;
      row.draft.id = id; row.draft.operationId = row.operation_id; row.draft.ceremony.id = ceremonyId;
      return row;
    };
    const insert = (row: unknown) => pool.query("INSERT INTO rest_wallet_payment_reviews SELECT * FROM jsonb_populate_record(NULL::rest_wallet_payment_reviews,$1::jsonb)", [JSON.stringify(row)]);
    for (const change of ["missing-authority", "null-account", "missing-ceremony", "completed-insert"]) {
      const row = clone();
      if (change === "missing-authority") delete row.draft.authority;
      else if (change === "null-account") row.draft.authority.accountId = null;
      else if (change === "missing-ceremony") delete row.draft.ceremony;
      else row.status = "approved";
      await expect(insert(row)).rejects.toMatchObject({ code: "23514" });
    }
    // Shape-only SQL positive control; no handler authenticates or consumes this fabricated row.
    await expect(insert(clone())).resolves.toMatchObject({ rowCount: 1 });
    expect(await counts()).toMatchObject({ reviews: 2, ceremonies: 1, consumed: 0 });
  });

  it("does not retrieve or revive an approved envelope after its finite SafeOp review deadline", async () => {
    const value = await pendingReview({}, 5000);
    await value.store.approve(value.view.draft.id, value.assertion);
    await waitPast(value.view.draft.expiresAtMs);
    await Promise.all([() => value.store.getForApp(value.actor, value.view.draft.id),
      () => value.store.get(value.view.draft.id),
      () => value.store.approve(value.view.draft.id, value.assertion)].map(async operation => {
      await expect(operation()).rejects.toMatchObject({ status: 410, code: "WALLET_PAYMENT_REVIEW_EXPIRED" });
    }));
    expect(await counts()).toMatchObject({ reviews: 1, approved: 1, consumed: 1, nonces: 0 });
  });

  it.each(["gas", "nonce", "plan", "steps"])("rejects a changed %s tuple in the server-owned operation or plan before consuming approval", async change => {
    const value = await pendingReview(), record = structuredClone(value.record);
    if (change === "plan") {
      const plan = structuredClone(value.plan); (plan.draft.summary as Record<string, unknown>).beneficiary = terminal;
      plan.commitment = digest({ actor: plan.actor, draft: plan.draft, expiresAt: plan.expiresAt, smartAccount: plan.smartAccount });
      await pool.query("UPDATE rest_transaction_plans SET document=$2::jsonb WHERE id=$1", [plan.id, JSON.stringify(plan)]);
    } else {
      if (change === "gas") record.operation.maxFeePerGas = "0x3";
      if (change === "nonce") record.operation.nonce = "0x9";
      if (change === "steps") record.stepIndexes = [1, 0];
      record.operationHash = getUserOperationHash(record.operation, record.entryPoint, record.chainId);
      record.commitment = digest({ planId: record.planId, planCommitment: record.planCommitment, operation: record.operation,
        operationHash: record.operationHash, accountBindingId: record.accountBindingId, accountStateHash: record.accountStateHash,
        gasPolicyId: record.gasPolicyId, providerId: record.providerId, createdAt: record.createdAt, expiresAt: record.expiresAt });
      await pool.query("UPDATE rest_user_operations SET document=$2::jsonb WHERE id=$1", [record.id, JSON.stringify(record)]);
    }
    await expect(value.store.approve(value.view.draft.id, value.assertion)).rejects.toMatchObject({ status: 403, code: "WALLET_PAYMENT_REVIEW_INACTIVE" });
    expect(await counts()).toMatchObject({ approved: 0, consumed: 0, nonces: 0 });
  });

  it("bounds retained per-account receipts after cancellation and preserves idempotent recovery at capacity", async () => {
    const value = await pendingReview({ maxAccountRecords: 1 }), prepared = await preparedOperation(value, 120_000, 2n);
    await value.store.cancel(value.view.draft.id);
    expect((await value.store.prepare(value.actor, { operationId: value.record.id, state: value.state }, value.key)).status).toBe("cancelled");
    await expect(value.store.prepare(value.actor, { operationId: prepared.record.id, state: token() }, `review:${prepared.plan.id}`))
      .rejects.toMatchObject({ status: 429, code: "WALLET_PAYMENT_REVIEW_LIMIT" });
    expect(await counts()).toMatchObject({ reviews: 1, ceremonies: 1, operations: 2 });
  });

  it("serializes the global last slot across two accounts and distinct leading schemas resolving the same tables", async () => {
    const firstContext = await appContext(), secondContext = await appContext();
    const firstOperation = await preparedOperation(firstContext), secondOperation = await preparedOperation(secondContext);
    const firstAlias = `wallet_payment_alias_${randomUUID().replaceAll("-", "")}`, secondAlias = `wallet_payment_alias_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${firstAlias}`); await admin.query(`CREATE SCHEMA ${secondAlias}`);
    try {
      const first = await worker({ maxRecords: 1 }, firstAlias), second = await worker({ maxRecords: 1 }, secondAlias);
      const request = first.request({ action: "prepare", actor: firstContext.actor,
        input: { operationId: firstOperation.record.id, state: token() }, key: `review:${firstOperation.plan.id}`, barrier: "after-review-write" });
      await reachedBarrier(first, request);
      const competing = second.request({ action: "prepare", actor: secondContext.actor,
        input: { operationId: secondOperation.record.id, state: token() }, key: `review:${secondOperation.plan.id}` });
      await waitingForLock(second.backendPid); first.child.send("release");
      expect((await request).status).toBe(200); expect(await competing).toMatchObject({ status: 429, body: { code: "WALLET_PAYMENT_REVIEW_LIMIT" } });
      expect(await counts()).toMatchObject({ reviews: 1, ceremonies: 1, operations: 2 });
    } finally { await admin.query(`DROP SCHEMA ${firstAlias}`); await admin.query(`DROP SCHEMA ${secondAlias}`); }
  });

  it("keeps the review quota shared even when replicas resolve different ceremony tables", async () => {
    const a = await appContext(), b = await appContext(), firstOperation = await preparedOperation(a), secondOperation = await preparedOperation(b);
    const aliases = [0, 1].map(() => `wallet_payment_alias_${randomUUID().replaceAll("-", "")}`);
    for (const alias of aliases) {
      await admin.query(`CREATE SCHEMA ${alias}`);
      await admin.query(`CREATE TABLE ${alias}.rest_wallet_ceremonies (LIKE ${schema}.rest_wallet_ceremonies INCLUDING ALL)`);
    }
    try {
      const first = await worker({ maxRecords: 1 }, aliases[0]), second = await worker({ maxRecords: 1 }, aliases[1]);
      const original = first.request({ action: "prepare", actor: a.actor,
        input: { operationId: firstOperation.record.id, state: token() }, key: `review:${firstOperation.plan.id}`, barrier: "after-review-write" });
      await reachedBarrier(first, original);
      const competing = second.request({ action: "prepare", actor: b.actor,
        input: { operationId: secondOperation.record.id, state: token() }, key: `review:${secondOperation.plan.id}` });
      // The broken implementation can finish B while A's review is still uncommitted.
      // Release A in either case so the behavioral red observes actual admitted row count.
      await Promise.race([waitingForLock(second.backendPid), competing]);
      first.child.send("release");
      expect((await original).status).toBe(200);
      const competitor = await competing;
      expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_payment_reviews")).rows[0].count).toBe(1);
      expect(competitor).toMatchObject({ status: 429, body: { code: "WALLET_PAYMENT_REVIEW_LIMIT" } });
    } finally {
      for (const alias of aliases) await admin.query(`DROP SCHEMA ${alias} CASCADE`);
    }
  }, 20_000);

  it("cleans only expired review receipts in bounded batches while preserving operation, nonce, plan and ceremony history", async () => {
    const value = await pendingReview({ receiptRetentionMs: 100 }, 8000);
    await value.store.approve(value.view.draft.id, value.assertion);
    const approval = (await value.store.getForApp(value.actor, value.view.draft.id)).approval!;
    const operation = { ...value.record.operation, signature: approval.signature };
    // Real durable relay claim, deliberately no bundler dispatch or EVM effect in this PG suite.
    const claimNow = await nowMs();
    expect(claimNow, "Cleanup fixture approval must still be live before the durable claim")
      .toBeLessThan(Number(value.view.draft.signing.validUntil) * 1000);
    const claimed = await new PostgresUserOperationStore(pool).claim({ actor: value.actor, id: value.record.id,
      key: `submit:${value.plan.id}`, operation, signedCommitment: userOperationCommitment(operation, value.record.entryPoint, 8453),
      authorization: { issuedAt: Number(value.view.draft.signing.validAfter), expiresAt: Number(value.view.draft.signing.validUntil) }, now: claimNow });
    expect(claimed.dispatch).toBe(true);
    const other = await preparedOperation(value, 8000, 2n);
    const pending = await value.store.prepare(value.actor, { operationId: other.record.id, state: token() }, `review:${other.plan.id}`);
    const before = (await pool.query("SELECT document FROM rest_user_operations ORDER BY id")).rows;
    const nonces = (await pool.query("SELECT * FROM rest_user_operation_nonces")).rows;
    await waitPast(Math.max(Number((await reviewRow(value.view.draft.id)).retain_until_ms), Number((await reviewRow(pending.draft.id)).retain_until_ms)), 9000);
    const lock = await pool.connect(); await lock.query("BEGIN");
    await lock.query("SELECT id FROM rest_wallet_payment_reviews WHERE id=$1 FOR UPDATE", [value.view.draft.id]);
    try {
      expect(await value.store.cleanup(1)).toBe(1); expect(await reviewRow(pending.draft.id)).toBeUndefined();
      expect(await reviewRow(value.view.draft.id)).toBeDefined();
    } finally { await lock.query("ROLLBACK"); lock.release(); }
    expect(await value.store.cleanup(1)).toBe(1); expect(await value.store.cleanup(1)).toBe(0);
    expect((await pool.query("SELECT document FROM rest_user_operations ORDER BY id")).rows).toEqual(before);
    expect((await pool.query("SELECT * FROM rest_user_operation_nonces")).rows).toEqual(nonces);
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_transaction_plans")).rows[0].count).toBe(2);
    expect(await counts()).toMatchObject({ reviews: 0, ceremonies: 2, consumed: 1, operations: 2, nonces: 1 });
  });
});
