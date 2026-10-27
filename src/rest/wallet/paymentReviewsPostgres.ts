import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isAddress, type Address, type Hex } from "viem";
import { RestError, type RestActor } from "../core.js";
import { signaChainName } from "./chains.js";
import { stable } from "../smartAccounts/service.js";
import type { SmartAccountBinding, SmartAccountManifest } from "../smartAccounts/types.js";
import type { StoredPlan } from "../transactions/types.js";
import { getPostgresTransports } from "../transactions/transport-reservations.js";
import { assertPlan, digest, type UserOperationRecord } from "../userOperations/store.js";
import type { WalletAssertion } from "./webauthn.js";
import { assertWalletPaymentReviewContext, copyWalletPaymentReviewAssertion, reviewGas, createWalletPaymentReviewDraft, createWalletSignatureReviewDraft,
  isSignatureReview, validateWalletAnyReviewDraft, validateWalletSignatureReviewDraft, walletReviewFromStored, walletReviewToStored,
  verifyWalletPaymentReviewProof, type WalletAnyReviewDraft, type WalletPaymentReviewApprover, type WalletPaymentReviewContext,
  type WalletReviewDraft } from "./paymentReviews.js";
import type { ReviewedSignatureReview } from "../userOperations/reviewedSignatures.js";
import { walletSessionCredential } from "./loginPostgres.js";
import type { WalletAuthorityDevice } from "./devices.js";
import { parseWalletAppPrincipalId, walletAppAccount, walletAppAudience, walletAppFields,
  walletAppPrincipalId, walletAppUuid } from "./appGrants.js";
import { assertWalletAppGrantActiveInTransaction, getWalletAppGrantInTransaction } from "./appGrantsPostgres.js";
import type { WalletAuthorityContext } from "./authority.js";
import { loadWalletAuthorityContextInTransaction, PostgresWalletAuthorityStore } from "./authorityPostgres.js";
import { PostgresWalletCeremonyStore, lockWalletCeremonyAdmission, walletCeremonyDatabaseNow } from "./ceremoniesPostgres.js";
import { validateWalletPolicyOrigin } from "./policy.js";
import { validateWalletHandoffToken } from "./handoff.js";
import { detachedFromRequest } from "../context.js";

export interface WalletPaymentReviewView<D extends WalletAnyReviewDraft = WalletAnyReviewDraft> {
  draft: D;
  status: "pending" | "approved" | "cancelled";
  approvedAtMs: number | null;
  cancelledAtMs: number | null;
  /** Null for a signature: it has no operation. */
  operationState: UserOperationRecord["state"] | null;
  /** The account's passkeys that may approve: the primary and every activated device. */
  approvers: string[];
}
export interface WalletPaymentReviewAppView<D extends WalletAnyReviewDraft = WalletAnyReviewDraft> extends WalletPaymentReviewView<D> {
  approval: { signature: Hex; signedCommitment: Hex } | null;
}
export interface WalletPaymentReviewStoreOptions {
  issuer: string;
  audience: string;
  token: Address;
  directV6Terminal: Address;
  manifestFor(binding: SmartAccountBinding): SmartAccountManifest;
  maxRecords?: number;
  maxAccountRecords?: number;
  receiptRetentionMs?: number;
  /** How long a signature review stays open for its one approval; five minutes, the most a review may live. */
  signatureReviewLifetimeMs?: number;
  /** App origins admitted to frame their reviews: their approvals may be cross-origin assertions naming them. */
  frameableAppOrigins?: string[];
  /** The account's ERC-1271 check on its chain, run on an approved signature before it is kept. */
  verifySignature?: (input: { chainId: number; account: Address; hash: Hex; signature: Hex }) => Promise<boolean>;
}
interface ReviewRow {
  id: string; account_id: string; principal_id: string; operation_id: string; preparation_key: string;
  input_digest: string; ceremony_id: string; created_at_ms: string; expires_at_ms: string; retain_until_ms: string;
  draft: WalletAnyReviewDraft; status: WalletPaymentReviewView["status"]; session_id: string | null;
  proof_digest: string | null; signature: Hex | null; signed_commitment: Hex | null;
  approved_at_ms: string | null; cancelled_at_ms: string | null;
}
/** A signature captures no plan or operation: its context is the grant, authority and manifest alone. */
interface Captured {
  context: WalletPaymentReviewContext;
  authority: string;
  operation: string | null;
  plan: string | null;
}
function invalid(): never { throw new RestError(400, "WALLET_PAYMENT_REVIEW_INVALID", "Wallet payment review input is invalid."); }
function inactive(): never { throw new RestError(403, "WALLET_PAYMENT_REVIEW_INACTIVE", "Wallet payment review authority is unavailable."); }
function conflict(): never { throw new RestError(409, "WALLET_PAYMENT_REVIEW_CONFLICT", "The original payment review cannot be replaced or reused."); }
function expired(): never { throw new RestError(410, "WALLET_PAYMENT_REVIEW_EXPIRED", "The original payment review expired."); }
function missing(): never { throw new RestError(404, "WALLET_PAYMENT_REVIEW_NOT_FOUND", "Wallet payment review is unavailable."); }
function fields(value: unknown, required: string[], optional: string[] = []) {
  try { return walletAppFields(value, required, optional); } catch { return invalid(); }
}
function uuid(value: unknown): string { return walletAppUuid(value) ? value : invalid(); }
function actorOf(value: RestActor): RestActor {
  const actor = fields(value, ["accountId", "principalId"]);
  if (!walletAppAccount(actor.accountId) || !parseWalletAppPrincipalId(actor.principalId)) invalid();
  return { accountId: actor.accountId, principalId: actor.principalId as string };
}
function actorMatches(actor: RestActor, draft: WalletAnyReviewDraft): void {
  if (actor.accountId !== draft.grant.accountId || actor.principalId !== walletAppPrincipalId(draft.grant)) inactive();
}
function authorityIdentity(context: WalletAuthorityContext): string {
  // Routine observations may refresh readiness without replacing this owner/credential identity.
  return stable({ accountId: context.accountId, enrollment: context.enrollment, credential: context.credential,
    binding: context.binding, identity: context.prior?.identity ?? null,
    authorityEpoch: context.prior?.authorityEpoch ?? null, sessionEpoch: context.prior?.sessionEpoch ?? null });
}
function operationIdentity(record: UserOperationRecord): string {
  const { state: _state, revision: _revision, submission: _submission, observation: _observation, ...immutable } = record;
  return stable(immutable);
}
function planIdentity(plan: StoredPlan): string {
  const { steps: _steps, revision: _revision, ...immutable } = plan; return stable(immutable);
}
function draftIdentity(draft: WalletAnyReviewDraft): string {
  const { id: _id, createdAtMs: _created, expiresAtMs: _expires, ceremony: _ceremony, ...immutable } = draft;
  return stable(immutable);
}
function read(row: ReviewRow): ReviewRow { return { ...row, draft: walletReviewFromStored(row.draft) }; }
/** `kept`: an approved signature, which its app may still fetch past the review window (below). */
function live(row: ReviewRow, time: number, kept = false): void {
  if (Number(row.created_at_ms) > time) inactive();
  if (!kept && Number(row.expires_at_ms) <= time) expired();
}
/** An approved signature stays its app's to fetch, under current authority, for as long as its receipt and passkey
 * challenge are kept: a lost callback must not strand a signature whose request can't be asked again in that time. */
const kept = (row: ReviewRow, time: number) => row.status === "approved" && isSignatureReview(row.draft) && Number(row.retain_until_ms) > time;
function view(row: ReviewRow, operation: UserOperationRecord | null, captured: Captured): WalletPaymentReviewView {
  const authority = captured.context.authority;
  return { draft: row.draft, status: row.status, approvers: [authority.credential.credentialId, ...(authority.devices ?? []).map(device => device.credentialId)],
    approvedAtMs: row.approved_at_ms === null ? null : Number(row.approved_at_ms),
    cancelledAtMs: row.cancelled_at_ms === null ? null : Number(row.cancelled_at_ms), operationState: operation?.state ?? null };
}
const nowSql = "floor(extract(epoch FROM clock_timestamp())*1000)::bigint";
/** Internal composition. App actors come only from real signed REST authentication; session
 * handles come only from the authenticated central cookie. Neither alone approves a payment.
 * Proof/plan/profile verification occurs before SQL; locked metadata is compared afterwards.
 * Reviews do not reserve a nonce, dispatch, or release execution liability. All replicas must
 * use the same retained-row limits; global admission is bounded, not a capacity guarantee. */
/** What an approval hands to the operation's submission: the app's actor from the review row, the
 * exact signature the approval produced, one publication key per review and the approval's window. */
export interface WalletPaymentApprovedSubmission {
  actor: RestActor; operationId: string; signature: Hex; key: string; authority: { issuedAt: number; expiresAt: number };
}
export class PostgresWalletPaymentReviewStore {
  private readonly options: Required<WalletPaymentReviewStoreOptions>;
  private submission: ((input: WalletPaymentApprovedSubmission) => Promise<unknown>) | undefined;
  /** The approval sends the operation itself; the app's later hand-back observes that submission. */
  attachSubmission(submit: (input: WalletPaymentApprovedSubmission) => Promise<unknown>): void { this.submission = submit; }
  private speculation: ((actor: RestActor, operationId: string) => Promise<void>) | undefined;
  /** The admission's head-bound checks run ahead of the approval: when the review is created and when
   * its page is read. Detached from the request, never awaited, never a review's failure. */
  attachSpeculation(speculate: (actor: RestActor, operationId: string) => Promise<void>): void { this.speculation = speculate; }
  private speculate(row: ReviewRow): void {
    if (!this.speculation || row.status !== "pending" || isSignatureReview(row.draft)) return;
    // An async body: a hook that throws synchronously becomes a rejection this swallows.
    void detachedFromRequest(async () => this.speculation!(this.rowActor(row), row.operation_id)).catch(() => undefined);
  }
  private readonly authority: PostgresWalletAuthorityStore;
  private readonly ceremonies: PostgresWalletCeremonyStore;
  private readonly frameable: Set<string>;
  constructor(private readonly pool: Pool, input: WalletPaymentReviewStoreOptions) {
    const v = fields(input, ["issuer", "audience", "token", "directV6Terminal", "manifestFor"],
      ["maxRecords", "maxAccountRecords", "receiptRetentionMs", "signatureReviewLifetimeMs", "frameableAppOrigins", "verifySignature"]);
    if (v.verifySignature !== undefined && typeof v.verifySignature !== "function") invalid();
    const frameableAppOrigins = v.frameableAppOrigins === undefined ? [] : v.frameableAppOrigins;
    if (!Array.isArray(frameableAppOrigins) || frameableAppOrigins.some(value => typeof value !== "string")) invalid();
    let frameable: Set<string>;
    try { frameable = new Set((frameableAppOrigins as string[]).map(value => validateWalletPolicyOrigin(value))); } catch { invalid(); }
    let issuer: string, audience: string;
    try { issuer = validateWalletPolicyOrigin(v.issuer); audience = walletAppAudience(v.audience); } catch { invalid(); }
    if (typeof v.manifestFor !== "function") invalid();
    for (const key of ["token", "directV6Terminal"] as const)
      if (typeof v[key] !== "string" || !isAddress(v[key]) || BigInt(v[key]) <= 1n) invalid();
    const maxRecords = (v.maxRecords ?? 100_000) as number, maxAccountRecords = (v.maxAccountRecords ?? 128) as number;
    const receiptRetentionMs = (v.receiptRetentionMs ?? 86_400_000) as number, signatureReviewLifetimeMs = (v.signatureReviewLifetimeMs ?? 300_000) as number;
    for (const [name, value, minimum, maximum] of [["maxRecords", maxRecords, 1, 1_000_000],
      ["maxAccountRecords", maxAccountRecords, 1, 10_000], ["receiptRetentionMs", receiptRetentionMs, 100, 86_400_000],
      ["signatureReviewLifetimeMs", signatureReviewLifetimeMs, 1000, 300_000]] as const)
      if ((Object.hasOwn(v, name) && typeof v[name] !== "number") || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
    this.options = { issuer, audience, token: (v.token as string).toLowerCase() as Address,
      directV6Terminal: (v.directV6Terminal as string).toLowerCase() as Address,
      manifestFor: v.manifestFor as WalletPaymentReviewStoreOptions["manifestFor"], maxRecords, maxAccountRecords, receiptRetentionMs, signatureReviewLifetimeMs, frameableAppOrigins: [...frameable],
      verifySignature: (v.verifySignature ?? (async () => false)) as Required<WalletPaymentReviewStoreOptions>["verifySignature"] };
    this.authority = new PostgresWalletAuthorityStore(pool); this.ceremonies = new PostgresWalletCeremonyStore(pool);
    this.frameable = frameable;
  }
  /** The app may name the review's id (a UUID it drew) so it can open the review page before the
   * review exists; an id already taken is a conflict, and a replay on the same key returns the
   * review that key created whatever id it names now. */
  async prepare(inputActor: RestActor, input: { operationId: string; state: string; id?: string }, inputKey: string): Promise<WalletPaymentReviewView<WalletReviewDraft>> {
    const actor = actorOf(inputActor), v = fields(input, ["operationId", "state"], ["id"]), operationId = uuid(v.operationId);
    const chosenId = v.id === undefined ? undefined : uuid(v.id);
    let state: string; try { state = validateWalletHandoffToken(v.state); } catch { return invalid(); }
    if (typeof inputKey !== "string" || !/^[!-~]{1,128}$/.test(inputKey)) invalid();
    const key = inputKey, inputDigest = digest({ actor, operationId, state }).slice(2);
    const hint = (await this.pool.query<ReviewRow>(`SELECT * FROM rest_wallet_payment_reviews
      WHERE account_id=$1 AND principal_id=$2 AND preparation_key=$3`, [actor.accountId, actor.principalId, key])).rows.map(read)[0];
    if (hint && (hint.input_digest !== inputDigest || hint.operation_id !== operationId)) conflict();
    const captured = await this.capture(actor, operationId);
    const draft = hint ? this.assertHint(hint, captured) : createWalletPaymentReviewDraft(captured.context,
      { id: chosenId ?? randomUUID(), state, createdAtMs: await this.databaseNow() });
    return this.issue(actor, captured, draft, { key, inputDigest }) as Promise<WalletPaymentReviewView<WalletReviewDraft>>;
  }
  /** A signature an app asks the account for, reviewed by the caller (`reviewSignature`): the same
   * approval page, ceremony and limits as a payment, under the same id and replay rules. */
  async prepareSignature(inputActor: RestActor, input: { review: ReviewedSignatureReview; state: string; id?: string }, inputKey: string): Promise<WalletPaymentReviewView> {
    const actor = actorOf(inputActor), v = fields(input, ["review", "state"], ["id"]);
    const chosenId = v.id === undefined ? undefined : uuid(v.id);
    let state: string; try { state = validateWalletHandoffToken(v.state); } catch { return invalid(); }
    if (typeof inputKey !== "string" || !/^[!-~]{1,128}$/.test(inputKey)) invalid();
    const key = inputKey, inputDigest = digest({ actor, review: v.review, state }).slice(2);
    const hint = (await this.pool.query<ReviewRow>(`SELECT * FROM rest_wallet_payment_reviews
      WHERE account_id=$1 AND principal_id=$2 AND preparation_key=$3`, [actor.accountId, actor.principalId, key])).rows.map(read)[0];
    if (hint && hint.input_digest !== inputDigest) conflict();
    const captured = await this.capture(actor, null);
    const draft = hint ? this.assertHint(hint, captured) : createWalletSignatureReviewDraft(captured.context,
      { id: chosenId ?? randomUUID(), state, createdAtMs: await this.databaseNow(), review: v.review as ReviewedSignatureReview, lifetimeMs: this.options.signatureReviewLifetimeMs });
    return this.issue(actor, captured, draft, { key, inputDigest });
  }
  private async issue(actor: RestActor, captured: Captured, draft: WalletAnyReviewDraft, input: { key: string; inputDigest: string }): Promise<WalletPaymentReviewView> {
    const { key, inputDigest } = input, operationId = draft.operationId;
    const expectedDraft = draftIdentity(draft), encoded = JSON.stringify(walletReviewToStored(draft));
    const result = await this.transaction(async client => {
      // Each retained table owns its admission lock: schemas may share reviews while
      // resolving distinct ceremony tables. Acquire both before account/session rows.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet-payment-reviews:' || 'rest_wallet_payment_reviews'::regclass::oid::text, 0))");
      await lockWalletCeremonyAdmission(client);
      await this.guard(client, captured, draft);
      const { operation, plan } = await this.lockExecution(client, captured);
      const prior = (await client.query<ReviewRow>(`SELECT * FROM rest_wallet_payment_reviews
        WHERE operation_id=$1 OR (account_id=$2 AND principal_id=$3 AND preparation_key=$4) FOR UPDATE`,
      [operationId, actor.accountId, actor.principalId, key])).rows.map(read);
      if (prior.length) {
        if (prior.length !== 1) conflict();
        const row = prior[0]!;
        if (row.account_id !== actor.accountId || row.principal_id !== actor.principalId || row.preparation_key !== key ||
          row.operation_id !== operationId || row.input_digest !== inputDigest || draftIdentity(row.draft) !== expectedDraft) conflict();
        await this.finish(client, captured, row, operation); return { view: view(row, operation, captured), row };
      }
      if (operation) await this.unspent(client, operation, plan!);
      const counts = (await client.query<{ total: string; account: string }>(`SELECT count(*)::text AS total,
        count(*) FILTER (WHERE account_id=$1)::text AS account FROM rest_wallet_payment_reviews`, [actor.accountId])).rows[0]!;
      if (BigInt(counts.total) >= BigInt(this.options.maxRecords) || BigInt(counts.account) >= BigInt(this.options.maxAccountRecords))
        throw new RestError(429, "WALLET_PAYMENT_REVIEW_LIMIT", "Wallet payment review retention limit reached.");
      await this.ceremonies.issueInTransaction(client, draft.ceremony, null);
      const row = (await client.query<ReviewRow>(`INSERT INTO rest_wallet_payment_reviews
        (id,account_id,principal_id,operation_id,preparation_key,input_digest,ceremony_id,created_at_ms,expires_at_ms,retain_until_ms,draft)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
      [draft.id, actor.accountId, actor.principalId, operationId, key, inputDigest, draft.ceremony.id,
        draft.createdAtMs, draft.expiresAtMs, draft.expiresAtMs + this.options.receiptRetentionMs, encoded])).rows.map(read)[0]!;
      await this.finish(client, captured, row, operation); return { view: view(row, operation, captured), row };
    });
    this.speculate(result.row);
    return { ...result.view, draft: validateWalletAnyReviewDraft(result.view.draft) };
  }
  async getForApp(inputActor: RestActor, inputId: string): Promise<WalletPaymentReviewAppView> {
    const actor = actorOf(inputActor), hint = await this.hint(inputId, true); actorMatches(actor, hint.draft);
    const captured = await this.capture(actor, hint.operation_id), draft = this.assertHint(hint, captured);
    return this.transaction(async client => {
      await this.guard(client, captured, draft, kept(hint, await walletCeremonyDatabaseNow(client)));
      const { operation } = await this.lockExecution(client, captured), row = await this.lockReview(client, hint);
      await this.finish(client, captured, row, operation, kept(row, await walletCeremonyDatabaseNow(client)));
      return { ...view(row, operation, captured), approval: row.status === "approved" ? { signature: row.signature!, signedCommitment: row.signed_commitment! } : null };
    });
  }
  /** The review id is the capability: the page that holds it reads the review and cancels it, and
   * approves it with one of the account's passkeys. No Center sign-in is asked for on the way. */
  /** The origin of the app a live review was prepared for: the one origin allowed to frame its page. */
  async frameOrigin(inputId: string): Promise<string> { return (await this.hint(inputId)).draft.grant.origin; }
  async get(inputId: string): Promise<WalletPaymentReviewView> {
    const hint = await this.hint(inputId), captured = await this.capture(this.rowActor(hint), hint.operation_id);
    const draft = this.assertHint(hint, captured);
    const result = await this.transaction(async client => {
      await this.guard(client, captured, draft);
      const { operation } = await this.lockExecution(client, captured), row = await this.lockReview(client, hint);
      await this.finish(client, captured, row, operation);
      return { view: view(row, operation, captured), row, pending: row.status === "approved" && operation?.state === "prepared" };
    });
    // The approval page reloaded on an approved review nothing has published yet: send again.
    if (result.pending) this.sendApproved(result.row);
    this.speculate(result.row);
    return result.view;
  }
  /** The approval is the send: the operation goes out on the review's own authority right after the
   * approval is durable, and a later look at an approved review retries while nothing was published.
   * A failure here never touches the approval; the app's hand-back submits the same bytes itself. */
  private sendApproved(row: ReviewRow): void {
    if (!this.submission || !row.signature || row.approved_at_ms === null) return;
    const issuedAt = Math.floor(Number(row.approved_at_ms) / 1000);
    const submission = { actor: this.rowActor(row), operationId: row.operation_id, signature: row.signature as Hex,
      key: `review:${row.id}`, authority: { issuedAt, expiresAt: Math.min(Math.floor(Number(row.expires_at_ms) / 1000), issuedAt + 300) } };
    void Promise.resolve().then(() => this.submission!(submission)).then(
      () => console.info(JSON.stringify({ service: "wallet", action: "approval_submit", outcome: "ok", review: row.id })),
      (error: unknown) => console.info(JSON.stringify({ service: "wallet", action: "approval_submit", outcome: "failed", review: row.id,
        code: (error as { code?: unknown } | null)?.code ?? null })));
  }
  async approve(inputId: string, assertion: WalletAssertion): Promise<{ view: WalletPaymentReviewView; replayed: boolean }> {
    const id = uuid(inputId), ownedAssertion = copyWalletPaymentReviewAssertion(assertion);
    const hint = await this.hint(id);
    const captured = await this.capture(this.rowActor(hint), hint.operation_id), draft = this.assertHint(hint, captured);
    // An account that cannot prefund its own gas is never asked to sign: the operation would fail at the EntryPoint.
    const gas = isSignatureReview(draft) ? null : reviewGas(draft);
    if (gas?.payer === "account" && !gas.funded)
      throw new RestError(409, "WALLET_PAYMENT_GAS_UNFUNDED", `Needs ETH for gas on ${signaChainName(draft.chainId)}.`);
    // Local WebAuthn/P256/ABI verification is complete before transactional lock acquisition. The
    // assertion names the approving passkey: the primary, or one of the account's devices.
    const proof = verifyWalletPaymentReviewProof(draft, ownedAssertion, this.approver(captured, draft, ownedAssertion.credentialId),
      this.frameable.has(draft.grant.origin) ? { framedBy: draft.grant.origin } : {});
    // A signature leaves only once the account itself accepts it on its chain.
    if (isSignatureReview(draft) && hint.status === "pending" && await this.options.verifySignature({ chainId: draft.review.chainId,
      account: draft.authority.accountId.split(":")[2] as Address, hash: draft.signing.requestDigest, signature: proof.signature }).catch(() => false) !== true)
      throw new RestError(503, "WALLET_SIGNATURE_UNVERIFIED", "The account could not confirm this signature on its network. Try again shortly.");
    const result = await this.transaction(async client => {
      await this.guard(client, captured, draft);
      const { operation, plan } = await this.lockExecution(client, captured), row = await this.lockReview(client, hint);
      live(row, await walletCeremonyDatabaseNow(client));
      if (row.status === "cancelled") conflict();
      if (row.status === "approved") {
        if (row.proof_digest !== proof.proofDigest) conflict();
        await this.finish(client, captured, row, operation);
        return { view: view(row, operation, captured), replayed: true, row, pending: operation?.state === "prepared" };
      }
      if (operation) await this.unspent(client, operation, plan!);
      const consumed = await this.ceremonies.consumeInTransaction(client, { ...draft.ceremony,
        proofDigest: proof.proofDigest, resultId: operation ? draft.operationId : draft.id });
      if (consumed.replayed) conflict();
      const updated = (await client.query<ReviewRow>(`UPDATE rest_wallet_payment_reviews SET status='approved',
        proof_digest=$2,signature=$3,signed_commitment=$4,approved_at_ms=${nowSql}
        WHERE id=$1 AND status='pending' AND expires_at_ms>${nowSql} RETURNING *`,
      [row.id, proof.proofDigest, proof.signature, proof.signedCommitment])).rows.map(read)[0];
      if (!updated) expired();
      await this.finish(client, captured, updated, operation);
      return { view: view(updated, operation, captured), replayed: false, row: updated, pending: !!operation };
    });
    if (result.pending) this.sendApproved(result.row);
    return { view: result.view, replayed: result.replayed };
  }
  async cancel(inputId: string): Promise<WalletPaymentReviewView> {
    const hint = await this.hint(inputId), captured = await this.capture(this.rowActor(hint), hint.operation_id);
    const draft = this.assertHint(hint, captured);
    return this.transaction(async client => {
      await this.guard(client, captured, draft);
      const { operation } = await this.lockExecution(client, captured), row = await this.lockReview(client, hint);
      live(row, await walletCeremonyDatabaseNow(client));
      if (row.status === "approved") conflict();
      const updated = row.status === "cancelled" ? row : (await client.query<ReviewRow>(`UPDATE rest_wallet_payment_reviews
        SET status='cancelled',cancelled_at_ms=${nowSql} WHERE id=$1 AND status='pending' AND expires_at_ms>${nowSql} RETURNING *`, [row.id])).rows.map(read)[0];
      if (!updated) expired();
      await this.finish(client, captured, updated, operation); return view(updated, operation, captured);
    });
  }
  /** An approval is final: no review leaves the approved state. */
  async approved(operationId: string): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM rest_wallet_payment_reviews WHERE operation_id=$1 AND status='approved' LIMIT 1", [uuid(operationId)])).rowCount! > 0;
  }
  async cleanup(limit = 250): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid();
    return this.transaction(async client => (await client.query(`WITH expired AS (SELECT id FROM rest_wallet_payment_reviews
      WHERE retain_until_ms<=${nowSql} ORDER BY retain_until_ms,id LIMIT $1 FOR UPDATE SKIP LOCKED)
      DELETE FROM rest_wallet_payment_reviews r USING expired e WHERE r.id=e.id`, [limit])).rowCount ?? 0);
  }
  private rowActor(row: ReviewRow): RestActor { return { accountId: row.account_id, principalId: row.principal_id }; }
  private async hint(inputId: string, keep = false): Promise<ReviewRow> {
    const row = (await this.pool.query<ReviewRow>("SELECT * FROM rest_wallet_payment_reviews WHERE id=$1", [uuid(inputId)])).rows.map(read)[0];
    if (!row) missing();
    row.draft = validateWalletAnyReviewDraft(row.draft);
    const time = await this.databaseNow(); live(row, time, keep && kept(row, time)); return row;
  }
  private async databaseNow(): Promise<number> {
    const time = Number((await this.pool.query<{ now: string }>(`SELECT ${nowSql} AS now`)).rows[0]!.now);
    if (!Number.isSafeInteger(time) || time <= 0) inactive(); return time;
  }
  /** `operationId` null, or a signature's row key, captures no operation or plan. */
  private async capture(actor: RestActor, operationId: string | null): Promise<Captured> {
    const principal = parseWalletAppPrincipalId(actor.principalId); if (!principal) inactive();
    const client = await this.pool.connect();
    let grant;
    try { grant = await getWalletAppGrantInTransaction(client, principal.id); } finally { client.release(); }
    if (!grant || walletAppPrincipalId(grant) !== actor.principalId || grant.accountId !== actor.accountId || grant.audience !== this.options.audience) inactive();
    let operation: UserOperationRecord | undefined, plan: StoredPlan | undefined;
    if (operationId !== null && !operationId.startsWith("signature:")) {
      operation = (await this.pool.query<{ document: UserOperationRecord }>(`SELECT document FROM rest_user_operations
        WHERE id=$1 AND account_id=$2 AND principal_id=$3`, [operationId, actor.accountId, actor.principalId])).rows[0]?.document;
      if (!operation) missing();
      plan = (await this.pool.query<{ document: StoredPlan }>(`SELECT document FROM rest_transaction_plans
        WHERE id=$1 AND account_id=$2 AND principal_id=$3`, [operation.planId, actor.accountId, actor.principalId])).rows[0]?.document;
      if (!plan) missing();
    }
    const authority = await this.authority.loadContext(actor.accountId);
    const manifest = this.options.manifestFor(structuredClone(authority.binding));
    const context = { issuer: this.options.issuer, token: this.options.token,
      directV6Terminal: this.options.directV6Terminal, grant, authority, plan, operation, manifest: structuredClone(manifest) } as WalletPaymentReviewContext;
    return { context, authority: authorityIdentity(authority), operation: operation ? operationIdentity(operation) : null, plan: plan ? planIdentity(plan) : null };
  }
  private assertHint(row: ReviewRow, captured: Captured): WalletAnyReviewDraft {
    const draft = validateWalletAnyReviewDraft(row.draft);
    if (draft.id !== row.id || draft.operationId !== row.operation_id || draft.ceremony.id !== row.ceremony_id ||
      draft.createdAtMs !== Number(row.created_at_ms) || draft.expiresAtMs !== Number(row.expires_at_ms)) inactive();
    actorMatches(this.rowActor(row), draft);
    try {
      if (!isSignatureReview(draft)) assertWalletPaymentReviewContext(draft, captured.context);
      else if (stable(validateWalletSignatureReviewDraft(draft)) !== stable(createWalletSignatureReviewDraft(captured.context,
        { id: draft.id, state: draft.state, createdAtMs: draft.createdAtMs, review: draft.review, lifetimeMs: draft.expiresAtMs - draft.createdAtMs }))) inactive();
    } catch { return inactive(); }
    return draft;
  }
  /** The asserting passkey and its own Safe owner; a device signs as its device signer. */
  private approver(captured: Captured, draft: WalletAnyReviewDraft, credentialId: string): WalletPaymentReviewApprover {
    const passkey = walletSessionCredential(captured.context.authority, credentialId);
    if (!passkey) throw new RestError(403, "WALLET_PAYMENT_REVIEW_PROOF_INVALID", "A matching fresh wallet payment assertion is required.");
    if (!("device" in passkey)) return { credential: draft.authority.credential, signer: draft.authority.signer };
    const { recovery: _recovery, device, ...credential } = passkey as WalletAuthorityDevice & { recovery?: unknown };
    return { credential, signer: device.signerAddress };
  }
  private async guard(client: PoolClient, captured: Captured, draft: WalletAnyReviewDraft, keep = false): Promise<void> {
    const current = await loadWalletAuthorityContextInTransaction(client, draft.authority.accountId);
    if (authorityIdentity(current) !== captured.authority) inactive();
    await assertWalletAppGrantActiveInTransaction(client, draft.grant,
      { kind: "actor", principalId: walletAppPrincipalId(draft.grant), audience: this.options.audience });
    if (!keep && draft.expiresAtMs <= await walletCeremonyDatabaseNow(client)) expired();
  }
  private async lockExecution(client: PoolClient, captured: Captured): Promise<{ operation: UserOperationRecord | null; plan: StoredPlan | null }> {
    if (captured.operation === null) return { operation: null, plan: null };
    const expected = captured.context.operation, actor = expected.actor;
    const operation = (await client.query<{ document: UserOperationRecord }>(`SELECT document FROM rest_user_operations
      WHERE id=$1 AND account_id=$2 AND principal_id=$3 FOR UPDATE`, [expected.id, actor.accountId, actor.principalId])).rows[0]?.document;
    const plan = (await client.query<{ document: StoredPlan }>(`SELECT document FROM rest_transaction_plans
      WHERE id=$1 AND account_id=$2 AND principal_id=$3 FOR UPDATE`, [expected.planId, actor.accountId, actor.principalId])).rows[0]?.document;
    if (!operation || !plan || operationIdentity(operation) !== captured.operation || planIdentity(plan) !== captured.plan) conflict();
    return { operation, plan };
  }
  private async lockReview(client: PoolClient, hint: ReviewRow): Promise<ReviewRow> {
    const row = (await client.query<ReviewRow>("SELECT * FROM rest_wallet_payment_reviews WHERE id=$1 FOR UPDATE", [hint.id])).rows.map(read)[0];
    if (!row || row.account_id !== hint.account_id || row.principal_id !== hint.principal_id || row.input_digest !== hint.input_digest ||
      stable(row.draft) !== stable(hint.draft)) conflict();
    return row;
  }
  private async unspent(client: PoolClient, operation: UserOperationRecord, plan: StoredPlan): Promise<void> {
    if (operation.state !== "prepared" || operation.submission) conflict();
    try { assertPlan(operation, plan, await walletCeremonyDatabaseNow(client)); } catch { return conflict(); }
    const selected = new Set(operation.stepIndexes);
    if ((await getPostgresTransports(client, plan.id)).some(row => selected.has(row.stepIndex))) conflict();
    // Stored as the claim writes them: a lowercase sender and a decimal nonce.
    const nonce = await client.query(`SELECT user_operation_id FROM rest_user_operation_nonces WHERE chain_id=$1 AND sender=$2 AND nonce=$3`,
      [operation.chainId, operation.sender.toLowerCase(), BigInt(operation.operation.nonce).toString()]);
    if (nonce.rows.length) conflict();
  }
  private async finish(client: PoolClient, captured: Captured, row: ReviewRow, operation: UserOperationRecord | null, keep = false): Promise<void> {
    if (row.status === "approved") {
      if (!row.signature || !row.signed_commitment || !row.proof_digest) inactive();
      if (operation?.submission && !isSignatureReview(row.draft) && (operation.submission.commitment !== row.signed_commitment ||
        stable(operation.submission.operation) !== stable({ ...row.draft.operation, signature: row.signature }))) conflict();
    }
    await this.guard(client, captured, row.draft, keep);
    live(row, await walletCeremonyDatabaseNow(client), keep);
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout='5000ms'");
      await client.query("SET LOCAL statement_timeout='10000ms'"); await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const result = await run(client); await client.query("COMMIT"); return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error && typeof error === "object" && "code" in error && ["23505", "22003"].includes(String(error.code))) conflict();
      throw error;
    } finally { client.release(); }
  }
}
