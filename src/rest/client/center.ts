import { keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerialized } from "viem";
import { payFailureOf } from "./payFailure.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Account, BotGrant, BotScope } from "../auth/store.js";
import { parseAccountId } from "../auth/signatures.js";
import type { RestPlanDraft } from "../core.js";
import type { StepState, SemanticResult, StoredReceipt } from "../transactions/types.js";
import type { PreparedForwardRequest, SponsorshipSubmission } from "../sponsorship/types.js";
import {
  SignedRestClient, accountIdFor, RestClientError, readPublicRestJson, newRequestNonce, createBotRegistration,
  buildTransactionApprovalTypedData, buildSponsorshipApprovalTypedData, sponsorshipSubmissionHash,
  prepareSignedRequest,
  type RequestOptions, type ClientOptions, type RestSigner, type TransactionApproval, type SponsorshipApproval,
} from "./index.js";
import { parseConnection } from "./connection.js";
import { SmartAccountClient, assertReviewedOperation, signSessionUserOperation,
  type PreparedUserOperation, type SmartWalletPlan } from "./smartAccounts.js";
import type { StoredSession } from "../sessions/types.js";

export interface Plan {
  id: string; account: `0x${string}`; operation: string; commitment: Hex;
  draft: RestPlanDraft; createdAt: number; expiresAt: number; revision: number;
  status: "prepared" | "pending" | "partial" | "blocked" | "reorged" | "expired" | "transactions_confirmed";
  steps: { index: number; state: StepState; blockedBy: number[]; receipt?: StoredReceipt; semantic?: SemanticResult; transaction?: { hash: Hex }; execution?: { hash?: Hex } }[];
  confirmationScope: string;
}
export interface PrepaidPreparation {
  id: string; planId: string; commitment: Hex; publicationExpiresAt: number;
  authorizations: PreparedForwardRequest[];
  state: "prepared" | "submitting" | "submission_unknown" | "quoted";
  availability: string;
  observations: { stepIndex: number; chainId: number; state: string; hash?: Hex }[];
  quote?: { bundleUuid: string; runtimeVerified: boolean; payments: { chainId: number; value: string; deadline: string }[] };
}
export type ActionSigner = { address: `0x${string}`; signTypedData: {
  (document: ReturnType<typeof buildTransactionApprovalTypedData>): Promise<Hex>;
  (document: ReturnType<typeof buildSponsorshipApprovalTypedData>): Promise<Hex>;
} };
export type TransactionSubmission = { planId: string; stepIndex: number; rawSignedTransaction: Hex; ownerApproval?: TransactionApproval };
export type PrepaidSubmission = { sponsorshipId: string } & SponsorshipSubmission & { ownerApproval?: SponsorshipApproval };
const id = (value: string) => {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) throw new RestClientError("INVALID_INPUT", "Use the identifier returned by Center.");
  return encodeURIComponent(value);
};

/** Named workflows over the same exact-request signing and authorization protocol. */
export class CenterClient {
  private readonly client: SignedRestClient;
  constructor(private readonly options: ClientOptions) { this.client = new SignedRestClient({ payFailure: payFailureOf, ...options }); }
  request<T = unknown>(options: RequestOptions) { return this.client.request<T>(options); }
  /** Authorizes one exact GET for a relay. Send the returned URL and headers unchanged; this method does not send it. */
  authorizeRead(requestTarget: string) { return prepareSignedRequest(this.options, { method: "GET", requestTarget }); }
  /** Uses this connection's existing API identity and grant on every execution network. */
  smartAccounts() { return new SmartAccountClient(this.client); }
  /** Signs locally with the bot key after checking the exact plan and activated permission. Does not submit. */
  async signSessionOperation(input: { plan: SmartWalletPlan; operation: PreparedUserOperation; session: StoredSession }): Promise<Hex> {
    const reviewed = structuredClone(input), signer = this.options.signer;
    if (!this.options.grantId || reviewed.session.compiled.grantId !== this.options.grantId ||
        reviewed.session.compiled.ownerAccountId !== this.options.accountId)
      throw new RestClientError("SESSION_CONNECTION_MISMATCH", "Use the bot connection approved for this wallet permission.");
    if (!signer.signMessage)
      throw new RestClientError("SESSION_SIGNER_REQUIRED", "The bot signer must support signing a raw message hash.");
    assertReviewedOperation(reviewed.operation, reviewed.plan);
    return signSessionUserOperation({ record: reviewed.operation, session: reviewed.session,
      signer: { address: signer.address, signMessage: value => signer.signMessage!(value) } });
  }
  static forOwner(options: Omit<ClientOptions, "accountId" | "grantId"> & { chainId: number }) {
    const { chainId, ...config } = options;
    return new CenterClient({ ...config, accountId: accountIdFor(options.signer.address, chainId) });
  }
  static fromConnection(value: unknown, options: Pick<ClientOptions, "fetch" | "timeoutMs" | "now"> = {}) {
    const connection = parseConnection(value);
    if (connection.expiresAt <= (options.now?.() ?? Math.floor(Date.now() / 1000)))
      throw new RestClientError("CONNECTION_EXPIRED", "This bot connection expired. Register a new grant on Accounts.");
    return new CenterClient({ ...options, audience: connection.audience, accountId: connection.accountId,
      grantId: connection.grantId, signer: privateKeyToAccount(connection.privateKey) });
  }
  account() { return this.request<{ account: Account }>({ requestTarget: "/api/v1/accounts/me" }); }
  enroll() { return this.request<{ account: Account }>({ method: "POST", requestTarget: "/api/v1/accounts/enroll", json: {} }); }
  bots() { return this.request<{ bots: BotGrant[] }>({ requestTarget: "/api/v1/accounts/me/bots" }); }
  revokeBot(grantId: string) { return this.request<{ bot: BotGrant }>({ method: "DELETE", requestTarget: `/api/v1/accounts/me/bots/${id(grantId)}` }); }
  async registerBot(input: { signer: RestSigner; scopes: BotScope[]; label: string; expiresAt: number }) {
    const proof = await createBotRegistration(this.options.audience, { accountId: this.options.accountId,
      botAddress: input.signer.address, scopes: input.scopes, label: input.label, expiresAt: input.expiresAt,
      ownerRequestNonce: newRequestNonce() }, input.signer);
    const { bot } = await this.request<{ bot: BotGrant }>({ method: "POST", requestTarget: "/api/v1/accounts/me/bots", json: proof.registration, nonce: proof.ownerRequestNonce });
    if (bot.accountId !== this.options.accountId || bot.botAddress.toLowerCase() !== input.signer.address.toLowerCase() ||
        bot.expiresAt !== input.expiresAt || bot.revokedAt !== null || JSON.stringify(bot.scopes) !== JSON.stringify(input.scopes))
      throw new RestClientError("INVALID_RESPONSE", "Registration did not match the requested API access.");
    return { bot, client: new CenterClient({ ...this.options, signer: input.signer, grantId: bot.id }) };
  }
  capabilities<T = Record<string, unknown>>() { return readPublicRestJson<T>(this.options.audience, "/api/v1/capabilities", this.options.fetch); }
  prepare(input: { operation: string; input: unknown }, idempotencyKey: string) {
    return this.request<Plan>({ method: "POST", requestTarget: "/api/v1/plans", json: input, idempotencyKey });
  }
  plan(planId: string, options: { refresh?: boolean } = {}) {
    return this.request<Plan>({ requestTarget: `/api/v1/plans/${id(planId)}${options.refresh ? "?refresh=true" : ""}` });
  }
  simulate(planId: string, stepIndex: number) {
    this.step(stepIndex);
    return this.request<{ simulated: true; planId: string; commitment: Hex; stepIndex: number; blockHash: Hex; blockNumber: string; result: Hex }>({ requestTarget: `/api/v1/plans/${id(planId)}/steps/${stepIndex}/simulation` });
  }
  /** Call after the owner reviews the plan and the transaction wallet signs the exact bytes. */
  async approveTransaction(input: { plan: Plan; stepIndex: number; rawSignedTransaction: Hex }, owner: ActionSigner): Promise<TransactionSubmission> {
    this.step(input.stepIndex);
    if (!input.plan.draft.calls[input.stepIndex] || input.plan.expiresAt <= (this.options.now?.() ?? Math.floor(Date.now() / 1000)) * 1000)
      throw new RestClientError("PLAN_NOT_READY", "Review a current plan and choose one of its steps.");
    // Freeze the reviewed input before asynchronous signature recovery or wallet prompts.
    input = structuredClone(input);
    const call = input.plan.draft.calls[input.stepIndex]!;
    try {
      const transaction = parseTransaction(input.rawSignedTransaction);
      const sender = await recoverTransactionAddress({ serializedTransaction: input.rawSignedTransaction as TransactionSerialized });
      if (transaction.chainId !== call.chainId || transaction.to?.toLowerCase() !== call.to.toLowerCase() ||
          (transaction.data ?? "0x").toLowerCase() !== call.data.toLowerCase() ||
          (transaction.value ?? 0n) !== BigInt(call.value) || sender.toLowerCase() !== input.plan.account.toLowerCase() ||
          !["legacy", "eip2930", "eip1559"].includes(transaction.type ?? "legacy")) throw new Error("Mismatch");
    } catch {
      throw new RestClientError("SIGNED_TRANSACTION_MISMATCH", "The wallet-signed transaction does not match this reviewed plan step.");
    }
    const result = { planId: input.plan.id, stepIndex: input.stepIndex, rawSignedTransaction: input.rawSignedTransaction };
    if (!this.options.grantId) return result; // The owner signs the exact submission HTTP request.
    const claims = { ...this.approvalWindow(owner), planId: input.plan.id, commitment: input.plan.commitment,
      stepIndex: input.stepIndex, transactionHash: keccak256(input.rawSignedTransaction) };
    return { ...result, ownerApproval: { ...claims, signature: await owner.signTypedData(buildTransactionApprovalTypedData(this.options.audience, claims)) } };
  }
  submitTransaction(input: TransactionSubmission, idempotencyKey: string) {
    this.step(input.stepIndex);
    const { planId, stepIndex, ...json } = input;
    return this.request<{ plan: Plan; dispatch: { status: string; hash: Hex; error?: { code: string; message: string } } }>({ method: "POST", requestTarget: `/api/v1/plans/${id(planId)}/steps/${stepIndex}/submissions`, json, idempotencyKey });
  }
  preparePrepaid(planId: string, stepIndexes: number[] | undefined, idempotencyKey: string) {
    return this.request<PrepaidPreparation>({ method: "POST", requestTarget: "/api/v1/sponsorships", json: { planId, ...(stepIndexes ? { stepIndexes } : {}) }, idempotencyKey });
  }
  prepaid(sponsorshipId: string, options: { refresh?: boolean } = {}) {
    return this.request<PrepaidPreparation>({ requestTarget: `/api/v1/sponsorships/${id(sponsorshipId)}${options.refresh ? "?refresh=true" : ""}` });
  }
  async approvePrepaid(preparation: PrepaidPreparation, signatures: Hex[], owner: ActionSigner): Promise<PrepaidSubmission> {
    if (signatures.length !== preparation.authorizations.length || preparation.publicationExpiresAt <= (this.options.now?.() ?? Math.floor(Date.now() / 1000)) * 1000)
      throw new RestClientError("PLAN_NOT_READY", "Review a current preparation and sign each returned authorization in order.");
    const result = { sponsorshipId: preparation.id, signatures: [...signatures] };
    if (!this.options.grantId) return result;
    const claims = { ...this.approvalWindow(owner), sponsorshipId: preparation.id, commitment: preparation.commitment,
      submissionHash: sponsorshipSubmissionHash(preparation.commitment, signatures) };
    return { ...result, ownerApproval: { ...claims, signature: await owner.signTypedData(buildSponsorshipApprovalTypedData(this.options.audience, claims)) } };
  }
  submitPrepaid(input: PrepaidSubmission, idempotencyKey: string) {
    const { sponsorshipId, ...json } = input;
    return this.request<PrepaidPreparation>({ method: "POST", requestTarget: `/api/v1/sponsorships/${id(sponsorshipId)}/submissions`, json, idempotencyKey });
  }
  prepareFunding(sponsorshipId: string, chainId: number, payer: `0x${string}`, idempotencyKey: string) {
    return this.request<Plan>({ method: "POST", requestTarget: `/api/v1/sponsorships/${id(sponsorshipId)}/funding-plans`, json: { chainId, payer }, idempotencyKey });
  }
  private step(index: number) { if (!Number.isInteger(index) || index < 0 || index > 31) throw new RestClientError("INVALID_INPUT", "Choose a plan step from 0 through 31."); }
  private approvalWindow(owner: ActionSigner) {
    if (parseAccountId(this.options.accountId).ownerAddress.toLowerCase() !== owner.address.toLowerCase())
      throw new RestClientError("OWNER_MISMATCH", "The account owner must approve this submission.");
    const issuedAt = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    return { accountId: this.options.accountId, principalId: `bot:${this.options.grantId}`, issuedAt, expiresAt: issuedAt + 300, nonce: newRequestNonce() };
  }
}
