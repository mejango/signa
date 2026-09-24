import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { walletAppPrincipalId, type WalletAppGrant } from "../src/rest/wallet/appGrants.js";
import { assertWalletAppGrantActiveInTransaction, getWalletAppGrantInTransaction, PostgresWalletAppGrantStore } from "../src/rest/wallet/appGrantsPostgres.js";
import { PostgresWalletPolicyStore } from "../src/rest/wallet/policyPostgres.js";
import { refreshTrustedWalletAuthority, seedTrustedWalletAuthority, trustedAuthorityNow, unreadyTrustedWalletAuthority,
  writeTrustedWalletAuthoritySnapshot } from "./fixtures/wallet-authority-readiness.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_apps_${randomUUID().replaceAll("-", "")}`;
const origin = "https://beep.biz", otherOrigin = "https://juicebox.money", audience = "https://juicebox.center";
const owner = `0x${"11".repeat(20)}`, signerAddress = `0x${"ab".repeat(20)}` as const;
const accountId = `eip155:8453:${owner}`, otherAccount = `eip155:8453:0x${"22".repeat(20)}`;
const legacyId = randomUUID();
let admin: Pool, pool: Pool, store: PostgresWalletAppGrantStore, backfilled: unknown;
const children = new Set<ChildProcess>();
type Context = Parameters<typeof assertWalletAppGrantActiveInTransaction>[2];
type Insert = Parameters<PostgresWalletAppGrantStore["insert"]>[0];
type RawApp = Omit<WalletAppGrant, "kind" | "incarnation" | "scopes">;
const policy = (origins = [origin, otherOrigin]) => ({ version: "center-wallet-policy-v1" as const,
  applications: origins.map(origin => ({ origin, walletCallbacks: [`${origin}/wallet/callback`] })) });
const actorContext = (grant: WalletAppGrant): Context => ({ kind: "actor", principalId: walletAppPrincipalId(grant), audience });
const requestContext = (expiresAt: number): Context => ({ kind: "request", audience, origin, expiresAt });

async function now(): Promise<number> {
  return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now")).rows[0].now);
}
async function seedAccount(id = accountId) {
  const address = id.split(":").at(-1)!;
  await pool.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,avatar_uri,created_at,updated_at)
    VALUES($1,$2,8453,'','',NULL,1,1) ON CONFLICT DO NOTHING`, [id, address]);
}
async function seedAuthority(id = accountId, authorityEpoch = "1", sessionEpoch = "1") {
  await seedAccount(id);
  // Trusted synthetic verified-readiness/live-binding state; these tests isolate grant storage.
  return seedTrustedWalletAuthority(pool, id, { authorityEpoch, sessionEpoch });
}
async function input(changes: Partial<Insert> = {}): Promise<Insert> {
  return { accountId, signerAddress, origin, callbackUri: `${origin}/wallet/callback`, audience,
    expectedAppGeneration: 1, expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", expiresAt: await now() + 900, ...changes };
}
async function rawApp(changes: Partial<RawApp> = {}): Promise<RawApp> {
  const createdAt = await now(), expiresAt = createdAt + 900;
  return { id: randomUUID(), accountId, signerAddress, origin, callbackUri: `${origin}/wallet/callback`, audience,
    appGeneration: 1, authorityEpoch: "1", sessionEpoch: "1", createdAt, expiresAt, revokedAt: null, retainUntil: expiresAt + 86400, ...changes };
}
async function insertRawApp(value: RawApp) {
  await pool.query(`INSERT INTO rest_wallet_app_grants(id,account_id,signer_address,origin,callback_uri,audience,
    app_generation,authority_epoch,session_epoch,created_at,expires_at,revoked_at,retain_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [value.id, value.accountId, value.signerAddress,
    value.origin, value.callbackUri, value.audience, value.appGeneration, value.authorityEpoch, value.sessionEpoch,
    value.createdAt, value.expiresAt, value.revokedAt, value.retainUntil]);
  return get(value.id);
}
async function get(id: string): Promise<WalletAppGrant> {
  const client = await pool.connect();
  try { const grant = await getWalletAppGrantInTransaction(client, id); expect(grant).not.toBeNull(); return grant!; }
  finally { client.release(); }
}
async function guard(grant: WalletAppGrant, context = actorContext(grant)): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [grant.accountId]);
    await assertWalletAppGrantActiveInTransaction(client, grant, context); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function counts(id?: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM rest_wallet_app_grants WHERE $1::text IS NULL OR id=$1) AS apps,
    (SELECT count(*)::int FROM rest_bot_grants WHERE $1::text IS NULL OR id=$1) AS bots,
    (SELECT count(*)::int FROM rest_grant_ids WHERE $1::text IS NULL OR id=$1) AS registry`, [id ?? null])).rows[0];
}
function message(child: ChildProcess, kind: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Child did not emit ${kind}`)), 12_000);
    const onMessage = (value: unknown) => { if (value && typeof value === "object" && "kind" in value && value.kind === kind) finish(undefined, value as Record<string, unknown>); };
    const onExit = () => finish(new Error(`Child exited before ${kind}`));
    function finish(error?: Error, value?: Record<string, unknown>) {
      clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError);
      if (error) reject(error); else resolve(value!);
    }
    const onError = () => finish(new Error("Local fixture process failed"));
    child.on("message", onMessage); child.on("exit", onExit); child.on("error", onError);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture did not terminate")), 5000);
    child.once("exit", () => { clearTimeout(timer); children.delete(child); resolve(); }); child.kill("SIGKILL");
  });
}
async function worker(options: { maxRecords?: number; maxAccountRecords?: number; maxOriginRecords?: number } = {}, prefix = "") {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-app-grant-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_APP_TEST_SCHEMA: schema,
      WALLET_APP_TEST_PREFIX_SCHEMA: prefix, WALLET_APP_TEST_OPTIONS: JSON.stringify(options) }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child); child.stderr?.on("data", () => {});
  const ready = await message(child, "ready");
  return { child, backendPid: Number(ready.backendPid), request: async (body: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${ready.port}`, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(12_000) });
    return { status: response.status, body: await response.json() };
  } };
}
async function waitingForLock(pid: number, expected?: { blocker: number; query: string }) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const row = (await pool.query("SELECT wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
    if (row?.wait_event_type === "Lock" && (!expected || (row.query.includes(expected.query) && row.blockers.includes(expected.blocker)))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected a real PostgreSQL authority lock wait");
}

suite("PostgreSQL typed app-grant storage (trusted fixture; no browser authentication)", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    await pool.query(await readFile(new URL("../src/db/migrations/004_rest_accounts.sql", import.meta.url), "utf8"));
    await seedAccount();
    await pool.query(`INSERT INTO rest_bot_grants(id,account_id,bot_address,scopes,label,created_at,expires_at)
      VALUES($1,$2,$3,ARRAY['read'],'legacy',1,9007199254740991)`, [legacyId, accountId, signerAddress]);
    await pool.query(await readFile(new URL("../src/db/migrations/017_rest_wallet_policy.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../src/db/migrations/051_wallet_policy_app_grant_lifetime.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../src/db/migrations/019_rest_wallet_app_grants.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../src/db/migrations/052_wallet_app_grant_lifetime_90d.sql", import.meta.url), "utf8"));
    for (const filename of ["007_rest_smart_accounts.sql", "012_rest_smart_account_onboarding.sql", "014_rest_passkey_onboarding.sql", "042_wallet_binding_consent.sql", "020_rest_wallet_authority.sql", "039_wallet_authority_window.sql", "049_wallet_authority_window_15m.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${filename}`, import.meta.url), "utf8"));
    backfilled = (await pool.query("SELECT id,kind,account_id FROM rest_grant_ids WHERE id=$1", [legacyId])).rows;
    await pool.query("CREATE TABLE wallet_app_claims(id uuid PRIMARY KEY,principal_id text NOT NULL)");
    store = new PostgresWalletAppGrantStore(pool);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE rest_wallet_app_grants,rest_wallet_authority,rest_grant_ids,rest_bot_grants,rest_accounts,rest_wallet_policy_apps,rest_wallet_policy,wallet_app_claims CASCADE");
    await seedAuthority(); await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 0, nextRevision: 1, configuration: policy() });
  });
  afterEach(async () => { vi.restoreAllMocks(); const results = await Promise.allSettled([...children].map(kill)); for (const result of results) if (result.status === "rejected") throw result.reason; });
  afterAll(async () => { try { await pool?.end(); } finally { if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); } } } });

  it("backfills legacy bot IDs and preserves old INSERT ON CONFLICT behavior", async () => {
    expect(backfilled).toEqual([{ id: legacyId, kind: "bot", account_id: accountId }]);
    const statement = `INSERT INTO rest_bot_grants(id,account_id,bot_address,scopes,label,created_at,expires_at)
      VALUES($1,$2,$3,ARRAY['read'],'legacy',1,9007199254740991) ON CONFLICT(id) DO NOTHING RETURNING id`;
    expect((await pool.query(statement, [legacyId, accountId, signerAddress])).rowCount).toBe(1);
    expect((await pool.query(statement, [legacyId, accountId, signerAddress])).rowCount).toBe(0);
    expect(await counts(legacyId)).toEqual({ apps: 0, bots: 1, registry: 1 });
  });
  it("creates a distinct typed app grant with a database incarnation and fixed retention", async () => {
    const request = await input(), before = await now(), grant = await store.insert(request);
    expect(grant).toMatchObject({ kind: "wallet-app", accountId, signerAddress, origin, audience,
      scopes: ["read", "plan", "relay"], authorityEpoch: "1", sessionEpoch: "1", appGeneration: 1, revokedAt: null });
    expect(grant.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(BigInt(grant.incarnation)).toBeGreaterThan(0n); expect(grant.createdAt).toBeGreaterThanOrEqual(before);
    expect(grant.retainUntil).toBe(request.expiresAt + 86400); expect(await get(grant.id)).toEqual(grant);
    expect(walletAppPrincipalId(grant)).toBe(`app:${grant.id}:${grant.incarnation}`);
    await expect(guard(grant)).resolves.toBeUndefined(); await expect(guard(grant, requestContext(await now() + 120))).resolves.toBeUndefined();
    expect(await counts(grant.id)).toEqual({ apps: 1, bots: 0, registry: 1 });
  });
  it("requires existing wallet authority and exact policy without creating missing authority", async () => {
    await seedAccount(otherAccount);
    await expect(store.insert(await input({ accountId: otherAccount }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const changes of [{ expectedAppGeneration: 2 }, { expectedAuthorityEpoch: "2" }, { expectedSessionEpoch: "2" },
      { callbackUri: `${origin}/unregistered` }, { origin: "https://untrusted.example", callbackUri: "https://untrusted.example/return" }])
      await expect(store.insert(await input(changes))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await pool.query("SELECT account_id FROM rest_wallet_authority")).rows).toEqual([{ account_id: accountId }]);
    expect((await counts()).apps).toBe(0);
  });
  it("rejects an epoch-only authority row before app grant insertion", async () => {
    await seedAccount(otherAccount);
    await pool.query("INSERT INTO rest_wallet_authority(account_id,authority_epoch,session_epoch,updated_at) VALUES($1,1,1,1)", [otherAccount]);
    await expect(store.insert(await input({ accountId: otherAccount }))).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect((await counts()).apps).toBe(0);
  });
  it.each(["unknown", "changed", "fenced"] as const)("rejects %s readiness without relying on an epoch change", async readiness => {
    const grant = await store.insert(await input());
    const row = (await pool.query("SELECT snapshot FROM rest_wallet_authority WHERE account_id=$1", [accountId])).rows[0];
    const snapshot = unreadyTrustedWalletAuthority(row.snapshot, readiness, await trustedAuthorityNow(pool));
    await writeTrustedWalletAuthoritySnapshot(pool, snapshot);
    await expect(guard(grant)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(store.insert(await input())).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await counts()).toEqual({ apps: 1, bots: 0, registry: 1 });
  });
  it("rejects caller-selected IDs and malformed authority/lifetime fields before insertion", async () => {
    // Earlier cases can consume seconds before the store samples DB time.
    // The unit suite checks the exact boundary against a fixed creation time.
    for (const changes of [{ id: randomUUID() }, { incarnation: "1" }, { signerAddress: owner }, { scopes: ["read"] },
      { expectedAuthorityEpoch: "01" }, { expectedSessionEpoch: "0" }, { expectedAuthorityEpoch: 1 },
      { expiresAt: await now() - 1 }, { expiresAt: await now() + 91 * 86_400 }, { expiresAt: 1.5 }])
      await expect(store.insert({ ...await input(), ...changes } as Insert)).rejects.toMatchObject({ code: "WALLET_APP_GRANT_INVALID" });
    expect((await counts()).apps).toBe(0);
  });
  it("rejects request origin/audience substitution and actor incarnation aliases", async () => {
    const grant = await store.insert(await input()), expiresAt = await now() + 120;
    for (const context of [requestContext(expiresAt), { ...requestContext(expiresAt), origin: null },
      { kind: "request", origin: otherOrigin, audience, expiresAt }, { kind: "request", origin, audience: origin, expiresAt },
      { kind: "actor", principalId: `bot:${grant.id}` }, { kind: "actor", principalId: `app:${grant.id}` },
      { kind: "actor", principalId: `app:${grant.id}:${BigInt(grant.incarnation) + 1n}` }].slice(1))
      await expect(guard(grant, context as Context)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guard(grant, requestContext(await now() - 1))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects changed or revoked stored grants even when a caller retains an older grant object", async () => {
    const grant = await store.insert(await input());
    await pool.query("UPDATE rest_wallet_app_grants SET revoked_at=created_at WHERE id=$1", [grant.id]);
    await expect(guard(grant)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(pool.query("UPDATE rest_wallet_app_grants SET signer_address=$2 WHERE id=$1", [grant.id, owner])).rejects.toBeDefined();
    expect((await get(grant.id)).signerAddress).toBe(signerAddress);
  });
  it("advances logout/authority epochs by exact CAS and invalidates old grants", async () => {
    const grant = await store.insert(await input());
    expect(await store.advanceEpochs({ accountId, expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", kind: "logout" }))
      .toMatchObject({ accountId, authorityEpoch: "1", sessionEpoch: "2" });
    await expect(guard(grant)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(store.advanceEpochs({ accountId, expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", kind: "logout" })).rejects.toMatchObject({ code: "WALLET_AUTHORITY_CONFLICT" });
    expect(await store.advanceEpochs({ accountId, expectedAuthorityEpoch: "1", expectedSessionEpoch: "2", kind: "authority" }))
      .toMatchObject({ authorityEpoch: "2", sessionEpoch: "3" });
    await expect(store.insert(await input())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(store.insert(await input({ expectedAuthorityEpoch: "2", expectedSessionEpoch: "3" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await refreshTrustedWalletAuthority(pool, accountId);
    await expect(store.insert(await input({ expectedAuthorityEpoch: "2", expectedSessionEpoch: "3" }))).resolves.toMatchObject({ authorityEpoch: "2", sessionEpoch: "3" });
  });
  it("preserves epochs and incarnation beyond Number.MAX_SAFE_INTEGER and rejects epoch overflow", async () => {
    const large = "9007199254740993";
    await pool.query("UPDATE rest_wallet_authority SET authority_epoch=$2,session_epoch=$2 WHERE account_id=$1", [accountId, large]);
    await refreshTrustedWalletAuthority(pool, accountId);
    await pool.query("SELECT setval(pg_get_serial_sequence('rest_wallet_app_grants','incarnation'),$1::bigint,false)", [large]);
    const grant = await store.insert(await input({ expectedAuthorityEpoch: large, expectedSessionEpoch: large }));
    expect(grant.incarnation).toBe(large); expect(grant.authorityEpoch).toBe(large); expect(grant.sessionEpoch).toBe(large);
    await expect(guard(grant)).resolves.toBeUndefined();
    expect(await store.advanceEpochs({ accountId, expectedAuthorityEpoch: large, expectedSessionEpoch: large, kind: "logout" })).toMatchObject({ sessionEpoch: "9007199254740994" });
    await pool.query("UPDATE rest_wallet_authority SET authority_epoch=$2,session_epoch=$2 WHERE account_id=$1", [accountId, "9223372036854775807"]);
    await expect(store.advanceEpochs({ accountId, expectedAuthorityEpoch: "9223372036854775807", expectedSessionEpoch: "9223372036854775807", kind: "authority" }))
      .rejects.toMatchObject({ code: "WALLET_AUTHORITY_CONFLICT" });
    expect((await pool.query("SELECT authority_epoch,session_epoch FROM rest_wallet_authority WHERE account_id=$1", [accountId])).rows[0])
      .toEqual({ authority_epoch: "9223372036854775807", session_epoch: "9223372036854775807" });
  });
  it("fails closed without a partial grant when the database incarnation sequence is exhausted", async () => {
    const prior = (await pool.query(`SELECT last_value::text,is_called FROM rest_wallet_app_grants_incarnation_seq`)).rows[0];
    try {
      await pool.query("SELECT setval(pg_get_serial_sequence('rest_wallet_app_grants','incarnation'),$1::bigint,false)", ["9223372036854775807"]);
      const grant = await store.insert(await input()); expect(grant.incarnation).toBe("9223372036854775807");
      await expect(store.insert(await input())).rejects.toMatchObject({ code: "2200H" });
      expect(await counts()).toEqual({ apps: 1, bots: 0, registry: 1 });
      await expect(guard(grant)).resolves.toBeUndefined();
    } finally {
      // Restore only this disposable fixture's artificial exhaustion; ordinary cleanup must never reset it.
      await pool.query("SELECT setval(pg_get_serial_sequence('rest_wallet_app_grants','incarnation'),$1::bigint,$2)", [prior.last_value, prior.is_called]);
    }
  });
  it("uses database time despite application clock skew", async () => {
    const request = await input(), current = await now(); vi.spyOn(Date, "now").mockReturnValue(1);
    const grant = await store.insert(request); expect(grant.createdAt).toBeGreaterThanOrEqual(current);
    await expect(guard(grant)).resolves.toBeUndefined();
    const expired = await insertRawApp(await rawApp({ createdAt: current - 100, expiresAt: current - 1, retainUntil: current + 86399 }));
    await expect(guard(expired)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("captures admission and epoch inputs before waiting for a pool connection", async () => {
    const constrained = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1, connectionTimeoutMillis: 5000 });
    const waitingStore = new PostgresWalletAppGrantStore(constrained);
    try {
      const lock = await constrained.connect(), admission = await input(), pending = waitingStore.insert(admission);
      admission.origin = otherOrigin; admission.callbackUri = `${otherOrigin}/wallet/callback`; admission.expectedSessionEpoch = "2";
      lock.release();
      expect(await pending).toMatchObject({ origin, callbackUri: `${origin}/wallet/callback`, sessionEpoch: "1" });
      const secondLock = await constrained.connect();
      const advance = { accountId, expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", kind: "logout" as "logout" | "authority" };
      const advancing = waitingStore.advanceEpochs(advance); advance.kind = "authority"; advance.expectedSessionEpoch = "2";
      secondLock.release();
      expect(await advancing).toMatchObject({ authorityEpoch: "1", sessionEpoch: "2" });
    } finally { await constrained.end(); }
  });
  it("arbitrates cross-kind UUID insertion between actual processes with different search paths", async () => {
    await admin.query(`CREATE SCHEMA ${schema}_a`); await admin.query(`CREATE SCHEMA ${schema}_b`);
    try {
      const [a, b] = await Promise.all([worker({}, `${schema}_a`), worker({}, `${schema}_b`)]), value = await rawApp();
      const reached = message(a.child, "barrier"), inserting = a.request({ action: "raw-app", rawValues: value, barrier: "after-grant-write" });
      await reached;
      const competing = b.request({ action: "raw-bot", rawValues: {
        id: value.id, accountId, botAddress: signerAddress, scopes: ["read"], label: "legacy", createdAt: value.createdAt, expiresAt: value.expiresAt,
      } });
      try { await waitingForLock(b.backendPid); } finally { a.child.send("release"); }
      const results = await Promise.all([inserting, competing]);
      expect(results.map(result => result.status).sort()).toEqual([200, 409]);
      const total = await counts(value.id); expect(total.apps + total.bots).toBe(1); expect(total.registry).toBe(1);
      expect((await pool.query("SELECT kind FROM rest_grant_ids WHERE id=$1", [value.id])).rows[0].kind).toBe(total.apps ? "wallet-app" : "bot");
    } finally { await Promise.allSettled([...children].map(kill)); await admin.query(`DROP SCHEMA ${schema}_a CASCADE`); await admin.query(`DROP SCHEMA ${schema}_b CASCADE`); }
  });
  it("cannot downgrade an app to a bot and leaves no registry-only row after rollback", async () => {
    const a = await worker(), grant = await store.insert(await input()), current = await now();
    const bot = { id: grant.id, accountId, botAddress: signerAddress, scopes: ["read"], label: "legacy", createdAt: current, expiresAt: current + 900 };
    expect((await a.request({ action: "raw-bot", rawValues: bot, onConflict: true })).status).toBe(409);
    expect(await counts(grant.id)).toEqual({ apps: 1, bots: 0, registry: 1 });
    for (const kind of ["raw-app", "raw-bot"]) {
      const id = randomUUID(), rawValues = kind === "raw-app" ? await rawApp({ id }) : { ...bot, id };
      expect((await a.request({ action: kind, rawValues, rollback: true })).status).toBe(200);
      expect(await counts(id)).toEqual({ apps: 0, bots: 0, registry: 0 });
    }
  });
  it("enforces global quota atomically across two processes", async () => {
    const [a, b] = await Promise.all([worker({ maxRecords: 2 }), worker({ maxRecords: 2 })]);
    const admissions: Insert[] = [];
    for (let index = 0; index < 8; index++) {
      const id = `eip155:8453:0x${(index + 3).toString(16).padStart(40, "0")}`;
      await seedAuthority(id); admissions.push(await input({ accountId: id }));
    }
    const results = await Promise.all(admissions.map((admission, index) => (index % 2 ? a : b).request({ action: "insert", input: admission })));
    expect(results.filter(result => result.status === 200)).toHaveLength(2);
    expect(results.filter(result => result.status === 429 && result.body.code === "STORAGE_LIMIT")).toHaveLength(6);
    expect(await counts()).toEqual({ apps: 2, bots: 0, registry: 2 });
  });
  it("holds the global quota lock across different accounts until the insert commits", async () => {
    await seedAuthority(otherAccount);
    const [a, b] = await Promise.all([worker({ maxRecords: 1 }), worker({ maxRecords: 1 })]), reached = message(a.child, "barrier");
    const first = a.request({ action: "insert", input: await input(), barrier: "after-grant-write" });
    await reached;
    const second = b.request({ action: "insert", input: await input({ accountId: otherAccount }) });
    try { await waitingForLock(b.backendPid); } finally { a.child.send("release"); }
    expect((await first).status).toBe(200); expect(await second).toMatchObject({ status: 429, body: { code: "STORAGE_LIMIT" } });
    expect(await counts()).toEqual({ apps: 1, bots: 0, registry: 1 });
  });
  it("counts only live grants toward the account and application caps, signing out the oldest at the application cap", async () => {
    const limited = new PostgresWalletAppGrantStore(pool, { maxAccountRecords: 2, maxOriginRecords: 1 });
    const first = await limited.insert(await input());
    await pool.query("UPDATE rest_wallet_app_grants SET revoked_at=created_at WHERE id=$1", [first.id]);
    // A revoked grant no longer counts; at the application cap the oldest live grant is signed out for the new one.
    const second = await limited.insert(await input()), third = await limited.insert(await input());
    const live = async () => (await pool.query("SELECT id FROM rest_wallet_app_grants WHERE origin=$1 AND revoked_at IS NULL ORDER BY created_at, id", [origin])).rows.map(row => row.id);
    expect(await live()).toEqual([third.id]); expect(second.id).not.toBe(third.id);
    expect((await pool.query("SELECT revoked_at FROM rest_wallet_app_grants WHERE id=$1", [second.id])).rows[0]!.revoked_at).not.toBeNull();
    // The account cap counts live grants across applications and still refuses.
    await limited.insert(await input({ origin: otherOrigin, callbackUri: `${otherOrigin}/wallet/callback` }));
    await expect(limited.insert(await input({ origin: otherOrigin, callbackUri: `${otherOrigin}/wallet/callback` }))).rejects.toMatchObject({ code: "STORAGE_LIMIT" });
    await seedAuthority(otherAccount); await expect(limited.insert(await input({ accountId: otherAccount }))).resolves.toMatchObject({ accountId: otherAccount });
    // An expired grant no longer counts either.
    const expiredAccount = `eip155:8453:0x${"33".repeat(20)}`, current = await now(); await seedAuthority(expiredAccount);
    await insertRawApp(await rawApp({ accountId: expiredAccount, createdAt: current - 100, expiresAt: current - 1, retainUntil: current + 86399 }));
    await expect(limited.insert(await input({ accountId: expiredAccount }))).resolves.toMatchObject({ accountId: expiredAccount });
  });
  it("retains the 24-hour grace, cleans a bounded batch, skips locked accounts and preserves bot reservations", async () => {
    const current = await now(), grace = await insertRawApp(await rawApp({ createdAt: current - 89900, expiresAt: current - 86300, retainUntil: current + 100 }));
    await seedAuthority(otherAccount);
    const eligible = await insertRawApp(await rawApp({ createdAt: current - 90000, expiresAt: current - 86401, retainUntil: current - 1 }));
    const other = await insertRawApp(await rawApp({ accountId: otherAccount, createdAt: current - 90000, expiresAt: current - 86401, retainUntil: current - 1 }));
    await pool.query("INSERT INTO rest_bot_grants(id,account_id,bot_address,scopes,label,created_at,expires_at) VALUES($1,$2,$3,ARRAY['read'],'retired',1,2)", [legacyId, accountId, signerAddress]);
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN"); await lock.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId]);
      expect(await store.cleanup(1)).toBe(1); expect(await counts(other.id)).toEqual({ apps: 0, bots: 0, registry: 0 });
      expect((await counts(eligible.id)).apps).toBe(1); await lock.query("ROLLBACK");
    } finally { await lock.query("ROLLBACK"); lock.release(); }
    expect(await store.cleanup(1)).toBe(1); expect(await store.cleanup(1)).toBe(0);
    expect((await counts(grace.id)).apps).toBe(1); expect(await counts(legacyId)).toEqual({ apps: 0, bots: 1, registry: 1 });
  });
  it("never revives an old actor when a cleaned UUID is reinserted with a new database incarnation", async () => {
    const current = await now(), expired = await insertRawApp(await rawApp({ createdAt: current - 90000, expiresAt: current - 86401, retainUntil: current - 1 }));
    const oldActor = actorContext(expired); expect(await store.cleanup()).toBe(1);
    const replacement = await insertRawApp(await rawApp({ id: expired.id }));
    expect(BigInt(replacement.incarnation)).toBeGreaterThan(BigInt(expired.incarnation));
    await expect(guard(replacement, oldActor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guard(replacement)).resolves.toBeUndefined(); await expect(guard(expired)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each(["logout", "authority"] as const)("holds account authority through a local durable claim before %s can commit", async kind => {
    const grant = await store.insert(await input()), [a, b] = await Promise.all([worker(), worker()]), claimId = randomUUID();
    const reached = message(a.child, "barrier"), claiming = a.request({ action: "claim", id: grant.id, context: actorContext(grant), claimId, barrier: "after-guard" });
    await reached;
    const advancing = b.request({ action: "epochs", input: { accountId, expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", kind } });
    try { await waitingForLock(b.backendPid); } finally { a.child.send("release"); }
    expect((await claiming).status).toBe(200); expect((await advancing).status).toBe(200);
    expect((await pool.query("SELECT id,principal_id FROM wallet_app_claims")).rows).toEqual([{ id: claimId, principal_id: walletAppPrincipalId(grant) }]);
    expect((await a.request({ action: "claim", id: grant.id, context: actorContext(grant), claimId: randomUUID() })).status).toBe(403);
  });
  it.each(["logout", "authority"] as const)("rejects a waiting claim when %s commits first", async kind => {
    const grant = await store.insert(await input()), [a, b] = await Promise.all([worker(), worker()]);
    const reached = message(a.child, "barrier");
    const advancing = a.request({ action: "epochs", input: { accountId, expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", kind }, barrier: "after-epoch-write" });
    await reached;
    const claiming = b.request({ action: "claim", id: grant.id, context: actorContext(grant), claimId: randomUUID() });
    try { await waitingForLock(b.backendPid); } finally { a.child.send("release"); }
    expect((await advancing).status).toBe(200); expect((await claiming).status).toBe(403);
    expect((await pool.query("SELECT count(*)::int AS count FROM wallet_app_claims")).rows[0].count).toBe(0);
  });
  it("holds the grant row through claim commit even against a direct SQL revocation", async () => {
    const grant = await store.insert(await input()), a = await worker(), revoker = await pool.connect();
    try {
      const backendPid = (await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const reached = message(a.child, "barrier"), claiming = a.request({ action: "claim", id: grant.id,
        context: actorContext(grant), claimId: randomUUID(), barrier: "after-guard" });
      await reached; await revoker.query("BEGIN");
      const revoking = revoker.query("UPDATE rest_wallet_app_grants SET revoked_at=created_at WHERE id=$1", [grant.id]);
      try { await waitingForLock(backendPid); } finally { a.child.send("release"); }
      expect((await claiming).status).toBe(200); await revoking; await revoker.query("COMMIT");
      await expect(guard(grant)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await pool.query("SELECT count(*)::int AS count FROM wallet_app_claims")).rows[0].count).toBe(1);
    } finally { await revoker.query("ROLLBACK"); revoker.release(); }
  });
  it("holds current app policy through claim commit and denies the next claim after removal", async () => {
    const grant = await store.insert(await input()), [a, b] = await Promise.all([worker(), worker()]);
    const reached = message(a.child, "barrier"), claiming = a.request({ action: "claim", id: grant.id, context: actorContext(grant), claimId: randomUUID(), barrier: "after-guard" });
    await reached; const removing = b.request({ action: "policy", input: { expectedRevision: 1, nextRevision: 2, configuration: policy([otherOrigin]) } });
    try { await waitingForLock(b.backendPid); } finally { a.child.send("release"); }
    expect((await claiming).status).toBe(200); expect((await removing).status).toBe(200);
    expect((await a.request({ action: "claim", id: grant.id, context: actorContext(grant), claimId: randomUUID() })).status).toBe(403);
    expect((await pool.query("SELECT count(*)::int AS count FROM wallet_app_claims")).rows[0].count).toBe(1);
  });
  it("rejects a grant expiring while account admission waits and a request expiring before final commit", async () => {
    const a = await worker(), lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      const blocker = Number((await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const grant = await store.insert(await input({ expiresAt: Math.ceil(await trustedAuthorityNow(pool) / 1000) + 5 }));
      await lock.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId]);
      const pending = a.request({ action: "claim", id: grant.id, context: actorContext(grant), claimId: randomUUID() });
      await Promise.race([waitingForLock(a.backendPid, { blocker, query: "FROM rest_accounts" }),
        pending.then(result => { throw new Error(`Claim returned before account lock: ${JSON.stringify(result)}`); })]);
      expect(await now()).toBeLessThan(grant.expiresAt);
      await lock.query("SELECT pg_sleep(GREATEST(0,$1::double precision-extract(epoch FROM clock_timestamp())::double precision)+0.05)", [grant.expiresAt]);
      await lock.query("COMMIT");
      expect((await pending).status).toBe(403);
    } finally { await lock.query("ROLLBACK"); lock.release(); }
    const live = await store.insert(await input()), reached = message(a.child, "barrier");
    const expiresAt = Math.ceil(await trustedAuthorityNow(pool) / 1000) + 5;
    const pending = a.request({ action: "claim", id: live.id, context: requestContext(expiresAt), claimId: randomUUID(), barrier: "after-guard" });
    try {
      await Promise.race([reached, pending.then(result => { throw new Error(`Claim returned before guard barrier: ${JSON.stringify(result)}`); })]);
      expect(await now()).toBeLessThan(expiresAt);
      await pool.query("SELECT pg_sleep(GREATEST(0,$1::double precision-extract(epoch FROM clock_timestamp())::double precision)+0.05)", [expiresAt]);
    } finally { a.child.send("release"); }
    expect((await pending).status).toBe(403);
    expect((await pool.query("SELECT count(*)::int AS count FROM wallet_app_claims")).rows[0].count).toBe(0);
  });
  it("rechecks database expiry after waiting for the policy lock", async () => {
    const a = await worker(), lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      const blocker = Number((await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const grant = await store.insert(await input({ expiresAt: Math.ceil(await trustedAuthorityNow(pool) / 1000) + 5 }));
      await lock.query("SELECT origin FROM rest_wallet_policy_apps WHERE origin=$1 FOR UPDATE", [origin]);
      const pending = a.request({ action: "claim", id: grant.id, context: actorContext(grant), claimId: randomUUID() });
      await Promise.race([waitingForLock(a.backendPid, { blocker, query: "FROM rest_wallet_policy_apps" }),
        pending.then(result => { throw new Error(`Claim returned before policy lock: ${JSON.stringify(result)}`); })]);
      expect(await now()).toBeLessThan(grant.expiresAt);
      await lock.query("SELECT pg_sleep(GREATEST(0,$1::double precision-extract(epoch FROM clock_timestamp())::double precision)+0.05)", [grant.expiresAt]);
      await lock.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect((await pool.query("SELECT count(*)::int AS count FROM wallet_app_claims")).rows[0].count).toBe(0);
    } finally { await lock.query("ROLLBACK"); lock.release(); }
  });
  it.each(["after-grant-write", "after-commit"])("recovers storage consistently after a fixture crash %s", async barrier => {
    const a = await worker(), reached = message(a.child, "barrier");
    const inserting = a.request({ action: "insert", input: await input(), barrier }).catch(() => null);
    await reached; await kill(a.child); await inserting;
    const expected = barrier === "after-commit" ? 1 : 0; expect(await counts()).toEqual({ apps: expected, bots: 0, registry: expected });
  });
});
