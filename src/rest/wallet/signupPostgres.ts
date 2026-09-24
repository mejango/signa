import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isAddress, type Address, type Hex } from "viem";
import { RestError } from "../core.js";
import type { SmartAccountManifest } from "../smartAccounts/types.js";
import { validatePasskeyOnboardingInput, type PasskeyOnboardingInput } from "../smartAccounts/passkeyOnboarding.js";
import { createWalletEnrollmentIntent, enrollmentDigest, type WalletEnrollment } from "./enrollment.js";
import { currentWalletCredentialInTransaction, lockWalletEnrollmentInTransaction, PostgresWalletEnrollmentStore } from "./enrollmentPostgres.js";
import { lockWalletCeremonyAdmission, PostgresWalletCeremonyStore, walletCeremonyDatabaseNow } from "./ceremoniesPostgres.js";
import { walletCeremonyRetentionMs, type WalletCeremonyDraft } from "./ceremonies.js";
import { validateWalletRpConfiguration, verifyWalletAssertion, type WalletAssertion, type WalletCeremonyOptions } from "./webauthn.js";

export interface WalletSignupFlow {
  id: string; enrollmentId: string; passkeyName: string; expiresAtMs: number; revision: number;
  deploymentId: string | null; setup: WalletSignupSetup | null;
}
export interface WalletSignupSetup {
  id: string; input: PasskeyOnboardingInput; stateHash: Hex; manifestRevision: Hex; initializerHash: Hex;
}
interface FlowRow {
  id: string; enrollment_id: string; token_hash: string; passkey_name: string; expires_at_ms: string; revision: string;
  deployment_id: string | null; setup_document: WalletSignupSetup | null;
}
interface ResumeDraft {
  id: string; rpId: string; origin: string; issuedAtMs: number; expiresAtMs: number; nextTokenHash: string;
  resumeTokenHash: string; nonce: string; ceremony: WalletCeremonyDraft;
}
interface ResumeRow {
  id: string; draft: ResumeDraft; resume_token_hash: string; next_token_hash: string; expires_at_ms: string;
  completed_at_ms: string | null; flow_id: string | null; proof_digest: string | null;
}
export interface WalletSignupPolicy {
  rpId: string; origin: string; manifest: SmartAccountManifest;
  maxFlows?: number; maxResumes?: number; flowLifetimeMs?: number; enrollmentLifetimeMs?: number; resumeLifetimeMs?: number;
}
const sqlNow = "floor(extract(epoch FROM clock_timestamp())*1000)::bigint";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const token = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, "base64url").toString("base64url") === value;
function invalid(): never { throw new RestError(400, "WALLET_SIGNUP_INVALID", "Signup fields or bounds are invalid."); }
function unauthorized(): never { throw new RestError(403, "WALLET_SIGNUP_UNAUTHORIZED", "A matching signup continuation or fresh passkey proof is required."); }
function expired(): never { throw new RestError(410, "WALLET_SIGNUP_EXPIRED", "This unverified signup or recovery challenge expired. Start a fresh registration or recovery challenge."); }
function conflict(): never { throw new RestError(409, "WALLET_SIGNUP_CONFLICT", "Signup changed. Reload its current state before continuing."); }
function hashToken(value: string, kind: "flow" | "resume") { return createHash("sha256").update(`center-wallet-signup-${kind}-v1:${value}`).digest("hex"); }
function nextToken(resumeToken: string) { return createHmac("sha256", Buffer.from(resumeToken, "base64url")).update("center-wallet-signup-continuation-v1").digest("base64url"); }
function flowOf(row: FlowRow): WalletSignupFlow {
  return { id: row.id, enrollmentId: row.enrollment_id, passkeyName: row.passkey_name, expiresAtMs: Number(row.expires_at_ms),
    revision: Number(row.revision), deploymentId: row.deployment_id, setup: row.setup_document };
}
function resumeChallenge(draft: ResumeDraft) {
  return { id: draft.id, rpId: draft.rpId, origin: draft.origin, expiresAtMs: draft.expiresAtMs,
    challenge: `0x${Buffer.from(draft.ceremony.challenge, "base64url").toString("hex")}` as Hex };
}
function fields(value: unknown, keys: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  const own = value && typeof value === "object" ? Reflect.ownKeys(value) : [];
  if (!value || typeof value !== "object" || Array.isArray(value) || own.length < keys.length || own.length > keys.length + optional.length ||
    own.some(key => typeof key !== "string" || (!keys.includes(key) && !optional.includes(key))) ||
    keys.some(key => !Object.hasOwn(value, key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) invalid();
}
export function copyWalletSignupAssertion(value: WalletAssertion): WalletAssertion {
  try {
    fields(value, ["credentialId", "userHandle", "authenticatorData", "clientDataJSON", "signature"]);
    if (typeof value.credentialId !== "string" || !/^[A-Za-z0-9_-]{1,1364}$/.test(value.credentialId) || !token(value.userHandle)) unauthorized();
    const copy = (input: Uint8Array, minimum: number, maximum: number) => {
      if (!(input instanceof Uint8Array) || input.byteLength < minimum || input.byteLength > maximum) unauthorized();
      return Uint8Array.from(input);
    };
    return { credentialId: value.credentialId, userHandle: value.userHandle, authenticatorData: copy(value.authenticatorData, 37, 37),
      clientDataJSON: copy(value.clientDataJSON, 1, 2048), signature: copy(value.signature, 8, 72) };
  } catch { unauthorized(); }
}

/** Internal pre-account continuation. HTTP must add same-origin admission, HttpOnly cookies
 * and CSRF. No method issues a login, app grant, deployment approval or spending principal. */
export class PostgresWalletSignupStore {
  private readonly policy: Required<WalletSignupPolicy>;
  private readonly enrollments: PostgresWalletEnrollmentStore;
  private readonly ceremonies: PostgresWalletCeremonyStore;
  constructor(private readonly pool: Pool, options: WalletSignupPolicy) {
    this.policy = { maxFlows: 100_000, maxResumes: 100_000, flowLifetimeMs: 1_800_000,
      enrollmentLifetimeMs: 900_000, resumeLifetimeMs: 180_000, ...structuredClone(options) };
    const p = this.policy;
    validateWalletRpConfiguration(p);
    for (const [value, maximum] of [[p.maxFlows, 1_000_000], [p.maxResumes, 1_000_000], [p.flowLifetimeMs, 86_400_000],
      [p.enrollmentLifetimeMs, 900_000], [p.resumeLifetimeMs, 300_000]] as const)
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
    // Validate the configured immutable profile at construction, without creating authority.
    createWalletEnrollmentIntent({ manifest: p.manifest, rpId: p.rpId, origin: p.origin,
      recoveryOwner: "0x1111111111111111111111111111111111111111", expiresAt: 1_800_000_000_000 });
    this.enrollments = new PostgresWalletEnrollmentStore(pool); this.ceremonies = new PostgresWalletCeremonyStore(pool);
  }
  async begin(input: { recoveryOwner: Address; passkeyName: string }): Promise<{ flow: WalletSignupFlow; flowToken: string }> {
    fields(input, ["recoveryOwner", "passkeyName"]);
    const { recoveryOwner, passkeyName } = input;
    if (!isAddress(recoveryOwner) || BigInt(recoveryOwner) <= 1n || typeof passkeyName !== "string" ||
      passkeyName !== passkeyName.trim() || !passkeyName.length || Buffer.byteLength(passkeyName) > 120 ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(passkeyName)) invalid();
    return this.transaction(async client => {
      await this.admit(client, "flows", this.policy.maxFlows);
      const now = await walletCeremonyDatabaseNow(client), flowToken = randomBytes(32).toString("base64url");
      const enrollment = await this.enrollments.beginInTransaction(client, createWalletEnrollmentIntent({ manifest: this.policy.manifest,
        rpId: this.policy.rpId, origin: this.policy.origin, recoveryOwner, expiresAt: now + this.policy.enrollmentLifetimeMs }));
      const row = (await client.query<FlowRow>(`INSERT INTO rest_wallet_signup_flows(id,enrollment_id,token_hash,passkey_name,created_at_ms,expires_at_ms)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), enrollment.intent.id, hashToken(flowToken, "flow"), passkeyName, now, now + this.policy.flowLifetimeMs])).rows[0]!;
      if (enrollment.intent.expiresAt <= await walletCeremonyDatabaseNow(client) || Number(row.expires_at_ms) <= await walletCeremonyDatabaseNow(client)) expired();
      return { flow: flowOf(row), flowToken };
    });
  }
  async authenticate(flowToken: string): Promise<WalletSignupFlow | null> {
    if (!token(flowToken)) return null;
    const row = (await this.pool.query<FlowRow & { origin: string; rp_id: string }>(`SELECT f.*,e.intent->>'origin' AS origin,e.intent->>'rpId' AS rp_id
      FROM rest_wallet_signup_flows f JOIN rest_wallet_enrollments e ON e.id=f.enrollment_id WHERE f.token_hash=$1 AND f.expires_at_ms>${sqlNow}`,
      [hashToken(flowToken, "flow")])).rows[0];
    return row?.origin === this.policy.origin && row.rp_id === this.policy.rpId ? flowOf(row) : null;
  }
  /** Host clock for original review issuance. The authoritative mutation checks DB time again. */
  async now(): Promise<number> {
    return Number((await this.pool.query(`SELECT ${sqlNow} AS now`)).rows[0].now);
  }
  /** Associate only a prepared, live review for this exact enrollment. A claimed operation
   * can never be replaced, including after cookie or approval expiry. */
  async associateDeployment(flowToken: string, expectedRevision: number, operationId: string): Promise<WalletSignupFlow> {
    if (!uuid.test(operationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalid();
    return this.transaction(async client => {
      const row = await this.lockFlow(client, flowToken);
      if (row.deployment_id === operationId) return flowOf(row);
      if (Number(row.revision) !== expectedRevision) conflict();
      type Operation = { id: string; enrollment_id: string; state: string; approval: { expiresAt: number } };
      // Stable UUID order if there are two reviews. No parent pool/enrollment lock follows.
      const operations = (await client.query<Operation>(`SELECT id,enrollment_id,state,approval FROM rest_wallet_deployments
        WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[row.deployment_id, operationId].filter(Boolean)])).rows;
      const next = operations.find(item => item.id === operationId), old = operations.find(item => item.id === row.deployment_id);
      const now = await walletCeremonyDatabaseNow(client);
      if (!next || next.enrollment_id !== row.enrollment_id || next.state !== "prepared" || next.approval.expiresAt <= now ||
        (row.deployment_id !== null && (!old || old.state !== "prepared" || old.approval.expiresAt > now))) conflict();
      const updated = (await client.query<FlowRow>("UPDATE rest_wallet_signup_flows SET deployment_id=$2,revision=revision+1 WHERE id=$1 RETURNING *",
        [row.id, operationId])).rows[0]!;
      const after = await walletCeremonyDatabaseNow(client);
      if (Number(updated.expires_at_ms) <= after || next.approval.expiresAt <= after) expired();
      return flowOf(updated);
    });
  }
  /** A persisted setup review contains public commitments and a browser public key only. */
  async associateSetup(flowToken: string, expectedRevision: number, input: WalletSignupSetup): Promise<WalletSignupFlow> {
    enrollmentDigest(input); fields(input, ["id", "input", "stateHash", "manifestRevision", "initializerHash"]);
    const setup = structuredClone(input);
    if (!uuid.test(setup.id) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
      [setup.stateHash, setup.manifestRevision, setup.initializerHash].some(value => !/^0x[0-9a-f]{64}$/.test(value))) invalid();
    return this.transaction(async client => {
      const row = await this.lockFlow(client, flowToken);
      if (row.setup_document && enrollmentDigest(row.setup_document) === enrollmentDigest(setup)) return flowOf(row);
      const now = await walletCeremonyDatabaseNow(client);
      validatePasskeyOnboardingInput(setup.input, Math.floor(now / 1000));
      if (Number(row.revision) !== expectedRevision || (row.setup_document && row.setup_document.input.expiresAt * 1000 > now)) conflict();
      const updated = (await client.query<FlowRow>("UPDATE rest_wallet_signup_flows SET setup_document=$2::jsonb,revision=revision+1 WHERE id=$1 RETURNING *",
        [row.id, JSON.stringify(setup)])).rows[0]!;
      const after = await walletCeremonyDatabaseNow(client);
      if (Number(updated.expires_at_ms) <= after || setup.input.expiresAt * 1000 <= after) expired();
      return flowOf(updated);
    });
  }
  async beginResume() {
    return this.transaction(async client => {
      await this.admit(client, "resumes", this.policy.maxResumes);
      const issuedAtMs = await walletCeremonyDatabaseNow(client), resumeToken = randomBytes(32).toString("base64url");
      const context = { version: "center-wallet-signup-resume-v1", id: randomUUID(), rpId: this.policy.rpId, origin: this.policy.origin,
        issuedAtMs, expiresAtMs: issuedAtMs + this.policy.resumeLifetimeMs, nextTokenHash: hashToken(nextToken(resumeToken), "flow"),
        resumeTokenHash: hashToken(resumeToken, "resume"), nonce: randomBytes(32).toString("base64url") };
      const contextDigest = enrollmentDigest(context), ceremony: WalletCeremonyDraft = { id: context.id,
        accountId: `wallet-signup-resume:${context.id}`, purpose: "signup-resume", contextDigest,
        challenge: Buffer.from(contextDigest, "hex").toString("base64url"), expiresAt: context.expiresAtMs };
      const draft: ResumeDraft = { ...context, ceremony };
      await this.ceremonies.issueInTransaction(client, ceremony, null);
      await client.query(`INSERT INTO rest_wallet_signup_resumes(id,draft,resume_token_hash,next_token_hash,expires_at_ms,retain_until_ms)
        VALUES($1,$2::jsonb,$3,$4,$5,$6)`, [draft.id, JSON.stringify(draft), draft.resumeTokenHash, draft.nextTokenHash,
        draft.expiresAtMs, draft.expiresAtMs + walletCeremonyRetentionMs]);
      if (draft.expiresAtMs <= await walletCeremonyDatabaseNow(client)) expired();
      return { challenge: resumeChallenge(draft), resumeToken };
    });
  }
  async completeResume(input: { resumeId: string; resumeToken: string; assertion: WalletAssertion }, ceremony: WalletCeremonyOptions = {}) {
    fields(input, ["resumeId", "resumeToken", "assertion"]);
    const { resumeId, resumeToken } = input, assertion = copyWalletSignupAssertion(input.assertion);
    if (!uuid.test(resumeId) || !token(resumeToken)) unauthorized();
    const prior = (await this.pool.query<ResumeRow>(`SELECT * FROM rest_wallet_signup_resumes WHERE id=$1 AND resume_token_hash=$2 AND retain_until_ms>${sqlNow}`,
      [resumeId, hashToken(resumeToken, "resume")])).rows[0];
    if (!prior || prior.draft.rpId !== this.policy.rpId || prior.draft.origin !== this.policy.origin ||
      hashToken(nextToken(resumeToken), "flow") !== prior.next_token_hash) unauthorized();
    // user_handle has a unique index. The credential ID and handle remain untrusted locators.
    const located = (await this.pool.query<{ id: string }>("SELECT id FROM rest_wallet_enrollments WHERE user_handle=$1", [assertion.userHandle])).rows[0];
    const enrollment = located ? await this.enrollments.get(located.id) : null;
    if (!enrollment?.candidate || enrollment.candidate.credentialId !== assertion.credentialId ||
      enrollment.intent.rpId !== this.policy.rpId || enrollment.intent.origin !== this.policy.origin) unauthorized();
    try { verifyWalletAssertion(assertion, { purpose: "signup-resume", challenge: resumeChallenge(prior.draft).challenge,
      rpId: this.policy.rpId, origin: this.policy.origin, ...(ceremony.topOrigin ? { topOrigin: ceremony.topOrigin } : {}), requireUserHandle: true,
      credential: { id: enrollment.candidate.credentialId, userHandle: enrollment.intent.userHandle,
        publicKey: enrollment.candidate.publicKey, backupEligible: enrollment.candidate.backupEligible } }); }
    catch { unauthorized(); }
    const proofDigest = enrollmentDigest(["center-wallet-signup-resume-proof-v1", prior.draft, enrollment.intent.id, enrollment.candidateDigest]);
    return this.transaction(async client => {
      // Existing enrollment → current credential → flow → resume → ceremony. No RPC or
      // key verification under these locks; every captured locator is rechecked here.
      const current = await lockWalletEnrollmentInTransaction(client, enrollment.intent.id);
      this.sameEnrollment(current, enrollment);
      if (current.state === "verified") {
        const credential = await currentWalletCredentialInTransaction(client, current);
        if (!credential || credential.credential_id !== assertion.credentialId || credential.rp_id !== prior.draft.rpId) unauthorized();
      }
      const flow = (await client.query<FlowRow>("SELECT * FROM rest_wallet_signup_flows WHERE enrollment_id=$1 FOR UPDATE", [current.intent.id])).rows[0];
      const row = (await client.query<ResumeRow>("SELECT * FROM rest_wallet_signup_resumes WHERE id=$1 FOR UPDATE", [resumeId])).rows[0];
      if (!flow || !row || enrollmentDigest(row.draft) !== enrollmentDigest(prior.draft)) unauthorized();
      const now = await walletCeremonyDatabaseNow(client);
      if (current.state !== "verified" && current.intent.expiresAt <= now) expired();
      if (row.completed_at_ms !== null) {
        if (row.flow_id !== flow.id || row.proof_digest !== proofDigest || flow.token_hash !== row.next_token_hash) conflict();
        if (Number(flow.expires_at_ms) <= now) expired();
        return { flow: flowOf(flow), flowToken: nextToken(resumeToken), replayed: true };
      }
      if (row.draft.expiresAtMs <= now) expired();
      await this.ceremonies.consumeInTransaction(client, { ...row.draft.ceremony, proofDigest, resultId: flow.id });
      const updated = (await client.query<FlowRow>(`UPDATE rest_wallet_signup_flows SET token_hash=$2,expires_at_ms=$3,revision=revision+1 WHERE id=$1 RETURNING *`,
        [flow.id, row.next_token_hash, now + this.policy.flowLifetimeMs])).rows[0]!;
      await client.query(`UPDATE rest_wallet_signup_resumes SET completed_at_ms=$2,flow_id=$3,proof_digest=$4 WHERE id=$1`, [resumeId, now, flow.id, proofDigest]);
      const after = await walletCeremonyDatabaseNow(client);
      if (row.draft.expiresAtMs <= after || Number(updated.expires_at_ms) <= after || (current.state !== "verified" && current.intent.expiresAt <= after)) expired();
      return { flow: flowOf(updated), flowToken: nextToken(resumeToken), replayed: false };
    });
  }
  private sameEnrollment(current: WalletEnrollment, before: WalletEnrollment) {
    if (enrollmentDigest([current.intent, current.candidate, current.candidateDigest, current.state, current.receipt]) !==
      enrollmentDigest([before.intent, before.candidate, before.candidateDigest, before.state, before.receipt])) conflict();
  }
  private async lockFlow(client: PoolClient, flowToken: string): Promise<FlowRow> {
    if (!token(flowToken)) unauthorized();
    const row = (await client.query<FlowRow>(`SELECT f.* FROM rest_wallet_signup_flows f JOIN rest_wallet_enrollments e ON e.id=f.enrollment_id
      WHERE f.token_hash=$1 AND e.intent->>'origin'=$2 AND e.intent->>'rpId'=$3 FOR UPDATE OF f`,
      [hashToken(flowToken, "flow"), this.policy.origin, this.policy.rpId])).rows[0];
    if (!row || Number(row.expires_at_ms) <= await walletCeremonyDatabaseNow(client)) unauthorized();
    return row;
  }
  private async admit(client: PoolClient, table: "flows" | "resumes", maximum: number) {
    const relation = `rest_wallet_signup_${table}`;
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('wallet-signup-${table}:' || '${relation}'::regclass::oid::text, 0))`);
    if (table === "flows") {
      await lockWalletCeremonyAdmission(client);
      await this.enrollments.cleanupInTransaction(client, 100);
    }
    if (table === "resumes") await client.query(`DELETE FROM ${relation} WHERE id IN
      (SELECT id FROM ${relation} WHERE retain_until_ms<=${sqlNow} ORDER BY retain_until_ms,id LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    // Pending enrollment cleanup cascades its flow. Verified identities and unresolved
    // deployment/setup associations remain durable, even after their cookie expires.
    if (Number((await client.query(`SELECT count(*)::text AS count FROM ${relation}`)).rows[0].count) >= maximum)
      throw new RestError(429, "WALLET_SIGNUP_LIMIT", "Signup storage admission limit reached.");
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
