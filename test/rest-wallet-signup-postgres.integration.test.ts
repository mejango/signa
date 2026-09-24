import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { PostgresWalletSignupStore } from "../src/rest/wallet/signupPostgres.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { walletEnrollmentDocument } from "../src/rest/wallet/enrollment.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const rpId = "wallet.juicebox.center", origin = "https://wallet.juicebox.center";
const policy = { rpId, origin, manifest: enrollmentManifest };
suite("durable pre-account signup continuation and purpose-bound recovery", () => {
  const schema = `rest_wallet_signup_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, store: PostgresWalletSignupStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 });
    for (const name of ["013_rest_wallet_ceremonies.sql", "015_rest_wallet_enrollment.sql", "046_wallet_signup_window.sql", "041_wallet_passkey_name.sql", "043_wallet_networks.sql", "044_wallet_devices.sql", "027_wallet_signup.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    store = new PostgresWalletSignupStore(pool, policy);
  });
  beforeEach(async () => { await pool.query("TRUNCATE rest_wallet_signup_resumes,rest_wallet_signup_flows,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE"); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
  async function registered(options: { enrollmentLifetimeMs?: number } = {}) {
    const current = new PostgresWalletSignupStore(pool, { ...policy, ...options });
    const begun = await current.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName: "Juicebox test" });
    const enrollment = await new PostgresWalletEnrollmentStore(pool).get(begun.flow.enrollmentId);
    const credential = createRegistration({ rpId, origin, userHandle: enrollment!.intent.userHandle,
      challenge: `0x${Buffer.from(enrollment!.intent.registration.challenge, "base64url").toString("hex")}` });
    const pending = await new PostgresWalletEnrollmentStore(pool).acceptRegistration(begun.flow.enrollmentId, credential.response);
    return { current, begun, credential, pending };
  }
  async function verify(value: Awaited<ReturnType<typeof registered>>) {
    const document = walletEnrollmentDocument(value.pending);
    return (await new PostgresWalletEnrollmentStore(pool).finalize(value.pending.intent.id, {
      assertion: signGet({ ...value.credential, rpId, origin, challenge: hashTypedData(document) }), backupSignature: await signBackupProof(document) })).record;
  }
  it("owns immutable enrollment parameters, persists the editable name and stores no continuation secrets", async () => {
    const value = await registered();
    const flow = await new PostgresWalletSignupStore(pool, policy).authenticate(value.begun.flowToken);
    expect(flow).toEqual(value.begun.flow); expect(flow!.passkeyName).toBe("Juicebox test");
    expect(value.pending.intent.rpId).toBe(rpId);
    expect(await store.authenticate(randomBytes(32).toString("base64url"))).toBeNull();
    expect(await store.authenticate(flow!.id)).toBeNull();
    const stored = (await pool.query("SELECT to_jsonb(f)::text AS value FROM rest_wallet_signup_flows f")).rows[0].value;
    expect(stored).not.toContain(value.begun.flowToken);
    for (const extra of [{ rpId: "attacker.example" }, { manifest: enrollmentManifest }, { saltNonce: "1" }, { accountId: "x" }])
      await expect(store.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName: "Juicebox test", ...extra })).rejects.toMatchObject({ status: 400 });
    for (const passkeyName of ["", " ", "a\nb", "a\u202eb", "é".repeat(61)])
      await expect(store.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName })).rejects.toMatchObject({ status: 400 });
  });
  it("recovers a registered candidate after cookie loss, rotates the old token and makes lost-response retries exact", async () => {
    const value = await registered(), resume = await store.beginResume();
    const input = { resumeId: resume.challenge.id, resumeToken: resume.resumeToken,
      assertion: signGet({ ...value.credential, rpId, origin, challenge: resume.challenge.challenge }) };
    const recovered = await store.completeResume(input);
    expect(recovered.flow.enrollmentId).toBe(value.pending.intent.id);
    expect(recovered.flowToken).not.toBe(value.begun.flowToken);
    expect(await store.authenticate(value.begun.flowToken)).toBeNull();
    expect(await store.authenticate(recovered.flowToken)).toEqual(recovered.flow);
    expect(await new PostgresWalletSignupStore(pool, policy).completeResume(input)).toEqual({ ...recovered, replayed: true });
    expect(await new PostgresWalletEnrollmentStore(pool).get(value.pending.intent.id)).toEqual(value.pending);
    const rows = (await pool.query("SELECT to_jsonb(r)::text AS value FROM rest_wallet_signup_resumes r")).rows[0].value;
    expect(rows).not.toContain(resume.resumeToken); expect(rows).not.toContain(recovered.flowToken);
  });
  it("keeps continuation reads, locked mutations and resume replays on the enrollment's original origin", async () => {
    const value = await registered(), signa = new PostgresWalletSignupStore(pool, { ...policy, origin: "https://signa.center", rpId: "signa.center" });
    const other = await signa.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName: "Signa test" });
    expect(await signa.authenticate(other.flowToken)).toEqual(other.flow);
    expect(await store.authenticate(other.flowToken)).toBeNull();
    expect(await signa.authenticate(value.begun.flowToken)).toBeNull();
    for (const [wrongStore, begun] of [[signa, value.begun], [store, other]] as const)
      await expect(wrongStore.associateDeployment(begun.flowToken, begun.flow.revision, randomUUID())).rejects.toMatchObject({ status: 403 });
    const resume = await store.beginResume();
    const input = { resumeId: resume.challenge.id, resumeToken: resume.resumeToken,
      assertion: signGet({ ...value.credential, rpId, origin, challenge: resume.challenge.challenge }) };
    await expect(signa.completeResume(input)).rejects.toMatchObject({ status: 403 });
    expect(await store.authenticate(value.begun.flowToken)).toEqual(value.begun.flow);
    const resumed = await store.completeResume(input);
    await expect(signa.completeResume(input)).rejects.toMatchObject({ status: 403 });
    expect(await store.completeResume(input)).toEqual({ ...resumed, replayed: true });
    expect(await signa.authenticate(resumed.flowToken)).toBeNull();
    expect(await store.authenticate(resumed.flowToken)).toEqual(resumed.flow);
  });
  it("never treats a locator, old purpose, other credential, missing user handle or different RP as recovery authority", async () => {
    const value = await registered(), other = await registered(), resume = await store.beginResume();
    const good = signGet({ ...value.credential, rpId, origin, challenge: resume.challenge.challenge });
    for (const assertion of [
      { ...good, userHandle: null }, { ...good, credentialId: other.credential.credentialId },
      signGet({ ...other.credential, userHandle: value.credential.userHandle, rpId, origin, challenge: resume.challenge.challenge }),
      signGet({ ...value.credential, rpId, origin: "https://evil.example", challenge: resume.challenge.challenge }),
      signGet({ ...value.credential, rpId: "evil.example", origin, challenge: resume.challenge.challenge }),
      signGet({ ...value.credential, rpId, origin, challenge: hashTypedData(walletEnrollmentDocument(value.pending)) }),
    ]) await expect(store.completeResume({ resumeId: resume.challenge.id, resumeToken: resume.resumeToken, assertion })).rejects.toMatchObject({ status: 403 });
    await expect(store.completeResume({ resumeId: resume.challenge.id, resumeToken: value.begun.flowToken, assertion: good })).rejects.toMatchObject({ status: 403 });
    expect(await store.authenticate(value.begun.flowToken)).not.toBeNull();
    expect((await store.completeResume({ resumeId: resume.challenge.id, resumeToken: resume.resumeToken, assertion: good })).replayed).toBe(false);
  });
  it("accepts a signup made inside an admitted app's frame only when every ceremony names that app", async () => {
    const app = "https://homerun.money", enrollments = new PostgresWalletEnrollmentStore(pool);
    const begun = await store.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName: "Juicebox test" });
    const enrollment = await enrollments.get(begun.flow.enrollmentId);
    const registration = (topOrigin?: string) => createRegistration({ rpId, origin, userHandle: enrollment!.intent.userHandle,
      challenge: `0x${Buffer.from(enrollment!.intent.registration.challenge, "base64url").toString("hex")}`, ...(topOrigin ? { topOrigin } : {}) });
    // A framed creation is refused without the admission, and under another app; admitted, it is the same candidate.
    await expect(enrollments.acceptRegistration(begun.flow.enrollmentId, registration(app).response)).rejects.toMatchObject({ status: 400 });
    await expect(enrollments.acceptRegistration(begun.flow.enrollmentId, registration(app).response, { topOrigin: "https://beep.biz" })).rejects.toMatchObject({ status: 400 });
    const credential = registration(app);
    const pending = await enrollments.acceptRegistration(begun.flow.enrollmentId, credential.response, { topOrigin: app });
    const document = walletEnrollmentDocument(pending), backupSignature = await signBackupProof(document);
    const proof = (topOrigin?: string) => ({ assertion: signGet({ ...credential, rpId, origin, challenge: hashTypedData(document), ...(topOrigin ? { topOrigin } : {}) }), backupSignature });
    await expect(enrollments.finalize(pending.intent.id, proof(app))).rejects.toMatchObject({ status: 403 });
    await expect(enrollments.finalize(pending.intent.id, proof(app), { topOrigin: "https://beep.biz" })).rejects.toMatchObject({ status: 403 });
    const verified = await enrollments.finalize(pending.intent.id, proof(app), { topOrigin: app });
    expect(verified.record.state).toBe("verified");
    // The framed resume names the app too.
    const resume = await store.beginResume();
    const resumption = (topOrigin?: string) => ({ resumeId: resume.challenge.id, resumeToken: resume.resumeToken,
      assertion: signGet({ ...credential, rpId, origin, challenge: resume.challenge.challenge, ...(topOrigin ? { topOrigin } : {}) }) });
    await expect(store.completeResume(resumption(app))).rejects.toMatchObject({ status: 403 });
    expect((await store.completeResume(resumption(app), { topOrigin: app })).flow.enrollmentId).toBe(pending.intent.id);
  });
  it("lets a verified enrollment resume after its original deadline without renewing genesis", async () => {
    const value = await registered({ enrollmentLifetimeMs: 1500 }), record = await verify(value);
    await pool.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.03)", [record.intent.expiresAt]);
    const resume = await store.beginResume(), recovered = await store.completeResume({ resumeId: resume.challenge.id, resumeToken: resume.resumeToken,
      assertion: signGet({ ...value.credential, rpId, origin, challenge: resume.challenge.challenge }) });
    expect(recovered.flow.enrollmentId).toBe(record.intent.id);
    expect(await new PostgresWalletEnrollmentStore(pool).get(record.intent.id)).toEqual(record);
  });
  it("does not renew expired unverified genesis or resume a superseded verified credential", async () => {
    // Registration signs a genuine credential, so the window covers that work and the wait
    // that outlives it comes from the database clock the enrollment store reads.
    const expired = await registered({ enrollmentLifetimeMs: 3_000 });
    await pool.query("SELECT pg_sleep(greatest(0, $1::bigint + 50 - floor(extract(epoch FROM clock_timestamp())*1000)) / 1000.0)",
      [String(expired.pending.intent.expiresAt)]);
    let resume = await store.beginResume();
    await expect(store.completeResume({ resumeId: resume.challenge.id, resumeToken: resume.resumeToken,
      assertion: signGet({ ...expired.credential, rpId, origin, challenge: resume.challenge.challenge }) })).rejects.toMatchObject({ status: 410 });
    const value = await registered(), record = await verify(value);
    await pool.query("UPDATE rest_wallet_credentials SET superseded_at=verified_at WHERE enrollment_id=$1", [record.intent.id]);
    resume = await store.beginResume();
    await expect(store.completeResume({ resumeId: resume.challenge.id, resumeToken: resume.resumeToken,
      assertion: signGet({ ...value.credential, rpId, origin, challenge: resume.challenge.challenge }) })).rejects.toMatchObject({ status: 403 });
  });
  it("admits one durable winner across replicas without restoring an older rotated continuation", async () => {
    const value = await registered(), resume = await store.beginResume();
    const input = { resumeId: resume.challenge.id, resumeToken: resume.resumeToken,
      assertion: signGet({ ...value.credential, rpId, origin, challenge: resume.challenge.challenge }) };
    const results = await Promise.all([store.completeResume(input), new PostgresWalletSignupStore(pool, policy).completeResume(input)]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(results[0].flowToken).toBe(results[1].flowToken);
    const next = await store.beginResume();
    await store.completeResume({ resumeId: next.challenge.id, resumeToken: next.resumeToken,
      assertion: signGet({ ...value.credential, rpId, origin, challenge: next.challenge.challenge }) });
    await expect(store.completeResume(input)).rejects.toMatchObject({ status: 409 });
  });
  it("enforces durable global admission bounds across concurrent replicas", async () => {
    const small = new PostgresWalletSignupStore(pool, { ...policy, maxFlows: 2, maxResumes: 2 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => small.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName: "Juicebox test" })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_enrollments")).rows[0].count).toBe(2);
    const resumes = await Promise.allSettled(Array.from({ length: 5 }, () => small.beginResume()));
    expect(resumes.filter(result => result.status === "fulfilled")).toHaveLength(2);
  });
});
